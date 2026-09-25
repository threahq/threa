import { useId, type ReactNode } from "react"
import {
  ArrowDown01,
  ArrowDown10,
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowDownZA,
  ArrowUpWideNarrow,
  CalendarArrowDown,
  CalendarArrowUp,
  Check,
  CircleDot,
  ClockArrowDown,
  ClockArrowUp,
  List,
  type LucideIcon,
} from "lucide-react"
import type { SidebarSectionFilter, SidebarSectionOrder } from "@threahq/types"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer"
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarDropdownMenu } from "./sidebar-actions"

/** A section's view options and what it offers. */
export interface SectionViewOptions {
  /** Current row filter; `undefined` when the section offers no filter (Inbox). */
  filter?: SidebarSectionFilter
  /** Current row order; `null` is the legacy mixed order ("Default"). */
  order: SidebarSectionOrder | null
  /** The orders on offer, default first. Empty means the default order is fixed. */
  orderOptions: readonly (SidebarSectionOrder | null)[]
  defaultOrder: SidebarSectionOrder | null
  reverse: boolean
  onFilterChange: (filter: SidebarSectionFilter) => void
  onSortChange: (order: SidebarSectionOrder | null, reverse: boolean) => void
}

/** One option change; set fields are the ones that changed. */
export interface SectionViewChange {
  filter?: SidebarSectionFilter
  order?: SidebarSectionOrder | null
  reverse?: boolean
}

/** Each order's label and its icon in the natural and the reversed direction. */
const ORDERS: Record<SidebarSectionOrder | "default", { label: string; icon: LucideIcon; reversedIcon: LucideIcon }> = {
  default: { label: "Default", icon: ArrowDownWideNarrow, reversedIcon: ArrowUpWideNarrow },
  arrival: { label: "Arrival", icon: ArrowDown01, reversedIcon: ArrowDown10 },
  activity: { label: "Latest activity", icon: ClockArrowDown, reversedIcon: ClockArrowUp },
  name: { label: "A–Z", icon: ArrowDownAZ, reversedIcon: ArrowDownZA },
  joined: { label: "Recently joined", icon: CalendarArrowDown, reversedIcon: CalendarArrowUp },
}

const FILTERS: Record<SidebarSectionFilter, { label: string; icon: LucideIcon }> = {
  all: { label: "All", icon: List },
  unread: { label: "Unread", icon: CircleDot },
}

/** Any option away from the section's default, which tints the opener. */
export function sectionViewCustomized(options: SectionViewOptions): boolean {
  return options.filter === "unread" || options.reverse || options.order !== options.defaultOrder
}

interface ViewRow {
  key: string
  label: string
  icon: LucideIcon
  checked: boolean
  reversed?: boolean
  onSelect: () => void
}

function rowName(row: ViewRow): string {
  return row.reversed ? `${row.label}, reversed` : row.label
}

function filterRows(options: SectionViewOptions): ViewRow[] {
  if (!options.filter) return []
  return (["all", "unread"] as const).map((filter) => ({
    key: filter,
    ...FILTERS[filter],
    checked: options.filter === filter,
    onSelect: () => options.onFilterChange(filter),
  }))
}

/**
 * The sort rows. Picking another order starts it in its natural direction;
 * picking the current one again flips it, and its icon shows which way it runs.
 * A section with a fixed order still lists that one order so it can be flipped.
 */
function sortRows(options: SectionViewOptions): ViewRow[] {
  const orders = options.orderOptions.length > 0 ? options.orderOptions : [options.defaultOrder]
  return orders.map((order) => {
    const { label, icon, reversedIcon } = ORDERS[order ?? "default"]
    const checked = options.order === order
    const reversed = checked && options.reverse
    return {
      key: order ?? "default",
      label,
      reversed,
      icon: reversed ? reversedIcon : icon,
      checked,
      onSelect: () => options.onSortChange(order, checked ? !options.reverse : false),
    }
  })
}

interface SectionViewMenuProps {
  label: string
  options: SectionViewOptions
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode
}

/** Desktop: the options as a dropdown off the section header. */
export function SectionViewMenu({ label, options, open, onOpenChange, trigger }: SectionViewMenuProps) {
  const filters = filterRows(options)
  return (
    <SidebarDropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-48" aria-label={`${label} view options`}>
        {filters.length > 0 && (
          <>
            <MenuGroup title="Show" rows={filters} />
            <DropdownMenuSeparator />
          </>
        )}
        <MenuGroup title="Sort" rows={sortRows(options)} />
      </DropdownMenuContent>
    </SidebarDropdownMenu>
  )
}

function MenuGroup({ title, rows }: { title: string; rows: ViewRow[] }) {
  return (
    <DropdownMenuGroup aria-label={title}>
      <DropdownMenuLabel className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground" aria-hidden>
        {title}
      </DropdownMenuLabel>
      {rows.map((row) => (
        <DropdownMenuItem
          key={row.key}
          role="menuitemradio"
          aria-checked={row.checked}
          aria-label={rowName(row)}
          // Keep the menu open so the list behind it visibly re-sorts.
          onSelect={(event) => {
            event.preventDefault()
            row.onSelect()
          }}
        >
          <row.icon className="text-muted-foreground" aria-hidden />
          <span>{row.label}</span>
          {row.checked && <Check className="ml-auto !h-3.5 !w-3.5 text-muted-foreground" aria-hidden />}
        </DropdownMenuItem>
      ))}
    </DropdownMenuGroup>
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
  const filters = filterRows(options)
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[85dvh]" aria-describedby={descriptionId}>
        <DrawerTitle className="px-4 pt-2 pb-1 text-base font-semibold">{label}</DrawerTitle>
        <DrawerDescription id={descriptionId} className="sr-only">
          Choose how this section lists its streams.
        </DrawerDescription>
        <div className="min-h-0 overflow-y-auto px-2 pb-[max(12px,env(safe-area-inset-bottom))]">
          {filters.length > 0 && <DrawerGroup title="Show" rows={filters} />}
          <DrawerGroup title="Sort" rows={sortRows(options)} />
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function DrawerGroup({ title, rows }: { title: string; rows: ViewRow[] }) {
  return (
    <div role="radiogroup" aria-label={title} className="border-b border-border/50 py-1 last:border-b-0">
      <div className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground" aria-hidden>
        {title}
      </div>
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          role="radio"
          aria-checked={row.checked}
          aria-label={rowName(row)}
          onClick={row.onSelect}
          className="flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors active:bg-muted/80"
        >
          <row.icon className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">{row.label}</span>
          {row.checked && <Check className="h-[18px] w-[18px] shrink-0 text-primary" aria-hidden />}
        </button>
      ))}
    </div>
  )
}
