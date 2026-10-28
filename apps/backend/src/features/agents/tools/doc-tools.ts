import { z } from "zod"
import {
  AgentStepTypes,
  AgentToolNames,
  TOOL_CATEGORIES_BY_NAME,
  type AgentToolEffect,
  type AgentToolName,
} from "@threahq/types"
import { logger } from "../../../lib/logger"
import type {
  DocAgentAccessRefusal,
  DocAgentCreateResult,
  DocAgentEditRefusal,
  DocAgentRefusalCode,
  DocAgentRewriteFailure,
  DocAgentTitleResult,
  DocAgentWriteResult,
} from "../../docs"
import { UNTITLED_DOC_LABEL } from "../../docs"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { DocToolDeps } from "./tool-deps"

const docId = z.string().describe("The doc's id, as listed by read_doc.")
const reason = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .describe("One line on what changed and why, shown to people on this stream's timeline.")
const after = z
  .string()
  .describe('The blockId (from a `<!-- blk_… -->` marker) to place the block after, or "start" for the top of the doc.')
const blockMarkdown = z.string().min(1).describe("The block's content as markdown, without markers.")

const ReadDocSchema = z.object({
  docId: docId.optional().describe("Omit to list this stream's docs; pass one to read it."),
})
const EditDocSchema = z.object({
  docId,
  reason,
  edits: z
    .array(
      z.object({
        blockId: z.string().optional().describe("Confine the match to this block."),
        old: z.string().min(1).describe("Exact current text inside ONE block, copied from read_doc."),
        new: z.string().describe("The replacement text."),
      })
    )
    .min(1)
    .describe("Applied together: if any edit fails to match, nothing is written."),
})
const InsertBlockSchema = z.object({ docId, reason, after, markdown: blockMarkdown })
const MoveBlockSchema = z.object({ docId, reason, blockId: z.string().describe("The block to move."), after })
const DeleteBlockSchema = z.object({ docId, reason, blockId: z.string().describe("The block to delete.") })
const SetDocTitleSchema = z.object({ docId, title: z.string().trim().min(1).max(200) })
const CreateDocSchema = z.object({
  reason,
  title: z.string().trim().max(200).optional(),
  markdown: z.string().optional().describe("The doc's initial body as markdown."),
})

const PROMPT_BLOCK = `## Working with docs

Docs hosted on this stream are shared working documents. \`read_doc\` without a docId lists them; with one it returns the doc as markdown, each top-level block preceded by a \`<!-- blk_… -->\` marker.

- A doc marked open under "Docs on this stream" is the one in front of them: "the doc" means that one unless they name another, and a doc they name wins.
- Read a doc before editing it, and **edit, don't append**: change the text in place with \`edit_doc\` rather than adding a new block that restates it.
- \`old\` must be the exact current text inside ONE block — copy it from read_doc; a match never spans two blocks. On not_found or ambiguous, retry once with a tighter anchor or a \`blockId\`.
- Markers are ids, not content: use them as \`blockId\`/\`after\`, never write them into text.
- \`reason\` is one line shown to people on this stream's timeline, so make it describe the change.
- Never put secrets (tokens, passwords, private keys) in a doc — everyone on the stream can read it.`

const NOT_FOUND =
  "Doc not found: it is not one of this stream's docs. Call read_doc without a docId to list them. Nothing was written."

const EDIT_REFUSAL_CAUSE = {
  not_found: "`old` does not match the current text",
  ambiguous: "`old` matches more than one place; use a longer anchor or a blockId",
  unknown_block: "the blockId or `after` names no block of this doc",
} as const satisfies Record<DocAgentEditRefusal["reason"], string>

const REFUSAL_CAUSE = {
  not_a_member: "the person who asked may not edit this doc",
  read_only: "the person who asked may not edit this doc",
  forbidden: "the person who asked may not edit this doc",
  archived: "the doc is archived",
  host_cannot_host_docs: "this stream type cannot host docs",
  e2e_host: "encrypted streams cannot host docs",
  title_empty: "the title was empty",
} as const satisfies Record<DocAgentRefusalCode, string>

