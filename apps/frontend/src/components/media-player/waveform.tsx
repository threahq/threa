import { memo, useLayoutEffect, useMemo, useRef, useState } from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"
import { formatClock } from "@/lib/dates"
import { clamp } from "@/lib/math-utils"
import { cn } from "@/lib/utils"
import { useScrub, type ScrubOptions } from "./use-scrub"

const BAR_PITCH_PX = 5
const MIN_BARS = 16
/** Used until the track has a measured width (and in jsdom, which never has one). */
const UNMEASURED_BARS = 64
const MIN_BAR_HEIGHT = 0.08
const TIME_BUBBLE_WIDTH = 64

export function decodeWaveform(base64: string | undefined): Uint8Array | null {
  if (!base64) return null
  try {
    const binary = atob(base64)
    const peaks = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) peaks[i] = binary.charCodeAt(i)
    return peaks.length > 0 ? peaks : null
  } catch {
    return null
  }
}

/** Merges the peaks into `count` bars (loudest peak per bar), as height fractions. */
export function waveformBars(peaks: Uint8Array, count: number): number[] {
  const bars = Math.max(1, Math.min(count, peaks.length))
  return Array.from({ length: bars }, (_, i) => {
    const start = Math.floor((i * peaks.length) / bars)
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / bars))
    let peak = 0
    for (let j = start; j < end; j++) peak = Math.max(peak, peaks[j])
    return Math.max(MIN_BAR_HEIGHT, peak / 255)
  })
}

function useBarCount(peaks: Uint8Array | null) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !peaks) return
    const measure = () => setWidth(el.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [peaks])
  const count = width > 0 ? Math.max(MIN_BARS, Math.floor(width / BAR_PITCH_PX)) : UNMEASURED_BARS
  return { ref, count }
}

const WaveformBars = memo(function WaveformBars({ bars, className }: { bars: number[]; className: string }) {
  return (
    <div aria-hidden className="absolute inset-0 flex items-center gap-[2px]">
      {bars.map((height, i) => (
        <span
          key={i}
          data-waveform-bar=""
          className={cn("min-w-px flex-1 rounded-full", className)}
          style={{ height: `${height * 100}%` }}
        />
      ))}
    </div>
  )
})

interface WaveformScrubProps extends ScrubOptions {
  /** Base64 peaks; without them the track is a plain line of the same height. */
  waveform: string | undefined
}

export function WaveformScrub({ waveform, ...options }: WaveformScrubProps) {
  const { time, duration } = options
  const scrub = useScrub(options)
  const peaks = useMemo(() => decodeWaveform(waveform), [waveform])
  const { ref: barsRef, count } = useBarCount(peaks)
  const bars = useMemo(() => (peaks ? waveformBars(peaks, count) : null), [peaks, count])
  const played = duration > 0 ? clamp(time / duration, 0, 1) * 100 : 0

  return (
    <div className="relative w-full" {...scrub.wrapProps}>
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute bottom-full left-0 z-10 mb-1 rounded border bg-popover px-1.5 py-0.5 text-center text-xs tabular-nums text-popover-foreground shadow-sm transition-opacity duration-150",
          scrub.bubbleVisible ? "opacity-100" : "opacity-0"
        )}
        style={{ width: TIME_BUBBLE_WIDTH, transform: `translateX(${scrub.bubbleOffset(TIME_BUBBLE_WIDTH)}px)` }}
      >
        {formatClock(scrub.bubbleTime ?? 0, duration)}
      </span>
      <SliderPrimitive.Root
        {...scrub.rootProps}
        data-waveform={bars ? "bars" : "plain"}
        className="group/scrub relative flex h-10 w-full cursor-pointer touch-none select-none items-center data-[disabled]:cursor-default"
      >
        {bars ? (
          <SliderPrimitive.Track ref={barsRef} className="relative h-7 w-full">
            <WaveformBars bars={bars} className="bg-muted-foreground/35" />
            <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - played}% 0 0)` }}>
              <WaveformBars bars={bars} className="bg-primary" />
            </div>
          </SliderPrimitive.Track>
        ) : (
          <SliderPrimitive.Track className="relative h-1 w-full overflow-hidden rounded-full bg-muted-foreground/25">
            <SliderPrimitive.Range className="absolute h-full bg-primary" />
          </SliderPrimitive.Track>
        )}
        <SliderPrimitive.Thumb
          {...scrub.thumbProps}
          className={cn(
            "block rounded-full bg-primary focus-visible:outline-none",
            // The played bars already mark the position, so their playhead shows only while it is being moved.
            bars
              ? "h-9 w-0.5 opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-data-[scrubbing]/scrub:opacity-100"
              : "h-3.5 w-3.5 shadow-sm ring-2 ring-background transition-transform duration-150 focus-visible:ring-ring group-data-[disabled]/scrub:scale-0"
          )}
        />
      </SliderPrimitive.Root>
    </div>
  )
}
