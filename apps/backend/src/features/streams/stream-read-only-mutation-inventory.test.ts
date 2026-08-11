import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8")

function methodBody(text: string, name: string): string {
  const match = new RegExp(`async\\s+${name}\\s*\\(`).exec(text)
  if (!match) throw new Error(`Missing owned method ${name}`)
  const nextMethod = text.indexOf("\n  async ", match.index + match[0].length)
  return text.slice(match.index, nextMethod < 0 ? text.length : nextMethod)
}

describe("stream read-only mutation source shape", () => {
  test("source shape only: each owned mutation body mentions its authority helper (behavior is covered in tests/integration/stream-read-only-mutation-matrix.test.ts)", () => {
    const guarded = [
      [
        "../conversations/service.ts",
        {
          reassignMessage: "assertStreamsWritable",
          settleMessage: "assertStreamWritable",
          regenerateTitle: "assertStreamWritable",
          updateConversation: "assertStreamWritable",
          splitThreadIntoConversation: "assertStreamsWritable",
          reassignMessagesToConversation: "assertStreamWritable",
          applySplit: "assertStreamWritable",
        },
      ],
      [
        "service.ts",
        {
          createThread: "assertStreamWritable",
          updateCompanionMode: "assertStreamWritable",
          setStreamToolPolicy: "assertStreamWritable",
          updateStream: "assertStreamWritable",
          regenerateDisplayName: "assertStreamWritable",
        },
      ],
      [
        "../scheduled-messages/service.ts",
        { schedule: "assertStreamWritable", update: "assertStreamWritable", sendNow: "assertStreamWritable" },
      ],
      ["../commands/handlers.ts", { dispatch: "assertViewerStreamWritable" }],
      ["../calls/service.ts", { startCall: "assertStreamWritable", joinCall: "assertStreamWritable" }],
      ["brief-service.ts", { updateInTransaction: "assertStreamWritable" }],
    ] as const

    for (const [path, methods] of guarded) {
      const text = source(path)
      for (const [method, guard] of Object.entries(methods)) expect(methodBody(text, method)).toContain(guard)
    }
  })
})
