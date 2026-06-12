-- Enclave pull transport (§2.7): invert push-addressed assignment to a
-- claimable work queue, converging the enclave onto the claim lifecycle the
-- bot path already runs in production (pending → claimed (TTL + attempts) →
-- completed/failed/parked).
--
-- One row per enclave turn trigger (a user message in an E2E scratchpad with
-- companion mode on). The enclave polls the backend and claims the oldest
-- item its EIK can actually serve — the claim predicate joins this row to
-- `stream_e2e_key_wraps` on the claimer's key id, so an item whose stream has
-- no wrap for any live EIK simply stays pending until the owner's client
-- revives the wrap (replacing the old queue-retry parking dance).
--
-- Workspace-scoped product data (INV-8): rows carry workspace_id and every
-- per-row mutation filters on it. The claim poll itself is deliberately
-- cross-workspace — the enclave is global infrastructure (like the
-- enclave_runtimes registry it authenticates as), serving every workspace
-- from one claim loop. `einv_` ULID id per INV-2; statuses are TEXT validated
-- in code (INV-3).

CREATE TABLE IF NOT EXISTS enclave_invocations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    -- Stream the trigger landed in (thread or root) — the reply goes here.
    stream_id TEXT NOT NULL,
    -- The root scratchpad carrying the E2E identity (wraps, key generations).
    -- Resolved at enqueue time; a thread's root never changes.
    root_stream_id TEXT NOT NULL,
    -- The triggering user message (its ciphertext becomes the prompt).
    message_id TEXT NOT NULL,
    triggered_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | claimed | completed | failed | parked
    claimed_by_key_id TEXT,
    claim_token TEXT,
    claim_expires_at TIMESTAMPTZ,
    -- Stamped when the claim creates its agent_sessions row, so the session
    -- callbacks (heartbeat renew, complete, fail) can address the claim
    -- without carrying the invocation id through the enclave.
    session_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- One invocation per trigger message: the outbox dispatch insert is
-- idempotent on redelivery, and the post-completion catch-up path reopens a
-- terminal row instead of inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_enclave_invocations_trigger
    ON enclave_invocations (workspace_id, message_id);

-- The claim poll scans only live work; tombstoned terminal rows stay out of
-- the index.
CREATE INDEX IF NOT EXISTS idx_enclave_invocations_claimable
    ON enclave_invocations (status, created_at)
    WHERE status IN ('pending', 'claimed');

-- Session callbacks flip the claim by session id (complete/fail/renew).
CREATE INDEX IF NOT EXISTS idx_enclave_invocations_session
    ON enclave_invocations (session_id)
    WHERE session_id IS NOT NULL;

-- Cancellation rides the pull channel too: "Stop research" sets this flag and
-- the enclave consumes it on its next session heartbeat (the inbound
-- /sessions/:id/cancel route is gone). NULL = no abort requested.
ALTER TABLE agent_sessions
    ADD COLUMN IF NOT EXISTS abort_requested_at TIMESTAMPTZ;

-- The enclave no longer runs an inbound content listener, so instances have
-- no routable address to register (and nothing to SSRF-validate).
ALTER TABLE enclave_runtimes
    DROP COLUMN IF EXISTS instance_url;
