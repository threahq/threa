import { describe, expect, test } from "bun:test"
import * as Y from "yjs"
import { ensureBlockIds } from "@threahq/prosemirror"
import type { JSONContent } from "@threahq/types"
import { blockId } from "../../lib/id"
import { diffSections, projectDoc } from "./projection"
import {
  DocUpdateNotApplicableError,
  applyClientUpdate,
  applyClientWrite,
  contentJsonToYDoc,
  encodeFullState,
  loadDocState,
  writeContentJson,
  ydocToContentJson,
} from "./yjs"

const id = (n: number) => `blk_${String(n).padStart(26, "0")}`
const text = (value: string): JSONContent => ({ type: "text", text: value })
const paragraph = (value: string, n?: number): JSONContent => ({
  type: "paragraph",
  ...(n === undefined ? {} : { attrs: { blockId: id(n) } }),
  content: [text(value)],
})
const task = (checked: boolean, value: string, n: number): JSONContent => ({
  type: "taskItem",
  attrs: { checked },
  content: [paragraph(value, n)],
})

const DOC_ID = "stream_self"
const docEmbed = (docId: string, embedBlockId: string | null = null): JSONContent => ({
  type: "docEmbed",
  attrs: { docId, blockId: embedBlockId, title: "Linked" },
})

const stampedDoc: JSONContent = {
  type: "doc",
  content: [
    paragraph("First", 1),
    paragraph("Second", 2),
    { type: "taskList", attrs: { blockId: id(3) }, content: [task(true, "Done", 4), task(false, "Todo", 5)] },
  ],
}

function editText(json: JSONContent, index: number, value: string): JSONContent {
  const content = [...(json.content ?? [])]
  content[index] = { ...content[index]!, content: [text(value)] }
  return { ...json, content }
}

describe("doc projection", () => {
  test("projects a Y.Doc's top-level blocks into sections and the whole body into markdown", () => {
    const projection = projectDoc(ydocToContentJson(contentJsonToYDoc(stampedDoc)), DOC_ID)
    expect({
      bodyMarkdown: projection.bodyMarkdown,
      sections: projection.sections.map(({ contentJson: _contentJson, ...section }) => section),
    }).toEqual({
      bodyMarkdown: "First\n\nSecond\n\n- [x] Done\n- [ ] Todo",
      sections: [
        { blockId: id(1), position: 0, kind: "paragraph", markdown: "First" },
        { blockId: id(2), position: 1, kind: "paragraph", markdown: "Second" },
        { blockId: id(3), position: 2, kind: "taskList", markdown: "- [x] Done\n- [ ] Todo" },
      ],
    })
  })

  test("projects an emptied doc to no sections", () => {
    expect(projectDoc(ydocToContentJson(new Y.Doc()), DOC_ID)).toEqual({
      bodyMarkdown: "",
      bodyJson: { type: "doc", content: [] },
      sections: [],
      references: [],
    })
  })

  test("should emit one reference per block and target when blocks embed other docs and itself", () => {
    const json: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockId: id(1) }, content: [docEmbed("stream_b"), docEmbed("stream_b")] },
        {
          type: "paragraph",
          attrs: { blockId: id(2) },
          content: [docEmbed("stream_b", id(9)), docEmbed("stream_b"), docEmbed(DOC_ID), docEmbed("stream_c")],
        },
      ],
    }
    expect(projectDoc(json, DOC_ID).references).toEqual([
      { blockId: id(1), refType: "doc", refId: "stream_b" },
      { blockId: id(2), refType: "doc", refId: "stream_b" },
      { blockId: id(2), refType: "doc", refId: "stream_c" },
    ])
  })

  test("refuses a top-level block without a block id", () => {
    expect(() => projectDoc({ type: "doc", content: [paragraph("No id")] }, DOC_ID)).toThrow("has no blockId")
  })

  test("reports exactly the added, changed and removed block ids", () => {
    const previous = [
      { blockId: id(1), markdown: "kept" },
      { blockId: id(2), markdown: "before" },
      { blockId: id(3), markdown: "removed" },
    ]
    const next = [
      { blockId: id(2), markdown: "after" },
      { blockId: id(1), markdown: "kept" },
      { blockId: id(4), markdown: "added" },
    ]
    expect(diffSections(previous, next)).toEqual([id(2), id(4), id(3)])
  })
})

describe("doc Yjs state", () => {
  test("writes server-stamped block ids into the fragment and they survive the round trip", () => {
    const unstamped: JSONContent = { type: "doc", content: [paragraph("One"), paragraph("Two")] }
    const server = contentJsonToYDoc(unstamped)
    const client = loadDocState({ snapshot: encodeFullState(server), updates: [] })

    const stamped = ensureBlockIds(ydocToContentJson(server), blockId)
    const stampUpdate = writeContentJson(server, stamped)
    Y.applyUpdate(client, stampUpdate)

    expect({ server: ydocToContentJson(server), client: ydocToContentJson(client) }).toEqual({
      server: stamped,
      client: stamped,
    })
    expect(stamped.content?.every((block) => typeof block.attrs?.blockId === "string")).toBe(true)
  })

  test("a client edit and a concurrent server write converge after exchanging updates", () => {
    const server = contentJsonToYDoc(stampedDoc)
    const client = loadDocState({ snapshot: encodeFullState(server), updates: [] })

    const clientUpdate = writeContentJson(client, editText(ydocToContentJson(client), 0, "First, edited by client"))
    const serverUpdate = writeContentJson(server, editText(ydocToContentJson(server), 1, "Second, edited by server"))
    applyClientUpdate(server, clientUpdate)
    Y.applyUpdate(client, serverUpdate)

    const expected = editText(editText(stampedDoc, 0, "First, edited by client"), 1, "Second, edited by server")
    expect({ server: ydocToContentJson(server), client: ydocToContentJson(client) }).toEqual({
      server: ydocToContentJson(contentJsonToYDoc(expected)),
      client: ydocToContentJson(contentJsonToYDoc(expected)),
    })
  })

  test("replays a snapshot plus later updates to the same doc", () => {
    const origin = contentJsonToYDoc(stampedDoc)
    const snapshot = encodeFullState(origin)
    const update = writeContentJson(origin, editText(ydocToContentJson(origin), 0, "Later"))
    expect(ydocToContentJson(loadDocState({ snapshot, updates: [update] }))).toEqual(ydocToContentJson(origin))
  })

  test("reports an update the doc already holds as not applied and leaves the doc unchanged", () => {
    const server = contentJsonToYDoc(stampedDoc)
    const client = loadDocState({ snapshot: encodeFullState(server), updates: [] })
    const update = writeContentJson(client, editText(ydocToContentJson(client), 0, "Edited once"))

    const first = applyClientWrite(server, update, ydocToContentJson(server))
    const stateAfterFirst = encodeFullState(server)
    const second = applyClientWrite(server, update, ydocToContentJson(server))

    expect({ first: first.applied, second, state: encodeFullState(server) }).toEqual({
      first: true,
      second: { applied: false },
      state: stateAfterFirst,
    })
  })

  test("refuses an update whose dependencies the doc does not have", () => {
    const origin = contentJsonToYDoc(stampedDoc)
    const behind = loadDocState({ snapshot: encodeFullState(origin), updates: [] })
    writeContentJson(origin, editText(ydocToContentJson(origin), 0, "Unseen"))
    const dependent = writeContentJson(origin, editText(ydocToContentJson(origin), 0, "Depends on unseen"))

    expect(() => applyClientUpdate(behind, dependent)).toThrow(DocUpdateNotApplicableError)
  })
})
