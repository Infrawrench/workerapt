import { Context } from 'hono';
import { array, object, safeParse, string } from 'valibot';
import consumeDeb, { ControlFields } from './debParser';
import type { DistDurableObject } from './durableObjects';

const debSchema = object({
	fileId: string(),
	md5: string(),
	sha256: string(),
});

const publishSchema = object({
	debs: array(debSchema),
});

export async function publishToDist(c: Context<{ Bindings: DistDurableObject }>): Promise<Response> {
	let j: unknown;
	try {
		j = await c.req.json();
	} catch (e) {
		console.error(e);
		return c.text('Expected JSON body', 400);
	}
	const validatorResult = safeParse(publishSchema, j);
	if (!validatorResult.success) {
		return c.text('Invalid body', 400);
	}
	const repoName = c.req.param('repoName')!;
	const catName = c.req.param('catName')!;

	const { debs } = validatorResult.output;
	const published: ControlFields[] = [];
	for (const deb of debs) {
		const { fileId, md5, sha256 } = deb;
		const file = await c.env.env.POOL_BUCKET.get(`${encodeURIComponent(repoName)}/${encodeURIComponent(fileId)}`);
		if (!file) {
			return c.json({ error: 'File not found', fileId }, 404);
		}

		const controlFields = await consumeDeb(file.body);
		published.push({
			...controlFields,
			Filename: `pool/${fileId}`,
			Size: String(file.size),
			MD5Sum: md5,
			SHA256: sha256,
			fileId,
		});
	}

	c.env.ctx.storage.transactionSync(() => {
		for (const controlField of published) {
			const fileId = controlField.fileId;
			const cpy = { ...controlField };
			delete cpy.fileId;
			const j = JSON.stringify(cpy);
			c.env.ctx.storage.sql.exec(
				'INSERT INTO releases (cat_name, id, metadata, architecture) VALUES (?, ?, ?, ?) ON CONFLICT(cat_name, id) DO UPDATE SET metadata = ?',
				catName,
				fileId,
				j,
				cpy.Architecture ?? 'all',
				j,
			);
		}
	});

	c.env.flushCache();

	return c.json({ published });
}
