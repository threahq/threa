import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
import { usePreferences } from "@/contexts"
import { VoiceSteeringWords } from "./voice-steering-words"
import { VOICE_TRANSCRIPTION_MODELS, type VoicePolishLevel } from "@threahq/types"

const VOICE_POLISH_LEVEL_DESCRIPTIONS: ReadonlyArray<{
  value: VoicePolishLevel
  label: string
  description: string
}> = [
  {
    value: "opinionated",
    label: "Opinionated",
    description:
      'Cleans up the most. Drops filler ("uh", "um"), applies self-corrections ("nine, no sorry eight" → "eight"), formats lists, and expands spoken emoji shortcodes.',
  },
  {
    value: "minor",
    label: "Minor",
    description: "Just punctuation, capitalization, and obvious typos. Keeps filler and self-corrections intact.",
  },
  {
    value: "none",
    label: "Off",
    description: "Commits raw transcripts straight to the editor. No model in the loop.",
  },
]

const VOICE_DEFAULT_OPTION_ID = "default"

/**
 * Voice dictation preferences: which speech-to-text provider runs, how
 * aggressively transcripts are polished, and the user's steering words. Grouped
 * in their own settings tab, separate from the scratchpad/AI guidance.
 */
export function DictationSettings() {
  const { preferences, updatePreference, isLoading } = usePreferences()

  const savedVoiceModel = preferences?.voiceTranscriptionModel ?? null
  const voiceSelection = savedVoiceModel ?? VOICE_DEFAULT_OPTION_ID
  const handleVoiceModelChange = (value: string) => {
    const next = value === VOICE_DEFAULT_OPTION_ID ? null : value
    if (next === savedVoiceModel) {
      return
    }
    void updatePreference("voiceTranscriptionModel", next)
  }

  // Default to "opinionated" so a missing preference (new account, in-flight
  // bootstrap) still reflects the opt-out stance — the user actively dials
  // polish down rather than discovers it was silently weak.
  const polishLevel: VoicePolishLevel = preferences?.voicePolishLevel ?? "opinionated"
  const handlePolishLevelChange = (value: string) => {
    const next = value as VoicePolishLevel
    if (next === polishLevel) return
    void updatePreference("voicePolishLevel", next)
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Voice Dictation Model</h3>
          <p className="text-sm text-muted-foreground">
            Choose which speech-to-text provider Threa uses when you dictate a message.
          </p>
        </div>
        <RadioGroup
          value={voiceSelection}
          onValueChange={handleVoiceModelChange}
          aria-label="Voice dictation model"
          className="space-y-3"
        >
          <div className="flex items-start space-x-3">
            <RadioGroupItem value={VOICE_DEFAULT_OPTION_ID} id="voice-model-default" className="mt-1" />
            <div className="grid gap-1">
              <Label htmlFor="voice-model-default" className="cursor-pointer">
                Use server default
              </Label>
              <p className="text-sm text-muted-foreground">
                Let Threa pick the provider. We currently default to ElevenLabs Scribe v2.
              </p>
            </div>
          </div>
          {VOICE_TRANSCRIPTION_MODELS.map((option) => (
            <div key={option.id} className="flex items-start space-x-3">
              <RadioGroupItem value={option.id} id={`voice-model-${option.id}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`voice-model-${option.id}`} className="cursor-pointer">
                  {option.name}
                </Label>
                <p className="text-sm text-muted-foreground">{option.description}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Polish dictated text</h3>
          <p className="text-sm text-muted-foreground">
            How aggressively a small, fast model rewrites your dictation before it lands in the editor. You can still
            flip "Show original" on the live session to compare.
          </p>
        </div>
        <RadioGroup
          value={polishLevel}
          onValueChange={handlePolishLevelChange}
          aria-label="Polish dictated text"
          className="space-y-3"
        >
          {VOICE_POLISH_LEVEL_DESCRIPTIONS.map((option) => (
            <div key={option.value} className="flex items-start space-x-3">
              <RadioGroupItem
                value={option.value}
                id={`voice-polish-${option.value}`}
                className="mt-1"
                disabled={isLoading}
              />
              <div className="grid gap-1">
                <Label htmlFor={`voice-polish-${option.value}`} className="cursor-pointer">
                  {option.label}
                </Label>
                <p className="text-sm text-muted-foreground">{option.description}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      <VoiceSteeringWords />
    </div>
  )
}
