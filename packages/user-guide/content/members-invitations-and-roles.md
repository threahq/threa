---
title: Members, invitations and roles
summary: How to invite people by email or link, see pending invitations, change roles and remove members, and what each role can do.
section: workspace
order: 2
---

# Members, invitations and roles

The **Users** tab in Workspace Settings lists everyone in the workspace and manages invitations. Every member can see the member list. Inviting people, changing roles and removing members need the Manage members permission, which workspace admins and owners have.

## Roles

- **Member**: the default role. Members read and write in the workspace and can create personal bots.
- **Admin**: everything a member can do, plus managing members, bots, integrations and workspace settings. Admins cannot transfer ownership.
- **Owner**: everything an admin can do, plus ownership-only actions such as promoting or demoting an owner, transferring ownership and deleting the workspace.

The role dropdown next to a member offers Member and Admin. Owners show an **Owner** badge and cannot be changed or removed from this tab. You cannot change or remove yourself. A workspace always keeps at least one owner.

## Invite by email

Open **Invite** and choose **Invite by email**. In the **Invite Users** dialog, enter email addresses one per line or separated by commas, pick a **Role** (Member or Admin) and choose **Send Invitations**. You can send up to 20 addresses at a time.

Addresses that already belong to a user, or that already have a pending invitation, are skipped and listed in the result as "Already a user" or "Invitation already pending". Each email invitation expires after 7 days, and it can only be accepted with the address it was sent to.

Pending invitations appear under **Pending invitations** with their role and expiry date. **Resend** replaces the invitation with a fresh one for the same address and role. **Revoke** cancels it.

## Invite by link

Open **Invite** and choose **Create invite link**. A link always gives the Member role. Set:

- **Maximum joins**: how many people can join through the link, or turn on **Unlimited**. The default is 1.
- **Expiration**: a date and time, or turn on **Never expires**. The default is 7 days from now.
- **Note** (optional, up to 200 characters), shown on the link's row.

When you choose **Create link**, Threa shows the link once. Copy it before you close the dialog: it cannot be shown again, and **Copy link** in the list only works until you refresh the page.

Anyone who opens the link enters their email address and gets a sign-in link by email to finish joining. Links show under **Invite links** as Active, Expired or Exhausted, with a count such as "1 of 5 joined". **Edit** changes the maximum joins or expiry (the maximum cannot go below the number who have already joined), and **Revoke** cancels the link.

## Remove a member

Open the **...** menu next to a member and choose **Remove from workspace**, then confirm with **Remove**. They lose access immediately.
