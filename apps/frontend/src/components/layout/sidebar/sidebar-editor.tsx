import { memo, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CircleDot, Eye, EyeOff, FolderInput, GripVertical, Plus, RotateCcw, X } from "lucide-react"
import {
  DndContext,
  DragOverlay,
  useDndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type CollisionDetection,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import {
  SIDEBAR_SECTION_KEYS,
  SIDEBAR_TYPE_SECTIONS,
  SIDEBAR_BASE_PRESETS,
  MAX_CUSTOM_SECTION_NAME_LENGTH,
  type SidebarSection,
  type SidebarSectionSpec,
  type SidebarQuickLink,
  type SidebarQuickLinkVisibility,
  type SidebarBasePreset,
  quickLinkHasActiveState,
} from "@threahq/types"
import { cn } from "@/lib/utils"
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
import { QUICK_LINK_META } from "./quick-link-meta"
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
  createCustomSection,
  renameCustomSection,
  newCustomSectionId,
} from "./sidebar-config"

const PRESET_LABELS: Record<SidebarBasePreset, string> = { smart: "Smart", all: "All" }

/** Tray draggable ids are prefixed so they never collide with section sortable ids. */
const ADD_PREFIX = "add:"
/** Droppable id for the sections list, so a tray drop into an empty list appends. */
const SECTIONS_DROPPABLE_ID = "sections-dropzone"
const QUICK_LINKS_DROPPABLE_ID = "quicklinks-dropzone"

type InsertionTarget = { index: number; rowId: string; edge: "before" | "after" }

function insertionTarget(collisions: DragEndEvent["collisions"]): InsertionTarget | undefined {
  return collisions?.[0]?.data?.insertion as InsertionTarget | undefined
}

function insertionCollision(ids: string[], listId: string): CollisionDetection {
  return (args) => {
    const { active, pointerCoordinates, droppableContainers, droppableRects } = args
    const activeIndex = ids.indexOf(String(active.id))
    let target: InsertionTarget
    if (pointerCoordinates) {
      const list = droppableContainers.find((container) => container.id === listId)?.node.current
      const hit = document.elementFromPoint(pointerCoordinates.x, pointerCoordinates.y)
      if (!list || !hit || !list.contains(hit)) return []
      let gap = ids.length
      for (let index = 0; index < ids.length; index++) {
        const rect = droppableRects.get(ids[index]!)
        if (rect && pointerCoordinates.y < rect.top + rect.height / 2) {
          gap = index
          break
        }
      }
      target = {
        index: gap - (activeIndex >= 0 && activeIndex < gap ? 1 : 0),
        rowId: ids[gap] ?? ids.at(-1) ?? listId,
        edge: gap < ids.length || ids.length === 0 ? "before" : "after",
      }
    } else {
      const collision = closestCenter({
        ...args,
        droppableContainers: droppableContainers.filter((container) => ids.includes(String(container.id))),
      })[0]
      if (!collision) return []
      const index = ids.indexOf(String(collision.id))
      target = { index, rowId: String(collision.id), edge: index > activeIndex ? "after" : "before" }
    }
    const id = target.rowId
    const droppableContainer = droppableContainers.find((container) => container.id === id)
    if (!droppableContainer) return []
    return [{ id, data: { droppableContainer, value: 1, insertion: target } }]
  }
}

