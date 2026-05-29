import { useMemo } from "react"
import { GripVertical, Plus, X } from "lucide-react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  SIDEBAR_SECTION_KEYS,
  SIDEBAR_TYPE_SECTIONS,
  SIDEBAR_BASE_PRESETS,
  type SidebarSection,
  type SidebarSectionSpec,
  type SidebarQuickLink,
  type SidebarBasePreset,
} from "@threa/types"
import { cn } from "@/lib/utils"
import { usePreferences } from "@/contexts"
import { useSidebarConfig } from "@/hooks/use-sidebar-config"
import { useWorkspaceLabels } from "@/stores/workspace-store"
import type { CachedLabel } from "@/hooks"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { LabelChip } from "@/components/labels/label-chip"
import { QUICK_LINK_META } from "./quick-links"
import {
  isPristinePreset,
  moveSection,
  addSection,
  removeSection,
  hasSection,
  sectionPresentation,
  toggleQuickLink,
  moveQuickLink,
} from "./sidebar-config"

const PRESET_LABELS: Record<SidebarBasePreset, string> = { smart: "Smart", all: "All" }

interface SidebarEditorDialogProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The full "Customize sidebar" panel. Pick a preset to seed from, then make the
 * sidebar yours: reorder quick links and hide ones you don't use, reorder stream
 * sections, add any section the layout lacks (smart buckets, stream types,
 * pinnable labels), or remove sections. Every action persists immediately
 * through {@link useSidebarConfig} (optimistic + cross-device sync) — there is no
 * separate save step, so the live sidebar reflects each change as it's made.
 */
