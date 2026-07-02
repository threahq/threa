/**
 * Regression tests for message content round-trip fidelity.
 *
 * These tests ensure that markdown content sent to the API is returned
 * syntactically identical when retrieved. This establishes the contract
 * that must hold before/during/after the ProseMirror storage migration.
 *
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/message-content-regression.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createScratchpad,
  createChannel,
  sendMessage,
  sendMessageWithAttachments,
  uploadAttachment,
  listEvents,
  joinWorkspace,
  joinStream,
  getWorkspaceBootstrap,
  type Workspace,
  type Stream,
  type User,
  type StreamEvent,
} from "../client"

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-${testRunId}@test.com`

interface MessageCreatedPayload {
  messageId: string
  contentJson: unknown
  contentMarkdown: string
  attachments?: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>
}

/**
 * Helper to create a message and retrieve it via events to verify round-trip.
 */
async function createAndRetrieveMessage(
  client: TestClient,
  workspaceId: string,
  streamId: string,
  content: string
): Promise<{ sentContent: string; retrievedContent: string }> {
  // Send message
  const message = await sendMessage(client, workspaceId, streamId, content)

  // Retrieve via events to get what's actually stored
  const events = await listEvents(client, workspaceId, streamId, ["message_created"])
  const messageEvent = events.find((e) => {
    const payload = e.payload as MessageCreatedPayload
    return payload.messageId === message.id
  })

  if (!messageEvent) {
    throw new Error(`Could not find message_created event for message ${message.id}`)
  }

  const payload = messageEvent.payload as MessageCreatedPayload
  return {
    sentContent: content,
    retrievedContent: payload.contentMarkdown,
  }
}

