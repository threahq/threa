import { usePreferences } from "@/contexts"
import {
  DEFAULT_ACCESSIBILITY,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_OPTIONS,
  MESSAGE_DISPLAY_OPTIONS,
  THEME_OPTIONS,
  type FontFamily,
  type FontSize,
} from "@threahq/types"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { MESSAGE_ROW_CONTINUATION_PADDING, MESSAGE_ROW_HEAD_PADDING } from "@/components/message/message-row-layout"
import { cn } from "@/lib/utils"
import { ChoiceSetting, SettingsSection, SwitchSetting, type ChoiceOption } from "./setting-primitives"
import { SETTING_CHOICE_LABELS } from "./settings-registry"

const FONT_SIZE_CHOICES: Record<FontSize, string> = { small: "Small", medium: "Medium", large: "Large" }

export const FONT_FAMILY_CHOICES: Record<FontFamily, Omit<ChoiceOption<FontFamily>, "value">> = {
  system: { label: "Default", description: "Switzer, Threa's own font." },
  monospace: { label: "Monospace", description: "Every character the same width." },
  dyslexic: { label: "OpenDyslexic", description: "Weighted letter shapes that are harder to flip or swap." },
}

function choices<T extends string>(values: readonly T[], labels: Record<T, string>): ChoiceOption<T>[] {
  return values.map((value) => ({ value, label: labels[value] }))
}

const PREVIEW_MESSAGES = [
  { initials: "MO", name: "Maya Okafor", minutes: 9 * 60 + 41, text: "Launch notes are in the doc. Anything missing?" },
  { initials: null, name: "Maya Okafor", minutes: 9 * 60 + 41, text: "The pricing table still needs a final look." },
] as const

/**
 * A few message rows built from the timeline's own classes and row rhythm, so the
 * settings applied to the page (theme, density, text size and font) show here as
 * they change. Decorative: the controls carry the state.
 */
function MessagePreview() {
  const { formatTime } = useFormattedDate()
  return (
    <div
      aria-hidden
      data-testid="appearance-preview"
      className="pointer-events-none select-none overflow-hidden rounded-md border bg-background pb-2.5"
    >
      {PREVIEW_MESSAGES.map((message, index) => (
        <div
          key={index}
          className={cn(
            "message-item flex gap-3 px-4",
            message.initials ? MESSAGE_ROW_HEAD_PADDING : MESSAGE_ROW_CONTINUATION_PADDING
          )}
        >
          {message.initials ? (
            <span className="message-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-xs font-semibold text-primary">
              {message.initials}
            </span>
          ) : (
            <span className="message-avatar-spacer w-8 shrink-0" />
          )}
          <div className="message-content min-w-0 flex-1">
            {message.initials && (
              <div className="mb-0.5 flex items-baseline gap-2">
                <span className="text-sm font-semibold">{message.name}</span>
                <span className="text-xs text-muted-foreground">
                  {formatTime(new Date(2000, 0, 1, Math.floor(message.minutes / 60), message.minutes % 60))}
                </span>
              </div>
            )}
            <p className="text-sm leading-relaxed">{message.text}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

export function AppearanceSettings() {
  const { preferences, updatePreference, updateAccessibility } = usePreferences()
  // Spread over the defaults rather than replacing them: preferences come from
  // the IDB cache, so a blob written before a field existed carries an
  // `accessibility` object missing it, and the control would render unset.
  const accessibility = { ...DEFAULT_ACCESSIBILITY, ...preferences?.accessibility }

  return (
    <div className="space-y-8">
      <SettingsSection section="theme">
        <ChoiceSetting
          setting="theme"
          value={preferences?.theme ?? "system"}
          options={choices(THEME_OPTIONS, SETTING_CHOICE_LABELS.theme)}
          onValueChange={(value) => updatePreference("theme", value)}
        />
        <ChoiceSetting
          setting="density"
          value={preferences?.messageDisplay ?? "comfortable"}
          options={choices(MESSAGE_DISPLAY_OPTIONS, SETTING_CHOICE_LABELS.density)}
          onValueChange={(value) => updatePreference("messageDisplay", value)}
        />
      </SettingsSection>

      <SettingsSection section="text">
        <ChoiceSetting
          setting="font-size"
          value={accessibility.fontSize}
          options={choices(FONT_SIZE_OPTIONS, FONT_SIZE_CHOICES)}
          onValueChange={(value) => updateAccessibility({ fontSize: value })}
        />
        <ChoiceSetting
          setting="font-family"
          value={accessibility.fontFamily}
          options={FONT_FAMILY_OPTIONS.map((value) => ({ value, ...FONT_FAMILY_CHOICES[value] }))}
          variant="select"
          onValueChange={(value) => updateAccessibility({ fontFamily: value })}
        >
          <MessagePreview />
        </ChoiceSetting>
      </SettingsSection>

      <SettingsSection section="comfort">
        <SwitchSetting
          setting="reduce-motion"
          checked={accessibility.reducedMotion}
          onCheckedChange={(checked) => updateAccessibility({ reducedMotion: checked })}
        />
        <SwitchSetting
          setting="high-contrast"
          checked={accessibility.highContrast}
          onCheckedChange={(checked) => updateAccessibility({ highContrast: checked })}
        />
      </SettingsSection>
    </div>
  )
}
