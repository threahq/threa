import { useMemo, useState, type FormEvent } from "react"
import { Navigate, Link, useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Tag, Plus, Globe, Lock, Trash2, Pencil, LogOut, Sparkles } from "lucide-react"
import { toast } from "sonner"
import type { Visibility } from "@threa/types"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label as UiLabel } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { VisibilityPicker } from "@/components/ui/visibility-picker"
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/components/ui/responsive-alert-dialog"
import { SidebarToggle } from "@/components/layout"
import { useIsOnline } from "@/components/layout/connection-status"
import { cn } from "@/lib/utils"
import { stripMarkdownToInline } from "@/lib/markdown"
import {
  useCreateLabel,
  useDeleteLabel,
  useJoinLabel,
  useLabelsSync,
  useLabelsView,
  useLeaveLabel,
  usePromoteLabel,
  useUpdateLabel,
  type CachedLabel,
  type LabelViewerContext,
} from "@/hooks"

type TabValue = "mine" | "discover" | "new"

const TABS: { value: TabValue; label: string; segment: string | null }[] = [
  { value: "mine", label: "Mine", segment: null },
  { value: "discover", label: "Discover", segment: "discover" },
  { value: "new", label: "New", segment: "new" },
]

const VALID_TABS = new Set<string>(["discover", "new"])

function resolveTab(segment: string | undefined): TabValue {
  if (segment === "discover") return "discover"
  if (segment === "new") return "new"
  return "mine"
}

// A curated palette of saturated, distinct colors that read well as full-bleed
// swatches. Users can override via hex input; these are the suggestions.
const PRESET_COLORS = [
  "#E04F3E",
  "#F0A030",
  "#E8C547",
  "#8AB04F",
  "#39A07A",
  "#3A91C7",
  "#4D5BA8",
  "#8654C2",
  "#C04C8E",
  "#1E1E1E",
] as const

const PRESET_EMOJIS = ["🏷️", "🌱", "🔥", "🧠", "📚", "🛠️", "🎯", "💡", "✨", "🪐", "🌊", "⚡"] as const

/**
 * Route is `/w/:workspaceId/labels/:tab?` — bare `/labels` renders the
 * viewer's own labels, `/labels/discover` shows joinable public labels,
 * `/labels/new` opens the create form. URL-driven so refresh/back/forward
 * always land on the same view (INV-59).
 */
export function LabelsPage() {
  const { workspaceId, tab: tabParam } = useParams<{ workspaceId: string; tab?: string }>()

  if (!workspaceId) return null

  if (tabParam !== undefined && !VALID_TABS.has(tabParam)) {
    return <Navigate to={`/w/${workspaceId}/labels`} replace />
  }

  const tab = resolveTab(tabParam)

  return <LabelsPageInner workspaceId={workspaceId} tab={tab} />
}

interface InnerProps {
  workspaceId: string
  tab: TabValue
}

function LabelsPageInner({ workspaceId, tab }: InnerProps) {
  useLabelsSync(workspaceId)
  const view = useLabelsView(workspaceId)

  const tabHref = (next: TabValue) => {
    const segment = TABS.find((t) => t.value === next)?.segment
    return segment ? `/w/${workspaceId}/labels/${segment}` : `/w/${workspaceId}/labels`
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center justify-between border-b px-4 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <SidebarToggle location="page" />
          <Link
            to={`/w/${workspaceId}`}
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8 shrink-0")}
            aria-label="Back to workspace"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex items-center gap-2 min-w-0">
            <Tag className="h-5 w-5 text-muted-foreground shrink-0" />
            <h1 className="font-semibold truncate">Labels</h1>
          </div>
        </div>

        <Tabs value={tab}>
          <TabsList className="h-8">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} asChild>
                <Link to={tabHref(t.value)} className="text-xs px-2.5 py-1">
                  {t.label}
                </Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      <ScrollArea className="flex-1">
        <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
          {tab === "mine" && <MineTab workspaceId={workspaceId} view={view} />}
          {tab === "discover" && <DiscoverTab workspaceId={workspaceId} view={view} />}
          {tab === "new" && <NewTab workspaceId={workspaceId} />}
        </main>
      </ScrollArea>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mine
// ---------------------------------------------------------------------------

interface TabContentProps {
  workspaceId: string
  view: LabelViewerContext
}

function MineTab({ workspaceId, view }: TabContentProps) {
  const { mine } = view

  return (
    <section>
      <SectionIntro
        title="Your labels"
        subtitle="Organize scratchpads, threads, and people with color and emoji. Private labels are yours alone; public ones are workspace-wide."
        action={
          <Link to={`/w/${workspaceId}/labels/new`} className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}>
            <Plus className="h-4 w-4" />
            New label
          </Link>
        }
      />

      {mine.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No labels yet"
          body="Create your first label to start grouping the things you save."
          action={
            <Link to={`/w/${workspaceId}/labels/new`} className={cn(buttonVariants(), "gap-1.5")}>
              <Plus className="h-4 w-4" />
              Create a label
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {mine.map((label) => (
            <OwnedLabelCard key={label.id} workspaceId={workspaceId} label={label} />
          ))}
          <Link
            to={`/w/${workspaceId}/labels/new`}
            className="group flex min-h-[160px] items-center justify-center rounded-xl border border-dashed border-border bg-card/40 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            <div className="flex items-center gap-1.5 text-sm">
              <Plus className="h-4 w-4" />
              <span>Add a label</span>
            </div>
          </Link>
        </div>
      )}
    </section>
  )
}

