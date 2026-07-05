/**
 * Memo Classifier Test Cases
 *
 * Derived from real production failures: a long-running Swedish DM where the
 * classifier let news hot-takes, model-release chatter, and trip logistics
 * through as "knowledge" (all paraphrased — no verbatim user content).
 */

import type { EvalCase } from "../../framework/types"
import type { MemoClassifierInput, MemoClassifierExpected } from "./types"

const KRIS = { authorId: "usr_eval_a", authorType: "user" as const, authorName: "Kim" }
const PIERRE = { authorId: "usr_eval_b", authorType: "user" as const, authorName: "Pelle" }

export const memoClassifierCases: EvalCase<MemoClassifierInput, MemoClassifierExpected>[] = [
  {
    id: "news-hot-takes-001",
    name: "News reactions: CEO gossip is not knowledge",
    input: {
      topicSummary: "AI-bolagens VD:ar",
      category: "news-reactions",
      messages: [
        { ...PIERRE, contentMarkdown: "shit vad jag inte gillar deras VD dock", minutesAgo: 20 },
        { ...KRIS, contentMarkdown: "Han är weird", minutesAgo: 18 },
        { ...PIERRE, contentMarkdown: "börjar klaga på open-weight modeller etc", minutesAgo: 17 },
        { ...KRIS, contentMarkdown: "Jävla savior complex också", minutesAgo: 15 },
        {
          ...PIERRE,
          contentMarkdown: "Inte läst att de stoppade sin AI som övervakade alla anställda? Helt absurt",
          minutesAgo: 12,
        },
        { ...KRIS, contentMarkdown: "Hade hatat att jobba där tror jag", minutesAgo: 10 },
        { ...PIERRE, contentMarkdown: "Samma här, aldrig varit ett företag av intresse", minutesAgo: 9 },
      ],
    },
    expectedOutput: { expectKnowledgeWorthy: false },
  },

  {
    id: "model-release-chatter-001",
    name: "News reactions: model release hot-takes are not knowledge",
    input: {
      topicSummary: "Nya modellsläpp",
      category: "news-reactions",
      messages: [
        { ...PIERRE, contentMarkdown: "Nya modellen verkar lite meh?", minutesAgo: 30 },
        { ...KRIS, contentMarkdown: "Inte testat än, ska kika imorgon", minutesAgo: 25 },
        {
          ...KRIS,
          contentMarkdown: "vem bryr sig när vi strax får tillbaka flaggskeppet? https://example.com/news/redeploy",
          minutesAgo: 20,
        },
        { ...PIERRE, contentMarkdown: "såg det, trist med 50% av weekly usage bara", minutesAgo: 15 },
        { ...KRIS, contentMarkdown: "Ja verkligen, antar att de sett folk maxxa quotan", minutesAgo: 12 },
      ],
    },
    expectedOutput: { expectKnowledgeWorthy: false },
  },

  {
    id: "trip-logistics-001",
    name: "Logistics: settled meetup plans are ephemeral, not knowledge",
    input: {
      topicSummary: "Träff imorgon kväll",
      category: "logistics",
      messages: [
        { ...PIERRE, contentMarkdown: "btw, hur många timmar har jag dig imorgon? :laughing:", minutesAgo: 20 },
        { ...KRIS, contentMarkdown: "Haha inte för sent, men kan säkert ta en buss runt nio?", minutesAgo: 18 },
        { ...KRIS, contentMarkdown: "Och kanske vara i stan halv sex?", minutesAgo: 16 },
        { ...PIERRE, contentMarkdown: "det låter som en plan", minutesAgo: 14 },
        { ...PIERRE, contentMarkdown: "Något med uteservering om det är bra väder", minutesAgo: 12 },
        { ...KRIS, contentMarkdown: "100%, kan kika på vilka som verkar rimliga", minutesAgo: 10 },
      ],
    },
    expectedOutput: { expectKnowledgeWorthy: false },
  },

  {
    id: "greeting-banter-001",
    name: "Chatter: reactions and banter produce no memo",
    input: {
      topicSummary: "Vardagssnack",
      category: "chatter",
      messages: [
        { ...KRIS, contentMarkdown: "haha, damn", minutesAgo: 10 },
        { ...PIERRE, contentMarkdown: "eller hur hahah", minutesAgo: 8 },
        { ...KRIS, contentMarkdown: ":shrug:", minutesAgo: 6 },
        { ...PIERRE, contentMarkdown: "sant, rip", minutesAgo: 4 },
      ],
    },
    expectedOutput: { expectKnowledgeWorthy: false },
  },

  {
    id: "procedure-setup-001",
    name: "Knowledge: a working setup with the how is worth keeping",
    input: {
      topicSummary: "pi-remote setup",
      category: "knowledge",
      messages: [
        { ...KRIS, contentMarkdown: "Funderar på om man kan köra en liten VPS med agenten?", minutesAgo: 30 },
        {
          ...PIERRE,
          contentMarkdown: "klart, jag satte upp https://github.com/example/pi-remote — funkar direkt",
          minutesAgo: 28,
        },
        { ...KRIS, contentMarkdown: "Kör du den lokalt då eller på VPS?", minutesAgo: 25 },
        {
          ...PIERRE,
          contentMarkdown: "jag kör det lokalt på min stationära, via tailscale. Noll config utöver auth-nyckeln",
          minutesAgo: 22,
        },
        { ...KRIS, contentMarkdown: "Ah smart, då slipper man exponera något publikt", minutesAgo: 20 },
      ],
    },
    expectedOutput: { expectKnowledgeWorthy: true },
  },

  {
    id: "decision-measured-001",
    name: "Knowledge: a measured decision with rationale is worth keeping",
    input: {
      topicSummary: "pgvector index-tuning",
      category: "knowledge",
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
    expectedOutput: { expectKnowledgeWorthy: true },
  },

  {
    id: "mixed-banter-one-fact-001",
    name: "Mixed: mostly banter with one durable fact is still worthy (memorizer selects)",
    input: {
      topicSummary: "Remote-agent snack",
      category: "mixed",
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
    expectedOutput: { expectKnowledgeWorthy: true },
  },

  {
    id: "revision-no-new-001",
    name: "Revision: rephrased already-captured facts do not warrant revision",
    input: {
      topicSummary: "Modellnyheter",
      category: "revision",
      existingMemos: [
        {
          title: "Flaggskeppsmodellen återlanseras med 50% weekly usage",
          abstract:
            "Modellen kommer tillbaka efter pausen men med halverad weekly quota; Kim och Pelle tror det beror på att folk maxxade flera subscriptions.",
          createdDaysAgo: 0,
        },
        {
          title: "Labbet har frångått sitt gamla modellnamn",
          abstract: "Labbet verkar själva ha slutat använda det gamla modellnamnet de tidigare stämt andra kring.",
          createdDaysAgo: 0,
        },
      ],
      messages: [
        { ...KRIS, contentMarkdown: "alltså 50% quota känns fortfarande snålt", minutesAgo: 10 },
        { ...PIERRE, contentMarkdown: "ja fast bättre än inget, den är ju tillbaka iaf", minutesAgo: 8 },
        { ...KRIS, contentMarkdown: "sant. Och lol att de inte ens använder namnet själva längre", minutesAgo: 5 },
      ],
    },
    expectedOutput: { expectKnowledgeWorthy: false, expectReviseExisting: false },
  },

  {
    id: "revision-new-fact-001",
    name: "Revision: a genuinely new durable fact warrants revision",
    input: {
      topicSummary: "pi-remote setup",
      category: "revision",
      existingMemos: [
        {
          title: "Pelle kör pi-remote lokalt via Tailscale",
          abstract: "Pelle kör pi-remote på sin stationära och når den via Tailscale, ingen publik endpoint behövs.",
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
    expectedOutput: { expectKnowledgeWorthy: true, expectReviseExisting: true },
  },
]
