import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { INSTALL_PLATFORMS, detectInstallPlatform } from "../src/lib/install-platform"

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1",
  ipadDesktopMode:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) Gecko/20100101 Firefox/141.0",
  curl: "curl/8.7.1",
}

describe("detectInstallPlatform", () => {
  test("maps each browser to the install steps it can follow", () => {
    expect({
      iphoneSafari: detectInstallPlatform(UA.iphoneSafari, 5),
      iphoneChrome: detectInstallPlatform(UA.iphoneChrome, 5),
      ipadDesktopMode: detectInstallPlatform(UA.ipadDesktopMode, 5),
      androidChrome: detectInstallPlatform(UA.androidChrome, 5),
      androidFirefox: detectInstallPlatform(UA.androidFirefox, 5),
      macSafari: detectInstallPlatform(UA.macSafari, 0),
      macChrome: detectInstallPlatform(UA.macChrome, 0),
      windowsEdge: detectInstallPlatform(UA.windowsEdge, 0),
      linuxFirefox: detectInstallPlatform(UA.linuxFirefox, 0),
      macFirefox: detectInstallPlatform(UA.macFirefox, 0),
      curl: detectInstallPlatform(UA.curl, 0),
    }).toEqual({
      iphoneSafari: "ios",
      iphoneChrome: "ios",
      ipadDesktopMode: "ios",
      androidChrome: "android",
      androidFirefox: "android",
      macSafari: "mac-safari",
      macChrome: "chromium",
      windowsEdge: "chromium",
      linuxFirefox: "firefox",
      macFirefox: "firefox",
      curl: null,
    })
  })
})

describe("homepage install section", () => {
  const index = fileURLToPath(new URL("../dist/index.html", import.meta.url))

  test("should ship a selectable steps panel for every detected platform", () => {
    expect(existsSync(index)).toBe(true)
    const html = readFileSync(index, "utf8")
    const missing = INSTALL_PLATFORMS.filter(
      (p) => !html.includes(`id="install-${p}"`) || !html.includes(`data-platform="${p}"`)
    )
    expect(missing).toEqual([])
  })
})
