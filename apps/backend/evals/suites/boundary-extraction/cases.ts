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

  {
    id: "new-topic-after-resolved-001",
    name: "New topic: Unrelated message after a resolved conversation",
    input: {
      newMessage: {
        authorId: "user_abc123",
        authorType: "user",
        contentMarkdown: "Switching gears — can someone review my PR for the new billing export?",
      },
      activeConversations: [
        {
          id: "conv_deploy_done001",
          topicSummary: "Deployment pipeline issues",
          messageCount: 8,
          lastMessagePreview: "Perfect, that fixed it! Thanks everyone.",
          participantIds: ["user_abc123", "user_def456"],
          completenessScore: 7,
          status: "resolved",
        },
      ],
      recentMessages: [
        {
          authorId: "user_def456",
          authorType: "user",
          contentMarkdown: "Perfect, that fixed it! Thanks everyone.",
        },
      ],
      streamType: "channel",
      category: "new-topic",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["billing", "export", "PR", "review"],
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
      // Topic must reuse the source conversation's Swedish wording, not translate to English
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

  // Quote-reply: explicit reply continues the quoted message's conversation,
  // even when a different conversation is the most recent one in the stream.
  {
    id: "reply-quote-continues-quoted-conv-001",
    name: "Reply: quote-reply joins quoted message's conversation, not the most recent",
    input: {
      newMessage: {
        authorId: "user_def456",
        authorType: "user",
        contentMarkdown: "samma här, kör på det",
      },
      activeConversations: [
        {
          id: "conv_buss",
          topicSummary: "Buss nio imorgon",
          messageCount: 8,
          lastMessagePreview: "samma här",
          participantIds: ["user_abc123", "user_def456"],
          completenessScore: 3,
        },
        {
          id: "conv_gpt",
          topicSummary: "gpt down?",
          messageCount: 2,
          lastMessagePreview: "nvm, fungerar nu",
          participantIds: ["user_abc123", "user_def456"],
          completenessScore: 5,
        },
      ],
      recentMessages: [
        { authorId: "user_abc123", authorType: "user", contentMarkdown: "wtf. gpt down?" },
        { authorId: "user_def456", authorType: "user", contentMarkdown: "nvm, fungerar nu" },
      ],
      replyTargets: [
        {
          quotedMessageId: "msg_buss_last",
          conversationId: "conv_buss",
          topicSummary: "Buss nio imorgon",
          snippet: "Kan kika lite på vilka uteserveringar som kan verka rimliga",
        },
      ],
      streamType: "dm",
      category: "reply",
    },
    expectedOutput: {
      // The quote-reply targets conv_buss; it must win over the more recent conv_gpt.
      expectConversationId: "conv_buss",
      minConfidence: 0.7,
    },
  },

  // Continuity: a short acknowledgement from the OTHER participant continues the
  // active exchange rather than spawning its own singleton conversation.
  {
    id: "continuity-short-ack-001",
    name: "Continuity: short reply continues active back-and-forth",
    input: {
      newMessage: {
        authorId: "user_def456",
        authorType: "user",
        contentMarkdown: ":fire: tokens",
      },
      activeConversations: [
        {
          id: "conv_exsules",
          topicSummary: "exsules API/GraphQL",
          messageCount: 6,
          lastMessagePreview: "mer att AI blir förvirrad och slösar tokens lol",
          participantIds: ["user_abc123", "user_def456"],
          completenessScore: 3,
        },
      ],
      recentMessages: [
        {
          authorId: "user_abc123",
          authorType: "user",
          contentMarkdown: "finns bara en remote, just nu dock",
        },
        {
          authorId: "user_abc123",
          authorType: "user",
          contentMarkdown: "mer att AI blir förvirrad och slösar tokens lol",
        },
      ],
      streamType: "dm",
      category: "continuity",
    },
    expectedOutput: {
      // ":fire: tokens" reacts to the "slösar tokens" line — stays in the exchange.
      expectConversationId: "conv_exsules",
      minConfidence: 0.6,
    },
  },

  // Session gaps: DMs happen in sessions. A message that opens a new subject a
  // day after the stream's last activity starts a NEW conversation, even though
  // the stale conversation holds every message in the recent window. This is
  // the prod mega-conversation failure: one DM conversation absorbing six days
  // of unrelated sessions because the extractor had no time signal.
  {
    id: "session-gap-next-day-new-topic-001",
    name: "Session gap: next-day message on a new subject leaves the stale conversation",
    input: {
      newMessage: {
        authorId: "user_kris",
        authorType: "user",
        contentMarkdown: "Helt sjukt, min agent har bränt 4GB mobildata på en dag. Det är ju bara text?!",
      },
      activeConversations: [
        {
          id: "conv_grillkvall",
          topicSummary: "Grillkväll på lördag",
          messageCount: 14,
          lastMessagePreview: "kör vi 17 då, jag tar med kol",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 1560, // 26h — yesterday evening's session
        },
      ],
      recentMessages: [
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "ska vi säga lördag eftermiddag?",
          minutesAgo: 1575,
        },
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "ja perfekt",
          minutesAgo: 1570,
        },
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "kör vi 17 då, jag tar med kol",
          minutesAgo: 1560,
        },
      ],
      streamType: "dm",
      category: "session-gap",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["data", "agent", "mobildata"],
      minConfidence: 0.6,
    },
  },

  {
    id: "session-gap-resolved-stale-001",
    name: "Session gap: casual opener two days after a resolved conversation",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "Såg att nya Gemini släpps idag, benchmarks ser galna ut",
      },
      activeConversations: [
        {
          id: "conv_tagresa",
          topicSummary: "Tågresa till Berlin",
          messageCount: 22,
          lastMessagePreview: "biljetterna bokade, kvitto i mejlen",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 7,
          status: "resolved",
          lastActivityMinutesAgo: 2880, // 2 days
        },
      ],
      recentMessages: [
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "biljetterna bokade, kvitto i mejlen",
          minutesAgo: 2880,
        },
      ],
      streamType: "dm",
      category: "session-gap",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["gemini"],
      minConfidence: 0.6,
    },
  },

  // Counter-case: a gap alone is not a boundary. A message that directly
  // answers the stale conversation's open question continues it — the fix must
  // not overcorrect into fragmenting slow-paced exchanges.
  {
    id: "session-gap-direct-answer-001",
    name: "Session gap: next-morning answer to an open question continues the conversation",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "Inte än, vi åker upp på torsdag. Ska packa ikväll",
      },
      activeConversations: [
        {
          id: "conv_stugan",
          topicSummary: "Stugan vecka 28",
          messageCount: 9,
          lastMessagePreview: "Är ni uppe i stugan nu?",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 3,
          lastActivityMinutesAgo: 540, // 9h — question asked last night
        },
      ],
      recentMessages: [
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Är ni uppe i stugan nu?",
          minutesAgo: 540,
        },
      ],
      streamType: "dm",
      category: "session-gap",
    },
    expectedOutput: {
      expectConversationId: "conv_stugan",
      minConfidence: 0.6,
    },
  },

  // Counter-case: explicit topic revival. Days later, a message that names the
  // old conversation's concrete subject resumes THAT conversation — not the
  // fresher unrelated one, and not a new singleton.
  {
    id: "session-gap-topic-revival-001",
    name: "Session gap: explicit revival rejoins the days-old conversation about that subject",
    input: {
      newMessage: {
        authorId: "user_kris",
        authorType: "user",
        contentMarkdown: "Har du kvar din zellij-setup förresten? Tänkte testa den på servern",
      },
      activeConversations: [
        {
          id: "conv_zellij",
          topicSummary: "zellij-setup",
          messageCount: 12,
          lastMessagePreview: "kör med den dagligen nu, funkar fint",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 6,
          lastActivityMinutesAgo: 4320, // 3 days
        },
        {
          id: "conv_lunch",
          topicSummary: "Lunch imorgon",
          messageCount: 4,
          lastMessagePreview: "12:30 funkar",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 60,
        },
      ],
      recentMessages: [
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "12:30 funkar",
          minutesAgo: 60,
        },
      ],
      streamType: "dm",
      category: "session-gap",
    },
    expectedOutput: {
      expectConversationId: "conv_zellij",
      minConfidence: 0.6,
    },
  },

  // A short enthusiastic opener hours after an unrelated discussion is a new
  // topic, not a continuation — brevity is only a continuity signal in a LIVE
  // exchange.
  {
    id: "session-gap-short-opener-001",
    name: "Session gap: short opener on a new subject after hours of quiet",
    input: {
      newMessage: {
        authorId: "user_kris",
        authorType: "user",
        contentMarkdown: "Shit vad fjärrstyrningen är nice",
      },
      activeConversations: [
        {
          id: "conv_lakemedel",
          topicSummary: "AI-läkemedelsnyheten",
          messageCount: 18,
          lastMessagePreview: "ja, känns som hype men vi får se",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 390, // 6.5h
        },
      ],
      recentMessages: [
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "ja, känns som hype men vi får se",
          minutesAgo: 390,
        },
      ],
      streamType: "dm",
      category: "session-gap",
    },
    expectedOutput: {
      expectNewConversation: true,
      minConfidence: 0.5,
    },
  },

  // The absorption guard at scale: a huge, day-stale conversation must not
  // swallow an unrelated message just because it owns every message in the
  // recent window and nothing else is listed.
  {
    id: "session-gap-mega-conversation-001",
    name: "Session gap: day-old mega-conversation does not absorb an unrelated message",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "Du, har du nån bra mall för konsultavtal? Fick en förfrågan igår",
      },
      activeConversations: [
        {
          id: "conv_semester",
          topicSummary: "Semesterplaner juli",
          messageCount: 79,
          lastMessagePreview: "haha ja, klassiskt",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 1740, // 29h
        },
      ],
      recentMessages: [
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "vi kör måndag som sagt då",
          minutesAgo: 1750,
        },
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "yes",
          minutesAgo: 1745,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "haha ja, klassiskt",
          minutesAgo: 1740,
        },
      ],
      streamType: "dm",
      category: "session-gap",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["konsultavtal", "avtal", "mall"],
      minConfidence: 0.6,
    },
  },

  // ── Live-session pivots ──────────────────────────────────────────────────
  // Modeled on real prod failures in a long-running DM: an all-day live
  // session drifts through many subjects, and the extractor glued every one
  // of them onto a single conversation (79 messages / 6 days / ~8 topics).
  // A session is not a conversation — a pivot mid-session must start a new
  // conversation even though the last message is only minutes old.

  {
    id: "live-pivot-btw-001",
    name: "Live pivot: 'btw' question mid-session opens a new conversation",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "btw, hur många timmar har jag dig imorgon? :laughing:",
      },
      activeConversations: [
        {
          id: "conv_cleanup01",
          topicSummary: "Stora deletes i monorepot",
          messageCount: 9,
          lastMessagePreview: "Man mår så bra av stora deletes!",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 4,
          lastActivityMinutesAgo: 2,
        },
      ],
      recentMessages: [
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "det känns som en `rm -rf *` ju haha",
          minutesAgo: 4,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Hehe galet mycket skräp bara, mest gamla testdumpar",
          minutesAgo: 3,
        },
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "ah, men ändå, känns bra",
          minutesAgo: 2,
        },
      ],
      streamType: "dm",
      category: "topic-shift",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["imorgon", "timmar", "träff", "planer"],
      minConfidence: 0.5,
    },
  },

  {
    id: "live-pivot-new-subject-001",
    name: "Live pivot: pasted diff stats mid-banter opens a new conversation",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "Detta känns fint `98 files changed, 214 insertions(+), 7402 deletions(-)`",
      },
      activeConversations: [
        {
          id: "conv_fashion01",
          topicSummary: "Absurda designerpriser",
          messageCount: 11,
          lastMessagePreview: "Inte ens särskilt speciell liksom",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 4,
          lastActivityMinutesAgo: 3,
        },
      ],
      recentMessages: [
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "även om man har cash, varför betala 14000 för en t-shirt? wtf",
          minutesAgo: 6,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Ingen som helst aning om varför",
          minutesAgo: 4,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Inte ens särskilt speciell liksom",
          minutesAgo: 3,
        },
      ],
      streamType: "dm",
      category: "topic-shift",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["delet", "cleanup", "rensning", "files", "diff", "kod"],
      minConfidence: 0.5,
    },
  },

  {
    id: "live-pivot-mid-blob-001",
    name: "Live pivot: new subject does not join the sprawling live conversation",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "Shit vad remote pi är nice",
      },
      activeConversations: [
        {
          id: "conv_blob01",
          topicSummary: "Smögen imorgon eftermiddag",
          messageCount: 72,
          lastMessagePreview: "De har väl själva frångått det också?",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 30,
        },
      ],
      recentMessages: [
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "ye, de hade ju stämt någon för namnet, visste inte ens att de brydde sig",
          minutesAgo: 35,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Helt sjukt",
          minutesAgo: 31,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "De har väl själva frångått det också?",
          minutesAgo: 30,
        },
      ],
      streamType: "dm",
      category: "topic-shift",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["remote pi", "pi"],
      minConfidence: 0.5,
    },
  },

  {
    id: "live-reaction-continues-001",
    name: "Live continuity: bare ':shrug:' seconds after an exchange is not a singleton",
    input: {
      newMessage: {
        authorId: "user_kris",
        authorType: "user",
        contentMarkdown: ":shrug:",
      },
      activeConversations: [
        {
          id: "conv_oldpc01",
          topicSummary: "Gamla stationära som hemmaserver",
          messageCount: 6,
          lastMessagePreview: "Om man bara inte startar om den så är det väl fine",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 3,
          lastActivityMinutesAgo: 1,
        },
      ],
      recentMessages: [
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Har en gammal gamingdator från typ 2016 som inte är särskilt pigg längre",
          minutesAgo: 3,
        },
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "kör en lätt distro på den bara så puttrar den nog fint",
          minutesAgo: 2,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Om man bara inte startar om den så är det väl fine",
          minutesAgo: 1,
        },
      ],
      streamType: "dm",
      category: "continuity",
    },
    expectedOutput: {
      expectConversationId: "conv_oldpc01",
      minConfidence: 0.5,
    },
  },

  // ── Merge resistance ─────────────────────────────────────────────────────
  // The reassignment instruction ("move the smaller one into the larger")
  // must not let a sprawling conversation swallow a focused one just because
  // they share a session and participants.

  {
    id: "no-merge-focused-into-blob-001",
    name: "Merge resistance: focused conversation is not folded into the live blob",
    input: {
      newMessage: {
        authorId: "user_kris",
        authorType: "user",
        contentMarkdown: "Testade med lists=200 nu, recall uppe på 0.94 utan att latensen stack iväg",
      },
      activeConversations: [
        {
          id: "conv_blob02",
          topicSummary: "Helgplaner och AI-nyheter",
          messageCount: 64,
          lastMessagePreview: "haha ja, vi får se på söndag",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 8,
          contextMessageIds: ["msg_blob_001"],
        },
        {
          id: "conv_pgvector01",
          topicSummary: "pgvector index-tuning",
          messageCount: 4,
          lastMessagePreview: "ivfflat med fler lists borde hjälpa",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 3,
          lastActivityMinutesAgo: 12,
          contextMessageIds: ["msg_pgv_001", "msg_pgv_002"],
        },
      ],
      recentMessages: [
        {
          id: "msg_pgv_001",
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "recall på embedding-sökningen ligger på typ 0.71, känns lågt",
          minutesAgo: 20,
        },
        {
          id: "msg_pgv_002",
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "ivfflat med fler lists borde hjälpa",
          minutesAgo: 12,
        },
        {
          id: "msg_blob_001",
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "haha ja, vi får se på söndag",
          minutesAgo: 8,
        },
      ],
      streamType: "dm",
      category: "merge-resistance",
    },
    expectedOutput: {
      expectConversationId: "conv_pgvector01",
      expectNoReassignments: true,
      minConfidence: 0.6,
    },
  },

  {
    id: "split-out-sandwich-001",
    name: "Sandwich split: follow-up reveals a mid-exchange message opened a new topic",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "Ja! Deras pad thai är helt sjukt bra, tog den två gånger förra veckan",
      },
      activeConversations: [
        {
          id: "conv_deploy02",
          topicSummary: "Staging-deployen som failar",
          messageCount: 6,
          lastMessagePreview: "Har någon testat nya thai-stället på Hornsgatan?",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 3,
          lastActivityMinutesAgo: 2,
          contextMessageIds: ["msg_dep_001", "msg_dep_002", "msg_thai_001"],
        },
      ],
      recentMessages: [
        {
          id: "msg_dep_001",
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "staging failar fortfarande på migrations-steget",
          minutesAgo: 6,
        },
        {
          id: "msg_dep_002",
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "kolla om det är samma lock-timeout som sist",
          minutesAgo: 5,
        },
        {
          id: "msg_thai_001",
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Har någon testat nya thai-stället på Hornsgatan?",
          minutesAgo: 2,
        },
      ],
      streamType: "dm",
      category: "merge-resistance",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["thai", "Hornsgatan", "lunch", "mat"],
      expectReassignedMessageIds: ["msg_thai_001"],
      minConfidence: 0.5,
    },
  },

  // ── Session gaps against a large stale conversation ─────────────────────
  // The prod blob absorbed messages across >24h gaps. A big candidate with a
  // stale trip-planning title must not attract an unrelated opener; an
  // explicit by-name resume must still find its (smaller, older) topic.

  {
    id: "gap-26h-new-opener-001",
    name: "Session gap: new subject 26h later leaves the big trip conversation alone",
    input: {
      newMessage: {
        authorId: "user_kris",
        authorType: "user",
        contentMarkdown:
          "Är inte det här helt sjukt. Claude har alltså ätit 3.9GB data på 5G den här månaden. Det är bara text!",
      },
      activeConversations: [
        {
          id: "conv_trip01",
          topicSummary: "Smögen imorgon eftermiddag",
          messageCount: 16,
          lastMessagePreview: "oh, nice",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 1560,
        },
      ],
      recentMessages: [
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Inte än, men vi ska till Hälsingland idag",
          minutesAgo: 1980,
        },
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "oh, nice",
          minutesAgo: 1560,
        },
      ],
      streamType: "dm",
      category: "session-gap",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["Claude", "data", "5G"],
      minConfidence: 0.6,
    },
  },

  {
    id: "gap-explicit-resume-001",
    name: "Session gap: by-name question resumes the right stale conversation, not the blob",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "Har du fortfarande opencode go?",
      },
      activeConversations: [
        {
          id: "conv_blob03",
          topicSummary: "Smögen imorgon eftermiddag",
          messageCount: 24,
          lastMessagePreview: "Jag hade inte varit förvånad om de glömt slå på gzip",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 1740,
        },
        {
          id: "conv_opencode01",
          topicSummary: "opencode go setup",
          messageCount: 9,
          lastMessagePreview: "kör den via tmux så länge, funkar förvånansvärt bra",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 4,
          status: "stalled",
          lastActivityMinutesAgo: 4320,
        },
      ],
      recentMessages: [
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Och jag skulle gissa att varje load drar ner ALLT också",
          minutesAgo: 1750,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Jag hade inte varit förvånad om de glömt slå på gzip",
          minutesAgo: 1740,
        },
      ],
      streamType: "dm",
      category: "session-gap",
    },
    expectedOutput: {
      expectConversationId: "conv_opencode01",
      minConfidence: 0.5,
    },
  },

  {
    id: "gap-4h-topic-reference-001",
    name: "Session gap: 4h-late reply that names the topic continues its conversation",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "vadå, köper folk i tech de där tröjorna på riktigt?",
      },
      activeConversations: [
        {
          id: "conv_fashion02",
          topicSummary: "Absurda designerpriser",
          messageCount: 5,
          lastMessagePreview: "Tänk att få gräsfläckar på en sån",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 3,
          lastActivityMinutesAgo: 240,
        },
      ],
      recentMessages: [
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Eller fuck, 14000kr https://example.com/quadrige-embroidered-t-shirt",
          minutesAgo: 245,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Tänk att få gräsfläckar på en sån",
          minutesAgo: 240,
        },
      ],
      streamType: "dm",
      category: "session-gap",
    },
    expectedOutput: {
      expectConversationId: "conv_fashion02",
      minConfidence: 0.5,
    },
  },

  // ── Summary-bearing variants ─────────────────────────────────────────────
  // Same volatile scenarios, but candidates carry the rolling "covers:"
  // summary the extractor now maintains. Measures whether summaries firm up
  // the live-pivot and merge decisions the title-only variants get wrong.

  {
    id: "live-pivot-new-subject-sum-001",
    name: "Live pivot with summaries: pasted diff stats mid-banter opens a new conversation",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "Detta känns fint `98 files changed, 214 insertions(+), 7402 deletions(-)`",
      },
      activeConversations: [
        {
          id: "conv_fashion01",
          topicSummary: "Absurda designerpriser",
          summary:
            "Skämt om absurda designerpriser: en broderad t-shirt för 14000kr och vem som egentligen köper sånt. Rent skvaller, inget beslut.",
          messageCount: 11,
          lastMessagePreview: "Inte ens särskilt speciell liksom",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 4,
          lastActivityMinutesAgo: 3,
        },
      ],
      recentMessages: [
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "även om man har cash, varför betala 14000 för en t-shirt? wtf",
          minutesAgo: 6,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Ingen som helst aning om varför",
          minutesAgo: 4,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Inte ens särskilt speciell liksom",
          minutesAgo: 3,
        },
      ],
      streamType: "dm",
      category: "topic-shift",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["delet", "cleanup", "rensning", "files", "diff", "kod"],
      minConfidence: 0.5,
    },
  },

  {
    id: "live-pivot-mid-blob-sum-001",
    name: "Live pivot with summaries: new subject does not join the sprawling conversation",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "Shit vad remote pi är nice",
      },
      activeConversations: [
        {
          id: "conv_blob01",
          topicSummary: "Smögen imorgon eftermiddag",
          summary:
            "Började som helgplaner kring Smögen, gled över i modellnyheter och sedan AI-bolagens VD:ar och stämningen kring dem. Spretigt, inget avslut.",
          messageCount: 72,
          lastMessagePreview: "De har väl själva frångått det också?",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 30,
        },
      ],
      recentMessages: [
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "ye, de hade ju stämt någon för namnet, visste inte ens att de brydde sig",
          minutesAgo: 35,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Helt sjukt",
          minutesAgo: 31,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "De har väl själva frångått det också?",
          minutesAgo: 30,
        },
      ],
      streamType: "dm",
      category: "topic-shift",
    },
    expectedOutput: {
      expectNewConversation: true,
      topicContains: ["remote pi", "pi"],
      minConfidence: 0.5,
    },
  },

  {
    id: "no-merge-focused-into-blob-sum-001",
    name: "Merge resistance with summaries: focused conversation stays separate",
    input: {
      newMessage: {
        authorId: "user_kris",
        authorType: "user",
        contentMarkdown: "Testade med lists=200 nu, recall uppe på 0.94 utan att latensen stack iväg",
      },
      activeConversations: [
        {
          id: "conv_blob02",
          topicSummary: "Helgplaner och AI-nyheter",
          summary:
            "Löst snack om helgplaner (söndag nämnd) blandat med reaktioner på veckans AI-nyheter. Inget konkret bestämt.",
          messageCount: 64,
          lastMessagePreview: "haha ja, vi får se på söndag",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 8,
          contextMessageIds: ["msg_blob_001"],
        },
        {
          id: "conv_pgvector01",
          topicSummary: "pgvector index-tuning",
          summary:
            "Embedding-sökningens recall låg på 0.71; ivfflat med fler lists föreslogs som fix. Väntar på testresultat.",
          messageCount: 4,
          lastMessagePreview: "ivfflat med fler lists borde hjälpa",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 3,
          lastActivityMinutesAgo: 12,
          contextMessageIds: ["msg_pgv_001", "msg_pgv_002"],
        },
      ],
      recentMessages: [
        {
          id: "msg_pgv_001",
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "recall på embedding-sökningen ligger på typ 0.71, känns lågt",
          minutesAgo: 20,
        },
        {
          id: "msg_pgv_002",
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "ivfflat med fler lists borde hjälpa",
          minutesAgo: 12,
        },
        {
          id: "msg_blob_001",
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "haha ja, vi får se på söndag",
          minutesAgo: 8,
        },
      ],
      streamType: "dm",
      category: "merge-resistance",
    },
    expectedOutput: {
      expectConversationId: "conv_pgvector01",
      expectNoReassignments: true,
      minConfidence: 0.6,
    },
  },

  // ── Entity-magnet resistance ─────────────────────────────────────────────
  // The reported prod failure: several distinct conversations that all mention
  // the model "Fable" (peripherally) collapsed into one conversation titled
  // "Fable". A shared named entity is a subject, not a topic — a different
  // question about the same name is a new conversation, and a fresh topic about
  // a recurring name must be titled by its aspect, not the bare name.

  {
    id: "entity-magnet-distinct-aspect-001",
    name: "Entity magnet: a different question about the same model opens a new conversation",
    input: {
      newMessage: {
        authorId: "user_kris",
        authorType: "user",
        contentMarkdown: "Btw, hur bra är Fable på svenska egentligen? Funderar på att köra den för kundmejlen",
      },
      activeConversations: [
        {
          id: "conv_fable_pris",
          topicSummary: "Fable-priser",
          summary:
            "Jämför Fable:s token-priser mot GPT för batch-jobb; output billigare, input dyrare. Öppen fråga exakt hur mycket dyrare input är.",
          messageCount: 9,
          lastMessagePreview: "ja input-priset är det enda som skaver",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 3,
          contextMessageIds: ["msg_fpris_001", "msg_fpris_002"],
        },
      ],
      recentMessages: [
        {
          id: "msg_fpris_001",
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "output-priset är typ halva GPT:s iallafall",
          minutesAgo: 5,
        },
        {
          id: "msg_fpris_002",
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "ja input-priset är det enda som skaver",
          minutesAgo: 3,
        },
      ],
      streamType: "dm",
      category: "merge-resistance",
    },
    expectedOutput: {
      // Same entity (Fable), different aspect (Swedish quality for support email)
      // → a new conversation, and no collateral merge of the pricing thread.
      expectNewConversation: true,
      topicContains: ["svenska", "kundmejl", "kvalitet", "ton"],
      expectNoReassignments: true,
      minConfidence: 0.5,
    },
  },

  {
    id: "entity-magnet-name-aspect-001",
    name: "Entity magnet: fresh topic about a recurring model is named by its aspect, not the bare name",
    input: {
      newMessage: {
        authorId: "user_kris",
        authorType: "user",
        contentMarkdown:
          "Fable verkar ha extremt lång kontext nu, typ 2M tokens. Undrar hur bra recall den har på riktigt",
      },
      activeConversations: [],
      streamType: "dm",
      category: "new-topic",
    },
    expectedOutput: {
      expectNewConversation: true,
      // Title must carry the aspect (context/recall), not just "Fable".
      topicContains: ["kontext", "context", "recall", "token"],
      minConfidence: 0.6,
    },
  },

  {
    id: "entity-magnet-same-aspect-continues-001",
    name: "Entity continuity: a message advancing the same aspect stays in the conversation",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "kollade nyss, input ligger på 3x GPT faktiskt, inte 2x",
      },
      activeConversations: [
        {
          id: "conv_fable_pris",
          topicSummary: "Fable-priser",
          summary:
            "Jämför Fable:s token-priser mot GPT för batch-jobb; output billigare, input dyrare — exakt hur mycket dyrare är en öppen fråga.",
          messageCount: 9,
          lastMessagePreview: "input-priset är det enda som skaver",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 2,
        },
      ],
      recentMessages: [
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "output-priset är typ halva GPT:s",
          minutesAgo: 4,
        },
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "input-priset är det enda som skaver",
          minutesAgo: 2,
        },
      ],
      streamType: "dm",
      category: "continue-existing",
    },
    expectedOutput: {
      // Directly advances the same open pricing question → continues, no split.
      expectConversationId: "conv_fable_pris",
      minConfidence: 0.6,
    },
  },

  {
    id: "resolution-settled-plan-sv-001",
    name: "Resolution: agreed plan marks the conversation settled (Swedish)",
    input: {
      newMessage: {
        authorId: "user_pierre",
        authorType: "user",
        contentMarkdown: "det låter som en plan :+1:",
      },
      activeConversations: [
        {
          id: "conv_meetup01",
          topicSummary: "Träff imorgon kväll",
          messageCount: 7,
          lastMessagePreview: "Och kanske vara i Slussen halv sex?",
          participantIds: ["user_kris", "user_pierre"],
          completenessScore: 5,
          lastActivityMinutesAgo: 1,
        },
      ],
      recentMessages: [
        {
          authorId: "user_pierre",
          authorType: "user",
          contentMarkdown: "btw, hur många timmar har jag dig imorgon? :laughing:",
          minutesAgo: 5,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Haha inte för sent, men kan säkert ta en buss runt nio?",
          minutesAgo: 3,
        },
        {
          authorId: "user_kris",
          authorType: "user",
          contentMarkdown: "Och kanske vara i Slussen halv sex?",
          minutesAgo: 1,
        },
      ],
      streamType: "dm",
      category: "resolution",
    },
    expectedOutput: {
      expectConversationId: "conv_meetup01",
      expectCompletenessUpdate: [{ conversationId: "conv_meetup01", minScore: 6 }],
      minConfidence: 0.6,
    },
  },
]
