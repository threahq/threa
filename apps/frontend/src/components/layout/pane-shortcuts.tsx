import { useLayoutEffect, useReducer, type MutableRefObject } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { usePanel, useCurrentPane, usePaneFocusLanding, usePaneShortcutQueue } from "@/contexts"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { findVisibleZoneEditor, focusAtEnd } from "@/hooks/use-type-to-focus"
import { activatePanelTab, closePanelTab, followCurrentPanel } from "@/lib/panel-tabs"
import { isPagePane } from "@/lib/stream-ids"
import { closeAside } from "@/stores/aside-store"

type PaneAction =
  | "closePane"
  | "reopenPane"
  | "nextPaneTab"
  | "previousPaneTab"
  | "nextPane"
  | "previousPane"
  | "togglePaneFocus"

/** How long a pane may take to come out from under the one it was behind. */
const UNCOVER_WAIT_MS = 2000
/** How long an uncovered pane may take to mount its composer before its tab takes focus. */
const EDITOR_WAIT_FRAMES = 10
/** How long a press waits for the page to catch up with the URL before it is dropped. */
const CATCH_UP_WAIT_MS = 2000

const NO_PANES: readonly string[] = []

/**
 * The pane shortcuts, acting on the tab this is scoped to: the pane worked in.
 * `panes` is every pane on screen in order, or empty where panes don't sit side
 * by side.
 */
export function PaneShortcuts({ panes = NO_PANES }: { panes?: readonly string[] }) {
  const {
    panelId,
    layout,
    section,
    getTabUrl,
    closePanel,
    canClosePanel,
    reopenTab,
    canReopenTab,
    setCurrentPane,
    focusTab,
  } = usePanel()
  const current = useCurrentPane()
  const navigate = useNavigate()
  const location = useLocation()
  const landing = usePaneFocusLanding()

  const showTab = (step: number) => {
    const ids = section?.ids ?? []
    if (!section?.active || ids.length < 2) return false
    const next = ids[(ids.indexOf(section.active) + step + ids.length) % ids.length]
    navigate(getTabUrl(next), { replace: true })
    setCurrentPane(next)
    landFocus(landing, next)
    // A section folded on screen can switch to a tab its own section already shows, which leaves the URL as it was.
    return activatePanelTab(layout, next) !== layout
  }

  const showPane = (step: number) => {
    const at = current === null ? -1 : panes.indexOf(current)
    const from = at === -1 && panelId !== null ? panes.indexOf(panelId) : at
    const next = panes[(from + step + panes.length) % panes.length]
    setCurrentPane(next)
    landFocus(landing, next)
    return false
  }

  /** Each action says whether it navigated. */
  const actions: Record<PaneAction, () => boolean> = {
    closePane: () => {
      if (!panelId) return false
      landFocus(landing, followCurrentPanel(layout, closePanelTab(layout, panelId), panelId))
      closePanel()
      return true
    },
    reopenPane: () => {
      const reopened = reopenTab()
      if (reopened) landFocus(landing, reopened)
      return reopened !== null
    },
    nextPaneTab: () => showTab(1),
    previousPaneTab: () => showTab(-1),
    nextPane: () => showPane(1),
    previousPane: () => showPane(-1),
    togglePaneFocus: () => {
      focusTab(layout.focused === undefined ? panelId : null)
      return true
    },
  }

  // A shortcut with nothing to act on leaves its key to typing, except a held
  // key: a held ⌘W must not go on to close the window once the tabs run out.
  const tabs = section?.ids.length ?? 0
  const available: Record<PaneAction, boolean> = {
    closePane: canClosePanel,
    reopenPane: canReopenTab(),
    nextPaneTab: tabs > 1,
    previousPaneTab: tabs > 1,
    // Panes under a floating one are out of reach.
    nextPane: layout.focused === undefined && panes.length > 1,
    previousPane: layout.focused === undefined && panes.length > 1,
    // Only a pane beside others can float; whatever floats can always go back.
    togglePaneFocus: panes.length > 1 && (layout.focused !== undefined || (panelId !== null && !isPagePane(panelId))),
  }

  // The router commits a navigation in a transition, so the URL can be a step
  // ahead of what this render saw, and a close that pops history moves the URL
  // only once the pop lands. A press waits for the render that shows both,
  // rather than acting on the layout the URL already left behind, and queued
  // presses act one per render so each sees what the one before it did.
  const queue = usePaneShortcutQueue()
  const [, nextRender] = useReducer((n: number) => n + 1, 0)
  const rendered = panesAt(location.pathname, location.search)
  const waited = () => performance.now() - queue.current.waitingSince > CATCH_UP_WAIT_MS
  const caughtUp = () =>
    (queue.current.navigatedFrom === null || waited()) &&
    panesAt(window.location.pathname, window.location.search) === rendered
  const act = (action: PaneAction) => {
    if (!available[action] || !actions[action]()) return
    queue.current.navigatedFrom = rendered
    queue.current.waitingSince = performance.now()
  }
  useLayoutEffect(() => {
    if (queue.current.navigatedFrom !== rendered) queue.current.navigatedFrom = null
    if (waited()) queue.current.pending = []
    if (queue.current.pending.length === 0 || !caughtUp()) return
    act(queue.current.pending.shift() as PaneAction)
    if (queue.current.pending.length === 0) return
    queue.current.waitingSince = performance.now()
    nextRender()
  })

  const handle = (action: PaneAction) => (event: KeyboardEvent) => {
    // The aside is no pane, so from inside it the rest would act on one the user isn't working in.
    if (event.target instanceof Element && event.target.closest("[data-aside-surface]")) {
      if (action !== "closePane") return event.repeat
      closeAside()
      return true
    }
    // A held key's repeats outrun the router, and must not go on acting after it is let go.
    if (queue.current.pending.length > 0 || !caughtUp()) {
      if (event.repeat) return true
      if (queue.current.pending.length === 0) queue.current.waitingSince = performance.now()
      queue.current.pending.push(action)
    } else if (available[action]) act(action)
    else return event.repeat
    return true
  }
  useKeyboardShortcuts({
    closePane: handle("closePane"),
    reopenPane: handle("reopenPane"),
    nextPaneTab: handle("nextPaneTab"),
    previousPaneTab: handle("previousPaneTab"),
    nextPane: handle("nextPane"),
    previousPane: handle("previousPane"),
    togglePaneFocus: handle("togglePaneFocus"),
  })

  return null
}

