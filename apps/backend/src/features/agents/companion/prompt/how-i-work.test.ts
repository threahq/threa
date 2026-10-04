import { describe, expect, test } from "bun:test"
import { AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threahq/types"
import { WORKSPACE_RESEARCH_TOOL_NAME } from "../../tools"
import { buildHowIWorkSection, WORKSPACE_REACH_TOOLS, type SelfKnowledge } from "./how-i-work"

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
      "Research the workspace: messages, memos and files, within the reach described above.",
      "Search the web and read web pages.",
      "Schedule a follow-up: come back to this conversation at a set time and pick up where it left off.",
      "List scheduled follow-ups.",
      "Change the user's own settings (theme, date and time format, timezone, language, notifications, working hours) when they ask.",
    ])
    expect(card).toContain("including memories private to them")
    expect(card).toContain("Threa may rerun a reply that fails its checks on `openrouter:openai/gpt-5.6-terra`")
    expect(card).toContain("Memory capture is on here")
  })

  test("should say the device the user shares is part of what it sees", () => {
    const card = buildHowIWorkSection(ariadne, privateScratchpad, [])

    expect(card).toContain("and, if the user shares it, which layout and device they're using. You don't watch")
  })

  test("should give every agent tool a capability line except replying and reporting back", () => {
    const toolsWithoutLine = Object.values(AgentToolNames).filter((tool) =>
      capabilities(buildHowIWorkSection(ariadne, privateScratchpad, [tool]))[0]!.startsWith("Nothing")
    )

    expect(toolsWithoutLine).toEqual([AgentToolNames.SEND_MESSAGE, AgentToolNames.REPORT_BACK])
  })

  test("should claim only the wired half of a capability when a persona enables part of it", () => {
    const card = buildHowIWorkSection(ariadne, privateScratchpad, [
      AgentToolNames.READ_URL,
      AgentToolNames.SEARCH_USERS,
      AgentToolNames.CANCEL_FOLLOW_UP,
      AgentToolNames.GITHUB_PULLS,
      AgentToolNames.GITHUB_ISSUES,
    ])

    expect(capabilities(card)).toEqual([
      "Read web pages.",
      "Find people in the workspace.",
      "Cancel scheduled follow-ups.",
      "Read GitHub pull requests and issues. Read-only.",
    ])
  })

  test("should claim no workspace reach when no wired tool reads beyond the conversation", () => {
    const card = buildHowIWorkSection(ariadne, privateScratchpad, [AgentToolNames.WEB_SEARCH])

    expect(card).toContain("What you reach: None of your tools here read beyond this conversation")
    expect(card).not.toContain("including memories private to them")
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
    expect(card).not.toContain("Your model, tools")
    expect(card).not.toContain("may rerun")
  })

  test("should defer to the enclave's tools, drop escalation and mention no memos when sealed", () => {
    const card = buildHowIWorkSection(ariadne, { sealed: true }, [])

    expect(capabilities(card)).toEqual([
      "At most: search the web, read web pages, research the web, and read files shared in this scratchpad. Only the tools described further down are available this turn.",
    ])
    expect(card).toContain("end-to-end-encrypted scratchpad")
    expect(card).toContain(
      "What you see: the messages in this conversation and the files people share in it, nothing more. You don't watch"
    )
    expect(card).toContain(
      "Memory: Nothing said here becomes a memo, because the server can't read it. Between conversations you remember only through summaries of your earlier sessions in this stream."
    )
    expect(card).not.toContain("may rerun")
  })

  test("should say private conversations stay out when the channel is public", () => {
    const card = buildHowIWorkSection(ariadne, { ...privateScratchpad, access: "public_only", memoryCapture: "off" }, [
      AgentToolNames.SEARCH_MESSAGES,
    ])

    expect(card).toContain("You never pull anyone's private conversations in here")
    expect(card).toContain("Memory capture is off here")
  })

  test("should say messages stay searchable without a memo only when a message search tool is wired", () => {
    const searchable = (toolNames: string[]) =>
      buildHowIWorkSection(ariadne, privateScratchpad, toolNames).includes("every message stays searchable")

    expect({
      searchMessages: searchable([AgentToolNames.SEARCH_MESSAGES]),
      webSearch: searchable([AgentToolNames.WEB_SEARCH]),
    }).toEqual({ searchMessages: true, webSearch: false })
  })

  test("should count general_research as workspace search only when the policy left a workspace tool", () => {
    const fullPolicy = buildHowIWorkSection(ariadne, privateScratchpad, [
      AgentToolNames.GENERAL_RESEARCH,
      AgentToolNames.DESCRIBE_MEMO,
    ])
    const webOnly = buildHowIWorkSection(ariadne, privateScratchpad, [
      AgentToolNames.WEB_SEARCH,
      AgentToolNames.GENERAL_RESEARCH,
    ])

    expect({
      fullPolicy: {
        research: capabilities(fullPolicy)[0],
        reachesWorkspace: fullPolicy.includes("including memories private to them"),
        searchable: fullPolicy.includes("every message stays searchable"),
      },
      webOnly: {
        research: capabilities(webOnly)[1],
        reachesWorkspace: webOnly.includes("including memories private to them"),
        searchable: webOnly.includes("every message stays searchable"),
      },
    }).toEqual({
      fullPolicy: {
        research: "Run deeper research that combines the workspace, the web and connected integrations.",
        reachesWorkspace: true,
        searchable: true,
      },
      webOnly: { research: "Run deeper research on the web.", reachesWorkspace: false, searchable: false },
    })
  })

  test("should offer saving a memo only when save_memo is wired", () => {
    const capture = (toolNames: string[]) =>
      buildHowIWorkSection(ariadne, { ...privateScratchpad, memoryCapture: "off" }, toolNames)
        .split("Memory: ")[1]!
        .split(". ")[0]

    expect({
      withSave: capture([AgentToolNames.SAVE_MEMO]),
      withoutSave: capture([]),
    }).toEqual({
      withSave:
        "Memory capture is off here, so nothing from this conversation becomes a memo unless someone asks you to save one",
      withoutSave: "Memory capture is off here, so nothing from this conversation becomes a memo",
    })
  })

  test("should claim no memo recall on an untriggered turn", () => {
    const card = buildHowIWorkSection(ariadne, { ...privateScratchpad, access: null }, [AgentToolNames.SEARCH_MESSAGES])

    expect(card).toContain("you remember only through summaries of your earlier sessions")
  })

  test("should treat every workspace read tool as reaching beyond the conversation", () => {
    // Workspace-category tools that write, run code or look up people rather than read conversations.
    const notConversationReads = new Set<string>([
      AgentToolNames.SAVE_MEMO,
      AgentToolNames.UPDATE_USER_SETTINGS,
      AgentToolNames.RUN_COMMAND,
      AgentToolNames.SEARCH_USERS,
    ])
    const workspaceReads = Object.entries(TOOL_CATEGORIES_BY_NAME)
      .filter(
        ([tool, categories]) =>
          (categories as readonly string[]).includes("workspace") && !notConversationReads.has(tool)
      )
      .map(([tool]) => tool)

    expect(workspaceReads.filter((tool) => !WORKSPACE_REACH_TOOLS.has(tool))).toEqual([])
  })
})
