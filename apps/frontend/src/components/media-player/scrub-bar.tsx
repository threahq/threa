import { useRef, useState } from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"
import { Loader2 } from "lucide-react"
import { formatClock } from "@/lib/dates"
import { clamp } from "@/lib/math-utils"
import { cn } from "@/lib/utils"
import { previewSize, useFramePreview } from "./use-frame-preview"
import type { BufferedRange } from "./use-media-playback"

export const SCRUB_SELECTOR = "[data-media-scrub]"

const TIME_BUBBLE_WIDTH = 64
const STEP_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"])

interface ScrubBarProps {
  src: string
  aspect: number
  time: number
  duration: number
  buffered: BufferedRange[]
  scrubbing: boolean
  touch: boolean
  onScrubStart(): void
  onScrub(time: number): void
  onScrubEnd(): void
  onSeek(time: number): void
}

function percent(value: number, duration: number): string {
  return `${duration > 0 ? clamp((value / duration) * 100, 0, 100) : 0}%`
}

export function ScrubBar({
  src,
  aspect,
  time,
  duration,
  buffered,
  scrubbing,
  touch,
  onScrubStart,
  onScrub,
  onScrubEnd,
  onSeek,
}: ScrubBarProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const pointerActiveRef = useRef(false)
  const [barWidth, setBarWidth] = useState(0)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const preview = useFramePreview(src, aspect)
  const thumbSize = previewSize(aspect)

  const measure = () => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (rect) setBarWidth(rect.width)
    return rect
  }

  const handleHover = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || duration <= 0) return
    const rect = measure()
    if (!rect || rect.width <= 0) return
    const fraction = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    const t = fraction * duration
    setHoverTime(t)
    if (!scrubbing) preview.request(t)
  }

  const endPointer = () => {
    if (!pointerActiveRef.current) return
    pointerActiveRef.current = false
    onScrubEnd()
    // Hover requests were held back during the drag; the bubble now previews where the pointer rests.
    if (hoverTime !== null) preview.request(hoverTime)
  }

  const showPreview = hoverTime !== null && !scrubbing
  const bubbleTime = scrubbing ? time : hoverTime
  const bubbleWidth = showPreview ? thumbSize.width : TIME_BUBBLE_WIDTH
  const bubbleCenter = bubbleTime !== null && duration > 0 ? (bubbleTime / duration) * barWidth : 0
  const bubbleX = clamp(bubbleCenter - bubbleWidth / 2, 0, Math.max(0, barWidth - bubbleWidth))
  const bubbleVisible = bubbleTime !== null && barWidth > 0
  const framePending = showPreview && preview.drawnTime !== hoverTime

  return (
    <div
      ref={wrapRef}
      className="relative"
      onPointerMove={handleHover}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setHoverTime(null)
      }}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute bottom-full left-0 mb-1.5 flex flex-col items-center gap-1 transition-opacity duration-150",
          bubbleVisible ? "opacity-100" : "opacity-0"
        )}
        style={{ width: bubbleWidth, transform: `translateX(${bubbleX}px)` }}
      >
        {!touch && (
          <div
            className={cn(
              "relative overflow-hidden rounded-md bg-white/10 shadow-lg ring-1 ring-white/15",
              !showPreview && "hidden"
            )}
            style={{ width: thumbSize.width, height: thumbSize.height }}
          >
            <canvas
              ref={preview.canvasRef}
              className={cn(
                "h-full w-full transition-opacity duration-150",
                preview.drawnTime === null && "invisible",
                framePending && "opacity-50"
              )}
            />
            {framePending && (
              <Loader2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/80" />
            )}
          </div>
        )}
        <span className="rounded bg-black/70 px-1.5 py-0.5 text-xs tabular-nums text-white">
          {formatClock(bubbleTime ?? 0, duration)}
        </span>
      </div>

      <SliderPrimitive.Root
        data-media-scrub=""
        data-scrubbing={scrubbing || undefined}
        value={[Math.min(time, duration || 0)]}
        min={0}
        max={duration > 0 ? duration : 1}
        step={0.001}
        disabled={duration <= 0}
        className={cn(
          "group/scrub relative flex w-full cursor-pointer touch-none select-none items-center",
          touch ? "h-8" : "h-6"
        )}
        onPointerDown={() => {
          pointerActiveRef.current = true
          measure()
        }}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
        onKeyDown={(e) => {
          if (STEP_KEYS.has(e.key)) e.preventDefault()
        }}
        onValueChange={([value]) => {
          if (!pointerActiveRef.current) {
            onSeek(value)
            return
          }
          if (!scrubbing) onScrubStart()
          onScrub(value)
        }}
      >
        <SliderPrimitive.Track
          className={cn(
            "relative h-1 w-full overflow-hidden rounded-full bg-white/25 transition-transform duration-150",
            "group-hover/scrub:scale-y-150 group-data-[scrubbing]/scrub:scale-y-150"
          )}
        >
          {buffered.map((range) => (
            <div
              key={range.start}
              className="absolute inset-y-0 bg-white/35"
              style={{ left: percent(range.start, duration), width: percent(range.end - range.start, duration) }}
            />
          ))}
          <SliderPrimitive.Range className="absolute h-full bg-white" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label="Seek"
          aria-valuetext={`${formatClock(time, duration)} of ${formatClock(duration)}`}
          className={cn(
            "block h-3.5 w-3.5 rounded-full bg-white shadow-md transition-transform duration-150",
            "focus-visible:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
            touch || scrubbing ? "scale-100" : "scale-0 group-hover/scrub:scale-100"
          )}
        />
      </SliderPrimitive.Root>
    </div>
  )
}
