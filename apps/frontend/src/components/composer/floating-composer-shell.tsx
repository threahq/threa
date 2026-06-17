import { type ReactNode, type Ref } from "react"

/**
 * Wrapper for the floating composer pill. Provides the shared shell —
 * absolute-positioned container with `pointer-events-none`, plus the inner
 * `pointer-events-auto` centered pill with the canonical padding. Used from
 * both the main stream `MessageInput` and the draft branch of `StreamPanel`
 * so visual tweaks (shadow, radius, padding, safe-area) stay in one place.
 *
 * When `hidden` is true the wrapper collapses to `display: none` — callers use
 * this while the expand-to-fullscreen overlay is mounted.
 */
interface FloatingComposerShellProps {
  hidden?: boolean
  children: ReactNode
  ref?: Ref<HTMLDivElement>
  "data-message-composer-root"?: boolean
}

export function FloatingComposerShell({ hidden = false, children, ref, ...rest }: FloatingComposerShellProps) {
  return (
    // will-change: the keyboard-close restore lays the composer out below the
    // still-visible keyboard, outside the window, where browsers don't
    // rasterize — without its own (small) compositor layer it painted in
    // late as the keyboard slid away. Scoped here on purpose; the same hint
    // on the whole app shell forced full-app re-rasters and was far worse.
    <div
      ref={ref}
      {...rest}
      className={hidden ? "hidden" : "pointer-events-none absolute inset-x-0 bottom-0 z-20 will-change-transform"}
    >
      <div className="pointer-events-auto pt-3 px-3 pb-3 sm:pt-6 sm:px-6 sm:pb-4 mx-auto max-w-[800px] w-full min-w-0">
        {children}
      </div>
    </div>
  )
}
