import { useRef, type ComponentProps, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { useInPaneDrawer, usePanel, useSidebar } from "@/contexts"
import { useElementWidth } from "@/hooks/use-element-width"
import { pageTitleOf } from "@/lib/page-panes"
import { foldHeaderControls, PANE_TITLE_MIN_WIDTH } from "@/lib/pane-header-fold"
import { TAB_ACTIONS_WIDTH, tabRowReserve } from "@/lib/panel-tab-fit"
import { cn } from "@/lib/utils"
import { PaneHeader } from "./pane-header"

type MeasureRefs = NonNullable<ComponentProps<typeof PaneHeader>["measureRefs"]>

const HEADER_PADDING = 32
const HEADER_GAP = 8
const BACK_WIDTH = 32
/** A page with an icon for a title keeps just that. */
const PAGE_ICON_WIDTH = 20
/** The room a page's search field takes beside its icon before it gets a row of its own, its count included. */
const PAGE_SEARCH_FIELD_WIDTH = 272

/** Whether this pane keeps the page's own way back: the first column's does, and on a phone the route's. */
function useKeepsBack(): boolean {
  const { inFirstColumn, onRoute } = usePanel()
  const { isMobile } = useSidebar()
  return isMobile ? onRoute : inFirstColumn
}

/**
 * Whether controls `controlsWidth` wide fit in the page's header, beside
 * `titleWidth` of its icon and title or the tab row standing in for them. A
 * page gives controls that don't fit a row of their own under the header, and
 * hands `measureRefs` to its {@link PagePaneHeader}. `tabbed` is whether the
 * header shows the tab row.
 */
export function usePageHeaderFit(
  controlsWidth: number,
  titleWidth = PANE_TITLE_MIN_WIDTH
): { fits: boolean; tabbed: boolean; measureRefs: MeasureRefs } {
  const { tabbed: inTabbedSection, section, splits } = usePanel()
  const inDrawer = useInPaneDrawer()
  const tabbed = inTabbedSection && !inDrawer
  const keepsBack = useKeepsBack()
  const headerRef = useRef<HTMLElement>(null)
  const headerWidth = useElementWidth(headerRef)
  const leadingRef = useRef<HTMLDivElement>(null)
  const leadingWidth = useElementWidth(leadingRef)
  const trailingRef = useRef<HTMLDivElement>(null)
  const trailingWidth = useElementWidth(trailingRef)

  // The tab row's -ml-2 hands back the gap before it.
  const identityWidth = tabbed
    ? tabRowReserve(section?.ids.length ?? 0) + (splits.length > 0 ? TAB_ACTIONS_WIDTH : 0) - HEADER_GAP
    : titleWidth + (keepsBack ? BACK_WIDTH + HEADER_GAP : 0)
  const folded = foldHeaderControls(
    headerWidth,
    HEADER_PADDING +
      (leadingWidth > 0 ? leadingWidth + HEADER_GAP : 0) +
      (trailingWidth > 0 ? trailingWidth + HEADER_GAP : 0),
    [{ id: "controls", width: controlsWidth + HEADER_GAP }],
    identityWidth
  )
  return {
    fits: !folded.has("controls"),
    tabbed,
    measureRefs: { header: headerRef, leading: leadingRef, trailing: trailingRef },
  }
}

interface PagePaneHeaderProps {
  workspaceId: string
  /** The page's own way back, kept by the pane in the first column (on a phone, the route's). */
  back?: { to: string; label: string }
  icon?: ReactNode
  title?: ReactNode
  measureRefs?: MeasureRefs
  className?: string
  /** What follows the title: the page's actions, or its search field. */
  children?: ReactNode
}

/** A workspace page's way back, icon and title, in its pane's header. */
export function PagePaneHeader({
  workspaceId,
  back,
  icon,
  title,
  measureRefs,
  className,
  children,
}: PagePaneHeaderProps) {
  const { panelId } = usePanel()
  const keepsBack = useKeepsBack()
  const backLink = keepsBack && back && (
    <Link
      to={back.to}
      className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8 shrink-0")}
      aria-label={back.label}
    >
      <ArrowLeft className="h-4 w-4" />
    </Link>
  )

  // Back is part of the page's identity: the tab row standing in for the title stands in for it too.
  return (
    <PaneHeader
      workspaceId={workspaceId}
      name={(panelId && pageTitleOf(panelId)) ?? ""}
      title={
        title !== undefined || icon !== undefined ? (
          <>
            {backLink}
            {icon}
            {title !== undefined && <h1 className="truncate font-semibold">{title}</h1>}
          </>
        ) : undefined
      }
      fixedTitle={title === undefined}
      measureRefs={measureRefs}
      className={className}
    >
      {children}
    </PaneHeader>
  )
}

interface PageSearchHeaderProps {
  workspaceId: string
  icon: ReactNode
  /** The search box and the count after it. */
  field: ReactNode
  /** The room `children` take, their gap included. */
  actionsWidth?: number
  /** The page's actions after the field. */
  children?: ReactNode
}

/**
 * The header of a page that is a search: its icon, then the field. A tab row
 * leaves a growing field no fair share of the header, so beside one, or in a
 * pane too narrow for it, the field takes a row of its own under the header.
 * It moves there by placement alone, so what is typed in it and its caret stay.
 * A phone's header keeps the field.
 */
export function PageSearchHeader({ workspaceId, icon, field, actionsWidth = 0, children }: PageSearchHeaderProps) {
  const { isMobile } = useSidebar()
  const { fits, tabbed, measureRefs } = usePageHeaderFit(PAGE_SEARCH_FIELD_WIDTH + actionsWidth, PAGE_ICON_WIDTH)
  const stacked = !isMobile && (tabbed || !fits)

  return (
    <PagePaneHeader
      workspaceId={workspaceId}
      back={{ to: `/w/${workspaceId}`, label: "Back to workspace" }}
      icon={icon}
      measureRefs={measureRefs}
      className={cn("border-b-0", stacked && "mb-10")}
    >
      <div className={cn("flex items-center gap-2", stacked ? "absolute inset-x-4 top-12 h-8" : "min-w-0 flex-[3]")}>
        {field}
      </div>
      {children}
    </PagePaneHeader>
  )
}
