import { describe, expect, it } from "bun:test"
import { parseAppLinkHref } from "./app-links"

describe("app: links", () => {
  it("should parse each destination kind", () => {
    expect([parseAppLinkHref("app:memory"), parseAppLinkHref("app:settings/notifications")]).toEqual([
      { kind: "page", page: "memory" },
      { kind: "settings", tab: "notifications" },
    ])
  })

  it("should resolve hrefs to the tabs of the two former settings dialogs", () => {
    expect(
      [
        "app:settings/dictation",
        "app:settings/schedule",
        "app:settings/accessibility",
        "app:settings/diagnostics",
        "app:workspace-settings/bots",
        "app:workspace-settings/users",
        "app:workspace-settings/api-keys",
        "app:workspace-settings/statuses",
        "app:workspace-settings/members",
      ].map(parseAppLinkHref)
    ).toEqual([
      { kind: "settings", tab: "voice" },
      { kind: "settings", tab: "datetime" },
      { kind: "settings", tab: "appearance" },
      { kind: "settings", tab: "privacy" },
      { kind: "settings", tab: "bots" },
      { kind: "settings", tab: "members" },
      { kind: "settings", tab: "developer" },
      { kind: "settings", tab: "workspace-defaults" },
      { kind: "settings", tab: "members" },
    ])
  })

  it("should reject hrefs outside the registry or to pages some readers can't see", () => {
    expect(
      [
        "app:moon",
        "app:settings",
        "app:settings/nope",
        "app:settings/constructor",
        "app:settings/workspace-ai",
        "app:settings/early-access",
        "app:settings/board",
        "app:workspace-settings/ai-agents",
        "app:workspace-settings/personas",
        "app:workspace-settings/feature-flags",
        "app:workspace-settings/bots/extra",
        "app:memory/extra",
        "https://threa.io",
        "",
      ].map(parseAppLinkHref)
    ).toEqual([null, null, null, null, null, null, null, null, null, null, null, null, null, null])
  })
})
