/**
 * Boundary Extraction Test Cases
 *
 * Tests the boundary extractor's ability to correctly classify messages
 * into existing conversations or identify new conversation topics.
 */

import type { EvalCase } from "../../framework/types"
import type { BoundaryExtractionInput, BoundaryExtractionExpected } from "./types"

export const boundaryExtractionCases: EvalCase<BoundaryExtractionInput, BoundaryExtractionExpected>[] = [
  // New topic cases - should create new conversation
  {
    id: "new-topic-fresh-stream-001",
    name: "New topic: First message in stream",
    input: {
      newMessage: {
        authorId: "user_abc123",
        authorType: "user",
        contentMarkdown: "Hey team, I need help with the deployment pipeline. The CI is failing on the staging branch.",
      },
      activeConversations: [],
      streamType: "channel",
      category: "new-topic",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["deployment", "CI", "pipeline", "staging"],
      minConfidence: 0.7,
    },
  },
  {
    id: "new-topic-unrelated-001",
    name: "New topic: Unrelated to existing conversations",
    input: {
      newMessage: {
        authorId: "user_xyz789",
        authorType: "user",
        contentMarkdown: "Has anyone tried the new Thai place on 5th street? Thinking of ordering lunch.",
      },
      activeConversations: [
        {
          id: "conv_tech123",
          topicSummary: "API authentication issues",
          messageCount: 5,
          lastMessagePreview: "The OAuth flow is now working correctly",
          participantIds: ["user_abc123", "user_def456"],
          completenessScore: 4,
        },
      ],
      recentMessages: [
        {
          authorId: "user_abc123",
          authorType: "user",
          contentMarkdown: "Fixed the token refresh logic",
        },
      ],
      streamType: "channel",
      category: "new-topic",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["lunch", "Thai", "food", "restaurant"],
      minConfidence: 0.7,
    },
  },

  // Continue existing conversation cases
  {
    id: "continue-direct-reply-001",
    name: "Continue: Direct reply to ongoing discussion",
    input: {
      newMessage: {
        authorId: "user_def456",
        authorType: "user",
        contentMarkdown:
          "I tried that fix but I'm still getting the 401 error. Can you share the exact headers you're using?",
      },
      activeConversations: [
        {
          id: "conv_auth001",
          topicSummary: "API authentication issues",
          messageCount: 3,
          lastMessagePreview: "Try refreshing the token before the request",
          participantIds: ["user_abc123", "user_def456"],
          completenessScore: 2,
        },
      ],
      recentMessages: [
        {
          authorId: "user_abc123",
          authorType: "user",
          contentMarkdown: "Try refreshing the token before the request",
        },
      ],
      streamType: "channel",
      category: "continue-existing",
    },
    expectedOutput: {
      expectConversationId: "conv_auth001",
      minConfidence: 0.8,
    },
  },
  {
    id: "continue-same-participant-001",
    name: "Continue: Same participant continuing their thought",
    input: {
      newMessage: {
        authorId: "user_abc123",
        authorType: "user",
        contentMarkdown:
          "Actually, I just realized we also need to handle the edge case when the token expires mid-request.",
      },
      activeConversations: [
        {
          id: "conv_token001",
          topicSummary: "Token refresh implementation",
          messageCount: 2,
          lastMessagePreview: "We need to implement automatic token refresh",
          participantIds: ["user_abc123"],
          completenessScore: 2,
        },
      ],
      recentMessages: [
        {
          authorId: "user_abc123",
          authorType: "user",
          contentMarkdown: "We need to implement automatic token refresh",
        },
      ],
      streamType: "channel",
      category: "continue-existing",
    },
    expectedOutput: {
      expectConversationId: "conv_token001",
      minConfidence: 0.8,
    },
  },

  // Topic shift cases - might continue or start new
  {
    id: "topic-shift-related-001",
    name: "Topic shift: Related but distinct topic",
    input: {
      newMessage: {
        authorId: "user_abc123",
        authorType: "user",
        contentMarkdown:
          "Speaking of authentication, we should also audit our password policies. When was the last security review?",
      },
      activeConversations: [
        {
          id: "conv_oauth001",
          topicSummary: "OAuth implementation",
          messageCount: 8,
          lastMessagePreview: "The OAuth flow is working now",
          participantIds: ["user_abc123", "user_def456"],
          completenessScore: 6,
        },
      ],
      recentMessages: [
        {
          authorId: "user_def456",
          authorType: "user",
          contentMarkdown: "The OAuth flow is working now",
        },
      ],
      streamType: "channel",
      category: "topic-shift",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["security", "password", "audit"],
      minConfidence: 0.6,
    },
  },

  // Resolution cases - should mark conversation as resolved
  {
    id: "resolution-explicit-001",
    name: "Resolution: Explicit resolution statement",
    input: {
      newMessage: {
        authorId: "user_abc123",
        authorType: "user",
        contentMarkdown: "Perfect, that fixed it! The deployment is now working. Thanks for the help everyone!",
      },
      activeConversations: [
        {
          id: "conv_deploy001",
          topicSummary: "Deployment pipeline issues",
          messageCount: 6,
          lastMessagePreview: "Try running the deploy script with verbose mode",
          participantIds: ["user_abc123", "user_def456", "user_ghi789"],
          completenessScore: 4,
        },
      ],
      recentMessages: [
        {
          authorId: "user_def456",
          authorType: "user",
          contentMarkdown: "Try running the deploy script with verbose mode",
        },
      ],
      streamType: "channel",
      category: "resolution",
    },
    expectedOutput: {
      expectConversationId: "conv_deploy001",
      minConfidence: 0.8,
      expectCompletenessUpdate: [
        {
          conversationId: "conv_deploy001",
          minScore: 6,
          status: "resolved",
        },
      ],
    },
  },

  // Ambiguous cases
  {
    id: "ambiguous-greeting-001",
    name: "Ambiguous: Simple greeting",
    input: {
      newMessage: {
        authorId: "user_new123",
        authorType: "user",
        contentMarkdown: "Good morning everyone!",
      },
      activeConversations: [
        {
          id: "conv_standup001",
          topicSummary: "Daily standup",
          messageCount: 3,
          lastMessagePreview: "I'll be working on the API today",
          participantIds: ["user_abc123", "user_def456"],
          completenessScore: 3,
        },
      ],
      recentMessages: [],
      streamType: "channel",
      category: "ambiguous",
    },
    expectedOutput: {
      minConfidence: 0.5,
    },
  },
  {
    id: "ambiguous-multiple-conversations-001",
    name: "Ambiguous: Message could fit multiple conversations",
    input: {
      newMessage: {
        authorId: "user_abc123",
        authorType: "user",
        contentMarkdown: "Any updates on this?",
      },
      activeConversations: [
        {
          id: "conv_bug001",
          topicSummary: "Bug in user registration",
          messageCount: 4,
          lastMessagePreview: "Looking into it now",
          participantIds: ["user_abc123", "user_def456"],
          completenessScore: 3,
        },
        {
          id: "conv_feature001",
          topicSummary: "New dashboard feature",
          messageCount: 5,
          lastMessagePreview: "Design is almost ready",
          participantIds: ["user_abc123", "user_ghi789"],
          completenessScore: 4,
        },
      ],
      recentMessages: [
        {
          authorId: "user_def456",
          authorType: "user",
          contentMarkdown: "Looking into it now",
        },
      ],
      streamType: "channel",
      category: "ambiguous",
    },
    expectedOutput: {
      minConfidence: 0.4,
    },
  },

  // Edge cases
  {
    id: "edge-code-block-001",
    name: "Edge: Message with code block",
    input: {
      newMessage: {
        authorId: "user_abc123",
        authorType: "user",
        contentMarkdown: `Here's the error I'm getting:
\`\`\`
Error: Connection refused at 127.0.0.1:5432
\`\`\`
Any ideas what's causing this?`,
      },
      activeConversations: [
        {
          id: "conv_db001",
          topicSummary: "Database connection issues",
          messageCount: 2,
          lastMessagePreview: "The database seems to be down",
          participantIds: ["user_abc123"],
          completenessScore: 2,
        },
      ],
      recentMessages: [],
      streamType: "channel",
      category: "continue-existing",
    },
    expectedOutput: {
      expectConversationId: "conv_db001",
      minConfidence: 0.7,
    },
  },
  {
    id: "edge-mention-001",
    name: "Edge: Message with @mention",
    input: {
      newMessage: {
        authorId: "user_abc123",
        authorType: "user",
        contentMarkdown: "@sarah can you review the PR when you get a chance?",
      },
      activeConversations: [
        {
          id: "conv_pr001",
          topicSummary: "Pull request for auth feature",
          messageCount: 3,
          lastMessagePreview: "I pushed the changes",
          participantIds: ["user_abc123"],
          completenessScore: 3,
        },
      ],
      recentMessages: [
        {
          authorId: "user_abc123",
          authorType: "user",
          contentMarkdown: "I pushed the changes",
        },
      ],
      streamType: "channel",
      category: "continue-existing",
    },
    expectedOutput: {
      expectConversationId: "conv_pr001",
      minConfidence: 0.7,
    },
  },

  // Topic naming: lead with the subject, no framing preamble
  {
    id: "topic-naming-no-preamble-001",
    name: "Topic naming: English topic without 'Discussion about' preamble",
    input: {
      newMessage: {
        authorId: "user_abc123",
        authorType: "user",
        contentMarkdown:
          "Let's lock down the seating chart for the wedding — 120 guests across 12 tables, and we need to keep the two families apart.",
      },
      activeConversations: [],
      streamType: "channel",
      category: "new-topic",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["seating", "wedding", "table"],
      topicNotContains: ["discussion about", "chat about", "conversation about", "thoughts on"],
      minConfidence: 0.7,
    },
  },

  // Topic naming: follow the conversation's language, don't label it
  {
    id: "topic-naming-swedish-001",
    name: "Topic naming: Swedish conversation stays in Swedish",
    input: {
      newMessage: {
        authorId: "user_abc123",
        authorType: "user",
        contentMarkdown:
          "Jag funderar på att börja odla tomater på balkongen i sommar. Vilken sort passar bäst för ett soligt läge, och hur ofta måste man vattna?",
      },
      activeConversations: [],
      streamType: "channel",
      category: "new-topic",
    },
    expectedOutput: {
      expectNewConversation: true,
      // Require Swedish wording from the source conversation (evaluator passes on any one match)
      topicContains: ["tomat", "balkong"],
      // Must not label the language or fall back to English framing
      topicNotContains: ["swedish", "svenska", "discussion", "chat about", "conversation about"],
      minConfidence: 0.7,
    },
  },

  // Topic naming: keep proper nouns verbatim, don't translate them
  {
    id: "topic-naming-proper-noun-001",
    name: "Topic naming: product names preserved verbatim in Swedish chat",
    input: {
      newMessage: {
        authorId: "user_abc123",
        authorType: "user",
        contentMarkdown:
          "Har du testat Lightroom för att redigera bilderna? Jag tycker färgerna blir bättre där än i Photoshop, men exporten känns långsam.",
      },
      activeConversations: [],
      streamType: "channel",
      category: "new-topic",
    },
    expectedOutput: {
      expectNewConversation: true,
      // Proper nouns survive untranslated (evaluator passes on any one match)
      topicContains: ["lightroom", "photoshop"],
      topicNotContains: ["swedish", "svenska"],
      minConfidence: 0.7,
    },
  },
]
