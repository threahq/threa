import { ChoiceSetting, SettingsSection, type ChoiceOption } from "./setting-primitives"
import { SETTING_CHOICE_LABELS } from "./settings-registry"
import {
  setCallLayout,
  setCallSelfMirror,
  setDesktopCallSurface,
  setLastDesktopSurface,
  useCallPrefs,
  type CallLayout,
  type CallSelfMirror,
  type DesktopCallSurface,
} from "@/stores/call-prefs-store"

// Picking an explicit surface in settings also seeds `lastDesktopSurface`, so a later
// switch to "Where you left it" resolves to what the user actually chose, not the stale default.
function chooseDesktopSurface(value: DesktopCallSurface): void {
  setDesktopCallSurface(value)
  if (value !== "keep_last") setLastDesktopSurface(value)
}

export const MIRROR_OPTIONS: ChoiceOption<CallSelfMirror>[] = [
  { value: "auto", label: "Automatic", description: "On front and desktop cameras, not a phone's back camera." },
  { value: "on", label: "Always", description: "On every camera." },
  { value: "off", label: "Never" },
]

export const LAYOUT_OPTIONS: ChoiceOption<CallLayout>[] = [
  { value: "speaker", label: "Speaker", description: "One large tile for whoever is talking, the rest in a strip." },
  { value: "grid", label: "Grid", description: "Every tile the same size." },
]

const DESKTOP_SURFACE_LABELS = SETTING_CHOICE_LABELS["call-desktop-video"]

export const DESKTOP_SURFACE_OPTIONS: ChoiceOption<DesktopCallSurface>[] = [
  { value: "keep_last", label: DESKTOP_SURFACE_LABELS.keep_last },
  { value: "floating", label: DESKTOP_SURFACE_LABELS.floating, description: "Drag it anywhere, or minimize it." },
  {
    value: "sidebar",
    label: DESKTOP_SURFACE_LABELS.sidebar,
    description: "Docked on the right. Drag its edge to resize.",
  },
  { value: "fullscreen", label: DESKTOP_SURFACE_LABELS.fullscreen, description: "Fills the space beside navigation." },
]

/**
 * Call preferences (the persisted {@link import("@/stores/call-prefs-store").CallPrefs}).
 * The in-call device menu carries a quick mirror toggle; this is the canonical home.
 */
export function CallSettings() {
  const { selfMirror, layout, desktopCallSurface } = useCallPrefs()
  return (
    <SettingsSection section="calls">
      <ChoiceSetting
        setting="call-layout"
        variant="segmented"
        value={layout}
        options={LAYOUT_OPTIONS}
        onValueChange={setCallLayout}
      />
      <ChoiceSetting
        setting="call-desktop-video"
        variant="select"
        value={desktopCallSurface}
        options={DESKTOP_SURFACE_OPTIONS}
        onValueChange={chooseDesktopSurface}
      />
      <ChoiceSetting
        setting="call-mirror"
        variant="segmented"
        value={selfMirror}
        options={MIRROR_OPTIONS}
        onValueChange={setCallSelfMirror}
      />
    </SettingsSection>
  )
}
