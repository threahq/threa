import { useRef, useState, type KeyboardEvent } from "react"
import { Plus, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { usePreferences } from "@/contexts"
import { VOICE_STEERING_BASE_TERMS, VOICE_STEERING_WORDS_MAX, VOICE_STEERING_WORD_MAX_LENGTH } from "@threa/types"

const BAKED_IN_LABEL = VOICE_STEERING_BASE_TERMS.join(", ")

/**
 * Editor for the user's custom dictation steering words. Words are biased into
 * the transcription model (and reinforced in the polish pass) so product names,
 * people, and jargon aren't mis-transcribed. The product's own names
 * ({@link VOICE_STEERING_BASE_TERMS}) are always applied on top server-side and
 * shown here as read-only chips so the user knows not to re-add them.
 */
export function VoiceSteeringWords() {
  const { preferences, updatePreference, isLoading } = usePreferences()
  const words = preferences?.voiceSteeringWords ?? []
  const [draft, setDraft] = useState("")
  // A rejected add (duplicate / already baked-in) otherwise just clears the
  // field, which reads as a silent failure — surface the reason instead.
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const atLimit = words.length >= VOICE_STEERING_WORDS_MAX

  const addWord = () => {
    const term = draft.trim()
    if (!term || isLoading || atLimit) return
    // Dedupe case-insensitively against both the user's list and the baked-in
    // terms — re-adding "Threa" is a no-op, not a duplicate chip.
    const existing = new Set([...words, ...VOICE_STEERING_BASE_TERMS].map((w) => w.toLowerCase()))
    if (existing.has(term.toLowerCase())) {
      setNotice(`"${term}" is already included.`)
      setDraft("")
      inputRef.current?.focus()
      return
    }
    setNotice(null)
    void updatePreference("voiceSteeringWords", [...words, term.slice(0, VOICE_STEERING_WORD_MAX_LENGTH)])
    setDraft("")
    // Tag entry is a rapid-fire gesture; keep the caret in the field so a
    // mouse user clicking "Add" can keep typing without re-clicking.
    inputRef.current?.focus()
  }

  const removeWord = (term: string) => {
    if (isLoading) return
    void updatePreference(
      "voiceSteeringWords",
      words.filter((w) => w !== term)
    )
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
        <h3 className="text-sm font-medium">Dictation steering words</h3>
        <p className="text-sm text-muted-foreground">
          Custom spellings the dictation model is nudged toward, so product names, people, and jargon come out right
          instead of a similar-sounding word. {BAKED_IN_LABEL} are always included.
        </p>
      </div>

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
          disabled={isLoading || atLimit}
          placeholder={atLimit ? "Word limit reached" : "Add a word or name, then press Enter"}
          aria-label="Add a dictation steering word"
        />
        <Button type="button" variant="outline" onClick={addWord} disabled={isLoading || atLimit || !draft.trim()}>
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>

      {/* Reserved line so showing/clearing the notice doesn't shift the chips (INV-21). */}
      <p className="min-h-[1rem] text-xs text-muted-foreground" aria-live="polite">
        {notice}
      </p>

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
            <button
              type="button"
              onClick={() => removeWord(term)}
              disabled={isLoading}
              className="rounded-full p-1.5 hover:bg-muted disabled:opacity-50"
              aria-label={`Remove ${term}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
    </section>
  )
}
