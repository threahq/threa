// Client performance capture: a closed registry of what the frontend may
// measure, plus the wire schema for one capture session.
//
// The registry is closed on purpose. A sample carries a name from this tuple, a
// timestamp, and at most one number — there is no free-text field anywhere, so a
// capture can never carry a stream id, a message body, a URL, or a user agent.
// Adding a measurement means adding a name here first; nothing else can emit.

import { z } from "zod"

/** Every mark the client may emit. Closed tuple — the union is derived from it (INV-31). */
export const PERF_MARK_NAMES = [
  "bootstrap.fetch",
  "bootstrap.preRead",
  "bootstrap.tx",
  "bootstrap.cleanup",
  "bootstrap.seed",
  "bootstrap.publish",
  "bootstrap.rowsWritten",
  "catchup.entryApply",
  "catchup.replay",
  "catchup.collapse",
  "catchup.serialReplay",
  "stream.subscriptions",
  "stream.eventApply",
  "stream.idbTransaction",
  "liveQuery.rerun",
  "liveQuery.load",
  "draft.staging",
  "draft.stagedChars",
  "editor.externalSync",
  "timeline.windowItems",
  "observer.longTask",
  "observer.eventDuration",
  "observer.frameGap",
] as const

/** One emittable measurement name. */
export type PerfMarkName = (typeof PERF_MARK_NAMES)[number]

/** Coarse device buckets derived from `hardwareConcurrency` + `deviceMemory` only. */
export const PERF_DEVICE_CLASSES = ["low", "mid", "high"] as const

export type PerfDeviceClass = (typeof PERF_DEVICE_CLASSES)[number]

/** Upper bound on samples in one uploaded capture. */
export const PERF_CAPTURE_MAX_SAMPLES = 2048

export const performanceSampleSchema = z
  .object({
    name: z.enum(PERF_MARK_NAMES),
    at: z.number(),
    value: z.number().optional(),
    count: z.number().optional(),
  })
  .strict()

export type PerformanceSample = z.infer<typeof performanceSampleSchema>

export const performanceCaptureSchema = z
  .object({
    captureId: z.string().min(1),
    appVersion: z.string().min(1),
    deviceClass: z.enum(PERF_DEVICE_CLASSES),
    startedAt: z.string().min(1),
    samples: z.array(performanceSampleSchema).max(PERF_CAPTURE_MAX_SAMPLES),
  })
  .strict()

export type PerformanceCapture = z.infer<typeof performanceCaptureSchema>
