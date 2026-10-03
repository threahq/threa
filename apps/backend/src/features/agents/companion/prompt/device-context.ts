import type { DeviceContext, DeviceOs } from "@threahq/types"

const OS_NAMES: Record<DeviceOs, string | null> = {
  ios: "iOS",
  android: "Android",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  chromeos: "ChromeOS",
  other: null,
}

export function buildDeviceContextSection(device: DeviceContext): string {
  const osName = OS_NAMES[device.os]
  const where = `${osName ? ` on ${osName}` : ""}, ${device.installed ? "as an installed app" : "in a browser"}`
  return `\n\n## Device\n\nThe person you're replying to is using Threa's ${device.layout} layout${where}. When you give directions in the app, give them for that layout.`
}
