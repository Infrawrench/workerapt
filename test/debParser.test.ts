import { describe, it, expect } from 'vitest';
import consumeDeb, { DebParseError } from '../src/debParser';
import { buildDeb } from './fixtures/buildDeb';

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

describe('consumeDeb', () => {
	it('parses control fields from a gzipped control.tar', async () => {
		const control = [
			'Package: hello',
			'Version: 1.2.3',
			'Architecture: amd64',
			'Maintainer: Tester <t@example.com>',
			'Description: A greeting',
			' continued line',
			'',
		].join('\n');
		const deb = await buildDeb({ control });
		const fields = await consumeDeb(streamFromBytes(deb));
		expect(fields.Package).toBe('hello');
		expect(fields.Version).toBe('1.2.3');
		expect(fields.Architecture).toBe('amd64');
		expect(fields.Maintainer).toBe('Tester <t@example.com>');
		expect(fields.Description).toBe('A greeting\n continued line');
	});

	it('parses an uncompressed control.tar', async () => {
		const deb = await buildDeb({
			control: 'Package: foo\nVersion: 0.1\nArchitecture: all\n',
			controlMember: 'control.tar',
		});
		const fields = await consumeDeb(streamFromBytes(deb));
		expect(fields.Package).toBe('foo');
		expect(fields.Architecture).toBe('all');
	});

	it('rejects non-deb input', async () => {
		const garbage = new TextEncoder().encode('not a deb file at all');
		await expect(consumeDeb(streamFromBytes(garbage))).rejects.toBeInstanceOf(DebParseError);
	});

	it('only returns the first paragraph', async () => {
		const control = 'Package: a\nVersion: 1\n\nPackage: b\nVersion: 2\n';
		const deb = await buildDeb({ control });
		const fields = await consumeDeb(streamFromBytes(deb));
		expect(fields.Package).toBe('a');
		expect(fields.Version).toBe('1');
	});
});
