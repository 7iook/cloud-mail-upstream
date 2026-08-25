/*
 * The one place a "current + previous" keyed-secret ring is built.
 *
 * Three rings share this shape — the sec pepper and the session signing key
 * (share-auth-service.js) and the sec KEK (share-sec-cipher.js). They were three
 * copies of the same nine lines until T-20b2a folded them here: a ring that
 * disagrees with its siblings about what an empty value or a duplicate kid means
 * is a fail-open waiting to happen, and drift between copies is invisible until
 * a key rotation lands on the odd one out.
 *
 * Contract, unchanged from the original in share-auth-service.js:
 * - An empty / missing value contributes no entry, so "configured" and
 *   "present in the ring" are the same question.
 * - A duplicate kid keeps the first (current) entry; the previous slot never
 *   shadows the current one.
 * - kid defaults are positional: 'v1' for current, 'v0' for previous, so a
 *   deployment that sets only the secret still names it deterministically.
 * - Order is current-then-previous, and callers rely on ring[0] being the key
 *   new material is minted under.
 */
export function collectKeyedSecrets(currentKid, currentValue, prevKid, prevValue) {
	const keys = [];
	const seen = new Set();
	const add = (kid, value) => {
		if (!value || seen.has(kid)) {
			return;
		}
		seen.add(kid);
		keys.push({ kid, value });
	};
	add(currentKid || 'v1', currentValue);
	add(prevKid || 'v0', prevValue);
	return keys;
}
