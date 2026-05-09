import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				bindings: {
					KEY: 'test-key',
					GPG_PUBLIC_KEY: '',
					GPG_PRIVATE_KEY: '',
					ORIGIN: 'TestOrigin',
					LABEL: 'TestLabel',
				},
			},
		}),
	],
});
