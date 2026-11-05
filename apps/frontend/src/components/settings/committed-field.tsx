import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { toast } from "sonner"

export type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string }

const SAVED_SHOWN_MS = 2000
const IDLE: SaveState = { kind: "idle" }
const REQUIRED_RESTORED: SaveState = { kind: "error", message: "Can't be empty, so the saved one is back." }

/** `draft` as a whole number from `min` to `max`, or `null` when it isn't one. */
export function parseBoundedInteger(draft: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  if (draft.trim() === "") return null
  const parsed = Number(draft)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

/**
 * Escape inside `fieldRef` reverts a dirty draft instead of closing the
 * settings window, which closes on Escape in the document's capture phase, so
 * this claims the key earlier, on the window.
 */
function useEscapeRevertsDraft(fieldRef: RefObject<HTMLElement | null>, dirty: boolean, revert: () => void) {
  useEffect(() => {
    if (!dirty) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !fieldRef.current?.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      revert()
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true })
  }, [fieldRef, dirty, revert])
}

interface CommittedTextOptions {
  saved: string
  /** Receives the trimmed draft. Throw to keep the draft and show the error in place. */
  commit: (value: string) => Promise<unknown>
  /** An empty draft reverts instead of saving, and says so in place. */
  required?: boolean
  /** A function reads the commit's error, such as a server's reason it was refused. */
  failureMessage?: string | ((error: unknown) => string)
}

/**
 * The one save model for a typed setting: the draft saves on blur or Enter (the
 * caller wires both to `save`), Escape inside `fieldRef` reverts it, and the
 * outcome shows in place. Closing the window without a blur still saves.
 */
export function useCommittedText<Field extends HTMLElement = HTMLElement>({
  saved,
  commit,
  required = false,
  failureMessage = "Couldn't save",
}: CommittedTextOptions) {
  const [draft, setDraftState] = useState<string | null>(null)
  const [state, setState] = useState<SaveState>(IDLE)
  const fieldRef = useRef<Field | null>(null)
  // Read after an await, when the render-time value is already stale.
  const draftRef = useRef<string | null>(null)
  const setDraft = useCallback((next: string | null) => {
    draftRef.current = next
    setDraftState(next)
  }, [])
  const saving = useRef(false)
  // A save asked for while one is in flight: the latest draft commits once it lands.
  const queued = useRef(false)
  const mounted = useRef(true)
  const latest = useRef({ saved, commit, required, failureMessage })
  latest.current = { saved, commit, required, failureMessage }

  const value = draft ?? saved
  const dirty = draft !== null && draft.trim() !== saved

  const save = useCallback(async () => {
    if (saving.current) {
      queued.current = true
      return
    }
    saving.current = true
    // What this run committed last, since `saved` only catches up on a later render.
    let committed: string | null = null
    try {
      for (;;) {
        queued.current = false
        const current = draftRef.current
        const { saved: savedValue, commit: commitValue, required: isRequired, failureMessage: failure } = latest.current
        if (current === null) return
        const next = current.trim()
        if (isRequired && !next) {
          setDraft(null)
          if (mounted.current) setState(REQUIRED_RESTORED)
          return
        }
        if (next === (committed ?? savedValue)) {
          setDraft(null)
          setState(committed === null ? IDLE : { kind: "saved" })
          return
        }
        setState({ kind: "saving" })
        try {
          await commitValue(next)
        } catch (error) {
          const message = typeof failure === "function" ? failure(error) : failure
          if (mounted.current) setState({ kind: "error", message })
          else toast.error(message)
          return
        }
        committed = next
        const pending = draftRef.current
        if (pending === null || pending.trim() === next) {
          setDraft(null)
          setState({ kind: "saved" })
          return
        }
        // Typed on while it saved: "Saved" would describe a value no longer shown.
        if (!queued.current && mounted.current) {
          setState(IDLE)
          return
        }
      }
    } finally {
      saving.current = false
    }
  }, [setDraft])

  const revert = useCallback(() => {
    setDraft(null)
    setState(IDLE)
  }, [setDraft])

  const onChange = useCallback(
    (next: string) => {
      setDraft(next)
      setState((current) => (current.kind === "error" || current.kind === "saved" ? IDLE : current))
    },
    [setDraft]
  )

  useEffect(() => {
    if (state.kind !== "saved") return
    const timer = setTimeout(() => setState(IDLE), SAVED_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [state])

  useEscapeRevertsDraft(fieldRef, dirty, revert)

  // Browser back or a closing window unmounts the field without a blur; a save
  // in flight then commits the latest draft once it lands.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void save()
    }
  }, [save])

  return { value, onChange, save, revert, dirty, state, fieldRef }
}

