# Post-Review Introspection · mailbox-share-capability

- Date: 2026-08-24
- Spec: docs/specs/mailbox-share-capability
- Rounds: 3 (internal SUB · channel sub · no codex CLI)

## What the draft got wrong

1. Assumed `RENAME COLUMN` was harmless expand — R1 caught publish/rollback break.
2. Persisted derived `share_type` without maintenance invariant — R1.
3. Over-claimed mask as security property over full response — R1/R2.
4. Over-claimed “never dead-on-arrival session” under stateless token — R2/R3.
5. Treated multi-only feature flag as sufficient publish gate — R3 (AuthKey/quota bypass on old workers).
6. Migration dirty-row predicate used “no Binding” — races with live old writers — R3.

## What improved

- Expand/migrate/contract + dual-write + `SHARE_CAPABILITY_V2` full capability gate.
- Status absolute watermarks; client-owned per-binding unread.
- Session establish Idempotency-Key + short KV replay for quota=“client obtained credential”.
- AuthKey state machine; masking as display preference; no auth_fail table.

## Generalizable?

| Finding | Gate | Action |
|---|---|---|
| Physical rename vs semantic rename | AP | Prefer keep physical column; map in DTO |
| Derived persisted fields need write-path invariants or don’t persist | E | Prefer compute-on-read for cardinality types |
| Feature flags must gate all producers of new security policy, not one create path | E | Capability activation checklist |
| Stateless token cannot promise response-time liveness under concurrent revoke | AP | Document TOCTOU; add establish idempotency for network loss separately |

`post-review-introspection` skill absent in this Cloud checkout → this stub satisfies crystallize minimum.
