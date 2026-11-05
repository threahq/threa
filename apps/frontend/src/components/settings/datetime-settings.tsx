import { useMemo } from "react"
import { TimezonePicker, formatTimezoneLabel } from "@/components/ui/timezone-picker"
import { usePreferences } from "@/contexts"
import { DATE_FORMAT_OPTIONS, TIME_FORMAT_OPTIONS, type DateFormat, type TimeFormat } from "@threahq/types"
import {
  ChoiceSetting,
  SETTING_CONTROL_CLASS,
  SettingRow,
  SettingStateAction,
  SettingsSection,
  settingIds,
  type ChoiceOption,
} from "./setting-primitives"
import { settingDef } from "./settings-registry"

const CLOCK_CHOICES: Record<TimeFormat, string> = { "24h": "14:30", "12h": "2:30 PM" }

export const DATE_FORMAT_CHOICES: Record<DateFormat, Omit<ChoiceOption<DateFormat>, "value">> = {
  "YYYY-MM-DD": { label: "2026-01-31", description: "Year first (ISO 8601)." },
  "DD/MM/YYYY": { label: "31/01/2026", description: "Day first." },
  "MM/DD/YYYY": { label: "01/31/2026", description: "Month first." },
}

export function DateTimeSettings() {
  const { preferences, updatePreference } = usePreferences()
  const timezone = preferences?.timezone ?? "UTC"
  const deviceTimezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])
  const ids = settingIds("timezone")
  const deviceNoteId = `${ids.control}-device`

  const adoptDeviceTimezone = () => {
    void updatePreference("timezone", deviceTimezone)
    // The button goes away once the zones match; keep focus on the setting.
    document.getElementById(ids.row)?.focus()
  }

  return (
    <SettingsSection section="time-format">
      <SettingRow
        setting="timezone"
        labelFor={false}
        control={
          <TimezonePicker
            id={ids.control}
            value={timezone}
            onChange={(tz) => updatePreference("timezone", tz)}
            className={SETTING_CONTROL_CLASS}
            aria-labelledby={ids.label}
            aria-describedby={
              [settingDef("timezone").description && ids.description, deviceTimezone !== timezone && deviceNoteId]
                .filter(Boolean)
                .join(" ") || undefined
            }
          />
        }
      >
        {deviceTimezone !== timezone && (
          <SettingStateAction
            id={deviceNoteId}
            action={{ onClick: adoptDeviceTimezone, children: "Use this device's time zone" }}
          >
            This device is on <span className="text-foreground">{formatTimezoneLabel(deviceTimezone)}</span>.
          </SettingStateAction>
        )}
      </SettingRow>
      <ChoiceSetting
        setting="time-format"
        value={preferences?.timeFormat ?? "24h"}
        options={TIME_FORMAT_OPTIONS.map((value) => ({ value, label: CLOCK_CHOICES[value] }))}
        onValueChange={(value) => updatePreference("timeFormat", value)}
      />
      <ChoiceSetting
        setting="date-format"
        value={preferences?.dateFormat ?? "YYYY-MM-DD"}
        options={DATE_FORMAT_OPTIONS.map((value) => ({ value, ...DATE_FORMAT_CHOICES[value] }))}
        variant="select"
        onValueChange={(value) => updatePreference("dateFormat", value)}
      />
    </SettingsSection>
  )
}
