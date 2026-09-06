import { useCallback, useRef, useState } from "react"
import { boundRefines } from "@/lib/search-query-parser"

interface UseRefineControlOptions {
  refines: string[]
  onChange: (refines: string[]) => void
}

export interface RefineControl {
  isOpen: boolean
  /** Chip the row is editing; null while adding a new refinement. */
  editingIndex: number | null
  /** Text the row opens with. */
  initialValue: string
  /** The pill, so closing the row hands focus back to what opened it. */
  triggerRef: React.RefObject<HTMLButtonElement | null>
  toggle: () => void
  edit: (index: number) => void
  commit: (text: string) => void
  close: () => void
}

/**
 * Open/edit/commit state for the refine row, shared by the sidebar panel and
 * the mobile search page so both commit a refinement the same way.
 */
export function useRefineControl({ refines, onChange }: UseRefineControlOptions): RefineControl {
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => {
    setIsOpen(false)
    setEditingIndex(null)
    triggerRef.current?.focus()
  }, [])

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev)
    setEditingIndex(null)
  }, [])

  const edit = useCallback((index: number) => {
    setEditingIndex(index)
    setIsOpen(true)
  }, [])

  const commit = useCallback(
    (text: string) => {
      const replacing = editingIndex !== null && editingIndex < refines.length
      const next = replacing ? refines.map((refine, i) => (i === editingIndex ? text : refine)) : [...refines, text]
      onChange(boundRefines(next))
      close()
    },
    [editingIndex, refines, onChange, close]
  )

  return {
    isOpen,
    editingIndex,
    initialValue: editingIndex !== null ? (refines[editingIndex] ?? "") : "",
    triggerRef,
    toggle,
    edit,
    commit,
    close,
  }
}
