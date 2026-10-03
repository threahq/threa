import { describe, expect, test } from "bun:test"
import { AgentToolNames } from "@threahq/types"
import { buildHowIWorkSection, type SelfKnowledge } from "./how-i-work"

const ariadne = {
  name: "Ariadne",
  model: "openrouter:openai/gpt-6-luna",
  escalationModel: "openrouter:openai/gpt-5.6-terra",
  enabledTools: [
    AgentToolNames.WEB_SEARCH,
    AgentToolNames.READ_URL,
    AgentToolNames.SCHEDULE_FOLLOW_UP,
    AgentToolNames.UPDATE_USER_SETTINGS,
  ],
}

const privateScratchpad: SelfKnowledge = { access: "user_full_access", memoryCapture: "on", sealed: false }

/** The card's bullet list, which is the part that varies by tool and context. */
function capabilities(card: string): string[] {
  return card
    .split("What you can do:\n")[1]!
    .split("\n\n")[0]!
    .split("\n")
    .map((line) => line.replace(/^- /, ""))
}

describe("buildHowIWorkSection", () => {
  test("should list workspace research and each enabled tool group when the user is alone in a private scratchpad", () => {
    const card = buildHowIWorkSection(ariadne, privateScratchpad)

    expect(capabilities(card)).toEqual([
      "Research the workspace: messages, memos and files within the reach described above.",
      "Search the web and read web pages.",
      "Schedule a follow-up: come back to this conversation at a set time and pick up where it left off.",
      "Change the user's own settings (theme, date and time format, timezone, language, notifications, working hours), only in their own scratchpad and only when they ask.",
    ])
    expect(card).toContain("including memories private to them")
    expect(card).toContain("Harder turns may be escalated to `openrouter:openai/gpt-5.6-terra`")
    expect(card).toContain("Memory capture is on here")
  })

  test("should keep only the enclave's web tools and say nothing leaves the scratchpad when sealed", () => {
    const card = buildHowIWorkSection(ariadne, { access: null, memoryCapture: "off", sealed: true })

    expect(capabilities(card)).toEqual(["Search the web and read web pages."])
    expect(card).toContain("end-to-end-encrypted scratchpad")
    expect(card).toContain("the server can't read it")
  })

  test("should drop workspace research when no one triggered the turn", () => {
    const card = buildHowIWorkSection({ ...ariadne, enabledTools: [] }, { ...privateScratchpad, access: null })

    expect(capabilities(card)).toEqual(["Nothing beyond replying in this conversation."])
    expect(card).toContain("No one triggered this turn")
  })

  test("should say private conversations stay out when the channel is public", () => {
    const card = buildHowIWorkSection(ariadne, { access: "public_only", memoryCapture: "off", sealed: false })

    expect(card).toContain("You never pull anyone's private conversations in here")
    expect(card).toContain("Memory capture is off here")
  })

  test("should treat a null tool list as every tool enabled", () => {
    const card = buildHowIWorkSection({ ...ariadne, enabledTools: null }, privateScratchpad)

    expect(card).toContain("Read Linear issues and projects")
    expect(card).toContain("Read GitHub repositories")
  })
})
