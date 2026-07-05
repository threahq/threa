import { useState, type ReactNode } from "react"
import { Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { formatFutureTime } from "@/lib/dates"

export type CustomDurationUnit = "minutes" | "hours"

export function customDurationToDate(amount: number, unit: CustomDurationUnit, now: Date = new Date()): Date | null {
  if (!Number.isFinite(amount) || amount <= 0) return null
  const minutes = unit === "hours" ? amount * 60 : amount
  const date = new Date(now.getTime() + minutes * 60_000)
  return Number.isNaN(date.getTime()) ? null : date
}

interface CustomDurationPickerProps {
  onSubmit?: (date: Date) => void
  disabled?: boolean
  submitLabel?: string
  showSubmit?: boolean
  className?: string
  controlClassName?: string
  buttonClassName?: string
  initialAmount?: number
  initialUnit?: CustomDurationUnit
  onDurationChange?: (amount: number, unit: CustomDurationUnit) => void
  preview?: false | ((date: Date) => ReactNode)
}

export function CustomDurationPicker({
  onSubmit,
  disabled = false,
  submitLabel = "Set",
  showSubmit = true,
  className,
  controlClassName,
  buttonClassName,
  initialAmount = 30,
  initialUnit = "minutes",
  onDurationChange,
  preview,
}: CustomDurationPickerProps) {
  const [amount, setAmount] = useState(String(initialAmount))
  const [unit, setUnit] = useState<CustomDurationUnit>(initialUnit)
  const parsedAmount = Number(amount)
  const previewDate = customDurationToDate(parsedAmount, unit)
  const validDuration = previewDate !== null
  const canSubmit = !disabled && validDuration
  let previewContent: ReactNode = null
  if (previewDate && preview !== false) {
    previewContent = preview ? preview(previewDate) : formatFutureTime(previewDate, new Date())
  }

  const handleAmountChange = (value: string) => {
    const nextAmount = Number(value)
    setAmount(value)
    onDurationChange?.(nextAmount, unit)
  }

  const handleUnitChange = (value: string) => {
    const nextUnit = value as CustomDurationUnit
    setUnit(nextUnit)
    onDurationChange?.(parsedAmount, nextUnit)
  }

  const submit = () => {
    const date = customDurationToDate(parsedAmount, unit)
    if (!date) return
    onSubmit?.(date)
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 px-2 py-1.5", className)}>
      <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        value={amount}
        onChange={(event) => handleAmountChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onSubmit && canSubmit) submit()
        }}
        aria-label="Custom duration"
        aria-invalid={!validDuration}
        className={cn("h-8 w-16 px-2", controlClassName)}
        disabled={disabled}
      />
      <Select value={unit} onValueChange={handleUnitChange} disabled={disabled}>
        <SelectTrigger aria-label="Duration unit" className={cn("h-8 w-[104px] px-2 text-sm", controlClassName)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="minutes">minutes</SelectItem>
          <SelectItem value="hours">hours</SelectItem>
        </SelectContent>
      </Select>
      {showSubmit && (
        <Button size="sm" className={cn("h-8 px-2 text-xs", buttonClassName)} onClick={submit} disabled={!canSubmit}>
          {submitLabel}
        </Button>
      )}
      {previewContent && <span className="text-xs text-muted-foreground">{previewContent}</span>}
      {!validDuration && <span className="text-xs text-destructive">Enter a positive duration</span>}
    </div>
  )
}
