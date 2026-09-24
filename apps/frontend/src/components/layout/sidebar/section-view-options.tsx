import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react"
import { ArrowDownUp, Check } from "lucide-react"
import type { SidebarSectionFilter, SidebarSectionOrder } from "@threahq/types"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer"
import { cn } from "@/lib/utils"

/** A section's view options and what it offers. */
export interface SectionViewOptions {
  /** Current row filter; `undefined` when the section offers no filter (Inbox). */
  filter?: SidebarSectionFilter
  /** Current row order; `null` is the legacy mixed order ("Default"). */
  order: SidebarSectionOrder | null
  /** The orders on offer, default first. Fewer than two hides the Order group. */
  orderOptions: readonly (SidebarSectionOrder | null)[]
  defaultOrder: SidebarSectionOrder | null
  reverse: boolean
  onFilterChange: (filter: SidebarSectionFilter) => void
  onOrderChange: (order: SidebarSectionOrder | null) => void
  onReverseChange: (reverse: boolean) => void
}

/** One option change; set fields are the ones that changed. */
export interface SectionViewChange {
  filter?: SidebarSectionFilter
  order?: SidebarSectionOrder | null
  reverse?: boolean
}

const ORDER_LABELS: Record<SidebarSectionOrder | "default", { label: string; short: string }> = {
  default: { label: "Default", short: "Default" },
  arrival: { label: "Arrival", short: "Arrival" },
  activity: { label: "Latest activity", short: "Activity" },
  name: { label: "A–Z", short: "A–Z" },
  joined: { label: "Recently joined", short: "Joined" },
}

const FILTER_LABELS: Record<SidebarSectionFilter, string> = { all: "All", unread: "Unread" }

function orderLabels(order: SidebarSectionOrder | null) {
  return ORDER_LABELS[order ?? "default"]
}

/** Any option away from the section's default, which tints the opener. */
export function sectionViewCustomized(options: SectionViewOptions): boolean {
  return options.filter === "unread" || options.reverse || options.order !== options.defaultOrder
}

function hasOrderChoice(options: SectionViewOptions): boolean {
  return options.orderOptions.length > 1
}

const segClass = "flex gap-0.5 rounded-md bg-muted p-0.5"
const segButtonClass = cn(
  "inline-flex h-6 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 text-xs text-muted-foreground transition-colors",
  "hover:text-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm"
)

interface SectionViewStripProps {
  id: string
  label: string
  options: SectionViewOptions
  openerRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
}

/** Desktop: the options as an inline strip under the section header. */
export function SectionViewStrip({ id, label, options, openerRef, onClose }: SectionViewStripProps) {
  const stripRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (stripRef.current?.contains(target) || openerRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [onClose, openerRef])

  return (
    <div
      ref={stripRef}
      id={id}
      role="group"
      aria-label={`${label} view options`}
      className="mx-1 mb-1.5 mt-0.5 grid gap-1.5 rounded-lg border bg-card p-2"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.stopPropagation()
        onClose()
        openerRef.current?.focus()
      }}
    >
      {options.filter && (
        <div className={segClass} role="group" aria-label="Show">
          {(["all", "unread"] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              className={segButtonClass}
              aria-pressed={options.filter === filter}
              onClick={() => options.onFilterChange(filter)}
            >
              {FILTER_LABELS[filter]}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        {hasOrderChoice(options) && (
          <div className={cn(segClass, "min-w-0 flex-1")} role="group" aria-label="Order">
            {options.orderOptions.map((order) => (
              <button
                key={order ?? "default"}
                type="button"
                className={segButtonClass}
                aria-pressed={options.order === order}
                title={orderLabels(order).label}
                onClick={() => options.onOrderChange(order)}
              >
                {orderLabels(order).short}
              </button>
            ))}
          </div>
        )}
        <div className={cn(segClass, !hasOrderChoice(options) && "flex-1")}>
          <button
            type="button"
            className={segButtonClass}
            aria-pressed={options.reverse}
            title="Reverse order"
            aria-label={hasOrderChoice(options) ? "Reverse order" : undefined}
            onClick={() => options.onReverseChange(!options.reverse)}
          >
            <ArrowDownUp className="h-3.5 w-3.5" aria-hidden />
            {!hasOrderChoice(options) && "Reverse"}
          </button>
        </div>
      </div>
    </div>
  )
}

interface SectionViewDrawerProps {
  label: string
  options: SectionViewOptions
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Mobile: the same options as a bottom sheet with full-width rows. */
export function SectionViewDrawer({ label, options, open, onOpenChange }: SectionViewDrawerProps) {
  const descriptionId = useId()
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[85dvh]" aria-describedby={descriptionId}>
        <DrawerTitle className="px-4 pt-2 pb-1 text-base font-semibold">{label}</DrawerTitle>
        <DrawerDescription id={descriptionId} className="sr-only">
          Choose how this section lists its streams.
        </DrawerDescription>
        <div className="min-h-0 overflow-y-auto px-2 pb-[max(12px,env(safe-area-inset-bottom))]">
          {options.filter && (
            <DrawerGroup title="Show">
              {(["all", "unread"] as const).map((filter) => (
                <DrawerOption
                  key={filter}
                  label={FILTER_LABELS[filter]}
                  checked={options.filter === filter}
                  onSelect={() => options.onFilterChange(filter)}
                />
              ))}
            </DrawerGroup>
          )}
          {hasOrderChoice(options) && (
            <DrawerGroup title="Order">
              {options.orderOptions.map((order) => (
                <DrawerOption
                  key={order ?? "default"}
                  label={orderLabels(order).label}
                  checked={options.order === order}
                  onSelect={() => options.onOrderChange(order)}
                />
              ))}
            </DrawerGroup>
          )}
          <DrawerGroup title="Reverse" role="group">
            <DrawerOption
              label="Reverse order"
              role="checkbox"
              checked={options.reverse}
              onSelect={() => options.onReverseChange(!options.reverse)}
            />
          </DrawerGroup>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function DrawerGroup({
  title,
  role = "radiogroup",
  children,
}: {
  title: string
  role?: "radiogroup" | "group"
  children: ReactNode
}) {
  return (
    <div role={role} aria-label={title} className="border-b border-border/50 py-1 last:border-b-0">
      <div className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground" aria-hidden>
        {title}
      </div>
      {children}
    </div>
  )
}

function DrawerOption({
  label,
  checked,
  onSelect,
  role = "radio",
}: {
  label: string
  checked: boolean
  onSelect: () => void
  role?: "radio" | "checkbox"
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      onClick={onSelect}
      className="flex h-12 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-sm transition-colors active:bg-muted/80"
    >
      {label}
      {checked && <Check className="h-[18px] w-[18px] shrink-0 text-primary" aria-hidden />}
    </button>
  )
}
