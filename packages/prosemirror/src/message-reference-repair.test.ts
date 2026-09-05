import { describe, expect, it, mock } from "bun:test"
import { repairMessageReferences, type ResolvedMessageReference } from "./message-reference-repair"

const MESSAGE = "msg_01JABCDEFGHJKMNPQRSTVWXYZ0"
const OTHER = "msg_01JABCDEFGHJKMNPQRSTVWXYZ1"
const STREAM = "stream_accessible"

function resolver(entries: ResolvedMessageReference[]) {
  return mock(
    async (_workspaceId: string, ids: string[]) =>
      new Map(entries.filter((entry) => ids.includes(entry.messageId)).map((entry) => [entry.messageId, entry]))
  )
}

describe("repairMessageReferences", () => {
  it("repairs bare and message-scheme references in one deduplicated lookup", async () => {
    const resolve = resolver([{ messageId: MESSAGE, streamId: STREAM }])
    const markdown = `${MESSAGE} and [the decision](message:${MESSAGE}) and ${MESSAGE}`

    expect(await repairMessageReferences(markdown, "ws_1", resolve)).toBe(
      `[${MESSAGE}](shared-message:${STREAM}/${MESSAGE}) and [the decision](shared-message:${STREAM}/${MESSAGE}) and [${MESSAGE}](shared-message:${STREAM}/${MESSAGE})`
    )
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]).toEqual(["ws_1", [MESSAGE]])
  })

  it("validates supplied streams and leaves missing references literal", async () => {
    const resolve = resolver([{ messageId: MESSAGE, streamId: STREAM }])
    const markdown = `[wrong](message:stream_other/${MESSAGE}) [missing](message:${OTHER})`
    expect(await repairMessageReferences(markdown, "ws_1", resolve)).toBe(markdown)
  })

  it("preserves code, URLs, existing links, substrings, marks, and reruns", async () => {
    const resolve = resolver([{ messageId: MESSAGE, streamId: STREAM }])
    const markdown = `**${MESSAGE}** \`${MESSAGE}\` \`\`${MESSAGE}\`\` [kept](https://example.com/${MESSAGE}) [escaped\\] label ${MESSAGE}](https://example.com) x${MESSAGE}\n\n\`\`\`txt\n${MESSAGE}\n\`\`\``
    const repaired = await repairMessageReferences(markdown, "ws_1", resolve)
    expect(repaired).toBe(
      `**[${MESSAGE}](shared-message:${STREAM}/${MESSAGE})** \`${MESSAGE}\` \`\`${MESSAGE}\`\` [kept](https://example.com/${MESSAGE}) [escaped\\] label ${MESSAGE}](https://example.com) x${MESSAGE}\n\n\`\`\`txt\n${MESSAGE}\n\`\`\``
    )
    expect(await repairMessageReferences(repaired, "ws_1", resolve)).toBe(repaired)
  })

  it("supports both stream-qualified message link separators and preserves escaped labels", async () => {
    const resolve = resolver([{ messageId: MESSAGE, streamId: STREAM }])
    const markdown = `[slash](message:${STREAM}/${MESSAGE}) [colon\\] label](message:${STREAM}:${MESSAGE})`
    expect(await repairMessageReferences(markdown, "ws_1", resolve)).toBe(
      `[slash](shared-message:${STREAM}/${MESSAGE}) [colon\\] label](shared-message:${STREAM}/${MESSAGE})`
    )
  })

  it("skips tilde, indented, nested, and longer fenced code", async () => {
    const resolve = resolver([{ messageId: MESSAGE, streamId: STREAM }])
    const markdown = [
      "~~~ts",
      MESSAGE,
      "~~~",
      `    ${MESSAGE}`,
      "> - ````md",
      `>   [code](message:${MESSAGE}) ${MESSAGE}`,
      ">   ````",
      MESSAGE,
    ].join("\n")

    expect(await repairMessageReferences(markdown, "ws_1", resolve)).toBe(
      markdown.slice(0, markdown.lastIndexOf(MESSAGE)) + `[${MESSAGE}](shared-message:${STREAM}/${MESSAGE})`
    )
  })

  it("skips reference links, definitions, images, autolinks, and URL literals", async () => {
    const resolve = resolver([{ messageId: MESSAGE, streamId: STREAM }])
    const markdown = [
      `[${MESSAGE}][source]`,
      `[source]: https://example.com/${MESSAGE} "${MESSAGE}"`,
      `![${MESSAGE}](https://example.com/raw-${MESSAGE}.png "${MESSAGE}")`,
      `<https://example.com?q=${MESSAGE}>`,
      `https://example.com?q=${MESSAGE}`,
      `<span data-id="${MESSAGE}">${MESSAGE}</span>`,
    ].join("\n\n")

    expect(await repairMessageReferences(markdown, "ws_1", resolve)).toBe(markdown)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("preserves inline link labels, escapes, angle destinations, and titles byte for byte", async () => {
    const resolve = resolver([{ messageId: MESSAGE, streamId: STREAM }])
    const markdown = `[escaped\\] **label**]( <message:${MESSAGE}> "a title" )`
    expect(await repairMessageReferences(markdown, "ws_1", resolve)).toBe(
      `[escaped\\] **label**]( <shared-message:${STREAM}/${MESSAGE}> "a title" )`
    )
  })

  it("uses decoded text boundaries while applying edits to raw source offsets", async () => {
    const resolve = resolver([{ messageId: MESSAGE, streamId: STREAM }])
    const markdown = `é${MESSAGE} &eacute;${MESSAGE} \\* ${MESSAGE} &amp; ${MESSAGE}`
    expect(await repairMessageReferences(markdown, "ws_1", resolve)).toBe(
      `é${MESSAGE} &eacute;${MESSAGE} \\* [${MESSAGE}](shared-message:${STREAM}/${MESSAGE}) &amp; [${MESSAGE}](shared-message:${STREAM}/${MESSAGE})`
    )
  })

  it("repairs the reported message id only in prose", async () => {
    const reproduced = "msg_01M1S8X2TV8W001X8Q6Z3BMNGV"
    const resolve = resolver([{ messageId: reproduced, streamId: STREAM }])
    const markdown = `See ${reproduced}\n\n~~~ts\n${reproduced}\n~~~\n\nhttps://example.com?q=${reproduced}`
    expect(await repairMessageReferences(markdown, "ws_1", resolve)).toBe(
      `See [${reproduced}](shared-message:${STREAM}/${reproduced})\n\n~~~ts\n${reproduced}\n~~~\n\nhttps://example.com?q=${reproduced}`
    )
  })

  it("does not look up content without candidates", async () => {
    const resolve = resolver([])
    const markdown = "Nothing to repair."
    expect(await repairMessageReferences(markdown, "ws_1", resolve)).toBe(markdown)
    expect(resolve).not.toHaveBeenCalled()
  })
})
