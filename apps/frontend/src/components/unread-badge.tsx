import { RollingNumber } from "@/components/rolling-number"
import { cn } from "@/lib/utils"

interface UnreadBadgeProps {
  count: number
  maxCount?: number
  className?: string
}

export function UnreadBadge({ count, maxCount = 99, className }: UnreadBadgeProps) {
  if (count <= 0) return null

  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground",
        className
      )}
    >
      <RollingNumber value={count} format={(n) => (n > maxCount ? `${maxCount}+` : String(n))} />
    </span>
  )
}
