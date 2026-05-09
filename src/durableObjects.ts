import { DurableObject } from "cloudflare:workers";
import { Context, Hono } from "hono";
import { publishToDist } from "./publishToDist";
import { deleteRelease } from "./deleteRelease";
import { sign, createMessage, readPrivateKey, PrivateKey } from "openpgp";
import crypto from "node:crypto";

const PACKAGES_FIELD_ORDER = [
    'Package', 'Source', 'Version', 'Architecture', 'Section', 'Priority',
    'Installed-Size', 'Maintainer', 'Depends', 'Pre-Depends', 'Recommends',
    'Suggests', 'Enhances', 'Breaks', 'Conflicts', 'Provides', 'Replaces',
    'Filename', 'Size', 'MD5Sum', 'SHA256', 'Homepage',
];

function formatPackagesEntry(metadata: Record<string, unknown>): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const k of PACKAGES_FIELD_ORDER) {
        const v = metadata[k];
        if (v != null) {
            lines.push(`${k}: ${v}`);
            seen.add(k);
        }
    }
    for (const [k, v] of Object.entries(metadata)) {
        if (!seen.has(k) && k !== 'Description' && v != null) {
            lines.push(`${k}: ${v}`);
        }
    }
    if (metadata.Description != null) {
        lines.push(`Description: ${metadata.Description}`);
    }
    return lines.join('\n');
}

function buildPackagesFile(rows: { metadata: string }[]): string {
    if (rows.length === 0) return '';
    return rows
        .map((r) => formatPackagesEntry(JSON.parse(r.metadata) as Record<string, unknown>))
        .join('\n\n') + '\n';
}

function buildArchReleaseFile(component: string, architecture: string, suite: string): string {
    return [
        `Archive: ${suite}`,
        `Suite: ${suite}`,
        `Component: ${component}`,
        `Origin: workerapt`,
        `Label: workerapt`,
        `Architecture: ${architecture}`,
    ].join('\n') + '\n';
}

async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Response(data).body!.pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface IndexEntry {
    path: string;
    size: number;
    md5: string;
    sha256: string;
}

