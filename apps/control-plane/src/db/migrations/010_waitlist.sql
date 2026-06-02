-- Waitlist signups from the public marketing site (threa.io).
-- Global, unauthenticated capture; email is normalized (lowercased/trimmed)
-- in the service before insert. Status carries the vetting lifecycle:
-- 'pending' on signup, later 'invited' when access is granted.

CREATE TABLE waitlist (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_waitlist_status_created ON waitlist (status, created_at);
