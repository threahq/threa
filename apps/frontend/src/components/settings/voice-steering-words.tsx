import { usePreferences } from "@/contexts"
import { VOICE_STEERING_BASE_TERMS } from "@threa/types"
import { SteeringWordsEditor } from "./steering-words-editor"

const BAKED_IN_LABEL = VOICE_STEERING_BASE_TERMS.join(", ")

/**
 * The user's personal dictation steering words, edited in the AI settings tab.
 * Unioned at session start with the baked-in product terms and the
 * workspace-shared list.
 */
export function VoiceSteeringWords() {
  const { preferences, updatePreference, isLoading } = usePreferences()
  return (
    <SteeringWordsEditor
      title="Dictation steering words"
      description={
        <>
          Custom spellings the dictation model is nudged toward, so product names, people, and jargon come out right
          instead of a similar-sounding word. {BAKED_IN_LABEL} are always included.
        </>
      }
      words={preferences?.voiceSteeringWords ?? []}
      // `preferences` is null until IDB hydrates; block writes until then.
      ready={preferences != null}
      busy={isLoading}
      canEdit
      onChange={(next) => void updatePreference("voiceSteeringWords", next)}
    />
  )
}
