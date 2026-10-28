import { z } from "zod"

const DEVICE_LAYOUTS = ["mobile", "desktop"] as const

const DEVICE_OSES = ["ios", "android", "macos", "windows", "linux", "chromeos", "other"] as const
export type DeviceOs = (typeof DEVICE_OSES)[number]

/** The most open docs one device report carries; a longer report is dropped whole. */
export const MAX_OPEN_DOC_IDS = 8

/** What the client reports about the device in use on a socket heartbeat. */
const deviceContextSchema = z.strictObject({
  layout: z.enum(DEVICE_LAYOUTS),
  os: z.enum(DEVICE_OSES),
  installed: z.boolean(),
  openDocIds: z
    .array(z.string().max(64))
    .max(MAX_OPEN_DOC_IDS)
    .default(() => []),
})

export type DeviceContext = z.output<typeof deviceContextSchema>

/** Heartbeat payloads are untrusted; anything off-shape is dropped, never partially applied. */
export function parseDeviceContext(value: unknown): DeviceContext | null {
  const parsed = deviceContextSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
