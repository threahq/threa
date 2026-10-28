import { memo, useCallback, useMemo } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { AlertCircle, Check, ChevronDown, Filter, Search } from "lucide-react"
import { StreamTypes, type DocEditor } from "@threahq/types"
import { PagePaneHeader } from "@/components/panes"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ActorAvatar } from "@/components/actor-avatar"
import { LabelGlyph } from "@/components/labels/label-chip"
import { SidebarLabelsProvider, StreamLabelDots } from "@/components/layout/sidebar/sidebar-labels"
import {
  buildDocRows,
  docFilterOptions,
  docListHref,
  filterDocRows,
  readDocListFilters,
  writeDocListFilters,
  type DocListStream,
  type DocRow,
} from "@/components/docs/doc-list"
import { useDocList } from "@/components/docs/use-doc-list"
import { usePanel } from "@/contexts"
import { useActors, type ActorLookup } from "@/hooks"
import { useDebouncedUrlText } from "@/hooks/use-debounced-url-text"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { STREAM_ICONS, resolveDmDisplayName, streamLabel } from "@/lib/streams"
import { cn } from "@/lib/utils"
import {
  useWorkspaceDmPeers,
  useWorkspaceLabelAssignments,
  useWorkspaceLabels,
  useWorkspaceStreams,
  useWorkspaceUsers,
} from "@/stores/workspace-store"

const DocGlyph = STREAM_ICONS[StreamTypes.DOC]
const MAX_AVATARS = 3

interface FilterOption {
  value: string
  label: string
  icon?: React.ReactNode
}

/** `/w/:workspaceId/docs`: every doc the viewer can read, last edited first, filtered from the URL (INV-59). */
export function DocsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  if (!workspaceId) return null
  return <DocsPageInner workspaceId={workspaceId} />
}

