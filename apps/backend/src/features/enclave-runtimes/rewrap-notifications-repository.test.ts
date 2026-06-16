import { describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { EnclaveRewrapNotificationsRepository } from "./rewrap-notifications-repository"

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rowCount: number): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows: [] as unknown[], rowCount } as QueryResult
    }),
  }
}

describe("EnclaveRewrapNotificationsRepository.claimSocketNudge", () => {
  it("upserts the socket clock under a window guard and reports whether it won the emit (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const claimed = await EnclaveRewrapNotificationsRepository.claimSocketNudge(createQuerier(captured, 1), {
      workspaceId: "ws_1",
      rootStreamId: "stream_1",
      reemitMs: 300_000,
    })

    expect(captured.text).toContain("INSERT INTO enclave_rewrap_notifications")
    expect(captured.text).toContain("ON CONFLICT (workspace_id, root_stream_id) DO UPDATE")
    expect(captured.text).toContain("SET last_socket_emit_at = NOW()")
    // The re-emit only fires once the prior stamp is null or older than the window.
    expect(captured.text).toContain("enclave_rewrap_notifications.last_socket_emit_at IS NULL")
    expect(captured.text).toContain("last_socket_emit_at\n              < NOW()")
    expect(captured.values).toContain(300_000)
    expect(claimed).toBe(true)
  })

  it("reports false when another poller emitted inside the window (no row updated)", async () => {
    const claimed = await EnclaveRewrapNotificationsRepository.claimSocketNudge(
      createQuerier({ text: null, values: null }, 0),
      { workspaceId: "ws_1", rootStreamId: "stream_1", reemitMs: 300_000 }
    )
    expect(claimed).toBe(false)
  })
})

describe("EnclaveRewrapNotificationsRepository.claimWebpushNudge", () => {
  it("guards an independent web-push clock so it can claim even after the socket slot created the row", async () => {
    const captured: Captured = { text: null, values: null }
    const claimed = await EnclaveRewrapNotificationsRepository.claimWebpushNudge(createQuerier(captured, 1), {
      workspaceId: "ws_1",
      rootStreamId: "stream_1",
      reemitMs: 1_800_000,
    })

    expect(captured.text).toContain("SET last_webpush_emit_at = NOW()")
    expect(captured.text).toContain("enclave_rewrap_notifications.last_webpush_emit_at IS NULL")
    expect(captured.values).toContain(1_800_000)
    expect(claimed).toBe(true)
  })
})
