import { StreamTypes, TOOL_PRIVACY_CATEGORY_LABELS, type StreamType, type ToolPrivacyPolicy } from "@threahq/types"
import { SETTING_CHOICE_LABELS, type SettingId, type StreamSettingId } from "@/components/settings/settings-registry"
import { stripMarkdownToInline } from "@/lib/markdown/strip"
import { modelDisplayName } from "@/lib/model-display"
import { streamFallbackLabel } from "@/lib/streams"

export interface AgentContextInput {
  /** The agent that replies, once the roster has loaded. */
  agent: { id: string; model: string; instructions: string | null; personal: boolean } | null
  e2e: boolean
  isAdmin: boolean
  /** Your scratchpad instructions; undefined where they don't reach the agent. */
  instructions?: string | null
  /** The stream's brief; undefined where it has none to show (drafts). */
  brief?: { content: string | null; loading: boolean; sharedWith: string | null }
  /** The scratchpad's tool policy; undefined for streams without one. */
  tools?: { policy: ToolPrivacyPolicy; viewerIsOwner: boolean }
  deviceSharing: boolean
}

/** A setting, a setting of this stream, or the editor of one agent. */
export type AgentContextLink = { setting: SettingId } | { streamSetting: StreamSettingId } | { persona: string }

export interface AgentContextItem {
  id: "agent" | "model" | "agent-instructions" | "instructions" | "brief" | "tools" | "device"
  label: string
  /** What the row is, in a few words. */
  description: string
  value: string
  editedBy: string
  /** Shapes only the viewer's replies; the rest shape everyone's here. */
  onlyYou?: true
  /** Free text cut to one line: it reads under the label, not beside it. */
  prose?: true
  /** Full text the row expands to show, read-only. */
  detail?: string
  /** Where it's edited, or null when the viewer can't open that place. */
  link: AgentContextLink | null
}

/** About one desktop row of text; narrower rows ellipsize the rest. */
const PREVIEW_MAX_CHARS = 80

/** The first non-blank line, cut at a word boundary when it runs long. */
function firstLine(text: string | null | undefined): string | null {
  const line =
    text
      ?.split("\n")
      .find((candidate) => candidate.trim())
      ?.trim() ?? null
  if (!line || line.length <= PREVIEW_MAX_CHARS) return line
  const cut = line.slice(0, PREVIEW_MAX_CHARS - 1)
  const space = cut.lastIndexOf(" ")
  const words = space > PREVIEW_MAX_CHARS / 2 ? cut.slice(0, space) : cut
  return `${words.replace(/[\p{P}\s]+$/u, "")}…`
}

const words = new Intl.Segmenter(undefined, { granularity: "word" })

/** Long text summarised by its length, read in full by opening the row. */
function lengthValue(text: string | null): string {
  if (!text) return "None"
  let count = 0
  for (const segment of words.segment(stripMarkdownToInline(text))) if (segment.isWordLike) count++
  return count === 1 ? "1 word" : `${count} words`
}

/** A free-text value: its preview with `prose` set, or "None" beside the label. */
function proseValue(text: string | null | undefined): Pick<AgentContextItem, "value" | "prose"> {
  const preview = firstLine(text && stripMarkdownToInline(text))
  return preview ? { value: preview, prose: true } : { value: "None" }
}

/** Who a thread's brief is shared with: the channel by name, otherwise the kind of parent. */
export function briefSharedWith(root: { type: StreamType; slug?: string | null } | null | undefined): string {
  if (!root) return "the parent stream"
  if (root.type === StreamTypes.CHANNEL && root.slug) return `#${root.slug}`
  return `the parent ${streamFallbackLabel(root.type, "noun")}`
}

function toolsValue(policy: ToolPrivacyPolicy): string {
  if (policy === null) return "All tools"
  if (policy.length === 0) return "Replies only"
  return policy.map((category) => TOOL_PRIVACY_CATEGORY_LABELS[category]).join(", ")
}

/**
 * Everything that shapes an agent's replies in one stream, each with who edits
 * it and where. Encrypted scratchpads run Ariadne in the enclave, which never
 * receives a brief or device details, so those rows drop there.
 */
export function describeAgentContext(input: AgentContextInput): AgentContextItem[] {
  const items: AgentContextItem[] = []

  if (input.e2e) {
    items.push({
      id: "agent",
      label: "Agent",
      description: "Who replies here.",
      value: "Ariadne",
      editedBy: "Fixed in encrypted scratchpads",
      link: null,
    })
  } else if (input.agent) {
    const { id, model, instructions, personal } = input.agent
    const link: AgentContextLink | null = personal || input.isAdmin ? { persona: id } : null
    const editedBy = personal ? "Edited by you" : "Edited by workspace admins"
    items.push({
      id: "model",
      label: "Model",
      description: "The model this agent runs on.",
      value: modelDisplayName(model),
      editedBy,
      link,
    })
    const text = instructions?.trim() || null
    items.push({
      id: "agent-instructions",
      label: "Agent instructions",
      description: "What the agent follows wherever it replies.",
      value: lengthValue(text),
      editedBy,
      link,
      detail: text ?? undefined,
    })
  }

  if (input.instructions !== undefined) {
    items.push({
      id: "instructions",
      label: "Your instructions",
      description: "What every agent follows in your scratchpads.",
      ...proseValue(input.instructions),
      editedBy: "Edited by you",
      onlyYou: true,
      link: { setting: "ai-instructions" },
    })
  }

  if (input.brief && !input.e2e) {
    const { content, loading, sharedWith } = input.brief
    items.push({
      id: "brief",
      label: "Brief",
      description: "What the agent reads on every turn here.",
      ...(loading ? { value: "Loading…" } : proseValue(content)),
      editedBy: sharedWith ? `Edited by members, shared with ${sharedWith}` : "Edited by members",
      link: { streamSetting: "stream-brief" },
    })
  }

  if (input.tools) {
    const { policy, viewerIsOwner } = input.tools
    items.push({
      id: "tools",
      label: "Tools",
      description: "What the agent can use besides replying.",
      value: toolsValue(policy),
      editedBy: viewerIsOwner ? "Edited by you" : "Edited by the owner",
      link: viewerIsOwner ? { streamSetting: "stream-tools" } : null,
    })
  }

  if (!input.e2e) {
    items.push({
      id: "device",
      label: "Your device",
      description: "What agents learn about the device you're on.",
      value: SETTING_CHOICE_LABELS["device-sharing"][input.deviceSharing ? "on" : "off"],
      editedBy: "Edited by you",
      onlyYou: true,
      link: { setting: "device-sharing" },
    })
  }

  return items
}