/** What a URL says about the panes on show; other params come and go without a navigation. */
function panesAt(pathname: string, search: string): string {
  return `${pathname}?${new URLSearchParams(search).get("panel") ?? ""}`
}

function findPane(paneId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-panel-tab="${CSS.escape(paneId)}"]`)
}

/**
 * Focus the pane's composer once the pane has come out from under the one it
 * was behind, or its tab on show (a page pane: its `data-pane-landing`) when it
 * has no composer. A later landing, or
 * the user moving focus first, calls it off.
 */
function landFocus(landing: MutableRefObject<number>, paneId: string | null) {
  if (paneId === null) return
  const run = ++landing.current
  const from = document.activeElement
  const deadline = performance.now() + UNCOVER_WAIT_MS
  let uncoveredFrames = 0
  const attempt = () => {
    const active = document.activeElement
    if (run !== landing.current || (active !== from && active !== document.body && active !== null)) return
    const pane = findPane(paneId)
    const uncovered = pane !== null && !pane.closest("[inert]")
    const editor = uncovered ? findVisibleZoneEditor(pane) : null
    if (editor) {
      focusAtEnd(editor)
      return
    }
    if (uncovered && ++uncoveredFrames >= EDITOR_WAIT_FRAMES) {
      pane.querySelector<HTMLElement>('[aria-current="page"],[data-pane-landing]')?.focus()
      return
    }
    if (performance.now() < deadline) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}
