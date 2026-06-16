import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react"
import { useSearchParams, useLocation } from "react-router-dom"

interface TraceContextValue {
  isOpen: boolean
  sessionId: string | null
  highlightMessageId: string | null

  getTraceUrl: (sessionId: string, highlightMessageId?: string) => string
  closeTraceModal: () => void
}

const TraceContext = createContext<TraceContextValue | null>(null)

interface TraceProviderProps {
  children: ReactNode
}

export function TraceProvider({ children }: TraceProviderProps) {
  const [searchParams, setSearchParams] = useSearchParams()
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

  const closeTraceModal = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("trace")
        next.delete("highlight")
        return next
      },
      { replace: true }
    )
  }, [setSearchParams])

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

  return <TraceContext.Provider value={value}>{children}</TraceContext.Provider>
}

export function useTrace(): TraceContextValue {
  const context = useContext(TraceContext)
  if (!context) {
    throw new Error("useTrace must be used within a TraceProvider")
  }
  return context
}
