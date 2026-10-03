import { AgentToolNames, type AgentToolName } from "@threahq/types"
import type { AgentAccessSpec } from "../../researcher/access-spec"
import { isToolEnabled } from "../../tools"

/** Conversation-stable inputs of the card, so it can sit in the cached half of the prompt. */
export interface SelfKnowledge {
  /** `null` when no human triggered the turn, so there is no one's access to borrow. */
  access: AgentAccessSpec["type"] | null
  memoryCapture: "on" | "off"
  /** End-to-end-encrypted scratchpad: the enclave runs the turn with a reduced toolset. */
  sealed: boolean
}

interface CardPersona {
  name: string
  model: string
  escalationModel: string | null
  enabledTools: string[] | null
}

/** The tools the enclave wires for a sealed turn, besides send_message. */
const SEALED_TOOLS: ReadonlySet<AgentToolName> = new Set([AgentToolNames.WEB_SEARCH, AgentToolNames.READ_URL])

/** `workspace` marks tools built only from workspace deps, which exist only when a human triggered the turn. */
const CAPABILITIES: Array<{ tools: AgentToolName[]; line: string; workspace?: true }> = [
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
    workspace: true,
  },
  {
    tools: [AgentToolNames.SEARCH_ATTACHMENTS, AgentToolNames.READ_ATTACHMENT],
    line: "Find and read files shared in the workspace: documents, PDFs, spreadsheets and images.",
    workspace: true,
  },
  {
    tools: [AgentToolNames.RUN_COMMAND],
    line: "Run code and shell commands in a sandbox tied to this stream, when the workspace has sandboxes.",
    workspace: true,
  },
  { tools: [AgentToolNames.DESCRIBE_MEMO], line: "Open memos to see their sources.", workspace: true },
  { tools: [AgentToolNames.SAVE_MEMO], line: "Save something to memory when someone asks." },
  { tools: [AgentToolNames.REACT_TO_MESSAGE], line: "React to messages with an emoji.", workspace: true },
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
    line: "Change the user's own settings (theme, date and time format, timezone, language, notifications, working hours), only in their own scratchpad and only when they ask.",
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
    line: "Read GitHub repositories, commits, pull requests, issues, workflows and releases, when the workspace has connected GitHub. Read-only.",
  },
  {
    tools: [
      AgentToolNames.LINEAR_LIST_ISSUES,
      AgentToolNames.LINEAR_GET_ISSUE,
      AgentToolNames.LINEAR_LIST_PROJECTS,
      AgentToolNames.LINEAR_GET_PROJECT,
    ],
    line: "Read Linear issues and projects, when the workspace has connected Linear. Read-only.",
  },
]

const REACH: Record<AgentAccessSpec["type"], string> = {
  user_full_access:
    "This is the user's own private space, so you can reach everything they can: their channels, DMs, scratchpads, files and memory, including memories private to them.",
  public_plus_stream:
    "Others can read this conversation, so you reach only this conversation (and its threads) plus public channels and the memory built from them. You never pull anyone's private conversations in here, even ones the person asking can see.",
  public_only:
    "This conversation is public, so you reach only public channels and the memory built from them. You never pull anyone's private conversations in here, even ones the person asking can see.",
  user_intersection:
    "In a DM you reach only what both people in it can access, so neither sees something through you that they couldn't open themselves.",
}

function capabilityLines(persona: CardPersona, self: SelfKnowledge): string[] {
  const enabled = (tool: AgentToolName) =>
    isToolEnabled(persona.enabledTools, tool) && (!self.sealed || SEALED_TOOLS.has(tool))

  const lines: string[] = []
  if (!self.sealed && self.access !== null) {
    lines.push("Research the workspace: messages, memos and files within the reach described above.")
  }
  for (const capability of CAPABILITIES) {
    if (capability.workspace && self.access === null) continue
    if (capability.tools.some(enabled)) lines.push(capability.line)
  }
  return lines
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
  if (self.sealed) return "Nothing said here becomes a memo, because the server can't read it."
  return self.memoryCapture === "on"
    ? "Memory capture is on here, so decisions, facts and how-tos from this conversation can become memos the workspace can recall later."
    : "Memory capture is off here, so nothing from this conversation becomes a memo unless someone asks you to save one."
}

/**
 * The `## How You Work` card: what this persona can see, reach and do, so it
 * can answer questions about itself truthfully instead of guessing. Lines for
 * tools that only exist under a condition state that condition, which keeps the
 * card identical on every turn of the conversation.
 */
export function buildHowIWorkSection(persona: CardPersona, self: SelfKnowledge): string {
  const model = persona.escalationModel
    ? `You run on \`${persona.model}\`. Harder turns may be escalated to \`${persona.escalationModel}\`.`
    : `You run on \`${persona.model}\`.`

  const capabilities = capabilityLines(persona, self)
  const capabilityBlock =
    capabilities.length > 0
      ? capabilities.map((line) => `- ${line}`).join("\n")
      : "- Nothing beyond replying in this conversation."

  return `

## How You Work

Use this when someone asks what you are, what you can do, or what you can see. Answer from it rather than guessing, and say so when something isn't covered here.

You are ${persona.name}, an AI agent in Threa. ${model} Your model, tools and instructions are configured in Threa's persona settings, not by you.

What you see: the messages in this conversation (older parts may be summarised), the files people share in it, and what your tools return. You don't see the user's screen, their other apps, or anything they haven't sent here.

What you reach: ${reachLine(self)}

Memory: ${memoryLine(self)} Between conversations you remember only through memos and summaries of your earlier sessions in this stream.

What you can do:
${capabilityBlock}

A capability is usable only when its tool is in your toolset for this turn. If it isn't, say you can't do that here rather than describing how you would. You can't click around the app for the user, invite people, create channels or change workspace settings.`
}
