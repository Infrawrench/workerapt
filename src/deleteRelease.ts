import { Context } from 'hono';
import { DistDurableObject } from './durableObjects';

export async function deleteRelease(c: Context<{ Bindings: DistDurableObject }>): Promise<Response> {
	const catName = c.req.param('catName')!;
	const id = c.req.param('id')!;
	c.env.ctx.storage.sql.exec('DELETE FROM releases WHERE cat_name = ? AND id = ?', catName, id);
	c.env.flushCache();
	return c.text('Release deleted', 200);
}
