# Voice Memos & Dictation — Implementation Plan

**Status:** Draft, ready for review
**Branch:** `claude/voice-memos-dictation-N3KE0`
**Author:** Claude (planning)
**Decisions owner:** Kristoffer

## TL;DR

Add a microphone affordance to the composer that streams dictated speech into the editor as if the user is typing. Scope of v1 is **transcription only** — recording, upload, transcription via OpenRouter (`openai/whisper-large-v3-turbo` by default), and live insertion at the caret. The "tidy-up" pass with `gpt-5.4-nano`/`gpt-5.4-mini` is designed-but-deferred, behind a feature flag and a clear hand-off point.

Three things you'll want to weigh in on before we build (see [Open Decisions](#open-decisions)):

1. **Audio chunking strategy** — true streaming via PCM/AudioWorklet vs single-take vs stop-and-restart. Tradeoffs in latency, complexity, and audio quality.
2. **Persistence** — whether we keep the audio at all, even ephemerally for debugging.
3. **Transport** — Socket.io vs SSE for streaming partial transcripts back to the client.

Sections that follow lay out the UX, data flow, models, file structure, milestones, risks, and rollout.

---

## 1. UX & Visual Design

### 1.1 Aesthetic direction

The mic affordance lives in a composer that already has a lot going on (formatting, emoji, mention, slash, attach, send). It needs to feel **like a separate mode**, not just another toolbar dot. The aesthetic direction I'm proposing — for review:

- **Recording state should feel physical.** Not a pulsing red circle. A live waveform rendered from the actual mic input (RMS-driven amplitude bars). When you're not recording, the button is restrained; when recording, the surrounding region becomes alive.
- **Type-in animation = "tape leader".** As transcribed text arrives, it appears with a 1-frame ghost of the next characters being typed (cursor leads the text by ~50ms, then the text catches up). Subtle, but it makes the dictation feel mechanically real, not magical.
- **Color**: bone-white background with a single warm accent (terracotta `#c1502c` or our existing destructive red if it reads well — the design system already has `--destructive`). No purple gradients.
- **Typography**: keep the editor's existing body font. The mic state label ("Listening…", "Transcribing…") uses the existing UI font in `text-xs` with `letter-spacing: 0.04em` for a slightly mechanical feel.

### 1.2 Button placement

#### Desktop

The composer (`apps/frontend/src/components/composer/message-composer.tsx:842-962`) has an inline toolbar with Aa, 😊, @, /, 📎. Add **Mic** as the rightmost tool _before_ the send group (so visual order is: format · emoji · @ · / · 📎 · | · mic · send).

Visibility rule: **always visible on desktop when the editor is empty; hidden once the user begins typing.** This matches the user's "hidden once I start typing manually" requirement. While dictating, the mic button stays visible and toggles into an active recording state regardless of editor content.

#### Mobile

The mobile composer (lines 282-289, 728-792) collapses to a one-line preview until focus, then exposes the action bar. For voice we want a **floating action button (FAB) that lives outside the composer**, above the send button. Specifics:

- On editor focus with empty content → FAB fades in, anchored above the send button with `bottom: calc(send-button-bottom + 56px)`, larger touch target than the inline toolbar (44×44).
- The FAB sits **outside** `[data-editor-zone]` so it doesn't get scissored by the editor expand toggle.
- On first character typed → FAB fades out. On clearing back to empty → FAB returns.
- Recording state expands the FAB into a pill containing the waveform + a stop affordance, while the composer below shows incoming text in real time.

A wireframe in words:

```
+------------------------------+
|                              |
|   [streaming transcript]     | ← composer (the editor)
|                              |
+------------------------------+
                      ( mic )    ← FAB, hovering above send
+------------------------------+
| Aa  😊  @  /  📎      [ ↑ ] | ← action bar
+------------------------------+
```

### 1.3 Recording lifecycle (visible to user)

