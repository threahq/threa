import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react"

/** One running agent session in the open stream (or its threads), for the header chip. */
export interface AgentActivitySummaryEntry {
  sessionId: string
  personaName: string
  stepCount: number
}

interface StreamAgentActivityContextValue {
  /** Running sessions in the open stream, most recently started first; empty when idle. */
  summary: AgentActivitySummaryEntry[]
  /** Called by the timeline to publish its running-session summary up to the header. */
  publishSummary: (summary: AgentActivitySummaryEntry[]) => void
  /**
   * The header chip's DOM element — the follow pill animates out of / back into
   * it so the affordance visibly belongs to the chip. Null while the chip isn't
   * mounted (the pill falls back to a plain fade from above).
   */
  chipRef: MutableRefObject<HTMLElement | null>
}

const EMPTY: AgentActivitySummaryEntry[] = []

const StreamAgentActivityContext = createContext<StreamAgentActivityContextValue>({
  summary: EMPTY,
  // No-op when there's no provider (e.g. a thread-panel StreamContent, which is
  // mounted outside the open stream's provider and must not publish into it).
  publishSummary: () => {},
  chipRef: { current: null },
})

function summaryEqual(a: AgentActivitySummaryEntry[], b: AgentActivitySummaryEntry[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.sessionId !== y.sessionId || x.personaName !== y.personaName || x.stepCount !== y.stepCount) return false
  }
  return true
}

export function StreamAgentActivityProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<AgentActivitySummaryEntry[]>(EMPTY)

  // Skip the re-render when a step tick produces an identical summary — the
  // timeline republishes on every agentActivity change, most of which don't
  // touch the header's fields (sessionId / personaName / stepCount).
  const publishSummary = useCallback((next: AgentActivitySummaryEntry[]) => {
    setSummary((prev) => (summaryEqual(prev, next) ? prev : next))
  }, [])

  const chipRef = useRef<HTMLElement | null>(null)

  const value = useMemo<StreamAgentActivityContextValue>(
    () => ({ summary, publishSummary, chipRef }),
    [summary, publishSummary]
  )

  return <StreamAgentActivityContext.Provider value={value}>{children}</StreamAgentActivityContext.Provider>
}

/** Read the open stream's running-session summary (header chip). */
export function useAgentActivitySummary(): AgentActivitySummaryEntry[] {
  return useContext(StreamAgentActivityContext).summary
}

/** Get the publish function the timeline uses to hand its summary to the header. */
export function usePublishAgentActivitySummary(): (summary: AgentActivitySummaryEntry[]) => void {
  return useContext(StreamAgentActivityContext).publishSummary
}

/** The header chip's element ref — assigned by the chip, read by the follow pill's animation. */
export function useAgentActivityChipRef(): MutableRefObject<HTMLElement | null> {
  return useContext(StreamAgentActivityContext).chipRef
}
