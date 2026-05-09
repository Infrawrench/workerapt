import xzWasm from './wasm/xz.wasm';

interface XzExports {
	memory: WebAssembly.Memory;
	create_context(): number;
	destroy_context(ptr: number): void;
	supply_input(ptr: number, size: number): void;
	get_next_output(ptr: number): number;
}

let xzInstancePromise: Promise<WebAssembly.Instance> | null = null;
function getXzInstance(): Promise<WebAssembly.Instance> {
	if (!xzInstancePromise) {
		xzInstancePromise = WebAssembly.instantiate(xzWasm, {}).catch((e) => {
			xzInstancePromise = null;
			throw e;
		});
	}
	return xzInstancePromise;
}

const XZ_OK = 0;
const XZ_STREAM_END = 1;

async function decompressXz(input: Uint8Array): Promise<Uint8Array> {
	const instance = await getXzInstance();
	const exports = instance.exports as unknown as XzExports;
	const ptr = exports.create_context();
	try {
		let mem8 = new Uint8Array(exports.memory.buffer);
		let mem32 = new Uint32Array(exports.memory.buffer, ptr);
		const refresh = () => {
			if (mem8.buffer !== exports.memory.buffer) {
				mem8 = new Uint8Array(exports.memory.buffer);
				mem32 = new Uint32Array(exports.memory.buffer, ptr);
			}
		};

		const bufSize = mem32[0];
		const inStart = mem32[1];
		const outStart = mem32[4];

		const chunks: Uint8Array[] = [];
		let totalOut = 0;
		let inputOffset = 0;
		let eofSignaled = false;

		while (true) {
			if (mem32[2] === mem32[3]) {
				if (inputOffset < input.length) {
					const chunkSize = Math.min(bufSize, input.length - inputOffset);
					mem8.set(input.subarray(inputOffset, inputOffset + chunkSize), inStart);
					exports.supply_input(ptr, chunkSize);
					inputOffset += chunkSize;
					refresh();
				} else if (!eofSignaled) {
					// Tell the decoder there's no more input so it can finalize.
					exports.supply_input(ptr, 0);
					eofSignaled = true;
					refresh();
				}
			}

			const result = exports.get_next_output(ptr);
			refresh();
			if (result !== XZ_OK && result !== XZ_STREAM_END) {
				throw new DebParseError(`xz decode failed with code ${result}`);
			}
			const outPos = mem32[5];
			if (outPos > 0) {
				chunks.push(mem8.slice(outStart, outStart + outPos));
				totalOut += outPos;
				mem32[5] = 0;
			}
			if (result === XZ_STREAM_END) break;
			if (outPos === 0 && eofSignaled) {
				throw new DebParseError('xz decoder stalled after EOF');
			}
		}

		const out = new Uint8Array(totalOut);
		let off = 0;
		for (const c of chunks) {
			out.set(c, off);
			off += c.length;
		}
		return out;
	} finally {
		exports.destroy_context(ptr);
	}
}

/**
 * Well-known fields from a Debian binary package's `control` file.
 * See https://www.debian.org/doc/debian-policy/ch-controlfields.html
 *
 * Unknown fields are also accepted via the index signature.
 */
export interface ControlFields {
	Package?: string;
	Source?: string;
	Version?: string;
	Section?: string;
	Priority?: string;
	Architecture?: string;
	'Installed-Size'?: string;
	Maintainer?: string;
	Depends?: string;
	'Pre-Depends'?: string;
	Recommends?: string;
	Suggests?: string;
	Enhances?: string;
	Breaks?: string;
	Conflicts?: string;
	Provides?: string;
	Replaces?: string;
	Description?: string;
	Homepage?: string;
	[field: string]: string | undefined;
}

export interface PublishResponse {
	published: Record<string, ControlFields>;
}

export class DebParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DebParseError';
	}
}

const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

const AR_MAGIC = '!<arch>\n';
const AR_HEADER_SIZE = 60;
const AR_NAME_OFFSET = 0;
const AR_NAME_LENGTH = 16;
const AR_SIZE_OFFSET = 48;
const AR_SIZE_LENGTH = 10;
const AR_END_OFFSET = 58;
const AR_END_MARKER = '`\n';

const TAR_BLOCK_SIZE = 512;
const TAR_NAME_OFFSET = 0;
const TAR_NAME_LENGTH = 100;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;

type ControlMemberName = 'control.tar' | 'control.tar.gz' | 'control.tar.xz';

function isControlMember(name: string): name is ControlMemberName {
	return name === 'control.tar' || name === 'control.tar.gz' || name === 'control.tar.xz';
}

class StreamReader {
	private buffer: Uint8Array = EMPTY;
	private done = false;

	constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

	private async pull(): Promise<boolean> {
		if (this.done) return false;
		const { done, value } = await this.reader.read();
		if (done) {
			this.done = true;
			return false;
		}
		if (value && value.length > 0) {
			const next = new Uint8Array(this.buffer.length + value.length);
			next.set(this.buffer, 0);
			next.set(value, this.buffer.length);
			this.buffer = next;
		}
		return true;
	}