function InsertionMarker({ rowId }: { rowId: string }) {
  const { collisions } = useDndContext()
  const target = insertionTarget(collisions)
  if (target?.rowId !== rowId) return null
  return (
    <span
      aria-hidden
      data-testid="sidebar-insertion-marker"
      data-edge={target.edge}
      data-index={target.index}
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-primary",
        target.edge === "before" ? "-top-0.5" : "-bottom-0.5"
      )}
    />
  )
}

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
export const SidebarEditorDialog = memo(function SidebarEditorDialog({
  workspaceId,
  open,
  onOpenChange,
}: SidebarEditorDialogProps) {
  const { config, setConfig, setBasePreset } = useSidebarConfig(workspaceId)
  const editorSectionRef = useRef<HTMLElement>(null)
  const canScroll = (element: Element) => element === editorSectionRef.current?.parentElement
  const labels = useWorkspaceLabels(workspaceId)
  const labelsById = useMemo(() => new Map(labels.map((label) => [label.id, label])), [labels])

  // Pointer for mouse/touch, keyboard for accessible reordering (space to lift,
  // arrows to move, space to drop) — dnd-kit wires the ARIA announcements.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // The preset this layout is pristinely equal to (highlights its toggle), or
  // null once the user has customized it — in which case Reset is available.
  const activePreset = isPristinePreset(config)
  const isCustomized = activePreset === null
  const sectionIds = useMemo(() => config.sections.map((s) => s.id), [config.sections])

  // Specs the layout doesn't have yet — the Add tray's draggable/clickable chips.
  const addableSpecs = useMemo<SidebarSectionSpec[]>(() => {
    const specs: SidebarSectionSpec[] = []
    if (!hasSection(config, { kind: "quicklinks" })) specs.push({ kind: "quicklinks" })
    if (!hasSection(config, { kind: "unread" })) specs.push({ kind: "unread" })
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
    const { active } = event
    const target = insertionTarget(event.collisions)
    if (!target) return
    const activeId = String(active.id)

    if (activeId.startsWith(ADD_PREFIX)) {
      const specId = activeId.slice(ADD_PREFIX.length)
      const spec = addableSpecs.find((s) => sectionIdForSpec(s) === specId)
      if (!spec) return
      setConfig(addSectionAt(config, spec, target.index))
      return
    }

    const overId = config.sections[target.index]?.id
    if (overId && activeId !== overId) setConfig(moveSection(config, activeId, overId))
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
              <Button
                variant="ghost"
                size="sm"
                // Enabled only once the layout has drifted from a preset; resetting
                // a pristine layout would be a silent no-op write.
                disabled={!isCustomized}
                onClick={() => setBasePreset(config.basePreset)}
                className="h-auto gap-1 px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
              >
                <RotateCcw className="h-3 w-3" />
                Reset preset
              </Button>
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

          <section ref={editorSectionRef} className="space-y-2">
            <EditorGroupHeading>Sections</EditorGroupHeading>
            <DndContext
              sensors={sensors}
              collisionDetection={insertionCollision(sectionIds, SECTIONS_DROPPABLE_ID)}
              autoScroll={{ canScroll }}
              onDragEnd={handleSectionsDragEnd}
            >
              <SectionsList
                sections={config.sections}
                sectionIds={sectionIds}
                labelsById={labelsById}
                quickLinks={config.quickLinks}
                canScroll={canScroll}
                onRemoveSection={(id) => setConfig(removeSection(config, id))}
                onRenameCustomSection={(sectionId, name) => setConfig(renameCustomSection(config, sectionId, name))}
                onSetQuickLinkVisibility={(key, visibility) =>
                  setConfig(setQuickLinkVisibility(config, key, visibility))
                }
                onMoveQuickLink={(activeKey, overKey) => setConfig(moveQuickLink(config, activeKey, overKey))}
              />

              <EditorDragOverlay />
              <AddTray
                specs={addableSpecs}
                labelsById={labelsById}
                onAdd={(spec) => setConfig(addSection(config, spec))}
              />
            </DndContext>

            <CustomSectionCreator
              onCreate={(name) => setConfig(createCustomSection(config, newCustomSectionId(), name))}
            />
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
})

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
  canScroll,
  onRemoveSection,
  onRenameCustomSection,
  onSetQuickLinkVisibility,
  onMoveQuickLink,
}: {
  sections: SidebarSection[]
  sectionIds: string[]
  labelsById: Map<string, CachedLabel>
  quickLinks: SidebarQuickLink[]
  canScroll: (element: Element) => boolean
  onRemoveSection: (id: string) => void
  onRenameCustomSection: (sectionId: string, name: string) => void
  onSetQuickLinkVisibility: (key: SidebarQuickLink["key"], visibility: SidebarQuickLinkVisibility) => void
  onMoveQuickLink: (activeKey: string, overKey: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: SECTIONS_DROPPABLE_ID })

  if (sections.length === 0) {
    return (
      <p
        ref={setNodeRef}
        className={cn(
          "relative rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground",
          isOver && "border-primary/60 bg-primary/5"
        )}
      >
        <InsertionMarker rowId={SECTIONS_DROPPABLE_ID} />
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
              canScroll={canScroll}
              onRemove={() => onRemoveSection(section.id)}
              onRenameCustomSection={onRenameCustomSection}
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
  canScroll,
  onRemove,
  onRenameCustomSection,
  onSetQuickLinkVisibility,
  onMoveQuickLink,
}: {
  section: SidebarSection
  labelsById: Map<string, CachedLabel>
  quickLinks: SidebarQuickLink[]
  canScroll: (element: Element) => boolean
  onRemove: () => void
  onRenameCustomSection: (sectionId: string, name: string) => void
  onSetQuickLinkVisibility: (key: SidebarQuickLink["key"], visibility: SidebarQuickLinkVisibility) => void
  onMoveQuickLink: (activeKey: string, overKey: string) => void
}) {
  const name = sectionDisplayName(section, labelsById)
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: section.id, data: { label: name } })
  const isQuickLinks = section.spec.kind === "quicklinks"

  return (
    <li ref={setNodeRef} className={cn("relative", isDragging && "opacity-40")}>
      <InsertionMarker rowId={section.id} />
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border bg-card px-2 py-1.5",
          // When the nested links render below, square off the bottom so the row
          // and its sub-list read as one connected group, not two stacked cards.
          isQuickLinks && "rounded-b-none border-b-0"
        )}
      >
        <DragHandle label={`Reorder ${name}`} attributes={attributes} listeners={listeners} />
        <div className="min-w-0 flex-1">
          <SectionRowContent section={section} labelsById={labelsById} onRenameCustomSection={onRenameCustomSection} />
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
          canScroll={canScroll}
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
  canScroll,
  onSetVisibility,
  onMove,
}: {
  quickLinks: SidebarQuickLink[]
  canScroll: (element: Element) => boolean
  onSetVisibility: (key: SidebarQuickLink["key"], visibility: SidebarQuickLinkVisibility) => void
  onMove: (activeKey: string, overKey: string) => void
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const keys = useMemo(() => quickLinks.map((l) => l.key), [quickLinks])

  const handleDragEnd = (event: DragEndEvent) => {
    const target = insertionTarget(event.collisions)
    const overKey = target && keys[target.index]
    if (overKey && event.active.id !== overKey) onMove(String(event.active.id), overKey)
  }

  // Continues the section card (it squared its bottom), indenting the links so
  // they read as sub-elements of the Quick Links block.
  return (
    <div className="rounded-b-md border border-t-0 bg-card/50 py-1.5 pl-3 pr-2">
      <DndContext
        sensors={sensors}
        collisionDetection={insertionCollision(keys, QUICK_LINKS_DROPPABLE_ID)}
        autoScroll={{ canScroll }}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          <QuickLinksDropList>
            {quickLinks.map((link) => (
              <SortableQuickLinkRow
                key={link.key}
                link={link}
                onSetVisibility={(visibility) => onSetVisibility(link.key, visibility)}
              />
            ))}
          </QuickLinksDropList>
        </SortableContext>
        <EditorDragOverlay />
      </DndContext>
    </div>
  )
}

