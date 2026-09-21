import { describe, expect, it } from "vitest"
import { buildIncomingWebhookUrls } from "./webhook-url"

describe("buildIncomingWebhookUrls", () => {
  it("builds the native and Slack URLs from a bare origin", () => {
    expect(buildIncomingWebhookUrls("https://app.threa.io", "ws_1", "hook_1", "s3cr3t")).toEqual({
      url: "https://app.threa.io/api/v1/workspaces/ws_1/hooks/hook_1/s3cr3t",
      slackUrl: "https://app.threa.io/api/v1/workspaces/ws_1/hooks/hook_1/s3cr3t/slack",
    })
  })

  it("does not double the slash when the origin ends with one", () => {
    expect(buildIncomingWebhookUrls("https://app.threa.io///", "ws_1", "hook_1", "s3cr3t")).toEqual({
      url: "https://app.threa.io/api/v1/workspaces/ws_1/hooks/hook_1/s3cr3t",
      slackUrl: "https://app.threa.io/api/v1/workspaces/ws_1/hooks/hook_1/s3cr3t/slack",
    })
  })
})