	async readExact(n: number): Promise<Uint8Array> {
		while (this.buffer.length < n) {
			if (!(await this.pull())) throw new DebParseError('Unexpected EOF');
		}
		const out = this.buffer.slice(0, n);
		this.buffer = this.buffer.slice(n);
		return out;
	}

	async skipExact(n: number): Promise<void> {
		let remaining = n;
		if (this.buffer.length >= remaining) {
			this.buffer = this.buffer.slice(remaining);
			return;
		}
		remaining -= this.buffer.length;
		this.buffer = EMPTY;
		while (remaining > 0) {
			if (!(await this.pull())) throw new DebParseError('Unexpected EOF');
			if (this.buffer.length <= remaining) {
				remaining -= this.buffer.length;
				this.buffer = EMPTY;
			} else {
				this.buffer = this.buffer.slice(remaining);
				remaining = 0;
			}
		}
	}

	async cancel(): Promise<void> {
		await this.reader.cancel().catch(() => {});
	}
}

async function decompressControl(name: ControlMemberName, data: Uint8Array): Promise<Uint8Array> {
	if (name === 'control.tar') return data;
	if (name === 'control.tar.xz') return decompressXz(data);
	const stream = new Response(data).body!.pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeCString(bytes: Uint8Array): string {
	const nul = bytes.indexOf(0);
	return decoder.decode(nul === -1 ? bytes : bytes.subarray(0, nul));
}

function extractControlFromTar(data: Uint8Array): string {
	let offset = 0;
	while (offset + TAR_BLOCK_SIZE <= data.length) {
		const header = data.subarray(offset, offset + TAR_BLOCK_SIZE);

		let allZero = true;
		for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
			if (header[i] !== 0) {
				allZero = false;
				break;
			}
		}
		if (allZero) break;

		const name = decodeCString(header.subarray(TAR_NAME_OFFSET, TAR_NAME_OFFSET + TAR_NAME_LENGTH));
		const sizeStr = decodeCString(header.subarray(TAR_SIZE_OFFSET, TAR_SIZE_OFFSET + TAR_SIZE_LENGTH)).trim();
		const size = parseInt(sizeStr, 8);
		if (!Number.isFinite(size) || size < 0) {
			throw new DebParseError(`Invalid tar size: ${sizeStr}`);
		}
		offset += TAR_BLOCK_SIZE;

		const cleanName = name.replace(/^\.?\/+/, '');
		if (cleanName === 'control') {
			return decoder.decode(data.subarray(offset, offset + size));
		}
		offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
	}
	throw new DebParseError('control file not found in control tarball');
}

function parseControlFields(text: string): ControlFields {
	const out: ControlFields = {};
	let currentKey: string | null = null;
	for (const rawLine of text.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (line === '') {
			if (currentKey !== null) break; // first paragraph only
			continue;
		}
		if (line[0] === ' ' || line[0] === '\t') {
			if (currentKey !== null) out[currentKey] += '\n' + line;
			continue;
		}
		const idx = line.indexOf(':');
		if (idx === -1) continue;
		currentKey = line.slice(0, idx);
		out[currentKey] = line.slice(idx + 1).replace(/^[ \t]+/, '');
	}
	return out;
}

interface ArHeader {
	name: string;
	size: number;
}

function parseArHeader(header: Uint8Array): ArHeader {
	const end = decoder.decode(header.subarray(AR_END_OFFSET, AR_END_OFFSET + 2));
	if (end !== AR_END_MARKER) {
		throw new DebParseError('Bad ar header terminator');
	}
	const name = decoder
		.decode(header.subarray(AR_NAME_OFFSET, AR_NAME_OFFSET + AR_NAME_LENGTH))
		.trimEnd()
		.replace(/\/$/, '');
	const sizeStr = decoder.decode(header.subarray(AR_SIZE_OFFSET, AR_SIZE_OFFSET + AR_SIZE_LENGTH)).trim();
	const size = parseInt(sizeStr, 10);
	if (!Number.isFinite(size) || size < 0) {
		throw new DebParseError(`Bad ar size: ${sizeStr}`);
	}
	return { name, size };
}

export default async function consumeDeb(body: ReadableStream<Uint8Array>): Promise<ControlFields> {
	const r = new StreamReader(body.getReader());
	try {
		const magic = decoder.decode(await r.readExact(AR_MAGIC.length));
		if (magic !== AR_MAGIC) {
			throw new DebParseError('Not a deb archive (bad ar magic)');
		}

		while (true) {
			const { name, size } = parseArHeader(await r.readExact(AR_HEADER_SIZE));

			if (isControlMember(name)) {
				const compressed = await r.readExact(size);
				const tar = await decompressControl(name, compressed);
				return parseControlFields(extractControlFromTar(tar));
			}

			if (name.startsWith('control.tar')) {
				throw new DebParseError(`Unsupported control compression: ${name}`);
			}

			await r.skipExact(size);
			if (size % 2 === 1) await r.skipExact(1);
		}
	} finally {
		await r.cancel();
	}
}
