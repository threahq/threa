-- Memo visibility scope (roadmap 6.4): the private/shared tier split.
--
-- `scope` is the visibility tier: 'workspace' (default — every existing row),
-- 'stream', or 'user'. workspace/stream memos are gated by the retriever's
-- stream access (INV-62); a 'user' memo is additionally private to a single
-- owner carried in `scope_user_id` — the per-user "what Ariadne knows about you"
-- tier, extracted from private scratchpads and settable via `save_memo`.
--
-- `workspace_id` stays required regardless of scope (INV-8): 'user' subdivides
-- WITHIN the workspace boundary, it is not a global private store.
--
-- Not a DB enum (INV-3): TEXT validated in code against MEMO_SCOPES. The CHECK is
-- a structural integrity guard (like memo_type_source), not an enum: a 'user'
-- memo must name its owner and a non-'user' memo must not — so the retrieval gate
-- (scope = 'user' → owner match) can never see a user-scoped row without an owner.
ALTER TABLE memos
ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'workspace';

ALTER TABLE memos
ADD COLUMN IF NOT EXISTS scope_user_id TEXT;

-- NOT VALID skips the validating table scan at ADD time (only a brief catalog
-- lock), then VALIDATE re-checks existing rows under a weaker ShareUpdateExclusive
-- lock that does not block writes — the standard no-downtime pattern for adding a
-- CHECK to a populated table. Every existing row (scope 'workspace', owner NULL)
-- already satisfies it, so the validation is a formality. The owner-index build is
-- deferred to the companion CONCURRENTLY migration (CONCURRENTLY cannot run inside
-- this file's implicit multi-statement transaction).
ALTER TABLE memos
ADD CONSTRAINT memo_scope_owner CHECK (
    (scope = 'user' AND scope_user_id IS NOT NULL) OR
    (scope <> 'user' AND scope_user_id IS NULL)
) NOT VALID;

ALTER TABLE memos VALIDATE CONSTRAINT memo_scope_owner;
