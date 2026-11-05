import { useId, type ReactNode } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  DisabledReason,
  SETTING_CONTROL_HEIGHT,
  SettingRemoveButton,
  SETTING_ITEM_DIVIDERS,
} from "./setting-primitives"
import { SETTING_MUTED_NOTE_TEXT } from "./setting-text"
import { FOCUS_FALLBACK, FOCUS_ITEM, FOCUS_SCOPE, useFocusAfterRemoval } from "./use-focus-after-removal"

export interface CheckboxListItem<T extends string> {
  value: T
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  /** Why it can't be picked, under its description; the checkbox is disabled and described by it. */
  reason?: ReactNode
  /** Further ids describing its checkbox, such as a note about the list as a whole. */
  describedBy?: string
}

const CHECKBOX_BLEED = {
  card: "-mx-4 px-4",
  inset: "-mx-2 rounded-md px-2",
} as const

export type SettingCheckboxBleed = keyof typeof CHECKBOX_BLEED

/**
 * A multi-select as a plain list of checkboxes, each with its label and an
 * optional note-size description; the whole item toggles it. In a row or
 * disclosure body its hover runs edge to edge of the card (`bleed="card"`);
 * in a padded panel outside a card it stays a rounded highlight (`"inset"`).
 */
export function SettingCheckboxList<T extends string>({
  items,
  selected,
  onCheckedChange,
  disabled = false,
  bleed = "card",
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: {
  items: readonly CheckboxListItem<T>[]
  selected: ReadonlySet<T> | readonly T[]
  onCheckedChange: (value: T, checked: boolean) => void
  /** Every item, such as while what it saves to is still loading. */
  disabled?: boolean
  bleed?: SettingCheckboxBleed
  "aria-labelledby": string
  "aria-describedby"?: string
}) {
  const prefix = useId()
  const isSelected = (value: T) => ("has" in selected ? selected.has(value) : selected.includes(value))
  return (
    <ul role="group" aria-labelledby={labelledBy} aria-describedby={describedBy}>
      {items.map((item) => {
        const id = `${prefix}-${item.value}`
        const itemDisabled = disabled || !!item.disabled || !!item.reason
        return (
          <li key={item.value}>
            <label
              htmlFor={id}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 py-2 transition-colors hover:bg-muted/60 has-[:disabled]:cursor-not-allowed has-[:disabled]:hover:bg-transparent motion-reduce:transition-none",
                CHECKBOX_BLEED[bleed]
              )}
            >
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={isSelected(item.value)}
                disabled={itemDisabled}
                aria-labelledby={`${id}-label`}
                aria-describedby={
                  [item.description && `${id}-description`, item.reason && `${id}-reason`, item.describedBy]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                onCheckedChange={(checked) => onCheckedChange(item.value, checked === true)}
              />
              <span className="grid min-w-0 gap-0.5">
                <span
                  id={`${id}-label`}
                  className={cn("text-sm font-medium leading-snug", itemDisabled && "opacity-60")}
                >
                  {item.label}
                </span>
                {item.description && (
                  <span id={`${id}-description`} className={SETTING_MUTED_NOTE_TEXT}>
                    {item.description}
                  </span>
                )}
                {item.reason && <DisabledReason id={`${id}-reason`}>{item.reason}</DisabledReason>}
              </span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * One item of a fixed list of fields in a row or disclosure body: its name
 * left, its controls right, such as a `w-40` select. Goes in a `ul` with
 * `SETTING_ITEM_DIVIDERS`; name each control with `aria-label`.
 */
export function SettingListItem({
  label,
  children,
  error,
}: {
  label: ReactNode
  children: ReactNode
  /** A {@link SettingFieldError} for one of its controls, on its own line under the item. */
  error?: ReactNode
}) {
  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 py-2">
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      <span className="ml-auto flex items-center gap-2">{children}</span>
      {error && <span className="basis-full">{error}</span>}
    </li>
  )
}

export interface OverrideListItem<V extends string> {
  key: string
  label: string
  value: V
  onValueChange: (value: V) => void
  /** Drops the override; omit for a fixed set of items. */
  onRemove?: () => void
  /** After the select, such as a count for "First N". */
  trailing?: ReactNode
  /** Why the trailing field wasn't saved, under the item. */
  error?: ReactNode
}

/**
 * Per-item exceptions to a default: the item's name left, a `w-40` select and
 * any `trailing` field right, and an X when the override can go. `add` puts a
 * select of the remaining items under the list. Selects are named by
 * `selectLabel(item label)`, remove buttons by `removeLabel(item label)`.
 */
export function SettingOverrideList<V extends string>({
  items,
  options,
  selectLabel,
  removeLabel = (label) => `Remove ${label}`,
  add,
  disabled = false,
  "aria-labelledby": labelledBy,
}: {
  items: readonly OverrideListItem<V>[]
  options: readonly { value: V; label: string }[]
  selectLabel: (label: string) => string
  removeLabel?: (label: string) => string
  add?: { label: string; options: readonly { value: string; label: string }[]; onAdd: (value: string) => void }
  disabled?: boolean
  "aria-labelledby": string
}) {
  const focusAfterRemoval = useFocusAfterRemoval()
  return (
    <div className="space-y-3" {...FOCUS_SCOPE}>
      {items.length > 0 && (
        <ul aria-labelledby={labelledBy} className={SETTING_ITEM_DIVIDERS}>
          {items.map((item) => (
            <SettingListItem key={item.key} label={item.label} error={item.error}>
              <Select value={item.value} disabled={disabled} onValueChange={(next) => item.onValueChange(next as V)}>
                <SelectTrigger
                  className={cn("w-40 shrink-0", SETTING_CONTROL_HEIGHT)}
                  aria-label={selectLabel(item.label)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {item.trailing}
              {item.onRemove && (
                <SettingRemoveButton
                  {...FOCUS_ITEM}
                  label={removeLabel(item.label)}
                  disabled={disabled}
                  onClick={(event) => {
                    focusAfterRemoval(event.currentTarget)
                    item.onRemove?.()
                  }}
                />
              )}
            </SettingListItem>
          ))}
        </ul>
      )}
      {add && add.options.length > 0 && (
        <Select value="" disabled={disabled} onValueChange={add.onAdd}>
          <SelectTrigger {...FOCUS_FALLBACK} className={cn("w-40", SETTING_CONTROL_HEIGHT)} aria-label={add.label}>
            <SelectValue placeholder={add.label} />
          </SelectTrigger>
          <SelectContent>
            {add.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
