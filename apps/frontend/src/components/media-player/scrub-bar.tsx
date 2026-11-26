import { useEffect } from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"
import { Loader2 } from "lucide-react"
import { formatClock } from "@/lib/dates"
import { clamp } from "@/lib/math-utils"
import { cn } from "@/lib/utils"
import { previewSize, useFramePreview } from "./use-frame-preview"
import type { BufferedRange } from "./use-media-playback"
import { useScrub, type ScrubOptions } from "./use-scrub"

const TIME_BUBBLE_WIDTH = 64

interface ScrubBarProps extends ScrubOptions {
  src: string
  aspect: number
  buffered: BufferedRange[]
  touch: boolean
}

function percent(value: number, duration: number): string {
  return `${duration > 0 ? clamp((value / duration) * 100, 0, 100) : 0}%`
}

export function ScrubBar({ src, aspect, buffered, touch, ...options }: ScrubBarProps) {
  const { duration, scrubbing } = options
  const scrub = useScrub(options)
  const preview = useFramePreview(src, aspect)
  const thumbSize = previewSize(aspect)
  const { hoverTime } = scrub

  // Held back during a drag; on release the bubble previews where the pointer rests.
  useEffect(() => {
    if (hoverTime !== null && !scrubbing) preview.request(hoverTime)
  }, [hoverTime, scrubbing, preview.request])

  const showPreview = hoverTime !== null && !scrubbing
  const bubbleWidth = showPreview ? thumbSize.width : TIME_BUBBLE_WIDTH
  const framePending = showPreview && preview.drawnTime !== hoverTime

  return (
    <div className="relative" {...scrub.wrapProps}>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute bottom-full left-0 mb-1.5 flex flex-col items-center gap-1 transition-opacity duration-150",
          scrub.bubbleVisible ? "opacity-100" : "opacity-0"
        )}
        style={{ width: bubbleWidth, transform: `translateX(${scrub.bubbleOffset(bubbleWidth)}px)` }}
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
          {formatClock(scrub.bubbleTime ?? 0, duration)}
        </span>
      </div>

      <SliderPrimitive.Root
        {...scrub.rootProps}
        className={cn(
          "group/scrub relative flex w-full cursor-pointer touch-none select-none items-center",
          touch ? "h-8" : "h-6"
        )}
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
          {...scrub.thumbProps}
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
