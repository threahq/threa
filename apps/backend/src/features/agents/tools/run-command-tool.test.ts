import { describe, expect, test } from "bun:test"
import type { AttachmentService } from "../../attachments"
import type { SandboxFile } from "../../sandboxes"
import { createRunCommandTool } from "./run-command-tool"
import type { RunCommandToolDeps, WorkspaceToolDeps } from "./tool-deps"

const toolOpts = { toolCallId: "test" }

const attachment = {
  id: "attach_1",
  filename: "../../etc/Q3 report?.csv",
  storagePath: "uploads/q3.csv",
  sizeBytes: 8,
  e2eOnly: false,
}

function setup(getAccessible: AttachmentService["getAccessible"]) {
  const sent: SandboxFile[][] = []
  const workspace = {
    workspaceId: "ws_1",
    accessibleStreamIds: ["stream_1"],
    storage: { getObject: async () => Buffer.from("a,b\n1,2\n") },
    attachmentService: { getAccessible },
  } as unknown as WorkspaceToolDeps
  const deps: RunCommandToolDeps = {
    run: async ({ files }) => {
      sent.push(files)
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, replaced: null, internet: false }
    },
  }
  return { tool: createRunCommandTool(workspace, deps), sent }
}

describe("run_command attachments", () => {
  test("copies an accessible attachment under its id with a path-safe filename", async () => {
    const { tool, sent } = setup(async () => attachment as never)

    const result = await tool.config.execute({ command: "wc -l", attachmentIds: ["attach_1"] }, toolOpts)

    expect({
      files: sent[0].map((f) => ({ path: f.path, text: new TextDecoder().decode(f.data) })),
      reported: JSON.parse(result.output).files,
    }).toEqual({
      files: [{ path: "/work/attachments/attach_1/Q3 report_.csv", text: "a,b\n1,2\n" }],
      reported: ["/work/attachments/attach_1/Q3 report_.csv"],
    })
  })

  test("refuses an inaccessible attachment without running", async () => {
    const { tool, sent } = setup(async () => null)

    const result = await tool.config.execute({ command: "ls", attachmentIds: ["attach_x"] }, toolOpts)

    expect({ output: JSON.parse(result.output), runs: sent.length }).toEqual({
      output: { error: "Attachment not found or not accessible", attachmentId: "attach_x" },
      runs: 0,
    })
  })

  test("refuses a sealed attachment without running", async () => {
    const { tool, sent } = setup(async () => ({ ...attachment, e2eOnly: true }) as never)

    const result = await tool.config.execute({ command: "ls", attachmentIds: ["attach_1"] }, toolOpts)

    expect({ error: JSON.parse(result.output).error, runs: sent.length }).toEqual({
      error: "Attachment not found or not accessible",
      runs: 0,
    })
  })

  test("refuses attachments over the per-call size limit before reading any", async () => {
    const { tool, sent } = setup(async () => ({ ...attachment, sizeBytes: 30 * 1024 * 1024 }) as never)

    const result = await tool.config.execute({ command: "ls", attachmentIds: ["attach_1", "attach_2"] }, toolOpts)

    expect({ error: JSON.parse(result.output).error.startsWith("Attachments total"), runs: sent.length }).toEqual({
      error: true,
      runs: 0,
    })
  })

  test("a multi-line command shows its first line in the headline and the whole script in a section", async () => {
    const { tool } = setup(async () => null)
    const input = { command: "python3 - <<'PY'\nprint(1)\nPY" }
    const result = await tool.config.execute(input, toolOpts)

    const trace = JSON.parse(tool.config.trace.formatContent(input, result))

    expect({ headline: trace.headline, sections: trace.sections.map((s: { label: string }) => s.label) }).toEqual({
      headline: "$ python3 - <<'PY' … · exit 0",
      sections: ["Arguments"],
    })
  })
})