function OwnedLabelCard({ workspaceId, label }: { workspaceId: string; label: CachedLabel }) {
  const isOnline = useIsOnline()
  const [editing, setEditing] = useState(false)
  const [confirmKind, setConfirmKind] = useState<"delete" | "promote" | null>(null)
  const deleteMutation = useDeleteLabel(workspaceId)
  const promoteMutation = usePromoteLabel(workspaceId)

  const handleDelete = () => {
    deleteMutation.mutate(label.id, {
      onSuccess: () => {
        toast.success("Label deleted")
        setConfirmKind(null)
      },
      onError: () => toast.error("Could not delete label"),
    })
  }

  const handlePromote = () => {
    promoteMutation.mutate(label.id, {
      onSuccess: () => {
        toast.success("Label is now public")
        setConfirmKind(null)
      },
      onError: () => toast.error("Could not promote label"),
    })
  }

  if (editing) {
    return <LabelEditCard workspaceId={workspaceId} label={label} onDone={() => setEditing(false)} />
  }

  return (
    <>
      <LabelSwatchCard label={label}>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => setEditing(true)}
            disabled={!isOnline}
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Button>
          {label.visibility === "private" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => setConfirmKind("promote")}
              disabled={!isOnline || promoteMutation.isPending}
            >
              <Globe className="h-3 w-3" />
              Make public
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
            onClick={() => setConfirmKind("delete")}
            disabled={!isOnline || deleteMutation.isPending}
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        </div>
      </LabelSwatchCard>

      <ResponsiveAlertDialog
        open={confirmKind !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmKind(null)
        }}
      >
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {confirmKind === "delete" ? `Delete “${label.name}”?` : `Make “${label.name}” public?`}
            </ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {confirmKind === "delete"
                ? "It will be archived and removed for everyone who joined. You can't undo this."
                : "Anyone in the workspace will be able to find and join this label. You can't switch it back to private."}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              onClick={confirmKind === "delete" ? handleDelete : handlePromote}
              disabled={deleteMutation.isPending || promoteMutation.isPending}
              className={
                confirmKind === "delete"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
            >
              {confirmKind === "delete" ? "Delete" : "Make public"}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  )
}

