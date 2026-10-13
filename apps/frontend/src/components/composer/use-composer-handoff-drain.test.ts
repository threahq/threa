import { afterEach, describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import type { JSONContent } from "@threahq/types"
import type { DraftComposerState } from "@/hooks/use-draft-composer"
import type { UseStashComposerResult } from "@/hooks/use-stash-composer"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { __resetShareHandoffStoreForTesting, queueContentHandoff } from "@/stores/composer-handoff-store"
import type { ComposerControlHandle } from "./message-composer"
import { useComposerHandoffDrain } from "./use-composer-handoff-drain"

const TARGET = "board:reply:conv_1"
const HANDED: JSONContent[] = [{ type: "paragraph", content: [{ type: "text", text: "from the aside" }] }]

/** An open composer on TARGET; `withEditor: false` is one whose editor never mounts. */
function openComposer({ withEditor }: { withEditor: boolean }) {
  let doc: JSONContent = EMPTY_DOC
  const chain = {
    setContent: (content: JSONContent) => {
      doc = content
      return chain
    },
    focus: () => chain,
    run: () => true,
  }
  const editor = { isDestroyed: false, getJSON: () => doc, chain: () => chain }
  const control = { getEditor: () => (withEditor ? editor : null) } as unknown as ComposerControlHandle
  const composer = {
    isLoaded: true,
    content: EMPTY_DOC,
    contextRefs: [],
    getPendingAttachmentsSnapshot: () => [],
    adoptAttachments: () => {},
    flushDraftWithResult: async () => true,
  } as unknown as DraftComposerState
  const stash = { handleStashBeforeReplace: async () => false } as unknown as UseStashComposerResult
  const hook = renderHook(() =>
    useComposerHandoffDrain({
      workspaceId: "ws_1",
      target: TARGET,
      draftKey: TARGET,
      composer,
      stash,
      controlRef: { current: control },
    })
  )
  return { unmount: hook.unmount, content: () => doc.content }
}

afterEach(() => __resetShareHandoffStoreForTesting())

describe("useComposerHandoffDrain", () => {
  it("should put a handed draft in one composer when two are open on the target", async () => {
    const first = openComposer({ withEditor: true })
    const second = openComposer({ withEditor: true })

    const { delivered } = queueContentHandoff("ws_1", TARGET, HANDED)

    expect(await delivered).toBe(true)
    expect([first.content(), second.content()]).toEqual([[...HANDED, { type: "paragraph" }], EMPTY_DOC.content])
  })

  it("should hand the draft to the other composer when the one taking it goes away", async () => {
    const leaving = openComposer({ withEditor: false })
    const staying = openComposer({ withEditor: true })

    const { delivered } = queueContentHandoff("ws_1", TARGET, HANDED)
    leaving.unmount()

    expect(await delivered).toBe(true)
    expect(staying.content()).toEqual([...HANDED, { type: "paragraph" }])
  })
})
