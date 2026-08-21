/**
 * Test Cases for Companion Agent Evaluation
 *
 * Organized by invocation context (scratchpad, channel, thread, dm)
 * and message type (greeting, question, information, task).
 */

import type { EvalCase } from "../../framework/types"
import type { StreamType, AgentTrigger } from "@threa/types"

/**
 * Input for companion evaluation.
 */
export interface CompanionInput {
  /** The user message to respond to */
  message: string
  /** Stream type context */
  streamType: StreamType
  /** Invocation trigger */
  trigger: AgentTrigger
  /** Invocation time override for deterministic temporal evals */
  currentTime?: string
  /** Invoking user's timezone override */
  timezone?: string
  /** Conversation history (if any) */
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string; createdAt?: string }>
  /** Additional workspace context from other streams for cross-stream memory tests */
  workspaceContext?: Array<{
    streamType?: StreamType
    name?: string
    description?: string
    conversationHistory: Array<{ role: "user" | "assistant"; content: string; createdAt?: string }>
  }>
  /** Additional context about the stream */
  streamContext?: {
    name?: string
    description?: string
    participants?: string[]
  }
  /** Name of the user sending the message */
  userName?: string
  /**
   * For `streamType: "aside"`: the host stream the aside is anchored to, seeded
   * as its own stream with this history, plus a viewport context bag on the
   * aside covering `visibleIndices` of that history (every row when omitted) —
   * the snapshot an aside is created with in production.
   */
  asideHost?: {
    name?: string
    conversationHistory: Array<{ role: "user" | "assistant"; content: string; createdAt?: string }>
    visibleIndices?: number[]
  }
}

/**
 * Expected output for companion evaluation.
 */
export interface CompanionExpected {
  /** Whether the agent should respond */
  shouldRespond: boolean
  /** Expected characteristics of the response */
  responseCharacteristics?: {
    /** Should be brief (< 100 words) */
    brief?: boolean
    /** Should include specific content */
    shouldContain?: string[]
    /** Should NOT include specific content */
    shouldNotContain?: string[]
    /** Expected tone (friendly, professional, casual) */
    tone?: "friendly" | "professional" | "casual"
    /** Should ask a clarifying question */
    shouldAskQuestion?: boolean
    /** Should use web search */
    shouldUseWebSearch?: boolean
    /** Web search query should include these terms */
    webSearchQueryShouldContain?: string[]
  }
  /** Reason for this expected behavior */
  reason: string
}

/**
 * Create a test case with ID prefix based on context.
 */
function createCase(
  id: string,
  name: string,
  input: CompanionInput,
  expectedOutput: CompanionExpected
): EvalCase<CompanionInput, CompanionExpected> {
  const prefix = `${input.streamType}-${input.trigger}`
  return {
    id: `${prefix}-${id}`,
    name,
    input,
    expectedOutput,
  }
}

// =============================================================================
// Scratchpad Cases (Personal context, companion mode)
// =============================================================================

const scratchpadCases: EvalCase<CompanionInput, CompanionExpected>[] = [
  createCase(
    "greeting-001",
    "Scratchpad: Simple greeting should get brief response",
    {
      message: "Hey!",
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        brief: true,
        tone: "friendly",
      },
      reason: "Simple greeting in personal scratchpad deserves a friendly, brief acknowledgment",
    }
  ),

  createCase(
    "question-001",
    "Scratchpad: Technical question should get helpful answer",
    {
      message: "How do I center a div in CSS?",
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["flex", "grid", "center"],
        tone: "friendly",
      },
      reason: "Technical question should receive a helpful, accurate answer with code examples",
    }
  ),

  createCase(
    "info-share-001",
    "Scratchpad: Information sharing might not need response",
    {
      message: "Just finished refactoring the auth module. Took about 3 hours but it's much cleaner now.",
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        brief: true,
        shouldNotContain: ["let me help", "would you like me"],
      },
      reason: "User sharing information - acknowledge briefly without overhelping",
    }
  ),

  createCase(
    "task-request-001",
    "Scratchpad: Task request should trigger action",
    {
      message: "Can you help me draft a commit message for adding user authentication?",
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["feat:", "auth"],
        tone: "professional",
      },
      reason: "Task request should result in actual help with the task",
    }
  ),

  createCase(
    "web-search-001",
    "Scratchpad: Current events question should trigger web search",
    {
      message: "What's the latest version of React?",
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldUseWebSearch: true,
      },
      reason: "Question about current information should trigger web search for accuracy",
    }
  ),

  createCase(
    "context-aware-001",
    "Scratchpad: Should use conversation history",
    {
      message: "What do you think about that approach?",
      streamType: "scratchpad",
      trigger: "companion",
      conversationHistory: [
        { role: "user", content: "I'm thinking of using a microservices architecture for the new project" },
        {
          role: "assistant",
          content: "That's an interesting choice! Microservices can offer flexibility but add complexity.",
        },
      ],
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["microservices"],
      },
      reason: "Should understand context from conversation history and reference previous discussion",
    }
  ),

  createCase(
    "vague-001",
    "Scratchpad: Vague message should prompt clarification",
    {
      message: "Fix it",
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldAskQuestion: true,
      },
      reason: "Vague request should prompt for clarification rather than guessing",
    }
  ),
]

