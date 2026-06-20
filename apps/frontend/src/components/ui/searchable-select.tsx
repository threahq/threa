import { type ReactNode, useState, useEffect } from "react"
import { ChevronsUpDown } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { useCoarsePointer } from "@/hooks/use-pointer"
import { cn } from "@/lib/utils"

interface SearchableSelectProps<T> {
  items: T[]
  value: T | null
  onChange: (item: T) => void
  /** Stable unique id for the item — used as React key and cmdk value. */
  getKey: (item: T) => string
  /** Search keywords matched by the cmdk fuzzy filter (e.g. [name, `@${slug}`]). */
  getKeywords: (item: T) => string[]
  /** Row rendered inside the popover list. */
  renderItem: (item: T, isSelected: boolean) => ReactNode
  /** Trigger label when a value is selected. Defaults to renderItem with selected=true. */
  renderSelected?: (item: T) => ReactNode
  /** Trigger label when no value is selected. */
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  /** Optional icon left of the trigger label. */
  triggerIcon?: LucideIcon
  /**
   * When no value is selected, append a subtle "· N available" hint to the trigger
   * so users can see how many options exist before opening.
   */
  showAvailableCount?: boolean
  availableLabel?: (n: number) => string
  disabled?: boolean
  className?: string
  contentClassName?: string
  align?: "start" | "center" | "end"
  /** Extra rows rendered above the items list (e.g. a "device timezone" suggestion). */
  prefixContent?: (helpers: { close: () => void }) => ReactNode
  /** Test id forwarded to the trigger. */
  "data-testid"?: string
}

export function SearchableSelect<T>({
  items,
  value,
  onChange,
  getKey,
  getKeywords,
  renderItem,
  renderSelected,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyMessage = "No results found.",
  triggerIcon: TriggerIcon,
  showAvailableCount = false,
  availableLabel = (n) => `${n} available`,
  disabled = false,
  className,
  contentClassName,
  align = "start",
  prefixContent,
  "data-testid": testId,
}: SearchableSelectProps<T>) {
  const isTouch = useCoarsePointer()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")

  // Reset filter input each time the popover/drawer closes so the next open shows the full list.
  useEffect(() => {
    if (!open) setSearch("")
  }, [open])

  const handleSelect = (item: T) => {
    onChange(item)
    setOpen(false)
  }

  const triggerContent = value ? (
    <span className="flex items-center gap-2 min-w-0 flex-1 truncate">
      {TriggerIcon && <TriggerIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="truncate">{(renderSelected ?? ((v: T) => renderItem(v, true)))(value)}</span>
    </span>
  ) : (
    <span className="flex items-center gap-2 min-w-0 flex-1 truncate font-normal text-muted-foreground">
      {TriggerIcon && <TriggerIcon className="h-4 w-4 shrink-0" />}
      <span className="truncate">{placeholder}</span>
      {showAvailableCount && items.length > 0 && (
        <span className="ml-auto pl-2 text-xs text-muted-foreground/70 shrink-0 tabular-nums">
          {availableLabel(items.length)}
        </span>
      )}
    </span>
  )

  const triggerButton = (
    <Button
      type="button"
      variant="outline"
      role="combobox"
      aria-expanded={open}
      disabled={disabled}
      data-testid={testId}
      className={cn("w-full justify-between gap-2 font-normal", className)}
    >
      {triggerContent}
      <ChevronsUpDown
        className={cn("h-4 w-4 shrink-0 opacity-50 transition-transform duration-150", open && "rotate-180 opacity-80")}
      />
    </Button>
  )

  const commandList = (
    <>
      <CommandEmpty>{emptyMessage}</CommandEmpty>
      {prefixContent && <CommandGroup>{prefixContent({ close: () => setOpen(false) })}</CommandGroup>}
      <CommandGroup>
        {items.map((item) => {
          const key = getKey(item)
          const isSelected = value !== null && getKey(value) === key
          return (
            <CommandItem key={key} value={key} keywords={getKeywords(item)} onSelect={() => handleSelect(item)}>
              {renderItem(item, isSelected)}
            </CommandItem>
          )
        })}
      </CommandGroup>
    </>
  )

  if (isTouch) {
    // Drawer (vaul) on touch devices. The drawer itself is content-driven (no fixed
    // height) so a 4-row list gives a 4-row drawer instead of an empty 85dvh
    // sheet. The CommandList caps at 70dvh, which lets the keyboard shrink
    // available space without pushing rows off-screen — vaul is configured
    // with repositionInputs={false}, so dvh is the single source of truth.
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{triggerButton}</DrawerTrigger>
        <DrawerContent className={cn("pb-[env(safe-area-inset-bottom)]", contentClassName)}>
          <DrawerTitle className="sr-only">{searchPlaceholder}</DrawerTitle>
          <Command>
            <CommandInput placeholder={searchPlaceholder} value={search} onValueChange={setSearch} />
            <CommandList className="max-h-[70dvh] overscroll-contain">{commandList}</CommandList>
          </Command>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      <PopoverContent
        className={cn("w-[--radix-popover-trigger-width] max-w-[calc(100vw-1rem)] p-0", contentClassName)}
        align={align}
        onWheel={(e) => e.stopPropagation()}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} value={search} onValueChange={setSearch} />
          {/*
           * Override cmdk's default 300px ceiling so the list shows more rows on
           * tall viewports and stays inside the screen on short ones. overscroll-
           * contain prevents body scroll-chaining once the user reaches the
           * top/bottom of the list.
           */}
          <CommandList className="max-h-[min(60vh,360px)] overscroll-contain">{commandList}</CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
