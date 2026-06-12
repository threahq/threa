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
import { useIsMobile } from "@/hooks/use-mobile"
import { filterSearchMentionables, filterUsersOnly, useMentionables } from "@/hooks/use-mentionables"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { formatISODate, getFutureDatePresets, getPastDatePresets } from "@/lib/dates"
import { addFilterToQuery, type FilterType } from "@/lib/search-query-parser"
import { cn } from "@/lib/utils"
import type { StreamType } from "@threa/types"
import type { ArchiveStatus } from "@/api"

/**
 * One menu entry per filter the query syntax supports. `in:` appears twice
 * because the syntax distinguishes channels (`in:#slug`) from DMs (`in:@slug`)
 * and the two need different value pickers.
 */
type FilterKind = "from" | "with" | "in-channel" | "in-dm" | "type" | "status" | "after" | "before"

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
  { kind: "after", label: "After date", syntax: "after:2026-01-01", icon: CalendarIcon },
  { kind: "before", label: "Before date", syntax: "before:2026-01-01", icon: CalendarIcon },
]

const STREAM_TYPE_OPTIONS: { value: StreamType; label: string }[] = [
  { value: "scratchpad", label: "Scratchpad" },
  { value: "channel", label: "Channel" },
  { value: "dm", label: "Direct message" },
  { value: "thread", label: "Thread" },
]

const ARCHIVE_STATUS_OPTIONS: { value: ArchiveStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

interface SearchFilterMenuProps {
  workspaceId: string
  query: string
  onQueryChange: (query: string) => void
  className?: string
}

/**
 * Discoverable counterpart to the typed filter syntax: a small "Add filter"
 * trigger that walks the user through filter kind → value without requiring
 * them to know `from:@`/`in:#`/… up front. Committing a value rewrites the
 * query string via `addFilterToQuery`, so the query stays the single source
 * of truth and the result renders as a normal removable chip.
 *
 * Popover on desktop, bottom drawer on mobile (same split as
 * `SearchableSelect`) — typing filter syntax on a phone keyboard is exactly
 * the flow this menu replaces.
 */
export function SearchFilterMenu({ workspaceId, query, onQueryChange, className }: SearchFilterMenuProps) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<FilterKind | null>(null)

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

  const activeKind = step !== null ? FILTER_KINDS.find((f) => f.kind === step) : undefined

  const content = (
    // The search surfaces listen for ArrowUp/ArrowDown/Escape to drive result
    // navigation; keys pressed inside the menu must not leak up to them.
    // (Radix's own Escape-dismiss listens on the document in capture phase,
    // so stopping bubble propagation here does not break closing the menu.)
    <div onKeyDown={(event) => event.stopPropagation()}>
      {step === null || !activeKind ? (
        <FilterKindList onPick={setStep} />
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

  if (isMobile) {
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

function FilterKindList({ onPick }: { onPick: (kind: FilterKind) => void }) {
  return (
    <Command>
      <CommandInput placeholder="Filter by..." />
      <CommandList className="max-h-[min(60vh,360px)] overscroll-contain">
        <CommandEmpty>No matching filter.</CommandEmpty>
        <CommandGroup>
          {FILTER_KINDS.map(({ kind, label, syntax, icon: Icon }) => (
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
      return <MentionablePicker usersOnly={false} onSelect={(slug) => onCommit("from", slug)} />
    case "with":
      return <MentionablePicker usersOnly={false} onSelect={(slug) => onCommit("with", slug)} />
    case "in-dm":
      return <MentionablePicker usersOnly onSelect={(slug) => onCommit("in", slug)} />
    case "in-channel":
      return <ChannelPicker workspaceId={workspaceId} onSelect={(slug) => onCommit("in", `#${slug}`)} />
    case "type":
      return <StaticOptionPicker options={STREAM_TYPE_OPTIONS} onSelect={(value) => onCommit("type", value)} />
    case "status":
      return <StaticOptionPicker options={ARCHIVE_STATUS_OPTIONS} onSelect={(value) => onCommit("status", value)} />
    case "after":
    case "before":
      return <DateValuePicker type={kind} onSelect={(isoDate) => onCommit(kind, isoDate)} />
  }
}

/**
 * User/persona/bot picker for `from:`/`with:` (search mentionables) and
 * `in:@` (users only — DMs only exist with users). Same data sources and
 * filter semantics as the typed `from:@…` autocomplete, including the "me"
 * shortcut matching the current user.
 */
function MentionablePicker({ usersOnly, onSelect }: { usersOnly: boolean; onSelect: (slug: string) => void }) {
  const { mentionables } = useMentionables()
  const [search, setSearch] = useState("")

  const filtered = useMemo(
    () => (usersOnly ? filterUsersOnly(mentionables, search) : filterSearchMentionables(mentionables, search)),
    [mentionables, search, usersOnly]
  )

  return (
    <Command shouldFilter={false}>
      <CommandInput placeholder="Search users..." value={search} onValueChange={setSearch} autoFocus />
      <CommandList className="max-h-[min(60vh,300px)] overscroll-contain">
        <CommandEmpty>No users found.</CommandEmpty>
        <CommandGroup>
          {filtered.slice(0, 20).map((item) => (
            <CommandItem key={item.id} value={item.id} onSelect={() => onSelect(item.slug)}>
              <span className="truncate">{item.name}</span>
              <span className="ml-auto pl-2 text-xs text-muted-foreground">@{item.slug}</span>
            </CommandItem>
          ))}
        </CommandGroup>
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
    if (!search) return withSlugs
    const lowerQuery = search.toLowerCase()
    return withSlugs.filter(
      (s) => s.slug.toLowerCase().includes(lowerQuery) || s.displayName?.toLowerCase().includes(lowerQuery)
    )
  }, [streams, search])

  return (
    <Command shouldFilter={false}>
      <CommandInput placeholder="Search channels..." value={search} onValueChange={setSearch} autoFocus />
      <CommandList className="max-h-[min(60vh,300px)] overscroll-contain">
        <CommandEmpty>No channels found.</CommandEmpty>
        <CommandGroup>
          {channels.slice(0, 20).map((stream) => (
            <CommandItem key={stream.id} value={stream.id} onSelect={() => onSelect(stream.slug)}>
              <Hash className="h-4 w-4 text-muted-foreground" />
              <span className="truncate">{stream.slug}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

function StaticOptionPicker<T extends string>({
  options,
  onSelect,
}: {
  options: { value: T; label: string }[]
  onSelect: (value: T) => void
}) {
  const commandRef = useCommandFocusOnMount()
  return (
    <Command ref={commandRef} tabIndex={-1} className="outline-none">
      <CommandList>
        <CommandGroup>
          {options.map((option) => (
            <CommandItem key={option.value} value={option.value} onSelect={() => onSelect(option.value)}>
              {option.label}
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
