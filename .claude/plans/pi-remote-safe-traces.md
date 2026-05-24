# Pi Remote Secret-Safe Traces

## Goal

Prevent Pi remote trace/status telemetry from leaking credentials or sensitive local tool data into Threa while preserving useful progress signals for bot invocations.

## What Was Built

### Pi remote trace summarization

The Pi remote extension now treats tool events as telemetry rather than logs. Tool calls are described with generated safe labels, and tool results report only output-size metadata instead of raw stdout/stderr contents.

**Files:**
- `docs/examples/pi-remote/threa-remote-v2.ts` — replaces raw tool input/output trace serialization with safe summaries; restricts status text to generated activity labels; avoids retaining raw tool arguments in `pendingToolCalls`.
- `docs/examples/pi-remote/threa-remote-v2.test.ts` — verifies bash commands, tool outputs, and edit patch bodies are omitted from trace payloads.

### Backend defense-in-depth sanitization

The public API sanitizes unstructured bot-provided trace/status data before persistence and socket broadcast. This is not the primary defense — the extension should not send raw data — but protects against custom/older bot runtimes.

**Files:**
- `apps/backend/src/features/public-api/handlers.ts` — redacts common secret shapes, clamps presence `statusText` to safe labels, and strips structured Pi tool trace `Arguments`, `Output`, and `Error output` bodies before storing steps.

## Design Decisions

### Treat traces as telemetry, not logs

**Chose:** Store what happened and approximate output size, not what the tool saw.
**Why:** A tool can read `.env`, credentials, tokens, or local files that Threa should not ingest or retain.
**Alternatives considered:** Regex-redacting raw outputs. This remains as backend defense-in-depth, but is insufficient as the primary protection because regexes miss novel secret formats.

### Allow only generated status text

**Chose:** Presence text is mapped to known safe phrases such as `Running shell command…`, `Searching files…`, and `Tool finished`.
**Why:** Presence is broadcast widely and displayed inline; it should never contain user/tool-provided strings.
**Alternatives considered:** Free-form redacted status text. This still risks leaking unusual credentials or sensitive filenames.

### Keep backend sanitization conservative

**Chose:** For structured Pi traces, backend replaces argument/output section bodies with omission messages regardless of whether the current extension already summarized them.
**Why:** Public API callers are untrusted bot runtimes. The server must not assume all clients follow the latest extension behavior.

## Schema Changes

None.

## What's NOT Included

- No opt-in raw debug trace mode.
- No retention-policy changes for trace rows.
- No frontend UI redesign; existing trace rendering continues to display structured trace sections.

## Status

- [x] Omit raw Pi tool call inputs from trace payloads.
- [x] Omit raw Pi tool outputs from trace payloads.
- [x] Restrict Pi remote status text to safe generated labels.
- [x] Add backend defense-in-depth sanitization for trace steps and presence text.
- [x] Add focused safety tests for the Pi remote example extension.