function QuickLinksDropList({ children }: { children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: QUICK_LINKS_DROPPABLE_ID })
  return (
    <ul ref={setNodeRef} className="space-y-1 border-l border-border pl-3">
      {children}
    </ul>
  )
}

/** A reorderable quick-link row with a tri-state visibility control. Top-level per INV-18. */
function SortableQuickLinkRow({
  link,
  onSetVisibility,
}: {
  link: SidebarQuickLink
  onSetVisibility: (visibility: SidebarQuickLinkVisibility) => void
}) {
  const { label, icon: Icon } = QUICK_LINK_META[link.key]
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: link.key, data: { label } })

  return (
    <li
      ref={setNodeRef}
      className={cn(
        "relative flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40",
        isDragging && "opacity-40"
      )}
    >
      <InsertionMarker rowId={link.key} />
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
      // Outline so each item has its own border — the selected state reads
      // clearly against the muted accent fill on the tinted sub-card; the items
      // size themselves (h-8 w-8) for a comfortable tap target.
      variant="outline"
      aria-label={`${label} visibility`}
      value={link.visibility}
      // Radix clears the value when you click the active item; ignore the empty
      // string so a link can't end up in an undefined visibility.
      onValueChange={(value) => {
        if (value) onSetVisibility(value as SidebarQuickLinkVisibility)
      }}
      className="shrink-0 gap-0.5"
    >
      {/* title duplicates the aria-label as a hover tooltip — the icons (esp. the
          middle "show when active") aren't self-evident to sighted users. */}
      <ToggleGroupItem value="show" aria-label={`Show ${label}`} title={`Show ${label}`} className="h-8 w-8 p-0">
        <Eye className="h-3.5 w-3.5" />
      </ToggleGroupItem>
      {hasActive && (
        <ToggleGroupItem
          value="active"
          aria-label={`Show ${label} when active`}
          title={`Show ${label} when active`}
          className="h-8 w-8 p-0"
        >
          <CircleDot className="h-3.5 w-3.5" />
        </ToggleGroupItem>
      )}
      <ToggleGroupItem value="hidden" aria-label={`Hide ${label}`} title={`Hide ${label}`} className="h-8 w-8 p-0">
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
      data-vaul-no-drag
      {...attributes}
      {...listeners}
    >
      <GripVertical className="h-4 w-4" />
    </button>
  )
}

