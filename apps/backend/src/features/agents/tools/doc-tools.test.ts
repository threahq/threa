import { describe, expect, it, mock } from "bun:test"
import type { DocAgentWriteResult } from "../../docs"
import {
  createCreateDocTool,
  createDeleteBlockTool,
  createEditDocTool,
  createInsertBlockTool,
  createMoveBlockTool,
  createReadDocTool,
  createSetDocTitleTool,
} from "./doc-tools"
import type { DocToolDeps } from "./tool-deps"

const EXEC_OPTS = { toolCallId: "call_1" }
const DOC = "stream_doc1"
const BLK = "blk_01JZ0000000000000000000000"

function deps(overrides: Partial<DocToolDeps> = {}): DocToolDeps {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected call")
  }
  return {
    listDocs: unexpected,
    readDoc: unexpected,
    editDoc: unexpected,
    insertBlock: unexpected,
    moveBlock: unexpected,
    deleteBlock: unexpected,
    setTitle: unexpected,
    createDoc: unexpected,
    ...overrides,
  }
}

const applied: DocAgentWriteResult = {
  status: "applied",
  docId: DOC,
  title: "Rotation tracker",
  seq: 7,
  touchedBlockIds: [BLK],
  markdown: `<!-- ${BLK} -->\n- [x] AWS key revoked`,
}

describe("read_doc", () => {
  it("lists the host's docs when called without a docId", async () => {
    const tool = createReadDocTool(
      deps({
        listDocs: async () => [
          { docId: DOC, title: "Rotation tracker" },
          { docId: "stream_doc2", title: null },
        ],
      })
    )
    const result = await tool.config.execute({}, EXEC_OPTS)
    expect(result.output).toBe("Docs on this stream:\n- stream_doc1: Rotation tracker\n- stream_doc2: (untitled)")
  })

  it("says so when the host has no docs", async () => {
    const tool = createReadDocTool(deps({ listDocs: async () => [] }))
    expect((await tool.config.execute({}, EXEC_OPTS)).output).toBe("This stream hosts no docs.")
  })

  it("returns title, seq and marker-annotated markdown for one doc", async () => {
    const readDoc = mock(async () => ({
      status: "ok" as const,
      docId: DOC,
      title: "Rotation tracker",
      seq: 3,
      markdown: `<!-- ${BLK} -->\n# Keys`,
    }))
    const tool = createReadDocTool(deps({ readDoc }))
    const result = await tool.config.execute({ docId: DOC }, EXEC_OPTS)
    expect({ calls: readDoc.mock.calls, output: result.output }).toEqual({
      calls: [[{ docId: DOC }] as never],
      output: `Doc stream_doc1 "Rotation tracker" (seq 3):\n\n<!-- ${BLK} -->\n# Keys`,
    })
  })

  it("points the model at the listing when the doc is not the host's", async () => {
    const tool = createReadDocTool(deps({ readDoc: async () => ({ status: "not_found" }) }))
    expect((await tool.config.execute({ docId: "stream_other" }, EXEC_OPTS)).output).toBe(
      "Doc not found: it is not one of this stream's docs. Call read_doc without a docId to list them. Nothing was written."
    )
  })

  it("carries the docs prompt block and declares no effects", () => {
    const tool = createReadDocTool(deps())
    expect({
      heading: tool.config.promptBlock?.split("\n")[0],
      effects: tool.config.trace.effects,
    }).toEqual({ heading: "## Working with docs", effects: undefined })
  })
})