const WRITTEN_DOC = /^(?:Applied to|Retitled|Created) doc (stream_\w+)(?: ("(?:[^"\\]|\\.)*"))?/

/** The header of every output that reports a written doc; `WRITTEN_DOC` reads the effect back from it. */
function writtenDoc(verb: "Applied to" | "Retitled" | "Created", docId: string, title: string | null): string {
  return `${verb} doc ${docId}${title ? ` ${JSON.stringify(title)}` : ""}`
}

function refusalCause(result: DocAgentAccessRefusal): string {
  if (result.status === "not_found") return "it is not one of this stream's docs"
  return result.detail ? `the server refused it (${result.detail})` : REFUSAL_CAUSE[result.code]
}

function formatAccessRefusal(result: DocAgentAccessRefusal): string {
  if (result.status === "not_found") return NOT_FOUND
  return `Refused (${result.code}): ${refusalCause(result)}. Nothing was written.`
}

function formatEditRefusal(refusal: DocAgentEditRefusal): string {
  const which = refusal.editIndex === undefined ? "" : ` at edits[${refusal.editIndex}]`
  const scope = refusal.scope.blockId ? `block ${refusal.scope.blockId}` : "the doc"
  return `Refused (${refusal.reason}${which}): ${EDIT_REFUSAL_CAUSE[refusal.reason]}. Nothing was written. Current text of ${scope}:\n\n${refusal.scope.markdown}`
}

function formatWrite(result: DocAgentWriteResult): string {
  switch (result.status) {
    case "applied": {
      const header = `${writtenDoc("Applied to", result.docId, result.title)} (seq ${result.seq}).`
      return result.markdown ? `${header} Changed blocks:\n\n${result.markdown}` : header
    }
    case "unchanged":
      return `Nothing changed: doc ${result.docId} already reads that way (seq ${result.seq}).`
    case "edit_refused":
      return formatEditRefusal(result.refusal)
    case "invalid":
      return "Refused: the result would not be a valid doc. Nothing was written."
    default:
      return formatAccessRefusal(result)
  }
}

function formatTitle(result: DocAgentTitleResult): string {
  if (result.status === "applied") return `${writtenDoc("Retitled", result.docId, result.title)}.`
  return formatAccessRefusal(result)
}

function failureCause(failure: DocAgentRewriteFailure): string {
  switch (failure.status) {
    case "edit_refused":
      return EDIT_REFUSAL_CAUSE[failure.refusal.reason]
    case "invalid":
      return "the result would not be a valid doc"
    case "error":
      return "saving it failed"
    default:
      return refusalCause(failure)
  }
}

function formatCreate(result: DocAgentCreateResult): string {
  if (result.status !== "created") return formatAccessRefusal(result)
  const header = writtenDoc("Created", result.docId, result.title)
  const failures = [
    ...(result.titleFailure ? [`the title was not set: ${failureCause(result.titleFailure)}.`] : []),
    ...(result.body ? [`the body was not applied: ${failureCause(result.body)}.`] : []),
  ]
  if (failures.length > 0) return `${header} (seq ${result.seq}), but ${failures.join(" Also, ")}`
  return result.markdown
    ? `${header} (seq ${result.seq}):\n\n${result.markdown}`
    : `${header} (seq ${result.seq}). It is empty.`
}

function docEffects(result: AgentToolResult): AgentToolEffect[] {
  const match = WRITTEN_DOC.exec(result.output)
  if (!match) return []
  const label = match[2] === undefined ? undefined : (JSON.parse(match[2]) as string)
  return [{ kind: "doc", target: match[1], ...(label ? { label } : {}) }]
}

/** One write tool: catches its own failures so the model gets text, and declares a `doc` effect only on a write. */
function defineDocWriteTool<TSchema extends z.ZodType<Record<string, unknown> & { reason?: string }>>(config: {
  name: AgentToolName
  description: string
  inputSchema: TSchema
  run: (input: z.infer<TSchema>) => Promise<string>
}) {
  return defineAgentTool({
    name: config.name,
    categories: TOOL_CATEGORIES_BY_NAME[config.name],
    description: config.description,
    inputSchema: config.inputSchema,
    execute: async (input): Promise<AgentToolResult> => {
      try {
        return { output: await config.run(input) }
      } catch (error) {
        logger.error({ error }, `${config.name} failed`)
        return { output: `Failed to ${config.name.replaceAll("_", " ")}. Nothing was written.` }
      }
    },
    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) => JSON.stringify({ tool: config.name, reason: input.reason }),
      effects: (_input, result) => docEffects(result),
    },
  })
}

