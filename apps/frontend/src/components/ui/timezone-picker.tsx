import { useCallback, useMemo } from "react"
import { Check } from "lucide-react"
import { CommandItem } from "@/components/ui/command"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { cn } from "@/lib/utils"

/**
 * Get all IANA timezone identifiers.
 * Falls back to a minimal list if Intl.supportedValuesOf is unavailable.
 */
export function getAvailableTimezones(): string[] {
  if (typeof Intl !== "undefined" && "supportedValuesOf" in Intl) {
    return (Intl as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf("timeZone")
  }
  return ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Stockholm", "Asia/Tokyo"]
}

/**
 * Get the UTC offset string for a timezone (e.g., "UTC+1", "UTC-5").
 */
export function getUtcOffset(timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
    })
    const parts = formatter.formatToParts(new Date())
    const offsetPart = parts.find((p) => p.type === "timeZoneName")
    if (offsetPart?.value) {
      const offset = offsetPart.value.replace("GMT", "UTC")
      return offset === "UTC" ? "UTC+0" : offset
    }
  } catch {
    // Invalid timezone
  }
  return "UTC+0"
}

/**
 * Format timezone for display: "Europe/Stockholm (UTC+1)"
 */
export function formatTimezoneLabel(timezone: string): string {
  const offset = getUtcOffset(timezone)
  const displayName = timezone.replace(/_/g, " ")
  return `${displayName} (${offset})`
}

interface TimezonePickerProps {
  value: string
  onChange: (timezone: string) => void
  disabled?: boolean
}

export function TimezonePicker({ value, onChange, disabled }: TimezonePickerProps) {
  const detectedTimezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])
  const timezones = useMemo(() => getAvailableTimezones(), [])
  // Precompute the formatted label for every timezone once. formatTimezoneLabel
  // spins up a fresh Intl.DateTimeFormat per call, and this list has 400+
  // entries — caching keeps every keystroke during search cheap.
  const labelByTz = useMemo(() => {
    const map = new Map<string, string>()
    for (const tz of timezones) map.set(tz, formatTimezoneLabel(tz))
    return map
  }, [timezones])
  const labelFor = useCallback((tz: string) => labelByTz.get(tz) ?? formatTimezoneLabel(tz), [labelByTz])

  return (
    <SearchableSelect
      items={timezones}
      value={value}
      onChange={onChange}
      disabled={disabled}
      getKey={(tz) => tz}
      getKeywords={(tz) => [tz, tz.replace(/_/g, " "), labelFor(tz)]}
      searchPlaceholder="Search timezone..."
      emptyMessage="No timezone found."
      renderSelected={(tz) => <span className="font-mono">{labelFor(tz)}</span>}
      renderItem={(tz, isSelected) => (
        <>
          <Check className={cn("mr-2 h-4 w-4", isSelected ? "opacity-100" : "opacity-0")} />
          <span className="font-mono">{labelFor(tz)}</span>
        </>
      )}
      prefixContent={({ close }) =>
        detectedTimezone !== value ? (
          <CommandItem
            value={`device-${detectedTimezone}`}
            onSelect={() => {
              onChange(detectedTimezone)
              close()
            }}
            className="font-medium"
          >
            <Check className="mr-2 h-4 w-4 opacity-0" aria-hidden="true" />
            <span className="font-mono">{labelFor(detectedTimezone)}</span>
            <span className="ml-2 text-muted-foreground">(device)</span>
          </CommandItem>
        ) : null
      }
    />
  )
}