describe("edit_doc", () => {
  const INPUT = {
    docId: DOC,
    reason: "marked the AWS key revoked",
    edits: [{ old: "[ ] AWS key", new: "[x] AWS key" }],
  }

  it("passes the edits through and shows the changed blocks", async () => {
    const editDoc = mock(async () => applied)
    const tool = createEditDocTool(deps({ editDoc }))
    const result = await tool.config.execute(INPUT, EXEC_OPTS)
    expect({ calls: editDoc.mock.calls, output: result.output }).toEqual({
      calls: [[INPUT] as never],
      output: `Applied to doc stream_doc1 "Rotation tracker" (seq 7). Changed blocks:\n\n<!-- ${BLK} -->\n- [x] AWS key revoked`,
    })
    expect(tool.config.trace.effects?.(INPUT, result)).toEqual([
      { kind: "doc", target: DOC, label: "Rotation tracker" },
    ])
  })

  it("names the refusal, the failing edit, and hands back the scope's current text", async () => {
    const tool = createEditDocTool(
      deps({
        editDoc: async () => ({
          status: "edit_refused",
          refusal: { reason: "ambiguous", editIndex: 0, scope: { markdown: `<!-- ${BLK} -->\nkey key` } },
        }),
      })
    )
    const result = await tool.config.execute(INPUT, EXEC_OPTS)
    expect(result.output).toBe(
      `Refused (ambiguous at edits[0]): \`old\` matches more than one place; use a longer anchor or a blockId. Nothing was written. Current text of the doc:\n\n<!-- ${BLK} -->\nkey key`
    )
    expect(tool.config.trace.effects?.(INPUT, result)).toEqual([])
  })

  it("scopes a not_found refusal to the named block", async () => {
    const tool = createEditDocTool(
      deps({
        editDoc: async () => ({
          status: "edit_refused",
          refusal: { reason: "not_found", editIndex: 1, scope: { blockId: BLK, markdown: `<!-- ${BLK} -->\nKeys` } },
        }),
      })
    )
    expect((await tool.config.execute(INPUT, EXEC_OPTS)).output).toBe(
      `Refused (not_found at edits[1]): \`old\` does not match the current text. Nothing was written. Current text of block ${BLK}:\n\n<!-- ${BLK} -->\nKeys`
    )
  })

  it("tells the model when nothing changed and declares no effect", async () => {
    const tool = createEditDocTool(
      deps({ editDoc: async () => ({ status: "unchanged", docId: DOC, title: "Rotation tracker", seq: 7 }) })
    )
    const result = await tool.config.execute(INPUT, EXEC_OPTS)
    expect({ output: result.output, effects: tool.config.trace.effects?.(INPUT, result) }).toEqual({
      output: "Nothing changed: doc stream_doc1 already reads that way (seq 7).",
      effects: [],
    })
  })

  it("explains access refusals by their cause and invalid results, without effects", async () => {
    const outputs: string[] = []
    for (const outcome of [
      { status: "not_found" },
      { status: "refused", code: "not_a_member" },
      { status: "refused", code: "archived" },
      { status: "refused", code: "forbidden", detail: "SOME_CODE" },
      { status: "invalid" },
    ] as DocAgentWriteResult[]) {
      const tool = createEditDocTool(deps({ editDoc: async () => outcome }))
      const result = await tool.config.execute(INPUT, EXEC_OPTS)
      expect(tool.config.trace.effects?.(INPUT, result)).toEqual([])
      outputs.push(result.output)
    }
    expect(outputs).toEqual([
      "Doc not found: it is not one of this stream's docs. Call read_doc without a docId to list them. Nothing was written.",
      "Refused (not_a_member): the person who asked may not edit this doc. Nothing was written.",
      "Refused (archived): the doc is archived. Nothing was written.",
      "Refused (forbidden): the person who asked may not edit this doc. Nothing was written.",
      "Refused: the result would not be a valid doc. Nothing was written.",
    ])
  })

  it("returns text, not a throw, when the service fails", async () => {
    const tool = createEditDocTool(
      deps({
        editDoc: async () => {
          throw new Error("db down")
        },
      })
    )
    const result = await tool.config.execute(INPUT, EXEC_OPTS)
    expect({ output: result.output, effects: tool.config.trace.effects?.(INPUT, result) }).toEqual({
      output: "Failed to edit doc. Nothing was written.",
      effects: [],
    })
  })

  it("requires a 1–280 char trimmed reason and at least one edit", () => {
    const schema = createEditDocTool(deps()).config.inputSchema
    expect({
      empty: schema.safeParse({ ...INPUT, reason: "" }).success,
      blank: schema.safeParse({ ...INPUT, reason: "   " }).success,
      long: schema.safeParse({ ...INPUT, reason: "x".repeat(281) }).success,
      max: schema.safeParse({ ...INPUT, reason: ` ${"x".repeat(280)} ` }).success,
      noEdits: schema.safeParse({ ...INPUT, edits: [] }).success,
    }).toEqual({ empty: false, blank: false, long: false, max: true, noEdits: false })
  })
})

