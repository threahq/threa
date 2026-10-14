import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react"
import { useSearchParams, useLocation } from "react-router-dom"
import { useCoverClose } from "@/hooks/use-cover-close"
import { useLatest } from "@/hooks/use-latest"
import { TRACE_COVER } from "@/lib/covers"

interface TraceContextValue {
  isOpen: boolean
  sessionId: string | null
  highlightMessageId: string | null

  getTraceUrl: (sessionId: string, highlightMessageId?: string) => string
  closeTraceModal: () => void
}

const TraceContext = createContext<TraceContextValue | null>(null)
const LatestTraceContext = createContext<(() => TraceContextValue) | null>(null)

interface TraceProviderProps {
  children: ReactNode
}

export function TraceProvider({ children }: TraceProviderProps) {
  const [searchParams] = useSearchParams()
  const location = useLocation()

  const sessionId = useMemo(() => searchParams.get("trace"), [searchParams])
  const highlightMessageId = useMemo(() => searchParams.get("highlight"), [searchParams])
  const isOpen = sessionId !== null

  const getTraceUrl = useCallback(
    (traceSessionId: string, messageId?: string) => {
      const newParams = new URLSearchParams(searchParams)
      newParams.set("trace", traceSessionId)
      if (messageId) {
        newParams.set("highlight", messageId)
      } else {
        newParams.delete("highlight")
      }
      return `${location.pathname}?${newParams.toString()}`
    },
    [searchParams, location.pathname]
  )

  const closeTraceModal = useCoverClose(TRACE_COVER)

  const value = useMemo<TraceContextValue>(
    () => ({
      isOpen,
      sessionId,
      highlightMessageId,
      getTraceUrl,
      closeTraceModal,
    }),
    [isOpen, sessionId, highlightMessageId, getTraceUrl, closeTraceModal]
  )

  const latest = useLatest(value)
  return (
    <TraceContext.Provider value={value}>
      <LatestTraceContext.Provider value={latest}>{children}</LatestTraceContext.Provider>
    </TraceContext.Provider>
  )
}

export function useTrace(): TraceContextValue {
  const context = useContext(TraceContext)
  if (!context) {
    throw new Error("useTrace must be used within a TraceProvider")
  }
  return context
}

/**
 * The trace value as it is when called, with no render subscription: a message
 * row only needs the trace url once its menu opens, and the value changes on
 * every navigation.
 */
export function useLatestTrace(): () => TraceContextValue {
  const latest = useContext(LatestTraceContext)
  if (!latest) {
    throw new Error("useLatestTrace must be used within a TraceProvider")
  }
  return latest
}
