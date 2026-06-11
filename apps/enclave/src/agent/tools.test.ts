import { describe, expect, it } from "vitest"
import type { AgentRuntimeAI } from "@threa/agent-runtime/runtime"
import type { ToolPrivacyCategory } from "@threa/types"
import type { LanguageModel } from "ai"
import { buildEnclaveTools } from "./tools"

const ai = {
  generateTextWithTools: async () => ({ text: "", toolCalls: [], response: { messages: [] } }),
} as AgentRuntimeAI
const model = {} as LanguageModel

function toolNames(tavilyApiKey?: string, allowedCategories?: ToolPrivacyCategory[]): string[] {
  return buildEnclaveTools({
    ai,
    model,
    modelString: "anthropic/claude-sonnet-4.6",
    tavilyApiKey,
    allowedCategories,
  }).map((t) => t.name)
}

describe("buildEnclaveTools", () => {
  it("exposes web_search, read_url, and general_research when a Tavily key is present", () => {
    expect(new Set(toolNames("tvly-test"))).toEqual(new Set(["web_search", "read_url", "general_research"]))
  })

  it("omits web_search but keeps read_url + general_research without a Tavily key", () => {
    expect(new Set(toolNames(undefined))).toEqual(new Set(["read_url", "general_research"]))
  })

  it("builds the full web surface when the policy allows web", () => {
    expect(new Set(toolNames("tvly-test", ["web"]))).toEqual(new Set(["web_search", "read_url", "general_research"]))
  })

  it("builds no tools when the policy forbids web (every enclave tool is web egress)", () => {
    // Empty policy → no tools at all; a workspace-only policy → still no tools,
    // since the enclave has no workspace tools to offer yet.
    expect(toolNames("tvly-test", [])).toEqual([])
    expect(toolNames("tvly-test", ["workspace"])).toEqual([])
  })

  it("keeps the conversation-local load_attachment under a no-web policy (empty categories)", () => {
    const tools = buildEnclaveTools({
      ai,
      model,
      modelString: "anthropic/claude-sonnet-4.6",
      tavilyApiKey: "tvly-test",
      allowedCategories: [],
      attachments: { refsById: new Map(), ciphertextById: new Map() },
    })
    expect(tools.map((t) => t.name)).toEqual(["load_attachment"])
  })

  it("advertises web-only research reach — never workspace or integrations", () => {
    const research = buildEnclaveTools({ ai, model, modelString: "anthropic/claude-sonnet-4.6" }).find(
      (t) => t.name === "general_research"
    )
    expect(research).toBeDefined()
    const advertised = `${research!.config.description}\n${research!.config.promptBlock}`
    expect(advertised).not.toMatch(/workspace|GitHub|Linear/)
  })
})
