import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
import { TimezonePicker } from "@/components/ui/timezone-picker"
import { usePreferences } from "@/contexts"
import { DATE_FORMAT_OPTIONS, TIME_FORMAT_OPTIONS, type DateFormat, type TimeFormat } from "@threahq/types"

const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  "YYYY-MM-DD": "2025-01-15 (ISO)",
  "DD/MM/YYYY": "15/01/2025 (European)",
  "MM/DD/YYYY": "01/15/2025 (US)",
}

const TIME_FORMAT_LABELS: Record<TimeFormat, string> = {
  "24h": "14:30 (24-hour)",
  "12h": "2:30 PM (12-hour)",
}

export function DateTimeSettings() {
  const { preferences, updatePreference } = usePreferences()

  const dateFormat = preferences?.dateFormat ?? "YYYY-MM-DD"
  const timeFormat = preferences?.timeFormat ?? "24h"
  const timezone = preferences?.timezone ?? "UTC"
  const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Date Format</h3>
          <p className="text-sm text-muted-foreground">Choose how dates are displayed</p>
        </div>
        <RadioGroup
          value={dateFormat}
          onValueChange={(value) => updatePreference("dateFormat", value as DateFormat)}
          className="space-y-3"
        >
          {DATE_FORMAT_OPTIONS.map((option) => (
            <div key={option} className="flex items-center space-x-3">
              <RadioGroupItem value={option} id={`date-${option}`} />
              <Label htmlFor={`date-${option}`} className="cursor-pointer font-mono">
                {DATE_FORMAT_LABELS[option]}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Time Format</h3>
          <p className="text-sm text-muted-foreground">Choose how times are displayed</p>
        </div>
        <RadioGroup
          value={timeFormat}
          onValueChange={(value) => updatePreference("timeFormat", value as TimeFormat)}
          className="space-y-3"
        >
          {TIME_FORMAT_OPTIONS.map((option) => (
            <div key={option} className="flex items-center space-x-3">
              <RadioGroupItem value={option} id={`time-${option}`} />
              <Label htmlFor={`time-${option}`} className="cursor-pointer font-mono">
                {TIME_FORMAT_LABELS[option]}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Home Timezone</h3>
          <p className="text-sm text-muted-foreground">
            Your home timezone is shown to colleagues and used for time-aware features. Times in the UI are displayed in
            your device's local timezone.
          </p>
        </div>
        <div className="space-y-2">
          <Label>Timezone</Label>
          <TimezonePicker value={timezone} onChange={(tz) => updatePreference("timezone", tz)} />
        </div>
        <p className="text-sm text-muted-foreground">
          Your device is set to <span className="font-mono">{detectedTimezone}</span>
        </p>
      </section>
    </div>
  )
}
