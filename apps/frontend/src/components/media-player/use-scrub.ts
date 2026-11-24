import { useRef, useState } from "react"
import { formatClock } from "@/lib/dates"
import { clamp } from "@/lib/math-utils"

export const SCRUB_SELECTOR = "[data-media-scrub]"

const STEP_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"])

export interface ScrubOptions {
  time: number
  duration: number
  scrubbing: boolean
  /** Holds the slider inert while there is nothing to seek yet, even when a duration is known. */
  disabled?: boolean
  onScrubStart(): void
  onScrub(time: number): void
  onScrubEnd(): void
  onSeek(time: number): void
}

/**
 * The seek slider's interaction protocol, shared by every media scrub bar: a
 * pointer drag is a scrub (start, moves, end), a keyboard or click change is a
 * single seek, and a mouse hovering the bar reports the time under it. Callers
 * spread the returned props onto a wrapper, a Radix `Slider.Root` and its
 * `Slider.Thumb`, and draw their own track and bubble.
 */
export function useScrub({
  time,
  duration,
  scrubbing,
  disabled = false,
  onScrubStart,
  onScrub,
  onScrubEnd,
  onSeek,
}: ScrubOptions) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const pointerActiveRef = useRef(false)
  const [barWidth, setBarWidth] = useState(0)
  const [hoverTime, setHoverTime] = useState<number | null>(null)

  const measure = () => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (rect) setBarWidth(rect.width)
    return rect
  }

  const endPointer = () => {
    if (!pointerActiveRef.current) return
    pointerActiveRef.current = false
    onScrubEnd()
  }

  const bubbleTime = scrubbing ? time : hoverTime

  return {
    hoverTime,
    bubbleTime,
    bubbleVisible: bubbleTime !== null && barWidth > 0,
    /** Left offset that centers a bubble of `width` on the bubble time, kept inside the bar. */
    bubbleOffset(width: number): number {
      const center = bubbleTime !== null && duration > 0 ? (bubbleTime / duration) * barWidth : 0
      return clamp(center - width / 2, 0, Math.max(0, barWidth - width))
    },
    wrapProps: {
      ref: wrapRef,
      onPointerMove: (e: React.PointerEvent) => {
        if (e.pointerType !== "mouse" || disabled || duration <= 0) return
        const rect = measure()
        if (!rect || rect.width <= 0) return
        setHoverTime(clamp((e.clientX - rect.left) / rect.width, 0, 1) * duration)
      },
      onPointerLeave: (e: React.PointerEvent) => {
        if (e.pointerType === "mouse") setHoverTime(null)
      },
    },
    rootProps: {
      "data-media-scrub": "",
      "data-scrubbing": scrubbing || undefined,
      value: [Math.min(time, duration || 0)],
      min: 0,
      max: duration > 0 ? duration : 1,
      step: 0.001,
      disabled: disabled || duration <= 0,
      onPointerDown: () => {
        pointerActiveRef.current = true
        measure()
      },
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onLostPointerCapture: endPointer,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (STEP_KEYS.has(e.key)) e.preventDefault()
      },
      onValueChange: ([value]: number[]) => {
        if (!pointerActiveRef.current) {
          onSeek(value)
          return
        }
        if (!scrubbing) onScrubStart()
        onScrub(value)
      },
    },
    thumbProps: {
      "aria-label": "Seek",
      "aria-valuetext": `${formatClock(time, duration)} of ${formatClock(duration)}`,
    },
  }
}
