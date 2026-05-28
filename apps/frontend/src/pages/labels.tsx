import { useMemo, useState, type FormEvent } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, Tag, Plus, Globe, Lock, Trash2, Pencil, LogOut, SmilePlus, X } from "lucide-react"
import { toast } from "sonner"
import { Visibilities } from "@threa/types"
import type { Visibility } from "@threa/types"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label as UiLabel } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { ReactionEmojiPicker } from "@/components/timeline/reaction-emoji-picker"
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
 * Route is `/w/:workspaceId/labels`. A single "Your labels" catalog (labels you
 * created plus public labels you joined). Creating — and adopting an existing
 * public label — happens in an overlay, not a separate page.
 */
export function LabelsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()

  if (!workspaceId) return null

  return <LabelsPageInner workspaceId={workspaceId} />
}

function LabelsPageInner({ workspaceId }: { workspaceId: string }) {
  useLabelsSync(workspaceId)
  const view = useLabelsView(workspaceId)
  const { mine, publicLabels, joinedLabelIds, currentUserId } = view
  const [addOpen, setAddOpen] = useState(false)

  // Your catalog: labels you authored + public labels you explicitly joined.
  const myLabels = useMemo(() => {
    const joinedPublic = publicLabels.filter((l) => l.creatorUserId !== currentUserId && joinedLabelIds.has(l.id))
    return [...mine, ...joinedPublic].sort((a, b) => a.name.localeCompare(b.name))
  }, [mine, publicLabels, joinedLabelIds, currentUserId])

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center justify-between gap-2 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarToggle location="page" />
          <Link
            to={`/w/${workspaceId}`}
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8 shrink-0")}
            aria-label="Back to workspace"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <Tag className="h-5 w-5 shrink-0 text-muted-foreground" />
            <h1 className="truncate font-semibold">Labels</h1>
          </div>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
          <SectionIntro
            title="Your labels"
            subtitle="Organize scratchpads, threads, and people with color and emoji. Private labels are yours alone; public ones are workspace-wide."
          />

          {myLabels.length === 0 ? (
            <EmptyState
              icon={Tag}
              title="No labels yet"
              body="Create your first label to start grouping the things you save, or join a public one your workspace already uses."
              action={
                <Button className="gap-1.5" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Add label
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <AddLabelTile onClick={() => setAddOpen(true)} />
              {myLabels.map((label) =>
                label.creatorUserId === currentUserId ? (
                  <OwnedLabelCard key={label.id} workspaceId={workspaceId} label={label} />
                ) : (
                  <JoinedLabelCard
                    key={label.id}
                    workspaceId={workspaceId}
                    label={label}
                    userId={currentUserId ?? ""}
                  />
                )
              )}
            </div>
          )}
        </main>
      </ScrollArea>

      <AddLabelDialog workspaceId={workspaceId} view={view} open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add label overlay (create new + join an existing public label)
// ---------------------------------------------------------------------------

function AddLabelDialog({
  workspaceId,
  view,
  open,
  onOpenChange,
}: {
  workspaceId: string
  view: LabelViewerContext
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isOnline = useIsOnline()
  const createMutation = useCreateLabel(workspaceId)
  const joinMutation = useJoinLabel(workspaceId)
  const [name, setName] = useState("")
  const [visibility, setVisibility] = useState<Visibility>(Visibilities.PRIVATE)
  const [color, setColor] = useState<string>(PRESET_COLORS[5])
  const [emoji, setEmoji] = useState<string>("")
  const [description, setDescription] = useState("")

  const reset = () => {
    setName("")
    setVisibility(Visibilities.PRIVATE)
    setColor(PRESET_COLORS[5])
    setEmoji("")
    setDescription("")
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const query = name.trim().toLowerCase()
  const joinMatches = useMemo(() => {
    if (!query) return view.discoverable
    return view.discoverable.filter((l) => l.name.toLowerCase().includes(query))
  }, [view.discoverable, query])

  const handleCreate = (e: FormEvent) => {
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
          handleOpenChange(false)
        },
        onError: () => toast.error("Could not create label"),
      }
    )
  }

  const handleJoin = (label: CachedLabel) => {
    joinMutation.mutate(label.id, {
      onSuccess: () => {
        toast.success(`Joined ${label.name}`)
        handleOpenChange(false)
      },
      onError: () => toast.error("Could not join label"),
    })
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange} disableSnapPoints>
      <ResponsiveDialogContent
        desktopClassName="sm:flex sm:max-h-[85vh] sm:max-w-lg sm:flex-col p-0 gap-0"
        drawerClassName="flex max-h-[92dvh] flex-col gap-0"
      >
        <ResponsiveDialogHeader className="border-b px-4 py-4 sm:px-6 sm:py-5">
          <ResponsiveDialogTitle>Add a label</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Join a public label your workspace already uses, or create a new one.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <form onSubmit={handleCreate} className="flex min-h-0 flex-1 flex-col">
          <ResponsiveDialogBody className="space-y-5 py-4">
            {!isOnline && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                You're offline. Labels need a live connection.
              </div>
            )}

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

            {joinMatches.length > 0 && (
              <div>
                <SubsectionHeading title={query ? "Matching public labels" : "Public labels you can join"} />
                <div className="space-y-1.5">
                  {joinMatches.map((label) => (
                    <JoinMatchRow
                      key={label.id}
                      label={label}
                      disabled={!isOnline || joinMutation.isPending}
                      onJoin={() => handleJoin(label)}
                    />
                  ))}
                </div>
                <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  <span>or create a new label</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              </div>
            )}

            <Field label="Visibility" htmlFor="label-visibility">
              <VisibilityPicker value={visibility} onChange={setVisibility} />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {visibility === Visibilities.PUBLIC
                  ? "Visible to everyone in the workspace. Members join to subscribe. You can't undo this."
                  : "Only you can see this label. You can promote it to public later."}
              </p>
            </Field>

            <Field label="Color" htmlFor="label-color">
              <ColorRow value={color} onChange={setColor} />
            </Field>

            <Field label="Emoji" htmlFor="label-emoji">
              <EmojiField workspaceId={workspaceId} value={emoji} onChange={setEmoji} />
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
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter className="border-t px-4 py-3 sm:px-6">
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!isOnline || createMutation.isPending || !name.trim()}>
              {createMutation.isPending ? "Creating..." : "Create label"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function JoinMatchRow({ label, disabled, onJoin }: { label: CachedLabel; disabled: boolean; onJoin: () => void }) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2"
      style={{ borderLeft: `3px solid ${label.color}` }}
    >
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base"
        style={{ backgroundColor: hexToRgba(label.color, 0.12), color: label.color }}
        aria-hidden
      >
        {label.emoji ?? <Tag className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight">{label.name}</p>
        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          <Globe className="h-3 w-3" />
          <span>Public</span>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 shrink-0 px-3 text-xs"
        onClick={onJoin}
        disabled={disabled}
      >
        Join
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Catalog cards
// ---------------------------------------------------------------------------

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
          {label.visibility === Visibilities.PRIVATE && (
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
        <EmojiField workspaceId={workspaceId} value={emoji} onChange={setEmoji} />
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
              {label.visibility === Visibilities.PUBLIC ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              <span>{label.visibility === Visibilities.PUBLIC ? "Public" : "Private"}</span>
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

function AddLabelTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card/40 text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
        <Plus className="h-4 w-4" />
      </div>
      <span className="text-sm font-medium">Add label</span>
    </button>
  )
}

function SectionIntro({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6 max-w-2xl">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
    </div>
  )
}

function SubsectionHeading({ title }: { title: string }) {
  return <h3 className="mb-2 text-sm font-semibold">{title}</h3>
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

function EmojiField({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string
  value: string
  onChange: (next: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ReactionEmojiPicker
        workspaceId={workspaceId}
        onSelect={onChange}
        trigger={
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-lg border text-lg leading-none transition-colors hover:border-foreground/30"
            aria-label="Search emoji"
          >
            {value || <SmilePlus className="h-4 w-4 text-muted-foreground" />}
          </button>
        }
      />
      <div className="h-5 w-px bg-border" />
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
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      )}
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
