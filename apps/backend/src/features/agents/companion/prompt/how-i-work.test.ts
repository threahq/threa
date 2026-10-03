import { describe, expect, test } from "bun:test"
import { AgentToolNames } from "@threahq/types"
import { WORKSPACE_RESEARCH_TOOL_NAME } from "../../tools"
import { buildHowIWorkSection, type SelfKnowledge } from "./how-i-work"

const ariadne = {
  name: "Ariadne",
  model: "openrouter:openai/gpt-6-luna",
  escalationModel: "openrouter:openai/gpt-5.6-terra",
}

const privateScratchpad: SelfKnowledge = {
  sealed: false,
  access: "user_full_access",
  memoryCapture: "on",
  subagentModel: null,
}

/** The card's bullet list, which is the part that varies by tool and context. */
function capabilities(card: string): string[] {
  return card
    .split("What you can do:\n")[1]!
    .split("\n\n")[0]!
    .split("\n")
    .map((line) => line.replace(/^- /, ""))
}

describe("buildHowIWorkSection", () => {
  test("should list one line per capability among the tools wired this turn", () => {
    const card = buildHowIWorkSection(ariadne, privateScratchpad, [
      WORKSPACE_RESEARCH_TOOL_NAME,
      AgentToolNames.WEB_SEARCH,
      AgentToolNames.READ_URL,
      AgentToolNames.SCHEDULE_FOLLOW_UP,
      AgentToolNames.LIST_FOLLOW_UPS,
      AgentToolNames.UPDATE_USER_SETTINGS,
    ])

    expect(capabilities(card)).toEqual([
      "Research the workspace: messages, memos and files within the reach described above.",
      "Search the web and read web pages.",
      "Schedule a follow-up: come back to this conversation at a set time and pick up where it left off.",
      "Change the user's own settings (theme, date and time format, timezone, language, notifications, working hours) when they ask.",
    ])
    expect(card).toContain("including memories private to them")
    expect(card).toContain("Harder turns may be escalated to `openrouter:openai/gpt-5.6-terra`")
    expect(card).toContain("Memory capture is on here")
  })

  test("should give every agent tool a capability line except replying and reporting back", () => {
    const toolsWithoutLine = Object.values(AgentToolNames).filter((tool) =>
      capabilities(buildHowIWorkSection(ariadne, privateScratchpad, [tool]))[0]!.startsWith("Nothing")
    )

    expect(toolsWithoutLine).toEqual([AgentToolNames.SEND_MESSAGE, AgentToolNames.REPORT_BACK])
  })

  test("should say nothing beyond replying when no tools are wired", () => {
    const card = buildHowIWorkSection(ariadne, { ...privateScratchpad, access: null }, [])

    expect(capabilities(card)).toEqual(["Nothing beyond replying in this conversation."])
    expect(card).toContain("No one triggered this turn")
  })

  test("should name the delegated model and drop escalation inside a subagent thread", () => {
    const card = buildHowIWorkSection(
      ariadne,
      { ...privateScratchpad, subagentModel: "openrouter:anthropic/claude-opus-5-5" },
      []
    )

    expect(card).toContain("In this thread you run on `openrouter:anthropic/claude-opus-5-5`")
    expect(card).not.toContain("escalated")
  })

  test("should defer to the enclave's tools, drop escalation and mention no memos when sealed", () => {
    const card = buildHowIWorkSection(ariadne, { sealed: true }, [])

    expect(capabilities(card)).toEqual([
      "At most: search the web, read web pages, research the web, and read files shared in this scratchpad. Only the tools described further down are available this turn.",
    ])
    expect(card).toContain("end-to-end-encrypted scratchpad")
    expect(card).toContain(
      "Memory: Nothing said here becomes a memo, because the server can't read it. Between conversations you remember only through summaries of your earlier sessions in this stream."
    )
    expect(card).not.toContain("escalated")
  })

  test("should say private conversations stay out when the channel is public", () => {
    const card = buildHowIWorkSection(
      ariadne,
      { ...privateScratchpad, access: "public_only", memoryCapture: "off" },
      []
    )

    expect(card).toContain("You never pull anyone's private conversations in here")
    expect(card).toContain("Memory capture is off here")
  })
})
