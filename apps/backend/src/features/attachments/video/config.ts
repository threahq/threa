/**
 * File extensions supported by AWS MediaConvert as input.
 */
export const VIDEO_EXTENSIONS = [
  ".3g2",
  ".3gp",
  ".asf",
  ".avi",
  ".f4v",
  ".flv",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mxf",
  ".webm",
  ".wmv",
] as const

/**
 * Falls back to extension matching when the MIME type isn't video/*, since
 * browser/upload MIME detection is inconsistent across video formats.
 */
export function isVideoAttachment(mimeType: string, filename: string): boolean {
  if (mimeType.startsWith("video/")) {
    return true
  }

  const lowerFilename = filename.toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => lowerFilename.endsWith(ext))
}

/** Maximum age for a transcode job before it's considered stuck and failed (30 minutes) */
export const VIDEO_TRANSCODE_MAX_AGE_MS = 30 * 60 * 1000

/** Delay between MediaConvert status check polls (10 seconds) */
export const VIDEO_TRANSCODE_CHECK_DELAY_MS = 10_000