function DocsPageInner({ workspaceId }: { workspaceId: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => readDocListFilters(searchParams), [searchParams])
  const cachedStreams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  // A cached DM's displayName can be the raw row's null; its name is the peer's.
  const streams = useMemo(
    () =>
      cachedStreams.map((stream) =>
        stream.type === StreamTypes.DM
          ? { ...stream, displayName: resolveDmDisplayName(stream.id, users, dmPeers) ?? stream.displayName }
          : stream
      ),
    [cachedStreams, users, dmPeers]
  )
  const labels = useWorkspaceLabels(workspaceId)
  const assignments = useWorkspaceLabelAssignments(workspaceId)
  const docList = useDocList(workspaceId)
  const { getActorName } = useActors(workspaceId)

  const rows = useMemo(
    () =>
      docList.data
        ? buildDocRows({ streams, items: docList.data.docs, assignments, listedAt: docList.dataUpdatedAt })
        : [],
    [docList.data, docList.dataUpdatedAt, streams, assignments]
  )
  const shown = useMemo(() => filterDocRows(rows, filters), [rows, filters])
  const options = useMemo(() => docFilterOptions(rows), [rows])

  const commitQuery = useCallback(
    (query: string) => setSearchParams((params) => writeDocListFilters(params, { query }), { replace: true }),
    [setSearchParams]
  )
  const { draft, setDraft } = useDebouncedUrlText({ value: filters.query, onCommit: commitQuery })

  const hostOptions: FilterOption[] = options.hosts.map(({ host, name }) => ({
    value: host.id,
    label: name,
    icon: <HostGlyph host={host} />,
  }))
  const labelOptions: FilterOption[] = labels
    .filter((label) => !label.archivedAt && options.labelIds.has(label.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((label) => ({
      value: label.id,
      label: label.name,
      icon: <LabelGlyph label={label} className="h-3.5 w-3.5" />,
    }))
  const editorOptions: FilterOption[] = options.editors.map((editor) => ({
    value: editor.actorId,
    label: getActorName(editor.actorId, editor.actorType),
    icon: (
      <ActorAvatar
        actorId={editor.actorId}
        actorType={editor.actorType}
        workspaceId={workspaceId}
        size="xs"
        showStatus={false}
      />
    ),
  }))

  const state = docsBodyState(docList)

  return (
    <div className="flex h-full flex-col">
      <PagePaneHeader
        workspaceId={workspaceId}
        back={{ to: `/w/${workspaceId}`, label: "Back to workspace" }}
        icon={<DocGlyph className="h-5 w-5 shrink-0 text-muted-foreground" />}
        title="Docs"
      />

      <div className="border-b px-4 py-2">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2">
          <div className="relative min-w-[min(100%,12rem)] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Search docs"
              aria-label="Search docs"
              className="h-9 pl-8"
            />
          </div>
          <div className="flex min-w-0 items-center gap-1">
            <FilterMenu
              name="Host"
              anyLabel="Any host"
              emptyLabel="No hosts yet"
              selected={filters.host}
              options={hostOptions}
              hrefFor={(host) => docListHref(workspaceId, searchParams, { host })}
            />
            <FilterMenu
              name="Label"
              anyLabel="Any label"
              emptyLabel="No labeled docs"
              selected={filters.label}
              options={labelOptions}
              hrefFor={(label) => docListHref(workspaceId, searchParams, { label })}
            />
            <FilterMenu
              name="Editor"
              anyLabel="Anyone"
              emptyLabel="No edits yet"
              selected={filters.editor}
              options={editorOptions}
              hrefFor={(editor) => docListHref(workspaceId, searchParams, { editor })}
            />
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <main className="mx-auto max-w-3xl py-2">
          <SidebarLabelsProvider workspaceId={workspaceId}>
            <DocsBody
              workspaceId={workspaceId}
              state={state}
              listed={rows.length}
              shown={shown}
              getActorName={getActorName}
              clearHref={docListHref(workspaceId, searchParams, { query: "", host: null, label: null, editor: null })}
            />
          </SidebarLabelsProvider>
        </main>
      </ScrollArea>
    </div>
  )
}

type DocsBodyState = "ready" | "error" | "loading"

function docsBodyState({ data, isError }: { data: unknown; isError: boolean }): DocsBodyState {
  if (data) return "ready"
  return isError ? "error" : "loading"
}

function DocsBody({
  workspaceId,
  state,
  listed,
  shown,
  getActorName,
  clearHref,
}: {
  workspaceId: string
  state: DocsBodyState
  listed: number
  shown: DocRow[]
  getActorName: ActorLookup["getActorName"]
  clearHref: string
}) {
  if (state === "loading") return null
  if (state === "error") return <DocsEmpty kind="error" />
  if (listed === 0) return <DocsEmpty kind="empty" />
  if (shown.length === 0) return <DocsEmpty kind="filtered" clearHref={clearHref} />
  return (
    <ul>
      {shown.map((row) => (
        <DocListRow key={row.doc.id} workspaceId={workspaceId} row={row} getActorName={getActorName} />
      ))}
    </ul>
  )
}

function HostGlyph({ host }: { host: DocListStream }) {
  const Icon = STREAM_ICONS[host.type]
  return <Icon className="h-3.5 w-3.5 text-muted-foreground" />
}

/** A filter's menu: a link per option, so picking one is a navigation to the filtered URL (INV-40). */
function FilterMenu({
  name,
  anyLabel,
  emptyLabel,
  selected,
  options,
  hrefFor,
}: {
  name: string
  anyLabel: string
  emptyLabel: string
  selected: string | null
  options: FilterOption[]
  hrefFor: (value: string | null) => string
}) {
  const current = selected === null ? null : options.find((option) => option.value === selected)
  const valueLabel = current?.label ?? `Unknown ${name.toLowerCase()}`
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={selected === null ? "ghost" : "secondary"}
          size="sm"
          className="h-9 min-w-0 gap-1 px-2.5 text-xs"
          aria-label={selected === null ? `Filter by ${name.toLowerCase()}` : `${name}: ${valueLabel}`}
        >
          <span className="max-w-[7rem] truncate">{selected === null ? name : valueLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuItem asChild>
          <Link to={hrefFor(null)} replace>
            <span className="flex-1">{anyLabel}</span>
            {selected === null && <Check className="h-3.5 w-3.5" />}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {options.length === 0 ? (
          <DropdownMenuItem disabled>{emptyLabel}</DropdownMenuItem>
        ) : (
          options.map((option) => (
            <DropdownMenuItem key={option.value} asChild>
              <Link to={hrefFor(option.value)} replace className="flex items-center gap-2">
                {option.icon}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.value === selected && <Check className="h-3.5 w-3.5 shrink-0" />}
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const DocListRow = memo(function DocListRow({
  workspaceId,
  row,
  getActorName,
}: {
  workspaceId: string
  row: DocRow
  getActorName: ActorLookup["getActorName"]
}) {
  const { getPanelUrl } = usePanel()
  const { formatRelative, formatFull } = useFormattedDate()
  const activityAt = new Date(row.activityAt)
  const when = formatRelative(activityAt, new Date(), { terse: true })
  return (
    <li className="px-2">
      <Link
        to={getPanelUrl(row.doc.id)}
        className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2.5 hover:bg-muted/60"
      >
        <DocGlyph className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{row.title}</span>
            <StreamLabelDots streamId={row.doc.id} />
          </div>
          {row.host && <div className="truncate text-xs text-muted-foreground">in {streamLabel(row.host)}</div>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className="text-xs tabular-nums text-muted-foreground"
            title={`${row.edited ? "Last edited" : "Created"} ${formatFull(activityAt)}`}
          >
            {when}
          </span>
          <EditorStack workspaceId={workspaceId} editors={row.editors} getActorName={getActorName} />
        </div>
      </Link>
    </li>
  )
})

function EditorStack({
  workspaceId,
  editors,
  getActorName,
}: {
  workspaceId: string
  editors: DocEditor[]
  getActorName: ActorLookup["getActorName"]
}) {
  if (editors.length === 0) return null
  const names = editors.map((editor) => getActorName(editor.actorId, editor.actorType))
  const extra = editors.length - MAX_AVATARS
  return (
    <span className="flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground" title={names.join(", ")}>
      <span className="flex -space-x-1.5">
        {editors.slice(0, MAX_AVATARS).map((editor, index) => (
          <ActorAvatar
            key={editor.actorId}
            actorId={editor.actorId}
            actorType={editor.actorType}
            workspaceId={workspaceId}
            size="xs"
            alt={names[index]}
            showStatus={false}
            className="ring-2 ring-background"
          />
        ))}
      </span>
      {extra > 0 && <span aria-label={`${extra} more editors`}>+{extra}</span>}
    </span>
  )
}

const EMPTY_COPY = {
  empty: {
    title: "No docs yet",
    body: "Docs you create in channels, scratchpads and DMs show up here, last edited first.",
    icon: DocGlyph,
    accent: "bg-primary/10 text-primary",
  },
  filtered: {
    title: "No docs match",
    body: "Try a different search or clear the filters.",
    icon: Filter,
    accent: "bg-muted text-muted-foreground",
  },
  error: {
    title: "Couldn't load docs",
    body: "Something went wrong loading your docs. Try again in a moment.",
    icon: AlertCircle,
    accent: "bg-destructive/10 text-destructive",
  },
}

function DocsEmpty({ kind, clearHref }: { kind: keyof typeof EMPTY_COPY; clearHref?: string }) {
  const { title, body, icon: Icon, accent } = EMPTY_COPY[kind]
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <div className={cn("flex h-12 w-12 items-center justify-center rounded-card", accent)}>
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="max-w-[28ch] text-xs text-muted-foreground">{body}</p>
      </div>
      {clearHref && (
        <Link to={clearHref} replace className={buttonVariants({ variant: "outline", size: "sm" })}>
          Clear filters
        </Link>
      )}
    </div>
  )
}
