import { useCallback, useRef, useState } from "react"
import type { SearchRefinement } from "@threahq/types"
import { boundRefines } from "@/lib/search-query-parser"

interface UseRefineControlOptions {
  refines: SearchRefinement[]
  onChange: (refines: SearchRefinement[]) => void
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
  /** Adds a refinement the user did not type — a row menu's More like this / Drop. */
  append: (refine: SearchRefinement) => void
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

  const append = useCallback(
    (refine: SearchRefinement) => {
      onChange(boundRefines([...refines, refine]))
    },
    [refines, onChange]
  )

  return {
    isOpen,
    editingIndex,
    initialValue: proseAt(refines, editingIndex),
    triggerRef,
    toggle,
    edit,
    commit,
    append,
    close,
  }
}

/** Only prose is editable; a row refinement has no text the row could reopen on. */
function proseAt(refines: SearchRefinement[], index: number | null): string {
  if (index === null) return ""
  const refine = refines[index]
  return typeof refine === "string" ? refine : ""
}
