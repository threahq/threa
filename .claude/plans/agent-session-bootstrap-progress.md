# Agent Session Bootstrap Progress

## Goal

Fix timeline agent-session cards after a refresh during an active Pi/bot invocation. Running sessions already persist trace steps, but stream bootstrap only returned the original `agent_session:started` event, so the timeline could render a running card with `0 steps` until another live progress socket event arrived.

## What Was Built

### Backend bootstrap enrichment

Running `agent_session:started` events are enriched during stream bootstrap with a persisted progress snapshot: current step type, step count, and sent-message count. This makes the bootstrap response self-sufficient for mid-run refreshes while preserving existing socket progress events for live updates.

**Files:**
- `apps/backend/src/features/agents/session-repository.ts` — adds `findProgressSnapshotsByIds()` to fetch running session step/message counts in a set-based query.
- `apps/backend/src/features/messaging/event-service.ts` — enriches bootstrapped `agent_session:started` events with persisted progress snapshot fields for still-running sessions.
- `packages/types/src/agent-trace.ts` — documents optional bootstrap-only fields on `AgentSessionStartedPayload`.

### Frontend activity hydration

The timeline activity hook now seeds running-session state from optional snapshot fields on bootstrapped `agent_session:started` events, then lets live `agent_session:progress` socket updates override those values as before.

**Files:**
- `apps/frontend/src/hooks/use-agent-activity.ts` — carries bootstrapped `stepCount`, `messageCount`, and `currentStepType` into `MessageAgentActivity`.
- `apps/frontend/src/hooks/use-agent-activity.test.tsx` — covers the refresh-mid-run bootstrap path.

## Design Decisions

### Enrich the existing started event instead of adding another bootstrap endpoint

**Chose:** Add optional progress snapshot fields to `AgentSessionStartedPayload` when stream events are bootstrapped.

**Why:** The timeline already derives running sessions from stream events. Enriching that existing event keeps the subscribe-then-bootstrap model intact and avoids another client fetch per running session.

**Alternatives considered:** Fetch full trace details from the timeline or add a separate activity snapshot endpoint. Those would duplicate the trace modal path or introduce extra network round trips for every stream load.

### Keep live progress socket events authoritative after bootstrap

**Chose:** Use bootstrapped counts only as the initial state; existing `agent_session:progress` events still update counts and current step live.

**Why:** The bug is only the refresh gap. Socket events remain the correct low-latency live-update mechanism.

### Snapshot only running sessions

**Chose:** Repository snapshots filter to `agent_sessions.status = 'running'`.

**Why:** Completed/failed/deleted lifecycle stream events already carry terminal counts and should remain the source of truth for non-running cards.

## Design Evolution

- **Problem narrowed:** Initial suspicion was that trace events might not be persisted. Inspection showed the trace modal reads persisted `agent_session_steps` correctly; the missing data was only in timeline bootstrap state.

## Schema Changes

None.

## What's NOT Included

- No changes to trace modal loading; it already reads persisted steps correctly.
- No new socket event types.
- No persistence changes for `agent_session:progress`; it remains an ephemeral live event.

## Status

- [x] Backend stream bootstrap enriches running session progress snapshots.
- [x] Frontend timeline activity hook hydrates counts from bootstrap.
- [x] Focused frontend hook test covers the refresh-mid-run behavior.
- [x] Typechecks pass for affected packages/apps.
