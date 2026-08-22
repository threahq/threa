import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react"
import type { JSONContent } from "@threa/types"

export interface AgentBlockData {
  /** `persona_…` / `bot_…` — the agent credited with the text (INV-64). */
  authorId: string
  authorName: string
  /** The aside the text was drafted in, when it came from one. */
  sourceAsideId?: string
  /** The agent's message, already parsed — `contentJson` end to end (INV-58). */
  content: JSONContent[]
}

interface AgentBlockContextValue {
  /** Carry an agent message into the composer — called by message actions. */
  insertAgentBlock: (data: AgentBlockData) => void
  /** Register the composer's insertion handler. */
  registerHandler: (handler: (data: AgentBlockData) => void) => () => void
}

const AgentBlockCtx = createContext<AgentBlockContextValue | null>(null)

export function AgentBlockProvider({ children }: { children: ReactNode }) {
  const handlerRef = useRef<((data: AgentBlockData) => void) | null>(null)

  const registerHandler = useCallback((handler: (data: AgentBlockData) => void) => {
    handlerRef.current = handler
    return () => {
      handlerRef.current = null
    }
  }, [])

  const insertAgentBlock = useCallback((data: AgentBlockData) => {
    handlerRef.current?.(data)
  }, [])

  const value = useMemo(() => ({ insertAgentBlock, registerHandler }), [insertAgentBlock, registerHandler])

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
    attrs: {
      authorId: data.authorId,
      authorName: data.authorName,
      sourceAsideId: data.sourceAsideId ?? null,
    },
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
