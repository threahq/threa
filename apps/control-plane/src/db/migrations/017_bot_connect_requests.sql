-- Device-code style requests from `threa-bot connect`: a runtime that has no
-- credentials yet asks for a pair of codes, the user approves in the browser
-- (which mints the bot key against the workspace's region), and the runtime
-- polls here for the result. Global (control-plane) because the device does
-- not know the workspace, hence the region, until approval.
--
-- `device_code_hash` is the SHA-256 of the secret the device holds; `user_code`
-- is the short code the user types, unique only while pending (partial index).
-- `api_key` is the minted bot key, held in plaintext between approval and the
-- single claim that hands it to the device, then nulled; every row expires
-- within minutes either way. `status` is TEXT validated in code (INV-3):
-- 'pending' | 'approved' | 'claimed' | 'denied'.

CREATE TABLE bot_connect_requests (
    id                         TEXT PRIMARY KEY,
    device_code_hash           TEXT NOT NULL UNIQUE,
    user_code                  TEXT NOT NULL,
    status                     TEXT NOT NULL DEFAULT 'pending',
    requested_name             TEXT,
    requested_host             TEXT,
    approved_workspace_id      TEXT,
    approved_workspace_name    TEXT,
    approved_bot_id            TEXT,
    approved_bot_slug          TEXT,
    approved_by_workos_user_id TEXT,
    api_key                    TEXT,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at                 TIMESTAMPTZ NOT NULL,
    approved_at                TIMESTAMPTZ,
    claimed_at                 TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_bot_connect_requests_pending_user_code
    ON bot_connect_requests (user_code)
    WHERE status = 'pending';

CREATE INDEX idx_bot_connect_requests_expires_at ON bot_connect_requests (expires_at);
