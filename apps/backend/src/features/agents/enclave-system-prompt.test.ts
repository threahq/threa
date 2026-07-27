import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes } from "@threa/types"
import * as contextBuilder from "./context-builder"
import * as systemPrompt from "./companion/prompt/system-prompt"
import { buildEnclaveSystemPrompt } from "./enclave-system-prompt"
import { TONE_PRESET_FRAGMENTS, BREVITY_PRESET_FRAGMENTS } from "./companion/config"
import type { Stream } from "../streams"
import type { BuiltInAgentConfig } from "./built-in-agents"

afterEach(() => mock.restore())

const STREAM = { id: "stream_1", workspaceId: "ws_1", type: "scratchpad" } as Stream
const PERSONA = { id: "ariadne", name: "Ariadne", systemPrompt: "You are Ariadne." } as BuiltInAgentConfig
const PREFS = { scratchpadCustomPrompt: null } as never

describe("buildEnclaveSystemPrompt", () => {
  it("appends the encrypted-scratchpad limits clause after the shared prompt (UX-7)", async () => {
    spyOn(contextBuilder, "buildStreamContext").mockResolvedValue({} as never)
    spyOn(systemPrompt, "buildSystemPrompt").mockReturnValue({ stable: "BASE_PROMPT", volatile: "_BODY" })

    const result = await buildEnclaveSystemPrompt({
      pool: {} as Pool,
      stream: STREAM,
      preferences: PREFS,
      persona: PERSONA,
    })

    // The shared prompt is preserved verbatim and leads — the enclave receives
    // it rejoined, so the split never reaches the encrypted wire.
    expect(result.startsWith("BASE_PROMPT_BODY")).toBe(true)
    // …followed by the limits section that names the boundary and the guidance.
    expect(result).toContain("## Encrypted scratchpad limits")
    expect(result).toContain("workspace memory (GAM)")
    expect(result).toMatch(/do not guess or invent/i)
  })

  it("builds the prompt with NO tool sections — the enclave appends them from its real toolset", async () => {
    spyOn(contextBuilder, "buildStreamContext").mockResolvedValue({} as never)
    const build = spyOn(systemPrompt, "buildSystemPrompt").mockReturnValue({ stable: "BASE", volatile: "" })

    await buildEnclaveSystemPrompt({ pool: {} as Pool, stream: STREAM, preferences: PREFS, persona: PERSONA })

    const [, , , , , rollingSummary, tools] = build.mock.calls[0]!
    expect(rollingSummary).toBeNull() // no plaintext history to summarize
    expect(tools).toEqual([]) // tool prose is assembled in-enclave (run-turn)
  })

  it("carries the persona's tone/brevity preset fragments into the prompt (enclave parity)", async () => {
    // Real buildSystemPrompt this time — the enclave must resolve style slots
    // server-side and pass them, or the encrypted turn diverges from the
    // in-process companion's response style.
    spyOn(contextBuilder, "buildStreamContext").mockResolvedValue({
      streamType: StreamTypes.SCRATCHPAD,
      streamInfo: { id: "stream_1", name: "Notes", description: null, slug: null },
      conversationHistory: [],
    } as never)

    const persona = {
      id: "ariadne",
      name: "Ariadne",
      systemPrompt: "You are Ariadne.",
      tonePreset: "direct",
      brevityPreset: "thorough",
      tonePrompt: null,
      brevityPrompt: null,
    } as BuiltInAgentConfig

    const result = await buildEnclaveSystemPrompt({ pool: {} as Pool, stream: STREAM, preferences: PREFS, persona })

    expect(result).toContain(
      `## Response Style\n\n${BREVITY_PRESET_FRAGMENTS.thorough} ${TONE_PRESET_FRAGMENTS.direct}`
    )
  })
})