// =============================================================================
// Temporal Grounding Cases
// =============================================================================

const temporalGroundingCases: EvalCase<CompanionInput, CompanionExpected>[] = [
  createCase(
    "temporal-now-001",
    "Temporal: Tomorrow should resolve from invocation time",
    {
      message: "What is tomorrow's date? Answer with the YYYY-MM-DD date only.",
      streamType: "scratchpad",
      trigger: "companion",
      currentTime: "2026-11-15T10:00:00.000Z",
      timezone: "UTC",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        brief: true,
        shouldContain: ["2026-11-16"],
        shouldNotContain: ["2025", "2024", "knowledge cutoff"],
      },
      reason:
        "Relative dates must resolve from the invocation time, not model training cutoff or wall-clock assumptions",
    }
  ),

  createCase(
    "temporal-long-lived-001",
    "Temporal: Recent should use November invocation time in an old stream",
    {
      message: "Which of these decisions is more recent, and what did we decide?",
      streamType: "scratchpad",
      trigger: "companion",
      currentTime: "2026-11-15T10:00:00.000Z",
      timezone: "UTC",
      conversationHistory: [
        {
          role: "user",
          content: "Decision log: In April we chose Redis for the short-lived cache.",
          createdAt: "2026-04-20T09:00:00.000Z",
        },
        {
          role: "user",
          content: "Decision log: This week we replaced that with Postgres advisory locks for coordination.",
          createdAt: "2026-11-12T14:00:00.000Z",
        },
      ],
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["Postgres", "advisory"],
        shouldNotContain: [
          "Redis is more recent",
          "redis was the more recent choice",
          "the redis decision is more recent",
        ],
      },
      reason:
        "Long-lived streams must interpret recent relative to the current November invocation, while preserving historical message dates",
    }
  ),

  createCase(
    "temporal-news-001",
    "Temporal: Latest AI news should search with the current year",
    {
      message: "What's the most recent news in AI?",
      streamType: "scratchpad",
      trigger: "companion",
      currentTime: "2026-11-15T10:00:00.000Z",
      timezone: "UTC",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldUseWebSearch: true,
        webSearchQueryShouldContain: ["2026"],
        shouldNotContain: ["knowledge cutoff", "last update"],
      },
      reason: "Open-ended recent-news questions should be grounded with web search against the invocation year",
    }
  ),
]

// =============================================================================
// Channel Cases (Collaborative context, @mention trigger)
// =============================================================================

const channelCases: EvalCase<CompanionInput, CompanionExpected>[] = [
  createCase(
    "mention-question-001",
    "Channel: @mention with question should respond helpfully",
    {
      message: "@ariadne can you explain how the new caching system works?",
      streamType: "channel",
      trigger: "mention",
      streamContext: {
        name: "engineering",
        description: "Engineering team discussions",
        participants: ["Alice", "Bob", "Charlie"],
      },
      userName: "Alice",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        tone: "professional",
      },
      reason: "Direct @mention with question in channel should receive professional, helpful response",
    }
  ),

  createCase(
    "mention-help-001",
    "Channel: @mention for help should be thorough",
    {
      message: "@ariadne I'm stuck on a bug where the WebSocket disconnects randomly. Any ideas?",
      streamType: "channel",
      trigger: "mention",
      streamContext: {
        name: "engineering",
        participants: ["Dave"],
      },
      userName: "Dave",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["reconnect", "heartbeat", "timeout"],
      },
      reason: "Help request should receive thorough troubleshooting guidance",
    }
  ),

  createCase(
    "mention-opinion-001",
    "Channel: @mention for opinion should be balanced",
    {
      message: "@ariadne what do you think - should we use PostgreSQL or MongoDB for this?",
      streamType: "channel",
      trigger: "mention",
      userName: "Eve",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["depends", "consider", "trade"],
        tone: "professional",
      },
      reason: "Opinion request should provide balanced view of trade-offs, not a single answer",
    }
  ),
]

