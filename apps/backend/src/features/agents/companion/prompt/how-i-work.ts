import { AgentToolNames, type AgentToolName } from "@threahq/types"
import type { AgentAccessSpec } from "../../researcher/access-spec"
import { WORKSPACE_RESEARCH_TOOL_NAME } from "../../tools/workspace-research-tool"

/** Conversation-stable inputs of the card, so it can sit in the cached half of the prompt. */
export type SelfKnowledge =
  /** End-to-end-encrypted scratchpad: the enclave runs the turn and owns its toolset. */
  | { sealed: true }
  | {
      sealed: false
      /** `null` when no human triggered the turn, so there is no one's access to borrow. */
      access: AgentAccessSpec["type"] | null
      memoryCapture: "on" | "off"
      /** The model a person delegated this thread to, when the turn runs inside a subagent thread. */
      subagentModel: string | null
    }

interface CardPersona {
  name: string
  model: string
  escalationModel: string | null
}

type CardToolName = AgentToolName | typeof WORKSPACE_RESEARCH_TOOL_NAME

const CAPABILITIES: Array<{ tools: CardToolName[]; line: string }> = [
  {
    tools: [WORKSPACE_RESEARCH_TOOL_NAME],
    line: "Research the workspace: messages, memos and files within the reach described above.",
  },
  { tools: [AgentToolNames.WEB_SEARCH, AgentToolNames.READ_URL], line: "Search the web and read web pages." },
  {
    tools: [AgentToolNames.GENERAL_RESEARCH],
    line: "Run deeper research that combines the workspace, the web and connected integrations.",
  },
  {
    tools: [
      AgentToolNames.SEARCH_MESSAGES,
      AgentToolNames.SEARCH_STREAMS,
      AgentToolNames.SEARCH_USERS,
      AgentToolNames.GET_STREAM_MESSAGES,
    ],
    line: "Search messages, streams and people, and read a stream's history, within the reach described above.",
  },
  {
    tools: [AgentToolNames.SEARCH_ATTACHMENTS, AgentToolNames.READ_ATTACHMENT],
    line: "Find and read files shared in the workspace: documents, PDFs, spreadsheets and images.",
  },
  {
    tools: [AgentToolNames.RUN_COMMAND],
    line: "Run code and shell commands in a sandbox tied to this stream.",
  },
  { tools: [AgentToolNames.DESCRIBE_MEMO], line: "Open memos to see their sources." },
  { tools: [AgentToolNames.SAVE_MEMO], line: "Save something to memory when someone asks." },
  { tools: [AgentToolNames.REACT_TO_MESSAGE], line: "React to messages with an emoji." },
  {
    tools: [
      AgentToolNames.SCHEDULE_FOLLOW_UP,
      AgentToolNames.LIST_FOLLOW_UPS,
      AgentToolNames.CANCEL_FOLLOW_UP,
      AgentToolNames.UPDATE_FOLLOW_UP,
    ],
    line: "Schedule a follow-up: come back to this conversation at a set time and pick up where it left off.",
  },
  { tools: [AgentToolNames.UPDATE_STREAM_BRIEF], line: "Keep this stream's brief up to date." },
  {
    tools: [AgentToolNames.START_SUBAGENT],
    line: "Hand a question to another model, which answers in a thread under a card in this stream, when a person asks for a second opinion or names a model.",
  },
  {
    tools: [AgentToolNames.DELEGATE_TASK],
    line: "Hand a longer task to the user's own local agent (for example a coding agent on their machine), which reports back here, when a person asked for the work.",
  },
  {
    tools: [AgentToolNames.UPDATE_USER_SETTINGS],
    line: "Change the user's own settings (theme, date and time format, timezone, language, notifications, working hours) when they ask.",
  },
  {
    tools: [
      AgentToolNames.GITHUB_REPOS,
      AgentToolNames.GITHUB_COMMITS,
      AgentToolNames.GITHUB_PULLS,
      AgentToolNames.GITHUB_CONTENT,
      AgentToolNames.GITHUB_WORKFLOWS,
      AgentToolNames.GITHUB_RELEASES,
      AgentToolNames.GITHUB_ISSUES,
    ],
    line: "Read GitHub repositories, commits, pull requests, issues, workflows and releases. Read-only.",
  },
  {
    tools: [
      AgentToolNames.LINEAR_LIST_ISSUES,
      AgentToolNames.LINEAR_GET_ISSUE,
      AgentToolNames.LINEAR_LIST_PROJECTS,
      AgentToolNames.LINEAR_GET_PROJECT,
    ],
    line: "Read Linear issues and projects. Read-only.",
  },
]

