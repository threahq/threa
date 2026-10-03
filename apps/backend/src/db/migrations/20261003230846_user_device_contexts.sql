-- The latest device each user reported on a socket heartbeat, one row per user
-- per workspace, so the companion can match its directions to the user's screen.
-- Its own table rather than columns on users: user rows are broadcast to every
-- workspace member, and a user's device must not travel with them.
CREATE TABLE IF NOT EXISTS user_device_contexts (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  layout TEXT NOT NULL,
  os TEXT NOT NULL,
  installed BOOLEAN NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
