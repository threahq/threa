import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/** `className` sizes the wrapper; `compact` matches a segmented control's height from `sm` up. */
const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select"> & { compact?: boolean }>(
  ({ className, compact = false, ...props }, ref) => (
    <div className={cn("relative", className)}>
      <select
        ref={ref}
        className={cn(
          compact ? "h-11 sm:h-9 [@media(pointer:coarse)]:h-11" : "h-10",
          "w-full cursor-pointer appearance-none truncate rounded-input border border-input bg-background pl-3 pr-9 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        )}
        {...props}
      />
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  )
)
NativeSelect.displayName = "NativeSelect"

export { NativeSelect }
