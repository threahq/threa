import { useCallback, useEffect, useRef, useState } from "react"

interface DebouncedUrlTextOptions {
  /** The committed value, read back from the URL. */
  value: string
  /** Called with the settled draft; must write `value` (directly or eventually). */
  onCommit: (next: string) => void
  delayMs?: number
}

const DEFAULT_DELAY_MS = 200

/**
 * A text input that is locally controlled and debounced into URL state.
 *
 * Driving `value` straight off `useSearchParams` makes the input lag a tick
 * behind keystrokes, and mobile autocorrect — which replaces the misspelled word
 * in two DOM steps — sees a stale value mid-replacement and concatenates the
 * suggestion onto the original ("gurl" + "girl" -> "Guelirl") instead of
 * substituting it.
 *
 * Two refs carry the rest of the contract: `lastWrittenRef` tells our own
 * debounced echo (skip — it would clobber keystrokes typed during React Router's
 * render delay) from an external change like Clear filters or back/forward
 * (apply, and cancel the pending debounce so it can't resurrect stale typing);
 * `commitRef` keeps the timer on the freshest callback, so a pending debounce
 * can't write back a params snapshot taken before another filter changed.
 */
export function useDebouncedUrlText({ value, onCommit, delayMs = DEFAULT_DELAY_MS }: DebouncedUrlTextOptions) {
  const [draft, setDraftState] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastWrittenRef = useRef(value)

  const commitRef = useRef(onCommit)
  useEffect(() => {
    commitRef.current = onCommit
  }, [onCommit])

  useEffect(() => {
    if (value === lastWrittenRef.current) return
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    lastWrittenRef.current = value
    setDraftState(value)
  }, [value])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const setDraft = useCallback(
    (next: string) => {
      setDraftState(next)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        lastWrittenRef.current = next
        commitRef.current(next)
      }, delayMs)
    },
    [delayMs]
  )

  return { draft, setDraft }
}
