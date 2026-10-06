import { type Page } from "@playwright/test"

/**
 * Counts React component renders by posing as the DevTools global hook, which
 * React (dev and prod builds alike) calls on every commit. A render is a
 * function/class/forwardRef/memo fiber flagged PerformedWork in that commit;
 * subtrees whose child pointer did not change were bailed out and are skipped.
 */

export interface RenderSample {
  renders: number
  byComponent: Record<string, number>
}

interface CounterState {
  counting: boolean
  lastCommitAt: number
  renders: number
  byComponent: Record<string, number>
}

type CounterWindow = Window & { __renderCounter?: CounterState }

// The window closes once no commit has landed for QUIET_MS. It has to outlast
// the app's debounced follow-ups (the read-state commit waits 500ms), or they
// are cut from this action and counted toward the next one.
const QUIET_MS = 1_000
const QUIET_CAP_MS = 20_000

function installHook(): void {
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])
  const PERFORMED_WORK = 1
  const state: CounterState = { counting: false, lastCommitAt: performance.now(), renders: 0, byComponent: {} }
  ;(window as CounterWindow).__renderCounter = state

  const nameOf = (fiber: any): string => {
    const t = fiber.type
    if (!t) return "anonymous"
    if (typeof t === "function") return t.displayName || t.name || "anonymous"
    return (
      t.displayName ||
      t.render?.displayName ||
      t.render?.name ||
      t.type?.displayName ||
      t.type?.name ||
      t.type?.render?.name ||
      "anonymous"
    )
  }

  const walk = (next: any, prev: any): void => {
    if (COMPONENT_TAGS.has(next.tag) && (next.flags & PERFORMED_WORK) === PERFORMED_WORK) {
      state.renders++
      const name = nameOf(next)
      state.byComponent[name] = (state.byComponent[name] ?? 0) + 1
    }
    if (prev && next.child === prev.child) return
    for (let child = next.child; child; child = child.sibling) walk(child, child.alternate)
  }

  const renderers = new Map<number, unknown>()
  ;(window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers,
    inject(renderer: unknown) {
      renderers.set(renderers.size + 1, renderer)
      return renderers.size
    },
    checkDCE() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    setStrictMode() {},
    onCommitFiberRoot(_id: number, root: any) {
      state.lastCommitAt = performance.now()
      if (state.counting) walk(root.current, root.current.alternate)
    },
  }
}

/** Must run before the first navigation: React looks for the hook once, at load. */
export async function installRenderCounter(page: Page): Promise<void> {
  await page.addInitScript(installHook)
}

async function waitForQuiet(page: Page, label: string): Promise<void> {
  await page
    .waitForFunction(
      (quietMs) => performance.now() - (window as CounterWindow).__renderCounter!.lastCommitAt >= quietMs,
      QUIET_MS,
      { timeout: QUIET_CAP_MS, polling: 50 }
    )
    .catch(() => {
      throw new Error(`${label}: React kept committing for ${QUIET_CAP_MS}ms without a ${QUIET_MS}ms pause`)
    })
}

/**
 * Renders committed from the start of `action` until React has been quiet for
 * QUIET_MS. `action` must await its own visible effect, so the window can never
 * close before the action happened.
 */
export async function measureRenders(page: Page, label: string, action: () => Promise<void>): Promise<RenderSample> {
  await waitForQuiet(page, `${label} (before)`)
  await page.evaluate(() => {
    const state = (window as CounterWindow).__renderCounter!
    state.renders = 0
    state.byComponent = {}
    state.counting = true
  })
  await action()
  await waitForQuiet(page, label)
  const sample = await page.evaluate(() => {
    const state = (window as CounterWindow).__renderCounter!
    state.counting = false
    return { renders: state.renders, byComponent: state.byComponent }
  })
  // Every gated action renders something, so zero means the counter is broken
  // (React no longer reports commits to the stand-in hook, or its fiber flags
  // changed). Reported as an improvement, it would talk a reader into setting
  // the baseline to 0, which disables the gate.
  if (sample.renders === 0) {
    throw new Error(
      `${label}: the render counter saw no component renders. React did not report commits to the stand-in DevTools hook, or the fiber tags/flags render-counter.ts reads have changed.`
    )
  }
  return sample
}
