import type { ReactNode } from "react"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"

interface FieldRowProps {
  label: string
  htmlFor?: string
  description?: string
  overridden: boolean
  onReset: () => void
  disabled?: boolean
  children: ReactNode
}

/**
 * One editor field with its overridden-vs-default indicator and a per-field
 * reset-to-default control. The reset button holds its footprint whether or not
 * the field is overridden (INV-21 — no layout shift) and is disabled when the
 * value already matches the default.
 */
export function FieldRow({ label, htmlFor, description, overridden, onReset, disabled, children }: FieldRowProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Label htmlFor={htmlFor} className="text-sm font-medium">
              {label}
            </Label>
            {overridden && (
              <span className="text-[11px] font-normal text-amber-600 dark:text-amber-500">Customized</span>
            )}
          </div>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
          onClick={onReset}
          disabled={disabled || !overridden}
          aria-label={`Reset ${label}`}
        >
          <RotateCcw className="mr-1 h-3 w-3" />
          Reset
        </Button>
      </div>
      {children}
    </div>
  )
}
