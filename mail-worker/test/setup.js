import { env, SELF } from 'cloudflare:test';

const secret = env.jwt_secret;
if (!secret) {
	throw new Error('jwt_secret binding missing; check wrangler-vitest.toml');
}

if (!env.db) {
	throw new Error('D1 binding db missing; check wrangler-vitest.toml');
}

const response = await SELF.fetch(`http://example.com/api/init/${encodeURIComponent(secret)}`);
const body = await response.text();
if (body !== 'success') {
	throw new Error(`test schema init failed: status=${response.status} body=${body}`);
}
