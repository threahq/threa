import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { JSONContent } from "@threa/types"

export interface AgentBlockData {
  /** `persona_…` / `bot_…` — the agent credited with the text (INV-64). */
  authorId: string
  authorName: string
  /** The agent's message — `contentJson` end to end (INV-58). */
  content: JSONContent[]
}

interface AgentBlockContextValue {
  /** Carry an agent message out of the timeline as an attributed block. */
  insertAgentBlock: (data: AgentBlockData) => void
}

const AgentBlockCtx = createContext<AgentBlockContextValue | null>(null)

/**
 * Provided by the surface that owns where agent text goes (the aside pane:
 * its draft editor). A timeline without a provider offers no insert action —
 * the timeline's own composer is never the destination.
 */
export function AgentBlockProvider({
  onInsert,
  children,
}: {
  onInsert: (data: AgentBlockData) => void
  children: ReactNode
}) {
  const value = useMemo(() => ({ insertAgentBlock: onInsert }), [onInsert])
  return <AgentBlockCtx.Provider value={value}>{children}</AgentBlockCtx.Provider>
}

export function useAgentBlock(): AgentBlockContextValue | null {
  return useContext(AgentBlockCtx)
}

/**
 * Append an `agentBlock` node to composer content, returning the new doc.
 * Trailing empty paragraphs are stripped so the block appends cleanly and
 * exactly one is re-added for typing after it — the same trimming
 * `appendQuoteReplyNode` does, so both insertions land the same way.
 */
export function appendAgentBlockNode(content: JSONContent, data: AgentBlockData): JSONContent {
  const agentNode: JSONContent = {
    type: "agentBlock",
    attrs: { authorId: data.authorId, authorName: data.authorName },
    content: data.content.length > 0 ? data.content : [{ type: "paragraph" }],
  }

  const blocks = [...(content.content ?? [])]
  while (
    blocks.length > 0 &&
    blocks[blocks.length - 1].type === "paragraph" &&
    (blocks[blocks.length - 1].content?.length ?? 0) === 0
  ) {
    blocks.pop()
  }

  return { ...content, type: content.type ?? "doc", content: [...blocks, agentNode, { type: "paragraph" }] }
}
