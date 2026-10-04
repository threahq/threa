import { describe, expect, spyOn, test } from "bun:test"
import type { AttachmentService } from "../../attachments"
import * as streams from "../../streams"
import type { SandboxFile, SandboxService } from "../../sandboxes"
import { bindStreamSandbox, createRunCommandTool } from "./run-command-tool"
import type { RunCommandToolDeps, WorkspaceToolDeps } from "./tool-deps"

const toolOpts = { toolCallId: "test" }

const attachment = {
  id: "attach_1",
  filename: "../../etc/Q3 report?.csv",
  storagePath: "uploads/q3.csv",
  sizeBytes: 8,
  e2eOnly: false,
}

function setup(
  getAccessibleVia: AttachmentService["getAccessibleVia"],
  run?: RunCommandToolDeps["run"],
  threaApi = false
) {
  const sent: Parameters<RunCommandToolDeps["run"]>[0][] = []
  const workspace = {
    workspaceId: "ws_1",
    accessibleStreamIds: ["stream_1"],
    storage: { getObject: async () => Buffer.from("a,b\n1,2\n") },
    attachmentService: { getAccessibleVia },
  } as unknown as WorkspaceToolDeps
  const deps: RunCommandToolDeps = {
    threaApi,
    internet: async () => run !== undefined,
    run:
      run ??
      (async (params) => {
        sent.push(params)
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          replaced: null,
          contentStreamIds: [],
        }
      }),
  }
  return { tool: createRunCommandTool(workspace, deps), sent }
}

