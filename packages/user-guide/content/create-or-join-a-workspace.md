---
title: Creating or joining a workspace
summary: Pick a workspace, accept an invitation, open an invite link, or create a new workspace.
section: getting-started
order: 5
---

# Creating or joining a workspace

A workspace is where your streams, people and memory live. After signing in you either open one you already belong to, accept an invitation, or create a new one.

## The workspace picker

The picker greets you with "Welcome, `<your name>`" and "Select a workspace to continue". It lists:

- **Pending invitations**: each workspace that has invited you, with an **Accept** button.
- Your workspaces, as buttons. Select one to open it.

If you belong to exactly one workspace and have no pending invitations, Threa skips the picker and opens that workspace.

Selecting **Accept** adds you to the workspace and takes you to the welcome page, where you set up your profile. See [Your welcome setup](/guide/welcome-and-profile-setup). Accept can fail with a message such as "This invitation was revoked." or "This invitation has expired." Ask the person who invited you for a new one. If you see "Sign in with the email address that received this invitation.", sign in with that address, or [add that account](/guide/sign-in-and-accounts).

## Create a workspace

Under the list, enter a name in **New workspace name** and select **Create Workspace**. Threa derives the workspace slug from the name, and there is no separate field for it. If more than one region is available, a **Select region** menu appears so you can choose where the workspace is hosted.

Creating a workspace requires a dedicated workspace invite. Without one, Threa shows "Workspace creation requires a dedicated workspace invite."

## Open an invite link

An invite link points to a `/join/` page. It shows "You're invited to" followed by the workspace name, and either an expiry date or "This link does not expire".

1. Enter your email in the **Email** field and select **Continue**.
2. Threa sends a sign-in link to that address. The page confirms with "Check your inbox".
3. Open the link in the email to join the workspace.

Other states you may see:

- **Already a member**: your email already belongs to the workspace. Select **Sign in** to continue.
- **Invitation not found**, **Invitation revoked**, **Invitation expired**, **Invite link already used** or **Invitation link is full**: the link no longer works. Ask for a new one.
- **Link is busy**: the link has too many pending join requests. Try again in a little while.
- **Invitations unavailable**: try again in a minute.

Except for **Already a member**, each of these pages has a **Sign in instead** button for people who already have an account.

To create invitations yourself, see [Members, invitations and roles](/guide/members-invitations-and-roles).
