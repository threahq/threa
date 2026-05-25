# Stream-scoped slash commands for Pi remote scratchpads

## Goal

Add dynamic slash commands that are available only in the streams where they make sense, starting with Pi remote scratchpads and scratchpad-rooted threads.

The first consumer is a scratchpad linked to a local Pi session. In that stream, Threa should surface Pi session-control commands such as:

- `/compact [instructions]`
- `/model <model>`
- `/thinking <off|minimal|low|medium|high|xhigh>`
- `/skill <search terms or skill name>`

The command list must be stream-aware, not just workspace-global. Threads/sub-streams rooted in the linked scratchpad should inherit the linked runtime unless they have a more specific session link.

## Current state

- Workspace bootstrap returns `commands: CommandInfo[]` from the global backend `CommandRegistry` plus frontend client-action commands.
- The frontend slash suggestion hook reads `workspaceMetadata.commands` and does ad hoc route-local filtering for `/invite` and `/discuss-with-ariadne`.
- `POST /api/workspaces/:workspaceId/commands/dispatch` parses a command and looks it up in the global `CommandRegistry`.
- Command dispatch writes `command_dispatched`, publishes `command:dispatched`, and the command outbox worker executes registered server commands.
- Pi remote runtime state already has the right stream/session primitives:
  - `stream_active_actors`
  - `bot_runtime_instances.capabilities`
  - `bot_runtime_session_links` with `root_stream_id` and `active_stream_id`
  - `bot_invocations` targeted by `target_instance_id` and `target_runtime_session_id`
- The Pi extension can use current Pi APIs for the requested actions:
  - `ctx.compact()` for compaction
  - `pi.setModel()` and `ctx.modelRegistry` for model changes
  - `pi.setThinkingLevel()` for thinking effort
  - `pi.getCommands()` to discover skill commands, while built-in interactive commands like `/model` and `/compact` are not included there.

## Design principles

1. **Backend owns command availability.** The frontend should not hardcode Pi-specific stream logic beyond rendering the commands it receives.
2. **Keep global commands global.** Existing workspace commands remain in workspace bootstrap for compatibility.
3. **Add stream-effective commands.** Stream bootstrap should include commands available in that stream, computed from the current stream/root stream, active actor, runtime link, and runtime capabilities.
4. **Dispatch validates again.** Listing commands is only UI; `dispatch` must re-resolve availability with the authenticated user and stream.
5. **Runtime control commands are bot invocations, not server command-worker jobs.** They should target the linked Pi runtime session and be claimed through the existing bot invocation protocol.
6. **Do not require a new table for v1.** Use runtime capabilities and session links first. Add a persistent dynamic-command table only if non-runtime command providers need it later.

## Proposed API/type changes

### Shared command descriptor

Extend `CommandInfo` in `packages/types/src/api.ts` with optional metadata, preserving existing fields:

```ts
interface CommandInfo {
  name: string
  description: string
  kind?: "server" | "client-action" | "bot-runtime"
  clientActionId?: string
  scope?: "workspace" | "stream"
  args?: Array<{
    name: string
    required?: boolean
    description?: string
    suggestions?: Array<{ value: string; label?: string; description?: string }>
  }>
}
```

`args` is optional. Initial UI can ignore it; later it can power argument autocomplete for `/model`, `/thinking`, and `/skill`.

### Stream bootstrap