describe("run_command attachments", () => {
  test("copies an accessible attachment under its id with a path-safe filename, tainted by its stream", async () => {
    const { tool, sent } = setup(async () => ({ attachment, viaStreamIds: ["stream_1"] }) as never)

    const result = await tool.config.execute({ command: "wc -l", attachmentIds: ["attach_1"] }, toolOpts)

    expect({
      files: sent[0].files.map((f: SandboxFile) => ({ path: f.path, text: new TextDecoder().decode(f.data) })),
      contentStreamIds: sent[0].contentStreamIds,
      readableStreamIds: sent[0].readableStreamIds,
      reported: JSON.parse(result.output).files,
    }).toEqual({
      files: [{ path: "/work/attachments/attach_1/Q3 report_.csv", text: "a,b\n1,2\n" }],
      contentStreamIds: ["stream_1"],
      readableStreamIds: ["stream_1"],
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
    const { tool, sent } = setup(
      async () => ({ attachment: { ...attachment, e2eOnly: true }, viaStreamIds: ["stream_1"] }) as never
    )

    const result = await tool.config.execute({ command: "ls", attachmentIds: ["attach_1"] }, toolOpts)

    expect({ error: JSON.parse(result.output).error, runs: sent.length }).toEqual({
      error: "Attachment not found or not accessible",
      runs: 0,
    })
  })

  test("refuses attachments over the per-call size limit before reading any", async () => {
    const { tool, sent } = setup(
      async () => ({ attachment: { ...attachment, sizeBytes: 30 * 1024 * 1024 }, viaStreamIds: ["stream_1"] }) as never
    )

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

describe("bindStreamSandbox", () => {
  const ok = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    replaced: null,
    contentStreamIds: [],
  }

  function bind(params: {
    sealed: boolean
    sandboxInternet?: boolean
    streamToolPolicy?: ("web" | "workspace")[] | null
    invokingUserId?: string | null
    run?: SandboxService["run"]
    revokeError?: Error
  }) {
    const calls: string[] = []
    const deps = bindStreamSandbox(
      {
        service: {
          run: async (p: Parameters<SandboxService["run"]>[0]) => {
            calls.push("run")
            return (params.run ?? (async () => ok))(p)
          },
        } as SandboxService,
        workspaceSettings: { getSettings: async () => ({ sandboxInternet: params.sandboxInternet ?? false }) as never },
        sessionTokens: {
          mint: async (p) => {
            calls.push(`mint ttl=${p.ttlSec} captured=${p.capturedStreamIds.join(",")}`)
            return { session: { id: "sbx_1" } as never, value: "threa_sk_1" }
          },
          revoke: async (_ws, id) => {
            calls.push(`revoke ${id}`)
            if (params.revokeError) throw params.revokeError
            return ["stream_3"]
          },
        },
      },
      {
        workspaceId: "ws_1",
        streamId: "stream_1",
        sealed: params.sealed,
        streamToolPolicy: params.streamToolPolicy ?? null,
        personaId: "persona_1",
        sessionId: "session_1",
        invokingUserId: params.invokingUserId === undefined ? "usr_1" : params.invokingUserId,
        capturedStreamIds: ["stream_1", "stream_2"],
      }
    )
    return { deps, calls }
  }

  const params = {
    internet: false,
    readableStreamIds: ["stream_1"],
    command: "true",
    files: [],
    contentStreamIds: [],
    timeoutSec: 60,
  }

  test("withholds the sandbox on a sealed stream", () => {
    expect(bind({ sealed: true, sandboxInternet: true, streamToolPolicy: null }).deps).toBeUndefined()
  })

  test("gives the box internet only when the workspace allows it and the stream grants web", async () => {
    const cases = [
      { sandboxInternet: true, streamToolPolicy: null },
      { sandboxInternet: true, streamToolPolicy: ["workspace" as const] },
      { sandboxInternet: false, streamToolPolicy: null },
    ]
    const internet = []
    for (const c of cases) {
      const { deps } = bind({ sealed: false, ...c })
      internet.push(await deps!.internet())
    }

    expect(internet).toEqual([true, false, false])
  })

  test("mints a token when the command starts and revokes it when the command fails", async () => {
    const apis: unknown[] = []
    const { deps, calls } = bind({
      sealed: false,
      run: async (p) => {
        apis.push(await p.api!())
        throw new Error("command failed")
      },
    })

    await expect(deps!.run(params)).rejects.toThrow("command failed")
    expect({ calls, apis }).toEqual({
      calls: ["run", "mint ttl=90 captured=stream_1,stream_2", "revoke sbx_1"],
      apis: [{ token: "threa_sk_1", workspaceId: "ws_1" }],
    })
  })

  test("returns the output when everything the box holds is readable or the command's own token read it", async () => {
    const { deps, calls } = bind({
      sealed: false,
      run: async (p) => {
        await p.api!()
        return { ...ok, contentStreamIds: ["stream_1", "stream_3"] }
      },
    })

    expect({ result: await deps!.run(params), calls }).toEqual({
      result: { ...ok, contentStreamIds: ["stream_1", "stream_3"] },
      calls: ["run", "mint ttl=90 captured=stream_1,stream_2", "revoke sbx_1"],
    })
  })

  test("withholds the output when the box holds a stream the turn cannot read and the command did not read", async () => {
    const { deps } = bind({
      sealed: false,
      run: async (p) => {
        await p.api!()
        return { ...ok, stdout: "private notes", contentStreamIds: ["stream_3", "stream_9"] }
      },
    })

    await expect(deps!.run(params)).rejects.toThrow("output is withheld")
  })

  test("withholds the output when the reads it was built from cannot be retrieved", async () => {
    const { deps } = bind({
      sealed: false,
      revokeError: new Error("db down"),
      run: async (p) => {
        await p.api!()
        return { ...ok, stdout: "private notes" }
      },
    })

    await expect(deps!.run(params)).rejects.toThrow("db down")
  })

  test("still reports the command's own failure when its revoke also fails", async () => {
    const { deps } = bind({
      sealed: false,
      revokeError: new Error("db down"),
      run: async (p) => {
        await p.api!()
        throw new Error("command failed")
      },
    })

    await expect(deps!.run(params)).rejects.toThrow("command failed")
  })

  test("mints nothing when the run fails before the command starts", async () => {
    const { deps, calls } = bind({
      sealed: false,
      run: async () => {
        throw new Error("box gone")
      },
    })
    await expect(deps!.run(params)).rejects.toThrow("box gone")
    expect(calls).toEqual(["run"])
  })

  test("runs without a token when the turn has no invoking user", async () => {
    const apis: unknown[] = []
    const { deps, calls } = bind({
      sealed: false,
      invokingUserId: null,
      run: async (p) => {
        apis.push(p.api)
        return ok
      },
    })

    await deps!.run(params)
    expect({ threaApi: deps!.threaApi, calls, apis }).toEqual({
      threaApi: false,
      calls: ["run"],
      apis: [undefined],
    })
  })
})

describe("run_command prompt", () => {
  test("teaches the threa CLI only when commands can reach Threa", () => {
    const teaches = (threaApi: boolean) =>
      setup(async () => null, undefined, threaApi).tool.config.promptBlock!.includes("threa attachments upload")

    expect([teaches(true), teaches(false)]).toEqual([true, false])
  })
})

describe("run_command sources", () => {
  test("cites each stream the box's files may hold content from, and nothing when there are none", async () => {
    const ran = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      replaced: null,
      contentStreamIds: [] as string[],
    }
    const named = spyOn(streams.StreamRepository, "findByIds").mockImplementation(async (_db, _ws, ids) =>
      ids.map((id) => ({ id, type: "channel", slug: "design" }) as never)
    )
    const reading = setup(
      async () => null,
      async () => ({ ...ran, contentStreamIds: ["stream_2"] })
    ).tool
    const silent = setup(
      async () => null,
      async () => ran
    ).tool
    const sources = async (tool: typeof reading) =>
      tool.config.trace.extractSources!(
        { command: "threa search x" },
        await tool.config.execute({ command: "threa search x" }, toolOpts)
      )

    expect({ reading: await sources(reading), silent: await sources(silent) }).toEqual({
      reading: [{ type: "workspace", title: "design", url: "/w/ws_1/s/stream_2", streamId: "stream_2" }],
      silent: [],
    })
    named.mockRestore()
  })
})

describe("run_command effects", () => {
  test("a command in a box with internet may have written elsewhere; one without cannot", async () => {
    const { tool } = setup(async () => null)
    const effects = (internet: boolean) =>
      tool.config.trace.effects!({ command: "true" }, { output: JSON.stringify({ exitCode: 0, internet }) })

    expect({ on: effects(true), off: effects(false) }).toEqual({ on: [{ kind: "other" }], off: [] })
  })

  test("a command that fails in a box with internet still may have written elsewhere", async () => {
    const { tool } = setup(
      async () => null,
      async () => {
        throw new Error("exec connection dropped")
      }
    )

    const result = await tool.config.execute({ command: "curl -X POST https://example.com" }, toolOpts)

    expect(tool.config.trace.effects!({ command: "curl" }, result)).toEqual([{ kind: "other" }])
  })
})
