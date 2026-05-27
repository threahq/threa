import type { AI, CostContext } from "@threa/agent-runtime"
import type { RenderableMessage } from "./types"
import { SUMMARIZER_MAX_TOKENS, SUMMARIZER_MODEL_ID, SUMMARIZER_TEMPERATURE } from "./config"

export interface SummarizeInput {
  refKey: string
  items: RenderableMessage[]
}

export interface SummarizeDeps {
  ai: AI
  costContext: CostContext
  /** Override for tests / evals. Leave undefined in production. */
  model?: string
}

/**
 * Produce a neutral, citation-preserving summary of the thread messages. The
 * resulting string goes into the stable region of the prompt and is cached in
 * `context_summaries` keyed by the explicit inputs manifest (see
 * fingerprint.ts) so any drift in any message flips the key and re-runs this.
 *
 * Returns `{ text, model }` so the caller can persist the model id alongside
 * the summary in context_summaries.
 */
export async function summarizeThread(
  deps: SummarizeDeps,
  input: SummarizeInput
): Promise<{ text: string; model: string }> {
  const model = deps.model ?? SUMMARIZER_MODEL_ID

  const messages = input.items
    .map((m) => {
      const edited = m.editedAt ? ` (edited)` : ""
      return `- [${m.messageId}] ${m.authorName} at ${m.createdAt}${edited}: ${m.contentMarkdown}`
    })
    .join("\n")

  const result = await deps.ai.generateText({
    model,
    telemetry: {
      functionId: "context-bag.summarize",
      metadata: {
        ref_kind: "thread",
        ref_key: input.refKey,
      },
    },
    context: deps.costContext,
    temperature: SUMMARIZER_TEMPERATURE,
    maxTokens: SUMMARIZER_MAX_TOKENS,
    messages: [
      {
        role: "system",
        content: [
          "You summarize chat threads so another assistant can reason about them.",
          "Be neutral and factual. Do not add opinions, recommendations, or meta commentary.",
          "Preserve specific details: names, decisions, unresolved questions, and open action items.",
          "Cite messages inline using their bracketed ids (for example `[msg_abc]`) whenever you",
          "mention a specific claim so downstream answers can point back to the source.",
          "Output a short plain-text summary under 500 words. No bullet lists unless the thread was itself a list.",
        ].join(" "),
      },
      {
        role: "user",
        content: [`Summarize the following thread. Source key: ${input.refKey}.`, "", messages].join("\n"),
      },
    ],
  })

  return { text: result.value, model }
}
