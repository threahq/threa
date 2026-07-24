import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
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
// switch to "Keep last" resolves to what the user actually chose, not the stale default.
function chooseDesktopSurface(value: DesktopCallSurface): void {
  setDesktopCallSurface(value)
  if (value !== "keep_last") setLastDesktopSurface(value)
}

const MIRROR_OPTIONS: { value: CallSelfMirror; label: string; description: string }[] = [
  {
    value: "auto",
    label: "Automatic",
    description: "Mirror a front-facing or desktop camera; leave a phone's back camera normal.",
  },
  { value: "on", label: "Always mirror", description: "Always show your self-view mirrored." },
  { value: "off", label: "Never mirror", description: "Always show your self-view the normal way." },
]

const LAYOUT_OPTIONS: { value: CallLayout; label: string; description: string }[] = [
  {
    value: "speaker",
    label: "Speaker",
    description: "One large tile for the active speaker, the rest in a filmstrip.",
  },
  { value: "grid", label: "Grid", description: "Equal-sized tiles for everyone." },
]

const DESKTOP_SURFACE_OPTIONS: { value: DesktopCallSurface; label: string; description: string }[] = [
  { value: "keep_last", label: "Keep last", description: "Reopen calls wherever you last had them." },
  {
    value: "floating",
    label: "Floating square",
    description: "A movable square you can drag anywhere and minimize.",
  },
  { value: "sidebar", label: "Sidebar", description: "Docked down the right side, resizable." },
  { value: "fullscreen", label: "Fullscreen", description: "Fills the desktop area beside navigation." },
]

/**
 * Call preferences (the persisted {@link import("@/stores/call-prefs-store").CallPrefs}).
 * The in-call device menu carries a quick mirror toggle; this is the canonical home.
 */
export function CallSettings() {
  const { selfMirror, layout, desktopCallSurface } = useCallPrefs()
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Mirror my video</h3>
          <p className="text-sm text-muted-foreground">
            Flips your own self-view like a mirror. Only you see it mirrored — everyone else always sees you the normal
            way.
          </p>
        </div>
        <RadioGroup
          value={selfMirror}
          onValueChange={(value) => setCallSelfMirror(value as CallSelfMirror)}
          className="space-y-3"
        >
          {MIRROR_OPTIONS.map((option) => (
            <div key={option.value} className="flex items-start space-x-3">
              <RadioGroupItem value={option.value} id={`mirror-${option.value}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`mirror-${option.value}`} className="cursor-pointer">
                  {option.label}
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
          <h3 className="text-sm font-medium">Default layout</h3>
          <p className="text-sm text-muted-foreground">How a call opens; you can still switch layouts mid-call.</p>
        </div>
        <RadioGroup value={layout} onValueChange={(value) => setCallLayout(value as CallLayout)} className="space-y-3">
          {LAYOUT_OPTIONS.map((option) => (
            <div key={option.value} className="flex items-start space-x-3">
              <RadioGroupItem value={option.value} id={`layout-${option.value}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`layout-${option.value}`} className="cursor-pointer">
                  {option.label}
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
          <h3 className="text-sm font-medium">Desktop video</h3>
          <p className="text-sm text-muted-foreground">Where a call opens on desktop; you can still switch mid-call.</p>
        </div>
        <RadioGroup
          value={desktopCallSurface}
          onValueChange={(value) => chooseDesktopSurface(value as DesktopCallSurface)}
          className="space-y-3"
        >
          {DESKTOP_SURFACE_OPTIONS.map((option) => (
            <div key={option.value} className="flex items-start space-x-3">
              <RadioGroupItem value={option.value} id={`desktop-surface-${option.value}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`desktop-surface-${option.value}`} className="cursor-pointer">
                  {option.label}
                </Label>
                <p className="text-sm text-muted-foreground">{option.description}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>
    </div>
  )
}
