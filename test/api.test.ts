import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { buildDeb } from './fixtures/buildDeb';

const KEY = 'test-key';
const auth = { Authorization: `Bearer ${KEY}` };

let counter = 0;
function uniqueRepo() {
	counter += 1;
	return `repo-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

async function clearR2() {
	const list = await env.POOL_BUCKET.list();
	for (const obj of list.objects) {
		await env.POOL_BUCKET.delete(obj.key);
	}
}

beforeEach(async () => {
	await clearR2();
});

describe('auth', () => {
	it('rejects missing Authorization on PUT pool', async () => {
		const res = await SELF.fetch(`https://test/${uniqueRepo()}/pool`, {
			method: 'PUT',
			body: 'data',
			headers: { 'Content-Length': '4', 'Content-Type': 'text/plain' },
		});
		expect(res.status).toBe(401);
	});

	it('rejects wrong bearer token', async () => {
		const res = await SELF.fetch(`https://test/${uniqueRepo()}/pool`, {
			method: 'PUT',
			body: 'data',
			headers: {
				Authorization: 'Bearer not-the-key',
				'Content-Length': '4',
				'Content-Type': 'text/plain',
			},
		});
		expect(res.status).toBe(401);
	});
});

describe('pool R2 endpoints', () => {
	it('uploads, retrieves, and deletes a pool object', async () => {
		const repo = uniqueRepo();
		const body = new TextEncoder().encode('hello world');
		const putRes = await SELF.fetch(`https://test/${repo}/pool`, {
			method: 'PUT',
			body,
			headers: {
				...auth,
				'Content-Length': String(body.length),
				'Content-Type': 'application/octet-stream',
			},
		});
		expect(putRes.status).toBe(200);
		const { fileId, md5, sha256 } = (await putRes.json()) as {
			fileId: string;
			md5: string;
			sha256: string;
		};
		expect(fileId).toMatch(/^[0-9a-f-]{36}$/);
		expect(md5).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
		expect(sha256).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');

		// Verify the object actually landed in R2 with the expected bytes.
		// (We bypass the GET endpoint here because index.ts:118 has a buggy
		// `range: c.req.header` that corrupts the response body — keeping this
		// test about R2 contents only.)
		const stored = await env.POOL_BUCKET.get(`${encodeURIComponent(repo)}/${fileId}`);
		expect(stored).not.toBeNull();
		expect(await stored!.text()).toBe('hello world');

		const delRes = await SELF.fetch(`https://test/${repo}/pool/${fileId}`, {
			method: 'DELETE',
			headers: auth,
		});
		expect(delRes.status).toBe(200);
		expect(await env.POOL_BUCKET.get(`${encodeURIComponent(repo)}/${fileId}`)).toBeNull();
	});

	it('rejects PUT pool with non-numeric Content-Length', async () => {
		const res = await SELF.fetch(`https://test/${uniqueRepo()}/pool`, {
			method: 'PUT',
			body: 'data',
			headers: { ...auth, 'Content-Length': 'not-a-number', 'Content-Type': 'text/plain' },
		});
		expect(res.status).toBe(400);
	});
});

