import { useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Plus, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { VOICE_STEERING_BASE_TERMS, VOICE_STEERING_WORDS_MAX, VOICE_STEERING_WORD_MAX_LENGTH } from "@threahq/types"

interface SteeringWordsEditorProps {
  title: string
  description: ReactNode
  /** The editable list of steering words. */
  words: string[]
  /** False until the backing store hydrates — writes are blocked so a stray
   *  add/remove can't persist a list built from an empty baseline. */
  ready: boolean
  /** A persist is in flight; actions are disabled. */
  busy: boolean
  /** When false the list renders read-only (no input, no remove buttons). */
  canEdit: boolean
  /** Shown under the chips when `canEdit` is false (e.g. an admin-only note). */
  readOnlyNote?: string
  /** Persist the next list. */
  onChange: (next: string[]) => void
}

/**
 * Shared tag editor for a dictation steering-word list — used for both the
 * per-user list and the workspace-shared list. Owns the add/remove/dedupe/limit
 * UX; the caller supplies the list, hydration/busy state, edit permission, and a
 * persist callback. The baked-in product terms ({@link VOICE_STEERING_BASE_TERMS})
 * always render as non-removable "always on" chips and are deduped against, since
 * they bias every session regardless of the list.
 */
export function SteeringWordsEditor({
  title,
  description,
  words,
  ready,
  busy,
  canEdit,
  readOnlyNote,
  onChange,
}: SteeringWordsEditorProps) {
  const [draft, setDraft] = useState("")
  // A rejected add (duplicate / already baked-in) otherwise just clears the
  // field, which reads as a silent failure — surface the reason instead.
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const atLimit = words.length >= VOICE_STEERING_WORDS_MAX
  const writable = ready && canEdit && !busy

  const addWord = () => {
    const term = draft.trim()
    if (!term || !writable || atLimit) return
    // Dedupe case-insensitively against both the list and the baked-in terms —
    // re-adding "Threa" is a no-op, not a duplicate chip.
    const existing = new Set([...words, ...VOICE_STEERING_BASE_TERMS].map((w) => w.toLowerCase()))
    if (existing.has(term.toLowerCase())) {
      setNotice(`"${term}" is already included.`)
      setDraft("")
      inputRef.current?.focus()
      return
    }
    setNotice(null)
    onChange([...words, term.slice(0, VOICE_STEERING_WORD_MAX_LENGTH)])
    setDraft("")
    // Tag entry is a rapid-fire gesture; keep the caret in the field so a mouse
    // user clicking "Add" can keep typing without re-clicking.
    inputRef.current?.focus()
  }

  const removeWord = (term: string) => {
    if (!writable) return
    onChange(words.filter((w) => w !== term))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter or comma commits the current draft as a word.
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      addWord()
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {canEdit ? (
        <>
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                if (notice) setNotice(null)
              }}
              onKeyDown={handleKeyDown}
              maxLength={VOICE_STEERING_WORD_MAX_LENGTH}
              disabled={!writable || atLimit}
              placeholder={atLimit ? "Word limit reached" : "Add a word or name, then press Enter"}
              aria-label="Add a dictation steering word"
            />
            <Button type="button" variant="outline" onClick={addWord} disabled={!writable || atLimit || !draft.trim()}>
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
          {/* Reserved line so showing/clearing the notice doesn't shift the chips (INV-21). */}
          <p className="min-h-[1rem] text-xs text-muted-foreground" aria-live="polite">
            {notice}
          </p>
        </>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {VOICE_STEERING_BASE_TERMS.map((term) => (
          <Badge key={`base-${term}`} variant="secondary" className="gap-1 font-normal">
            {term}
            <span className="text-muted-foreground">· always on</span>
          </Badge>
        ))}
        {words.map((term) => (
          <Badge key={term} variant="outline" className="gap-1 pr-1 font-normal">
            {term}
            {canEdit ? (
              <button
                type="button"
                onClick={() => removeWord(term)}
                disabled={!writable}
                className="rounded-full p-1.5 hover:bg-muted disabled:opacity-50"
                aria-label={`Remove ${term}`}
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </Badge>
        ))}
      </div>

      {!canEdit && readOnlyNote ? <p className="text-xs text-muted-foreground">{readOnlyNote}</p> : null}
    </section>
  )
}
