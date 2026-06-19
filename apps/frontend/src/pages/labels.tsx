import { useState, type FormEvent } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, Tag, Plus, Trash2, Pencil } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { SidebarToggle } from "@/components/layout"
import { useIsOnline } from "@/components/layout/connection-status"
import { cn } from "@/lib/utils"
import { hexToRgba } from "@/lib/labels"
import { stripMarkdownToInline } from "@/lib/markdown"
import { useCreateLabel, useDeleteLabel, useLabelsSync, useLabelsView, type CachedLabel } from "@/hooks"
import { ColorRow, EmojiField, Field, LabelEditForm, PRESET_COLORS } from "@/components/labels/label-edit-form"

/**
 * Route is `/w/:workspaceId/labels`. A single "Your labels" catalog — every
 * label is private to you. Creating happens in an overlay, not a separate page.
 */
export function LabelsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()

  if (!workspaceId) return null

  return <LabelsPageInner workspaceId={workspaceId} />
}

function LabelsPageInner({ workspaceId }: { workspaceId: string }) {
  useLabelsSync(workspaceId)
  const { myLabels } = useLabelsView(workspaceId)
  const [addOpen, setAddOpen] = useState(false)

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
            subtitle="Organize scratchpads, threads, and people with color and emoji. Labels are yours alone."
          />

          {myLabels.length === 0 ? (
            <EmptyState
              icon={Tag}
              title="No labels yet"
              body="Create your first label to start grouping the things you save."
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
              {myLabels.map((label) => (
                <OwnedLabelCard key={label.id} workspaceId={workspaceId} label={label} />
              ))}
            </div>
          )}
        </main>
      </ScrollArea>

      <AddLabelDialog workspaceId={workspaceId} open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}

function AddLabelDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isOnline = useIsOnline()
  const createMutation = useCreateLabel(workspaceId)
  const [name, setName] = useState("")
  const [color, setColor] = useState<string>(PRESET_COLORS[5])
  const [emoji, setEmoji] = useState<string>("")
  const [description, setDescription] = useState("")

  const reset = () => {
    setName("")
    setColor(PRESET_COLORS[5])
    setEmoji("")
    setDescription("")
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const handleCreate = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    createMutation.mutate(
      {
        name: name.trim(),
        color,
        emoji: emoji.trim() || null,
        description: description.trim() || null,
      },
      {
        onSuccess: () => {
          handleOpenChange(false)
        },
        onError: () => toast.error("Could not create label"),
      }
    )
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange} disableSnapPoints>
      <ResponsiveDialogContent
        desktopClassName="sm:flex sm:max-h-[85vh] sm:max-w-lg sm:flex-col p-0 gap-0"
        drawerClassName="flex max-h-[92dvh] flex-col gap-0"
      >
        <ResponsiveDialogHeader className="border-b px-4 py-4 sm:px-6 sm:py-5">
          <ResponsiveDialogTitle>Add a label</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>Create a label to organize your streams.</ResponsiveDialogDescription>
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

function OwnedLabelCard({ workspaceId, label }: { workspaceId: string; label: CachedLabel }) {
  const isOnline = useIsOnline()
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteMutation = useDeleteLabel(workspaceId)

  const handleDelete = () => {
    deleteMutation.mutate(label.id, {
      onSuccess: () => {
        setConfirmDelete(false)
      },
      onError: () => toast.error("Could not delete label"),
    })
  }

  if (editing) {
    return <LabelEditForm workspaceId={workspaceId} label={label} onDone={() => setEditing(false)} variant="card" />
  }

  return (
    <>
      <LabelSwatchCard workspaceId={workspaceId} label={label}>
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
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={!isOnline || deleteMutation.isPending}
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        </div>
      </LabelSwatchCard>

      <ResponsiveAlertDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(false)
        }}
      >
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>Delete “{label.name}”?</ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              It will be archived and removed from everything it's applied to. You can't undo this.
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  )
}

function LabelSwatchCard({
  workspaceId,
  label,
  children,
}: {
  workspaceId: string
  label: CachedLabel
  children?: React.ReactNode
}) {
  return (
    <article
      className="relative flex min-h-[160px] flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/20"
      style={{ borderLeft: `3px solid ${label.color}` }}
    >
      <div className="flex flex-1 flex-col p-3.5">
        {/* The identity block opens the label's landing page (INV-40: navigation
            is a link); the action buttons below stay outside it as buttons. */}
        <Link to={`/w/${workspaceId}/labels/${label.id}`} className="group flex flex-1 flex-col rounded-md">
          <div className="flex items-start gap-2.5">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xl"
              style={{ backgroundColor: hexToRgba(label.color, 0.12), color: label.color }}
              aria-hidden
            >
              {label.emoji ?? <Tag className="h-4 w-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-semibold leading-tight group-hover:underline">{label.name}</h3>
            </div>
          </div>
          {label.description && (
            <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {stripMarkdownToInline(label.description)}
            </p>
          )}
        </Link>
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
