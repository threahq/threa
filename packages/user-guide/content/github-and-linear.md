---
title: GitHub and Linear
summary: How workspace admins connect GitHub and Linear, and what the connection gives link previews and agents.
section: integrations
order: 5
---

# GitHub and Linear

Connecting GitHub or Linear gives the whole workspace two things. Links to GitHub and Linear items show rich previews, and agents that have the matching tools can read from those services. Workspace admins manage the connections in the [Integrations](app:workspace-settings/integrations) tab of Workspace Settings. Other members who open the tab see "You need the Workspace Admin permission to manage integrations."

## GitHub

GitHub previews cover pull requests, issues, commits, files and comments. To connect, select **Connect GitHub**, which sends you to GitHub to install the Threa GitHub App. If the tab says "GitHub App credentials are not configured on this deployment yet", the deployment you are on has no GitHub App set up and there is nothing to connect.

Each connected GitHub account or organization appears as its own row with a **Personal** or **Organization** badge and a **Connected** badge. The row shows the **Repository access** (**All repositories** or **Selected repositories**) and the repositories themselves. Available actions:

- **Repository access on GitHub** (shown when GitHub provides a settings address) opens the installation's settings on GitHub, where you change which repositories the app can see.
- **Sync repos** refreshes the repository list from GitHub.
- **Reconnect** appears if the installation shows an **Error** badge.
- **Disconnect** removes that installation from this workspace.
- **Add organization or account** connects another one.

Previews of pull requests and issues refresh when GitHub reports a change to them.

## Linear

Linear previews cover issues, comments, projects and documents. Select **Connect Linear** to authorize the Threa Linear app. Once connected, the tab shows the **Organization**, the **Access** ("All public teams in this workspace") and who installed it. **Reconnect** repeats the authorization and **Disconnect** removes the connection. If the tab says "Linear OAuth credentials are not configured on this deployment yet", the deployment has no Linear app set up.

## What agents can do with them

Ariadne and other agents with the GitHub and Linear tools turned on can read from connected accounts while they work. All of it is read-only.

- GitHub: list repositories and branches, read commits, pull requests, issues, releases and GitHub Actions runs, and read or search file contents.
- Linear: list and read issues and projects.

Which tools an agent has is part of the agent's setup. See [Custom personas](/guide/custom-personas) and [What agents can do](/guide/what-agents-can-do).
