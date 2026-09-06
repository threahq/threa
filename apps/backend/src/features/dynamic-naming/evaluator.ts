import type { AI } from "@threahq/agent-runtime"
import type { ConfigResolver } from "../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../lib/ai/config-resolver"
import { DynamicNamingDecisionResponseSchema, DynamicNamingDecisionSchema } from "./types"
import type { DynamicNamingDecision, DynamicNamingDecisionProvider, DynamicNamingEvaluationInput } from "./types"

const SYSTEM_PROMPT = `Evaluate whether a conversation title should be deferred, kept, or renamed.

Return one structured action:
- defer: only when checkpoint 1 is not forced and the context does not identify a useful subject.
- keep: the current title remains materially accurate and specific enough.
- rename: provide a concise 2-5 word title when the current title is absent, inaccurate, or materially less specific than the conversation now supports.

Rules:
- Preserve a good current title. Keep it when it still names the same subject, even if later messages add symptoms, causes, or implementation details. Rename for specificity only when the old title would materially mislead someone about the conversation's main subject; never for stylistic preference or a tighter synonym.
- Name the subject directly; never add framing such as "Discussion about" or describe the language or tone.
- Use the dominant language and wording of the participants. Preserve names, products, and technical terms exactly.
- Use attachments and linked-page context when they establish the subject.
- Avoid recent sibling titles when a more specific accurate title is available.
- A forced evaluation must return keep or rename, never defer.
- Always return the title field. rename requires a non-empty title of at most 100 characters; keep and defer set title to an empty string.`

export class DynamicNamingEvaluator implements DynamicNamingDecisionProvider {
  constructor(
    private readonly ai: AI,
    private readonly configResolver: ConfigResolver
  ) {}

  async decide(input: DynamicNamingEvaluationInput, signal: AbortSignal): Promise<DynamicNamingDecision> {
    const config = await this.configResolver.resolve(COMPONENT_PATHS.STREAM_NAMING)
    const { value } = await this.ai.generateObject({
      model: config.modelId,
      schema: DynamicNamingDecisionResponseSchema,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `${JSON.stringify({
            checkpoint: input.checkpoint,
            forced: input.forced,
            currentTitle: input.currentTitle,
            messageCount: input.messageCount,
            recentSiblingTitles: input.existingTitles,
          })}\n\n${input.context}`,
        },
      ],
      temperature: config.temperature,
      abortSignal: signal,
      telemetry: {
        functionId: "dynamic-naming-evaluate",
        metadata: {
          targetKind: input.targetKind,
          checkpoint: input.checkpoint,
          forced: input.forced,
          hasCurrentTitle: input.currentTitle !== null,
          existingTitleCount: input.existingTitles.length,
        },
      },
      context: { workspaceId: input.workspaceId, origin: "system" },
    })
    const decision = DynamicNamingDecisionSchema.parse(value.action === "rename" ? value : { action: value.action })
    if (input.forced && decision.action === "defer") {
      throw new Error("Dynamic naming evaluator deferred a forced checkpoint")
    }
    if (input.currentTitle === null && decision.action === "keep") {
      throw new Error("Dynamic naming evaluator kept a missing title")
    }
    return decision
  }
}

export class StubDynamicNamingEvaluator implements DynamicNamingDecisionProvider {
  async decide(input: DynamicNamingEvaluationInput): Promise<DynamicNamingDecision> {
    if (input.currentTitle) return { action: "keep" }
    if (!input.forced) return { action: "defer" }
    return { action: "rename", title: "Untitled conversation" }
  }
}
