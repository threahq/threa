import { describe, expect, it } from "vitest"
import type { AgentRuntimeAI } from "@threa/agent-runtime/runtime"
import type { LanguageModel } from "ai"
import { buildEnclaveTools } from "./tools"

const ai = {
  generateTextWithTools: async () => ({ text: "", toolCalls: [], response: { messages: [] } }),
} as AgentRuntimeAI
const model = {} as LanguageModel

function toolNames(tavilyApiKey?: string): string[] {
  return buildEnclaveTools({ ai, model, modelString: "anthropic/claude-sonnet-4.6", tavilyApiKey }).map((t) => t.name)
}

describe("buildEnclaveTools", () => {
  it("exposes web_search, read_url, and general_research when a Tavily key is present", () => {
    const names = toolNames("tvly-test")
    expect(names).toContain("web_search")
    expect(names).toContain("read_url")
    expect(names).toContain("general_research")
  })

  it("omits web_search but keeps read_url + general_research without a Tavily key", () => {
    const names = toolNames(undefined)
    expect(names).not.toContain("web_search")
    expect(names).toContain("read_url")
    expect(names).toContain("general_research")
  })
})
