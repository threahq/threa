import { z } from "zod"
import {
  AgentStepTypes,
  AgentToolNames,
  PI_TOOL_TRACE_FORMAT,
  PiToolTraceSectionLabels,
  TOOL_CATEGORIES_BY_NAME,
  ToolPrivacyCategories,
  isToolCategoryAllowed,
  type ToolPrivacyPolicy,
} from "@threahq/types"
import { logger } from "../../../lib/logger"
import {
  SANDBOX_DEFAULT_TIMEOUT_SEC,
  SANDBOX_MAX_TIMEOUT_SEC,
  SANDBOX_TOKEN_GRACE_SEC,
  SandboxReplacedReasons,
  type SandboxService,
  type SandboxSessionTokenService,
  type SandboxFile,
  type SandboxReplacedReason,
} from "../../sandboxes"
import type { WorkspaceSettingsService } from "../../workspace-settings"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { RunCommandToolDeps, WorkspaceToolDeps } from "./tool-deps"

const MAX_ATTACHMENTS_PER_CALL = 10
/** Copies are buffered in backend memory on the way into the box. */
const MAX_ATTACHMENT_BYTES_PER_CALL = 50 * 1024 * 1024
const TRACE_SECTION_MAX_CHARS = 8000
const HEADLINE_PART_MAX_CHARS = 200

const RunCommandSchema = z.object({
  command: z.string().min(1).describe("Shell command, run with `sh -c` in /work"),
  attachmentIds: z
    .array(z.string())
    .max(MAX_ATTACHMENTS_PER_CALL)
    .optional()
    .describe("Attachments to copy in first, each to /work/attachments/<attachmentId>/<filename>"),
  timeoutSec: z
    .number()
    .int()
    .min(1)
    .max(SANDBOX_MAX_TIMEOUT_SEC)
    .optional()
    .describe(`Seconds before the command is killed. Default ${SANDBOX_DEFAULT_TIMEOUT_SEC}.`),
})

const REPLACED_NOTICES: Record<SandboxReplacedReason, string> = {
  [SandboxReplacedReasons.EXPIRED]: "New sandbox: the previous one expired and its files are gone",
  [SandboxReplacedReasons.NETWORK_CHANGED]:
    "New sandbox: its internet access changed (the workspace setting or this conversation's web permission), and the previous sandbox's files are gone",
}

function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ""
  const cleaned = base.replace(/[^\w.\- ]/g, "_").replace(/^\.+/, "")
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file"
}

function clip(text: string, max = TRACE_SECTION_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text
}

export interface StreamSandboxDeps {
  service: SandboxService
  workspaceSettings: Pick<WorkspaceSettingsService, "getSettings">
  sessionTokens: Pick<SandboxSessionTokenService, "mint" | "revoke">
}

/**
 * Binds `run_command` to one stream's sandbox, or withholds it on a sealed
 * stream, whose plaintext and files must not reach a server-side box. Internet
 * needs the workspace setting AND the stream policy's `web` grant; the setting
 * is read per call so an admin's toggle applies to the next command.
 *
 * Each command gets its own API token, reading what this turn could read
 * (`capturedStreamIds`) as the invoking user, revoked once the command ends.
 * A turn with no invoking user has nobody to read as, so its commands get none.
 */
export function bindStreamSandbox(
  sandbox: StreamSandboxDeps,
  target: {
    workspaceId: string
    streamId: string
    sealed: boolean
    streamToolPolicy: ToolPrivacyPolicy
    personaId: string
    sessionId: string
    invokingUserId: string | null
    capturedStreamIds: string[]
  }
): RunCommandToolDeps | undefined {
  const { workspaceId, streamId, sealed, streamToolPolicy, invokingUserId } = target
  if (sealed) return undefined
  return {
    threaApi: invokingUserId !== null,
    internet: async () => {
      const settings = await sandbox.workspaceSettings.getSettings(workspaceId)
      return settings.sandboxInternet && isToolCategoryAllowed(streamToolPolicy, ToolPrivacyCategories.WEB)
    },
    run: async (params) => {
      if (!invokingUserId) return sandbox.service.run({ workspaceId, streamId, ...params })
      const { session, value } = await sandbox.sessionTokens.mint({
        workspaceId,
        invokingUserId,
        personaId: target.personaId,
        sessionId: target.sessionId,
        streamId,
        capturedStreamIds: target.capturedStreamIds,
        ttlSec: params.timeoutSec + SANDBOX_TOKEN_GRACE_SEC,
      })
      try {
        return await sandbox.service.run({ workspaceId, streamId, ...params, api: { token: value, workspaceId } })
      } finally {
        await sandbox.sessionTokens.revoke(workspaceId, session.id).catch((err) => {
          logger.warn({ err, workspaceId, tokenId: session.id }, "Sandbox token not revoked; it expires with its TTL")
        })
      }
    },
  }
}

/**
 * A shell in a Linux box bound to this stream. Files persist between calls
 * until the box is replaced; a replacement is reported to the model and shown
 * on the trace step, because work the user saw earlier is gone.
 */
