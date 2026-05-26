# Pi Command Feedback

## Goal

Make Pi runtime slash commands feel dispatched immediately in Threa, and expose trace rows for session-control outputs so long-running commands such as `/compact` show progress instead of only a final bot reply.

## What Was Built

### Offline-first command queueing

When the composer dispatches a server/runtime slash command, it now writes an optimistic `command_dispatched` event into IndexedDB and enqueues a durable `dispatch_command` operation. The operation queue replays the dispatch when online, swaps the optimistic event for the authoritative server event, and socket delivery still dedupes by event ID. Bootstrap cleanup preserves command events while their queued operation is pending, preserves terminal failed optimistic command rows, and permanent dispatch failures create a local `command_failed` event instead of retrying forever. The stream view no longer has to wait for the realtime round trip before showing the command row, and offline commands survive retries like other queued writes.

**Files:**
- `apps/frontend/src/components/timeline/message-input.tsx`
- `apps/frontend/src/hooks/use-command-dispatch-queue.ts`
- `apps/frontend/src/db/database.ts`
- `apps/frontend/src/sync/operation-queue.ts`

### Session-control trace steps

The Pi remote extension now records trace steps for session-control commands:

- a `context_received` step when a runtime command starts
- a `tool_call` step when `/compact` starts compaction
- a `response` step containing the final command output before completing the invocation

**Files:**
- `docs/examples/pi-remote/threa-remote-v2.ts`

## Schema Changes

None.

## Status

- [x] Show dispatched slash commands immediately via an optimistic local event.
- [x] Queue command dispatches through the offline operation queue for retry.
- [x] Preserve optimistic command rows across bootstrap cleanup while queued.
- [x] Preserve terminal failed command rows across bootstrap cleanup.
- [x] Convert permanent dispatch errors into local failed command rows.
- [x] Record traces for Pi session-control command outputs.
- [x] Copy updated Pi remote extension to `~/.pi/agent/extensions/threa-remote.ts`.
- [x] Move IndexedDB command queue writes behind a hook so timeline components do not import the database directly.
- [x] Verify Pi remote focused tests.
