import { usePreferences } from "@/contexts"
import { VOICE_TRANSCRIPTION_MODELS, type VoicePolishLevel } from "@threahq/types"
import { ChoiceSetting, SettingsSection, type ChoiceOption } from "./setting-primitives"
import { VoiceSteeringWords } from "./voice-steering-words"

const VOICE_DEFAULT_OPTION_ID = "default"

export const MODEL_OPTIONS: ChoiceOption<string>[] = [
  {
    value: VOICE_DEFAULT_OPTION_ID,
    label: "Automatic",
    description: "Threa picks the model. Currently ElevenLabs Scribe v2.",
  },
  ...VOICE_TRANSCRIPTION_MODELS.map((model) => ({
    value: model.id,
    label: model.name,
    description: model.description,
  })),
]

export const POLISH_OPTIONS: ChoiceOption<VoicePolishLevel>[] = [
  {
    value: "opinionated",
    label: "Full",
    description: "Removes filler, applies spoken corrections and formats lists. “Show original” undoes it.",
  },
  {
    value: "minor",
    label: "Light",
    description: "Fixes punctuation, capitals and typos. “Show original” undoes it.",
  },
  { value: "none", label: "Off", description: "Text arrives as transcribed." },
]

export function DictationSettings() {
  const { preferences, updatePreference, isLoading } = usePreferences()

  const savedVoiceModel = preferences?.voiceTranscriptionModel ?? null
  const handleVoiceModelChange = (value: string) => {
    const next = value === VOICE_DEFAULT_OPTION_ID ? null : value
    if (next === savedVoiceModel) return
    void updatePreference("voiceTranscriptionModel", next)
  }

  // Default to "opinionated" so a missing preference (new account, in-flight
  // bootstrap) still reflects the opt-out stance — the user actively dials
  // polish down rather than discovers it was silently weak.
  const polishLevel: VoicePolishLevel = preferences?.voicePolishLevel ?? "opinionated"
  const handlePolishLevelChange = (next: VoicePolishLevel) => {
    if (next === polishLevel) return
    void updatePreference("voicePolishLevel", next)
  }

  return (
    <SettingsSection section="dictation">
      <ChoiceSetting
        setting="dictation-polish"
        value={polishLevel}
        options={POLISH_OPTIONS}
        onValueChange={handlePolishLevelChange}
        variant="segmented"
        disabled={isLoading}
      />
      <VoiceSteeringWords />
      <ChoiceSetting
        setting="dictation-model"
        value={savedVoiceModel ?? VOICE_DEFAULT_OPTION_ID}
        options={MODEL_OPTIONS}
        onValueChange={handleVoiceModelChange}
        variant="select"
      />
    </SettingsSection>
  )
}