// =============================================================================
// Thread Cases (Nested discussion, context from parent)
// =============================================================================

const threadCases: EvalCase<CompanionInput, CompanionExpected>[] = [
  createCase(
    "thread-followup-001",
    "Thread: Follow-up question should build on context",
    {
      message: "How would that work with our existing setup?",
      streamType: "thread",
      trigger: "companion",
      conversationHistory: [
        { role: "user", content: "We should probably add rate limiting to the API" },
        { role: "assistant", content: "Good idea! You could use a token bucket or sliding window algorithm." },
      ],
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["rate limit"],
      },
      reason: "Thread follow-up should reference the ongoing discussion context",
    }
  ),

  createCase(
    "thread-deep-001",
    "Thread: Deep technical question should be detailed",
    {
      message: "Can you show me a code example of the sliding window approach?",
      streamType: "thread",
      trigger: "companion",
      conversationHistory: [
        { role: "user", content: "How does sliding window rate limiting work?" },
        {
          role: "assistant",
          content: "Sliding window tracks requests in a time window that moves with the current time...",
        },
      ],
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["function", "window", "time"],
      },
      reason: "Code example request should include actual code",
    }
  ),

  createCase(
    "thread-correction-001",
    "Thread: Latest correction in context should win",
    {
      message: "Can you summarize the final timeout decision?",
      streamType: "thread",
      trigger: "companion",
      conversationHistory: [
        { role: "user", content: "Let's set the request timeout to 30 seconds." },
        { role: "assistant", content: "Sounds good, 30 seconds is a reasonable default." },
        { role: "user", content: "Actually, let's lower it to 10 seconds for now." },
      ],
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["10 second"],
      },
      reason: "Thread responses should use the latest user correction from context",
    }
  ),
]

// =============================================================================
// DM Cases (Two-party, focused conversation)
// =============================================================================

const dmCases: EvalCase<CompanionInput, CompanionExpected>[] = [
  createCase(
    "dm-question-001",
    "DM: Direct question should get personalized response",
    {
      message: "Hey, quick question - what's the best way to handle auth tokens in React?",
      streamType: "dm",
      trigger: "companion",
      userName: "Frank",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["token", "storage"],
        tone: "friendly",
      },
      reason: "DM question should feel personal and direct",
    }
  ),

  createCase(
    "dm-casual-001",
    "DM: Casual chat should match tone",
    {
      message: "Working on anything interesting today?",
      streamType: "dm",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        tone: "casual",
        brief: true,
      },
      reason: "Casual DM should have a friendly, conversational tone",
    }
  ),

  createCase(
    "dm-thanks-001",
    "DM: Thanks message should be brief",
    {
      message: "Thanks, that was super helpful!",
      streamType: "dm",
      trigger: "companion",
      conversationHistory: [
        { role: "user", content: "How do I use async/await in JavaScript?" },
        { role: "assistant", content: "Here's how async/await works..." },
      ],
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        brief: true,
        shouldNotContain: ["let me know if", "feel free to ask"],
      },
      reason: "Thank you message should get brief acknowledgment, not over-helpful response",
    }
  ),
]

// =============================================================================
// Workspace Memory Cases (Cross-stream retrieval)
// =============================================================================

const workspaceMemoryCases: EvalCase<CompanionInput, CompanionExpected>[] = [
  createCase(
    "workspace-memory-001",
    "Workspace Memory: Should recall cross-stream retry decision",
    {
      message: "Do you remember the retry strategy we chose for Project Hummingbird?",
      streamType: "scratchpad",
      trigger: "companion",
      workspaceContext: [
        {
          streamType: "channel",
          name: "ops-retros",
          conversationHistory: [
            { role: "user", content: "Decision log: Project Hummingbird retry policy is 4 attempts." },
            { role: "user", content: "Add jitter to retries and cap total backoff at 7 seconds." },
          ],
        },
      ],
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["jitter"],
      },
      reason: "The agent should retrieve relevant cross-stream decisions when asked to recall prior workspace choices",
    }
  ),

  createCase(
    "workspace-memory-002",
    "Workspace Memory: Should recall owner from prior workspace notes",
    {
      message: "Who owns the release freeze checklist again?",
      streamType: "scratchpad",
      trigger: "companion",
      workspaceContext: [
        {
          streamType: "channel",
          name: "release-planning",
          conversationHistory: [
            { role: "user", content: "Release note: Marta owns the release freeze checklist for v2.3." },
            { role: "assistant", content: "Acknowledged, Marta is the checklist owner." },
          ],
        },
      ],
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["Marta"],
      },
      reason: "When workspace history contains the owner explicitly, the response should recall that owner",
    }
  ),
]