function LabelEditCard({
  workspaceId,
  label,
  onDone,
}: {
  workspaceId: string
  label: CachedLabel
  onDone: () => void
}) {
  const [name, setName] = useState(label.name)
  const [color, setColor] = useState(label.color)
  const [emoji, setEmoji] = useState(label.emoji ?? "")
  const [description, setDescription] = useState(label.description ?? "")
  const updateMutation = useUpdateLabel(workspaceId)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    updateMutation.mutate(
      {
        labelId: label.id,
        input: {
          name: name.trim(),
          color,
          emoji: emoji.trim() || null,
          description: description.trim() || null,
        },
      },
      {
        onSuccess: () => {
          toast.success("Label updated")
          onDone()
        },
        onError: () => toast.error("Could not update label"),
      }
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="relative flex flex-col overflow-hidden rounded-xl border bg-card"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="flex flex-col gap-3 p-3.5">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" autoFocus />
        <ColorRow value={color} onChange={setColor} />
        <EmojiRow value={emoji} onChange={setEmoji} />
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={2}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={updateMutation.isPending || !name.trim()}>
            Save
          </Button>
        </div>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

function DiscoverTab({ workspaceId, view }: TabContentProps) {
  const { discoverable, publicLabels, joinedLabelIds, currentUserId } = view

  const joined = useMemo(
    () => publicLabels.filter((l) => l.creatorUserId !== currentUserId && joinedLabelIds.has(l.id)),
    [publicLabels, currentUserId, joinedLabelIds]
  )

  return (
    <section>
      <SectionIntro
        title="Discover"
        subtitle="Public labels anyone in the workspace can join. Joining surfaces them in your own catalog."
      />

      {discoverable.length === 0 && joined.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing public yet"
          body="When someone creates a public label, or promotes a private one, it lands here."
          action={
            <Link to={`/w/${workspaceId}/labels/new`} className={cn(buttonVariants(), "gap-1.5")}>
              <Plus className="h-4 w-4" />
              Create the first
            </Link>
          }
        />
      ) : (
        <div className="space-y-8">
          {discoverable.length > 0 && (
            <div>
              <SubsectionHeading title="Available to join" count={discoverable.length} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {discoverable.map((label) => (
                  <DiscoverableLabelCard key={label.id} workspaceId={workspaceId} label={label} />
                ))}
              </div>
            </div>
          )}
          {joined.length > 0 && (
            <div>
              <SubsectionHeading title="You're a member" count={joined.length} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {joined.map((label) => (
                  <JoinedLabelCard
                    key={label.id}
                    workspaceId={workspaceId}
                    label={label}
                    userId={currentUserId ?? ""}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function DiscoverableLabelCard({ workspaceId, label }: { workspaceId: string; label: CachedLabel }) {
  const isOnline = useIsOnline()
  const joinMutation = useJoinLabel(workspaceId)

  const handleJoin = () => {
    joinMutation.mutate(label.id, {
      onSuccess: () => toast.success(`Joined ${label.name}`),
      onError: () => toast.error("Could not join label"),
    })
  }

  return (
    <LabelSwatchCard label={label}>
      <Button
        size="sm"
        className="mt-3 h-7 w-fit gap-1.5 px-3 text-xs"
        onClick={handleJoin}
        disabled={!isOnline || joinMutation.isPending}
      >
        Join
      </Button>
    </LabelSwatchCard>
  )
}

function JoinedLabelCard({ workspaceId, label, userId }: { workspaceId: string; label: CachedLabel; userId: string }) {
  const isOnline = useIsOnline()
  const leaveMutation = useLeaveLabel(workspaceId)

  const handleLeave = () => {
    leaveMutation.mutate(
      { labelId: label.id, userId },
      {
        onSuccess: () => toast.success(`Left ${label.name}`),
        onError: () => toast.error("Could not leave label"),
      }
    )
  }

  return (
    <LabelSwatchCard label={label}>
      <Button
        size="sm"
        variant="ghost"
        className="mt-3 h-7 w-fit gap-1.5 px-3 text-xs"
        onClick={handleLeave}
        disabled={!isOnline || leaveMutation.isPending}
      >
        <LogOut className="h-3 w-3" />
        Leave
      </Button>
    </LabelSwatchCard>
  )
}

// ---------------------------------------------------------------------------
// New
// ---------------------------------------------------------------------------

function NewTab({ workspaceId }: { workspaceId: string }) {
  const isOnline = useIsOnline()
  const navigate = useNavigate()
  const createMutation = useCreateLabel(workspaceId)
  const [name, setName] = useState("")
  const [visibility, setVisibility] = useState<Visibility>("private")
  const [color, setColor] = useState<string>(PRESET_COLORS[5])
  const [emoji, setEmoji] = useState<string>("")
  const [description, setDescription] = useState("")

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    createMutation.mutate(
      {
        name: name.trim(),
        visibility,
        color,
        emoji: emoji.trim() || null,
        description: description.trim() || null,
      },
      {
        onSuccess: () => {
          toast.success("Label created")
          navigate(`/w/${workspaceId}/labels`)
        },
        onError: () => toast.error("Could not create label"),
      }
    )
  }

  return (
    <section>
      <SectionIntro
        title="New label"
        subtitle="Give it a name, pick a color, add an emoji. You can edit anything but the visibility later."
      />

      {!isOnline && (
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          You're offline. Labels need a live connection to create.
        </div>
      )}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.1fr_1fr]">
        <form onSubmit={handleSubmit} className="space-y-5">
          <Field label="Name" htmlFor="label-name">
            <Input
              id="label-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Inbox zero, Reading list, Q3 launch"
              maxLength={80}
              autoFocus
            />
          </Field>

          <Field label="Visibility" htmlFor="label-visibility">
            <VisibilityPicker value={visibility} onChange={setVisibility} />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {visibility === "public"
                ? "Visible to everyone in the workspace. Members join to subscribe. You can't undo this."
                : "Only you can see this label. You can promote it to public later."}
            </p>
          </Field>

          <Field label="Color" htmlFor="label-color">
            <ColorRow value={color} onChange={setColor} />
          </Field>

          <Field label="Emoji" htmlFor="label-emoji">
            <EmojiRow value={emoji} onChange={setEmoji} />
          </Field>

          <Field label="Description" htmlFor="label-description">
            <Textarea
              id="label-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this label mean? (optional)"
              maxLength={280}
              rows={3}
            />
          </Field>

          <div className="flex justify-end gap-2 pt-2">
            <Link to={`/w/${workspaceId}/labels`} className={cn(buttonVariants({ variant: "ghost" }))}>
              Cancel
            </Link>
            <Button type="submit" disabled={!isOnline || createMutation.isPending || !name.trim()}>
              {createMutation.isPending ? "Creating..." : "Create label"}
            </Button>
          </div>
        </form>

        <aside className="lg:sticky lg:top-4 lg:self-start">
          <SubsectionHeading title="Preview" />
          <LabelPreview
            name={name || "Untitled label"}
            color={color}
            emoji={emoji}
            description={description}
            visibility={visibility}
          />
        </aside>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Shared atoms
// ---------------------------------------------------------------------------

function LabelSwatchCard({ label, children }: { label: CachedLabel; children?: React.ReactNode }) {
  return (
    <article
      className="relative flex min-h-[160px] flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/20"
      style={{ borderLeft: `3px solid ${label.color}` }}
    >
      <div className="flex flex-1 flex-col p-3.5">
        <div className="flex items-start gap-2.5">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xl"
            style={{ backgroundColor: hexToRgba(label.color, 0.12), color: label.color }}
            aria-hidden
          >
            {label.emoji ?? <Tag className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold leading-tight">{label.name}</h3>
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              {label.visibility === "public" ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              <span>{label.visibility === "public" ? "Public" : "Private"}</span>
            </div>
          </div>
        </div>
        {label.description && (
          <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {stripMarkdownToInline(label.description)}
          </p>
        )}
        {children}
      </div>
    </article>
  )
}

function LabelPreview({
  name,
  color,
  emoji,
  description,
  visibility,
}: {
  name: string
  color: string
  emoji: string
  description: string
  visibility: Visibility
}) {
  return (
    <article
      className="relative flex min-h-[180px] flex-col overflow-hidden rounded-xl border bg-card"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-2xl"
            style={{ backgroundColor: hexToRgba(color, 0.14), color }}
            aria-hidden
          >
            {emoji || <Tag className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold leading-tight">{name}</h3>
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              {visibility === "public" ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              <span>{visibility === "public" ? "Public" : "Private"}</span>
            </div>
          </div>
        </div>

        {description ? (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{stripMarkdownToInline(description)}</p>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground/60">No description yet.</p>
        )}

        <div className="mt-auto pt-5">
          <div
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ backgroundColor: hexToRgba(color, 0.16), color }}
          >
            <span>{emoji || "🏷️"}</span>
            <span>{name}</span>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            How the label tag appears inline next to a saved thread or scratchpad.
          </p>
        </div>
      </div>
    </article>
  )
}

function SectionIntro({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-2xl">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

function SubsectionHeading({ title, count }: { title: string; count?: number }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {typeof count === "number" && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/40 px-6 py-12 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <UiLabel htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </UiLabel>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

function ColorRow({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESET_COLORS.map((preset) => {
        const selected = value.toLowerCase() === preset.toLowerCase()
        return (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            className={cn(
              "h-8 w-8 rounded-full border-2 transition-transform",
              selected ? "scale-110 border-foreground" : "border-transparent hover:scale-105"
            )}
            style={{ backgroundColor: preset }}
            aria-label={`Pick color ${preset}`}
            aria-pressed={selected}
          />
        )
      })}
      <label className="ml-1 inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-4 w-4 cursor-pointer rounded border-0 bg-transparent p-0"
          aria-label="Custom color"
        />
        <span className="font-mono tracking-tight">{value.toUpperCase()}</span>
      </label>
    </div>
  )
}

function EmojiRow({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESET_EMOJIS.map((preset) => {
        const selected = value === preset
        return (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(selected ? "" : preset)}
            className={cn(
              "h-9 w-9 rounded-full border text-lg leading-none transition-colors",
              selected ? "border-foreground bg-foreground/5" : "border-transparent bg-muted hover:border-border"
            )}
            aria-label={`Pick emoji ${preset}`}
            aria-pressed={selected}
          >
            {preset}
          </button>
        )
      })}
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Or type"
        className="h-9 w-24"
        maxLength={4}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "")
  if (normalized.length !== 6) return hex
  const r = parseInt(normalized.slice(0, 2), 16)
  const g = parseInt(normalized.slice(2, 4), 16)
  const b = parseInt(normalized.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