| State            | Trigger                                                    | UI                                                                                              |
| ---------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **idle**         | default                                                    | mic icon, neutral                                                                               |
| **requesting**   | tap mic, awaiting `getUserMedia` permission                | mic icon, faint spin halo                                                                       |
| **listening**    | permission granted, recording active                       | active state with waveform; small "Listening…" label                                            |
| **transcribing** | chunks in flight, text arriving                            | waveform continues; subtle "·" indicator next to caret as text streams in                       |
| **finalizing**   | user stopped recording, last chunk still being transcribed | waveform freezes; pulse indicator until last chunk lands                                        |
| **error**        | mic blocked / network / model error                        | inline toast + button reverts to idle; if mid-recording, captured text is preserved in composer |

Stop affordances: tap mic again (toggle), or tap outside the composer area (mobile). The send button is **never** the stop button — too easy to send a half-finished message.

### 1.4 Interaction with existing composer content

The user explicitly wants dictation to coexist with already-typed text. Rules:

- New transcribed text is inserted **at the current caret position**, not appended.
- If the user keeps typing _during_ dictation, their typing wins for that range; further transcription is inserted at the new caret position.
- If the user moves the caret mid-dictation, subsequent text lands at the new caret position. No re-inserts.
- We do **not** apply autocomplete (mentions, slash commands) inside transcribed text — they're inserted as plain text so a transcribed "@kris" doesn't trigger the mention popover. Manual typing of `@` still works normally.

### 1.5 Settings UI

A new section under **Settings → Voice & dictation**:

- **Transcription model** — radio buttons: Whisper Large v3 Turbo (default), Whisper Large v3, GPT-4o Transcribe, GPT-4o Mini Transcribe. (Models added to `models.yaml` and to a new "Speech-to-text" section in `docs/model-reference.md`.)
- **Language hint** — `Auto-detect (default)` or pick a locale. Whisper performs better with a hint.
- **Vocabulary** — multi-line text field, free-form: "Names, terms, or phrases I use often." Stored as `userPreferences.voice.vocabularyHints` (array of strings). Used by both the language hint to the STT call and (later) the tidy-up pass.
- **Tidy-up pass** — toggle (default off in v1 since it's deferred). Tooltip: "Use a small model to clean disfluencies and corrections from your speech."
- **Tidy-up model** — radio buttons: GPT-5.4 Nano (default), GPT-5.4 Mini. Only relevant when tidy-up is on.

---

## 2. End-to-end data flow

This is the meat of the question you flagged: **how audio gets from the mic to OpenRouter and how text gets from OpenRouter back into the composer.**

### 2.1 Topology

```
 Browser                           Backend                         OpenRouter
 ┌─────────────────────┐          ┌──────────────────────┐        ┌─────────────────┐
 │ MediaRecorder /     │  audio   │  POST /workspaces/:w │  audio │ POST /api/v1/   │
 │ AudioWorklet (PCM)  │ ───────► │  /voice/sessions/    │ ─────► │ audio/          │
 │                     │ (multi-  │  :sid/chunks         │ (base64│ transcriptions  │
 │ Recorder loop:      │  part /  │                      │ JSON)  │                 │
 │ - capture window    │  binary  │  → transcribe service│        │ ◄── { text }    │
 │ - upload chunk N    │  WS)     │  → outbox event      │        │                 │
 │ - receive text      │ ◄─────── │  → broadcast handler │        └─────────────────┘
 │ - insert at caret   │  socket  │                      │
 └─────────────────────┘  event   └──────────────────────┘
```

### 2.2 Why this shape

- **HTTP for audio upload, Socket.io for results.** Audio chunks are large and binary; results are small and text. Two transports keeps each one optimized. Audio upload uses the existing multer-s3 + workspace-router auth chain (`apps/backend/src/middleware/upload.ts`). Result delivery rides the outbox + broadcast handler pattern (INV-4) that the rest of the app already uses (`apps/backend/src/lib/outbox/broadcast-handler.ts`).
- **The user's socket.io room receives the events.** Specifically a user-scoped room: `ws:{workspaceId}:user:{userId}`, since dictation results are private and not stream-scoped (a user might be dictating into a thread, a scratchpad, or composing a DM — the destination doesn't matter to the transcription layer).
- **A `voiceSessionId` ties chunks together.** Each press of the mic button creates a session; chunks reference it. The frontend filters incoming events by `voiceSessionId` to ignore stale results from a previous session.

### 2.3 OpenRouter audio API — what we know and what we don't

