import { useState, useEffect, useMemo, useRef } from "react"
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command"
import { Calendar } from "@/components/ui/calendar"
import { formatISODate } from "@/lib/dates"
import { useFormattedDate } from "@/hooks"
import type { StreamType, User, Stream } from "@threa/types"
import { rankMatches } from "@/lib/match-score"
import { getStreamName, streamLabel } from "@/lib/streams"

interface StreamTypeOption {
  value: StreamType
  label: string
}

interface ArchiveStatusOption {
  value: "active" | "archived"
  label: string
}

interface FilterSelectProps {
  type: "from" | "with" | "type" | "status" | "in" | "after" | "before"
  users: User[]
  streams: Stream[]
  streamTypes: StreamTypeOption[]
  statusOptions?: ArchiveStatusOption[]
  onSelect: (value: string, label: string) => void
  onCancel: () => void
}

export function FilterSelect({
  type,
  users,
  streams,
  streamTypes,
  statusOptions,
  onSelect,
  onCancel,
}: FilterSelectProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onCancel()
      }
    }

    // Use timeout to avoid catching the click that opened this
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [onCancel])

  let content: React.ReactNode = null

  if (type === "from" || type === "with") {
    content = <UserSelect users={users} onSelect={onSelect} />
  } else if (type === "type") {
    content = <StreamTypeSelect streamTypes={streamTypes} onSelect={onSelect} />
  } else if (type === "status" && statusOptions) {
    content = <StatusSelect statusOptions={statusOptions} onSelect={onSelect} />
  } else if (type === "in") {
    content = <StreamSelect streams={streams} onSelect={onSelect} />
  } else if (type === "after" || type === "before") {
    content = <DateSelect type={type} onSelect={onSelect} />
  }

  if (!content) return null

  return <div ref={containerRef}>{content}</div>
}

interface UserSelectProps {
  users: User[]
  onSelect: (value: string, label: string) => void
}

function UserSelect({ users, onSelect }: UserSelectProps) {
  const [search, setSearch] = useState("")

  const filtered = useMemo(
    () => rankMatches(users, search, (u) => ({ labels: [u.name || u.slug, u.slug] })),
    [users, search]
  )

  return (
    <div className="w-48">
      {/* Ranked above; each row's cmdk value is an id, so a second filter pass
          over it would match nothing and empty the list. */}
      <Command className="border rounded-md" shouldFilter={false}>
        <CommandInput placeholder="Search users..." value={search} onValueChange={setSearch} className="h-8" />
        <CommandList className="max-h-32">
          <CommandEmpty>No users found.</CommandEmpty>
          <CommandGroup>
            {filtered.slice(0, 10).map((workspaceUser) => {
              const name = workspaceUser.name || workspaceUser.slug
              return (
                <CommandItem
                  key={workspaceUser.id}
                  value={workspaceUser.id}
                  onSelect={() => onSelect(workspaceUser.id, name)}
                >
                  {name}
                </CommandItem>
              )
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}

interface StreamTypeSelectProps {
  streamTypes: StreamTypeOption[]
  onSelect: (value: string, label: string) => void
}

function StreamTypeSelect({ streamTypes, onSelect }: StreamTypeSelectProps) {
  return (
    <div className="w-40">
      <Command className="border rounded-md">
        <CommandList>
          <CommandGroup>
            {streamTypes.map((st) => (
              <CommandItem key={st.value} value={st.value} onSelect={() => onSelect(st.value, st.label)}>
                {st.label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}

interface StatusSelectProps {
  statusOptions: ArchiveStatusOption[]
  onSelect: (value: string, label: string) => void
}

function StatusSelect({ statusOptions, onSelect }: StatusSelectProps) {
  return (
    <div className="w-32">
      <Command className="border rounded-md">
        <CommandList>
          <CommandGroup>
            {statusOptions.map((opt) => (
              <CommandItem key={opt.value} value={opt.value} onSelect={() => onSelect(opt.value, opt.label)}>
                {opt.label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}

interface StreamSelectProps {
  streams: Stream[]
  onSelect: (value: string, label: string) => void
}

function StreamSelect({ streams, onSelect }: StreamSelectProps) {
  const [search, setSearch] = useState("")

  const filtered = rankMatches(streams, search, (s) => ({ labels: [getStreamName(s) ?? ""] }))

  const resolvedName = (stream: Stream) => streamLabel(stream)

  return (
    <div className="w-48">
      {/* Ranked above; see UserSelect for why cmdk must not filter again. */}
      <Command className="border rounded-md" shouldFilter={false}>
        <CommandInput placeholder="Search streams..." value={search} onValueChange={setSearch} className="h-8" />
        <CommandList className="max-h-32">
          <CommandEmpty>No streams found.</CommandEmpty>
          <CommandGroup>
            {filtered.slice(0, 10).map((stream) => (
              <CommandItem key={stream.id} value={stream.id} onSelect={() => onSelect(stream.id, resolvedName(stream))}>
                {resolvedName(stream)}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}

interface DateSelectProps {
  type: "after" | "before"
  onSelect: (value: string, label: string) => void
}

function DateSelect({ type, onSelect }: DateSelectProps) {
  const [date, setDate] = useState<Date | undefined>()
  const { formatDate } = useFormattedDate()

  const handleSelect = (selectedDate: Date | undefined) => {
    if (selectedDate) {
      setDate(selectedDate)
      const isoDate = formatISODate(selectedDate)
      const displayDate = formatDate(selectedDate)
      const label = `${type === "after" ? "After" : "Before"} ${displayDate}`
      onSelect(isoDate, label)
    }
  }

  return (
    <div className="border rounded-md bg-popover p-2">
      <Calendar mode="single" selected={date} onSelect={handleSelect} initialFocus className="p-0" />
    </div>
  )
}
