/**
 * Memorizer Test Cases
 *
 * Derived from real production failures: hot-takes stored as "learnings",
 * the same fact re-captured in new words on every re-extraction pass, and
 * banter memos ("Remote pi är riktigt nice" as a learning). Paraphrased.
 */

import type { EvalCase } from "../../framework/types"
import type { MemorizerInput, MemorizerExpected } from "./types"

const KRIS = { authorId: "usr_eval_a", authorType: "user" as const, authorName: "Kim" }
const PIERRE = { authorId: "usr_eval_b", authorType: "user" as const, authorName: "Pelle" }

export const memorizerCases: EvalCase<MemorizerInput, MemorizerExpected>[] = [
  {
    id: "mixed-extracts-only-fact-001",
    name: "Selectivity: banter around one durable fact yields only the fact",
    input: {
      category: "selectivity",
      messages: [
        { ...PIERRE, contentMarkdown: "Shit vad remote-setupen är nice", minutesAgo: 30 },
        { ...KRIS, contentMarkdown: "haha ja det ser ballt ut", minutesAgo: 28 },
        { ...PIERRE, contentMarkdown: "Ehh den första blev fel lol, det var något scam-mail", minutesAgo: 26 },
        { ...KRIS, contentMarkdown: "Kul med scams dock haha", minutesAgo: 24 },
        {
          ...PIERRE,
          contentMarkdown:
            "men alltså: den kör lokalt på min stationära via tailscale, så telefonen når den utan publik endpoint",
          minutesAgo: 20,
        },
        { ...KRIS, contentMarkdown: "det är ju exakt vad jag behöver för min gamla burk", minutesAgo: 18 },
      ],
    },
    expectedOutput: {
      maxMemos: 2,
      minMemos: 1,
      mustCoverAny: [["tailscale", "lokalt", "stationära"]],
      mustNotContain: ["nice", "scam", "ballt"],
    },
  },

  {
    id: "news-hot-takes-yields-nothing-001",
    name: "Selectivity: news reactions yield no memos even if classified worthy",
    input: {
      category: "selectivity",
      messages: [
        { ...PIERRE, contentMarkdown: "shit vad jag inte gillar deras VD dock", minutesAgo: 20 },
        { ...KRIS, contentMarkdown: "Han är weird, jävla savior complex", minutesAgo: 18 },
        {
          ...PIERRE,
          contentMarkdown: "Inte läst att de stoppade sin AI som övervakade alla anställda? Helt absurt",
          minutesAgo: 15,
        },
        { ...KRIS, contentMarkdown: "Hade hatat att jobba där", minutesAgo: 12 },
        { ...PIERRE, contentMarkdown: "Samma här, aldrig varit ett företag av intresse", minutesAgo: 10 },
      ],
    },
    expectedOutput: {
      maxMemos: 0,
    },
  },

  {
    id: "transient-status-yields-nothing-001",
    name: "Selectivity: an ephemeral 'broken right now' status produces no memo",
    input: {
      category: "transient",
      messages: [
        { ...KRIS, contentMarkdown: "btw view run är trasig just nu, bara vitt", minutesAgo: 12 },
        { ...PIERRE, contentMarkdown: "ah, throwar den något?", minutesAgo: 10 },
        { ...KRIS, contentMarkdown: "orkar inte kika nu, tar det sen", minutesAgo: 8 },
        { ...PIERRE, contentMarkdown: "ok", minutesAgo: 7 },
      ],
    },
    expectedOutput: {
      maxMemos: 0,
    },
  },

  {
    id: "tool-behavior-learning-captured-001",
    name: "Extraction: a validated tool-behavior learning that changed their practice is captured",
    input: {
      category: "extraction",
      messages: [
        {
          ...KRIS,
          contentMarkdown:
            "märkte en grej med agenten: säger jag inte tydligt nej så tolkar den vaga svar som go-ahead",
          minutesAgo: 30,
        },
        { ...PIERRE, contentMarkdown: "reproducerbart?", minutesAgo: 27 },
        {
          ...KRIS,
          contentMarkdown: "ja, konsekvent. Så nu skriver jag alltid ett explicit stopp när jag är osäker",
          minutesAgo: 22,
        },
        { ...PIERRE, contentMarkdown: "bra fynd, vi lägger in en explicit-nej-regel i prompten", minutesAgo: 18 },
      ],
    },
    expectedOutput: {
      maxMemos: 2,
      minMemos: 1,
      mustCoverAny: [["go-ahead", "vaga", "tolkar", "explicit", "stopp", "nej"]],
    },
  },

  {
    id: "revision-all-covered-001",
    name: "Revision: rephrased already-captured facts yield an empty set",
    input: {
      category: "revision",
      existingMemos: [
        {
          title: "Flaggskeppsmodellen återlanseras med 50% weekly usage",
          abstract:
            "Modellen kommer tillbaka efter pausen men med halverad weekly quota; Kim och Pelle tror det beror på att folk maxxade flera subscriptions.",
          createdDaysAgo: 0,
        },
        {
          title: "Pelle kör pi-remote lokalt via Tailscale",
          abstract: "Pelle kör pi-remote på sin stationära och når den via Tailscale utan publik endpoint.",
          createdDaysAgo: 0,
        },
      ],
      messages: [
        { ...KRIS, contentMarkdown: "alltså 50% quota känns fortfarande snålt", minutesAgo: 10 },
        { ...PIERRE, contentMarkdown: "ja fast bättre än inget, den är ju tillbaka iaf", minutesAgo: 8 },
        { ...KRIS, contentMarkdown: "och din tailscale-setup rullar fint fortfarande?", minutesAgo: 6 },
        { ...PIERRE, contentMarkdown: "yes, stationära + tailscale, inga problem", minutesAgo: 4 },
      ],
    },
    expectedOutput: {
      maxMemos: 0,
    },
  },

  {
    id: "revision-one-new-fact-001",
    name: "Revision: only the genuinely new fact is captured",
    input: {
      category: "revision",
      existingMemos: [
        {
          title: "Pelle kör pi-remote lokalt via Tailscale",
          abstract: "Pelle kör pi-remote på sin stationära och når den via Tailscale utan publik endpoint.",
          createdDaysAgo: 1,
        },
      ],
      messages: [
        {
          ...PIERRE,
          contentMarkdown:
            "uppdatering: flyttade pi-remote till en Hetzner-VPS igår, den stationära lät för mycket på natten",
          minutesAgo: 15,
        },
        { ...KRIS, contentMarkdown: "haha rimligt. Samma tailscale-upplägg?", minutesAgo: 12 },
        {
          ...PIERRE,
          contentMarkdown: "yes, exakt samma, bara en annan nod i tailnetet. CX22:an räcker gott",
          minutesAgo: 10,
        },
      ],
    },
    expectedOutput: {
      maxMemos: 2,
      minMemos: 1,
      mustCoverAny: [["Hetzner", "VPS"]],
    },
  },

  {
    id: "procedure-capture-001",
    name: "Extraction: a worked-out procedure is captured tersely, in Swedish",
    input: {
      category: "extraction",
      messages: [
        { ...KRIS, contentMarkdown: "recall på embedding-sökningen ligger på typ 0.71, känns lågt", minutesAgo: 40 },
        { ...PIERRE, contentMarkdown: "ivfflat med fler lists borde hjälpa", minutesAgo: 35 },
        {
          ...KRIS,
          contentMarkdown: "Testade med lists=200 nu, recall uppe på 0.94 utan att latensen stack iväg",
          minutesAgo: 10,
        },
        { ...PIERRE, contentMarkdown: "nice, kör på det", minutesAgo: 8 },
        { ...KRIS, contentMarkdown: "Yes, sätter 200 som default i migrationen", minutesAgo: 5 },
      ],
    },
    expectedOutput: {
      maxMemos: 2,
      minMemos: 1,
      mustCoverAny: [["lists", "ivfflat", "200"], ["recall"]],
    },
  },
]
