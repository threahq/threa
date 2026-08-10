# auth.md

How an agent authenticates against the Threa API.

Threa runs no OAuth authorization server and has no dynamic client
registration, so there is nothing at `/.well-known/oauth-authorization-server`
or `/.well-known/oauth-protected-resource` to follow. This file is the
authoritative description instead. Credentials are bearer API keys, minted by a
workspace member in the app and handed to the agent out of band.

## Audience

Agents acting inside one Threa workspace: a local coding agent, a CI job, a
notifier, or a persistent bot. Human sign-in is a separate, browser-only flow
and is not available to agents.

## Getting a credential

There is no registration endpoint. A workspace member creates the key in the
app and copies it once; Threa cannot show it again.

- **Personal access key** (`threa_uk_…`) — created under Settings → API keys.
  Carries the creator's identity and access, and can never do more than they
  can. Messages it sends are attributed to them, flagged as sent via the API.
- **Bot key** (`threa_bk_…`) — created from a bot's own settings, after making
  the bot. Acts as its own participant in the workspace, and must be added to
  the streams it should see. A personal bot belongs to one member; a shared bot
  belongs to the workspace and is created by an admin.

Each key carries a set of scopes chosen at creation and editable afterwards
(`messages:read`, `messages:write`, `memos:read`, `delegations:write`, and so
on). Workspace-admin powers are not grantable to a key. The full scope table is
at <https://threa.io/developers/authentication.md>.

## Using the credential

Send the key as a bearer token on every request:

```http
GET /api/v1/workspaces/{workspaceId}/me HTTP/1.1
Host: app.threa.io
Authorization: Bearer threa_uk_…
```

The key is bound to one workspace, so `{workspaceId}` in the path must match
it. `GET /me` requires no scope and returns the principal behind the key
(`user` or `bot`) — the cheapest way to confirm a key is live and pointed at
the right workspace. A request with no key returns `401`; a key missing the
endpoint's scope returns `403`.

The API is versioned by date. Each key is pinned to a version when minted, so
requests need no version header; `Threa-Version: <date>` overrides the pin for
one request.

## Revoking

The member who owns the key revokes it under the same settings screen. Only a
hash of the key is stored, and revocation takes effect immediately.

## Machine-readable

- <https://threa.io/.well-known/api-catalog> — RFC 9727 catalog
- <https://threa.io/openapi.json> — OpenAPI 3.0 contract
- <https://threa.io/llms.txt> — markdown index of the developer docs
- <https://threa.io/.well-known/agent-skills/index.json> — agent skills index
