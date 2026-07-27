import { useEffect, useMemo, useRef, useState } from "react"
import {
  Archive,
  Calendar as CalendarIcon,
  ChevronLeft,
  Hash,
  Layers,
  ListFilter,
  MessageCircle,
  User,
  Users,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useInputMode } from "@/hooks/use-input-mode"
import { filterUsersOnly, useMentionables } from "@/hooks/use-mentionables"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { FILTER_TYPE_OPTIONS } from "@/components/editor/triggers/filter-type-extension"
import { STATUS_FILTER_OPTIONS } from "@/components/editor/triggers/status-filter-extension"
import { formatISODate, getFutureDatePresets, getPastDatePresets } from "@/lib/dates"
import { rankMatches } from "@/lib/match-score"
import { addFilterToQuery, type FilterType } from "@/lib/search-query-parser"
import { getStreamName, streamLabel } from "@/lib/streams"
import { cn } from "@/lib/utils"

/**
 * One menu entry per filter the query syntax supports. `in:` appears twice
 * because the syntax distinguishes channels (`in:#slug`) from DMs (`in:@slug`)
 * and the two need different value pickers.
 */
export type FilterKind = "from" | "with" | "in-channel" | "in-dm" | "type" | "status" | "after" | "before"

interface FilterKindDef {
  kind: FilterKind
  label: string
  /** The typed syntax this entry teaches (shown as a hint). */
  syntax: string
  icon: LucideIcon
}

const FILTER_KINDS: FilterKindDef[] = [
  { kind: "from", label: "From user", syntax: "from:@user", icon: User },
  { kind: "with", label: "With user", syntax: "with:@user", icon: Users },
  { kind: "in-channel", label: "In channel", syntax: "in:#channel", icon: Hash },
  { kind: "in-dm", label: "In DM with", syntax: "in:@user", icon: MessageCircle },
  { kind: "type", label: "Stream type", syntax: "is:thread", icon: Layers },
  { kind: "status", label: "Status", syntax: "status:archived", icon: Archive },
  { kind: "after", label: "After date", syntax: `after:${new Date().getFullYear()}-01-01`, icon: CalendarIcon },
  { kind: "before", label: "Before date", syntax: `before:${new Date().getFullYear()}-01-01`, icon: CalendarIcon },
]

/** Cap on rows rendered in the searchable pickers; a hint row says how to narrow. */
const PICKER_RESULT_CAP = 20

interface SearchFilterMenuProps {
  workspaceId: string
  query: string
  onQueryChange: (query: string) => void
  className?: string
  /**
   * Restrict the offered filters, in this order. Surfaces whose scope makes a
   * filter meaningless (the stream-scoped context panel has no `in:`/`type:`)
   * narrow the menu rather than forking it. Defaults to every kind.
   */
  kinds?: readonly FilterKind[]
}

/**
 * Discoverable counterpart to the typed filter syntax: a small "Add filter"
 * trigger that walks the user through filter kind → value without requiring
 * them to know `from:@`/`in:#`/… up front. Committing a value rewrites the
 * query string via `addFilterToQuery`, so the query stays the single source
 * of truth and the result renders as a normal removable chip.
 *
 * Popover for mouse input, bottom drawer when a finger is active (same split as
 * `SearchableSelect`) — typing filter syntax on a touch keyboard is exactly
 * the flow this menu replaces. A mouse on a touchscreen laptop gets the popover.
 */
