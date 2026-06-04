import { isImageAttachment } from "../image-caption"

/**
 * Longest-edge pixel cap for the inline stream-view thumbnail. The inline
 * render is ~128px tall; 640px keeps it crisp on 2–3x displays while staying
 * a tiny fraction of the original's bytes.
 */
export const IMAGE_THUMBNAIL_MAX_DIMENSION = 640

/**
 * WebP quality for thumbnails — the smallest setting that still looks clean
 * for screenshots/photos at thumbnail scale.
 */
export const IMAGE_THUMBNAIL_WEBP_QUALITY = 72

/**
 * Animated GIF thumbnails stay animated (encoded as animated WebP), but we cap
 * the frame rate so a 30–50fps source does not ship dozens of near-identical
 * frames at thumbnail scale. Sources already at or below this rate keep their
 * original pacing untouched.
 */
export const IMAGE_THUMBNAIL_GIF_MAX_FPS = 15

/**
 * GIF frames with a missing or sub-{@link GIF_MIN_SANE_FRAME_DELAY_MS} delay are
 * rendered by browsers at a default ~100ms; normalise to that so our pacing math
 * matches what the user actually sees.
 */
const GIF_DEFAULT_FRAME_DELAY_MS = 100
const GIF_MIN_SANE_FRAME_DELAY_MS = 20

export interface GifFramePlan {
  /** Source frame indices to keep, in order. */
  keep: number[]
  /** Display duration (ms) for each kept frame; sums to the source duration. */
  delays: number[]
  /** True when any source frames were collapsed away (i.e. the rate was capped). */
  dropped: boolean
}

/**
 * Picks which GIF frames to keep so the thumbnail plays at most
 * {@link IMAGE_THUMBNAIL_GIF_MAX_FPS}. Consecutive frames are collapsed into the
 * first frame of each run and their delays folded together, so the total
 * animation duration is preserved exactly. A source already under the cap keeps
 * every frame (`dropped: false`).
 */
export function planGifThumbnailFrames(rawDelays: readonly number[], pages: number): GifFramePlan {
  const minInterval = Math.round(1000 / IMAGE_THUMBNAIL_GIF_MAX_FPS)

  const delays: number[] = []
  for (let i = 0; i < pages; i++) {
    const d = rawDelays[i]
    delays.push(d && d >= GIF_MIN_SANE_FRAME_DELAY_MS ? d : GIF_DEFAULT_FRAME_DELAY_MS)
  }

  const keep: number[] = []
  const outDelays: number[] = []
  let acc = 0
  let runStart = 0
  let dropped = false
  for (let i = 0; i < pages; i++) {
    acc += delays[i]
    if (acc >= minInterval) {
      keep.push(runStart)
      outDelays.push(acc)
      if (i > runStart) dropped = true
      acc = 0
      runStart = i + 1
    }
  }
  // Trailing frames too short to reach the interval: fold them into the last
  // kept frame's delay so no animation time is lost.
  if (runStart < pages) {
    if (keep.length > 0) {
      outDelays[outDelays.length - 1] += acc
      dropped = true
    } else {
      keep.push(runStart)
      outDelays.push(acc)
    }
  }

  return { keep, delays: outDelays, dropped }
}

/**
 * SVGs are already small vector files; rasterizing them to a fixed-size WebP
 * makes them larger and blurry, so we serve the original instead. Everything
 * else that `isImageAttachment` recognises (including image-typed
 * `application/octet-stream` uploads) is resizable by sharp.
 */
export function shouldGenerateThumbnail(mimeType: string, filename: string): boolean {
  if (mimeType === "image/svg+xml") return false
  return isImageAttachment(mimeType, filename)
}
