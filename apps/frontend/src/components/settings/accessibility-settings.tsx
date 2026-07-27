import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { usePreferences } from "@/contexts"
import {
  FONT_SIZE_OPTIONS,
  FONT_FAMILY_OPTIONS,
  COMPOSER_ACTION_SIDE_OPTIONS,
  DEFAULT_ACCESSIBILITY,
  type FontSize,
  type FontFamily,
  type ComposerActionSide,
} from "@threa/types"

const FONT_SIZE_LABELS: Record<FontSize, string> = {
  small: "Small (14px)",
  medium: "Medium (16px)",
  large: "Large (18px)",
}

const FONT_FAMILY_LABELS: Record<FontFamily, string> = {
  system: "Default",
  monospace: "Monospace",
  dyslexic: "OpenDyslexic",
}

const COMPOSER_ACTION_SIDE_LABELS: Record<ComposerActionSide, string> = {
  right: "Right",
  left: "Left",
}

const COMPOSER_ACTION_SIDE_DESCRIPTIONS: Record<ComposerActionSide, string> = {
  right: "Send sits at the right end of the composer, after the other controls",
  left: "Mirrors the row so Send sits at the left end, within reach of a left thumb",
}

const FONT_FAMILY_DESCRIPTIONS: Record<FontFamily, string> = {
  system: "Clean, readable font for everyday use",
  monospace: "Fixed-width font for code-like appearance",
  dyslexic: "Designed to improve readability for dyslexic readers",
}

export function AccessibilitySettings() {
  const { preferences, updateAccessibility } = usePreferences()

  // Spread over the defaults rather than replacing them: preferences come from
  // the IDB cache, so a blob written before a field existed carries an
  // `accessibility` object missing it, and the control would render unset.
  const accessibility = { ...DEFAULT_ACCESSIBILITY, ...preferences?.accessibility }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Motion</h3>
          <p className="text-sm text-muted-foreground">Control animations and transitions</p>
        </div>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label htmlFor="reduced-motion">Reduce motion</Label>
            <p className="text-sm text-muted-foreground">Minimize animations throughout the interface</p>
          </div>
          <Switch
            id="reduced-motion"
            checked={accessibility.reducedMotion}
            onCheckedChange={(checked) => updateAccessibility({ reducedMotion: checked })}
          />
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Contrast</h3>
          <p className="text-sm text-muted-foreground">Adjust visual contrast</p>
        </div>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label htmlFor="high-contrast">High contrast</Label>
            <p className="text-sm text-muted-foreground">Increase contrast for better visibility</p>
          </div>
          <Switch
            id="high-contrast"
            checked={accessibility.highContrast}
            onCheckedChange={(checked) => updateAccessibility({ highContrast: checked })}
          />
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Composer actions</h3>
          <p className="text-sm text-muted-foreground">Which end of the composer holds the Send button</p>
        </div>
        <RadioGroup
          value={accessibility.composerActionSide}
          onValueChange={(value) => updateAccessibility({ composerActionSide: value as ComposerActionSide })}
          className="space-y-4"
        >
          {COMPOSER_ACTION_SIDE_OPTIONS.map((option) => (
            <div key={option} className="flex items-start space-x-3">
              <RadioGroupItem value={option} id={`composer-action-side-${option}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`composer-action-side-${option}`} className="cursor-pointer">
                  {COMPOSER_ACTION_SIDE_LABELS[option]}
                </Label>
                <p className="text-sm text-muted-foreground">{COMPOSER_ACTION_SIDE_DESCRIPTIONS[option]}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Font Size</h3>
          <p className="text-sm text-muted-foreground">Adjust the base font size</p>
        </div>
        <RadioGroup
          value={accessibility.fontSize}
          onValueChange={(value) => updateAccessibility({ fontSize: value as FontSize })}
          className="space-y-3"
        >
          {FONT_SIZE_OPTIONS.map((option) => (
            <div key={option} className="flex items-center space-x-3">
              <RadioGroupItem value={option} id={`font-size-${option}`} />
              <Label htmlFor={`font-size-${option}`} className="cursor-pointer">
                {FONT_SIZE_LABELS[option]}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Font Family</h3>
          <p className="text-sm text-muted-foreground">Choose your preferred font</p>
        </div>
        <RadioGroup
          value={accessibility.fontFamily}
          onValueChange={(value) => updateAccessibility({ fontFamily: value as FontFamily })}
          className="space-y-4"
        >
          {FONT_FAMILY_OPTIONS.map((option) => (
            <div key={option} className="flex items-start space-x-3">
              <RadioGroupItem value={option} id={`font-family-${option}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`font-family-${option}`} className="cursor-pointer">
                  {FONT_FAMILY_LABELS[option]}
                </Label>
                <p className="text-sm text-muted-foreground">{FONT_FAMILY_DESCRIPTIONS[option]}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>
    </div>
  )
}