const REACH: Record<AgentAccessSpec["type"], string> = {
  user_full_access:
    "This is the user's own private space, so you can reach everything they can: their channels, DMs, scratchpads, files and memory, including memories private to them.",
  public_plus_stream:
    "Others can read this conversation, so you reach only this conversation (and its threads), public channels, and the memory built from them. You never pull anyone's private conversations in here, even ones the person asking can see.",
  public_only:
    "This conversation is public, so you reach only public channels and the memory built from them. You never pull anyone's private conversations in here, even ones the person asking can see.",
  user_intersection:
    "In a DM you reach only what both people in it can access, so neither sees something through you that they couldn't open themselves.",
}

/** The enclave owns a sealed turn's toolset and describes it in the tool sections it appends. */
const SEALED_CAPABILITIES =
  "- At most: search the web, read web pages, research the web, and read files shared in this scratchpad. Only the tools described further down are available this turn."

function capabilityBlock(toolNames: readonly string[]): string {
  const wired = new Set(toolNames)
  const lines = CAPABILITIES.filter((capability) => capability.tools.some((tool) => wired.has(tool))).map(
    (capability) => `- ${capability.line}`
  )
  return lines.length > 0 ? lines.join("\n") : "- Nothing beyond replying in this conversation."
}

function modelLine(persona: CardPersona, self: SelfKnowledge): string {
  if (!self.sealed && self.subagentModel) {
    return `In this thread you run on \`${self.subagentModel}\`, the model a person asked to answer here.`
  }
  // The enclave never escalates, so a sealed turn always runs the persona's own model.
  return persona.escalationModel && !self.sealed
    ? `You run on \`${persona.model}\`. Harder turns may be escalated to \`${persona.escalationModel}\`.`
    : `You run on \`${persona.model}\`.`
}

function reachLine(self: SelfKnowledge): string {
  if (self.sealed) {
    return "This is an end-to-end-encrypted scratchpad. You see this conversation and nothing else in the workspace."
  }
  if (self.access === null) {
    return "No one triggered this turn, so you work from this conversation alone and can't search the rest of the workspace."
  }
  return REACH[self.access]
}

function memoryLine(self: SelfKnowledge): string {
  if (self.sealed) {
    return "Nothing said here becomes a memo, because the server can't read it. Between conversations you remember only through summaries of your earlier sessions in this stream."
  }
  const capture =
    self.memoryCapture === "on"
      ? "Memory capture is on here, so decisions, facts and how-tos from this conversation can become memos the workspace can recall later."
      : "Memory capture is off here, so nothing from this conversation becomes a memo unless someone asks you to save one."
  return `${capture} Between conversations you remember only through memos and summaries of your earlier sessions in this stream.`
}

/**
 * The `## How You Work` card: what this persona can see, reach and do, so it
 * can answer questions about itself truthfully instead of guessing. The
 * capability list comes from the tools actually wired this turn, which the
 * prompt already treats as conversation-stable.
 */
export function buildHowIWorkSection(persona: CardPersona, self: SelfKnowledge, toolNames: readonly string[]): string {
  const capabilities = self.sealed ? SEALED_CAPABILITIES : capabilityBlock(toolNames)

  return `

## How You Work

Use this when someone asks what you are, what you can do, or what you can see. Answer from it rather than guessing, and say so when something isn't covered here.

You are ${persona.name}, an AI agent in Threa. ${modelLine(persona, self)} Your model, tools and instructions are configured in Threa's persona settings, not by you.

What you see: the messages in this conversation (older parts may be summarised), the files people share in it, and what your tools return. You don't see the user's screen, their other apps, or anything they haven't sent here.

What you reach: ${reachLine(self)}

Memory: ${memoryLine(self)}

What you can do:
${capabilities}

If something isn't on this list, say you can't do it here rather than describing how you would. You can't click around the app for the user, invite people, create channels or change workspace settings.`
}
