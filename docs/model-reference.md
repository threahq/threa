# AI Model Reference

**Last updated:** 2026-04-12

This document provides a comprehensive reference for AI models including capabilities, pricing, and usage guidelines. Always verify against this file when working with AI integration.

## Model Capabilities Registry

The source of truth for model input/output modalities is `apps/backend/src/lib/ai/models.yaml`. This file defines which models support vision, text, and other modalities. The `ModelRegistry` class loads this at startup and provides capability checks:

```typescript
import { createModelRegistry } from "./lib/ai/model-registry"

const modelRegistry = createModelRegistry()

// Check if a model supports vision (image input)
if (modelRegistry.supportsVision("openrouter:anthropic/claude-sonnet-4.5")) {
  // Model can process images
}
```

When adding new models, update `models.yaml` with their capabilities.

## Model Format

All models use `provider:modelPath` format:

- `openrouter:anthropic/claude-haiku-4.5`
- `openrouter:anthropic/claude-sonnet-4.5`

**Note:** OpenRouter uses version numbers (e.g., `claude-sonnet-4.5`), not date-suffixed versions (e.g., `claude-sonnet-4-20250514`). Don't use date suffixes - they don't exist on OpenRouter.

## Inference Models

### openrouter:anthropic/claude-sonnet-4.6

**Name:** Claude Sonnet 4.6

**Description:** Latest high-quality reasoning model from Anthropic's Claude 4.6 generation. Successor to Claude Sonnet 4.5 with improved capabilities.

**Typical cost:** ~$3.00 per 1M input tokens, ~$15.00 per 1M output tokens

**When to use:**

- Complex reasoning and generation
- Multi-turn agent conversations
- Nuanced text generation requiring high quality
- Default Ariadne companion persona model
- Tasks where quality justifies higher cost

**Use instead of:** `claude-sonnet-4.5` for improved quality

---

### openrouter:anthropic/claude-haiku-4.5

**Name:** Claude Haiku 4.5

**Description:** Fast, cost-effective model from Anthropic's Claude 4.5 generation. Good balance of speed, cost, and accuracy for structured tasks.

**Typical cost:** ~$0.25 per 1M input tokens, ~$1.25 per 1M output tokens

**When to use:**

- Classification and extraction (structured output)
- Simple reasoning tasks
- General chat and conversations
- High-volume batch operations where quality bar is met
- Stream naming, memo classification

**Use instead of:** `claude-3-haiku`, `claude-3.5-haiku`, or any Claude 3.x series models

---

### openrouter:anthropic/claude-sonnet-4.5

**Name:** Claude Sonnet 4.5

**Description:** High-quality reasoning model from Anthropic's Claude 4 generation. Best for complex tasks requiring nuanced understanding and generation.

**Typical cost:** ~$3.00 per 1M input tokens, ~$15.00 per 1M output tokens

**When to use:**

- Complex reasoning and generation
- Multi-turn agent conversations (LangGraph/LangChain)
- Nuanced text generation requiring high quality
- Tasks where quality justifies higher cost
- Companion agent responses, simulation agents

**Use instead of:** `claude-3-sonnet`, `claude-3.5-sonnet`, `claude-3-opus`, or any Claude 3.x series models

---

### openrouter:openai/gpt-5-mini

**Name:** GPT-5 Mini

**Description:** Cost-effective model from OpenAI's GPT-5 generation. Good balance of performance and cost for general tasks.

**Typical cost:** ~$0.40 per 1M input tokens, ~$1.60 per 1M output tokens

**When to use:**

- Classification and extraction tasks
- General reasoning and chat
- Structured output generation
- Tasks where GPT ecosystem is preferred
- Cost-sensitive applications

**Use instead of:** `gpt-4o`, `gpt-4o-mini`, `gpt-3.5-turbo`

---

### openrouter:openai/gpt-5-nano

**Name:** GPT-5 Nano

**Description:** Ultra-fast, cost-effective model from OpenAI's GPT-5 generation. Optimized for high-throughput tasks.

**Typical cost:** ~$0.10 per 1M input tokens, ~$0.40 per 1M output tokens

**When to use:**

