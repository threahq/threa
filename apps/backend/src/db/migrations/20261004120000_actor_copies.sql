-- Threa Connect: a partner workspace's copy of a shared channel names the host
-- personas and bots that wrote or reacted in it. A copy is display only, under
-- the host's id (its prefix says persona or bot), never a persona or bot here.
CREATE TABLE actor_copies (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    origin_workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar_emoji TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, id)
);
