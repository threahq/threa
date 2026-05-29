import { useMemo } from "react"
import { CircleDot, Eye, EyeOff, GripVertical, RotateCcw, X } from "lucide-react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
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
  type SidebarQuickLinkVisibility,
  type SidebarBasePreset,
  quickLinkHasActiveState,
} from "@threa/types"
import { cn } from "@/lib/utils"
import { usePreferences } from "@/contexts"
import { useSidebarConfig } from "@/hooks/use-sidebar-config"
import { useWorkspaceLabels } from "@/stores/workspace-store"
import type { CachedLabel } from "@/hooks"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
import { BADGE_CONFIG } from "./config"
import {
  isPristinePreset,
  moveSection,
  addSection,
  addSectionAt,
  removeSection,
  hasSection,
  sectionPresentation,
  sectionIdForSpec,
  setQuickLinkVisibility,
  moveQuickLink,
} from "./sidebar-config"

const PRESET_LABELS: Record<SidebarBasePreset, string> = { smart: "Smart", all: "All" }

/** Tray draggable ids are prefixed so they never collide with section sortable ids. */
const ADD_PREFIX = "add:"
/** Droppable id for the sections list, so a tray drop into an empty list appends. */
const SECTIONS_DROPPABLE_ID = "sections-dropzone"

interface SidebarEditorDialogProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The full "Customize sidebar" panel. Everything is one ordered list of sections
 * — stream buckets, stream types, pinned labels, and the Quick Links block — that
 * you drag to reorder, drag in from the Add tray, or remove. The Quick Links
 * section expands to reorder its links and set each one's visibility
 * (show / show when active / hide). Pick a preset to seed from, or reset to one.
 * Every action persists immediately through {@link useSidebarConfig} (optimistic +
 * cross-device sync) — there is no save step, so the live sidebar reflects each
 * change as it's made.
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

  // Specs the layout doesn't have yet — the Add tray's draggable/clickable chips.
  const addableSpecs = useMemo<SidebarSectionSpec[]>(() => {
    const specs: SidebarSectionSpec[] = []
    if (!hasSection(config, { kind: "quicklinks" })) specs.push({ kind: "quicklinks" })
    for (const bucket of SIDEBAR_SECTION_KEYS) {
      const spec: SidebarSectionSpec = { kind: "smart", bucket }
      if (!hasSection(config, spec)) specs.push(spec)
    }
    for (const streamType of SIDEBAR_TYPE_SECTIONS) {
      const spec: SidebarSectionSpec = { kind: "type", streamType }
      if (!hasSection(config, spec)) specs.push(spec)
    }
    for (const label of labels) {
      const spec: SidebarSectionSpec = { kind: "label", labelId: label.id }
      if (!hasSection(config, spec)) specs.push(spec)
    }
    return specs
  }, [config, labels])

  // One drop handler for the sections context: a tray chip adds a section at the
  // drop position; a section drag reorders. Tray ids carry the ADD_PREFIX.
  const handleSectionsDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const activeId = String(active.id)

    if (activeId.startsWith(ADD_PREFIX)) {
      const specId = activeId.slice(ADD_PREFIX.length)
      const spec = addableSpecs.find((s) => sectionIdForSpec(s) === specId)
      if (!spec) return
      // Dropped on the list body (empty list) → append; on a section → insert there.
      const index =
        String(over.id) === SECTIONS_DROPPABLE_ID
          ? config.sections.length
          : config.sections.findIndex((s) => s.id === String(over.id))
      setConfig(addSectionAt(config, spec, index === -1 ? config.sections.length : index))
      return
    }

    if (activeId !== String(over.id)) setConfig(moveSection(config, activeId, String(over.id)))
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="sm:max-w-md sm:max-h-[80vh] sm:flex flex-col gap-0 p-0"
        drawerClassName="flex flex-col"
      >
        <ResponsiveDialogHeader className="border-b px-4 py-3 sm:px-6">
          <ResponsiveDialogTitle>Customize sidebar</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Drag to reorder, drag in from the tray to add, or remove anything — including Quick Links.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="space-y-5 py-5 sm:py-6">
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <EditorGroupHeading>Preset</EditorGroupHeading>
              <button
                type="button"
                onClick={() => setBasePreset(activePreset ?? config.basePreset)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotateCcw className="h-3 w-3" />
                Reset preset
              </button>
            </div>
            <div role="group" aria-label="Preset" className="inline-flex gap-1 rounded-md bg-muted p-0.5">
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
            <EditorGroupHeading>Sections</EditorGroupHeading>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleSectionsDragEnd}>
              <SectionsList
                sections={config.sections}
                sectionIds={sectionIds}
                labelsById={labelsById}
                quickLinks={config.quickLinks}
                reduceMotion={reduceMotion}
                onRemoveSection={(id) => setConfig(removeSection(config, id))}
                onSetQuickLinkVisibility={(key, visibility) =>
                  setConfig(setQuickLinkVisibility(config, key, visibility))
                }
                onMoveQuickLink={(activeKey, overKey) => setConfig(moveQuickLink(config, activeKey, overKey))}
              />

              <AddTray
                specs={addableSpecs}
                labelsById={labelsById}
                onAdd={(spec) => setConfig(addSection(config, spec))}
              />
            </DndContext>
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

