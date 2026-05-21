CREATE TABLE stream_active_actors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  root_stream_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, root_stream_id)
);

CREATE INDEX idx_stream_active_actors_actor
  ON stream_active_actors (workspace_id, actor_type, actor_id);

CREATE TABLE bot_runtime_instances (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  runtime_kind TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL,
  accepting_invocations BOOLEAN NOT NULL DEFAULT FALSE,
  capabilities JSONB NOT NULL DEFAULT '{}',
  status_text TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, bot_id, instance_id)
);

CREATE INDEX idx_bot_runtime_instances_lookup
  ON bot_runtime_instances (workspace_id, bot_id, status, accepting_invocations);

CREATE TABLE bot_runtime_session_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  runtime_kind TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  root_stream_id TEXT NOT NULL,
  active_stream_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  linked_by TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, bot_id, root_stream_id, active_stream_id),
  UNIQUE (workspace_id, bot_id, runtime_kind, instance_id, runtime_session_id)
);

CREATE INDEX idx_bot_runtime_session_links_instance
  ON bot_runtime_session_links (workspace_id, bot_id, instance_id, status);

CREATE TABLE bot_invocations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  root_stream_id TEXT NOT NULL,
  active_stream_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  response_stream_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  required_capability TEXT NOT NULL,
  prompt_markdown TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  mentioned_actor_slugs TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  target_instance_id TEXT,
  target_runtime_session_id TEXT,
  claimed_by_instance_id TEXT,
  claim_token TEXT,
  claim_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, source_message_id, actor_type, actor_id, trigger)
);

CREATE INDEX idx_bot_invocations_claimable
  ON bot_invocations (workspace_id, actor_id, status, created_at)
  WHERE status IN ('pending', 'claimed');

CREATE INDEX idx_bot_invocations_source_message
  ON bot_invocations (workspace_id, source_message_id);

UPDATE bots
SET traits = ARRAY(
  SELECT DISTINCT unnest(array_remove(traits, 'interactive') || ARRAY['mentionable', 'active-scratchpad']::text[])
)
WHERE 'interactive' = ANY(traits);
