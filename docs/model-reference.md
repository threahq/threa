# AI Model Reference

**Last updated:** 2026-07-30

This document provides a comprehensive reference for AI models including capabilities, pricing, and usage guidelines. Always verify against this file when working with AI integration.

## Price table

All figures per 1M tokens, verified on 2026-07-30. Temporary OpenRouter discounts are excluded; Luna's listed discounted rates were normalized to its standard rates. **Verify before making a model-choice argument** — this table was wrong about `claude-haiku-4.5` by 4× for months, and five components were pinned to it on the strength of that number:

```bash
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY" \
 | jq -r '.data[] | select(.id|test("MODEL")) | [.id,(.pricing.prompt|tonumber*1e6),(.pricing.completion|tonumber*1e6),(.pricing.input_cache_read//"-"),(.pricing.input_cache_write//"-")] | @tsv'
```

| Model                           | Input | Output | Cache read | Cache write | Context |
| ------------------------------- | ----- | ------ | ---------- | ----------- | ------- |
| `openai/gpt-5.4-nano`           | $0.20 | $1.25  | $0.02      | free        | 400K    |
| `openai/gpt-5.4-mini`           | $0.75 | $4.50  | $0.075     | free        | 400K    |
| `openai/gpt-5.6-luna`           | $0.20 | $1.20  | $0.02      | **$0.25**   | 1.05M   |
| `openai/gpt-5.6-terra`          | $2.50 | $15.00 | $0.25      | $3.125      | 1.05M   |
| `openai/gpt-5.6-sol`            | $5.00 | $30.00 | $0.50      | $6.25       | 1.05M   |
| `anthropic/claude-haiku-4.5`    | $1.00 | $5.00  | $0.10      | $1.25       | 200K    |
| `anthropic/claude-sonnet-5`     | $2.00 | $10.00 | $0.20      | $2.50       | 1M      |
| `anthropic/claude-sonnet-4.6`   | $3.00 | $15.00 | $0.30      | $3.75       | 1M      |
| `anthropic/claude-opus-5`       | $5.00 | $25.00 | $0.50      | $6.25       | 1M      |
| `google/gemini-2.5-flash-lite`  | $0.10 | $0.40  | $0.01      | $0.083      | 1M      |
| `google/gemini-3.1-flash-lite`  | $0.25 | $1.50  | $0.025     | $0.083      | 1M      |
| `google/gemini-2.5-flash`       | $0.30 | $2.50  | $0.03      | $0.083      | 1M      |
| `google/gemini-3.5-flash-lite`  | $0.30 | $2.50  | $0.03      | $0.083      | 1M      |
| `google/gemini-3.6-flash`       | $1.50 | $7.50  | $0.15      | $0.083      | 1M      |
| `openai/text-embedding-3-small` | $0.02 | —      | —          | —           | —       |

Anthropic, Google and OpenAI only. That is a deliberate constraint, not an accident of history: those three can be run regionally, through OpenRouter or direct with the provider, and that has repeatedly mattered more than a cheaper per-token rate elsewhere.

**Cache columns are not a footnote — they change which model is cheapest.**

- **Free writes (OpenAI family).** Caching is automatic and costs nothing to attempt, so a stable ≥1024-token prefix is pure upside. A cache miss bills the normal input rate.
- **Paid writes (Anthropic, Google, and `gpt-5.6-luna`).** A miss on a cacheable-size prompt bills the **write** rate, not the input rate. Luna bills $0.25 on a miss or $0.02 on a hit; its $0.20 headline input rate applies below the cache floor. Prompts above 272K tokens use the long-context rate ($0.40 input, $1.80 output, $0.04 cache read, $0.50 cache write).
- **Anthropic and Google need an explicit breakpoint** (`applyCacheBreakpoints`, `packages/agent-runtime/src/ai/ai.ts`); the OpenAI family needs only prefix stability.
- **A prefix only caches if it is genuinely a prefix.** Interpolating a date, a language rule, or a message list _above_ the static block truncates the cacheable span to whatever precedes the first variable — commonly a few dozen tokens, under the 1024-token floor, so nothing caches at all.

## Model Capabilities Registry