interface CommittedIntegerOptions {
  /** The saved number; `null` while the setting holds none, and the field keeps what was typed. */
  saved: number | null
  /** The draft before anything is saved or typed. */
  initial: number
  min: number
  /** Omit for no upper bound. */
  max?: number
  onCommit: (value: number) => void
  /** The value being typed while it's valid, for a live preview; `null` once it's committed, reverted or invalid. */
  onDraftChange?: (draft: number | null) => void
}

/**
 * {@link useCommittedText}'s save model for a typed whole number: the draft
 * commits on blur or Enter (the caller wires both to `commit`), Escape inside
 * `fieldRef` reverts it, and closing the window without a blur still saves a
 * valid one. Input outside the range stays in the field, `invalid`, unsaved. A
 * new `saved` replaces the draft unless it holds unsaved typing.
 */
export function useCommittedInteger({ saved, initial, min, max, onCommit, onDraftChange }: CommittedIntegerOptions) {
  const [draft, setDraftState] = useState(String(saved ?? initial))
  // Read by a handler in the same event as the keystroke, and by the unmount flush, ahead of the render that shows it.
  const draftRef = useRef(draft)
  const setDraft = useCallback((next: string) => {
    draftRef.current = next
    setDraftState(next)
  }, [])
  const [invalid, setInvalid] = useState(false)
  const edited = useRef(false)
  const fieldRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (edited.current) return
    if (saved !== null) setDraft(String(saved))
    setInvalid(false)
  }, [saved, setDraft])
  const latest = useRef({ saved, min, max, onCommit })
  latest.current = { saved, min, max, onCommit }
  useEffect(
    () => () => {
      if (!edited.current) return
      const { saved: value, min: low, max: high, onCommit: save } = latest.current
      const parsed = parseBoundedInteger(draftRef.current, low, high)
      if (parsed !== null && parsed !== value) save(parsed)
    },
    []
  )

  const change = (next: string) => {
    edited.current = true
    setDraft(next)
    const parsed = parseBoundedInteger(next, min, max)
    if (parsed !== null) setInvalid(false)
    onDraftChange?.(parsed)
  }

  const commit = () => {
    onDraftChange?.(null)
    const parsed = parseBoundedInteger(draft, min, max)
    setInvalid(parsed === null)
    if (parsed === null) return
    edited.current = false
    setDraft(String(parsed))
    if (parsed !== saved) onCommit(parsed)
  }

  /**
   * Keeps the draft but drops its unsaved and invalid marks, for a caller that
   * saves something else; returns the draft as typed so far, `null` when invalid.
   */
  const settle = useCallback((): number | null => {
    edited.current = false
    setInvalid(false)
    return parseBoundedInteger(draftRef.current, min, max)
  }, [min, max])

  const revert = useCallback(() => {
    settle()
    if (saved !== null) setDraft(String(saved))
    onDraftChange?.(null)
  }, [saved, settle, setDraft, onDraftChange])
  useEscapeRevertsDraft(fieldRef, saved !== null && draft !== String(saved), revert)

  return { draft, invalid, change, commit, settle, fieldRef }
}

export type CommittedInteger = ReturnType<typeof useCommittedInteger>