describe("block tools", () => {
  it("insert_block forwards after/markdown and declares the doc effect", async () => {
    const insertBlock = mock(async () => applied)
    const tool = createInsertBlockTool(deps({ insertBlock }))
    const input = { docId: DOC, reason: "added GitHub row", after: "start", markdown: "New" }
    const result = await tool.config.execute(input, EXEC_OPTS)
    expect({ calls: insertBlock.mock.calls, effects: tool.config.trace.effects?.(input, result) }).toEqual({
      calls: [[input] as never],
      effects: [{ kind: "doc", target: DOC, label: "Rotation tracker" }],
    })
  })

  it("move_block reports an unknown block", async () => {
    const tool = createMoveBlockTool(
      deps({
        moveBlock: async () => ({
          status: "edit_refused",
          refusal: { reason: "unknown_block", scope: { markdown: "whole doc" } },
        }),
      })
    )
    const input = { docId: DOC, reason: "reordered", blockId: BLK, after: "blk_missing" }
    const result = await tool.config.execute(input, EXEC_OPTS)
    expect({ output: result.output, effects: tool.config.trace.effects?.(input, result) }).toEqual({
      output:
        "Refused (unknown_block): the blockId or `after` names no block of this doc. Nothing was written. Current text of the doc:\n\nwhole doc",
      effects: [],
    })
  })

  it("delete_block reports an applied delete with no remaining blocks to show", async () => {
    const tool = createDeleteBlockTool(deps({ deleteBlock: async () => ({ ...applied, title: null, markdown: "" }) }))
    const input = { docId: DOC, reason: "removed stale row", blockId: BLK }
    const result = await tool.config.execute(input, EXEC_OPTS)
    expect({ output: result.output, effects: tool.config.trace.effects?.(input, result) }).toEqual({
      output: "Applied to doc stream_doc1 (seq 7).",
      effects: [{ kind: "doc", target: DOC }],
    })
  })

  it("labels the effect with a title that carries quotes", async () => {
    const tool = createMoveBlockTool(deps({ moveBlock: async () => ({ ...applied, title: 'Q3 "launch" plan' }) }))
    const input = { docId: DOC, reason: "reordered", blockId: BLK, after: "start" }
    const result = await tool.config.execute(input, EXEC_OPTS)
    expect(tool.config.trace.effects?.(input, result)).toEqual([
      { kind: "doc", target: DOC, label: 'Q3 "launch" plan' },
    ])
  })
})

describe("set_doc_title", () => {
  const INPUT = { docId: DOC, title: "Key rotation" }

  it("passes docId and title on, and labels the effect with the new title", async () => {
    const setTitle = mock(async () => ({ status: "applied" as const, docId: DOC, title: "Key rotation" }))
    const tool = createSetDocTitleTool(deps({ setTitle }))
    const result = await tool.config.execute(INPUT, EXEC_OPTS)
    expect({
      calls: setTitle.mock.calls,
      output: result.output,
      effects: tool.config.trace.effects?.(INPUT, result),
    }).toEqual({
      calls: [[{ docId: DOC, title: "Key rotation" }] as never],
      output: 'Retitled doc stream_doc1 "Key rotation".',
      effects: [{ kind: "doc", target: DOC, label: "Key rotation" }],
    })
  })

  it("declares nothing when refused", async () => {
    const tool = createSetDocTitleTool(deps({ setTitle: async () => ({ status: "refused", code: "not_a_member" }) }))
    const result = await tool.config.execute(INPUT, EXEC_OPTS)
    expect(tool.config.trace.effects?.(INPUT, result)).toEqual([])
  })

  it("requires a non-blank title of at most 200 chars and takes no reason", () => {
    const schema = createSetDocTitleTool(deps()).config.inputSchema
    expect({
      blank: schema.safeParse({ docId: DOC, title: "   " }).success,
      long: schema.safeParse({ docId: DOC, title: "x".repeat(201) }).success,
      trimmed: schema.safeParse({ docId: DOC, title: "  Key rotation " }).data,
      reasonDropped: schema.safeParse({ ...INPUT, reason: "clearer name" }).data,
    }).toEqual({ blank: false, long: false, trimmed: INPUT, reasonDropped: INPUT })
  })
})