export function createReadDocTool(deps: DocToolDeps) {
  return defineAgentTool({
    name: AgentToolNames.READ_DOC,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.READ_DOC],
    description:
      "List this stream's docs (no docId), or read one as markdown with a `<!-- blk_… -->` marker before each block. Read before editing.",
    inputSchema: ReadDocSchema,
    promptBlock: PROMPT_BLOCK,
    execute: async (input): Promise<AgentToolResult> => {
      try {
        if (!input.docId) {
          const docs = await deps.listDocs()
          if (docs.length === 0) return { output: "This stream hosts no docs." }
          return {
            output: `Docs on this stream:\n${docs.map((doc) => `- ${doc.docId}: ${doc.title ?? UNTITLED_DOC_LABEL}`).join("\n")}`,
          }
        }
        const result = await deps.readDoc({ docId: input.docId })
        if (result.status === "not_found") return { output: NOT_FOUND }
        return {
          output: `Doc ${result.docId} "${result.title ?? UNTITLED_DOC_LABEL}" (seq ${result.seq}):\n\n${result.markdown}`,
        }
      } catch (error) {
        logger.error({ error }, "read_doc failed")
        return { output: "Failed to read the doc." }
      }
    },
    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input) => JSON.stringify({ tool: AgentToolNames.READ_DOC, docId: input.docId }),
    },
  })
}

export function createEditDocTool(deps: DocToolDeps) {
  return defineDocWriteTool({
    name: AgentToolNames.EDIT_DOC,
    description:
      "Replace exact text inside a doc's blocks. Each edit's `old` must match the current text of one block exactly (copy it from read_doc); any failed edit aborts the whole call.",
    inputSchema: EditDocSchema,
    run: async (input) => formatWrite(await deps.editDoc(input)),
  })
}

export function createInsertBlockTool(deps: DocToolDeps) {
  return defineDocWriteTool({
    name: AgentToolNames.INSERT_BLOCK,
    description:
      'Insert new markdown as one or more blocks after a block (by blockId) or at "start". For changing existing text use edit_doc instead.',
    inputSchema: InsertBlockSchema,
    run: async (input) => formatWrite(await deps.insertBlock(input)),
  })
}

export function createMoveBlockTool(deps: DocToolDeps) {
  return defineDocWriteTool({
    name: AgentToolNames.MOVE_BLOCK,
    description: 'Move a block to just after another block (by blockId) or to "start".',
    inputSchema: MoveBlockSchema,
    run: async (input) => formatWrite(await deps.moveBlock(input)),
  })
}

export function createDeleteBlockTool(deps: DocToolDeps) {
  return defineDocWriteTool({
    name: AgentToolNames.DELETE_BLOCK,
    description: "Delete one block from a doc by blockId.",
    inputSchema: DeleteBlockSchema,
    run: async (input) => formatWrite(await deps.deleteBlock(input)),
  })
}

export function createSetDocTitleTool(deps: DocToolDeps) {
  return defineDocWriteTool({
    name: AgentToolNames.SET_DOC_TITLE,
    description: "Rename a doc on this stream.",
    inputSchema: SetDocTitleSchema,
    run: async (input) => formatTitle(await deps.setTitle(input)),
  })
}

export function createCreateDocTool(deps: DocToolDeps) {
  return defineDocWriteTool({
    name: AgentToolNames.CREATE_DOC,
    description:
      "Create a new doc on this stream, optionally with a title and an initial markdown body. Check read_doc's list first: edit an existing doc rather than creating a near-duplicate.",
    inputSchema: CreateDocSchema,
    run: async (input) => formatCreate(await deps.createDoc(input)),
  })
}