The source of truth for model input/output modalities is `packages/agent-runtime/src/ai/models.yaml`. This file defines which models support vision, text, and other modalities. The `ModelRegistry` class loads this at startup and provides capability checks:

```typescript
import { createModelRegistry } from "./lib/ai/model-registry"

const modelRegistry = createModelRegistry()

// Check if a model supports vision (image input)
if (modelRegistry.supportsVision("openrouter:anthropic/claude-sonnet-5")) {
  // Model can process images
}
```

When adding new models, update `models.yaml` with their capabilities.

## Model Format

All models use `provider:modelPath` format:

- `openrouter:anthropic/claude-sonnet-5`
- `openrouter:openai/gpt-5.4-mini`

**Note:** OpenRouter uses version numbers (e.g., `claude-sonnet-5`), not date-suffixed versions (e.g., `claude-sonnet-4-20250514`). Don't use date suffixes - they don't exist on OpenRouter.

## Inference Models

Everything listed here is also in `models.yaml`, so it is offered in the persona
model picker. The two lists are meant to stay identical — an entry is an offer.

### openrouter:anthropic/claude-opus-5

**Name:** Claude Opus 5

**Description:** Anthropic's flagship, for demanding reasoning, coding and long-horizon agentic work. 1M context. Same per-token price as the Opus 4.x line it replaces, with a larger context window than Opus 4.5.

**Typical cost:** ~$5.00 / ~$25.00 per 1M (cache read $0.50, cache write $6.25)

**When to use:**

- Low-volume, high-stakes calls where quality dominates cost
- Offered in the picker as an `escalationModel`. It was Ariadne's default escalation until 2026-08-31, when Terra took that slot — see the Terra entry.

**Use instead of:** any Opus 4.x.

---

### openrouter:anthropic/claude-sonnet-5

**Name:** Claude Sonnet 5

**Description:** Near-Opus quality on agentic and coding work at Sonnet cost. Adaptive thinking on by default; the tokenizer produces ~30% more tokens for the same text than Sonnet 4.6, so per-request cost is roughly a wash despite the lower per-token price. 1M context.

**Typical cost:** ~$2.00 / ~$10.00 per 1M (introductory through 2026-08-31; $3.00/$15.00 after). Cache read $0.20, cache write $2.50.

**When to use:**

- Complex reasoning and multi-turn agent conversations
- Was the default Ariadne persona model from 2026-07-11 to 2026-08-27, on the July 2026 companion eval against 4.6 (51/84 vs 46/84 case-runs, best judge quality) at ~34% higher per-conversation cost and ~30% higher latency. Replaced by Luna as a product decision, not an eval result — see the Luna entry.

**Use instead of:** `claude-sonnet-4.6`

---

### openrouter:anthropic/claude-sonnet-4.6

**Name:** Claude Sonnet 4.6

**Description:** The prior Sonnet generation. Kept so personas already pinned to it keep resolving, and because the July 2026 companion eval measured it directly against Sonnet 5, so the comparison is real rather than assumed.

**Typical cost:** ~$3.00 / ~$15.00 per 1M (cache read $0.30, cache write $3.75)

**When to use:** nothing new. Prefer `claude-sonnet-5` — cheaper and it won the eval.

The general researcher (`general_research`) pinned 4.6 until 2026-08-31. It now inherits the calling turn's model: on a backend persona turn that is the resolved turn model, escalation included; an enclave turn always forwards the persona's base model, since enclave turns never escalate. `gpt-5.6-luna` is the fallback where there is no calling turn, and an eval's `general:researcher` override outranks both. No code path selects 4.6 by default any more.

Research cost now follows the turn: a persona pinned to Opus 5 researches at Opus prices, where the same research used to bill at Sonnet 4.6's.

---

### openrouter:anthropic/claude-haiku-4.5

**Name:** Claude Haiku 4.5

**Description:** Fast, but **not the cheap tier** — the most expensive small model here, above `gpt-5.4-mini` on both axes and 5× `gpt-5.4-nano` on input.

**Typical cost:** ~$1.00 / ~$5.00 per 1M (cache read $0.10, cache **write** $1.25)

**When to use:** nothing. No production component selects it.

