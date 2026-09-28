import { describe, expect, it } from "bun:test"
import { isPushRequestPath } from "./push"

describe("isPushRequestPath", () => {
  it("should match every push API route and nothing that only looks like one", () => {
    const paths = [
      "/api/workspaces/ws_01X/push/test",
      "/api/workspaces/ws_01X/push/test/ptest_01ABC",
      "/api/workspaces/ws_01X/push/receipts",
      "/api/workspaces/ws_01X/push/subscribe",
      "/api/workspaces/ws_01X/push/unsubscribe",
      "/api/workspaces/ws_01X/push/vapid-key",
      "/api/workspaces/ws_01X/push",
      "/api/workspaces/ws_01X/push/",
      "/API/Workspaces/WS_01X/PUSH/Test",
      "/api/workspaces/%zz/push/receipts",
      "/api/workspaces//push/test",
      "/api/push/cleanup-endpoint",
      "/api/push",
      "/api/workspaces/ws_01X/pushes",
      "/api/workspaces/ws_01X/push-settings",
      "/api/workspaces/ws_01X/streams/push",
      "/api/pushy",
      "/api/workspaces/ws_01X/a/push/test",
      "/v2/api/push/cleanup-endpoint",
      "/w/ws_01X/push/test",
      "/api/workspaces/ws_01X/streams",
    ]

    expect(Object.fromEntries(paths.map((path) => [path, isPushRequestPath(path)]))).toEqual({
      "/api/workspaces/ws_01X/push/test": true,
      "/api/workspaces/ws_01X/push/test/ptest_01ABC": true,
      "/api/workspaces/ws_01X/push/receipts": true,
      "/api/workspaces/ws_01X/push/subscribe": true,
      "/api/workspaces/ws_01X/push/unsubscribe": true,
      "/api/workspaces/ws_01X/push/vapid-key": true,
      "/api/workspaces/ws_01X/push": true,
      "/api/workspaces/ws_01X/push/": true,
      "/API/Workspaces/WS_01X/PUSH/Test": true,
      "/api/workspaces/%zz/push/receipts": true,
      "/api/workspaces//push/test": true,
      "/api/push/cleanup-endpoint": true,
      "/api/push": true,
      "/api/workspaces/ws_01X/pushes": false,
      "/api/workspaces/ws_01X/push-settings": false,
      "/api/workspaces/ws_01X/streams/push": false,
      "/api/pushy": false,
      "/api/workspaces/ws_01X/a/push/test": false,
      "/v2/api/push/cleanup-endpoint": false,
      "/w/ws_01X/push/test": false,
      "/api/workspaces/ws_01X/streams": false,
    })
  })
})