export function SearchFilterMenu({ workspaceId, query, onQueryChange, className, kinds }: SearchFilterMenuProps) {
  const isTouch = useInputMode() === "touch"
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<FilterKind | null>(null)
  const offered = useMemo(
    () => (kinds ? kinds.map((kind) => FILTER_KINDS.find((f) => f.kind === kind)!).filter(Boolean) : FILTER_KINDS),
    [kinds]
  )

  // Reopening always starts at the kind list, never a stale value picker.
  useEffect(() => {
    if (!open) setStep(null)
  }, [open])

  const commitFilter = (type: FilterType, value: string) => {
    // Trailing space keeps the cursor out of the filter token when the user
    // resumes typing in the search input.
    onQueryChange(addFilterToQuery(query, type, value) + " ")
    setOpen(false)
  }

  const activeKind = step !== null ? offered.find((f) => f.kind === step) : undefined

  const content = (
    // The search surfaces listen for ArrowUp/ArrowDown/Escape to drive result
    // navigation; keys pressed inside the menu must not leak up to them.
    // (Radix's own Escape-dismiss listens on the document in capture phase,
    // so stopping bubble propagation here does not break closing the menu.)
    <div onKeyDown={(event) => event.stopPropagation()}>
      {step === null || !activeKind ? (
        <FilterKindList kinds={offered} onPick={setStep} />
      ) : (
        <>
          <div className="flex items-center gap-1 border-b px-2 py-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              onClick={() => setStep(null)}
              aria-label="Back to filter list"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs font-medium">{activeKind.label}</span>
            <code className="ml-auto rounded bg-muted px-1 text-[10px] text-muted-foreground">{activeKind.syntax}</code>
          </div>
          <FilterValuePicker workspaceId={workspaceId} kind={step} onCommit={commitFilter} />
        </>
      )}
    </div>
  )

  const trigger = (
    <Button
      variant="outline"
      size="sm"
      className={cn("h-6 gap-1 rounded-full px-2 text-[11px] font-normal text-muted-foreground", className)}
      aria-label="Add search filter"
    >
      <ListFilter className="h-3 w-3" />
      Add filter
    </Button>
  )

  if (isTouch) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="pb-[env(safe-area-inset-bottom)]">
          <DrawerTitle className="sr-only">Add search filter</DrawerTitle>
          {content}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start" onWheel={(e) => e.stopPropagation()}>
        {content}
      </PopoverContent>
    </Popover>
  )
}

