import { type ReactNode, type Ref } from "react"

/**
 * Wrapper for the composer pill. Provides the shared shell plus the inner
 * centered pill with the canonical padding. Used from both the main stream
 * `MessageInput` and the draft branch of `StreamPanel` so visual tweaks
 * (shadow, radius, padding, safe-area) stay in one place.
 *
 * Two layout modes:
 *  - floating (default): absolute-positioned over the bottom of the scroll
 *    area with `pointer-events-none` so content scrolls behind it. The scroll
 *    area must reserve matching space (the `--composer-height` machinery).
 *  - docked: a normal in-flow block. The composer is a flex sibling below the
 *    scroll area, so the viewport simply shrinks to fit it — no reserved space,
 *    no re-anchoring, and the last message can never sit behind the composer.
 *
 * When `hidden` is true the wrapper collapses to `display: none` — callers use
 * this while the expand-to-fullscreen overlay is mounted.
 */
interface FloatingComposerShellProps {
  hidden?: boolean
  /** Render in-flow (flex sibling) instead of absolutely positioned. */
  docked?: boolean
  children: ReactNode
  ref?: Ref<HTMLDivElement>
  "data-message-composer-root"?: boolean
}

export function FloatingComposerShell({
  hidden = false,
  docked = false,
  children,
  ref,
  ...rest
}: FloatingComposerShellProps) {
  const outer = docked ? "relative w-full shrink-0 z-20" : "pointer-events-none absolute inset-x-0 bottom-0 z-20"
  const inner = docked
    ? "pt-2 px-3 pb-3 sm:px-6 sm:pb-4 mx-auto max-w-[800px] w-full min-w-0"
    : "pointer-events-auto pt-3 px-3 pb-3 sm:pt-6 sm:px-6 sm:pb-4 mx-auto max-w-[800px] w-full min-w-0"
  return (
    <div ref={ref} {...rest} className={hidden ? "hidden" : outer}>
      <div className={inner}>{children}</div>
    </div>
  )
}