Add `commands: CommandInfo[]` to `StreamBootstrap`. When present, this list is **authoritative** for the stream — it is the complete effective command list (workspace fallback commands plus runtime-conditional commands like `/compact`, intersected with what's actually available in this stream). The frontend uses the workspace list only as a fallback for surfaces where no stream bootstrap is loaded yet.

Frontend effective commands:

```ts
const effectiveCommands = streamBootstrap.commands ?? workspaceMetadata.commands
```

Do **not** merge the two lists: `/invite` is a workspace fallback that does not belong in scratchpads, and `/compact` is only valid in a linked Pi scratchpad — merging would leak each into the wrong surface.

### Runtime capability advertisement

Have the Pi adapter advertise command capability metadata in `bot_runtime_instances.capabilities`, for example:

```json
{
  "runtimeSessionId": "...",
  "slashCommands": [
    { "name": "compact", "description": "Compact the linked Pi session" },
    { "name": "model", "description": "Set the Pi model" },
    { "name": "thinking", "description": "Set Pi thinking effort" },
    { "name": "skill", "description": "Run a Pi skill by fuzzy search" }
  ]
}
```

The backend should sanitize this to a known allow-list for `pi-local` in v1. That prevents arbitrary runtime-provided command names from becoming executable Threa commands before we have a trust model.

## Backend plan

### 1. Command availability resolver

Add a resolver in `apps/backend/src/features/commands/` that accepts:

- `workspaceId`
- `userId`
- `streamId`
- `commandRegistry`
- `botRuntimeService` / stream repositories

It returns effective commands:

1. global server commands from `CommandRegistry`, filtered by stream availability (`/invite` belongs here instead of frontend ad hoc filtering),
2. known client-action commands if needed by workspace/bootstrap callers,
3. runtime commands when the stream is a scratchpad or scratchpad-rooted thread whose active actor is a linked Pi bot.

Runtime link resolution should match active-scratchpad invocation routing:

- prefer a link for `(rootStreamId, activeStreamId)`;
- if the current stream is a thread and has no specific link, fall back to `(rootStreamId, rootStreamId)`.

### 2. Stream bootstrap commands

Populate `StreamBootstrap.commands` from the resolver for that stream. Workspace bootstrap keeps returning workspace-global commands.

### 3. Dispatch resolver

Update command dispatch to resolve the parsed command against the same effective command set for the provided stream.

For existing server commands:

- keep the current `command_dispatched` event and `command:dispatched` outbox path.

For runtime commands:

- insert `command_dispatched` with payload metadata such as:

```ts
{
  commandId,
  name,
  args,
  status: "dispatched",
  executionKind: "bot-runtime"
}
```

- create a targeted `bot_invocation` with:
  - `requiredCapability: "session-control"` (new bot invocation capability),
  - `targetInstanceId` and `targetRuntimeSessionId` from the resolved session link,
  - `metadata: { commandId, commandName, commandArgs }`.

The command outbox worker must ignore `command_dispatched` events whose `executionKind` is not `server`/missing, so runtime commands do not fail as unknown server commands.

### 4. Completion/failure linkage

When a runtime command invocation completes/fails, use the invocation metadata to write matching `command_completed` or `command_failed` events for the original `commandId`.

This keeps author-facing command status semantics consistent with server commands.

### 5. Parser compatibility

Support command names needed for this feature:

- `/compact`
- `/model`
- `/thinking`
- `/skill`

The existing backend parser only accepts `\w+`; update it to match the frontend/prosemirror command-name rules if aliases with hyphens become necessary. Keep `/skill <query>` instead of Pi’s `/skill:name` shape so users do not need exact skill names and we avoid colon parsing in v1.

## Pi adapter plan

Extend `docs/examples/pi-remote/threa-remote-v2.ts` so claimed invocations with `metadata.commandName` are handled locally instead of being sent as normal user prompts.

### `/compact [instructions]`

- Call `ctx.compact({ customInstructions })`.
- Complete the bot invocation after `onComplete`.
- Fail the invocation from `onError`.
- Post a short final message such as `Compacted the linked Pi session.` unless we decide command events alone are enough.

### `/model <model>`

- If args are missing, return current model plus a concise candidate list.
- Resolve exact `provider/id`, exact id, then fuzzy match against `ctx.modelRegistry`.
- If one match: call `pi.setModel(model)` and complete with confirmation.
- If zero or multiple matches: complete with actionable candidates, not a silent failure.

### `/thinking <level>`

- Normalize aliases like `x-high` -> `xhigh`.
- Validate against Pi levels: `off|minimal|low|medium|high|xhigh`.
- Call `pi.setThinkingLevel(level)` and complete with confirmation.

### `/skill <query>`

- Use `pi.getCommands().filter(c => c.source === "skill")`.
- Match exact name first, then fuzzy name/description.
- If one match: inject the concrete skill command with `pi.sendUserMessage(...)` so Pi’s native skill expansion runs.
- If ambiguous: complete with the top candidate names/descriptions.
- This is intentionally a convenience command, not a new skill execution engine.

## Frontend plan

1. Store/read stream-scoped commands from stream bootstrap query data.
2. Update `useCommandSuggestion` to merge workspace commands and current stream commands.
3. Remove ad hoc `/invite` filtering once backend availability is in place.
4. Update command rendering context so dynamic command chips in the active stream render as known commands.
5. Later: add argument autocomplete using optional `CommandInfo.args`, starting with `/thinking` fixed choices and `/model` advertised choices.

## Testing plan

### Backend

- Resolver returns Pi commands only for linked scratchpad/rooted thread streams.
- Resolver does not return Pi commands for unrelated streams, unlinked scratchpads, archived streams, or streams the user cannot access.
- Thread fallback uses the root scratchpad session link when no thread-specific link exists.
- Runtime command dispatch creates a targeted `bot_invocation` with command metadata and does not enqueue a server command worker job.
- Runtime command dispatch re-checks availability and fails with a clear HTTP error if the link disappeared.
- Bot invocation complete/fail writes corresponding command lifecycle events.

### Frontend

- Slash suggestions include stream commands in linked scratchpads.
- Slash suggestions do not leak stream commands into unrelated streams.
- Switching streams updates the effective command list.
- Existing workspace/global commands still appear.

### Pi adapter

- Advertises known control commands in presence capabilities.
- Handles compact/model/thinking command invocations without sending them to the LLM.
- Handles `/skill` by resolving to a Pi skill command or returning candidates.
- Does not leak raw tool args, command output, file contents, or secrets in traces.

## Suggested implementation phases

### Phase 1 — Infrastructure and listing

- Add stream-scoped `StreamBootstrap.commands`.
- Add backend command availability resolver.
- Surface Pi runtime commands only for linked Pi scratchpads/threads.
- Merge workspace + stream commands in frontend suggestions.

### Phase 2 — Runtime command dispatch

- Add `session-control` invocation capability.
- Route `/compact`, `/model`, `/thinking`, `/skill` dispatch to targeted bot invocations.
- Prevent runtime commands from entering the server command worker path.
- Add command completion/failure linkage.

### Phase 3 — Pi adapter execution

- Advertise command capabilities from the adapter.
- Execute compact/model/thinking locally.
- Implement `/skill` fuzzy resolution and handoff to native Pi skill expansion.

### Phase 4 — Argument suggestions and polish

- Add optional argument suggestion UI for command args.
- Populate `/thinking` fixed suggestions.
- Populate `/model` suggestions from Pi-advertised model candidates when safe/compact.
- Improve `/skill` suggestions from `pi.getCommands()` skill metadata.

## Open decisions

1. Should runtime control commands post visible bot messages on success, or should command lifecycle events be the only visible confirmation?
2. Should `/thinking` have aliases like `/think`, or keep one canonical command in v1?
3. How much model metadata should Pi advertise to Threa for suggestions? A short allow-listed set is safer than dumping the full model registry into presence.
4. Should `/skill` execute the best fuzzy match automatically, or require exact match when confidence is low? Recommendation: auto-run exact/high-confidence single matches; otherwise return candidates.
