import { Context, Hono } from 'hono';
import crypto from 'node:crypto';

export { DistDurableObject } from './durableObjects';

const app = new Hono<{ Bindings: Env }>();

async function processRewrite(c: Context<{ Bindings: Env }>, repoName: string, distName: string, prependRepoName?: boolean) {
	const distDO = c.env.DIST_DO.getByName(`${encodeURIComponent(repoName)}/${encodeURIComponent(distName)}`);
	if (!distDO) {
		return c.notFound();
	}
	let path = '/' + c.req.path.split('/').slice(4).join('/');
	if (prependRepoName) {
		path = '/' + encodeURIComponent(repoName) + path;
	}
	const url = new URL(path, c.req.url);
	return distDO.fetch(new Request(url.toString(), c.req.raw));
}

app.get('/:repoName/dists/:distName', (c) => processRewrite(
	c,
	c.req.param('repoName'),
	c.req.param('distName'),
));

app.get('/:repoName/dists/:distName/*', (c) => processRewrite(
	c,
	c.req.param('repoName'),
	c.req.param('distName'),
));

function authorize(fn: (c: Context<{ Bindings: Env }>) => Promise<Response>) {
	return async (c: Context<{ Bindings: Env }>) => {
		const auth = c.req.header('Authorization') || '';
		if (!auth.startsWith('Bearer ')) return c.text('Unauthorized', 401);
		const token = auth.slice(7);
		if (token !== c.env.KEY) {
			// Add a delay here to prevent timing attacks
			await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
			return c.text('Unauthorized', 401);
		}
		return fn(c);
	};
}

app.delete('/:repoName/dists/:distName/:catName/:id', authorize((c) => processRewrite(
	c,
	c.req.param('repoName')!,
	c.req.param('distName')!,
)));

app.put('/:repoName/dists/:distName/:catName', authorize((c) => processRewrite(
	c,
	c.req.param('repoName')!,
	c.req.param('distName')!,
	true,
)));

app.put('/:repoName/pool', authorize(async (c) => {
	const repoName = c.req.param('repoName');
	if (!repoName) return c.text('Expected repoName', 400);
	const fileId = crypto.randomUUID();

	const hasher256 = crypto.createHash('sha256');
	const hasherMD5 = crypto.createHash('md5');

	const reader = c.req.raw.body?.getReader();
	if (!reader) return c.text('Expected body', 400);

	const contentLength = Number(c.req.raw.headers.get('Content-Length'));
	const contentType = c.req.raw.headers.get('Content-Type');
	if (isNaN(contentLength) || contentLength < 0) return c.text('Expected Content-Length and Content-Type headers', 400);

	const readableStream = new ReadableStream({
		async start(controller) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					break;
				}
				hasher256.update(value);
				hasherMD5.update(value);
				controller.enqueue(value);
			}
		},
		expectedLength: contentLength,
	});

	await c.env.POOL_BUCKET.put(`${encodeURIComponent(repoName)}/${fileId}`, readableStream, {
		httpMetadata: new Headers({
			'Content-Type': contentType || '',
		}),
	});
	return c.json({
		fileId,
		md5: hasherMD5.digest('hex'),
		sha256: hasher256.digest('hex'),
	});
}));

app.delete('/:repoName/pool/:fileId', authorize(async (c) => {
	const repoName = c.req.param('repoName');
	if (!repoName) return c.text('Expected repoName', 400);
	const fileId = c.req.param('fileId');
	if (!fileId) return c.text('Expected fileId', 400);
	await c.env.POOL_BUCKET.delete(`${encodeURIComponent(repoName)}/${fileId}`);
	return c.json({ success: true });
}));

app.get('/:repoName/pool/:fileId', authorize(async (c) => {
	const repoName = c.req.param('repoName');
	if (!repoName) return c.text('Expected repoName', 400);
	const fileId = c.req.param('fileId');
	if (!fileId) return c.text('Expected fileId', 400);
	const file = await c.env.POOL_BUCKET.get(`${encodeURIComponent(repoName)}/${fileId}`, {
		range: c.req.header,
	});
	if (!file) return c.text('File not found', 404);
	return new Response(file.body, {
		headers: {
			'Content-Type': file.httpMetadata?.contentType || '',
			'Content-Length': file.size.toString(),
			'ETag': file.etag,
			'Last-Modified': file.uploaded.toISOString(),
			'Cache-Control': file.httpMetadata?.cacheControl || '',
			'Cache-Expiry': file.httpMetadata?.cacheExpiry?.toISOString() || '',
			'Content-Encoding': file.httpMetadata?.contentEncoding || '',
			'Content-Language': file.httpMetadata?.contentLanguage || '',
			'Content-Disposition': file.httpMetadata?.contentDisposition || '',
		},
	});
}));

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
