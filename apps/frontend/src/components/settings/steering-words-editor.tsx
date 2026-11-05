import { useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Plus, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { VOICE_STEERING_BASE_TERMS, VOICE_STEERING_WORDS_MAX, VOICE_STEERING_WORD_MAX_LENGTH } from "@threahq/types"
import { cn } from "@/lib/utils"
import { SETTING_CONTROL_HEIGHT, SettingEmptyNote, SettingRow, settingIds } from "./setting-primitives"
import { FOCUS_FALLBACK, FOCUS_ITEM, FOCUS_SCOPE, useFocusAfterRemoval } from "./use-focus-after-removal"

const BUILT_IN_NOTE = `${new Intl.ListFormat("en", { type: "conjunction" }).format(VOICE_STEERING_BASE_TERMS)} are always included.`

interface SteeringWordsEditorProps {
  setting: "steering-words" | "shared-steering-words"
  /** Copy that depends on state, replacing the registry description. */
  description?: ReactNode
  /** The editable list of steering words. */
  words: string[]
  /** False until the backing store hydrates — writes are blocked so a stray
   *  add/remove can't persist a list built from an empty baseline. */
  ready: boolean
  /** A persist is in flight; actions are disabled. */
  busy: boolean
  /** When false the list renders read-only (no input, no remove buttons). */
  canEdit: boolean
  /** Persist the next list. */
  onChange: (next: string[]) => void
}

/**
 * A dictation steering-word list as its setting's row, for yours and the
 * workspace's. The product terms ({@link VOICE_STEERING_BASE_TERMS}) bias every
 * session whatever the list holds, so they're named once under it and deduped
 * against.
 */
export function SteeringWordsEditor({
  setting,
  description,
  words,
  ready,
  busy,
  canEdit,
  onChange,
}: SteeringWordsEditorProps) {
  const [draft, setDraft] = useState("")
  // A rejected add (duplicate / already baked-in) otherwise just clears the
  // field, which reads as a silent failure: the emptied field says why, in its
  // placeholder, so the chips below never move (INV-21).
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusAfterRemoval = useFocusAfterRemoval()

  const atLimit = words.length >= VOICE_STEERING_WORDS_MAX
  const writable = ready && canEdit && !busy
  let placeholder = notice ? "Already included" : "Add a word"
  if (atLimit) placeholder = "Word limit reached"

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

  const removeWord = (term: string, button: HTMLElement) => {
    if (!writable) return
    focusAfterRemoval(button)
    onChange(words.filter((w) => w !== term))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter or comma commits the current draft as a word.
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      addWord()
    }
  }

  const addField = canEdit ? (
    <div className="flex gap-2">
      <Input
        {...FOCUS_FALLBACK}
        ref={inputRef}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          if (notice) setNotice(null)
        }}
        onKeyDown={handleKeyDown}
        maxLength={VOICE_STEERING_WORD_MAX_LENGTH}
        disabled={!writable || atLimit}
        placeholder={placeholder}
        aria-label="Add a dictation steering word"
        aria-describedby={settingIds(setting).description}
        className={cn(SETTING_CONTROL_HEIGHT, "min-w-0 flex-1")}
      />
      <Button
        type="button"
        variant="outline"
        className={cn(SETTING_CONTROL_HEIGHT, "shrink-0")}
        onClick={addWord}
        disabled={!writable || atLimit || !draft.trim()}
      >
        <Plus className="h-4 w-4" aria-hidden />
        Add
      </Button>
    </div>
  ) : undefined

  return (
    <div {...FOCUS_SCOPE}>
      <SettingRow setting={setting} labelFor={false} description={description} control={addField}>
        {canEdit && (
          <p className="sr-only" aria-live="polite">
            {notice}
          </p>
        )}
        <div className="space-y-2">
          {words.length > 0 && (
            <div className="flex flex-wrap gap-x-2 gap-y-4 sm:gap-2">
              {words.map((term) => (
                <Badge key={term} variant="outline" className="gap-1 pr-1 font-normal">
                  {term}
                  {canEdit ? (
                    <button
                      {...FOCUS_ITEM}
                      type="button"
                      onClick={(event) => removeWord(term, event.currentTarget)}
                      disabled={!writable}
                      className="-my-3 inline-flex size-11 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:-my-1 sm:size-6 [@media(pointer:coarse)]:-my-3 [@media(pointer:coarse)]:size-11"
                      aria-label={`Remove ${term}`}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  ) : null}
                </Badge>
              ))}
            </div>
          )}
          <SettingEmptyNote>
            {words.length === 0 && "No words yet. "}
            {BUILT_IN_NOTE}
          </SettingEmptyNote>
        </div>
      </SettingRow>
    </div>
  )
}
