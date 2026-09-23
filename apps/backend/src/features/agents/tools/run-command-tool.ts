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
  SandboxReplacedReasons,
  type SandboxService,
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
    "New sandbox: the workspace's sandbox internet setting changed, and the previous sandbox's files are gone",
}

function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ""
  const cleaned = base.replace(/[^\w.\- ]/g, "_").replace(/^\.+/, "")
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file"
}

function clip(text: string): string {
  return text.length > TRACE_SECTION_MAX_CHARS ? `${text.slice(0, TRACE_SECTION_MAX_CHARS)}\n…` : text
}

export interface StreamSandboxDeps {
  service: SandboxService
  workspaceSettings: Pick<WorkspaceSettingsService, "getSettings">
}

/**
 * Binds `run_command` to one stream's sandbox. Internet needs the workspace
 * setting AND the stream policy's `web` grant, read per call so an admin's
 * toggle applies to the next command.
 */
export function bindStreamSandbox(
  sandbox: StreamSandboxDeps,
  target: { workspaceId: string; streamId: string; streamToolPolicy: ToolPrivacyPolicy }
): RunCommandToolDeps {
  const { workspaceId, streamId, streamToolPolicy } = target
  return {
    run: async ({ command, files, timeoutSec, signal }) => {
      const settings = await sandbox.workspaceSettings.getSettings(workspaceId)
      const internet = settings.sandboxInternet && isToolCategoryAllowed(streamToolPolicy, ToolPrivacyCategories.WEB)
      const result = await sandbox.service.run({ workspaceId, streamId, internet, command, files, timeoutSec, signal })
      return { ...result, internet }
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

You have a \`run_command\` tool: a shell in a Debian box that belongs to this conversation, with python3, node, curl and jq. Use it to calculate, transform data, or inspect files rather than doing it in your head.

- Pass \`attachmentIds\` to copy workspace files in; each lands at /work/attachments/<attachmentId>/<filename>.
- Files you write persist between calls until the sandbox is replaced. When the result says it was replaced, tell the user that earlier files are gone. Attachments are still in the workspace: pass their ids again rather than asking the user to re-upload.
- The result says whether the sandbox has internet. When it does not, don't try to install packages or fetch URLs.`,
    description:
      "Run a shell command in this conversation's sandbox. Returns stdout, stderr and the exit code; optionally copies workspace attachments in first.",
    inputSchema: RunCommandSchema,

    execute: async (input, { signal }): Promise<AgentToolResult> => {
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
          files.push({
            path: `/work/attachments/${attachment.id}/${safeFilename(attachment.filename)}`,
            data: new Uint8Array(await storage.getObject(attachment.storagePath)),
          })
        }

        const result = await deps.run({
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
            internet: result.internet,
            ...(result.replaced && { sandboxReplaced: REPLACED_NOTICES[result.replaced] }),
            ...(files.length > 0 && { files: files.map((f) => f.path) }),
          }),
        }
      } catch (error) {
        if (signal?.aborted) throw error
        logger.error({ error }, "run_command failed")
        return {
          output: JSON.stringify({
            error: `Sandbox failed: ${error instanceof Error ? error.message : "Unknown error"}`,
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
        const status = parsed.error ?? (parsed.timedOut ? "timed out" : `exit ${parsed.exitCode}`)
        const [firstLine, ...moreLines] = input.command.split("\n")
        const commandLine = moreLines.length > 0 ? `${firstLine} …` : firstLine
        const headline = [`$ ${commandLine}`, status, parsed.sandboxReplaced].filter(Boolean).join(" · ")
        const sections = [
          moreLines.length > 0 && { label: PiToolTraceSectionLabels.ARGUMENTS, body: clip(input.command), lang: null },
          parsed.stdout && { label: PiToolTraceSectionLabels.OUTPUT, body: clip(parsed.stdout), lang: null },
          parsed.stderr && { label: PiToolTraceSectionLabels.ERROR_OUTPUT, body: clip(parsed.stderr), lang: null },
        ].filter(Boolean)
        return JSON.stringify({ format: PI_TOOL_TRACE_FORMAT, headline, sections })
      },
    },
  })
}