export function SidebarEditorDialog({ workspaceId, open, onOpenChange }: SidebarEditorDialogProps) {
  const { config, setConfig, setBasePreset } = useSidebarConfig(workspaceId)
  const { preferences } = usePreferences()
  // dnd-kit applies its reorder transition via an inline style, which the global
  // `.reduced-motion` stylesheet rule can't reach — so gate it here.
  const reduceMotion = preferences?.accessibility.reducedMotion ?? false
  const labels = useWorkspaceLabels(workspaceId)
  const labelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels])

  // Pointer for mouse/touch, keyboard for accessible reordering (space to lift,
  // arrows to move, space to drop) — dnd-kit wires the ARIA announcements.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const activePreset = isPristinePreset(config)
  const sectionIds = useMemo(() => config.sections.map((s) => s.id), [config.sections])
  const quickLinkKeys = useMemo(() => config.quickLinks.map((l) => l.key), [config.quickLinks])

  const addableSmart = SIDEBAR_SECTION_KEYS.map((bucket): SidebarSectionSpec => ({ kind: "smart", bucket })).filter(
    (spec) => !hasSection(config, spec)
  )
  const addableTypes = SIDEBAR_TYPE_SECTIONS.map(
    (streamType): SidebarSectionSpec => ({ kind: "type", streamType })
  ).filter((spec) => !hasSection(config, spec))
  const addableLabels = labels.filter((label) => !hasSection(config, { kind: "label", labelId: label.id }))
  const hasAddable = addableSmart.length + addableTypes.length + addableLabels.length > 0

  const handleSectionDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) setConfig(moveSection(config, String(active.id), String(over.id)))
  }
  const handleQuickLinkDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) setConfig(moveQuickLink(config, String(active.id), String(over.id)))
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-md sm:max-h-[80vh]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Customize sidebar</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Start from a preset, then reorder, hide, add, or remove anything.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="space-y-5">
          <section className="space-y-2">
            <EditorGroupHeading>Preset</EditorGroupHeading>
            <div className="inline-flex gap-1 rounded-md bg-muted p-0.5">
              {SIDEBAR_BASE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={activePreset === preset}
                  onClick={() => setBasePreset(preset)}
                  className={cn(
                    "rounded px-3 py-1 text-xs font-medium transition-all",
                    activePreset === preset ? "bg-card text-primary" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {PRESET_LABELS[preset]}
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <EditorGroupHeading>Quick links</EditorGroupHeading>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleQuickLinkDragEnd}>
              <SortableContext items={quickLinkKeys} strategy={verticalListSortingStrategy}>
                <ul className="space-y-1">
                  {config.quickLinks.map((link) => (
                    <SortableQuickLinkRow
                      key={link.key}
                      link={link}
                      reduceMotion={reduceMotion}
                      onToggle={() => setConfig(toggleQuickLink(config, link.key))}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          </section>

          <section className="space-y-2">
            <EditorGroupHeading>Sections</EditorGroupHeading>
            {config.sections.length === 0 ? (
              <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
                No sections. Add one below or reset to a preset.
              </p>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleSectionDragEnd}>
                <SortableContext items={sectionIds} strategy={verticalListSortingStrategy}>
                  <ul className="space-y-1">
                    {config.sections.map((section) => (
                      <SortableSectionRow
                        key={section.id}
                        section={section}
                        labelsById={labelsById}
                        reduceMotion={reduceMotion}
                        onRemove={() => setConfig(removeSection(config, section.id))}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="w-full gap-1.5" disabled={!hasAddable}>
                  <Plus className="h-3.5 w-3.5" />
                  {hasAddable ? "Add section" : "All sections added"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
                {addableSmart.map((spec) => (
                  <AddSectionItem
                    key={`smart:${spec.kind === "smart" ? spec.bucket : ""}`}
                    onSelect={() => setConfig(addSection(config, spec))}
                  >
                    <span aria-hidden>{sectionPresentation(spec).icon}</span>
                    {sectionPresentation(spec).label}
                  </AddSectionItem>
                ))}
                {addableTypes.map((spec) => (
                  <AddSectionItem
                    key={`type:${spec.kind === "type" ? spec.streamType : ""}`}
                    onSelect={() => setConfig(addSection(config, spec))}
                  >
                    {sectionPresentation(spec).label}
                  </AddSectionItem>
                ))}
                {addableLabels.length > 0 && (addableSmart.length > 0 || addableTypes.length > 0) && (
                  <DropdownMenuSeparator />
                )}
                {addableLabels.length > 0 && <DropdownMenuLabel>Labels</DropdownMenuLabel>}
                {addableLabels.map((label) => (
                  <AddSectionItem
                    key={`label:${label.id}`}
                    onSelect={() => setConfig(addSection(config, { kind: "label", labelId: label.id }))}
                  >
                    <LabelChip label={label} className="pointer-events-none" />
                  </AddSectionItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </section>
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter className="border-t px-4 py-3 sm:px-6">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/** Small uppercase group heading inside the editor. Top-level per INV-18. */
function EditorGroupHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
}

/** A reorderable quick-link row with a visibility switch. Top-level per INV-18. */
function SortableQuickLinkRow({
  link,
  reduceMotion,
  onToggle,
}: {
  link: SidebarQuickLink
  reduceMotion: boolean
  onToggle: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: link.key })
  const style = { transform: CSS.Transform.toString(transform), transition: reduceMotion ? undefined : transition }
  const { label, icon: Icon } = QUICK_LINK_META[link.key]

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 rounded-md border bg-card px-2 py-1.5",
        isDragging && "relative z-10 shadow-md"
      )}
    >
      <DragHandle label={`Reorder ${label}`} attributes={attributes} listeners={listeners} />
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium",
          !link.enabled && "text-muted-foreground"
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <Switch checked={link.enabled} onCheckedChange={onToggle} aria-label={`Show ${label}`} />
    </li>
  )
}

/** A reorderable section row with a remove button. Top-level per INV-18. */
function SortableSectionRow({
  section,
  labelsById,
  reduceMotion,
  onRemove,
}: {
  section: SidebarSection
  labelsById: Map<string, CachedLabel>
  reduceMotion: boolean
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id })
  const style = { transform: CSS.Transform.toString(transform), transition: reduceMotion ? undefined : transition }
  const name = sectionDisplayName(section, labelsById)

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 rounded-md border bg-card px-2 py-1.5",
        isDragging && "relative z-10 shadow-md"
      )}
    >
      <DragHandle label={`Reorder ${name}`} attributes={attributes} listeners={listeners} />
      <div className="min-w-0 flex-1">
        <SectionRowContent section={section} labelsById={labelsById} />
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  )
}

type SortableHandle = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">

/** The grip used to drag a row. Top-level per INV-18. */
function DragHandle({
  label,
  attributes,
  listeners,
}: {
  label: string
  attributes: SortableHandle["attributes"]
  listeners: SortableHandle["listeners"]
}) {
  return (
    <button
      type="button"
      className="flex h-6 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      aria-label={label}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="h-4 w-4" />
    </button>
  )
}

/** The visual for a section row: a tinted chip for labels, icon + name otherwise. */
function SectionRowContent({ section, labelsById }: { section: SidebarSection; labelsById: Map<string, CachedLabel> }) {
  if (section.spec.kind === "label") {
    const label = labelsById.get(section.spec.labelId)
    if (!label) return <span className="truncate text-sm italic text-muted-foreground">Unavailable label</span>
    return <LabelChip label={label} />
  }
  const { label, icon } = sectionPresentation(section.spec)
  return (
    <span className="flex items-center gap-1.5 truncate text-sm font-medium">
      {icon && <span aria-hidden>{icon}</span>}
      {label}
    </span>
  )
}

/** Plain-text name for a section, for the reorder/remove button aria-labels. */
function sectionDisplayName(section: SidebarSection, labelsById: Map<string, CachedLabel>): string {
  if (section.spec.kind === "label") return labelsById.get(section.spec.labelId)?.name ?? "label section"
  return sectionPresentation(section.spec).label
}

/** A dropdown row that adds a section; closes the menu on select. Top-level per INV-18. */
function AddSectionItem({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="gap-1.5">
      {children}
    </DropdownMenuItem>
  )
}
