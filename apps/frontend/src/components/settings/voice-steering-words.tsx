import { usePreferences } from "@/contexts"
import { SteeringWordsEditor } from "./steering-words-editor"

/**
 * The user's personal dictation steering words, unioned at session start with
 * the baked-in product terms and the workspace-shared list.
 */
export function VoiceSteeringWords() {
  const { preferences, updatePreference, isLoading } = usePreferences()
  return (
    <SteeringWordsEditor
      setting="steering-words"
      words={preferences?.voiceSteeringWords ?? []}
      // `preferences` is null until IDB hydrates; block writes until then.
      ready={preferences != null}
      busy={isLoading}
      canEdit
      onChange={(next) => void updatePreference("voiceSteeringWords", next)}
    />
  )
}