function FilterKindList({ kinds, onPick }: { kinds: FilterKindDef[]; onPick: (kind: FilterKind) => void }) {
  return (
    <Command>
      <CommandInput placeholder="Filter by..." />
      <CommandList className="max-h-[min(60vh,360px)] overscroll-contain">
        <CommandEmpty>No matching filter.</CommandEmpty>
        <CommandGroup>
          {kinds.map(({ kind, label, syntax, icon: Icon }) => (
            <CommandItem key={kind} value={kind} keywords={[label, syntax]} onSelect={() => onPick(kind)}>
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span>{label}</span>
              <code className="ml-auto rounded bg-muted px-1 text-[10px] text-muted-foreground">{syntax}</code>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

/**
 * Focus the cmdk root on mount so arrow/Enter navigation works in pickers
 * that have no text input (the input-bearing pickers get focus through the
 * input's autoFocus instead). Without focus inside the root, cmdk never sees
 * the keydown events.
 */
function useCommandFocusOnMount() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return ref
}

function FilterValuePicker({
  workspaceId,
  kind,
  onCommit,
}: {
  workspaceId: string
  kind: FilterKind
  onCommit: (type: FilterType, value: string) => void
}) {
  switch (kind) {
    case "from":
      return <UserPicker onSelect={(slug) => onCommit("from", slug)} />
    case "with":
      return <UserPicker onSelect={(slug) => onCommit("with", slug)} />
    case "in-dm":
      return <UserPicker onSelect={(slug) => onCommit("in", slug)} />
    case "in-channel":
      return <ChannelPicker workspaceId={workspaceId} onSelect={(slug) => onCommit("in", `#${slug}`)} />
    case "type":
      return <StaticOptionPicker options={FILTER_TYPE_OPTIONS} onSelect={(value) => onCommit("type", value)} />
    case "status":
      return <StaticOptionPicker options={STATUS_FILTER_OPTIONS} onSelect={(value) => onCommit("status", value)} />
    case "after":
    case "before":
      return <DateValuePicker type={kind} onSelect={(isoDate) => onCommit(kind, isoDate)} />
  }
}

/**
 * User picker for `from:`/`with:`/`in:@`. Users only: `useMessageSearch`
 * resolves these slugs against workspace users exclusively, so offering
 * personas/bots here would commit a chip whose filter silently never applies.
 * Keeps the "me" shortcut matching the current user.
 */
function UserPicker({ onSelect }: { onSelect: (slug: string) => void }) {
  const { mentionables } = useMentionables()
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => filterUsersOnly(mentionables, search), [mentionables, search])

  return (
    <Command shouldFilter={false}>
      <CommandInput placeholder="Search users..." value={search} onValueChange={setSearch} autoFocus />
      <CommandList className="max-h-[min(60vh,300px)] overscroll-contain">
        <CommandEmpty>No users found.</CommandEmpty>
        <CommandGroup>
          {filtered.slice(0, PICKER_RESULT_CAP).map((item) => (
            <CommandItem key={item.id} value={item.id} onSelect={() => onSelect(item.slug)}>
              <span className="truncate">{item.name}</span>
              <span className="ml-auto pl-2 text-xs text-muted-foreground">@{item.slug}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        {filtered.length > PICKER_RESULT_CAP && <PickerCapHint />}
      </CommandList>
    </Command>
  )
}

/** Channel picker for `in:#` — only streams with slugs are addressable. */
function ChannelPicker({ workspaceId, onSelect }: { workspaceId: string; onSelect: (slug: string) => void }) {
  const streams = useWorkspaceStreams(workspaceId)
  const [search, setSearch] = useState("")

  const channels = useMemo(() => {
    const withSlugs = streams.filter((s): s is typeof s & { slug: string } => Boolean(s.slug))
    return rankMatches(withSlugs, search, (s) => {
      const name = getStreamName(s)
      return { labels: name ? [s.slug, name] : [s.slug] }
    })
  }, [streams, search])

  return (
    <Command shouldFilter={false}>
      <CommandInput placeholder="Search channels..." value={search} onValueChange={setSearch} autoFocus />
      <CommandList className="max-h-[min(60vh,300px)] overscroll-contain">
        <CommandEmpty>No channels found.</CommandEmpty>
        <CommandGroup>
          {channels.slice(0, PICKER_RESULT_CAP).map((stream) => {
            // streamLabel is "#slug" for channels; slugged non-channels (e.g.
            // scratchpads) label by display name, so surface the slug alongside
            const label = streamLabel(stream)
            return (
              <CommandItem key={stream.id} value={stream.id} onSelect={() => onSelect(stream.slug)}>
                <span className="truncate">{label}</span>
                {label !== `#${stream.slug}` && (
                  <span className="ml-auto pl-2 text-xs text-muted-foreground">#{stream.slug}</span>
                )}
              </CommandItem>
            )
          })}
        </CommandGroup>
        {channels.length > PICKER_RESULT_CAP && <PickerCapHint />}
      </CommandList>
    </Command>
  )
}

function PickerCapHint() {
  return (
    <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
      Showing first {PICKER_RESULT_CAP} — keep typing to narrow
    </p>
  )
}

function StaticOptionPicker<T extends string>({
  options,
  onSelect,
}: {
  options: { value: T; label: string; description?: string }[]
  onSelect: (value: T) => void
}) {
  const commandRef = useCommandFocusOnMount()
  return (
    <Command ref={commandRef} tabIndex={-1} className="outline-none">
      <CommandList>
        <CommandGroup>
          {options.map((option) => (
            <CommandItem
              key={option.value}
              value={option.value}
              onSelect={() => onSelect(option.value)}
              className="flex-col items-start gap-0"
            >
              <span>{option.label}</span>
              {option.description && <span className="text-xs text-muted-foreground">{option.description}</span>}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

/**
 * Date picker for `after:`/`before:` — the same relative presets as the typed
 * autocomplete, plus a calendar for an arbitrary date.
 */
function DateValuePicker({ type, onSelect }: { type: "after" | "before"; onSelect: (isoDate: string) => void }) {
  const commandRef = useCommandFocusOnMount()
  const [showCalendar, setShowCalendar] = useState(false)

  const presets = useMemo(() => {
    const now = new Date()
    return type === "after" ? getPastDatePresets(now) : getFutureDatePresets(now)
  }, [type])

  if (showCalendar) {
    return (
      <div className="p-2">
        <Button
          variant="ghost"
          size="sm"
          className="mb-1 h-6 gap-1 px-1.5 text-xs text-muted-foreground"
          onClick={() => setShowCalendar(false)}
        >
          <ChevronLeft className="h-3 w-3" />
          Date presets
        </Button>
        <Calendar
          mode="single"
          onSelect={(date) => {
            if (date) onSelect(formatISODate(date))
          }}
          autoFocus
          className="p-0"
        />
      </div>
    )
  }

  return (
    <Command ref={commandRef} tabIndex={-1} className="outline-none">
      <CommandList>
        <CommandGroup>
          {presets.map((preset) => (
            <CommandItem key={preset.id} value={preset.id} onSelect={() => onSelect(formatISODate(preset.date))}>
              <span>{preset.label}</span>
              <span className="ml-auto pl-2 text-xs tabular-nums text-muted-foreground">
                {formatISODate(preset.date)}
              </span>
            </CommandItem>
          ))}
          <CommandItem value="custom" onSelect={() => setShowCalendar(true)}>
            <CalendarIcon className="h-4 w-4 text-muted-foreground" />
            Pick a date...
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  )
}
