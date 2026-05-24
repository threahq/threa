# Pi Remote Session State and Runtime Readiness

## Goal

Make the Threa Pi remote adapter reliable enough for main Threa usage by removing global runtime state, adding self-configuration and diagnostics, advertising accurate busy presence, supporting steering while Pi is already working, and ensuring Pi runtime bots are eligible for invocation creation.

## What Was Built

### Pi remote adapter

`docs/examples/pi-remote/threa-remote-v2.ts` now keeps runtime state scoped to the active Pi session link instead of global config fields.

**Files:**

- `docs/examples/pi-remote/threa-remote-v2.ts` — session-scoped enablement/cursors, `/remote-control configure`, `/remote-control debug`, busy heartbeats, steering injection, legacy config migration.
- `docs/examples/pi-remote/threa-remote-v2.test.ts` — regression coverage for config migration and pasted configuration parsing, alongside existing trace-safety tests.
- `.agents/skills/update-pi-remote-plugin/SKILL.md` — repeatable maintenance workflow for keeping the plugin aligned with Pi and Threa APIs.

### Backend runtime bot readiness

`apps/backend/src/features/public-api/handlers.ts` now ensures a personal bot linked as a Pi runtime has the runtime traits required by the invocation producer.

**Files:**

- `apps/backend/src/features/public-api/handlers.ts` — `POST /bot-runtime/sessions` ensures the personal bot has the `active-scratchpad` trait before linking the session.
- `apps/backend/src/features/bot-runtimes/service.ts` — owns transactional runtime trait repair and session-link creation helpers.
- `apps/backend/src/features/public-api/bot-repository.ts` — atomically adds missing bot traits without clobbering concurrent updates.

### Bot trait controls

The workspace bot settings UI now exposes bot capability tags on create/edit so admins and bot owners can explicitly configure whether a bot is mentionable or can act as an active scratchpad runtime.

**Files:**

- `apps/frontend/src/api/bots.ts` — includes `traits` in create/update bot payload types.
- `apps/frontend/src/components/workspace-settings/bot-traits-picker.tsx` — shared capability picker.
- `apps/frontend/src/components/workspace-settings/bots-tab.tsx` — includes capabilities when creating shared or personal bots.
- `apps/frontend/src/components/workspace-settings/bot-detail.tsx` — displays and edits bot capabilities.

## Design Decisions

### Session-local runtime state

**Chose:** store `enabled` and `streamCursors` on each `linkedSessions[runtimeSessionId]` entry.
**Why:** a global on/off flag caused one Pi session to disable or enable every linked session, and global cursors could skip messages across unrelated scratchpads.
**Alternatives considered:** separate config files per session. That would avoid mixing state but make setup and migration harder.

### In-plugin configuration

**Chose:** add `/remote-control configure` with an editor-backed JSON template.
**Why:** users should not need to manually find and edit `~/.pi/agent/threa-remote.json` to paste API URL, workspace ID, or bot key.

### Busy presence and steering

**Chose:** heartbeat `busy` when Pi is already working, and claim/inject new invocations as Pi steering messages via `deliverAs: "steer"`.
**Why:** Threa should not show an available green dot while Pi cannot pick up a fresh request, and follow-up messages in the scratchpad should steer the active local run instead of waiting silently.

### Backend trait repair on session link

**Chose:** session linking ensures the personal bot has the `active-scratchpad` trait only.
**Why:** the invocation outbox handler checks `active-scratchpad` before creating scratchpad invocation rows. `mentionable` expands who can invoke a bot by `@mention`, so it remains an explicit UI capability choice.

### Explicit bot capability UI

**Chose:** expose the existing `BOT_TRAITS` vocabulary in bot create/edit flows.
**Why:** users need a supported way to repair or intentionally configure bot scheduling behavior without hand-written API calls or database edits.

## Schema Changes

None.

## What's NOT Included

- No packaged npm/git distribution for the Pi plugin; `docs/examples/pi-remote/` remains the canonical repo copy for now.
- No dedicated public debug endpoint for bot invocations.
- No production data mutation outside normal runtime session linking behavior.

## Status

- [x] Session-scoped plugin state
- [x] Self-configuration command
- [x] Debug status command
- [x] Busy presence while Pi is occupied
- [x] Steering support for messages received mid-run
- [x] Backend trait repair for linked runtime bots
- [x] Bot trait controls in settings UI
- [x] Focused plugin tests
- [x] Backend typecheck
- [x] Frontend typecheck