/** The droppable, sortable list of section rows. Top-level per INV-18. */
function SectionsList({
  sections,
  sectionIds,
  labelsById,
  quickLinks,
  reduceMotion,
  onRemoveSection,
  onSetQuickLinkVisibility,
  onMoveQuickLink,
}: {
  sections: SidebarSection[]
  sectionIds: string[]
  labelsById: Map<string, CachedLabel>
  quickLinks: SidebarQuickLink[]
  reduceMotion: boolean
  onRemoveSection: (id: string) => void
  onSetQuickLinkVisibility: (key: SidebarQuickLink["key"], visibility: SidebarQuickLinkVisibility) => void
  onMoveQuickLink: (activeKey: string, overKey: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: SECTIONS_DROPPABLE_ID })

  if (sections.length === 0) {
    return (
      <p
        ref={setNodeRef}
        className={cn(
          "rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground",
          isOver && "border-primary/60 bg-primary/5"
        )}
      >
        Empty sidebar. Drag an item from below, or reset to a preset.
      </p>
    )
  }

  return (
    <div ref={setNodeRef} className={cn("rounded-lg", isOver && "ring-2 ring-primary/40")}>
      <SortableContext items={sectionIds} strategy={verticalListSortingStrategy}>
        <ul className="space-y-1">
          {sections.map((section) => (
            <SortableSectionRow
              key={section.id}
              section={section}
              labelsById={labelsById}
              quickLinks={quickLinks}
              reduceMotion={reduceMotion}
              onRemove={() => onRemoveSection(section.id)}
              onSetQuickLinkVisibility={onSetQuickLinkVisibility}
              onMoveQuickLink={onMoveQuickLink}
            />
          ))}
        </ul>
      </SortableContext>
    </div>
  )
}

/** A reorderable section row with a remove button. The Quick Links section also
 *  renders its nested link editor beneath the row. Top-level per INV-18. */
function SortableSectionRow({
  section,
  labelsById,
  quickLinks,
  reduceMotion,
  onRemove,
  onSetQuickLinkVisibility,
  onMoveQuickLink,
}: {
  section: SidebarSection
  labelsById: Map<string, CachedLabel>
  quickLinks: SidebarQuickLink[]
  reduceMotion: boolean
  onRemove: () => void
  onSetQuickLinkVisibility: (key: SidebarQuickLink["key"], visibility: SidebarQuickLinkVisibility) => void
  onMoveQuickLink: (activeKey: string, overKey: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id })
  const style = { transform: CSS.Transform.toString(transform), transition: reduceMotion ? undefined : transition }
  const name = sectionDisplayName(section, labelsById)
  const isQuickLinks = section.spec.kind === "quicklinks"

  return (
    <li ref={setNodeRef} style={style} className={cn(isDragging && "relative z-10")}>
      <div className={cn("flex items-center gap-2 rounded-md border bg-card px-2 py-1.5", isDragging && "shadow-md")}>
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
      </div>

      {isQuickLinks && (
        <QuickLinksSectionBody
          quickLinks={quickLinks}
          reduceMotion={reduceMotion}
          onSetVisibility={onSetQuickLinkVisibility}
          onMove={onMoveQuickLink}
        />
      )}
    </li>
  )
}

/** The nested reorder/visibility editor for the quick links, indented under the
 *  Quick Links section row. Its own DndContext so quick-link drags don't bubble
 *  to the sections list. Top-level per INV-18. */
