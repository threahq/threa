import { AgentToolNames, TOOL_CATEGORIES_BY_NAME, type AgentToolName } from "@threahq/types"
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

/**
 * One line per capability, phrased from only the tools wired this turn: a
 * persona can enable any subset, and stream policy drops tools too, so a line
 * never claims a sibling tool that isn't there.
 */
const CAPABILITIES: Array<{
  parts: Array<[CardToolName, string | ((workspace: boolean) => string)]>
  line: (phrases: string) => string
}> = [
  {
    parts: [[WORKSPACE_RESEARCH_TOOL_NAME, "research the workspace: messages, memos and files"]],
    line: (p) => `${p}, within the reach described above.`,
  },
  {
    parts: [
      [AgentToolNames.WEB_SEARCH, "search the web"],
      [AgentToolNames.READ_URL, "read web pages"],
    ],
    line: (p) => `${p}.`,
  },
  {
    parts: [
      [
        AgentToolNames.GENERAL_RESEARCH,
        (workspace) =>
          workspace
            ? "run deeper research that combines the workspace, the web and connected integrations"
            : "run deeper research on the web",
      ],
    ],
    line: (p) => `${p}.`,
  },
  {
    parts: [
      [AgentToolNames.SEARCH_MESSAGES, "search messages"],
      [AgentToolNames.SEARCH_STREAMS, "find streams"],
      [AgentToolNames.GET_STREAM_MESSAGES, "read a stream's history"],
    ],
    line: (p) => `${p}, within the reach described above.`,
  },
  { parts: [[AgentToolNames.SEARCH_USERS, "find people in the workspace"]], line: (p) => `${p}.` },
  {
    parts: [
      [AgentToolNames.SEARCH_ATTACHMENTS, "find files shared in the workspace"],
      [AgentToolNames.READ_ATTACHMENT, "read shared files (documents, PDFs, spreadsheets and images)"],
    ],
    line: (p) => `${p}.`,
  },
  {
    parts: [[AgentToolNames.RUN_COMMAND, "run code and shell commands in a sandbox tied to this stream"]],
    line: (p) => `${p}.`,
  },
  { parts: [[AgentToolNames.DESCRIBE_MEMO, "open memos to see their sources"]], line: (p) => `${p}.` },
  { parts: [[AgentToolNames.SAVE_MEMO, "save something to memory when someone asks"]], line: (p) => `${p}.` },
  { parts: [[AgentToolNames.REACT_TO_MESSAGE, "react to messages with an emoji"]], line: (p) => `${p}.` },
  {
    parts: [
      [
        AgentToolNames.SCHEDULE_FOLLOW_UP,
        "schedule a follow-up: come back to this conversation at a set time and pick up where it left off",
      ],
    ],
    line: (p) => `${p}.`,
  },
  {
    parts: [
      [AgentToolNames.LIST_FOLLOW_UPS, "list"],
      [AgentToolNames.UPDATE_FOLLOW_UP, "change"],
      [AgentToolNames.CANCEL_FOLLOW_UP, "cancel"],
    ],
    line: (p) => `${p} scheduled follow-ups.`,
  },
  { parts: [[AgentToolNames.UPDATE_STREAM_BRIEF, "keep this stream's brief up to date"]], line: (p) => `${p}.` },
  {
    parts: [
      [
        AgentToolNames.START_SUBAGENT,
        "hand a question to another model, which answers in a thread under a card in this stream, when a person asks for a second opinion or names a model",
      ],
    ],
    line: (p) => `${p}.`,
  },
  {
    parts: [
      [
        AgentToolNames.DELEGATE_TASK,
        "hand a longer task to the user's own local agent (for example a coding agent on their machine), which reports back here, when a person asked for the work",
      ],
    ],
    line: (p) => `${p}.`,
  },
  {
    parts: [
      [
        AgentToolNames.UPDATE_USER_SETTINGS,
        "change the user's own settings (theme, date and time format, timezone, language, notifications, working hours) when they ask",
      ],
    ],
    line: (p) => `${p}.`,
  },
  {
    parts: [
      [AgentToolNames.GITHUB_REPOS, "repositories"],
      [AgentToolNames.GITHUB_CONTENT, "files"],
      [AgentToolNames.GITHUB_COMMITS, "commits"],
      [AgentToolNames.GITHUB_PULLS, "pull requests"],
      [AgentToolNames.GITHUB_ISSUES, "issues"],
      [AgentToolNames.GITHUB_WORKFLOWS, "workflows"],
      [AgentToolNames.GITHUB_RELEASES, "releases"],
    ],
    line: (p) => `read GitHub ${p}. Read-only.`,
  },
  {
    parts: [
      [AgentToolNames.LINEAR_LIST_ISSUES, "issues"],
      [AgentToolNames.LINEAR_GET_ISSUE, "issues"],
      [AgentToolNames.LINEAR_LIST_PROJECTS, "projects"],
      [AgentToolNames.LINEAR_GET_PROJECT, "projects"],
    ],
    line: (p) => `read Linear ${p}. Read-only.`,
  },
]

/**
 * Tools that read beyond this conversation; without one, the access spec reaches
 * nothing. `general_research` is not listed: it reads the workspace only when
 * the stream policy grants it (see `workspaceGranted`).
 */