From the OpenRouter docs ([announcement](https://openrouter.ai/announcements/announcing-audio-apis), [audio guide](https://openrouter.ai/docs/guides/overview/multimodal/audio)):

- Endpoint: `POST https://openrouter.ai/api/v1/audio/transcriptions`.
- **Body shape**: JSON with **base64-encoded audio**. Documented fields include `model`, the audio payload, and an optional `language` hint. The announcement does **not** confirm `stream: true` for the transcription endpoint (only for the speech/output endpoint). Treat OpenRouter transcription as **one-shot per call** for v1.
- Supported formats: mp3, mp4, wav, webm, flac, ogg. We'll send `webm/opus` from MediaRecorder, or `wav` PCM if we go the AudioWorklet route.
- File size limit is documented as 25 MB for Whisper-1 on OpenRouter; the turbo variant isn't explicitly bounded but we should assume 25 MB / ~25 min per request and keep individual chunks well under that.

**Streaming implication:** since OpenRouter's transcription endpoint is one-shot, "true" partial-transcript streaming requires us to do the chunking on _our_ side. Each client-side chunk → one OpenRouter request → one socket.io event back to the client.

If `stream: true` becomes supported on OpenRouter (or if we point at OpenAI direct for `gpt-4o-mini-transcribe`, which _does_ support `stream: true` via the OpenAI SDK), the same architecture absorbs that: the backend just receives partial-transcript SSE events from upstream and emits them as separate `voice:transcription:partial` events. The contract toward the frontend doesn't change.

### 2.4 Client → backend — chunking strategy

Three approaches, ordered by my recommendation:

#### Approach A (recommended): **AudioWorklet + PCM windows**

- Use Web Audio API with an `AudioWorkletNode` to read raw `Float32Array` samples off the mic.
- Buffer samples in a ring; emit a **window** every ~2.5 s (or earlier on a detected silence ≥ 300 ms).
- Encode each window as a self-contained WAV blob (just a header + the int16 PCM) and POST it.
- **Pros**: Each chunk is independently decodable. No gaps between chunks. Cross-platform (works on iOS Safari, Android Chrome, desktop). Lets us implement simple VAD-driven chunking (cut at silences, not arbitrary 2.5-second walls). Cheap to encode.
- **Cons**: Slightly more code than MediaRecorder. WAV is ~10× larger on the wire than opus (16-bit 16 kHz mono = 32 KB/sec, so a 2.5 s chunk is ~80 KB).

#### Approach B: **MediaRecorder with stop-and-restart**

- `recorder.start()`, after 2.5 s `recorder.stop()`, on `dataavailable` upload the blob, then `recorder.start()` again. Each blob is a complete webm/opus file, independently decodable.
- **Pros**: Less code. Smaller payloads (~10 KB/2.5 s).
- **Cons**: 30–80 ms audio gap per chunk boundary (browser-dependent). Words can get clipped. Workable but not invisible.

#### Approach C: **Single take, no chunking**

- Record the whole thing as one blob; upload on stop. Text returns in one big chunk.
- **Pros**: Simplest. Smallest code surface.
- **Cons**: Doesn't match the "stream into the composer" UX the user asked for. For a 30 s dictation the user sits with nothing for ~3 s after release.

**Recommendation:** ship Approach A, with a server-side feature flag that can fall back to Approach C if there are issues. Approach B is a middle option if we want to defer the AudioWorklet complexity.

### 2.5 Backend → OpenRouter

The existing `createAI` wrapper (`apps/backend/src/lib/ai/ai.ts`) is built for chat completions and embeddings via `@openrouter/ai-sdk-provider`. It does **not** have an audio path. Two options:

1. **Bypass the wrapper for transcription.** Add a thin `TranscriptionClient` that calls OpenRouter's audio endpoint directly via `fetch`, reusing the existing `OPENROUTER_API_KEY` from `env.ts:152` and the `OPENROUTER_BASE_URL` constant from `ai.ts:30`. Hand-roll cost recording via the existing `CostRecorder.recordUsage()` path (`features/ai-usage/cost-service.ts`).
2. **Extend `createAI`.** Add a `generateTranscription(options)` method that internally still hits the audio endpoint by hand (since the AI SDK doesn't have a transcription primitive for this provider) but plugs into the same telemetry, retry, and cost recording machinery.

**Recommendation:** option 2. Keep all AI traffic through `createAI` so INV-19 (telemetry) and INV-28 (no raw SDK imports) are honored, even though under the hood it's a direct fetch. This also gives us one place to add `stream: true` support if/when OpenRouter ships it.

`models.yaml` gains a new section:

```yaml
# Speech-to-text models
openrouter:openai/whisper-large-v3-turbo:
  name: Whisper Large v3 Turbo
  inputModalities: [audio]
  outputModalities: [text]

openrouter:openai/whisper-large-v3:
  name: Whisper Large v3
  inputModalities: [audio]
  outputModalities: [text]

openrouter:openai/gpt-4o-transcribe:
  name: GPT-4o Transcribe
  inputModalities: [audio]
  outputModalities: [text]

openrouter:openai/gpt-4o-mini-transcribe:
  name: GPT-4o Mini Transcribe
  inputModalities: [audio]
  outputModalities: [text]
```

A new `audio` modality value is introduced — `ModelRegistry` gets a `supportsAudioInput()` method for parity with `supportsVision()`. Update `docs/model-reference.md` with a "Speech-to-text" section listing the four models with cost per minute (Whisper turbo ~$0.04/hr per OpenRouter pricing) and "When to use" guidance.

### 2.6 Backend → client (live transcript)

For each chunk the worker completes:

1. Insert outbox event `voice:transcript:chunk` with payload `{ voiceSessionId, chunkIndex, text, isFinal }`.
2. `BroadcastHandler` routes events with `scope: "user"` to `ws:{workspaceId}:user:{userId}` (already supported, see `broadcast-handler.ts:1-60`).
3. Frontend listens for `voice:transcript:chunk` only while a voice session is active locally, filters by `voiceSessionId`, and inserts text at the caret using `editor.chain().focus().insertContent(text).run()` (`apps/frontend/src/components/editor/rich-editor.tsx:777`).

**Why outbox vs direct socket.emit:** the broadcast handler already debounces, deduplicates, and survives backend restarts. Reusing it costs nothing and keeps INV-4 honored. The slight downside is ~10–50 ms of additional latency from the outbox dispatcher cycle — acceptable since end-to-end is dominated by upstream STT.

**Alternative considered:** SSE / chunked HTTP from the upload endpoint itself (keep the HTTP request open, stream `text/event-stream` back). Rejected because (a) the codebase has no SSE precedent and (b) splitting upload from result lets us hold the recording open across multiple chunk uploads without one giant request.

### 2.7 Streaming text into the composer (UX layer)

When a chunk arrives, we don't dump all the text at once — we want the "typing" feel.

- Maintain a small client-side **type buffer** per voice session. Each socket event appends to it.
- A `requestAnimationFrame` loop drains the buffer at ~25–40 characters per second, inserting characters at the editor caret.
- If the user moves the caret or starts typing manually, the buffer drains at the new position.
- When the session ends (`isFinal: true` on the last chunk and buffer empty), the buffer is cleared and the composer returns to idle.

This gives a believable typing animation even though the underlying transcript arrives in 2.5-second chunks of dozens of characters at a time.

---

## 3. Backend feature

New colocated feature: `apps/backend/src/features/voice-transcription/` (INV-51).

```
voice-transcription/
├── index.ts                    # barrel exports
├── config.ts                   # default models, chunk size limits, language defaults
├── handlers.ts                 # POST /sessions, POST /sessions/:id/chunks, POST /sessions/:id/finish
├── service.ts                  # session lifecycle, dispatch transcription
├── repository.ts               # voice_sessions table access
├── transcription-client.ts     # talks to OpenRouter audio endpoint (or via createAI extension)
├── worker.ts                   # JobQueues.VOICE_TRANSCRIBE worker
├── chunk-outbox-handler.ts     # turns transcription completions into broadcast events
├── service.test.ts
├── transcription-client.test.ts
└── handlers.test.ts
```

### 3.1 Routes

Wired into `apps/backend/src/routes.ts` via `createVoiceTranscriptionHandlers({...})`:

- `POST /api/workspaces/:wid/voice/sessions` — create a session. Body: `{ model?: string, language?: string }`. Response: `{ voiceSessionId, expiresAt }`. Defaults pulled from user preferences if set, else `config.ts` defaults.
- `POST /api/workspaces/:wid/voice/sessions/:sid/chunks` — upload one chunk (multipart, single field `audio`). Optional fields: `chunkIndex`, `isFinal`. Returns 202 immediately; transcription is async.
- `POST /api/workspaces/:wid/voice/sessions/:sid/finish` — mark the session done. Backend stops accepting chunks. Useful for cleanup; not strictly required if `isFinal` is set on the last chunk.
- `DELETE /api/workspaces/:wid/voice/sessions/:sid` — abort. Drops any pending work.

### 3.2 Data model

One new table, kept light. **No persistence of audio bytes by default** (see [Open Decisions §2](#open-decisions)).

#### `voice_sessions`

| Column         | Type                       | Notes                                           |
| -------------- | -------------------------- | ----------------------------------------------- |
| id             | TEXT PK                    | ULID prefixed `voicesess_`                      |
| workspace_id   | TEXT NOT NULL              | INV-8                                           |
| user_id        | TEXT NOT NULL              | Owner                                           |
| model          | TEXT NOT NULL              | e.g. `openrouter:openai/whisper-large-v3-turbo` |
| language       | TEXT                       | nullable; null = auto                           |
| status         | TEXT NOT NULL              | `active` / `finished` / `aborted` / `expired`   |
| chunk_count    | INTEGER NOT NULL DEFAULT 0 |                                                 |
| total_audio_ms | INTEGER NOT NULL DEFAULT 0 | for cost telemetry                              |
| created_at     | TIMESTAMPTZ NOT NULL       | DEFAULT NOW()                                   |
| finished_at    | TIMESTAMPTZ                |                                                 |
| expires_at     | TIMESTAMPTZ NOT NULL       | created_at + 10 min — sessions auto-expire      |

Index on `(workspace_id, user_id, status)` to find a user's active session quickly. No table for individual chunks unless we decide to persist audio (see Open Decisions).

The handler validates input with Zod (INV-55) and throws `HttpError` for failures (INV-32). Migration follows append-only convention (INV-17); add via `/add-migration`.

### 3.3 Job queue

Add `VOICE_TRANSCRIBE: "voice.transcribe"` to `JobQueues` in `apps/backend/src/lib/queue/job-queue.ts`. Worker payload:

```ts
{
  workspaceId: string
  userId: string
  voiceSessionId: string
  chunkIndex: number
  audioBytes: Buffer // small; never persisted to disk
  audioFormat: "wav" | "webm" | "ogg"
  durationMs: number
  isFinal: boolean
}
```

**Concurrency tier:** `interactive`. Voice chunks are user-blocking — they should not queue behind PDF/image work. Suggested token budget: `min(maxConcurrentVoice, 8)` per backend node, plenty for the small number of dictating users we'll have at launch.

**Why a worker rather than synchronous in-handler:** lets us bound concurrent OpenRouter calls per node, and survives transient OpenRouter slowness without holding the HTTP upload connection open. The chunk upload returns 202 within ~50 ms of disk write; the worker does the slow call asynchronously.

### 3.4 Outbox events emitted

- `voice:transcript:chunk` — `{ voiceSessionId, chunkIndex, text, isFinal }`. Scope: `user`. Routes to `ws:{workspaceId}:user:{userId}`.
- `voice:transcription:error` — `{ voiceSessionId, chunkIndex, code, message }`. Scope: `user`.
- `voice:session:expired` — emitted by a sweeper when an active session passes its `expires_at`.

### 3.5 Cost tracking

The transcription client wraps every OpenRouter call in `recordUsage()` with telemetry metadata `{ functionId: "voice_transcription", voiceSessionId, chunkIndex, durationMs }` (INV-19). OpenRouter returns cost in `usage.cost` on the response, same as chat completions — we record it the same way.

For Whisper, OpenRouter bills per audio second/minute rather than per token. The `CostRecorder` interface may need a minor extension to record `{ unit: "audio_seconds", quantity: durationSeconds }` alongside token-based usage. Look at how it currently handles non-token cost from `usage.cost`; if the field already carries dollar-cost directly, we may not need a schema change at all.

---

## 4. Frontend implementation

### 4.1 Files added / changed

```
apps/frontend/src/
├── components/composer/
│   ├── message-composer.tsx           # extend: mic button slot + recording mode UI
│   └── voice/
│       ├── voice-recorder.ts          # AudioWorklet-based capture (Approach A)
│       ├── voice-recorder-worklet.ts  # registered with audio context
│       ├── voice-session-store.ts     # Zustand: { sessionId, status, buffer }
│       ├── voice-mic-button.tsx       # the button + recording-state UI
│       ├── voice-waveform.tsx         # canvas-based waveform
│       └── insert-stream.ts           # the type-buffer drainer
├── lib/api/voice.ts                   # createSession / uploadChunk / finishSession / abort
└── pages/settings/voice-settings.tsx  # new settings panel
```

### 4.2 Recorder API

```ts
// voice-recorder.ts
const recorder = createVoiceRecorder({
  windowMs: 2500,
  silenceCutoffMs: 300,
  onChunk: (wavBlob, meta) => uploadChunk(sessionId, wavBlob, meta),
  onStop: () => finishSession(sessionId),
  onError: (e) => store.setStatus("error", e.message),
})
await recorder.start() // requests getUserMedia
// ...
recorder.stop()
```

### 4.3 Socket subscription

Hook `useVoiceTranscriptionStream(voiceSessionId)`:

- Subscribes to `voice:transcript:chunk` on the user room.
- Filters by `voiceSessionId`.
- Pushes incoming text into the local type buffer.
- Pairs subscription with a bootstrap fetch of any chunks already completed for this session (INV-53), so reconnects don't drop text.

### 4.4 Editor integration

`MessageComposer` exposes a method on its imperative ref:

```ts
type MessageComposerHandle = {
  // existing...
  insertTranscribedText(text: string): void // inserts at caret, plain text
}
```

The voice store's drainer calls this on every animation frame. The caret position is taken from the live editor, so user-initiated cursor moves naturally redirect the stream.

### 4.5 Mic button visibility logic

`apps/frontend/src/components/composer/message-composer.tsx`:

- Desktop inline toolbar: `<MicButton hidden={editorIsNotEmpty && !isRecording} />`.
- Mobile FAB: rendered in a portal sibling to the composer, with `visible = isFocused && (editorIsEmpty || isRecording)`.

The "is editor empty" check uses TipTap's `editor.isEmpty` (cheap, reactive). We add a small `useIsEditorEmpty(editor)` hook so both layouts share the logic without prop drilling.

### 4.6 Permission UX

First time the user taps mic, the browser shows the permission prompt. If denied, we show a single-line inline message with a "?" tooltip linking to a help article about enabling mic permissions in Chrome/Safari/Firefox. If permanently blocked, the mic button is dimmed and tapping it surfaces the help text rather than re-prompting (browsers suppress the prompt anyway).

---

## 5. Tidy-up pass (deferred)

Designed here so the v1 wiring leaves a clean hand-off. **Not implemented in v1.**

### 5.1 Where it slots in

A second outbox event `voice:transcript:tidied` carrying `{ voiceSessionId, chunkIndex, originalText, tidiedText, span }`. The frontend, when tidy-up is enabled, swaps `originalText` for `tidiedText` in the composer (using TipTap range replace) and animates the change.

### 5.2 The tidy-up call

A separate worker (`JobQueues.VOICE_TIDY`) consumes chunk completions, calls `gpt-5.4-nano` (or `gpt-5.4-mini` per user preference) with a prompt that includes:

- The newly-transcribed chunk.
- The last ~200 characters of preceding committed text in the same session (for continuity).
- The user's vocabulary hints (from settings).
- Instruction: "Rewrite the user's dictation by removing filler words and resolving in-line corrections (e.g., 'no wait, I meant X'). Preserve meaning and tone. Output only the cleaned text."

Lives in `voice-transcription/tidy/` to colocate (INV-51). Eval harness in `voice-transcription/tidy/evals/` uses the production entry point (INV-45). Config in `voice-transcription/tidy/config.ts` (INV-44).

### 5.3 Order-of-operations question

Chunk-by-chunk tidy-up risks over-rewriting (the model can't see "no wait" if it lands in the next chunk). Two designs to choose from when we get there:

- **Per-chunk** with a "tail re-rewrite" pass when a new chunk lands (re-tidy the last 2 chunks together).
- **End-of-session** only — tidy fires once when the user stops dictating, and the composer's text is replaced wholesale.

I lean toward end-of-session: simpler, cheaper, and the user gets the unfiltered transcript live with a "polish" pass as they finish. But the per-chunk approach matches the "streaming feel" better. Decide when we get there.

---

## 6. Persistence

The user's instinct ("we don't have to persist the audio stream") matches mine. Recommended posture:

- **Audio bytes: never persisted by default.** The worker holds the buffer in memory, sends to OpenRouter, discards on completion. No S3 write, no temp file. Logs only durations + transcribed text, not audio.
- **Transcribed text: persisted only as the composer draft.** The drafts system (`apps/frontend/src/components/timeline/message-input.tsx`) already saves composer state to IDB; dictated text rides that machinery. No separate "voice transcript" table.
- **Voice session metadata: kept in `voice_sessions` for 7 days.** Useful for cost telemetry and debugging without retaining sensitive content.

If we want optional retention later (e.g., "save voice memos as message attachments"), we already have the attachments feature with a workspace-scoped S3 path — we'd persist the recombined audio there. That's a feature we can add without altering the v1 model.

---

## 7. Security & privacy

- **getUserMedia permission scope.** Browsers persist mic permission per-origin; we don't escalate or store anything beyond that.
- **Audio in transit.** TLS to backend, TLS to OpenRouter. No third-party processors in between.
- **Workspace isolation.** Voice sessions are workspace-scoped (INV-8). A session created in workspace A can't be uploaded to from a request scoped to workspace B; standard workspace middleware enforces this.
- **Rate limiting.** Reuse the existing rate-limit middleware. Per-user limits on `POST chunks`: max 30 chunks / minute (one chunk every ~2 s × 60 s).
- **Abuse considerations.** The cost-per-minute of Whisper turbo is low (~$0.04/hr), but a malicious caller streaming silence for an hour is still a real bill. The `voice_sessions.expires_at` (10-min hard cap) limits damage per session; per-user daily caps live in the AI cost service and apply automatically.

---

## 8. Testing

- **Unit:** `voice-recorder.ts` (window emission timing), `insert-stream.ts` (caret-respecting buffer drain), `service.ts` (session lifecycle), `transcription-client.ts` (request shape, error mapping).
- **Integration:** real component mount of `MessageComposer` with a mocked `voice-session-store` simulating chunks arriving (INV-39).
- **E2E (Playwright):** stub `getUserMedia` and OpenRouter responses; verify (a) mic button appears/disappears with editor empty state, (b) tapping mic creates a session, (c) incoming socket events insert text at the caret, (d) typing during dictation interleaves correctly.
- **Eval (when tidy-up lands):** small corpus of transcripts with known disfluencies and corrections, scored against hand-written gold versions.

---

## 9. Milestones

| #   | Outcome                                                                                                                  | Estimate |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------- |
| 1   | Backend feature skeleton: session table, handlers, repo, service. No transcription yet — handler echoes the chunk count. | 0.5 d    |
| 2   | `TranscriptionClient` against OpenRouter; cost recording wired; backend worker calling it; manual curl test.             | 1 d      |
| 3   | Frontend recorder (Approach A): AudioWorklet, WAV encoding, upload loop. Headless test against staging backend.          | 1 d      |
| 4   | Socket.io broadcast plumbing + frontend insert-stream into the editor. Round-trip working end-to-end.                    | 0.5 d    |
| 5   | UX polish: desktop button placement, mobile FAB, recording states, waveform.                                             | 1 d      |
| 6   | Settings UI (model, language, vocabulary hints). User preferences plumbed.                                               | 0.5 d    |
| 7   | E2E + integration tests; cost telemetry verification.                                                                    | 0.5 d    |

Total: ~5 days for v1 (transcription only). Tidy-up pass is a separate ~2-day follow-up.

---

## 10. Risks & how we mitigate

| Risk                                                                                     | Mitigation                                                                                                                 |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| OpenRouter audio endpoint changes its base64-only stance and starts requiring multipart. | `TranscriptionClient` is the only place that knows the wire format. Swap behind one method.                                |
| Stop-and-restart chunking drops audio at boundaries (Approach B).                        | Start with Approach A (AudioWorklet) which has no boundaries.                                                              |
| Mobile Safari quirks with AudioWorklet on older iOS.                                     | Capability-detect at session start; fall back to MediaRecorder webm/opus (Approach B) for unsupported clients.             |
| Long dictations exceed the per-chunk size limit.                                         | Fixed-size windows already keep chunks small (~80 KB).                                                                     |
| OpenRouter latency spikes block the worker queue and stall the user.                     | `tier: interactive`, plus a per-call timeout (8 s) that surfaces an error event the frontend can show inline.              |
| Socket reconnects drop transcript events mid-session.                                    | INV-53: subscription pairs with a bootstrap fetch that returns any already-finished chunks since `lastChunkIndex`.         |
| Background tabs throttle the recorder and audio capture goes silent.                     | Listen for `visibilitychange`; pause + show a "Tab paused" banner; do not silently drop audio.                             |
| Cost runaway from accidental hot mics.                                                   | 10-min hard session expiry. Per-user daily cost cap via existing AI cost service. UI warning if user crosses a soft limit. |

---

## 11. Open Decisions

I need an answer (or "your call, pick the recommended one") on these before building. Order matches the order I'd want to confirm them.

1. **Chunking strategy.** Recommended: Approach A (AudioWorklet + PCM windows). Alternatives: B (MediaRecorder stop-and-restart, simpler), C (single take, no streaming UX).
2. **Audio persistence.** Recommended: never persist. Alternative: short-lived S3 with 7-day TTL for debug-only access by admins, behind a feature flag.
3. **Transport for live transcripts.** Recommended: Socket.io via existing outbox/broadcast. Alternative: SSE on the same HTTP connection that ships chunks (requires new infra; not recommended).
4. **Tidy-up timing model.** Recommended: end-of-session full rewrite. Alternative: per-chunk with re-rewrite of last two chunks. (Decide later; doesn't block v1.)
5. **Default model.** Confirmed: `openrouter:openai/whisper-large-v3-turbo`. Worth a side-eye on whether to default new users to `openai/gpt-4o-mini-transcribe` instead, which has stronger handling of disfluencies but is ~3× the cost.
6. **Vocabulary hints in v1.** The settings UI is cheap to build but the hints only matter when (a) we pass them as Whisper's `prompt` field, and (b) the tidy-up pass uses them. Worth shipping in v1 just for (a) — Whisper does respect `prompt` for biasing.
7. **Cost cap UI.** Where (if anywhere) do we surface "you've spent $X on voice this month"? Probably the same settings page. Out of scope for v1 unless you'd like it.

---

## 12. References

- `apps/frontend/src/components/composer/message-composer.tsx:218-990` — composer
- `apps/frontend/src/components/editor/rich-editor.tsx:33-41, 777` — editor handle, programmatic insert
- `apps/frontend/src/components/timeline/message-input.tsx:189-468` — host of the composer
- `apps/backend/src/lib/ai/ai.ts:392-949` — `createAI` wrapper, where audio support hooks in
- `apps/backend/src/lib/ai/models.yaml` — model capability registry
- `apps/backend/src/features/attachments/` — precedent for file upload (multer-s3) and outbox-driven worker dispatch
- `apps/backend/src/lib/outbox/broadcast-handler.ts:1-60` — user-scoped socket.io routing
- `apps/backend/src/lib/queue/job-queue.ts` — job queue tiers
- `apps/backend/src/features/user-preferences/service.ts:115-184` — preference store + outbox propagation
- `docs/model-reference.md` — where the new STT entries go
- OpenRouter: [Audio APIs announcement](https://openrouter.ai/announcements/announcing-audio-apis) · [Whisper Large v3 Turbo](https://openrouter.ai/openai/whisper-large-v3-turbo) · [Audio guide](https://openrouter.ai/docs/guides/overview/multimodal/audio)
- OpenAI: [Speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text) (relevant if we add direct `gpt-4o-mini-transcribe` streaming later)
