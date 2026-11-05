---
title: GitHub and Linear
summary: How workspace admins connect GitHub and Linear, and what the connection gives link previews and agents.
section: integrations
order: 5
---

# GitHub and Linear

Connecting GitHub or Linear gives the whole workspace two things. Links to GitHub and Linear items show rich previews, and agents that have the matching tools can read from those services. Workspace admins manage the connections on the [Integrations](app:settings/integrations) settings page. Other members can open the page but not change it. Its rows say "Only workspace admins can connect GitHub." and "Only workspace admins can connect Linear."

## GitHub

GitHub previews cover pull requests, issues, commits, files and comments. To connect, select **Connect GitHub**, which sends you to GitHub to install the Threa GitHub App. If the row says "The GitHub app isn't set up on this Threa server.", the server you are on has no GitHub App set up and there is nothing to connect. Whoever runs the server can set it up.

The GitHub row's description counts the connected accounts. Each connected GitHub account or organization appears under it with a **Personal** or **Organization** badge, whether the app sees **All repositories** or **Selected repositories**, and the repositories themselves. Available actions:

- **Repository access on GitHub**, in the row's **...** menu when GitHub provides a settings address, opens the installation's settings on GitHub, where you change which repositories the app can see.
- **Sync repos** refreshes the repository list from GitHub.
- **Reconnect** appears if the installation shows an **Error** badge.
- **Disconnect**, in the same menu, removes that installation from this workspace.
- **Add organization or account** connects another one.

Previews of pull requests and issues refresh when GitHub reports a change to them.

## Linear

Linear previews cover issues, comments, projects and documents. Select **Connect Linear** to authorize the Threa Linear app. Once connected, the row reads "Connected to" the organization name, "all public teams", and who installed it. **Reconnect** repeats the authorization and **Disconnect** removes the connection. If the connection fails, the row says "The connection failed. Connect again to restore Linear previews." If the row says "Linear isn't set up on this Threa server.", the server has no Linear app set up.

## What agents can do with them

Ariadne and other agents with the GitHub and Linear tools turned on can read from connected accounts while they work. All of it is read-only.

- GitHub: list repositories and branches, read commits, pull requests, issues, releases and GitHub Actions runs, and read or search file contents.
- Linear: list and read issues and projects.

Which tools an agent has is part of the agent's setup. See [Custom personas](/guide/custom-personas) and [What agents can do](/guide/what-agents-can-do).
