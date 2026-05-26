# Pi Session-Control Presence Preservation

## Goal

Keep Pi runtime session-control slash commands (`/model`, `/thinking`, `/compact`, `/skill`, `/reload`) visible after the Pi remote begins polling for invocations. Claim polling sends a lightweight presence heartbeat; it must not erase the richer capability advertisement from the explicit `/bot-runtime/presence` heartbeat.

## What Was Built

### Preserve runtime capabilities across lightweight heartbeats

Changed the bot runtime presence upsert to support explicit merge mode for lightweight heartbeats. Claim/step heartbeats merge incoming capabilities with the existing JSONB capabilities, while full `/bot-runtime/presence` heartbeats remain authoritative replacements. This lets claim polling update `runtimeSessionId` and status without deleting fields such as `supportsSessionControlCommands`, `sessionControlCommands`, `thinkingLevels`, and `modelSuggestions`, while still allowing runtimes to remove stale capabilities.

**Files:**
- `apps/backend/src/features/bot-runtimes/repository.ts` — adds optional merge-mode capability upserts for lightweight heartbeat callers.

### Regression coverage for command availability after claim polling

Extended the stream-scoped Pi command e2e test to claim an invocation after advertising session-control support and then re-fetch stream bootstrap commands. The test asserts `/model` remains available after the lightweight claim heartbeat, and also verifies an explicit downgraded presence heartbeat can remove `/model` again.

**Files:**
- `apps/backend/tests/e2e/commands.test.ts` — adds regression coverage for claim heartbeat preserving Pi slash-command availability.

## Design Decisions

### Merge capabilities in the repository upsert

**Chose:** JSONB merge at the persistence boundary, gated by an explicit `mergeCapabilities` flag.
**Why:** All presence writers converge on `BotRuntimeInstanceRepository.upsertPresence`, including explicit presence heartbeats and claim/step lightweight heartbeats. A caller-controlled merge mode protects lightweight heartbeats without changing the authoritative replacement semantics of full presence heartbeats.
**Alternatives considered:** Always merge in the repository. That fixed claim polling but would keep stale capabilities forever when a runtime intentionally stops advertising them. Only sending full capabilities from claim polling would require runtime callers to know and resend capability state on every lightweight heartbeat, increasing API coupling.

## Schema Changes

None.

## What's NOT Included

- No bot reconfiguration or new bot traits.
- No frontend command-list changes.
- No migration/backfill; a fresh explicit Pi heartbeat (`/remote-control on`) repopulates rich capabilities after deploy.

## Status

- [x] Preserve rich Pi runtime capabilities during lightweight presence upserts.
- [x] Keep explicit presence heartbeats authoritative so stale capabilities can be removed.
- [x] Add e2e regression coverage for `/model` remaining available after claim polling and disappearing after downgraded presence.
- [x] Verify focused e2e locally against a running test backend.
