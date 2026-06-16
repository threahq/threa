import { useState, useEffect } from "react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useFormattedDate } from "@/hooks"

interface RelativeTimeProps {
  date: Date | string | null | undefined
  className?: string
  /**
   * Use the terse formatter ("now", "2m ago", "5h ago", "yesterday")
   * instead of the default verbose one ("yesterday 14:30", "Monday 2:30 PM").
   * Preferred for compact surfaces like thread cards and activity feeds.
   */
  terse?: boolean
}

export function RelativeTime({ date, className, terse }: RelativeTimeProps) {
  const [, setTick] = useState(0)
  const { formatRelative, formatFull } = useFormattedDate()

  // Update every minute to keep relative times fresh
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(interval)
  }, [])

  if (!date) {
    return <span className={className}>--</span>
  }

  const dateObj = date instanceof Date ? date : new Date(date)
  const isValid = dateObj instanceof Date && !isNaN(dateObj.getTime())

  if (!isValid) {
    return <span className={className}>--</span>
  }

  const relative = formatRelative(dateObj, undefined, terse ? { terse: true } : undefined)
  const full = formatFull(dateObj)

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <span className={className}>{relative}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{full}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
