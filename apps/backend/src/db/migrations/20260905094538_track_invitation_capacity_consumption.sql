ALTER TABLE workspace_invitations
  ADD COLUMN acceptance_consumes_capacity BOOLEAN;

UPDATE workspace_invitations
SET acceptance_consumes_capacity = accepted_workos_user_id IS NOT NULL
WHERE parent_link_id IS NOT NULL
  AND accepted_at IS NOT NULL;
