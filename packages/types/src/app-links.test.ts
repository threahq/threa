import { describe, expect, it } from "bun:test"
import { parseAppLinkHref } from "./app-links"

describe("app: links", () => {
  it("should parse each destination kind", () => {
    expect([
      parseAppLinkHref("app:memory"),
      parseAppLinkHref("app:settings/notifications"),
      parseAppLinkHref("app:workspace-settings/bots"),
    ]).toEqual([
      { kind: "page", page: "memory" },
      { kind: "settings", tab: "notifications" },
      { kind: "workspace-settings", tab: "bots" },
    ])
  })

  it("should reject hrefs outside the registry", () => {
    expect(
      [
        "app:moon",
        "app:settings",
        "app:settings/nope",
        "app:workspace-settings/bots/extra",
        "app:memory/extra",
        "https://threa.io",
        "",
      ].map(parseAppLinkHref)
    ).toEqual([null, null, null, null, null, null, null])
  })
})
