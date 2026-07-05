-- User resolution takes precedence over the AI's rulings (Kris, 2026-07-05).
-- When a user explicitly marks a conversation resolved (or reopens it) from the
-- board, that intent is authoritative: the boundary-extraction LLM must not
-- silently flip the status back via its `completenessUpdates`. This flag records
-- that the status was user-set; the extractor's status write is guarded on it.
-- (The deterministic "a new message reopens a resolved conversation" path is real
-- activity, not an AI ruling, and is intentionally left unguarded.)

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS status_locked_by_user BOOLEAN NOT NULL DEFAULT FALSE;
