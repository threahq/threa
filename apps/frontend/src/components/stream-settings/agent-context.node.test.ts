import { describe, expect, it } from "vitest"
import { StreamTypes } from "@threahq/types"
import { briefSharedWith, describeAgentContext, type AgentContextInput } from "./agent-context"

const base: AgentContextInput = {
  agent: { id: "persona_shared", model: "openrouter:anthropic/claude-sonnet-5", instructions: null, personal: false },
  e2e: false,
  isAdmin: false,
  deviceSharing: true,
}

function rows(input: Partial<AgentContextInput>) {
  return describeAgentContext({ ...base, ...input }).map(({ id, value, editedBy, link, detail, prose }) => ({
    id,
    value,
    editedBy,
    link,
    ...(detail === undefined ? {} : { detail }),
    ...(prose ? { prose } : {}),
  }))
}

describe("describeAgentContext", () => {
  it("shows a channel's agent model and instructions, brief and device, read-only for non-admins", () => {
    expect(
      rows({
        agent: {
          id: "persona_shared",
          model: "openrouter:anthropic/claude-sonnet-5",
          instructions: "\n**Be kind.**\nCite sources.",
          personal: false,
        },
        brief: { content: "## Goals\nShip the **launch**", loading: false, sharedWith: null },
      })
    ).toEqual([
      { id: "model", value: "Claude Sonnet 5", editedBy: "Edited by workspace admins", link: null },
      {
        id: "agent-instructions",
        value: "4 words",
        editedBy: "Edited by workspace admins",
        link: null,
        detail: "**Be kind.**\nCite sources.",
      },
      {
        id: "brief",
        value: "Goals Ship the launch",
        editedBy: "Edited by members",
        link: { streamSetting: "stream-brief" },
        prose: true,
      },
      {
        id: "device",
        value: "Layout, system and open docs",
        editedBy: "Edited by you",
        link: { setting: "device-sharing" },
      },
    ])
  })

  it("links admins and the owner of a personal agent straight to that agent's editor", () => {
    expect(rows({ isAdmin: true }).slice(0, 2)).toEqual([
      {
        id: "model",
        value: "Claude Sonnet 5",
        editedBy: "Edited by workspace admins",
        link: { persona: "persona_shared" },
      },
      {
        id: "agent-instructions",
        value: "None",
        editedBy: "Edited by workspace admins",
        link: { persona: "persona_shared" },
      },
    ])
    expect(
      rows({
        agent: { id: "persona_mine", model: "openrouter:openai/gpt-5", instructions: "Coach me.", personal: true },
      }).slice(0, 2)
    ).toEqual([
      { id: "model", value: "GPT-5", editedBy: "Edited by you", link: { persona: "persona_mine" } },
      {
        id: "agent-instructions",
        value: "2 words",
        editedBy: "Edited by you",
        link: { persona: "persona_mine" },
        detail: "Coach me.",
      },
    ])
  })

  it("adds a scratchpad's instructions and tools, linking tools only for the owner", () => {
    const scratchpad = rows({
      instructions: "\n**Answer** in bullet points.\nBe brief.",
      tools: { policy: ["web", "github"], viewerIsOwner: false },
      deviceSharing: false,
    })
    expect(scratchpad.filter((row) => row.id !== "model" && row.id !== "agent-instructions")).toEqual([
      {
        id: "instructions",
        value: "Answer in bullet points. Be brief.",
        editedBy: "Edited by you",
        link: { setting: "ai-instructions" },
        prose: true,
      },
      { id: "tools", value: "Web, GitHub", editedBy: "Edited by the owner", link: null },
      { id: "device", value: "Not shared", editedBy: "Edited by you", link: { setting: "device-sharing" } },
    ])
    expect(rows({ tools: { policy: null, viewerIsOwner: true } }).find((row) => row.id === "tools")).toEqual({
      id: "tools",
      value: "All tools",
      editedBy: "Edited by you",
      link: { streamSetting: "stream-tools" },
    })
    expect(rows({ tools: { policy: [], viewerIsOwner: true } }).find((row) => row.id === "tools")?.value).toBe(
      "Replies only"
    )
  })

  it("says None for empty instructions and brief, and names who a thread's brief is shared with", () => {
    const thread = rows({ instructions: "  ", brief: { content: null, loading: false, sharedWith: "#general" } })
    expect(thread.find((row) => row.id === "instructions")?.value).toBe("None")
    expect(thread.find((row) => row.id === "brief")).toMatchObject({
      value: "None",
      editedBy: "Edited by members, shared with #general",
    })
  })

  it("cuts long text at a word boundary, dropping the punctuation before the ellipsis", () => {
    const long = "Always answer as a careful, meticulous senior engineer who cites the file, then stops there."
    const value = rows({ instructions: long }).find((row) => row.id === "instructions")?.value
    expect(value).toBe("Always answer as a careful, meticulous senior engineer who cites the file…")
    expect(value?.length).toBeLessThanOrEqual(80)
  })

  it("keeps empty and loading values short, beside the label", () => {
    const thread = rows({ instructions: null, brief: { content: null, loading: true, sharedWith: null } })
    expect(thread.filter((row) => row.prose).map((row) => row.id)).toEqual([])
  })

  it("names a thread's parent channel, or the kind of parent when it isn't one", () => {
    expect([
      briefSharedWith({ type: StreamTypes.CHANNEL, slug: "general" }),
      briefSharedWith({ type: StreamTypes.SCRATCHPAD, slug: null }),
      briefSharedWith({ type: StreamTypes.DM }),
      briefSharedWith(null),
    ]).toEqual(["#general", "the parent scratchpad", "the parent DM", "the parent stream"])
  })

  it("keeps an encrypted scratchpad to Ariadne and your instructions, which is all the enclave gets", () => {
    expect(
      rows({
        e2e: true,
        instructions: "Be brief.",
        brief: { content: "Goals", loading: false, sharedWith: null },
      }).map((row) => [row.id, row.value])
    ).toEqual([
      ["agent", "Ariadne"],
      ["instructions", "Be brief."],
    ])
  })

  it("counts words in any script, one for a single word", () => {
    const value = (instructions: string) =>
      rows({ agent: { ...base.agent!, instructions } }).find((row) => row.id === "agent-instructions")?.value
    expect([value("Hi."), value("日本語で答えてください")]).toEqual(["1 word", expect.stringMatching(/^[2-9] words$/)])
  })

  it("leaves the agent out until the roster has loaded", () => {
    expect(rows({ agent: null }).map((row) => row.id)).toEqual(["device"])
  })
})
