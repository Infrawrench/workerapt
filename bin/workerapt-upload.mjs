#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

function usage() {
	process.stderr.write(`Usage: workerapt-upload --url <api> --key <bearer> --repo <repo> --dist <dist> --cat <component> <file>...

Hashes each .deb locally, asks the Worker for a presigned R2 PUT URL,
uploads the file directly to R2, then publishes the batch to the dist.

Required:
  --url   Worker base URL                      (env: WORKERAPT_URL)
  --key   Bearer token matching Worker's KEY   (env: WORKERAPT_KEY)
  --repo  Repository name
  --dist  Distribution name (e.g. stable)
  --cat   Component name   (e.g. main)

Files are listed positionally.
`);
	process.exit(2);
}

function parseArgs(argv) {
	const out = { files: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--url') out.url = argv[++i];
		else if (a === '--key') out.key = argv[++i];
		else if (a === '--repo') out.repo = argv[++i];
		else if (a === '--dist') out.dist = argv[++i];
		else if (a === '--cat') out.cat = argv[++i];
		else if (a === '-h' || a === '--help') usage();
		else if (a.startsWith('-')) {
			process.stderr.write(`Unknown flag: ${a}\n`);
			usage();
		} else out.files.push(a);
	}
	out.url ??= process.env.WORKERAPT_URL;
	out.key ??= process.env.WORKERAPT_KEY;
	if (!out.url || !out.key || !out.repo || !out.dist || !out.cat || out.files.length === 0) {
		usage();
	}
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

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const debs = [];
	for (const file of args.files) {
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

		debs.push({ fileId, md5, sha256 });
	}
	process.stderr.write(`publishing ${debs.length} package(s) to ${args.repo}/${args.dist}/${args.cat}... `);
	const result = await publish(args, debs);
	process.stderr.write(`done\n`);
	process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((e) => {
	process.stderr.write(`${e?.message ?? e}\n`);
	process.exit(1);
});
