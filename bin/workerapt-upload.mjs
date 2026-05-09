#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

function usage() {
	process.stderr.write(`Usage:
  workerapt-upload pool    [flags] <file>...
  workerapt-upload publish [flags] <manifest>...
  workerapt-upload         [flags] <file>...   (legacy: pool + publish together)

Splits the upload pipeline into two steps so parallel CI jobs can each push
a .deb to the pool independently, and a single reconcile job can publish the
collected manifests as one signed release.

  pool     Hashes each file, asks the Worker for a presigned R2 PUT URL,
           uploads directly to R2, and emits a JSON manifest per file
           containing { fileId, md5, sha256, name, size }.

  publish  Reads pool manifests and POSTs them as one batch to
           /<repo>/dists/<dist>/<cat>, regenerating the signed indices.

Common flags:
  --url   Worker base URL                      (env: WORKERAPT_URL)
  --key   Bearer token matching Worker's KEY   (env: WORKERAPT_KEY)
  --repo  Repository name

pool extra flags:
  --out <dir>     Write one <fileId>.json manifest per file into <dir>.
                  Default: print a JSON array of manifests to stdout.

publish extra flags:
  --dist <dist>   Distribution name (e.g. stable)
  --cat  <cat>    Component name   (e.g. main)

  Positional manifest args may be:
    - a path to a .json file (object or array of objects)
    - a directory (all *.json inside are read, sorted)
    - "-" to read a JSON array from stdin

Legacy (no subcommand): same as pool + publish; takes --dist, --cat, and files.
`);
	process.exit(2);
}

function parseArgs(argv) {
	const subcommands = new Set(['pool', 'publish']);
	let cmd = 'legacy';
	let rest = argv;
	if (argv.length > 0 && subcommands.has(argv[0])) {
		cmd = argv[0];
		rest = argv.slice(1);
	}
	const out = { cmd, files: [] };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === '--url') out.url = rest[++i];
		else if (a === '--key') out.key = rest[++i];
		else if (a === '--repo') out.repo = rest[++i];
		else if (a === '--dist') out.dist = rest[++i];
		else if (a === '--cat') out.cat = rest[++i];
		else if (a === '--out') out.outDir = rest[++i];
		else if (a === '-h' || a === '--help') usage();
		else if (a !== '-' && a.startsWith('-')) {
			process.stderr.write(`Unknown flag: ${a}\n`);
			usage();
		} else out.files.push(a);
	}
	out.url ??= process.env.WORKERAPT_URL;
	out.key ??= process.env.WORKERAPT_KEY;
	if (!out.url || !out.key || !out.repo) usage();
	if (out.cmd === 'pool' && out.files.length === 0) usage();
	if (out.cmd === 'publish' && (!out.dist || !out.cat || out.files.length === 0)) usage();
	if (out.cmd === 'legacy' && (!out.dist || !out.cat || out.files.length === 0)) usage();
	out.url = out.url.replace(/\/$/, '');
	return out;
}

async function hashFile(path) {
	const md5 = createHash('md5');
	const sha = createHash('sha256');
	let size = 0;
	for await (const chunk of createReadStream(path)) {
		md5.update(chunk);
		sha.update(chunk);
		size += chunk.length;
	}
	return { md5: md5.digest('hex'), sha256: sha.digest('hex'), size };
}

