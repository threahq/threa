-- Generalize label ownership/attribution from user-only to a polymorphic actor.
-- Public API keys made bots first-class label actors (a shared bot has no owning
-- user, so it can't be reduced to a UserId). The companion id columns are left
-- in place — `labels.creator_user_id`, `label_members.user_id`, and
-- `label_assignments.user_id` now carry the *actor's* id, and the new
-- `*_actor_type` column says whether that id is a user or a bot. User and bot ids
-- are globally unique prefixed ULIDs, so the existing id-keyed indexes/PKs stay
-- correct (no two actors share an id) and viewer checks that compare the id to a
-- UserId keep working: a bot id never equals a user id.
--
-- DEFAULT 'user' backfills every existing row (all are user-owned today) in one
-- pass; the default is then dropped so new writes must state the actor type
-- explicitly (INV-11: no silent fallback in the app layer).

ALTER TABLE labels ADD COLUMN creator_actor_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE labels ALTER COLUMN creator_actor_type DROP DEFAULT;

ALTER TABLE label_members ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE label_members ALTER COLUMN actor_type DROP DEFAULT;

ALTER TABLE label_assignments ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE label_assignments ALTER COLUMN actor_type DROP DEFAULT;
