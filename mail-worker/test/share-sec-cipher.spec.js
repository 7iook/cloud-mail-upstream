import { describe, expect, it } from 'vitest';
import {
	ENVELOPE_VERSION,
	SEC_CIPHER_FAILURE,
	decryptShareSec,
	encryptShareSec,
	kekRing,
	probeKek
} from '../src/security/share-sec-cipher.js';

// base64url of 32 random bytes, per the KEK material contract (决策卡 §5).
const KEK_V1 = 'Zm9vYmFyLWtlay1tYXRlcmlhbC12MS0zMmJ5dGVzISE';
const KEK_V2 = 'YmF6LXF1eC1rZWstbWF0ZXJpYWwtdjItMzJieXRlcyE';

const SHARE_ID = 'shr_t20b1_alpha';
const OTHER_SHARE_ID = 'shr_t20b1_beta';
const SEC = 'sec_9f2c41ab7d';

function envV1() {
	return { SHARE_SEC_KEK: KEK_V1, SHARE_SEC_KEK_KID: 'v1' };
}

// Rotation overlap: v2 is current, v1 stays reachable as prev.
function envRotating() {
	return {
		SHARE_SEC_KEK: KEK_V2,
		SHARE_SEC_KEK_KID: 'v2',
		SHARE_SEC_KEK_PREV: KEK_V1,
		SHARE_SEC_KEK_PREV_KID: 'v1'
	};
}

function envV2Only() {
	return { SHARE_SEC_KEK: KEK_V2, SHARE_SEC_KEK_KID: 'v2' };
}

async function seal(env, plaintext = SEC, shareId = SHARE_ID) {
	const sealed = await encryptShareSec(env, { shareId, plaintext });
	expect(sealed.ok).toBe(true);
	return sealed;
}

function corruptLastSegment(envelope) {
	const parts = envelope.split(':');
	const ct = parts[parts.length - 1];
	// Flip one base64url character of the ciphertext‖tag, keeping the alphabet legal
	// so this exercises the GCM tag rather than the decoder.
	const idx = ct.length - 3;
	const flipped = ct[idx] === 'A' ? 'B' : 'A';
	parts[parts.length - 1] = `${ct.slice(0, idx)}${flipped}${ct.slice(idx + 1)}`;
	return parts.join(':');
}

describe('T-20b1 share sec envelope cipher — key ring', () => {
	it('builds a current+prev ring in that order, dropping unset entries', () => {
		expect(kekRing(envRotating())).toEqual([
			{ kid: 'v2', value: KEK_V2 },
			{ kid: 'v1', value: KEK_V1 }
		]);
		expect(kekRing(envV1())).toEqual([{ kid: 'v1', value: KEK_V1 }]);
		expect(kekRing({})).toEqual([]);
	});

	it('reports KEK availability so the create path can fail closed before writing a row', () => {
		expect(probeKek(envRotating())).toEqual({
			available: true,
			currentKid: 'v2',
			kids: ['v2', 'v1']
		});
		expect(probeKek({})).toEqual({ available: false, currentKid: null, kids: [] });
	});
});

