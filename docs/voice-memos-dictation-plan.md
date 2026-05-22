# Voice Memos & Dictation — Implementation Plan

**Status:** Draft, ready for review
**Branch:** `claude/voice-memos-dictation-N3KE0`
**Author:** Claude (planning)
**Decisions owner:** Kristoffer

> **Revision note (streaming + steering):** After review, the primary transport is a **realtime WebSocket transcription session** (true word-by-word streaming), not chunked OpenRouter Whisper. Default provider is **ElevenLabs Scribe v2 Realtime** (~150 ms latency, STT-specialized, zero-retention mode, $0.39/hr). The comparison/steering strategy is **Deepgram Nova-3** (strongest keyterm steering, EU residency region), with **OpenRouter Whisper batch** as the cheap baseline — all swappable behind one interface. OpenAI was evaluated and ruled out (its prompt steering doesn't work in realtime sessions). Section 2 was rewritten around this; §7.6 covers data residency. See [§2](#2-end-to-end-data-flow).

## TL;DR

Add a microphone affordance to the composer that streams dictated speech into the editor as if the user is typing. Scope of v1 is **transcription only** — recording, live streaming transcription, and insertion at the caret. The "tidy-up" pass with `gpt-5.4-nano`/`gpt-5.4-mini` is designed-but-deferred, behind a feature flag and a clear hand-off point.

**Default model is `elevenlabs:scribe-v2-realtime`**, not `whisper-large-v3-turbo`. Two reasons. (1) Streaming: real word-by-word transcription needs a realtime WebSocket session; Whisper turbo via OpenRouter is one-shot only. (2) Whisper turbo isn't even on OpenAI's own API — only third parties serve it, none with realtime. ElevenLabs Scribe v2 Realtime is purpose-built for streaming STT (lowest latency and cheapest of the options at $0.39/hr, strong accent handling, context-aware keyterm steering, zero-retention mode that matches our no-persistence stance). **Deepgram Nova-3** is the comparison/steering strategy: the strongest keyterm steering available (100 words / 500 tokens, multilingual) and a usable EU residency region — the escape hatch when steering or data-residency needs outgrow ElevenLabs' starting tier. Whisper turbo stays reachable as a cheap non-streaming "batch" comparison strategy. All three sit behind one `TranscriptionStrategy` interface, so swapping to compare is a settings toggle.

Things you'll want to weigh in on before we build (see [Open Decisions](#open-decisions)):

1. **Default provider** — ElevenLabs Scribe v2 Realtime (decided). Deepgram Nova-3 is the swappable comparison/steering + EU-residency strategy.
2. **Realtime connection model** — backend WebSocket relay (recommended, keeps cost tracking + API keys server-side) vs browser-direct with ephemeral tokens (lower latency, weaker observability).
3. **Persistence** — whether we keep the audio at all, even ephemerally for debugging.
4. **Strategy coverage in v1** — ship just the default realtime provider, or wire all three from day one so you can A/B them immediately.

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

- **Transcription model** — radio buttons: ElevenLabs Scribe v2 Realtime (default, streaming), Deepgram Nova-3 (streaming — heavy keyterm steering, EU region), Whisper Large v3 Turbo (batch — laggy, for comparison). Each labeled with its transport so the tradeoff is visible. (Models added to `models.yaml` and to a new "Speech-to-text" section in `docs/model-reference.md`.) Note: a workspace residency policy (§7.6) can constrain or hide options here — an EU-required workspace won't be offered a US-only model.
- **Language hint** — `Auto-detect (default)` or pick a locale. Improves accuracy and reduces language flip-flopping on the realtime path.
- **Vocabulary** — multi-line text field, free-form: "Names, terms, or phrases I use often." Stored as `userPreferences.voice.vocabularyHints` (array of strings). Passed as keyterm/biasing hints to providers that accept them (ElevenLabs ≤50 realtime terms, Deepgram ≤100 words) and (later) used by the tidy-up pass.
- **Tidy-up pass** — toggle (default off in v1 since it's deferred). Tooltip: "Use a small model to clean disfluencies and corrections from your speech."
- **Tidy-up model** — radio buttons: GPT-5.4 Nano (default), GPT-5.4 Mini. Only relevant when tidy-up is on.

---

## 2. End-to-end data flow

This is the meat of the question you flagged: **how audio gets from the mic to the model and how text comes back into the composer.** The primary path is a realtime WebSocket transcription session (default provider ElevenLabs Scribe v2 Realtime) for genuine word-by-word streaming. A secondary batch path (OpenRouter Whisper) is kept behind the same strategy interface for model comparison.

### 2.1 Why realtime, and what we give up

`whisper-large-v3-turbo` can't drive live dictation: it's one-shot only via OpenRouter, and it isn't on OpenAI's own API at all — OpenAI direct serves only `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` ([OpenAI models](https://developers.openai.com/api/docs/models/gpt-4o-transcribe)); the turbo weights are open and only third parties (OpenRouter, Groq) host them, none with realtime. True streaming — audio in, partial transcripts out continuously — needs a provider with a realtime STT WebSocket. The realistic options:

1. **ElevenLabs Scribe v2 Realtime** (recommended default) — WebSocket STT, ~150 ms last-chunk-to-text latency, 90 languages, strong accents, **zero-retention mode** ([Scribe v2 Realtime](https://elevenlabs.io/realtime-speech-to-text)). STT-specialized; currently tops accuracy benchmarks. Pricier than Whisper batch but built for exactly this.
2. **Deepgram Nova-3** — WebSocket STT over `wss://api.deepgram.com/v1/listen`, PCM16 frames in, interim + final transcripts out continuously, low latency ([Nova-3 keyterm prompting](https://deepgram.com/learn/deepgram-expands-nova-3-with-10-new-languages-and-multilingual-keyterm-prompting)). Strongest **keyterm steering** (up to 100 words / 500 tokens, multilingual, GA) and an **EU region** for residency (§7.6). The comparison/steering escape hatch. (We evaluated OpenAI's realtime transcription here but ruled it out: its `prompt` steering does not apply to realtime sessions and its first-token latency is 500–1500 ms — it can't deliver steering + streaming together.)
3. **OpenRouter Whisper turbo** — one-shot batch only; the cheap comparison baseline, visibly laggy.

**Decision:** primary path is a realtime WebSocket session, defaulting to ElevenLabs. The cost is new provider integrations — `ELEVENLABS_API_KEY` (and `DEEPGRAM_API_KEY` for the comparison/EU strategy); the backend currently only configures `OPENROUTER_API_KEY` in `env.ts:152` — plus a WebSocket relay on the backend. You've explicitly accepted that complexity in exchange for streaming.

What we give up: `whisper-large-v3-turbo` is no longer the default. It stays reachable via the batch strategy (§2.5) so you can still A/B it against the realtime providers.

### 2.2 Topology (primary: realtime WebSocket relay)

```
 Browser                              Backend (relay)                    Realtime STT provider
 ┌──────────────────────┐            ┌──────────────────────┐           ┌──────────────────┐
 │ AudioWorklet (PCM16) │            │  socket.io ns        │  WS       │ ElevenLabs Scribe│
 │  - capture frames    │  socket.io │  /voice/realtime     │  (PCM16   │ v2 Realtime  OR  │
 │  - downsample 16kHz  │  binary    │                      │  frames)  │ Deepgram Nova-3  │
 │  - send ~100ms frames│ ─────────► │  relay audio frames  │ ────────► │                  │
 │                      │            │  up; relay deltas    │           │                  │
 │  - receive deltas    │ ◄───────── │  down; record usage  │ ◄──────── │ delta / final    │
 │  - insert at caret   │  delta evt │  on session close    │  events   │ events           │
 └──────────────────────┘            └──────────────────────┘           └──────────────────┘
```

- **The browser never holds the provider key.** Audio frames go to our backend over the existing socket.io connection (binary events) or a dedicated WS route; the backend holds one upstream WS to the resolved provider (ElevenLabs or Deepgram) per active session. This keeps the API key server-side and lets us record usage/cost (INV-19), enforce per-user caps, and route by data-residency policy (§7.6).
- **A `voiceSessionId` ties the session together.** Created when the user taps mic, torn down on stop/blur/expiry. The frontend tags audio frames and filters incoming deltas by it so a stale session can't leak text into a new one.
- **User-scoped, not stream-scoped.** Dictation is private to the user and destination-agnostic (thread, scratchpad, DM), so relay events ride a per-connection channel rather than a stream room.

#### Connection model — the open decision

- **(A, recommended) Backend relay.** Client ↔ backend WS ↔ provider WS. Full cost tracking, key safety, per-user rate limiting, residency-aware routing, one place to swap models. Cost: ~one extra hop of latency (single-digit ms intra-region) and backend holds N concurrent upstream sockets.
- **(B) Browser-direct with ephemeral tokens.** Backend mints a short-lived provider token; browser connects straight to the provider. Lowest latency, no relay load. But we lose visibility into traffic for cost/telemetry, can't enforce residency routing, and must trust client-reported usage. Not recommended for a product that meters AI cost.

### 2.3 Client capture (both paths)

Use the Web Audio API with an `AudioWorkletNode` to read raw `Float32Array` samples, downsample to 16 kHz mono, and convert to PCM16:

- **Realtime path:** emit ~100 ms frames continuously, base64-encode, and send as `input_audio_buffer.append` payloads relayed upstream. Server-side VAD handles segmentation — no manual silence detection needed.
- **Batch path (§2.5):** buffer into ~2.5 s windows (or cut on a ≥300 ms silence), wrap each as a self-contained WAV blob, POST to a chunk endpoint.

AudioWorklet works on iOS Safari, Android Chrome, and desktop. Capability-detect at session start; if AudioWorklet or `getUserMedia` is unavailable, disable the mic affordance with an explanatory tooltip rather than failing silently.

### 2.4 Backend relay & the `TranscriptionStrategy` interface

All transcription goes through one interface so the transport difference is invisible to the rest of the feature:

```ts
interface TranscriptionStrategy {
  // Realtime: opens an upstream WS, returns a live session.
  // Batch: returns a session whose pushChunk() does a one-shot HTTP call.
  open(opts: { model: string; language?: string; vocabulary?: string[] }): Promise<TranscriptionSession>
}

interface TranscriptionSession {
  pushAudio(frame: Int16Array): void // realtime: append; batch: buffer
  flush(): Promise<void> // batch: send current window; realtime: commit
  onDelta(cb: (text: string) => void): void
  onError(cb: (e: TranscriptionError) => void): void
  close(): Promise<{ totalAudioMs: number; costUsd?: number }>
}
```

- **`RealtimeElevenLabsStrategy`** (recommended default) — opens ElevenLabs Scribe v2 Realtime over WebSocket, streams PCM frames, surfaces partial transcripts via `onDelta`. ~150 ms last-chunk-to-text latency, STT-specialized accuracy across 90 languages and accents, and a **Zero Retention mode** that aligns with our no-persistence stance ([Scribe v2 Realtime](https://elevenlabs.io/realtime-speech-to-text), [realtime docs](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)). Auth with `ELEVENLABS_API_KEY`.
- **`RealtimeDeepgramStrategy`** (steering-heavy comparison) — opens Deepgram Nova-3 streaming STT over WebSocket (`wss://api.deepgram.com/v1/listen`), relays PCM frames, surfaces interim/final transcripts via `onDelta`. The reason it's the comparison strategy rather than OpenAI: Nova-3's **keyterm prompting** is the strongest steering on offer — up to 100 words / 500 tokens, multilingual, GA — so it's the right escape hatch when a user's vocabulary outgrows ElevenLabs' realtime keyterm cap (50 terms × 20 chars). ~$0.46/hr streaming, 45+ languages, EU region available (see §7.6). Auth with `DEEPGRAM_API_KEY`. We dropped OpenAI realtime from this slot because its `prompt` steering parameter is **not supported in realtime sessions** ([OpenAI realtime guide](https://developers.openai.com/api/docs/guides/realtime-transcription)) and its realtime first-token latency (500–1500 ms) is the worst of the group — it can't give us steering and streaming at once, which is exactly what you asked for.
- **`BatchOpenRouterStrategy`** — buffers PCM into WAV windows, calls `POST https://openrouter.ai/api/v1/audio/transcriptions` (base64, one-shot) with `whisper-large-v3-turbo`, surfaces the returned text via `onDelta` once per window. Reuses `OPENROUTER_API_KEY` + `OPENROUTER_BASE_URL` from `ai.ts:30`. Cheapest (~$0.04/hr) but visibly laggy; the comparison baseline.

**The two realtime providers don't share a transport detail, but they share the relay shape**: client frames → backend relay → upstream WS → deltas back. Adding Deepgram cost nothing architecturally — it's the payoff of the strategy interface, and it directly serves your "compare which is most useful" goal (ElevenLabs vs Deepgram realtime vs Whisper batch), with Deepgram covering the heavy-steering / EU-residency cases ElevenLabs can't on our starting tier.

The wrapper question (INV-19/INV-28): the `@openrouter/ai-sdk-provider` SDK has no transcription or realtime primitive, so every strategy does its own `fetch`/WS. To stay inside the project's AI-governance, expose them through a `createAI`-adjacent factory (`createTranscription({ elevenlabs, deepgram, openrouter })`) that owns telemetry metadata and `CostRecorder.recordUsage()` — same pattern as `createAI`, just a different modality. Cost is recorded on `close()` from the upstream usage event (ElevenLabs/Deepgram report billed audio duration; OpenRouter returns `usage.cost`).

`models.yaml` gains a speech-to-text section. Note the provider prefix differs per strategy:

```yaml
# Speech-to-text models
elevenlabs:scribe-v2-realtime: # recommended default, realtime
  name: ElevenLabs Scribe v2 Realtime
  inputModalities: [audio]
  outputModalities: [text]
  streaming: realtime

deepgram:nova-3: # steering-heavy comparison strategy, realtime
  name: Deepgram Nova-3
  inputModalities: [audio]
  outputModalities: [text]
  streaming: realtime

openrouter:openai/whisper-large-v3-turbo: # batch comparison strategy
  name: Whisper Large v3 Turbo
  inputModalities: [audio]
  outputModalities: [text]
  streaming: batch
```

New `elevenlabs:` and `deepgram:` provider prefixes join `openrouter:`. The model-registry/provider-resolution code (`ai.ts:413`) only knows `openrouter` today; adding `elevenlabs` and `deepgram` as transcription-only providers is part of this work.

A new `audio` modality and a `streaming: realtime | batch` capability are introduced; `ModelRegistry` gets `supportsAudioInput()` and `transcriptionStreamingMode()`. Update `docs/model-reference.md` with a "Speech-to-text" section: ElevenLabs Scribe v2 Realtime (~$0.39/hr), Deepgram Nova-3 (~$0.46/hr streaming), Whisper turbo (~$0.04/hr via OpenRouter), and "when to use" guidance (ElevenLabs realtime for dictation default; Deepgram realtime when heavy keyterm steering or EU residency is needed; batch for cheap/offline comparison).

### 2.5 Batch path (secondary, for comparison)

Kept so you can compare Whisper turbo against the streaming providers without re-architecting. When the selected model's `streaming` capability is `batch`, the frontend switches from continuous frames to WAV-window uploads:

- `POST /api/workspaces/:wid/voice/sessions/:sid/chunks` — multipart `audio` field, optional `chunkIndex` / `isFinal`. Returns 202; transcription runs async on `JobQueues.VOICE_TRANSCRIBE`.
- Each completed window emits an outbox event `voice:transcript:chunk` `{ voiceSessionId, chunkIndex, text, isFinal }`, scope `user`, routed by `BroadcastHandler` to `ws:{workspaceId}:user:{userId}` (`broadcast-handler.ts:1-60`).

The batch path is the original chunked design; it is fully usable but visibly laggier (~2.5 s windows) than realtime. Treat it as a developer/comparison tool, not the default UX.

### 2.6 Backend → client (live transcript)

- **Realtime path:** deltas arrive on the relay WS and are forwarded to the browser as `voice:transcript:delta` events `{ voiceSessionId, text, isFinal }`. No outbox hop — these are ephemeral, per-connection, and latency-sensitive, so the relay emits them directly to the originating socket (the relay already holds that socket). This is the one place we bypass the outbox, justified because the data is transient and tied to a live connection rather than durable workspace state.
- **Batch path:** uses the outbox + broadcast handler (INV-4) as above, since those completions are produced by an async worker decoupled from the client connection.
- Either way the frontend listens only while a session is locally active and filters by `voiceSessionId`.

**Reconnect handling (INV-53):** if the socket drops mid-session, the realtime session is considered ended (audio can't resume cleanly); the frontend stops the recorder, keeps whatever text already landed, and surfaces a "connection lost — tap to resume" affordance that starts a fresh session. We do not attempt to replay missed deltas.

### 2.7 Streaming text into the composer (UX layer)

When a chunk arrives, we don't dump all the text at once — we want the "typing" feel.

- Maintain a small client-side **type buffer** per voice session. Each socket event appends to it.
- A `requestAnimationFrame` loop drains the buffer at ~25–40 characters per second, inserting characters at the editor caret.
- If the user moves the caret or starts typing manually, the buffer drains at the new position.
- When the session ends (`isFinal: true` on the last chunk and buffer empty), the buffer is cleared and the composer returns to idle.

On the realtime path deltas already arrive word-by-word every ~200–400 ms, so the buffer mostly just smooths jitter. On the batch path it does the heavier lifting, turning a 2.5-second chunk of dozens of characters into a believable typing animation. Same drainer, both paths.

Realtime transcription deltas are sometimes **revised** (the model corrects an interim guess as more context arrives). The drainer must support a "replace last interim span" operation, not just append: track the character range of the current not-yet-finalized delta and overwrite it when a correction arrives, committing the span only on the `isFinal`/`completed` event for that segment.

---

## 3. Backend feature

New colocated feature: `apps/backend/src/features/voice-transcription/` (INV-51).

```
voice-transcription/
├── index.ts                    # barrel exports
├── config.ts                   # default models, frame/window sizes, language defaults
├── handlers.ts                 # session create/finish/abort; batch chunk upload
├── realtime-gateway.ts         # socket.io namespace: per-session relay to upstream provider WS
├── service.ts                  # session lifecycle, strategy selection
├── repository.ts               # voice_sessions table access
├── transcription/              # the TranscriptionStrategy interface + impls (INV-44 config colocated)
│   ├── strategy.ts             # interface + factory createTranscription({ elevenlabs, deepgram, openrouter })
│   ├── realtime-elevenlabs.ts  # RealtimeElevenLabsStrategy (upstream WS, default)
│   ├── realtime-deepgram.ts    # RealtimeDeepgramStrategy (upstream WS, steering/EU comparison)
│   ├── residency.ts            # residency-aware strategy resolver (workspace policy → provider+region)
│   ├── batch-openrouter.ts     # BatchOpenRouterStrategy (one-shot HTTP, comparison)
│   └── config.ts               # model IDs, temperatures, frame sizes
├── worker.ts                   # JobQueues.VOICE_TRANSCRIBE worker (batch path only)
├── chunk-outbox-handler.ts     # batch completions → broadcast events
├── service.test.ts
├── realtime-gateway.test.ts
├── transcription/strategy.test.ts
└── handlers.test.ts
```

### 3.1 Routes & realtime gateway

HTTP handlers wired into `apps/backend/src/routes.ts` via `createVoiceTranscriptionHandlers({...})`:

- `POST /api/workspaces/:wid/voice/sessions` — create a session. Body: `{ model?: string, language?: string }`. Response: `{ voiceSessionId, transport: "realtime" | "batch", expiresAt }`. `transport` is derived from the selected model's `streaming` capability so the client knows whether to open the realtime gateway or POST chunks. Defaults from user preferences, else `config.ts`.
- `POST /api/workspaces/:wid/voice/sessions/:sid/finish` — mark done. Closes the upstream session and records usage/cost.
- `DELETE /api/workspaces/:wid/voice/sessions/:sid` — abort. Tears down the upstream WS, drops pending work.
- `POST /api/workspaces/:wid/voice/sessions/:sid/chunks` — **batch path only.** Multipart `audio`; optional `chunkIndex`/`isFinal`; returns 202, runs async on the queue.

**Realtime gateway** (`realtime-gateway.ts`): a socket.io namespace/event set on the existing server, not a raw `ws` server, so it inherits auth and the workspace connection the client already has. Events:

- client → server: `voice:audio` `{ voiceSessionId, frame }` (binary PCM16, ~100 ms).
- server → client: `voice:transcript:delta` `{ voiceSessionId, text, isFinal }`, `voice:transcription:error`.

On the first `voice:audio` for a session the gateway lazily opens the upstream provider WS via the residency-resolved strategy, then pipes frames up and deltas down until `finish`/`abort`/idle-timeout/socket-close. One upstream socket per active session; a per-user concurrency guard (max 1–2 concurrent sessions) prevents fan-out abuse.

### 3.2 Data model

One new table, kept light. **No persistence of audio bytes by default** (see [Open Decisions §2](#open-decisions)).

#### `voice_sessions`

| Column         | Type                       | Notes                                                          |
| -------------- | -------------------------- | -------------------------------------------------------------- |
| id             | TEXT PK                    | ULID prefixed `voicesess_`                                     |
| workspace_id   | TEXT NOT NULL              | INV-8                                                          |
| user_id        | TEXT NOT NULL              | Owner                                                          |
| model          | TEXT NOT NULL              | e.g. `elevenlabs:scribe-v2-realtime`                           |
| transport      | TEXT NOT NULL              | `realtime` / `batch` (derived from model)                      |
| provider       | TEXT NOT NULL              | `elevenlabs` / `deepgram` / `openrouter`                       |
| region         | TEXT NOT NULL              | resolved processing region, e.g. `us` / `eu` (residency audit) |
| language       | TEXT                       | nullable; null = auto                                          |
| status         | TEXT NOT NULL              | `active` / `finished` / `aborted` / `expired`                  |
| chunk_count    | INTEGER NOT NULL DEFAULT 0 |                                                                |
| total_audio_ms | INTEGER NOT NULL DEFAULT 0 | for cost telemetry                                             |
| created_at     | TIMESTAMPTZ NOT NULL       | DEFAULT NOW()                                                  |
| finished_at    | TIMESTAMPTZ                |                                                                |
| expires_at     | TIMESTAMPTZ NOT NULL       | created_at + 10 min — sessions auto-expire                     |

Index on `(workspace_id, user_id, status)` to find a user's active session quickly. No table for individual chunks unless we decide to persist audio (see Open Decisions).

The handler validates input with Zod (INV-55) and throws `HttpError` for failures (INV-32). Migration follows append-only convention (INV-17); add via `/add-migration`.

### 3.3 Job queue (batch path only)

The realtime path needs no queue — the gateway relays frames synchronously over the live WS. The queue exists only for the batch comparison strategy.

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

### 3.4 Realtime vs outbox events

- **Realtime path** (relay → originating socket, no outbox): `voice:transcript:delta` `{ voiceSessionId, text, isFinal }`, `voice:transcription:error` `{ voiceSessionId, code, message }`.
- **Batch path** (outbox + broadcast, scope `user`): `voice:transcript:chunk` `{ voiceSessionId, chunkIndex, text, isFinal }`, `voice:transcription:error`.
- **Both:** `voice:session:expired` — emitted by a sweeper when an active session passes `expires_at`.

### 3.5 Cost tracking

Both strategies record on session `close()` via `CostRecorder.recordUsage()` with telemetry metadata `{ functionId: "voice_transcription", voiceSessionId, transport, model, totalAudioMs }` (INV-19).

- **Realtime:** ElevenLabs and Deepgram report billed audio duration on the session; convert to dollar cost via the provider's per-hour rate and record it.
- **Batch:** OpenRouter returns `usage.cost` per request, same as chat completions; sum across windows.

Both bill on audio duration rather than text tokens. The `CostRecorder` may need a minor extension to record `{ unit: "audio_seconds", quantity }` alongside token usage; if the existing `usage.cost` field already carries dollar-cost directly, no schema change is needed.

---

## 4. Frontend implementation

### 4.1 Files added / changed

```
apps/frontend/src/
├── components/composer/
│   ├── message-composer.tsx           # extend: mic button slot + recording mode UI
│   └── voice/
│       ├── voice-recorder.ts          # AudioWorklet capture → PCM16 frames
│       ├── voice-recorder-worklet.ts  # AudioWorklet processor (downsample + framing)
│       ├── voice-transport.ts         # realtime (socket.io frames) | batch (chunk POST)
│       ├── voice-session-store.ts     # Zustand: { sessionId, transport, status, buffer }
│       ├── voice-mic-button.tsx       # the button + recording-state UI
│       ├── voice-waveform.tsx         # canvas-based waveform
│       └── insert-stream.ts           # the type-buffer drainer (append + replace-interim)
├── lib/api/voice.ts                   # createSession / finishSession / abort / (batch) uploadChunk
└── pages/settings/voice-settings.tsx  # new settings panel
```

### 4.2 Recorder API

The recorder always produces PCM16 frames; the transport decides what to do with them based on the session's `transport` field returned by `POST /sessions`.

```ts
// voice-recorder.ts — single capture pipeline, two sinks
const recorder = createVoiceRecorder({
  frameMs: 100, // realtime: send each frame; batch: buffer to windows
  onFrame: (pcm16) => transport.pushAudio(pcm16),
  onStop: () => transport.finish(),
  onError: (e) => store.setStatus("error", e.message),
})
await recorder.start() // requests getUserMedia

// voice-transport.ts
const transport =
  session.transport === "realtime"
    ? createRealtimeTransport(socket, session.voiceSessionId) // emits voice:audio frames
    : createBatchTransport(session.voiceSessionId, { windowMs: 2500, silenceCutoffMs: 300 }) // buffers → WAV → POST
```

### 4.3 Receiving deltas

Hook `useVoiceTranscriptionStream(voiceSessionId, transport)`:

- **Realtime:** listens for `voice:transcript:delta` on the active socket; handles both append and interim-replacement (track current interim span, overwrite until `isFinal`).
- **Batch:** listens for `voice:transcript:chunk` on the user room; appends each window's text.
- Both filter by `voiceSessionId` and push into the local type buffer.
- INV-53: on the batch path, pairs with a bootstrap fetch of already-completed chunks so a reconnect doesn't drop text. On the realtime path, a dropped socket ends the session (see §2.6) — there's no partial replay.

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

- **Audio bytes: never persisted by default.** Realtime frames pass through the relay and are discarded; batch windows are held in memory, sent, and dropped. No S3 write, no temp file. Logs only durations + transcribed text, not audio. ElevenLabs zero-retention mode (and Deepgram's no-storage / no-training default) means the upstream provider doesn't retain audio either.
- **Transcribed text: persisted only as the composer draft.** The drafts system (`apps/frontend/src/components/timeline/message-input.tsx`) already saves composer state to IDB; dictated text rides that machinery. No separate "voice transcript" table.
- **Voice session metadata: kept in `voice_sessions` for 7 days.** Useful for cost telemetry and debugging without retaining sensitive content.

If we want optional retention later (e.g., "save voice memos as message attachments"), we already have the attachments feature with a workspace-scoped S3 path — we'd persist the recombined audio there. That's a feature we can add without altering the v1 model.

---

## 7. Security & privacy

- **getUserMedia permission scope.** Browsers persist mic permission per-origin; we don't escalate or store anything beyond that.
- **Audio in transit.** TLS to backend, TLS to the upstream provider (ElevenLabs/Deepgram/OpenRouter). The relay terminates the client connection and opens its own upstream connection; the API key never reaches the browser. Prefer providers' zero-retention / no-training modes where available.
- **Workspace isolation.** Voice sessions are workspace-scoped (INV-8). A session created in workspace A can't be driven from a connection scoped to workspace B; standard workspace middleware plus the gateway's per-session ownership check enforce this.
- **Rate limiting & concurrency.** Reuse the existing rate-limit middleware. Realtime: max 1–2 concurrent sessions per user (the gateway holds one upstream socket each). Batch: max 30 chunk POSTs / minute.
- **Abuse considerations.** Realtime providers bill per audio minute; a hot mic streaming silence for an hour is a real bill. The `voice_sessions.expires_at` (10-min hard cap) plus a server-side idle-timeout (e.g. 30 s of VAD-detected silence auto-closes the session) limit per-session damage; per-user daily caps live in the AI cost service and apply automatically.

### 7.6 Data residency

You asked specifically: can we run ElevenLabs in EU vs US, or is the region up to them — and what's the strategy for customers who require residency.

**What ElevenLabs actually offers (researched May 2026):**

- Three residency regions — **US (default), EU, and India** — but **regional residency is an Enterprise-tier feature only** ([data residency docs](https://elevenlabs.io/docs/overview/administration/data-residency), [EU residency announcement](https://elevenlabs.io/blog/introducing-european-data-residency)). On the tier we start on, processing is **US-only**.
- It is **not fully "up to them"** at the Enterprise tier — you select the region. But the guarantee is softer than it sounds: residency pins **storage** to the region, while **processing may still occur outside it** (international affiliates, subprocessors, support, content moderation) **unless** you combine EU residency with **Zero Retention Mode + the API**, which together restrict processing to the EU. Zero Retention is also a higher-tier feature.
- Compliance posture is solid: EU‑US Data Privacy Framework certified (active on the official registry as of 2026‑05), GDPR, a DPA, plus HDS and HIPAA-capable configurations. There is no publicly documented separate EU endpoint hostname — routing is provisioned at the Enterprise account level via their CSM, not a self-serve header.

**So the honest position for v1:** we start on ElevenLabs at a non-Enterprise tier, which means **voice processing happens in the US**. That's fine for most users but unacceptable for a customer with a hard EU (or other) residency requirement. We do **not** want to silently stream a residency-required customer's audio to the US. The strategy below makes residency a first-class, enforced policy rather than an afterthought — and leans on the fact that **Threa is already region-sharded by workspace** (workspace is the data ownership/sharding boundary, INV-8), so each workspace already has a home region we can align to.

**Residency strategy (provider-agnostic, enforced at the relay):**

1. **Per-workspace residency policy.** Add `voiceResidencyPolicy: "any" | "eu" | "us" | "disabled"` (default `"any"`), stored on workspace settings, defaulting from the workspace's home region. This is the single source of truth; the model picker (§1.5) and the relay both read it.
2. **Residency-aware strategy resolver** (`transcription/residency.ts`). Given `(policy, requestedModel)`, it returns a concrete `(provider, region, endpoint)` or refuses. Selection rules:
   - `policy = "any"` → ElevenLabs US (default), or whatever model the user picked.
   - `policy = "eu"` → route to a provider+region that processes in the EU. **Deepgram Nova-3 is the v1 EU answer**: it exposes an EU processing region and is already our comparison strategy, so no new integration is needed — the resolver just selects Deepgram-EU instead of ElevenLabs-US. (If/when we reach ElevenLabs Enterprise with EU residency + Zero Retention, the resolver can prefer ElevenLabs-EU instead — a config change, not a rearchitecture.)
   - `policy = "us"` → pin to a US region explicitly (e.g. compliance that forbids EU processing).
   - No strategy satisfies the policy → **fail closed**: disable the mic for that workspace with a clear message ("Voice dictation isn't available under your data-residency settings yet"), never fall through to a non-compliant region.
3. **Audit trail.** `voice_sessions.provider` and `voice_sessions.region` (added to the table in §3.2) record where each session was actually processed, so we can prove residency after the fact.
4. **Degradation ladder, explicit and ordered:** (a) preferred in-region provider → (b) alternate in-region provider → (c) **disable** with a clear user-facing reason. Never (d) "send it to US anyway." This is the whole point of routing at the backend relay rather than browser-direct: the policy can't be bypassed by the client.

This gives you a concrete answer for residency-sensitive customers today (Deepgram-EU or disable), keeps the door open to ElevenLabs-EU once Enterprise is in play, and the abstraction means adding a third in-region option later (e.g. Azure Speech EU, or self-hosted Whisper in our EU backend region) is just another resolver branch.

---

## 8. Testing

- **Unit:** `voice-recorder.ts` (PCM framing/downsampling), `insert-stream.ts` (caret-respecting drain + interim-replacement), `service.ts` (session lifecycle + transport selection), `residency.ts` (policy → provider/region resolution, including the fail-closed "disable" branch when no in-region strategy exists), each strategy in `transcription/` (frame relay / request shape, error mapping). Mock the upstream WS for the realtime strategies.
- **Integration:** real component mount of `MessageComposer` with a mocked `voice-session-store` feeding `voice:transcript:delta` events, including an interim→final correction (INV-39).
- **E2E (Playwright):** stub `getUserMedia` and a fake realtime gateway; verify (a) mic button appears/disappears with editor empty state, (b) tapping mic creates a realtime session, (c) delta events stream text at the caret, (d) typing during dictation interleaves correctly, (e) socket drop ends the session and preserves captured text.
- **Eval (when tidy-up lands):** small corpus of transcripts with known disfluencies and corrections, scored against hand-written gold versions.

---

## 9. Milestones

| #   | Outcome                                                                                                                                                            | Estimate |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 1   | Backend feature skeleton: `voice_sessions` table, session create/finish/abort handlers, repo, service, `TranscriptionStrategy` interface.                          | 0.5 d    |
| 2   | `RealtimeElevenLabsStrategy` + realtime gateway (socket.io ns relaying to upstream WS); cost recording on close; manual test with a CLI frame feeder.              | 1.5 d    |
| 3   | Frontend recorder: AudioWorklet → PCM16 frames; realtime transport emitting `voice:audio`; receive `voice:transcript:delta`. End-to-end round-trip.                | 1.5 d    |
| 4   | Editor insert-stream (append + interim-replacement) wired to the live caret. Dictation visibly working.                                                            | 0.5 d    |
| 5   | UX polish: desktop button placement, mobile FAB, recording states, waveform.                                                                                       | 1 d      |
| 6   | Second strategy (`RealtimeDeepgramStrategy`) + batch (`BatchOpenRouterStrategy`) behind the toggle; residency resolver; settings UI (model, language, vocabulary). | 1 d      |
| 7   | E2E + integration tests; cost telemetry verification.                                                                                                              | 0.5 d    |

Total: ~6.5 days for v1 (transcription only, three swappable strategies). Drop to ~4.5 days if we ship only the ElevenLabs realtime strategy first (milestone 6 becomes a follow-up). Tidy-up pass is a separate ~2-day follow-up.

---

## 10. Risks & how we mitigate

| Risk                                                                         | Mitigation                                                                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A provider's realtime WS protocol differs (frame format, event names, auth). | Each provider is one `TranscriptionStrategy` impl; the gateway and frontend only know the neutral interface. Differences stay isolated.      |
| Backend holds many concurrent upstream sockets (one per dictating user).     | Per-user concurrency cap (1–2), idle-timeout auto-close, 10-min hard expiry. Sockets are cheap; the cap bounds fan-out.                      |
| Mobile Safari quirks with AudioWorklet on older iOS.                         | Capability-detect at session start; if unsupported, fall back to the batch strategy (MediaRecorder webm/opus windows) or disable the mic.    |
| Realtime provider latency spikes or upstream disconnect mid-dictation.       | Surface a `voice:transcription:error`; keep captured text; offer "tap to resume" (new session). Per-frame send has an upstream send timeout. |
| Socket drop mid-session loses in-flight audio.                               | Realtime sessions end on drop (no clean resume); preserve landed text. Batch path uses INV-53 bootstrap to recover completed chunks.         |
| Interim deltas get revised and the composer flickers.                        | Interim-replacement drain: overwrite the tracked interim span, commit only on `isFinal`. No re-insert of committed text.                     |
| Background tabs throttle the recorder and audio capture goes silent.         | Listen for `visibilitychange`; pause + show a "Tab paused" banner; do not silently drop audio.                                               |
| Cost runaway from accidental hot mics (realtime bills per minute).           | 10-min hard expiry + idle-timeout. Per-user daily cost cap via existing AI cost service. UI warning if user crosses a soft limit.            |

---

## 11. Open Decisions

A few still open; the first three are now **decided** and recorded here for traceability.

1. ✅ **Default provider — decided: `elevenlabs:scribe-v2-realtime`.** Cheapest ($0.39/hr), lowest latency (~150 ms), STT-specialized, zero-retention. Deepgram Nova-3 is the swappable comparison/steering + EU-residency strategy. OpenAI ruled out (no steering in realtime sessions). Needs `ELEVENLABS_API_KEY` (+ `DEEPGRAM_API_KEY` for the comparison/EU path).
2. **Realtime connection model.** Recommended: backend WS relay (cost tracking + key safety + residency routing). Alternative: browser-direct with ephemeral tokens (lower latency, weaker observability, can't enforce residency). The relay is the right call for a metered product unless latency is unacceptable in testing.
3. ✅ **Strategy coverage in v1 — decided: start with ElevenLabs.** Ship ElevenLabs realtime first; Deepgram realtime + OpenRouter batch land in the fast follow (milestone 6) so you can A/B and so the EU-residency path exists.
4. **Audio persistence.** Recommended: never persist; rely on providers' zero-retention modes. Alternative: short-lived S3 with 7-day TTL for debug, behind a flag.
5. **Tidy-up timing model.** Recommended: end-of-session full rewrite. Alternative: per-chunk with re-rewrite of last two chunks. (Decide later; doesn't block v1. With strong realtime self-correction handling, the tidy-up may be less necessary than originally thought.)
6. ✅ **Vocabulary hints in v1 — yes.** Cheap to build; ElevenLabs (≤50 realtime terms) and Deepgram (≤100 words) both accept keyterm biasing, so it helps domain language immediately.
7. **Data residency (new).** v1 starts on ElevenLabs non-Enterprise = **US processing only**. Plan is a per-workspace `voiceResidencyPolicy` enforced at the relay (§7.6): EU-required workspaces route to Deepgram-EU, or voice is disabled (fail closed) — never silently US. Open sub-question for you: **for the very first cut, is it acceptable to ship US-only and gate EU customers behind "coming soon," or do you want the Deepgram-EU route wired in milestone 6 so EU customers are supported at launch?**
8. **Cost cap UI.** Where (if anywhere) do we surface "you've spent $X on voice this month"? Probably the settings page. Out of scope for v1 unless you'd like it.

---

## 12. References

- `apps/frontend/src/components/composer/message-composer.tsx:218-990` — composer
- `apps/frontend/src/components/editor/rich-editor.tsx:33-41, 777` — editor handle, programmatic insert
- `apps/frontend/src/components/timeline/message-input.tsx:189-468` — host of the composer
- `apps/backend/src/lib/ai/ai.ts:30,392-949` — `createAI` wrapper + `OPENROUTER_BASE_URL`; pattern to mirror for `createTranscription`
- `apps/backend/src/lib/ai/ai.ts:413` — provider resolution (only `openrouter` today; add `elevenlabs`/`deepgram`)
- `apps/backend/src/lib/ai/models.yaml` — model capability registry (add `audio` modality + `streaming` capability)
- `apps/backend/src/lib/env.ts:152` — provider keys (add `ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`)
- `apps/backend/src/features/attachments/` — precedent for file upload (multer-s3); used by the batch path
- `apps/backend/src/lib/outbox/broadcast-handler.ts:1-60` — user-scoped socket.io routing (batch path)
- `apps/backend/src/lib/queue/job-queue.ts` — job queue tiers (batch worker)
- `apps/backend/src/features/user-preferences/service.ts:115-184` — preference store + outbox propagation
- `docs/model-reference.md` — where the new STT entries go
- ElevenLabs: [Scribe v2 Realtime](https://elevenlabs.io/realtime-speech-to-text) · [Realtime STT API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime) · [client-side streaming guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/client-side-streaming) · [data residency](https://elevenlabs.io/docs/overview/administration/data-residency) · [EU residency announcement](https://elevenlabs.io/blog/introducing-european-data-residency)
- Deepgram (comparison/steering + EU residency): [Nova-3 keyterm prompting](https://deepgram.com/learn/deepgram-expands-nova-3-with-10-new-languages-and-multilingual-keyterm-prompting) · [Nova-3 intro](https://deepgram.com/learn/introducing-nova-3-speech-to-text-api) · [pricing](https://deepgram.com/pricing)
- OpenAI (evaluated, ruled out for realtime steering): [Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription)
- OpenRouter (batch comparison): [Audio APIs announcement](https://openrouter.ai/announcements/announcing-audio-apis) · [Whisper Large v3 Turbo](https://openrouter.ai/openai/whisper-large-v3-turbo)