async function presign({ url, key, repo }) {
	const r = await fetch(`${url}/${encodeURIComponent(repo)}/pool/presign`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}` },
	});
	if (!r.ok) throw new Error(`presign failed ${r.status}: ${await r.text()}`);
	return r.json();
}

async function uploadToR2(uploadUrl, path, size) {
	const r = await fetch(uploadUrl, {
		method: 'PUT',
		body: createReadStream(path),
		duplex: 'half',
		headers: { 'Content-Length': String(size) },
	});
	if (!r.ok) throw new Error(`R2 upload failed ${r.status}: ${await r.text()}`);
}

async function publish({ url, key, repo, dist, cat }, debs) {
	const r = await fetch(`${url}/${encodeURIComponent(repo)}/dists/${encodeURIComponent(dist)}/${encodeURIComponent(cat)}`, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ debs }),
	});
	if (!r.ok) throw new Error(`publish failed ${r.status}: ${await r.text()}`);
	return r.json();
}

async function poolOne(args, file) {
	const name = basename(file);
	process.stderr.write(`hashing ${name}... `);
	const { md5, sha256, size } = await hashFile(file);
	process.stderr.write(`${size}B md5=${md5}\n`);

	process.stderr.write(`presigning ${name}... `);
	const { fileId, uploadUrl } = await presign(args);
	process.stderr.write(`${fileId}\n`);

	process.stderr.write(`uploading ${name}... `);
	await uploadToR2(uploadUrl, file, size);
	process.stderr.write(`done\n`);

	return { fileId, md5, sha256, name, size };
}

async function readStdin() {
	let data = '';
	process.stdin.setEncoding('utf8');
	for await (const chunk of process.stdin) data += chunk;
	return data;
}

async function readManifests(paths) {
	const manifests = [];
	for (const p of paths) {
		if (p === '-') {
			const text = await readStdin();
			const parsed = JSON.parse(text);
			manifests.push(...(Array.isArray(parsed) ? parsed : [parsed]));
			continue;
		}
		const s = await stat(p);
		if (s.isDirectory()) {
			const entries = (await readdir(p)).filter((e) => e.endsWith('.json')).sort();
			for (const e of entries) {
				const text = await readFile(join(p, e), 'utf8');
				const parsed = JSON.parse(text);
				manifests.push(...(Array.isArray(parsed) ? parsed : [parsed]));
			}
		} else {
			const text = await readFile(p, 'utf8');
			const parsed = JSON.parse(text);
			manifests.push(...(Array.isArray(parsed) ? parsed : [parsed]));
		}
	}
	return manifests;
}

async function runPool(args) {
	const manifests = [];
	if (args.outDir) await mkdir(args.outDir, { recursive: true });
	for (const file of args.files) {
		const m = await poolOne(args, file);
		manifests.push(m);
		if (args.outDir) {
			await writeFile(join(args.outDir, `${m.fileId}.json`), JSON.stringify(m, null, 2) + '\n');
		}
	}
	if (!args.outDir) {
		process.stdout.write(JSON.stringify(manifests, null, 2) + '\n');
	}
}

async function runPublish(args) {
	const manifests = await readManifests(args.files);
	if (manifests.length === 0) {
		process.stderr.write('no manifests to publish\n');
		process.exit(1);
	}
	for (const m of manifests) {
		if (!m || typeof m.fileId !== 'string' || typeof m.md5 !== 'string' || typeof m.sha256 !== 'string') {
			throw new Error(`invalid manifest entry: ${JSON.stringify(m)}`);
		}
	}
	const debs = manifests.map(({ fileId, md5, sha256 }) => ({ fileId, md5, sha256 }));
	process.stderr.write(`publishing ${debs.length} package(s) to ${args.repo}/${args.dist}/${args.cat}... `);
	const result = await publish(args, debs);
	process.stderr.write(`done\n`);
	process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function runLegacy(args) {
	const debs = [];
	for (const file of args.files) {
		const m = await poolOne(args, file);
		debs.push({ fileId: m.fileId, md5: m.md5, sha256: m.sha256 });
	}
	process.stderr.write(`publishing ${debs.length} package(s) to ${args.repo}/${args.dist}/${args.cat}... `);
	const result = await publish(args, debs);
	process.stderr.write(`done\n`);
	process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.cmd === 'pool') return runPool(args);
	if (args.cmd === 'publish') return runPublish(args);
	return runLegacy(args);
}

main().catch((e) => {
	process.stderr.write(`${e?.message ?? e}\n`);
	process.exit(1);
});