// =============================================================================
// Edge Cases
// =============================================================================

const edgeCases: EvalCase<CompanionInput, CompanionExpected>[] = [
  createCase(
    "edge-empty-001",
    "Edge: Empty message should handle gracefully",
    {
      message: "",
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: false,
      reason: "Empty message should not trigger a response",
    }
  ),

  createCase(
    "edge-gibberish-001",
    "Edge: Gibberish should ask for clarification",
    {
      message: "asdf jkl; qwerty zxcv",
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldAskQuestion: true,
        tone: "friendly",
      },
      reason: "Gibberish should prompt for clarification politely",
    }
  ),

  createCase(
    "edge-long-001",
    "Edge: Long message should get focused response",
    {
      message: `I've been working on this project for about three months now and we're hitting some
        performance issues. The main problem seems to be with our database queries - they're getting
        slower as we add more data. We're using PostgreSQL with a pretty standard setup. The app is
        built with Node.js and Express. We have about 50,000 users now and growing. The slowest
        queries are in the user activity feed which joins multiple tables. I've tried adding some
        indexes but I'm not sure if I'm doing it right. Also wondering if we should consider
        caching or denormalization. What would you recommend?`,
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["index", "query", "cache"],
        tone: "professional",
      },
      reason: "Long, detailed message should get a focused, structured response",
    }
  ),

  createCase(
    "edge-code-001",
    "Edge: Code snippet should get technical response",
    {
      message: `What's wrong with this code?
\`\`\`javascript
const result = await fetch('/api/data')
const data = result.json()
console.log(data)
\`\`\``,
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["await"],
      },
      reason: "Should identify the missing await on .json()",
    }
  ),
]

// =============================================================================
// Behavior Consistency Cases
// =============================================================================

const consistencyCases: EvalCase<CompanionInput, CompanionExpected>[] = [
  createCase(
    "consistency-persona-001",
    "Consistency: Should maintain persona identity",
    {
      message: "Who are you?",
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldNotContain: ["ChatGPT", "Claude", "OpenAI", "Anthropic"],
      },
      reason: "Should respond with persona identity, not underlying model",
    }
  ),

  createCase(
    "consistency-no-overpromise-001",
    "Consistency: Should not overpromise capabilities",
    {
      message: "Can you send an email for me?",
      streamType: "scratchpad",
      trigger: "companion",
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldNotContain: ["I'll send", "sending now"],
      },
      reason: "Should not claim to do things outside its capabilities",
    }
  ),

  createCase(
    "consistency-no-hallucinate-001",
    "Consistency: Should not make up information",
    {
      message: "What did we discuss in yesterday's meeting?",
      streamType: "channel",
      trigger: "companion",
      conversationHistory: [],
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["don't have", "no record", "not sure"],
        shouldNotContain: ["we discussed", "you mentioned"],
      },
      reason: "Should acknowledge lack of context rather than inventing information",
    }
  ),
]

// =============================================================================
// Export all cases
// =============================================================================

// =============================================================================
// Aside Cases (viewport snapshot grounding)
// =============================================================================

const asideCases: EvalCase<CompanionInput, CompanionExpected>[] = [
  createCase(
    "viewport-001",
    "Aside: answers from the host messages that were on screen",
    {
      message: "What was the corrected churn figure they mentioned?",
      streamType: "aside",
      trigger: "companion",
      asideHost: {
        name: "pipeline-review",
        conversationHistory: [
          {
            role: "user",
            content:
              "Heads up: the Q3 churn number in the board deck is 4.2%, not 3.8%. Dana recomputed it this morning.",
          },
          { role: "user", content: "Can someone sanity-check the slide before the 3pm call?" },
        ],
      },
    },
    {
      shouldRespond: true,
      responseCharacteristics: {
        shouldContain: ["4.2"],
        shouldNotContain: ["get_stream_messages"],
      },
      reason:
        "The viewport snapshot grounds the aside in what the user was reading; the agent answers from it without asking for a paste or leaking tool names",
    }
  ),
]

export const companionCases: EvalCase<CompanionInput, CompanionExpected>[] = [
  ...scratchpadCases,
  ...temporalGroundingCases,
  ...channelCases,
  ...threadCases,
  ...dmCases,
  ...workspaceMemoryCases,
  ...edgeCases,
  ...consistencyCases,
  ...asideCases,
]

// Export case subsets for targeted testing
export {
  scratchpadCases,
  temporalGroundingCases,
  channelCases,
  threadCases,
  dmCases,
  workspaceMemoryCases,
  edgeCases,
  consistencyCases,
}
