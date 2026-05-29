/**
 * E2E tests for emoji features:
 * - Emoji list endpoint
 * - Emoji data in workspace bootstrap
 * - Message normalization (raw emoji → shortcode)
 * - Emoji usage tracking
 * - Emoji weights for personalized ordering
 */

import { describe, test, expect } from "bun:test"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createScratchpad,
  sendMessage,
  addReaction,
  getEmojis,
  getWorkspaceBootstrap,
  listEvents,
} from "../client"

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-${testRunId}@test.com`

// Emoji usage weights are computed asynchronously by the outbox listener after
// a message/reaction is persisted. Poll the bootstrap until the expected weights
// land instead of sleeping a fixed interval — a fixed `setTimeout` is racy under
// CI load and was the source of intermittent failures (INV-22).
const waitForEmojiWeights = async (
  client: TestClient,
  workspaceId: string,
  predicate: (weights: Record<string, number>) => boolean,
  { timeoutMs = 5000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {}
) => {
  const deadline = Date.now() + timeoutMs
  let bootstrap = await getWorkspaceBootstrap(client, workspaceId)
  while (!predicate(bootstrap.emojiWeights ?? {}) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    bootstrap = await getWorkspaceBootstrap(client, workspaceId)
  }
  return bootstrap
}

describe("Emoji E2E Tests", () => {
  describe("Emoji List", () => {
    test("should return emoji list with correct structure", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("emoji-list"), "Emoji List Test")
      const workspace = await createWorkspace(client, `Emoji List WS ${testRunId}`)

      const emojis = await getEmojis(client, workspace.id)

      expect(emojis.length).toBeGreaterThan(100) // Should have many emojis
      const thumbsUp = emojis.find((e) => e.shortcode === "+1")
      expect(thumbsUp).toBeDefined()
      expect(thumbsUp).toMatchObject({
        shortcode: "+1",
        emoji: "👍",
        type: "native",
        group: expect.any(String),
        order: expect.any(Number),
        aliases: expect.arrayContaining(["+1", "thumbsup"]),
      })
    })

    test("should include aliases for emoji search", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("emoji-aliases"), "Emoji Aliases Test")
      const workspace = await createWorkspace(client, `Emoji Aliases WS ${testRunId}`)

      const emojis = await getEmojis(client, workspace.id)

      // Heart should have multiple aliases
      const heart = emojis.find((e) => e.emoji === "❤️")
      expect(heart).toBeDefined()
      expect(heart!.aliases.length).toBeGreaterThanOrEqual(1)

      // Thumbs up should match on both +1 and thumbsup
      const thumbsUp = emojis.find((e) => e.emoji === "👍")
      expect(thumbsUp).toBeDefined()
      expect(thumbsUp!.aliases).toContain("+1")
      expect(thumbsUp!.aliases).toContain("thumbsup")
    })

    test("should include group and order for sorting", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("emoji-groups"), "Emoji Groups Test")
      const workspace = await createWorkspace(client, `Emoji Groups WS ${testRunId}`)

      const emojis = await getEmojis(client, workspace.id)

      // Check that different groups exist
      const groups = new Set(emojis.map((e) => e.group))
      expect(groups.size).toBeGreaterThan(1)

      // Verify order is a number for all emojis
      for (const emoji of emojis.slice(0, 10)) {
        expect(typeof emoji.order).toBe("number")
      }
    })
  })

  describe("Workspace Bootstrap", () => {
    test("should include emojis in bootstrap", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("bootstrap-emoji"), "Bootstrap Emoji Test")
      const workspace = await createWorkspace(client, `Bootstrap Emoji WS ${testRunId}`)

      const bootstrap = await getWorkspaceBootstrap(client, workspace.id)

      expect(bootstrap.emojis).toBeInstanceOf(Array)
      expect(bootstrap.emojis.length).toBeGreaterThan(100)
      expect(bootstrap.emojis[0]).toHaveProperty("shortcode")
      expect(bootstrap.emojis[0]).toHaveProperty("emoji")
      expect(bootstrap.emojis[0]).toHaveProperty("aliases")
    })

    test("should include emoji weights in bootstrap (initially empty)", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("bootstrap-weights"), "Bootstrap Weights Test")
      const workspace = await createWorkspace(client, `Bootstrap Weights WS ${testRunId}`)

      const bootstrap = await getWorkspaceBootstrap(client, workspace.id)

      expect(bootstrap.emojiWeights).toBeDefined()
      expect(typeof bootstrap.emojiWeights).toBe("object")
      // New user should have no emoji weights yet
      expect(Object.keys(bootstrap.emojiWeights).length).toBe(0)
    })
  })

  describe("Message Normalization", () => {
    test("should normalize raw emoji in message content to shortcode", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("msg-normalize"), "Message Normalize Test")
      const workspace = await createWorkspace(client, `Msg Normalize WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Send message with raw emoji
      const message = await sendMessage(client, workspace.id, scratchpad.id, "Great job! 👍")

      // Should be stored with shortcode
      expect(message.contentMarkdown).toBe("Great job! :+1:")
    })

    test("should normalize multiple emojis in same message", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("msg-multi-emoji"), "Message Multi Emoji Test")
      const workspace = await createWorkspace(client, `Msg Multi Emoji WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const message = await sendMessage(client, workspace.id, scratchpad.id, "🎉 Congrats! 🎊 You rock! 🤘")

      expect(message.contentMarkdown).toContain(":tada:")
      expect(message.contentMarkdown).toContain(":confetti_ball:")
      expect(message.contentMarkdown).toContain(":metal:")
    })

    test("should preserve existing shortcodes", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("msg-shortcode"), "Message Shortcode Test")
      const workspace = await createWorkspace(client, `Msg Shortcode WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Send message with shortcode (already normalized)
      const message = await sendMessage(client, workspace.id, scratchpad.id, "This is :fire: content!")

      expect(message.contentMarkdown).toBe("This is :fire: content!")
    })

    test("should leave unknown emoji unchanged", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("msg-unknown"), "Message Unknown Test")
      const workspace = await createWorkspace(client, `Msg Unknown WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Send message with text that looks like emoji but isn't registered
      const message = await sendMessage(client, workspace.id, scratchpad.id, "This is :notarealshortcode: text")

      expect(message.contentMarkdown).toBe("This is :notarealshortcode: text")
    })
  })

  describe("Emoji Usage Tracking", () => {
    test("should track emoji usage from messages", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("usage-msg"), "Usage Message Test")
      const workspace = await createWorkspace(client, `Usage Msg WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Send several messages with emojis
      await sendMessage(client, workspace.id, scratchpad.id, "I love this! 👍")
      await sendMessage(client, workspace.id, scratchpad.id, "Another thumbs up 👍")
      await sendMessage(client, workspace.id, scratchpad.id, "Fire! 🔥")

      // Wait for the outbox listener to record both emojis
      const bootstrap = await waitForEmojiWeights(
        client,
        workspace.id,
        (weights) => (weights["+1"] ?? 0) >= 2 && (weights["fire"] ?? 0) >= 1
      )

      // Should have tracked +1 emoji (used twice)
      expect(bootstrap.emojiWeights["+1"]).toBeGreaterThanOrEqual(2)
      // Should have tracked fire emoji
      expect(bootstrap.emojiWeights["fire"]).toBeGreaterThanOrEqual(1)
    })

    test("should track emoji usage from reactions", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("usage-react"), "Usage Reaction Test")
      const workspace = await createWorkspace(client, `Usage React WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const message = await sendMessage(client, workspace.id, scratchpad.id, "React to this!")
      await addReaction(client, workspace.id, message.id, "❤️")
      await addReaction(client, workspace.id, message.id, "🎉")

      // Wait for the outbox listener to record both reaction emojis
      const bootstrap = await waitForEmojiWeights(
        client,
        workspace.id,
        (weights) => (weights["heart"] ?? 0) >= 1 && (weights["tada"] ?? 0) >= 1
      )

      // Should have tracked heart and tada
      expect(bootstrap.emojiWeights["heart"]).toBeGreaterThanOrEqual(1)
      expect(bootstrap.emojiWeights["tada"]).toBeGreaterThanOrEqual(1)
    })

    test("should count multiple same emojis in one message", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("usage-wall"), "Usage Wall Test")
      const workspace = await createWorkspace(client, `Usage Wall WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // Wall of same emoji
      await sendMessage(client, workspace.id, scratchpad.id, "👍👍👍👍👍")

      // Wait for the outbox listener to count all 5 occurrences
      const bootstrap = await waitForEmojiWeights(client, workspace.id, (weights) => (weights["+1"] ?? 0) >= 5)

      // Should count all 5 occurrences
      expect(bootstrap.emojiWeights["+1"]).toBeGreaterThanOrEqual(5)
    })

    test("should have weights persist and accumulate across messages", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("usage-persist"), "Usage Persist Test")
      const workspace = await createWorkspace(client, `Usage Persist WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      // First message
      await sendMessage(client, workspace.id, scratchpad.id, "First 👍")
      const bootstrap1 = await waitForEmojiWeights(client, workspace.id, (weights) => (weights["+1"] ?? 0) >= 1)
      const weight1 = bootstrap1.emojiWeights["+1"] ?? 0

      // Second message — wait until the weight climbs past the first reading
      await sendMessage(client, workspace.id, scratchpad.id, "Second 👍")
      const bootstrap2 = await waitForEmojiWeights(client, workspace.id, (weights) => (weights["+1"] ?? 0) > weight1)
      const weight2 = bootstrap2.emojiWeights["+1"] ?? 0

      // Weight should have increased
      expect(weight2).toBeGreaterThan(weight1)
    })
  })

  describe("Reaction Normalization", () => {
    test("should normalize raw emoji reactions to shortcode", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("react-normalize"), "React Normalize Test")
      const workspace = await createWorkspace(client, `React Normalize WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const message = await sendMessage(client, workspace.id, scratchpad.id, "React to me")
      const updated = await addReaction(client, workspace.id, message.id, "👍")

      // Reaction key should be shortcode format
      expect(updated.reactions).toEqual({ ":+1:": [expect.stringMatching(/^usr_/)] })
    })

    test("should accept shortcode reactions directly", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("react-shortcode"), "React Shortcode Test")
      const workspace = await createWorkspace(client, `React Shortcode WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const message = await sendMessage(client, workspace.id, scratchpad.id, "React to me")
      const updated = await addReaction(client, workspace.id, message.id, ":fire:")

      expect(updated.reactions).toEqual({ ":fire:": [expect.stringMatching(/^usr_/)] })
    })
  })

  describe("Event Payloads", () => {
    test("message_created event should contain normalized content", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("event-msg"), "Event Message Test")
      const workspace = await createWorkspace(client, `Event Msg WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      await sendMessage(client, workspace.id, scratchpad.id, "Testing 👍 events")

      const events = await listEvents(client, workspace.id, scratchpad.id, ["message_created"])
      const payload = events[0].payload as { contentMarkdown: string }

      expect(payload.contentMarkdown).toBe("Testing :+1: events")
    })

    test("reaction_added event should contain shortcode", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("event-react"), "Event Reaction Test")
      const workspace = await createWorkspace(client, `Event React WS ${testRunId}`)
      const scratchpad = await createScratchpad(client, workspace.id, "off")

      const message = await sendMessage(client, workspace.id, scratchpad.id, "React to me")
      await addReaction(client, workspace.id, message.id, "❤️")

      const events = await listEvents(client, workspace.id, scratchpad.id, ["reaction_added"])
      const payload = events[0].payload as { emoji: string }

      expect(payload.emoji).toBe(":heart:")
    })
  })
})
