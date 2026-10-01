-- Users without a login: people an org workspace knows about before anyone
-- claims them, and partner copies. Both carry no WorkOS identity and may carry
-- no email. The (workspace_id, workos_user_id) unique key still holds for
-- claimed users; NULLs never collide in it.
ALTER TABLE users ALTER COLUMN workos_user_id DROP NOT NULL;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