- High-volume batch operations
- Simple classification tasks
- Fast response requirements
- Extremely cost-sensitive workloads
- Tasks where speed matters more than nuance

**Use instead of:** `gpt-3.5-turbo`, `gpt-4o-mini`

---

### openrouter:openai/gpt-5.4-mini

**Name:** GPT-5.4 Mini

**Description:** High-capability small model from OpenAI's GPT-5.4 generation (March 2026). Significantly improves over GPT-5 Mini across coding, reasoning, multimodal understanding, and tool use while running 2x faster. Supports configurable reasoning effort levels. 400K context window.

**Typical cost:** ~$0.75 per 1M input tokens, ~$4.50 per 1M output tokens

**When to use:**

- Complex structured output and abstractive writing
- Agent workflows and coding assistants at scale
- Tasks requiring high-quality reasoning in a cost-effective tier
- Multi-turn conversations with tool use
- Memo generation where quality justifies the cost over nano

**Use instead of:** `gpt-5-mini` for improved quality across all tasks

---

### openrouter:openai/gpt-5.4-nano

**Name:** GPT-5.4 Nano

**Description:** Smallest, cheapest model in OpenAI's GPT-5.4 generation (March 2026). Optimized for low-latency, high-volume tasks. Outperforms GPT-5 Mini on benchmarks despite lower cost. Supports configurable reasoning effort levels. 400K context window.

**Typical cost:** ~$0.20 per 1M input tokens, ~$1.25 per 1M output tokens

**When to use:**

- Classification, data extraction, and ranking (primary design target)
- Memo classification (gem detection)
- High-volume batch pipelines
- Sub-agent tasks in multi-agent systems
- Cost-sensitive workloads that still need good quality

**Use instead of:** `gpt-5-mini`, `gpt-5-nano` for better quality at comparable or lower cost

---

### openrouter:openai/gpt-oss-120b

**Name:** GPT-OSS 120B

**Description:** Open-weight 117B-parameter MoE model from OpenAI (Apache 2.0). Activates 5.1B params per forward pass, optimized for single H100 with native MXFP4 quantization. Supports configurable reasoning depth, chain-of-thought, and native tool use.

**Context:** 131K tokens (400K available on some providers)

**Typical cost:** ~$0.04 per 1M input tokens, ~$0.19 per 1M output tokens

**When to use:**

- High-volume reasoning tasks where open-weight licensing matters
- Cost-sensitive workloads where quality bar is low
- Self-hosted inference on single H100

**Note:** Previously used for memo classification, memorization, and researcher agent. Replaced by `claude-haiku-4.5` (researcher), `gpt-5.4-nano` (memo classifier/memorizer) due to unreliable tail latency on OpenRouter's patchwork provider backing and insufficient quality for structured extraction.

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

**Claude 3 Series:**

- ❌ `openrouter:anthropic/claude-3-haiku` → Use `openrouter:anthropic/claude-haiku-4.5`
- ❌ `openrouter:anthropic/claude-3-sonnet` → Use `openrouter:anthropic/claude-sonnet-4.5`
- ❌ `openrouter:anthropic/claude-3.5-sonnet` → Use `openrouter:anthropic/claude-sonnet-4.5`
- ❌ `openrouter:anthropic/claude-3-opus` → Use `openrouter:anthropic/claude-opus-4.5`

**OpenAI Legacy:**

- ❌ `openrouter:openai/gpt-3.5-turbo` → Use `openrouter:openai/gpt-5.4-nano`
- ❌ `openrouter:openai/gpt-4o` → Use `openrouter:openai/gpt-5` or `openrouter:openai/gpt-5.4-mini`
- ❌ `openrouter:openai/gpt-4o-mini` → Use `openrouter:openai/gpt-5.4-nano`
- ❌ `openrouter:openai/gpt-5-mini` → Use `openrouter:openai/gpt-5.4-mini` or `openrouter:openai/gpt-5.4-nano`
- ❌ `openrouter:openai/gpt-5-nano` → Use `openrouter:openai/gpt-5.4-nano`

**Why deprecated:** These are superseded by newer model generations with improved capabilities and pricing.
