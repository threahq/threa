import { type ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

/**
 * Two to four short, mutually exclusive options as native radios: arrow keys
 * move between them and Tab leaves the group. `value` of `null` checks none.
 * Four or more segments pair up in a 2×2 grid on phones.
 */
export function SegmentedControl<T extends string>({
  name,
  value,
  options,
  onValueChange,
  disabled,
  className,
  ...aria
}: {
  name: string
  value: T | null
  options: readonly SegmentedOption<T>[]
  onValueChange: (value: T) => void
  disabled?: boolean
  className?: string
  "aria-label"?: string
  "aria-labelledby"?: string
  "aria-describedby"?: string
}) {
  return (
    <div
      role="radiogroup"
      {...aria}
      className={cn(
        "gap-0.5 rounded-lg bg-muted p-0.5",
        options.length > 3 ? "grid grid-cols-2 sm:flex" : "flex flex-wrap",
        className
      )}
    >
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            "flex min-h-11 flex-1 basis-auto cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-transparent px-3 text-sm font-medium text-foreground/70 transition-colors hover:text-foreground sm:min-h-8 [@media(pointer:coarse)]:min-h-11",
            "has-[:checked]:border-foreground/30 has-[:checked]:bg-background has-[:checked]:text-foreground has-[:checked]:shadow-sm",
            "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
            "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 motion-reduce:transition-none"
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled || option.disabled}
            onChange={() => onValueChange(option.value)}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </div>
  )
}
