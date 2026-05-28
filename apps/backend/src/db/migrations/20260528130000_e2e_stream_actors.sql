-- Move the single invited-agent scalar on e2e_streams to a set of invited
-- actors, so one E2E stream can wrap its SSK to multiple non-human actors
-- (e.g. a bot and the enclave together). Composite PK mirrors the
-- stream_members link-table pattern — no synthetic id.
CREATE TABLE e2e_stream_actors (
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key_id TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, stream_id, kind)
);

CREATE INDEX idx_e2e_stream_actors_stream
  ON e2e_stream_actors (workspace_id, stream_id);

-- Backfill existing invites; "none" rows carry no actor.
INSERT INTO e2e_stream_actors (workspace_id, stream_id, kind, key_id)
  SELECT workspace_id, stream_id, invited_agent_kind, invited_agent_key_id
  FROM e2e_streams
  WHERE invited_agent_kind <> 'none';

ALTER TABLE e2e_streams
  DROP COLUMN invited_agent_kind,
  DROP COLUMN invited_agent_key_id;