describe("create_doc", () => {
  it("shows the created body and declares the new doc", async () => {
    const createDoc = mock(async () => ({
      status: "created" as const,
      docId: "stream_new",
      title: "Plan",
      seq: 1,
      markdown: `<!-- ${BLK} -->\n# Plan`,
    }))
    const tool = createCreateDocTool(deps({ createDoc }))
    const input = { reason: "started the plan", title: "Plan", markdown: "# Plan" }
    const result = await tool.config.execute(input, EXEC_OPTS)
    expect({
      calls: createDoc.mock.calls,
      output: result.output,
      effects: tool.config.trace.effects?.(input, result),
    }).toEqual({
      calls: [[input] as never],
      output: `Created doc stream_new "Plan" (seq 1):\n\n<!-- ${BLK} -->\n# Plan`,
      effects: [{ kind: "doc", target: "stream_new", label: "Plan" }],
    })
  })

  it("reports a doc whose body was not applied as created, and still declares it", async () => {
    const outputs: string[] = []
    for (const body of [
      { status: "invalid" },
      { status: "refused", code: "read_only" },
      { status: "error" },
    ] as const) {
      const tool = createCreateDocTool(
        deps({
          createDoc: async () => ({
            status: "created",
            docId: "stream_new",
            title: "Plan",
            seq: 0,
            markdown: "",
            body,
          }),
        })
      )
      const input = { reason: "started the plan", title: "Plan", markdown: "# Plan" }
      const result = await tool.config.execute(input, EXEC_OPTS)
      expect(tool.config.trace.effects?.(input, result)).toEqual([{ kind: "doc", target: "stream_new", label: "Plan" }])
      outputs.push(result.output)
    }

    expect(outputs).toEqual([
      'Created doc stream_new "Plan" (seq 0), but the body was not applied: the result would not be a valid doc.',
      'Created doc stream_new "Plan" (seq 0), but the body was not applied: the person who asked may not edit this doc.',
      'Created doc stream_new "Plan" (seq 0), but the body was not applied: saving it failed.',
    ])
  })

  it("reports a title that was not set alongside the created doc", async () => {
    const tool = createCreateDocTool(
      deps({
        createDoc: async () => ({
          status: "created",
          docId: "stream_new",
          title: null,
          seq: 0,
          markdown: "",
          titleFailure: { status: "error" },
        }),
      })
    )
    const input = { reason: "started the plan", title: "Plan" }
    const result = await tool.config.execute(input, EXEC_OPTS)

    expect({ output: result.output, effects: tool.config.trace.effects?.(input, result) }).toEqual({
      output: "Created doc stream_new (seq 0), but the title was not set: saving it failed.",
      effects: [{ kind: "doc", target: "stream_new" }],
    })
  })

  it("declares nothing when the host refuses, naming the real cause", async () => {
    const tool = createCreateDocTool(deps({ createDoc: async () => ({ status: "refused", code: "e2e_host" }) }))
    const input = { reason: "started the plan" }
    const result = await tool.config.execute(input, EXEC_OPTS)
    expect({ output: result.output, effects: tool.config.trace.effects?.(input, result) }).toEqual({
      output: "Refused (e2e_host): encrypted streams cannot host docs. Nothing was written.",
      effects: [],
    })
  })
})
