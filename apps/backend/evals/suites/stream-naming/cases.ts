/**
 * Stream Naming Test Cases
 *
 * Tests the stream naming service's ability to generate descriptive,
 * concise titles (2-5 words) for conversations.
 */

import type { EvalCase } from "../../framework/types"
import type { StreamNamingInput, StreamNamingExpected } from "./types"

export const streamNamingCases: EvalCase<StreamNamingInput, StreamNamingExpected>[] = [
  // Technical conversations
  {
    id: "technical-api-discussion-001",
    name: "Technical: API authentication discussion",
    input: {
      conversationText: `User: I'm trying to set up OAuth 2.0 for our API but getting 401 errors
User: The access token seems valid but the server keeps rejecting it
User: I've checked the scopes and they look correct
User: Could it be a clock skew issue?`,
      category: "technical",
    },
    expectedOutput: {
      nameContains: ["oauth", "api", "auth"],
      wordCountRange: { min: 2, max: 5 },
    },
  },
  {
    id: "technical-bug-fix-001",
    name: "Technical: Database migration bug",
    input: {
      conversationText: `User: The production database migration failed halfway through
User: We have orphaned records in the users table now
User: Need to figure out how to roll back safely
User: The foreign key constraints are blocking the delete`,
      category: "technical",
    },
    expectedOutput: {
      nameContains: ["database", "migration"],
      wordCountRange: { min: 2, max: 5 },
    },
  },
  {
    id: "technical-performance-001",
    name: "Technical: Performance optimization",
    input: {
      conversationText: `User: The homepage is loading really slowly, taking 8+ seconds
User: I ran lighthouse and it's showing a 23 performance score
User: Most of the time is spent in the main thread
User: Thinking we need to lazy load the images and defer non-critical JS`,
      category: "technical",
    },
    expectedOutput: {
      nameContains: ["performance", "loading", "slow"],
      wordCountRange: { min: 2, max: 5 },
    },
  },

  // Casual conversations
  {
    id: "casual-lunch-plans-001",
    name: "Casual: Lunch planning",
    input: {
      conversationText: `User: Hey, anyone want to grab lunch?
User: There's a new Thai place that opened up on 5th street
User: They have great pad thai apparently
User: I'm free around 12:30`,
      category: "casual",
    },
    expectedOutput: {
      nameContains: ["lunch"],
      nameNotContains: ["quick question", "new discussion"],
      wordCountRange: { min: 2, max: 5 },
    },
  },
  {
    id: "casual-coffee-chat-001",
    name: "Casual: Coffee break chat",
    input: {
      conversationText: `User: Just got back from vacation in Portugal
User: Lisbon was amazing, so much history
User: The pastéis de nata were incredible
User: Definitely recommend it if you haven't been`,
      category: "casual",
    },
    expectedOutput: {
      nameContains: ["portugal", "vacation", "lisbon", "trip"],
      wordCountRange: { min: 2, max: 5 },
    },
  },

  // Question-based conversations
  {
    id: "question-deployment-001",
    name: "Question: Deployment process",
    input: {
      conversationText: `User: How do we deploy to staging?
User: I've never done it before
User: Is there a CI/CD pipeline or do we do it manually?`,
      category: "question",
    },
    expectedOutput: {
      nameContains: ["deploy", "staging"],
      wordCountRange: { min: 2, max: 5 },
    },
  },
  {
    id: "question-code-review-001",
    name: "Question: Code review process",
    input: {
      conversationText: `User: What's the code review process here?
User: Do I need approvals from specific people?
User: How long do reviews usually take?`,
      category: "question",
    },
    expectedOutput: {
      nameContains: ["code review", "review"],
      wordCountRange: { min: 2, max: 5 },
    },
  },

  // Minimal context - should return NOT_ENOUGH_CONTEXT
  {
    id: "minimal-greeting-001",
    name: "Minimal: Just a greeting",
    input: {
      conversationText: `User: Hi`,
      requireName: false,
      category: "minimal",
    },
    expectedOutput: {
      expectNotEnoughContext: true,
    },
  },
  {
    id: "minimal-single-word-001",
    name: "Minimal: Single word message",
    input: {
      conversationText: `User: Thanks`,
      requireName: false,
      category: "minimal",
    },
    expectedOutput: {
      expectNotEnoughContext: true,
    },
  },
  {
    id: "minimal-required-001",
    name: "Minimal: Required name for vague message",
    input: {
      conversationText: `User: Hey
AI: Hello! How can I help you today?`,
      requireName: true,
      category: "minimal",
    },
    expectedOutput: {
      expectNotEnoughContext: false,
      wordCountRange: { min: 2, max: 5 },
      allowGeneric: true, // Generic names acceptable for minimal context
    },
  },

  // Duplicate avoidance
  {
    id: "duplicate-avoid-001",
    name: "Duplicate: Should avoid existing name",
    input: {
      conversationText: `User: Working on the API authentication flow
User: Need to implement refresh tokens
User: Should we use JWT or opaque tokens?`,
      existingNames: ["API Authentication Setup", "Auth Token Design"],
      category: "duplicate-avoidance",
    },
    expectedOutput: {
      nameNotContains: ["API Authentication Setup", "Auth Token Design"],
      nameContains: ["token", "jwt", "refresh"],
      wordCountRange: { min: 2, max: 5 },
      shouldAvoidExisting: true,
    },
  },
  {
    id: "duplicate-multiple-001",
    name: "Duplicate: Multiple similar existing names",
    input: {
      conversationText: `User: Planning the Q1 product roadmap
User: We need to prioritize the mobile app features
User: Also considering the API v2 migration`,
      existingNames: ["Q1 Roadmap Planning", "Product Roadmap Discussion", "Q1 Planning Session", "Roadmap Review"],
      category: "duplicate-avoidance",
    },
    expectedOutput: {
      nameNotContains: ["Q1 Roadmap Planning", "Product Roadmap Discussion", "Q1 Planning Session", "Roadmap Review"],
      wordCountRange: { min: 2, max: 5 },
      shouldAvoidExisting: true,
    },
  },

  // Edge cases
  {
    id: "edge-mixed-languages-001",
    name: "Edge: Mixed language content",
    input: {
      conversationText: `User: Need to localize the app for Japanese market
User: The i18n setup is done but we need native speakers to review
User: 日本語のレビューが必要です
User: Can we hire a freelancer for this?`,
      category: "technical",
    },
    expectedOutput: {
      nameContains: ["japanese", "localization", "i18n", "translation"],
      wordCountRange: { min: 2, max: 5 },
    },
  },
  // Language: title follows the conversation's language and drops preamble
  {
    id: "language-swedish-topic-001",
    name: "Language: Swedish conversation stays in Swedish",
    input: {
      conversationText: `User: Jag funderar på att börja odla tomater på balkongen i sommar
User: Vilken sort tror du passar bäst för ett soligt läge?
User: Och hur ofta måste man vattna?`,
      category: "language",
    },
    expectedOutput: {
      // Title must reuse the source conversation's Swedish wording, not translate to English
      nameContains: ["tomat", "balkong"],
      // Should not label the language or use English framing words
      nameNotContains: ["swedish", "svenska", "discussion", "chat", "conversation", "about"],
      wordCountRange: { min: 2, max: 5 },
    },
  },
  {
    id: "language-proper-noun-001",
    name: "Language: Product name preserved verbatim in Swedish chat",
    input: {
      conversationText: `User: Har du testat Lightroom för att redigera bilderna?
User: Jag tycker färgerna blir bättre där än i Photoshop
User: Men exporten känns långsam`,
      category: "language",
    },
    expectedOutput: {
      // Proper nouns must survive untranslated
      nameContains: ["lightroom", "photoshop"],
      nameNotContains: ["swedish", "svenska", "discussion", "chat", "conversation", "about"],
      wordCountRange: { min: 2, max: 5 },
    },
  },
  {
    id: "language-no-preamble-001",
    name: "Language: English topic without 'Discussion about' preamble",
    input: {
      conversationText: `User: Let's figure out the seating chart for the wedding
User: We have 120 guests and 12 tables
User: The tricky part is keeping the two families apart`,
      category: "casual",
    },
    expectedOutput: {
      nameContains: ["seating", "wedding", "table"],
      nameNotContains: ["discussion about", "chat about", "conversation about"],
      wordCountRange: { min: 2, max: 5 },
    },
  },
  {
    id: "edge-code-heavy-001",
    name: "Edge: Heavy code content",
    input: {
      conversationText: `User: Getting this error:
\`\`\`
TypeError: Cannot read property 'map' of undefined
    at UserList.render (UserList.tsx:42)
\`\`\`
User: The users array is coming back as undefined from the API
User: Need to add a null check or fix the API response`,
      category: "technical",
    },
    expectedOutput: {
      nameContains: ["error", "undefined", "bug", "fix"],
      wordCountRange: { min: 2, max: 5 },
    },
  },
]