/** The visual for a section row: a tinted chip for labels, an editable name for
 *  custom sections, icon + name otherwise. */
function SectionRowContent({
  section,
  labelsById,
  onRenameCustomSection,
}: {
  section: SidebarSection
  labelsById: Map<string, CachedLabel>
  onRenameCustomSection: (sectionId: string, name: string) => void
}) {
  if (section.spec.kind === "label") {
    const label = labelsById.get(section.spec.labelId)
    if (!label) return <span className="truncate text-sm italic text-muted-foreground">Unavailable label</span>
    return <LabelChip label={label} />
  }
  // Custom sections own their name, so the row doubles as a rename field.
  if (section.spec.kind === "custom") {
    return (
      <CustomSectionNameInput
        sectionId={section.spec.sectionId}
        name={section.spec.name}
        onRename={onRenameCustomSection}
      />
    )
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
  if (section.spec.kind === "custom") return section.spec.name
  return sectionPresentation(section.spec).label
}

/** Inline rename field for a custom section row. Commits on blur / Enter (not per
 *  keystroke) so renaming doesn't fire a write — and a persisted change reflects
 *  back. Top-level per INV-18. */
function CustomSectionNameInput({
  sectionId,
  name,
  onRename,
}: {
  sectionId: string
  name: string
  onRename: (sectionId: string, name: string) => void
}) {
  const [value, setValue] = useState(name)
  // Reflect a name changed elsewhere (another device) when not mid-edit.
  useEffect(() => setValue(name), [name])

  const commit = () => {
    const trimmed = value.trim()
    if (!trimmed || trimmed === name) {
      setValue(name)
      return
    }
    onRename(sectionId, trimmed)
  }

  return (
    <span className="flex items-center gap-1.5">
      <FolderInput className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
        maxLength={MAX_CUSTOM_SECTION_NAME_LENGTH}
        aria-label="Section name"
        className="min-w-0 flex-1 rounded bg-transparent px-0.5 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
      />
    </span>
  )
}

/** Inline form to create a new, empty custom section by name. Top-level per INV-18. */
function CustomSectionCreator({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState("")

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onCreate(trimmed)
    setName("")
  }

  return (
    <div className="space-y-1.5 pt-3">
      <p className="text-xs text-muted-foreground">Create a custom section:</p>
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              submit()
            }
          }}
          maxLength={MAX_CUSTOM_SECTION_NAME_LENGTH}
          placeholder="Section name…"
          aria-label="New custom section name"
          className="min-w-0 flex-1 rounded-md border bg-card px-2.5 py-1.5 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
        />
        <Button type="button" size="sm" variant="outline" onClick={submit} disabled={!name.trim()} className="shrink-0">
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add section
        </Button>
      </div>
    </div>
  )
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
    return <p className="pt-3 text-xs text-muted-foreground">Everything's in your sidebar.</p>
  }

  return (
    <div className="space-y-1.5 pt-3">
      {/* Interaction-neutral label: the chips support both drag-to-position and
          click-to-append, on either platform. */}
      <p className="text-xs text-muted-foreground">Available to add:</p>
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
  const name = sectionDisplayName({ id: sectionIdForSpec(spec), spec }, labelsById)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${ADD_PREFIX}${sectionIdForSpec(spec)}`,
    data: { label: name },
  })
  const label = spec.kind === "label" ? labelsById.get(spec.labelId) : undefined

  return (
    <li>
      <button
        ref={setNodeRef}
        type="button"
        onClick={onAdd}
        aria-label={`Add ${name}`}
        data-vaul-no-drag
        className={cn(
          // cursor-pointer (not grab): clicking to add is the primary action; the
          // grab cursor only appears once a drag is actually under way.
          // active: states give a visible tap flash on touch (where :hover can't),
          // since touch-none — needed for DnD — suppresses the native pressed style.
          "flex cursor-pointer touch-none items-center gap-1 rounded-full border border-dashed bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-solid hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing active:bg-muted active:text-foreground",
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

function EditorDragOverlay() {
  const { active } = useDndContext()
  return createPortal(
    <DragOverlay dropAnimation={null} transition="none" style={{ pointerEvents: "none", zIndex: 100 }}>
      {active && (
        <div
          data-testid="sidebar-drag-preview"
          aria-hidden
          className="flex w-fit max-w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-sm font-medium shadow-md"
        >
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{active.data.current?.label}</span>
        </div>
      )}
    </DragOverlay>,
    document.body
  )
}