describe('T-20b1 share sec envelope cipher — round trip', () => {
	it('returns the original secret after encrypt then decrypt', async () => {
		const env = envV1();
		const sealed = await seal(env);
		expect(sealed.kekKid).toBe('v1');
		expect(sealed.envelope.startsWith(`${ENVELOPE_VERSION}:v1:`)).toBe(true);
		expect(sealed.envelope).not.toContain(SEC);

		const opened = await decryptShareSec(env, { shareId: SHARE_ID, envelope: sealed.envelope });
		expect(opened).toEqual({ ok: true, plaintext: SEC, kekKid: 'v1' });
	});

	it('round-trips the empty string and multi-byte UTF-8 without loss', async () => {
		const env = envV1();
		for (const plaintext of ['', '密钥🔐 naïve \u0000 tail', 'a'.repeat(4096)]) {
			const sealed = await seal(env, plaintext);
			const opened = await decryptShareSec(env, { shareId: SHARE_ID, envelope: sealed.envelope });
			expect(opened.ok).toBe(true);
			expect(opened.plaintext).toBe(plaintext);
		}
	});

	it('emits a versioned 4-segment envelope with a 96-bit nonce', async () => {
		const sealed = await seal(envV1());
		const parts = sealed.envelope.split(':');
		expect(parts).toHaveLength(4);
		expect(parts[0]).toBe(ENVELOPE_VERSION);
		expect(parts[1]).toBe('v1');
		// base64url of 12 bytes is 16 chars unpadded.
		expect(parts[2]).toMatch(/^[A-Za-z0-9_-]{16}$/);
		expect(parts[2]).not.toContain('=');
		expect(parts[3]).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

describe('T-20b1 share sec envelope cipher — nonce uniqueness', () => {
	it('never reuses a nonce: the same plaintext encrypted twice differs in both nonce and ciphertext', async () => {
		const env = envV1();
		const nonces = new Set();
		const ciphertexts = new Set();
		for (let i = 0; i < 32; i++) {
			const parts = (await seal(env)).envelope.split(':');
			nonces.add(parts[2]);
			ciphertexts.add(parts[3]);
		}
		expect(nonces.size).toBe(32);
		expect(ciphertexts.size).toBe(32);
	});

	it('does not derive the nonce from shareId: repeats of one share differ, and so do two shares', async () => {
		const env = envV1();
		const first = await seal(env, SEC, SHARE_ID);
		const second = await seal(env, SEC, SHARE_ID);
		const other = await seal(env, SEC, OTHER_SHARE_ID);
		const nonceOf = (sealed) => sealed.envelope.split(':')[2];
		// The same-share repeat is the assertion that falsifies a derived nonce;
		// two different shares would differ under a derivation too.
		expect(nonceOf(first)).not.toBe(nonceOf(second));
		expect(nonceOf(first)).not.toBe(nonceOf(other));
	});
});

describe('T-20b1 share sec envelope cipher — AAD binds the row', () => {
	it('refuses an envelope lifted onto another share row', async () => {
		const env = envV1();
		const sealed = await seal(env);
		const opened = await decryptShareSec(env, {
			shareId: OTHER_SHARE_ID,
			envelope: sealed.envelope
		});
		expect(opened).toEqual({ ok: false, reason: SEC_CIPHER_FAILURE.AUTH_FAILED, kekKid: 'v1' });
	});

	it('refuses an empty shareId rather than silently unbinding the ciphertext', async () => {
		const env = envV1();
		await expect(encryptShareSec(env, { shareId: '', plaintext: SEC })).rejects.toThrow(/shareId/);
		const sealed = await seal(env);
		await expect(decryptShareSec(env, { shareId: '', envelope: sealed.envelope }))
			.rejects.toThrow(/shareId/);
	});
});

describe('T-20b1 share sec envelope cipher — rotation', () => {
	it('keeps a prev-kid envelope readable while current has already moved on', async () => {
		const sealedUnderV1 = await seal(envV1());
		const rotating = envRotating();

		const opened = await decryptShareSec(rotating, {
			shareId: SHARE_ID,
			envelope: sealedUnderV1.envelope
		});
		expect(opened).toEqual({ ok: true, plaintext: SEC, kekKid: 'v1' });

		// New writes move forward to the current kid; the ring never decides which
		// key an existing row used — the kid on the envelope does.
		const fresh = await seal(rotating);
		expect(fresh.kekKid).toBe('v2');
	});

	it('degrades a retired kid to unknown_kid, distinct from a corrupt ciphertext', async () => {
		const sealedUnderV1 = await seal(envV1());
		const opened = await decryptShareSec(envV2Only(), {
			shareId: SHARE_ID,
			envelope: sealedUnderV1.envelope
		});
		expect(opened).toEqual({ ok: false, reason: SEC_CIPHER_FAILURE.UNKNOWN_KID, kekKid: 'v1' });
	});
});

describe('T-20b1 share sec envelope cipher — four failure classes stay distinguishable', () => {
	it('① no ciphertext on the row (pre-feature share) reports absent', async () => {
		const env = envV1();
		for (const envelope of [null, undefined, '', '   ']) {
			const opened = await decryptShareSec(env, { shareId: SHARE_ID, envelope });
			expect(opened).toEqual({ ok: false, reason: SEC_CIPHER_FAILURE.ABSENT });
		}
	});

	it('② an empty ring reports kek_missing, on both read and write', async () => {
		const sealed = await seal(envV1());
		expect(await decryptShareSec({}, { shareId: SHARE_ID, envelope: sealed.envelope }))
			.toEqual({ ok: false, reason: SEC_CIPHER_FAILURE.KEK_MISSING });
		// Create-side fail-closed: no envelope is produced at all.
		expect(await encryptShareSec({}, { shareId: SHARE_ID, plaintext: SEC }))
			.toEqual({ ok: false, reason: SEC_CIPHER_FAILURE.KEK_MISSING });
	});

	it('③ a kid outside the ring reports unknown_kid, not auth_failed', async () => {
		const sealed = await seal(envV1());
		const foreign = sealed.envelope.replace(`${ENVELOPE_VERSION}:v1:`, `${ENVELOPE_VERSION}:v9:`);
		expect(await decryptShareSec(envV1(), { shareId: SHARE_ID, envelope: foreign }))
			.toEqual({ ok: false, reason: SEC_CIPHER_FAILURE.UNKNOWN_KID, kekKid: 'v9' });
	});

	it('④ a tampered ciphertext byte reports auth_failed, not a silent null', async () => {
		const env = envV1();
		const sealed = await seal(env);
		const opened = await decryptShareSec(env, {
			shareId: SHARE_ID,
			envelope: corruptLastSegment(sealed.envelope)
		});
		expect(opened).toEqual({ ok: false, reason: SEC_CIPHER_FAILURE.AUTH_FAILED, kekKid: 'v1' });
	});

	it('the four classes are four distinct reasons, never folded into one', async () => {
		const env = envV1();
		const sealed = await seal(env);
		const reasons = [
			(await decryptShareSec(env, { shareId: SHARE_ID, envelope: null })).reason,
			(await decryptShareSec({}, { shareId: SHARE_ID, envelope: sealed.envelope })).reason,
			(await decryptShareSec(envV2Only(), { shareId: SHARE_ID, envelope: sealed.envelope })).reason,
			(await decryptShareSec(env, { shareId: OTHER_SHARE_ID, envelope: sealed.envelope })).reason
		];
		expect(new Set(reasons).size).toBe(4);
		expect(reasons).toEqual([
			SEC_CIPHER_FAILURE.ABSENT,
			SEC_CIPHER_FAILURE.KEK_MISSING,
			SEC_CIPHER_FAILURE.UNKNOWN_KID,
			SEC_CIPHER_FAILURE.AUTH_FAILED
		]);
	});
});

describe('T-20b1 share sec envelope cipher — malformed envelopes fail cleanly', () => {
	it('reports malformed instead of throwing, for every shape of garbage', async () => {
		const env = envV1();
		const sealed = await seal(env);
		const parts = sealed.envelope.split(':');
		const garbage = [
			'not-an-envelope',
			'v1:v1:only-three',
			`v1:v1:${parts[2]}:${parts[3]}:extra-tail`,
			`v2:v1:${parts[2]}:${parts[3]}`,
			`V1:v1:${parts[2]}:${parts[3]}`,
			`v1::${parts[2]}:${parts[3]}`,
			`v1:v1:!!!not-base64!!!:${parts[3]}`,
			`v1:v1:${parts[2]}:@@@not-base64@@@`,
			`v1:v1:${parts[2].slice(0, 8)}:${parts[3]}`,
			`v1:v1:${parts[2]}:`,
			42,
			{ envelope: 'object' }
		];
		for (const envelope of garbage) {
			const opened = await decryptShareSec(env, { shareId: SHARE_ID, envelope });
			expect(opened.ok, `expected malformed for ${String(envelope)}`).toBe(false);
			expect(opened.reason, `expected malformed for ${String(envelope)}`)
				.toBe(SEC_CIPHER_FAILURE.MALFORMED);
		}
	});
});