export const WORKSPACE_REACH_TOOLS: ReadonlySet<string> = new Set<CardToolName>([
  WORKSPACE_RESEARCH_TOOL_NAME,
  AgentToolNames.SEARCH_MESSAGES,
  AgentToolNames.SEARCH_STREAMS,
  AgentToolNames.GET_STREAM_MESSAGES,
  AgentToolNames.SEARCH_ATTACHMENTS,
  AgentToolNames.READ_ATTACHMENT,
  AgentToolNames.DESCRIBE_MEMO,
])

/**
 * `general_research` runs its own toolset under the same stream policy, so it
 * searches the workspace only where the policy grants `workspace`. Any wired
 * `workspace` tool proves the grant; with none the card underclaims, never over.
 */
function workspaceGranted(toolNames: readonly string[]): boolean {
  return toolNames.some((tool) =>
    (TOOL_CATEGORIES_BY_NAME as Record<string, readonly string[]>)[tool]?.includes("workspace")
  )
}

/** Whether a wired tool is in `set`, counting `general_research` where it reaches the workspace. */
function wiresAny(toolNames: readonly string[], set: ReadonlySet<string>): boolean {
  return (
    toolNames.some((tool) => set.has(tool)) ||
    (toolNames.includes(AgentToolNames.GENERAL_RESEARCH) && workspaceGranted(toolNames))
  )
}

function joinPhrases(phrases: string[]): string {
  return phrases.length > 1 ? `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}` : phrases[0]
}

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
  const workspace = workspaceGranted(toolNames)
  const lines = CAPABILITIES.flatMap(({ parts, line }) => {
    const phrases = [
      ...new Set(
        parts
          .filter(([tool]) => wired.has(tool))
          .map(([, phrase]) => (typeof phrase === "string" ? phrase : phrase(workspace)))
      ),
    ]
    if (phrases.length === 0) return []
    const text = line(joinPhrases(phrases))
    return [`- ${text[0].toUpperCase()}${text.slice(1)}`]
  })
  return lines.length > 0 ? lines.join("\n") : "- Nothing beyond replying in this conversation."
}

function modelLine(persona: CardPersona, self: SelfKnowledge): string {
  if (!self.sealed && self.subagentModel) {
    return `In this thread you run on \`${self.subagentModel}\`, the model a person asked to answer here. Your tools and instructions are configured in Threa's persona settings, not by you.`
  }
  const settings = "Your model, tools and instructions are configured in Threa's persona settings, not by you."
  // The enclave never escalates, so a sealed turn always runs the persona's own model.
  return persona.escalationModel && persona.escalationModel !== persona.model && !self.sealed
    ? `You normally run on \`${persona.model}\`, and Threa may rerun a reply that fails its checks on \`${persona.escalationModel}\`. ${settings}`
    : `You run on \`${persona.model}\`. ${settings}`
}

function reachLine(self: SelfKnowledge, toolNames: readonly string[]): string {
  if (self.sealed) {
    return "This is an end-to-end-encrypted scratchpad. You see this conversation and nothing else in the workspace."
  }
  if (self.access === null) {
    return "No one triggered this turn, so you work from this conversation alone and can't search the rest of the workspace."
  }
  if (!wiresAny(toolNames, WORKSPACE_REACH_TOOLS)) {
    return "None of your tools here read beyond this conversation, so you work from it alone."
  }
  return REACH[self.access]
}

/** Tools that find messages again later, memo or not; `general_research` joins them as in `workspaceGranted`. */
const MESSAGE_SEARCH_TOOLS: ReadonlySet<string> = new Set<CardToolName>([
  WORKSPACE_RESEARCH_TOOL_NAME,
  AgentToolNames.SEARCH_MESSAGES,
])

function memoryLine(self: SelfKnowledge, toolNames: readonly string[]): string {
  if (self.sealed) {
    return "Nothing said here becomes a memo, because the server can't read it. Between conversations you remember only through summaries of your earlier sessions in this stream."
  }
  const onRequest = toolNames.includes(AgentToolNames.SAVE_MEMO) ? " unless someone asks you to save one" : ""
  const capture =
    self.memoryCapture === "on"
      ? "Memory capture is on here, so decisions, facts and how-tos from this conversation can become memos the workspace can recall later. Casual chat usually becomes none."
      : `Memory capture is off here, so nothing from this conversation becomes a memo${onRequest}.`
  // Memo recall is scoped to the person who triggered the turn, so an untriggered turn has none.
  if (self.access === null) {
    return `${capture} Between conversations you remember only through summaries of your earlier sessions in this stream.`
  }
  if (!wiresAny(toolNames, MESSAGE_SEARCH_TOOLS)) {
    return `${capture} Between conversations you remember only through memos and summaries of your earlier sessions in this stream.`
  }
  return `${capture} As time passes, the few messages that settled something get buried in the past under everything said since. A memo condenses what they settled into one clear entry, so a search still finds it long after, and nobody has to piece those messages back together each time. Memos are not the only record, though: every message stays searchable whether or not it became a memo, so you can find this conversation, or any other within your reach, again by searching. Between conversations you also have summaries of your earlier sessions in this stream. Never suggest something is lost because it wasn't saved as a memo.`
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

You are ${persona.name}, an AI agent in Threa. ${modelLine(persona, self)}

What you see: the messages in this conversation (older parts may be summarised), the files people share in it, context the app attaches to a turn (such as the conversation an aside was opened from, or a thread you were asked about), and what your tools return. You don't watch the user's screen or see their other apps.

What you reach: ${reachLine(self, toolNames)}

Memory: ${memoryLine(self, toolNames)}

What you can do:
${capabilities}

If something isn't on this list, say you can't do it here rather than describing how you would. You can't click around the app for the user, invite people, create channels or change workspace settings.`
}
