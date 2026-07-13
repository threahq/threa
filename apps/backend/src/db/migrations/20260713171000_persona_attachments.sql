-- Persona context attachments (persona-context-attachments): binds an existing
-- `attachments` row to a custom/personal persona so its extracted content rides
-- the persona's dispatch context. A join table, not a column on `attachments` —
-- the file keeps its message-centric columns (stream_id/message_id stay NULL
-- forever for a persona file) and the binding is persona-domain state.
--
-- attachment_id is the PRIMARY KEY: an attachment belongs to at most one persona
-- (no sharing/dedup in v1). No FKs (INV-1); TEXT ids validated in code (INV-3);
-- every query filters workspace_id (INV-8). The count cap and ordering are
-- enforced in the repository under a per-persona advisory lock (INV-20).

CREATE TABLE IF NOT EXISTS persona_attachments (
    attachment_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The list-and-cap read is always scoped to (workspace_id, persona_id) and
-- ordered by position; this index serves both the count guard and the ordered
-- fetch at dispatch.
CREATE INDEX IF NOT EXISTS idx_persona_attachments_persona_position
    ON persona_attachments (workspace_id, persona_id, position);