describe("Message Content Regression", () => {
  let client: TestClient
  let workspace: Workspace
  let stream: Stream
  let user: User

  beforeAll(async () => {
    client = new TestClient()
    user = await loginAs(client, testEmail("regression"), "Regression Test")
    workspace = await createWorkspace(client, `Regression WS ${testRunId}`)
    stream = await createScratchpad(client, workspace.id, "off") // Companion off to avoid noise
  })

  describe("Basic Formatting", () => {
    test("preserves plain text", async () => {
      const input = "Hello, world!"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves bold text", async () => {
      const input = "Hello **bold** world"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves italic text with asterisks", async () => {
      const input = "Hello *italic* world"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves italic text with underscores", async () => {
      const input = "Hello _italic_ world"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves strikethrough", async () => {
      const input = "Hello ~~deleted~~ world"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves inline code", async () => {
      const input = "Use `const x = 1` here"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves code blocks", async () => {
      const input = "```typescript\nconst x = 1\n```"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves code blocks with language", async () => {
      const input = "```javascript\nfunction hello() {\n  return 'world'\n}\n```"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves nested formatting", async () => {
      const input = "This is **bold and *italic* text**"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })
  })

  describe("Mentions and References", () => {
    test("preserves an unknown user mention as a bare slug", async () => {
      // No member named @kristoffer exists here, so the slug stays unresolved and
      // serializes back bare (INV-64 lenient-input fallback). A slug that resolves
      // comes back in pointer form instead — see the broadcast cases below.
      const input = "Hey @kristoffer check this"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves channel references", async () => {
      const input = "See #general for details"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("resolves broadcast mentions to the canonical pointer form", async () => {
      // @here/@channel are well-known sentinels that always resolve (INV-64), so
      // unlike an unknown user/channel slug they come back in pointer form.
      const { retrievedContent } = await createAndRetrieveMessage(
        client,
        workspace.id,
        stream.id,
        "@here please review"
      )
      expect(retrievedContent).toBe("[@here](broadcast:here) please review")
    })

    test("resolves @channel broadcast to the canonical pointer form", async () => {
      const { retrievedContent } = await createAndRetrieveMessage(
        client,
        workspace.id,
        stream.id,
        "@channel important announcement"
      )
      expect(retrievedContent).toBe("[@channel](broadcast:channel) important announcement")
    })

    test("preserves multiple mentions", async () => {
      const input = "@alice and @bob please review #engineering"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })
  })

  describe("Links", () => {
    test("preserves markdown links", async () => {
      const input = "Check [this link](https://example.com)"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves bare URLs", async () => {
      const input = "Visit https://example.com for more"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves links with special characters", async () => {
      const input = "See [docs](https://example.com/path?query=foo&bar=baz)"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })
  })

  describe("Lists", () => {
    test("preserves bullet lists", async () => {
      const input = "- Item one\n- Item two\n- Item three"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves ordered lists", async () => {
      const input = "1. First\n2. Second\n3. Third"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves nested lists", async () => {
      const input = "- Parent\n  - Child 1\n  - Child 2\n- Another parent"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves formatted text in lists", async () => {
      const input = "- **Bold item**\n- *Italic item*\n- `Code item`"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })
  })

  describe("Block Elements", () => {
    test("preserves headings", async () => {
      const input = "# Heading 1\n\n## Heading 2\n\n### Heading 3"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves blockquotes", async () => {
      const input = "> Quoted text"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves multi-line blockquotes", async () => {
      const input = "> First line\n> Second line\n> Third line"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves horizontal rules", async () => {
      const input = "Above\n\n---\n\nBelow"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })
  })

  describe("Slash Commands", () => {
    test("preserves slash commands", async () => {
      const input = "/remind me tomorrow"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves slash commands with arguments", async () => {
      const input = "/todo Add unit tests for the new feature"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })
  })

  describe("Emoji", () => {
    test("preserves emoji shortcodes", async () => {
      const input = "Hello :wave: world"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("normalizes unicode emoji to shortcodes", async () => {
      // Backend normalizes unicode emoji to shortcodes for consistent storage
      const input = "Hello 👋 world"
      const expected = "Hello :wave: world"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(expected)
    })

    test("normalizes multiple unicode emoji to shortcodes", async () => {
      // Backend normalizes unicode emoji to shortcodes for consistent storage
      const input = "Great job! 🎉 Keep it up! 💪"
      const expected = "Great job! :tada: Keep it up! :muscle:"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(expected)
    })
  })

  describe("Complex Combinations", () => {
    test("preserves mixed formatting with mentions", async () => {
      const input = "**Important:** @kristoffer please review #engineering"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves code in lists with links", async () => {
      const input = "- Use `npm install` first\n- Check [docs](https://docs.example.com)\n- Run **tests**"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves blockquote with formatting", async () => {
      const input = "> **Note:** This is *important* and uses `code`"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves paragraph breaks", async () => {
      const input = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })
  })

  describe("Edge Cases", () => {
    test("preserves escaped characters", async () => {
      const input = "Use \\*asterisks\\* for emphasis"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves special characters", async () => {
      const input = "Special chars: < > & \" ' / \\"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves whitespace within text", async () => {
      const input = "Text   with   multiple   spaces"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves empty lines between blocks", async () => {
      const input = "# Title\n\nParagraph\n\n- List item"
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })

    test("preserves very long content", async () => {
      const input = "This is a long message. ".repeat(100).trim()
      const { retrievedContent } = await createAndRetrieveMessage(client, workspace.id, stream.id, input)
      expect(retrievedContent).toBe(input)
    })
  })
})

describe("Message Content with Attachments", () => {
  let client: TestClient
  let workspace: Workspace
  let stream: Stream
  let user: User

  beforeAll(async () => {
    client = new TestClient()
    user = await loginAs(client, testEmail("attach-regression"), "Attach Regression Test")
    workspace = await createWorkspace(client, `Attach Regression WS ${testRunId}`)
    stream = await createScratchpad(client, workspace.id, "off")
  })

  test("preserves content with single attachment", async () => {
    const content = "Here is a file for you"
    const attachment = await uploadAttachment(client, workspace.id, {
      content: "File content",
      filename: "test.txt",
      mimeType: "text/plain",
    })

    const message = await sendMessageWithAttachments(client, workspace.id, stream.id, content, [attachment.id])

    const events = await listEvents(client, workspace.id, stream.id, ["message_created"])
    const messageEvent = events.find((e) => {
      const payload = e.payload as MessageCreatedPayload
      return payload.messageId === message.id
    })

    expect(messageEvent).toBeDefined()
    const payload = messageEvent!.payload as MessageCreatedPayload
    expect(payload.contentMarkdown).toBe(content)
    expect(payload.attachments).toHaveLength(1)
    expect(payload.attachments![0].id).toBe(attachment.id)
  })

  test("preserves markdown content with attachment", async () => {
    const content = "**Important file:** See attached `document.txt`"
    const attachment = await uploadAttachment(client, workspace.id, {
      content: "Document content",
      filename: "document.txt",
      mimeType: "text/plain",
    })

    const message = await sendMessageWithAttachments(client, workspace.id, stream.id, content, [attachment.id])

    const events = await listEvents(client, workspace.id, stream.id, ["message_created"])
    const messageEvent = events.find((e) => {
      const payload = e.payload as MessageCreatedPayload
      return payload.messageId === message.id
    })

    expect(messageEvent).toBeDefined()
    const payload = messageEvent!.payload as MessageCreatedPayload
    expect(payload.contentMarkdown).toBe(content)
  })

  test("preserves content with multiple attachments", async () => {
    const content = "Here are multiple files"
    const attach1 = await uploadAttachment(client, workspace.id, {
      content: "File 1",
      filename: "file1.txt",
      mimeType: "text/plain",
    })
    const attach2 = await uploadAttachment(client, workspace.id, {
      content: "File 2",
      filename: "file2.txt",
      mimeType: "text/plain",
    })

    const message = await sendMessageWithAttachments(client, workspace.id, stream.id, content, [attach1.id, attach2.id])

    const events = await listEvents(client, workspace.id, stream.id, ["message_created"])
    const messageEvent = events.find((e) => {
      const payload = e.payload as MessageCreatedPayload
      return payload.messageId === message.id
    })

    expect(messageEvent).toBeDefined()
    const payload = messageEvent!.payload as MessageCreatedPayload
    expect(payload.contentMarkdown).toBe(content)
    expect(payload.attachments).toHaveLength(2)
  })
})
