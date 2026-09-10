import { expect, it, vi } from "vitest"
import { ThreaDatabase, getActiveDb, setActiveDb } from "@/db/database"
import { setStorageAccount } from "@/lib/account-storage"
import { readStagedDraft, stageDraftContent } from "@/lib/drafts/draft-staging"
import { rescopeScopeDrafts } from "./use-draft-message"

it("should not move another account's staged content after rescoping the originating database", async () => {
  const previous = getActiveDb()
  const a = new ThreaDatabase("rescope_owner_a")
  const b = new ThreaDatabase("rescope_owner_b")
  const contentJson = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "B private draft" }] }],
  }
  try {
    setStorageAccount("workos_b")
    stageDraftContent("ws_shared", "stream:old", contentJson)
    await a.drafts.put({
      id: "draft_a",
      workspaceId: "ws_shared",
      scope: "stream:old",
      contentJson,
      attachments: [],
      clientUpdatedAt: 1,
    })
    setActiveDb(a)
    setStorageAccount("workos_a")
    const transact = a.transaction.bind(a) as (...args: unknown[]) => Promise<unknown>
    vi.spyOn(a, "transaction").mockImplementation(((...args: unknown[]) =>
      transact(...args).then((result) => {
        setActiveDb(b)
        setStorageAccount("workos_b")
        return result
      })) as typeof a.transaction)

    await rescopeScopeDrafts("ws_shared", "stream:old", "stream:new", a)

    expect({
      originScope: (await a.drafts.get("draft_a"))?.scope,
      otherOld: readStagedDraft("ws_shared", "stream:old")?.contentJson,
      otherNew: readStagedDraft("ws_shared", "stream:new"),
    }).toEqual({ originScope: "stream:new", otherOld: contentJson, otherNew: null })
  } finally {
    vi.restoreAllMocks()
    setActiveDb(previous)
    setStorageAccount(null)
    await a.delete()
    await b.delete()
  }
})
