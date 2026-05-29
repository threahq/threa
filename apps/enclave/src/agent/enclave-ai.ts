import type { AgentRuntimeAI } from "@threa/agent-runtime/runtime"
import type { RawChatFn } from "../llm"
import { buildAssistantMessage, toOpenAiMessages, toOpenAiTools } from "./openai-format"

/**
 * The enclave's `AgentRuntimeAI`: the single method the agent loop calls,
 * implemented over the raw OpenRouter transport. It speaks the AI SDK's
 * `ModelMessage`/`Tool` shapes on the loop side and OpenAI chat-completions on
 * the wire, summing token usage across the turn's calls into a caller-owned
 * accumulator (the `GenerateTextWithToolsResult` shape carries no usage field,
 * and a turn makes several calls).
 */

export interface UsageAccumulator {
  promptTokens: number
  completionTokens: number
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function createEnclaveAI(rawChat: RawChatFn, usage: UsageAccumulator): AgentRuntimeAI {
  return {
    async generateTextWithTools(options) {
      const result = await rawChat({
        // The loop resolves the model once and passes it as `modelString`; the
        // opaque `model` object is only meaningful to the SDK provider we don't use.
        model: options.modelString ?? String(options.model),
        messages: toOpenAiMessages(options.system, options.messages),
        tools: toOpenAiTools(options.tools),
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      })

      usage.promptTokens += result.usage?.prompt_tokens ?? 0
      usage.completionTokens += result.usage?.completion_tokens ?? 0

      const toolCalls = (result.message.tool_calls ?? []).map((tc) => ({
        toolCallId: tc.id,
        toolName: tc.function.name,
        input: parseArguments(tc.function.arguments),
      }))
      const text = result.message.content ?? ""

      return { text, toolCalls, response: { messages: [buildAssistantMessage(text, toolCalls)] } }
    },
  }
}