This entry read `$0.25/$1.25` until 2026-07-27 — 4× under the real price. On the strength of that number five components were pinned to haiku "for cost" (companion summary, workspace-agent plan/eval, turn digest, supersede validator, the Empty Agent shell) and the over-budget degradation map degraded Sonnet _to_ it, buying 2× where `gpt-5.4-mini` buys 2.7× and `gpt-5.4-nano` buys 10×. All six now target Luna. Left in the registry so a persona deliberately pinned to it keeps resolving.

**Use instead:** `gpt-5.6-luna`.

---

### openrouter:openai/gpt-5.4-nano

**Name:** GPT-5.4 Nano

**Description:** Cheapest model here. Designed for classification, extraction and ranking. 400K context.

**Typical cost:** ~$0.20 / ~$1.25 per 1M (cache read $0.02, writes free)

**When to use:** nothing new. Luna is cheaper at its undiscounted price and stronger on the evaluated classification suites.

**Caution:** re-tested July 2026 on the memo-classifier and boundary-extraction suites and rejected for both — it classified real knowledge as not-worthy 6/9 with the same three misses every round (silent knowledge loss) and failed sandwich-split/gap-resume every round (30–33/35 against mini's 33–35/35). Cheap, but not for anything where a miss is invisible.

---

### openrouter:openai/gpt-5.4-mini

**Name:** GPT-5.4 Mini

**Description:** The workhorse. Structured output and abstractive writing at a small-model price, ~2s per call, no cache-write premium. 400K context.

**Typical cost:** ~$0.75 / ~$4.50 per 1M (cache read $0.075, writes free)

**When to use:** nothing new. Production text components moved to Luna after its July 2026 price cut.

---

### openrouter:openai/gpt-5.6-luna

**Name:** GPT-5.6 Luna

**Description:** Fast, high-volume tier of the GPT-5.6 series. 1.05M context. Available EU-pinned. A `gpt-5.6-luna-pro` variant (same price) serves the same weights with `reasoning.mode: pro`.

**Typical cost:** ~$0.25 / ~$1.20 per 1M **on a cache miss**, ~$0.02 per 1M on a hit. The $0.20 headline input rate applies below the 1024-token cache floor. Long-context pricing begins at 272K tokens ($0.40/$1.80). Prices exclude temporary OpenRouter discounts.

**When to use:**

- Default Ariadne companion persona model (since 2026-08-27)
- Default LLM-as-judge model for the eval suites (`EVAL_JUDGE_MODEL`)
- Classification, extraction, ranking, naming, transcript polish, and summarization
- Memo memorization and tool-call guarding
- Over-budget model degradation
- Fallback model for the general researcher (since 2026-08-31; was pinned `claude-sonnet-4.6`). Callers with a turn of their own pass their own model instead, so this fires only where no calling turn exists — chosen as the cheapest current-generation model that still holds up on agentic tool use, on the same reasoning as the degradation map below, not on a research-specific eval.

**On the Ariadne default — read this before citing it as an eval win.** It is
Kristoffer's product call, taken on Luna's cost and his own use of it, and the
August 2026 comparison did NOT establish quality parity with `claude-sonnet-5`.
What that attempt produced:

- The one credit-clean head-to-head ran on a harness with four defects since
  fixed, and had sonnet-5 marginally AHEAD: 52/105 vs 48/105 case-runs, judge
  quality 0.661 vs 0.659 — a dead heat.
- The run that showed Luna far ahead (84/117 vs 43/117) is void: the OpenRouter
  key hit its weekly cap and rejected 1428 sonnet-5 calls. Luna survived that
  run _because_ its requests reserve fewer tokens. That number measures the
  credit ceiling, not the models, and it is the single most misleading artifact
  of the exercise.
- The clean rerun was killed by SIGTERM at 126/324 case-runs and never finished.

So the honest status is _unmeasured_, not _equal_. `evals/companion-model-comparison.yaml`
runs the comparison; finish it before this entry claims anything about quality.

**Consequence of the switch:** over-budget degradation is now a no-op for the
default persona. Every `MODEL_DEGRADATION_MAP` target is Luna because it is the
cheapest current-generation model that still holds up on agentic tool use, so a
workspace whose default persona is already Luna has no cheaper tier to fall back
to at the soft limit.

**Eval history (July 2026, 6-run tallies vs `gpt-5.4-mini`):** memorizer 10/10 cases perfect against mini's 8/10 — Luna never leaked the anti-gossip residuals and never inverted a decision direction; boundary-extraction effectively tied (0.996 vs 0.992); memo-classifier tied (11/11 both). Luna was ~40% slower per call, but the price cut makes it cheaper than both 5.4 tiers, so every production task previously on a GPT-5.4 tier now uses Luna.

---

### openrouter:openai/gpt-5.6-terra

**Name:** GPT-5.6 Terra

**Description:** Balanced tier of the GPT-5.6 series, between Sol and Luna. Everyday coding, reasoning and agentic work. 1.05M context.

**Typical cost:** ~$2.50 / ~$15.00 per 1M (cache read $0.25, cache write $3.125)

**When to use:**

- Default `escalationModel` for Ariadne since 2026-08-31 — persona turns whose previous attempt failed response validation run here. A product decision, not an eval result: the companion eval has never run against Terra, and nothing here measures it against `claude-opus-5`, the escalation it replaced.
- Otherwise not evaluated here.

---

### openrouter:openai/gpt-5.6-sol

**Name:** GPT-5.6 Sol

**Description:** Flagship of the GPT-5.6 series. Complex reasoning, coding and agentic workflows, strongest on multi-step command-line work. 1.05M context.

**Typical cost:** ~$5.00 / ~$30.00 per 1M (cache read $0.50, cache write $6.25)

**When to use:** not evaluated here yet. Offered in the picker; nothing selects it by default.

---

### openrouter:google/gemini-2.5-flash-lite

**Name:** Gemini 2.5 Flash Lite

**Description:** Cheapest vision-capable model here — 3× cheaper input and 6× cheaper output than 2.5 Flash. 1M context.

**Typical cost:** ~$0.10 / ~$0.40 per 1M (cache read $0.01, cache write $0.083)

**When to use:** the obvious swap target for `image-caption`, but **there is no eval suite for that component** (`evals/suites/multimodal-vision` drives `PersonaAgent.run()`, not the captioner), and captions feed boundary extraction, memo extraction and agent context — a regression there is silent. Build the suite first.

---

### openrouter:google/gemini-2.5-flash

**Name:** Gemini 2.5 Flash

**Description:** Fast multimodal model, 1M context. Vision quality is why it is here — it reads screenshots, charts and scanned documents well enough to drive downstream extraction.

**Typical cost:** ~$0.30 / ~$2.50 per 1M (cache read $0.03, cache write $0.083)

**When to use:**

- Image captioning and OCR (`image-caption`) — production choice
- Large-attachment summarization where the 1M window matters (`text-summary`)

**Note:** on image work, output is usually the larger half of the bill — the structured extraction schema (headings, labels, body, chart/table/diagram data) is verbose. Shape the schema before reaching for a cheaper model.

---

### openrouter:google/gemini-3.1-flash-lite

**Name:** Gemini 3.1 Flash Lite

**Description:** GA high-efficiency multimodal model for low-latency, high-volume work. 1M context. Cheaper on output than 2.5 Flash while being a newer generation.

**Typical cost:** ~$0.25 / ~$1.50 per 1M (cache read $0.025, cache write $0.083)

**When to use:** not evaluated here yet. A candidate for `image-caption` alongside 2.5 Flash Lite once that suite exists.

---

### openrouter:google/gemini-3.5-flash-lite

**Name:** Gemini 3.5 Flash Lite

**Description:** High-efficiency model with upgraded agentic behaviour, aimed at subagents running focused tasks. 1M context. Same price as 2.5 Flash, newer generation.

**Typical cost:** ~$0.30 / ~$2.50 per 1M (cache read $0.03, cache write $0.083)

**When to use:** not evaluated here yet.

---

### openrouter:google/gemini-3.6-flash

**Name:** Gemini 3.6 Flash

**Description:** Google's current high-efficiency model for coding and agentic workflows. 1M context.

**Typical cost:** ~$1.50 / ~$7.50 per 1M (cache read $0.15, cache write $0.083)

**When to use:** not evaluated here yet. Note the cache-write rate is far below the read-heavy Anthropic/OpenAI premium tiers, so a stable prefix pays back quickly here.

---

## Embedding Models

### openrouter:openai/text-embedding-3-small

**Name:** Text Embedding 3 Small

**Description:** Standard embedding model from OpenAI for semantic search and similarity tasks.

**Typical cost:** ~$0.02 per 1M tokens

**When to use:**

- Message and memo embeddings for semantic search
- Similarity comparisons
- Vector database indexing
- All embedding needs unless specific requirements dictate otherwise

**Use instead of:** `text-embedding-ada-002`, older embedding models

---

## Speech-to-Text Models

Realtime WebSocket speech-to-text providers used by voice dictation. The
`TranscriptionStrategy` interface (in `apps/backend/src/features/voice-transcription/transcription/strategy.ts`)
abstracts the per-provider wire protocol. A provider is only registered if its
API key env var is set; with no key, sessions for that provider fail loudly at
relay open time (INV-11).

Users pick which provider to use via the `voiceTranscriptionModel` preference;
omitted → server-configured default (`voiceConfig.defaultModel`).

### elevenlabs:scribe-v2-realtime

**Name:** ElevenLabs Scribe v2 Realtime

**Description:** Multilingual realtime STT. Audio is sent as base64-wrapped JSON chunks; auto-commits on VAD silence.

**Typical cost:** ~$0.39/hour of audio

**Env var:** `ELEVENLABS_API_KEY`

**When to use:**

- Default voice dictation provider
- Multilingual workspaces (auto-detects language by default)

### deepgram:nova-3

**Name:** Deepgram Nova-3

**Description:** Realtime STT. Audio is sent as raw binary PCM16; auto-finalizes utterances on 300ms silence (`endpointing=300`).

**Typical cost:** ~$0.46/hour of audio

**Env var:** `DEEPGRAM_API_KEY`

**When to use:**

- Alternative when ElevenLabs is unavailable or a workspace prefers Deepgram for accuracy/latency on specific languages
- Opt in per user via `voiceTranscriptionModel: "deepgram:nova-3"` preference

---

## Deprecated Models (Do Not Use)

Anything not listed under [Inference Models](#inference-models) is deprecated. It was removed from `models.yaml` on 2026-07-27, so it is no longer offered in the persona picker.

| Removed                                                                        | Use instead                          |
| ------------------------------------------------------------------------------ | ------------------------------------ |
| `claude-opus-4.5`, `claude-opus-4.8`, any Opus 4.x                             | `claude-opus-5`                      |
| `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-3.5-sonnet`, `claude-3-sonnet` | `claude-sonnet-5`                    |
| `claude-3-haiku`, `claude-3.5-haiku`                                           | `gpt-5.4-mini` (see the haiku entry) |
| `gpt-5`, `gpt-5-mini`, `gpt-4o`, `gpt-4-turbo`                                 | `gpt-5.4-mini`                       |
| `gpt-5-nano`, `gpt-4o-mini`, `gpt-3.5-turbo`                                   | `gpt-5.4-nano`                       |
| `gemini-2.5-pro`                                                               | `gemini-3.6-flash`                   |
| `gpt-oss-120b`, any open-weight model                                          | `gpt-5.4-nano`                       |

**On open-weight models.** `gpt-oss-120b` originally ran memo classification, memorization and the researcher agent, and was replaced in spring 2026 for unreliable tail latency on OpenRouter's patchwork provider backing. It was re-tested in July 2026 and rejected again on quality. A July 2026 sweep reached the same conclusion for the DeepSeek line: `deepseek-v4-pro` matched mini on quality (106/107 calls passing) at almost half the price but averaged **15.9s per call** against mini's ~2s; `deepseek-v4-flash` scored 0.976 and dropped the classic sandwich-split and gap-resume cases; `z-ai/glm-5.2` scored 0.919; `qwen3.5-flash` passed 24% with calls up to 8.9 minutes. Open-weight quality can be there; OpenRouter's provider latency is not. That, plus the regional-execution constraint, is why the registry is Anthropic/Google/OpenAI only.

**Caution when comparing models:** the eval CLI's `-m` flag did not reach ConfigResolver-backed components until the July 2026 runner fix, so any "nano" comparison older than that silently ran the production model.