function QuickLinksSectionBody({
  quickLinks,
  reduceMotion,
  onSetVisibility,
  onMove,
}: {
  quickLinks: SidebarQuickLink[]
  reduceMotion: boolean
  onSetVisibility: (key: SidebarQuickLink["key"], visibility: SidebarQuickLinkVisibility) => void
  onMove: (activeKey: string, overKey: string) => void
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const keys = useMemo(() => quickLinks.map((l) => l.key), [quickLinks])

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) onMove(String(active.id), String(over.id))
  }

  return (
    <div className="ml-4 mt-1 border-l pl-3">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1">
            {quickLinks.map((link) => (
              <SortableQuickLinkRow
                key={link.key}
                link={link}
                reduceMotion={reduceMotion}
                onSetVisibility={(visibility) => onSetVisibility(link.key, visibility)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  )
}

/** A reorderable quick-link row with a tri-state visibility control. Top-level per INV-18. */
function SortableQuickLinkRow({
  link,
  reduceMotion,
  onSetVisibility,
}: {
  link: SidebarQuickLink
  reduceMotion: boolean
  onSetVisibility: (visibility: SidebarQuickLinkVisibility) => void
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
          link.visibility === "hidden" && "text-muted-foreground"
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <QuickLinkVisibilityControl link={link} onSetVisibility={onSetVisibility} />
    </li>
  )
}

/** Show / Show-when-active / Hide segmented control. The middle state is offered
 *  only for links that carry a live signal. Top-level per INV-18. */
function QuickLinkVisibilityControl({
  link,
  onSetVisibility,
}: {
  link: SidebarQuickLink
  onSetVisibility: (visibility: SidebarQuickLinkVisibility) => void
}) {
  const { label } = QUICK_LINK_META[link.key]
  const hasActive = quickLinkHasActiveState(link.key)

  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={link.visibility}
      // Radix clears the value when you click the active item; ignore the empty
      // string so a link can't end up in an undefined visibility.
      onValueChange={(value) => {
        if (value) onSetVisibility(value as SidebarQuickLinkVisibility)
      }}
      className="shrink-0 gap-0.5"
    >
      <ToggleGroupItem value="show" aria-label={`Show ${label}`} className="h-7 w-7 p-0">
        <Eye className="h-3.5 w-3.5" />
      </ToggleGroupItem>
      {hasActive && (
        <ToggleGroupItem value="active" aria-label={`Show ${label} when active`} className="h-7 w-7 p-0">
          <CircleDot className="h-3.5 w-3.5" />
        </ToggleGroupItem>
      )}
      <ToggleGroupItem value="hidden" aria-label={`Hide ${label}`} className="h-7 w-7 p-0">
        <EyeOff className="h-3.5 w-3.5" />
      </ToggleGroupItem>
    </ToggleGroup>
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
  // Stream-type sections carry no emoji; mirror the live sidebar's lucide glyph
  // (BADGE_CONFIG) so a reordered "Channels"/"Scratchpads"/"DMs" row stays
  // recognizable. Smart buckets use their emoji from sectionPresentation; Quick
  // Links has no emoji, just its name.
  const { label, icon } = sectionPresentation(section.spec)
  const TypeIcon = section.spec.kind === "type" ? BADGE_CONFIG[section.spec.streamType].icon : null
  return (
    <span className="flex items-center gap-1.5 truncate text-sm font-medium">
      {TypeIcon ? (
        <TypeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        icon && <span aria-hidden>{icon}</span>
      )}
      {label}
    </span>
  )
}

/** Plain-text name for a section, for the reorder/remove button aria-labels. */
function sectionDisplayName(section: SidebarSection, labelsById: Map<string, CachedLabel>): string {
  if (section.spec.kind === "label") return labelsById.get(section.spec.labelId)?.name ?? "label section"
  return sectionPresentation(section.spec).label
}

/** The always-visible tray of addable sections. Each chip can be dragged onto the
 *  list at a position, or clicked to append. Top-level per INV-18. */
function AddTray({
  specs,
  labelsById,
  onAdd,
}: {
  specs: SidebarSectionSpec[]
  labelsById: Map<string, CachedLabel>
  onAdd: (spec: SidebarSectionSpec) => void
}) {
  if (specs.length === 0) {
    return <p className="pt-1 text-xs text-muted-foreground">Everything's in your sidebar.</p>
  }

  return (
    <div className="space-y-1.5 pt-1">
      <p className="text-xs text-muted-foreground">Drag in, or tap to add:</p>
      <ul className="flex flex-wrap gap-1.5">
        {specs.map((spec) => (
          <AddTrayChip key={sectionIdForSpec(spec)} spec={spec} labelsById={labelsById} onAdd={() => onAdd(spec)} />
        ))}
      </ul>
    </div>
  )
}

/** A draggable + clickable Add-tray chip. Top-level per INV-18. */
function AddTrayChip({
  spec,
  labelsById,
  onAdd,
}: {
  spec: SidebarSectionSpec
  labelsById: Map<string, CachedLabel>
  onAdd: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${ADD_PREFIX}${sectionIdForSpec(spec)}`,
  })
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined
  const name = sectionDisplayName({ id: sectionIdForSpec(spec), spec }, labelsById)
  const label = spec.kind === "label" ? labelsById.get(spec.labelId) : undefined

  return (
    <li>
      <button
        ref={setNodeRef}
        type="button"
        style={style}
        onClick={onAdd}
        aria-label={`Add ${name}`}
        className={cn(
          "flex cursor-grab touch-none items-center gap-1 rounded-full border border-dashed bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-solid hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
          isDragging && "opacity-50"
        )}
        {...attributes}
        {...listeners}
      >
        {label ? <LabelChip label={label} className="pointer-events-none" /> : name}
      </button>
    </li>
  )
}
