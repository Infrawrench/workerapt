const encoder = new TextEncoder();

function padRight(s: string, n: number, ch = ' '): string {
	if (s.length > n) throw new Error(`Field too long: ${s}`);
	return s + ch.repeat(n - s.length);
}

function arHeader(name: string, size: number): Uint8Array {
	const h = new Uint8Array(60);
	const fields = [
		[padRight(name, 16), 0],
		[padRight('0', 12), 16],
		[padRight('0', 6), 28],
		[padRight('0', 6), 34],
		[padRight('100644', 8), 40],
		[padRight(String(size), 10), 48],
		['`\n', 58],
	] as const;
	for (const [s, off] of fields) {
		h.set(encoder.encode(s), off);
	}
	return h;
}

function tarHeader(name: string, size: number): Uint8Array {
	const h = new Uint8Array(512);
	h.set(encoder.encode(padRight(name, 100, '\0')), 0);
	h.set(encoder.encode(padRight('0000644', 8, '\0')), 100);
	h.set(encoder.encode(padRight('0000000', 8, '\0')), 108);
	h.set(encoder.encode(padRight('0000000', 8, '\0')), 116);
	const sizeOctal = size.toString(8).padStart(11, '0') + '\0';
	h.set(encoder.encode(sizeOctal), 124);
	h.set(encoder.encode(padRight('00000000000', 12, '\0')), 136);
	h.set(encoder.encode('        '), 148);
	h[156] = 0x30; // '0' = regular file
	h.set(encoder.encode(padRight('ustar  ', 8, '\0')), 257);

	let sum = 0;
	for (let i = 0; i < 512; i++) sum += h[i];
	const chk = sum.toString(8).padStart(6, '0') + '\0 ';
	h.set(encoder.encode(chk), 148);
	return h;
}

function tarFile(name: string, contents: Uint8Array): Uint8Array {
	const padded = Math.ceil(contents.length / 512) * 512;
	const out = new Uint8Array(512 + padded);
	out.set(tarHeader(name, contents.length), 0);
	out.set(contents, 512);
	return out;
}

function tarEnd(): Uint8Array {
	return new Uint8Array(1024);
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Response(data).body!.pipeThrough(new CompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

export interface BuildDebOptions {
	control: string;
	dataMembers?: { name: string; data: Uint8Array }[];
	controlMember?: 'control.tar' | 'control.tar.gz';
}

export async function buildDeb(opts: BuildDebOptions): Promise<Uint8Array> {
	const controlMember = opts.controlMember ?? 'control.tar.gz';
	const controlTar = concat([
		tarFile('./control', encoder.encode(opts.control)),
		tarEnd(),
	]);
	const controlBytes = controlMember === 'control.tar.gz' ? await gzip(controlTar) : controlTar;

	const dataTar = concat([
		...(opts.dataMembers ?? []).map((m) => tarFile(m.name, m.data)),
		tarEnd(),
	]);
	const dataGz = await gzip(dataTar);

	const debianBinary = encoder.encode('2.0\n');

	const members: Uint8Array[] = [encoder.encode('!<arch>\n')];

	function addMember(name: string, body: Uint8Array) {
		members.push(arHeader(name, body.length));
		members.push(body);
		if (body.length % 2 === 1) members.push(new Uint8Array([0x0a]));
	}

	addMember('debian-binary', debianBinary);
	addMember(controlMember, controlBytes);
	addMember('data.tar.gz', dataGz);

	return concat(members);
}
