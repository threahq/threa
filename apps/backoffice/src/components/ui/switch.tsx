import * as React from "react"

import { cn } from "@/lib/utils"

const Switch = React.forwardRef<HTMLInputElement, Omit<React.ComponentProps<"input">, "type" | "role">>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      role="switch"
      className={cn(
        "relative h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-full bg-[hsl(30_8%_52%)] transition-colors dark:bg-[hsl(30_8%_45%)]",
        "before:absolute before:left-0.5 before:top-0.5 before:size-5 before:rounded-full before:bg-background before:shadow before:transition-transform",
        "checked:bg-control checked:before:translate-x-5 dark:checked:bg-control",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:before:transition-none",
        className
      )}
      {...props}
    />
  )
)
Switch.displayName = "Switch"

export { Switch }
