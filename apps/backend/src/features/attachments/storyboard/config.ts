export const STORYBOARD_MAX_TILES = 100
export const STORYBOARD_MIN_INTERVAL_MS = 500
export const STORYBOARD_MAX_COLUMNS = 10
export const STORYBOARD_TILE_MAX_WIDTH = 240
export const STORYBOARD_TILE_MAX_HEIGHT = 180
export const STORYBOARD_TILE_CONCURRENCY = 4
export const STORYBOARD_JPEG_QUALITY = 5
export const STORYBOARD_PROBE_TIMEOUT_MS = 60 * 1000
export const STORYBOARD_TILE_TIMEOUT_MS = 60 * 1000
export const STORYBOARD_SPRITE_TIMEOUT_MS = 60 * 1000
/** Outlives every tile run combined: each one opens the URL again. */
export const STORYBOARD_SOURCE_URL_EXPIRES_SECONDS = 60 * 60
/** Demuxers ffmpeg may use. Playlist formats (hls, concat, dash) are left out: they make ffmpeg fetch URLs named inside the upload. */
export const STORYBOARD_INPUT_FORMATS = "mov,matroska,avi,mpegts,mpeg,flv,asf,ogg"
/** 8K. A decoded frame costs memory in proportion to its pixels, and the upload decides how many it claims. */
export const STORYBOARD_MAX_SOURCE_PIXELS = 7680 * 4320
export const STORYBOARD_FILENAME = "storyboard.jpg"
export const STORYBOARD_MIME_TYPE = "image/jpeg"

export const StoryboardRowStatuses = {
  PENDING: "pending",
  READY: "ready",
  FAILED: "failed",
} as const
export type StoryboardRowStatus = (typeof StoryboardRowStatuses)[keyof typeof StoryboardRowStatuses]

const TILE_PREFIX = "tile_"
const TILE_DIGITS = 3
/** ffmpeg's numbered-input pattern for the files {@link storyboardTileName} names. */
export const STORYBOARD_TILE_PATTERN = `${TILE_PREFIX}%0${TILE_DIGITS}d.jpg`

export function storyboardTileName(index: number): string {
  return `${TILE_PREFIX}${String(index).padStart(TILE_DIGITS, "0")}.jpg`
}

export function storyboardStoragePath(workspaceId: string, attachmentId: string): string {
  return `${workspaceId}/${attachmentId}/${STORYBOARD_FILENAME}`
}
