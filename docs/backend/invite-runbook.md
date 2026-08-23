# Invite Runbook

This runbook covers how to send invites in Threa after removing in-app workspace-creation invite dispatch.

## Invite types

- **Workspace member invite**: Adds someone to an existing workspace. Sent in-app from Workspace Settings.
- **Workspace creation invite**: Allows someone to create a new workspace. Sent in WorkOS Dashboard only.

## 1) Send a workspace member invite (in-app)

1. Open the workspace where you want to add a member.
2. Go to `Workspace Settings` -> `Members`.
3. Click `Invite`.
4. Enter one or more email addresses.
5. Choose role (`member` or `admin`).
6. Submit the invite.
7. Confirm the invite appears in `Pending Invitations`.

Notes:

- These invites are workspace-scoped and tied to that workspace's WorkOS organization.
- Admins can manage member invites (send/resend/revoke).

## 2) Send a workspace creation invite (WorkOS Dashboard)

Use this when someone should be allowed to create a brand-new workspace.

1. Open the production WorkOS Dashboard.
2. Go to `User Management` -> `Users` -> `Invites`.
3. Click `Invite user` (or equivalent action in the current Dashboard UI).
4. Enter the recipient email.
5. Ensure this is an **application-wide invite**:
   - Do **not** select an organization/workspace.
   - If an organization is selected, the invite is org-scoped and will not satisfy workspace-creation gating.
6. Send the invite.
7. Ask the user to accept the invite via email and complete signup/sign-in.
8. After acceptance, the user can create a workspace in Threa.

Why this works:

- Backend checks for a WorkOS invitation with:
  - `state = accepted`
  - `organization_id = null` (application-level invite)

## 3) Verify invite status (optional)

In WorkOS Dashboard:

1. Go to `User Management` -> `Users` -> `Invites`.
2. Locate the recipient email.
3. Confirm state is `accepted` for workspace-creation access.

In Threa:

1. Sign in as the invited user.
2. Attempt `Create Workspace`.
3. Expected behavior:
   - Accepted application-level invite: create succeeds.
   - No accepted application-level invite: blocked with invite-required message.

## Troubleshooting

- **User still blocked after accepting invite**:
  - Confirm the invite was application-wide (no organization).
  - Confirm the invite state is `accepted` (not `pending`/`expired`/`revoked`).
  - Confirm you issued the invite in the production WorkOS environment.
- **Local dev behavior looks inconsistent**:
  - `USE_STUB_AUTH=true` does not validate real WorkOS invites.
  - `WORKSPACE_CREATION_SKIP_INVITE=true` explicitly bypasses workspace-creation invite enforcement (used by `dev:test`).

## References

- WorkOS Invitations overview: https://workos.com/docs/user-management/invitations
- WorkOS invite-only signup guide: https://workos.com/docs/user-management/invite-only-signup
- WorkOS Send invitation API: https://workos.com/docs/reference/user-management/invitation/send