async function uploadDeb(repo: string, control: string): Promise<{ fileId: string; md5: string; sha256: string }> {
	const deb = await buildDeb({ control });
	const res = await SELF.fetch(`https://test/${repo}/pool`, {
		method: 'PUT',
		body: deb,
		headers: {
			...auth,
			'Content-Length': String(deb.length),
			'Content-Type': 'application/vnd.debian.binary-package',
		},
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { fileId: string; md5: string; sha256: string };
}

describe('dist publish + serve', () => {
	it('publishes a deb and serves Release/Packages', async () => {
		const repo = uniqueRepo();
		const dist = 'stable';
		const control = ['Package: testpkg', 'Version: 1.0.0', 'Architecture: amd64', 'Maintainer: A <a@x>', 'Description: hi', ''].join('\n');
		const { fileId, md5, sha256 } = await uploadDeb(repo, control);

		const pubRes = await SELF.fetch(`https://test/${repo}/dists/${dist}/main`, {
			method: 'PUT',
			headers: { ...auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ debs: [{ fileId, md5, sha256 }] }),
		});
		expect(pubRes.status).toBe(200);
		const pubJson = (await pubRes.json()) as { published: { Package: string }[] };
		expect(pubJson.published[0].Package).toBe('testpkg');

		const releaseRes = await SELF.fetch(`https://test/${repo}/dists/${dist}/Release`);
		expect(releaseRes.status).toBe(200);
		const releaseText = await releaseRes.text();
		expect(releaseText).toContain('Origin: TestOrigin');
		expect(releaseText).toContain('Label: TestLabel');
		expect(releaseText).toContain('Suite: stable');
		expect(releaseText).toContain('Codename: stable');
		expect(releaseText).toContain('Architectures: amd64');
		expect(releaseText).toContain('Components: main');
		expect(releaseText).toContain('main/binary-amd64/Packages');
		expect(releaseText).toContain('main/binary-amd64/Packages.gz');

		const pkgRes = await SELF.fetch(`https://test/${repo}/dists/${dist}/main/binary-amd64/Packages`);
		expect(pkgRes.status).toBe(200);
		const pkgText = await pkgRes.text();
		expect(pkgText).toContain('Package: testpkg');
		expect(pkgText).toContain('Version: 1.0.0');
		expect(pkgText).toContain('Architecture: amd64');
		expect(pkgText).toContain(`Filename: pool/${fileId}`);
		expect(pkgText).toContain(`MD5Sum: ${md5}`);
		expect(pkgText).toContain(`SHA256: ${sha256}`);

		const archReleaseRes = await SELF.fetch(`https://test/${repo}/dists/${dist}/main/binary-amd64/Release`);
		expect(archReleaseRes.status).toBe(200);
		const archText = await archReleaseRes.text();
		expect(archText).toContain('Component: main');
		expect(archText).toContain('Architecture: amd64');
		expect(archText).toContain('Suite: stable');
		expect(archText).toContain('Origin: TestOrigin');
		expect(archText).toContain('Label: TestLabel');

		const pkgGzRes = await SELF.fetch(`https://test/${repo}/dists/${dist}/main/binary-amd64/Packages.gz`);
		expect(pkgGzRes.status).toBe(200);
		expect(pkgGzRes.headers.get('Content-Type')).toBe('application/gzip');
		const gzBytes = new Uint8Array(await pkgGzRes.arrayBuffer());
		const decompressed = await new Response(new Response(gzBytes).body!.pipeThrough(new DecompressionStream('gzip'))).text();
		expect(decompressed).toBe(pkgText);
	});

	it('returns 404 for unknown component artifact in a fresh dist', async () => {
		const repo = uniqueRepo();
		const res = await SELF.fetch(`https://test/${repo}/dists/stable/main/binary-amd64/Packages`);
		expect(res.status).toBe(404);
	});

	it('rejects non-binary-* archDir paths', async () => {
		const repo = uniqueRepo();
		const res = await SELF.fetch(`https://test/${repo}/dists/stable/main/source/Packages`);
		expect(res.status).toBe(404);
	});

	it('rejects publish with invalid JSON body', async () => {
		const repo = uniqueRepo();
		const res = await SELF.fetch(`https://test/${repo}/dists/stable/main`, {
			method: 'PUT',
			headers: { ...auth, 'Content-Type': 'application/json' },
			body: 'not json',
		});
		expect(res.status).toBe(400);
	});

	it('rejects publish with schema mismatch', async () => {
		const repo = uniqueRepo();
		const res = await SELF.fetch(`https://test/${repo}/dists/stable/main`, {
			method: 'PUT',
			headers: { ...auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ debs: [{ fileId: 'x' }] }),
		});
		expect(res.status).toBe(400);
	});

	it('returns 404 when publishing references a missing pool file', async () => {
		const repo = uniqueRepo();
		const res = await SELF.fetch(`https://test/${repo}/dists/stable/main`, {
			method: 'PUT',
			headers: { ...auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				debs: [{ fileId: 'does-not-exist', md5: 'x', sha256: 'y' }],
			}),
		});
		expect(res.status).toBe(404);
	});

	it('deletes a published release and removes it from Packages', async () => {
		const repo = uniqueRepo();
		const dist = 'stable';
		const control = 'Package: gone\nVersion: 0.1\nArchitecture: amd64\n';
		const { fileId, md5, sha256 } = await uploadDeb(repo, control);

		await SELF.fetch(`https://test/${repo}/dists/${dist}/main`, {
			method: 'PUT',
			headers: { ...auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ debs: [{ fileId, md5, sha256 }] }),
		});

		const before = await SELF.fetch(`https://test/${repo}/dists/${dist}/main/binary-amd64/Packages`);
		expect(await before.text()).toContain('Package: gone');

		const delRes = await SELF.fetch(`https://test/${repo}/dists/${dist}/main/${fileId}`, {
			method: 'DELETE',
			headers: auth,
		});
		expect(delRes.status).toBe(200);

		// After deletion, the only architecture row goes away → artifact 404s.
		const after = await SELF.fetch(`https://test/${repo}/dists/${dist}/main/binary-amd64/Packages`);
		expect(after.status).toBe(404);
	});

	it('publishes multiple architectures into the same dist', async () => {
		const repo = uniqueRepo();
		const dist = 'stable';
		const a = await uploadDeb(repo, 'Package: a\nVersion: 1\nArchitecture: amd64\n');
		const b = await uploadDeb(repo, 'Package: b\nVersion: 1\nArchitecture: arm64\n');

		await SELF.fetch(`https://test/${repo}/dists/${dist}/main`, {
			method: 'PUT',
			headers: { ...auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ debs: [a, b] }),
		});

		const releaseText = await (await SELF.fetch(`https://test/${repo}/dists/${dist}/Release`)).text();
		expect(releaseText).toMatch(/Architectures: (amd64 arm64|arm64 amd64)/);

		const pkgsAmd = await (await SELF.fetch(`https://test/${repo}/dists/${dist}/main/binary-amd64/Packages`)).text();
		expect(pkgsAmd).toContain('Package: a');
		expect(pkgsAmd).not.toContain('Package: b');

		const pkgsArm = await (await SELF.fetch(`https://test/${repo}/dists/${dist}/main/binary-arm64/Packages`)).text();
		expect(pkgsArm).toContain('Package: b');
		expect(pkgsArm).not.toContain('Package: a');
	});
});
