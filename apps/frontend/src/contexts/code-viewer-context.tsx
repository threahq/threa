import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { CodeViewer, type CodeViewerItem } from "@/components/code-viewer"

interface CodeViewerContextValue {
  open: (item: CodeViewerItem) => void
  close: () => void
}

const CodeViewerContext = createContext<CodeViewerContextValue | null>(null)

interface CodeViewerProviderProps {
  children: ReactNode
}

/**
 * Owns the single full-screen code viewer for the workspace shell. Any rendered
 * code block opens it imperatively with its code; the dialog is mounted once
 * here so the block itself never nests a Dialog per message.
 */
export function CodeViewerProvider({ children }: CodeViewerProviderProps) {
  const [item, setItem] = useState<CodeViewerItem | null>(null)
  // Bumped per open so the viewer remounts with fresh session state (wrap
  // toggle, copy feedback) instead of inheriting the previous block's.
  const [openId, setOpenId] = useState(0)

  const open = useCallback((next: CodeViewerItem) => {
    setItem(next)
    setOpenId((id) => id + 1)
  }, [])
  const close = useCallback(() => setItem(null), [])

  const value = useMemo<CodeViewerContextValue>(() => ({ open, close }), [open, close])

  return (
    <CodeViewerContext.Provider value={value}>
      {children}
      {item && <CodeViewer key={openId} item={item} onClose={close} />}
    </CodeViewerContext.Provider>
  )
}

/** Null outside the workspace shell (standalone previews, tests) — callers hide their trigger. */
export function useCodeViewerOptional(): CodeViewerContextValue | null {
  return useContext(CodeViewerContext)
}
