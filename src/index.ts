import { Context, Hono } from 'hono';
import crypto from 'node:crypto';
import { AwsClient } from 'aws4fetch';

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

app.get('/:repoName/setup', (c) => {
	const repoName = c.req.param('repoName');
	const dist = c.req.query('dist') || 'stable';
	const component = c.req.query('component') || 'main';
	const origin = new URL(c.req.url).origin;
	const keyringPath = `/etc/apt/keyrings/${repoName}.asc`;
	const listPath = `/etc/apt/sources.list.d/${repoName}.list`;
	const body = `# Add the ${repoName} apt repository
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL ${origin}/${repoName}/key.asc | sudo tee ${keyringPath} > /dev/null
echo "deb [signed-by=${keyringPath}] ${origin}/${repoName} ${dist} ${component}" | sudo tee ${listPath} > /dev/null
sudo apt-get update
`;
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Access-Control-Allow-Origin': '*',
		},
	});
});

app.get('/:repoName/key.asc', (c) => {
	return new Response(c.env.GPG_PUBLIC_KEY, {
		status: 200,
		headers: {
			'Content-Type': 'application/pgp-keys',
			'Access-Control-Allow-Origin': '*',
		},
	});
});

app.get('/:repoName/dists/:distName', (c) => processRewrite(c, c.req.param('repoName'), c.req.param('distName')));

app.get('/:repoName/dists/:distName/*', (c) => processRewrite(c, c.req.param('repoName'), c.req.param('distName')));

function authorize(fn: (c: Context<{ Bindings: Env }>) => Promise<Response>) {
	return async (c: Context<{ Bindings: Env }>) => {
		const auth = c.req.header('Authorization') || '';
		if (!auth.startsWith('Bearer ')) return c.text('Unauthorized', 401);
		const token = auth.slice(7);
		if (token !== c.env.KEY) {
			// Add a delay here to prevent timing attacks
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
			return c.text('Unauthorized', 401);
		}
		return fn(c);
	};
}

app.delete(
	'/:repoName/dists/:distName/:catName/:id',
	authorize((c) => processRewrite(c, c.req.param('repoName')!, c.req.param('distName')!)),
);

app.put(
	'/:repoName/dists/:distName/:catName',
	authorize((c) => processRewrite(c, c.req.param('repoName')!, c.req.param('distName')!, true)),
);

app.post(
	'/:repoName/pool/presign',
	authorize(async (c) => {
		const repoName = c.req.param('repoName');
		if (!repoName) return c.text('Expected repoName', 400);
		const fileId = crypto.randomUUID();
		const key = `${encodeURIComponent(repoName)}/${fileId}`;

		const aws = new AwsClient({
			accessKeyId: c.env.R2_ACCESS_KEY_ID,
			secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
			service: 's3',
			region: 'auto',
		});

		const expiresIn = 3600;
		const url = new URL(`https://${c.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${c.env.R2_BUCKET_NAME}/${key}`);
		url.searchParams.set('X-Amz-Expires', String(expiresIn));

		const signed = await aws.sign(url.toString(), {
			method: 'PUT',
			aws: { signQuery: true },
		});

		return c.json({
			fileId,
			uploadUrl: signed.url,
			method: 'PUT',
			expiresIn,
		});
	}),
);

app.put(
	'/:repoName/pool',
	authorize(async (c) => {
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
	}),
);

app.delete(
	'/:repoName/pool/:fileId',
	authorize(async (c) => {
		const repoName = c.req.param('repoName');
		if (!repoName) return c.text('Expected repoName', 400);
		const fileId = c.req.param('fileId');
		if (!fileId) return c.text('Expected fileId', 400);
		await c.env.POOL_BUCKET.delete(`${encodeURIComponent(repoName)}/${fileId}`);
		return c.json({ success: true });
	}),
);

app.get('/:repoName/pool/:fileId', async (c) => {
	const repoName = c.req.param('repoName');
	if (!repoName) return c.text('Expected repoName', 400);
	const fileId = c.req.param('fileId');
	if (!fileId) return c.text('Expected fileId', 400);
	const file = await c.env.POOL_BUCKET.get(`${encodeURIComponent(repoName)}/${fileId}`);
	if (!file) return c.text('File not found', 404);
	return new Response(file.body, {
		headers: {
			'Content-Type': file.httpMetadata?.contentType || '',
			'Content-Length': file.size.toString(),
			ETag: file.etag,
			'Last-Modified': file.uploaded.toUTCString(),
			'Cache-Control': file.httpMetadata?.cacheControl || '',
			'Cache-Expiry': file.httpMetadata?.cacheExpiry?.toISOString() || '',
			'Content-Encoding': file.httpMetadata?.contentEncoding || '',
			'Content-Language': file.httpMetadata?.contentLanguage || '',
			'Content-Disposition': file.httpMetadata?.contentDisposition || '',
		},
	});
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
