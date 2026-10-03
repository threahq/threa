import { z } from "zod"

export const DEVICE_LAYOUTS = ["mobile", "desktop"] as const
export type DeviceLayout = (typeof DEVICE_LAYOUTS)[number]

export const DEVICE_OSES = ["ios", "android", "macos", "windows", "linux", "chromeos", "other"] as const
export type DeviceOs = (typeof DEVICE_OSES)[number]

/** What the client reports about the device in use on a socket heartbeat. */
export const deviceContextSchema = z.strictObject({
  layout: z.enum(DEVICE_LAYOUTS),
  os: z.enum(DEVICE_OSES),
  installed: z.boolean(),
})

export type DeviceContext = z.infer<typeof deviceContextSchema>

/** Heartbeat payloads are untrusted; anything off-shape is dropped, never partially applied. */
export function parseDeviceContext(value: unknown): DeviceContext | null {
  const parsed = deviceContextSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
