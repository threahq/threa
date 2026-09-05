import { describe, expect, test } from "bun:test"
import { workspaceHomeUrl, workspaceMemoUrl, workspaceMessageUrl, workspaceStreamUrl } from "./workspace-links"

describe("workspace links", () => {
  test("message URL deep-links the stream at the message", () => {
    expect(workspaceMessageUrl("ws_1", "stream_1", "msg_1")).toBe("/w/ws_1/s/stream_1?m=msg_1")
  })

  test("stream URL points at the stream", () => {
    expect(workspaceStreamUrl("ws_1", "stream_1")).toBe("/w/ws_1/s/stream_1")
  })

  test("memo URL opens the memory explorer at the memo", () => {
    expect(workspaceMemoUrl("ws_1", "memo_1")).toBe("/w/ws_1/memory?memo=memo_1")
  })

  test("home URL is the workspace root", () => {
    expect(workspaceHomeUrl("ws_1")).toBe("/w/ws_1")
  })
})