function makeIndexEntry(path: string, buf: Uint8Array): IndexEntry {
    return {
        path,
        size: buf.byteLength,
        md5: crypto.createHash('md5').update(buf).digest('hex'),
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
}

const distSqlSchema = `
CREATE TABLE IF NOT EXISTS releases (
    cat_name TEXT NOT NULL,
    id TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    architecture TEXT NOT NULL,
    PRIMARY KEY (cat_name, id)
);

CREATE INDEX IF NOT EXISTS idx_releases_cat_name ON releases (cat_name);

CREATE INDEX IF NOT EXISTS idx_releases_created_at ON releases (created_at);

CREATE INDEX IF NOT EXISTS idx_releases_cat_name_architecture ON releases (cat_name, architecture);
`;

const distApp = new Hono<{ Bindings: DistDurableObject }>();

distApp.get('/Release', async (c) => {
    const { release } = await c.env.loadIndices();
    return c.text(release, 200);
});

distApp.get('/Release.gpg', async (c) => {
    const [, gpgSignature] = await c.env.loadReleaseAndGpgSignature();
    return c.text(gpgSignature, 200);
});

distApp.get('/InRelease', async (c) => {
    const [release, gpgSignature] = await c.env.loadReleaseAndGpgSignature();
    return c.text(`-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA256

${release}
${gpgSignature}`, 200);
});

distApp.put('/:repoName/:catName', publishToDist);

distApp.delete('/:catName/:id', deleteRelease);

async function serveArtifact(c: Context<{ Bindings: DistDurableObject }>, filename: string): Promise<Response> {
    const component = c.req.param('component')!;
    const archDir = c.req.param('archDir')!;
    if (!archDir.startsWith('binary-')) return c.notFound();
    const path = `${component}/${archDir}/${filename}`;
    const { artifacts } = await c.env.loadIndices();
    const data = artifacts.get(path);
    if (!data) return c.notFound();
    return new Response(data, {
        headers: {
            'Content-Type': filename.endsWith('.gz') ? 'application/gzip' : 'text/plain; charset=utf-8',
            'Content-Length': String(data.byteLength),
        },
    });
}

distApp.get('/:component/:archDir/Release', (c) => serveArtifact(c, 'Release'));
distApp.get('/:component/:archDir/Packages', (c) => serveArtifact(c, 'Packages'));
distApp.get('/:component/:archDir/Packages.gz', (c) => serveArtifact(c, 'Packages.gz'));

export class DistDurableObject extends DurableObject<Env> {
    public env: Env;
    public ctx: DurableObjectState<{}>;

    constructor(ctx: DurableObjectState<{}>, env: Env) {
        super(ctx, env);
        this.env = env;
        this.ctx = ctx;
        ctx.blockConcurrencyWhile(async () => {
            this.ctx.storage.sql.exec(distSqlSchema);
        });
    }

    private gpgPrivateKey: PrivateKey | undefined;

    async signer(input: () => Promise<string>): Promise<[string, string]> {
        const x = await input();
        const privateKey = this.gpgPrivateKey ??= await readPrivateKey({ armoredKey: this.env.GPG_PRIVATE_KEY });
        this.gpgPrivateKey = privateKey;
        const signature = await sign({
            message: await createMessage({ text: x }),
            signingKeys: [privateKey],
            detached: true,
        });
        return [x, signature as string];
    }

    public releaseAndGpgSignature: [string, string] | undefined;
    public indices: { release: string; artifacts: Map<string, Uint8Array> } | undefined;

    async loadReleaseAndGpgSignature(): Promise<[string, string]> {
        if (this.releaseAndGpgSignature) return this.releaseAndGpgSignature;
        const { release } = await this.loadIndices();
        const x = await this.signer(async () => release);
        this.releaseAndGpgSignature = x;
        return x;
    }

    async loadIndices(): Promise<{ release: string; artifacts: Map<string, Uint8Array> }> {
        if (this.indices) return this.indices;
        this.indices = await this.buildIndices();
        return this.indices;
    }

    private async buildIndices(): Promise<{ release: string; artifacts: Map<string, Uint8Array> }> {
        const sql = this.ctx.storage.sql;
        const pairs = sql.exec<{ cat_name: string; architecture: string }>(
            'SELECT DISTINCT cat_name, architecture FROM releases ORDER BY cat_name, architecture',
        ).toArray();

        const idName = this.ctx.id.name;
        const distName = idName ? decodeURIComponent(idName.split('/')[1] ?? '') || 'stable' : 'stable';

        const components = new Set<string>();
        const architectures = new Set<string>();
        const indexEntries: IndexEntry[] = [];
        const artifacts = new Map<string, Uint8Array>();

        for (const { cat_name, architecture } of pairs) {
            components.add(cat_name);
            architectures.add(architecture);
            const rows = sql.exec<{ metadata: string }>(
                'SELECT metadata FROM releases WHERE cat_name = ? AND architecture = ? ORDER BY id',
                cat_name,
                architecture,
            ).toArray();

            const packagesBuf = new TextEncoder().encode(buildPackagesFile(rows));
            const packagesGz = await gzipBytes(packagesBuf);
            const archReleaseBuf = new TextEncoder().encode(
                buildArchReleaseFile(cat_name, architecture, distName),
            );

            const prefix = `${cat_name}/binary-${architecture}`;
            const releasePath = `${prefix}/Release`;
            const packagesPath = `${prefix}/Packages`;
            const packagesGzPath = `${prefix}/Packages.gz`;

            artifacts.set(releasePath, archReleaseBuf);
            artifacts.set(packagesPath, packagesBuf);
            artifacts.set(packagesGzPath, packagesGz);

            indexEntries.push(
                makeIndexEntry(releasePath, archReleaseBuf),
                makeIndexEntry(packagesPath, packagesBuf),
                makeIndexEntry(packagesGzPath, packagesGz),
            );
        }

        const lines = [
            `Origin: workerapt`,
            `Label: workerapt`,
            `Suite: ${distName}`,
            `Codename: ${distName}`,
            `Date: ${new Date().toUTCString()}`,
            `Architectures: ${[...architectures].join(' ')}`,
            `Components: ${[...components].join(' ')}`,
            `Acquire-By-Hash: no`,
            `MD5Sum:`,
            ...indexEntries.map((f) => ` ${f.md5} ${f.size} ${f.path}`),
            `SHA256:`,
            ...indexEntries.map((f) => ` ${f.sha256} ${f.size} ${f.path}`),
        ];
        const release = lines.join('\n') + '\n';

        return { release, artifacts };
    }

    flushCache() {
        this.releaseAndGpgSignature = undefined;
        this.indices = undefined;
    }

    async fetch(request: Request): Promise<Response> {
        return distApp.fetch(request, this);
    }
}
