import { useCallback, useEffect, useRef, useState } from "react"
import { createSeekCoalescer, type SeekCoalescer } from "./seek-coalescer"

const PREVIEW_MAX_WIDTH = 160
const PREVIEW_MAX_HEIGHT = 120
const DEFAULT_ASPECT = 16 / 9

export function previewSize(aspect: number): { width: number; height: number } {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT
  const width = Math.round(Math.min(PREVIEW_MAX_WIDTH, PREVIEW_MAX_HEIGHT * ratio))
  return { width, height: Math.round(width / ratio) }
}

export interface FramePreview {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  /** Ask for the frame at `time`; the newest request wins. Creates the decoder on first call. */
  request(time: number): void
  /** Time of the frame currently on the canvas, or null before the first draw. */
  drawnTime: number | null
}

interface Decoder {
  video: HTMLVideoElement
  coalescer: SeekCoalescer
}

/**
 * Frames come from a second muted element on the same source, so hovering never
 * disturbs the playing one. It exists only after the first hover.
 */
export function useFramePreview(src: string, aspect: number): FramePreview {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const decoderRef = useRef<Decoder | null>(null)
  const wantedRef = useRef<number | null>(null)
  const [drawnTime, setDrawnTime] = useState<number | null>(null)
  const { width, height } = previewSize(aspect)
  const sizeRef = useRef({ width, height })
  sizeRef.current = { width, height }

  useEffect(
    () => () => {
      const decoder = decoderRef.current
      decoderRef.current = null
      if (!decoder) return
      decoder.video.removeAttribute("src")
      decoder.video.load()
    },
    [src]
  )

  const request = useCallback(
    (time: number) => {
      wantedRef.current = time
      let decoder = decoderRef.current
      if (!decoder) {
        const video = document.createElement("video")
        video.muted = true
        video.preload = "metadata"
        video.playsInline = true
        const coalescer = createSeekCoalescer(video)
        decoder = { video, coalescer }
        decoderRef.current = decoder
        video.addEventListener("seeked", () => {
          const landed = coalescer.inFlight
          const canvas = canvasRef.current
          const ctx = canvas?.getContext("2d")
          if (canvas && ctx && video.videoWidth > 0) {
            const dpr = window.devicePixelRatio || 1
            const { width: w, height: h } = sizeRef.current
            canvas.width = Math.round(w * dpr)
            canvas.height = Math.round(h * dpr)
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            if (landed !== null) setDrawnTime(landed)
          }
          coalescer.seeked()
        })
        // Requests made before metadata arrived only set a start position; re-issue the latest.
        video.addEventListener("loadedmetadata", () => {
          if (wantedRef.current !== null) coalescer.request(wantedRef.current, false)
        })
        video.src = src
      }
      decoder.coalescer.request(time, false)
    },
    [src]
  )

  return { canvasRef, request, drawnTime }
}