export function createRunCommandTool(workspace: WorkspaceToolDeps, deps: RunCommandToolDeps) {
  const { workspaceId, accessibleStreamIds, attachmentService, storage } = workspace

  return defineAgentTool({
    name: "run_command",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.RUN_COMMAND],
    promptBlock: `## Sandbox

You have a \`run_command\` tool: a shell in a Linux box that belongs to this conversation, with python3, node, curl and jq. Use it to calculate, transform data, or inspect files rather than doing it in your head.

- Pass \`attachmentIds\` to copy workspace files in; each lands at /work/attachments/<attachmentId>/<filename>.
- Files you write persist between calls until the sandbox is replaced. When the result says it was replaced, tell the user that earlier files are gone. Attachments are still in the workspace: pass their ids again rather than asking the user to re-upload.
- The result says whether the sandbox has internet. When it does not, don't try to install packages or fetch URLs.${
      deps.threaApi
        ? `
- Commands can use the \`threa\` CLI to read this workspace as you can in this turn: streams, messages, search, attachments (\`threa --help\`).
- To hand the user a file you made, \`threa attachments upload <path>\` prints its id; link it in your reply as [filename](attachment:<id>). Nothing is posted for you.`
        : ""
    }`,
    description:
      "Run a shell command in this conversation's sandbox. Returns stdout, stderr and the exit code; optionally copies workspace attachments in first.",
    inputSchema: RunCommandSchema,

    execute: async (input, { signal }): Promise<AgentToolResult> => {
      let internet = false
      try {
        const attachments = []
        for (const attachmentId of input.attachmentIds ?? []) {
          const attachment = await attachmentService.getAccessible(attachmentId, { workspaceId, accessibleStreamIds })
          if (!attachment || attachment.e2eOnly) {
            return { output: JSON.stringify({ error: "Attachment not found or not accessible", attachmentId }) }
          }
          attachments.push(attachment)
        }
        const totalBytes = attachments.reduce((sum, a) => sum + a.sizeBytes, 0)
        if (totalBytes > MAX_ATTACHMENT_BYTES_PER_CALL) {
          return {
            output: JSON.stringify({
              error: `Attachments total ${totalBytes} bytes; one call can copy at most ${MAX_ATTACHMENT_BYTES_PER_CALL}. Copy fewer per call; earlier copies stay in the sandbox.`,
            }),
          }
        }

        const files: SandboxFile[] = []
        for (const attachment of attachments) {
          signal?.throwIfAborted()
          files.push({
            path: `/work/attachments/${attachment.id}/${safeFilename(attachment.filename)}`,
            data: await storage.getObject(attachment.storagePath),
          })
        }
        signal?.throwIfAborted()

        internet = await deps.internet()
        const result = await deps.run({
          internet,
          command: input.command,
          files,
          timeoutSec: input.timeoutSec ?? SANDBOX_DEFAULT_TIMEOUT_SEC,
          signal,
        })

        return {
          output: JSON.stringify({
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            ...(result.timedOut && { timedOut: true }),
            ...(result.truncated && { truncated: true }),
            internet,
            ...(result.replaced && { sandboxReplaced: REPLACED_NOTICES[result.replaced] }),
            ...(files.length > 0 && { files: files.map((f) => f.path) }),
          }),
        }
      } catch (error) {
        if (signal?.aborted) throw error
        logger.error({ error, workspaceId }, "run_command failed")
        return {
          output: JSON.stringify({
            error: `Sandbox failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            // The command may have started before the failure.
            ...(internet && { internet: true }),
          }),
        }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input, result) => {
        const parsed = JSON.parse(result.output) as {
          exitCode?: number
          stdout?: string
          stderr?: string
          timedOut?: boolean
          sandboxReplaced?: string
          error?: string
        }
        const exitStatus = parsed.timedOut ? "timed out" : `exit ${parsed.exitCode}`
        const status = parsed.error ? clip(parsed.error, HEADLINE_PART_MAX_CHARS) : exitStatus
        const [firstLine, ...moreLines] = input.command.split("\n")
        const commandLine = clip(moreLines.length > 0 ? `${firstLine} …` : firstLine, HEADLINE_PART_MAX_CHARS)
        const headline = [`$ ${commandLine}`, status, parsed.sandboxReplaced].filter(Boolean).join(" · ")
        const sections = [
          moreLines.length > 0 && { label: PiToolTraceSectionLabels.ARGUMENTS, body: clip(input.command), lang: null },
          parsed.stdout && { label: PiToolTraceSectionLabels.OUTPUT, body: clip(parsed.stdout), lang: null },
          parsed.stderr && { label: PiToolTraceSectionLabels.ERROR_OUTPUT, body: clip(parsed.stderr), lang: null },
        ].filter(Boolean)
        return JSON.stringify({ format: PI_TOOL_TRACE_FORMAT, headline, sections })
      },
      // Only a box with internet can have written anywhere the user would have to go look.
      effects: (_input, result) => {
        const parsed = JSON.parse(result.output) as { internet?: boolean }
        return parsed.internet ? [{ kind: "other" }] : []
      },
    },
  })
}
