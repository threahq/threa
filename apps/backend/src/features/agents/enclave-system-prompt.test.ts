import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import * as contextBuilder from "./context-builder"
import * as systemPrompt from "./companion/prompt/system-prompt"
import { buildEnclaveSystemPrompt } from "./enclave-system-prompt"
import type { Stream } from "../streams"
import type { BuiltInAgentConfig } from "./built-in-agents"

afterEach(() => mock.restore())

const STREAM = { id: "stream_1", workspaceId: "ws_1", type: "scratchpad" } as Stream
const PERSONA = { id: "ariadne", name: "Ariadne", systemPrompt: "You are Ariadne." } as BuiltInAgentConfig
const PREFS = { scratchpadCustomPrompt: null } as never

describe("buildEnclaveSystemPrompt", () => {
  it("appends the encrypted-scratchpad limits clause after the shared prompt (UX-7)", async () => {
    spyOn(contextBuilder, "buildStreamContext").mockResolvedValue({} as never)
    spyOn(systemPrompt, "buildSystemPrompt").mockReturnValue("BASE_PROMPT_BODY")

    const result = await buildEnclaveSystemPrompt({
      pool: {} as Pool,
      stream: STREAM,
      preferences: PREFS,
      persona: PERSONA,
    })

    // The shared prompt is preserved verbatim and leads…
    expect(result.startsWith("BASE_PROMPT_BODY")).toBe(true)
    // …followed by the limits section that names the boundary and the guidance.
    expect(result).toContain("## Encrypted scratchpad limits")
    expect(result).toContain("workspace memory (GAM)")
    expect(result).toMatch(/do not guess or invent/i)
  })

  it("builds the prompt with the enclave-reduced toolset and workspace_research disabled", async () => {
    spyOn(contextBuilder, "buildStreamContext").mockResolvedValue({} as never)
    const build = spyOn(systemPrompt, "buildSystemPrompt").mockReturnValue("BASE")

    await buildEnclaveSystemPrompt({ pool: {} as Pool, stream: STREAM, preferences: PREFS, persona: PERSONA })

    const [personaArg, , , , , rollingSummary, workspaceResearch] = build.mock.calls[0]!
    expect((personaArg as { enabledTools: string[] }).enabledTools).toEqual([
      "web_search",
      "read_url",
      "general_research",
      "load_attachment",
    ])
    expect(rollingSummary).toBeNull() // no plaintext history to summarize
    expect(workspaceResearch).toBe(false) // no DB in the enclave
  })
})
