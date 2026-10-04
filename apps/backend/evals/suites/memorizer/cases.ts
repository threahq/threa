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
const DAY_MINUTES = 24 * 60
const daysAhead = (days: number) =>
  new Date(Date.now() + days * DAY_MINUTES * 60_000).toLocaleDateString("en-US", { month: "short", day: "numeric" })
const OFFSITE_DATES = `${daysAhead(60)} to ${daysAhead(62)}`

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

  // Derived from the July 2026 prod failure where one oscillating debate
  // produced seven contradictory decision memos and the surviving memo stated
  // the OPPOSITE of what was decided. Paraphrased structure, invented content.
  {
    id: "oscillating-debate-landing-001",
    name: "Extraction: a debate that swings back and forth yields only where it landed",
    input: {
      category: "extraction",
      messages: [
        { ...PIERRE, contentMarkdown: "fan, vad ska jag cachea sessioner i? funderar på Redis", minutesAgo: 45 },
        { ...KRIS, contentMarkdown: "kör Redis, standard", minutesAgo: 43 },
        { ...PIERRE, contentMarkdown: "exakt, Redis kör vi", minutesAgo: 42 },
        {
          ...KRIS,
          contentMarkdown: "fast vänta — vem driftar den? vi har ju ingen som vill äga en till burk",
          minutesAgo: 38,
        },
        { ...PIERRE, contentMarkdown: "true. in-process LRU räcker kanske? vi har ju bara en nod", minutesAgo: 35 },
        { ...KRIS, contentMarkdown: "men då tappar vi sessioner vid varje deploy, det suger", minutesAgo: 30 },
        { ...PIERRE, contentMarkdown: "hmm, så Redis ändå?", minutesAgo: 28 },
        {
          ...KRIS,
          contentMarkdown:
            "kollade just — vår host har managed Redis för en hundring i månaden, ingen drift alls för oss",
          minutesAgo: 15,
        },
        { ...PIERRE, contentMarkdown: "åh nice, då är driftargumentet dött. managed Redis, klart", minutesAgo: 12 },
        { ...KRIS, contentMarkdown: "kör på det, jag sätter upp den ikväll", minutesAgo: 10 },
      ],
    },
    expectedOutput: {
      maxMemos: 2,
      minMemos: 1,
      conclusionMustState: "They chose (managed) Redis for session caching",
      conclusionMustNotState: "They chose the in-process LRU cache / decided against Redis",
    },
  },

  {
    id: "fragment-pasted-answer-direction-001",
    name: "Extraction: a fragment with a pasted assistant answer must not invert the adopted conclusion",
    input: {
      category: "extraction",
      messages: [
        { ...PIERRE, contentMarkdown: "här är svaret från assistenten", minutesAgo: 12 },
        {
          ...PIERRE,
          contentMarkdown:
            "```plaintext\nGo with the managed queue. Self-hosting looks cheaper until you price the on-call burden — broker upgrades, disk pressure, partition rebalancing at 3am. A managed queue gives you DLQs and replay out of the box, and a two-person team should spend its hours on product, not broker ops. Self-hosting only wins under hard data-residency rules or extreme throughput, and you have neither.\n```",
          minutesAgo: 11,
        },
        {
          ...KRIS,
          contentMarkdown:
            "lol i princip mina argument men för managed. enda jag saknar är kostnadstaket, och det kan man ju larma på",
          minutesAgo: 5,
        },
        { ...KRIS, contentMarkdown: "jag köper det faktiskt", minutesAgo: 5 },
      ],
    },
    expectedOutput: {
      maxMemos: 2,
      conclusionMustNotState: "They chose to self-host the queue / decided against the managed queue",
    },
  },

  {
    id: "revision-reversal-supersedes-001",
    name: "Revision: a reversed decision retires the existing memo via supersedesMemoIds",
    input: {
      category: "revision",
      existingMemos: [
        {
          title: "Sessioner cachas i en in-process LRU",
          abstract:
            "De valde en in-process LRU för sessionscache i stället för Redis, för att slippa drifta en separat tjänst.",
          createdDaysAgo: 1,
        },
      ],
      messages: [
        {
          ...PIERRE,
          contentMarkdown: "btw, LRU:n höll inte — sessionerna dör vid varje deploy och supporten märker det",
          minutesAgo: 20,
        },
        {
          ...KRIS,
          contentMarkdown: "ja jag såg. vår host har managed Redis numera, hundring i månaden",
          minutesAgo: 15,
        },
        { ...PIERRE, contentMarkdown: "då river vi LRU:n och kör managed Redis i stället, beslutat", minutesAgo: 10 },
        { ...KRIS, contentMarkdown: "kör", minutesAgo: 8 },
      ],
    },
    expectedOutput: {
      minMemos: 1,
      maxMemos: 2,
      conclusionMustState: "They switched session caching to (managed) Redis, replacing the in-process LRU",
      expectSupersedes: "Sessioner cachas i en in-process LRU",
    },
  },

  {
    id: "personal-facts-captured-001",
    name: "Personal: a lasting health fact and a leave period are memos, a sick day and congratulations are not",
    input: {
      category: "extraction",
      messages: [
        {
          ...KRIS,
          contentMarkdown: "Allergitestet för Ylva klart. Hon är allergisk mot sesam, inte jordnötter som vi trodde",
          minutesAgo: 30,
        },
        { ...KRIS, contentMarkdown: "Så ingen tahini eller hummus. Jordnötter och nötter går bra", minutesAgo: 28 },
        { ...PIERRE, contentMarkdown: "Skönt att ni vet! Btw jag är föräldraledig 3 nov till 9 jan", minutesAgo: 20 },
        { ...PIERRE, contentMarkdown: "Mira tar alla mina jourpass medan jag är borta", minutesAgo: 18 },
        { ...PIERRE, contentMarkdown: "Är hemma sjuk idag förresten, så svarar lite segt", minutesAgo: 17 },
        { ...KRIS, contentMarkdown: "Grattis!! 🎉", minutesAgo: 15 },
      ],
    },
    expectedOutput: {
      minMemos: 2,
      maxMemos: 2,
      mustCoverAny: [["sesam", "sesame"], ["Mira"], ["nov"]],
      mustNotContain: ["sjuk", "sick", "Grattis"],
      conclusionMustState: "Ylva is allergic to sesame, not peanuts",
    },
  },

  {
    id: "cross-conversation-reversal-supersedes-001",
    name: "Reversal in a new conversation retires the stream memo it contradicts",
    input: {
      category: "revision",
      memoryContext: [
        {
          title: "Pro-planen kostar 12 dollar per användare",
          abstract: "De satte Pro-planens pris till 12 dollar per användare och månad, utan årsrabatt.",
          createdDaysAgo: 6,
        },
        {
          title: "Onboarding-mejl skickas via Resend",
          abstract: "Onboarding-mejlen skickas via Resend från noreply-adressen.",
          createdDaysAgo: 4,
        },
      ],
      messages: [
        {
          ...PIERRE,
          contentMarkdown: "kollade konverteringen på pro, 12 dollar skrämmer bort småteamen",
          minutesAgo: 30,
        },
        { ...KRIS, contentMarkdown: "ja, vi sänker till 9 per användare och ger 20% på årsplan", minutesAgo: 25 },
        { ...PIERRE, contentMarkdown: "kör, jag uppdaterar prissidan idag", minutesAgo: 20 },
      ],
    },
    expectedOutput: {
      minMemos: 1,
      maxMemos: 2,
      conclusionMustState: "The Pro plan now costs 9 dollars per user, with 20% off annual plans",
      expectSupersedes: "Pro-planen kostar 12 dollar per användare",
    },
  },

  {
    id: "cross-conversation-elaboration-keeps-001",
    name: "A new detail on a stream memo's topic retires nothing",
    input: {
      category: "extraction",
      memoryContext: [
        {
          title: "Pro-planen kostar 12 dollar per användare",
          abstract: "De satte Pro-planens pris till 12 dollar per användare och månad, utan årsrabatt.",
          createdDaysAgo: 6,
        },
      ],
      messages: [
        { ...PIERRE, contentMarkdown: "hur fakturerar vi pro egentligen?", minutesAgo: 30 },
        {
          ...KRIS,
          contentMarkdown: "via Stripe, i efterskott den första varje månad, per aktiv användare",
          minutesAgo: 25,
        },
        { ...PIERRE, contentMarkdown: "toppen, då skriver jag det i FAQ:n", minutesAgo: 20 },
      ],
    },
    expectedOutput: {
      minMemos: 1,
      maxMemos: 2,
      mustCoverAny: [["Stripe"]],
      expectSupersedes: null,
    },
  },

  {
    id: "team-event-booking-001",
    name: "A team event the participants booked is a decision, however logistical",
    input: {
      category: "extraction",
      messages: [
        {
          ...PIERRE,
          contentMarkdown: `Proposal for the offsite: Villa Fjällhem in Åre, ${OFFSITE_DATES}. Room for all 14 of us and a ski-in lodge.`,
          minutesAgo: 30 * DAY_MINUTES,
        },
        {
          ...KRIS,
          contentMarkdown: `Love it. Let's book Fjällhem for ${OFFSITE_DATES} then.`,
          minutesAgo: 30 * DAY_MINUTES - 1,
        },
        { ...PIERRE, contentMarkdown: "Booked, deposit paid.", minutesAgo: 30 * DAY_MINUTES - 2 },
      ],
    },
    expectedOutput: {
      minMemos: 1,
      maxMemos: 1,
      mustCoverAny: [["Fjällhem"]],
    },
  },

  {
    id: "team-event-moved-001",
    name: "A team event moved to a new venue is captured where it landed",
    input: {
      category: "extraction",
      messages: [
        {
          ...PIERRE,
          contentMarkdown:
            "Bad news: Fjällhem raised the price 40% and the train strike makes Åre a mess. I cancelled and got the deposit back.",
          minutesAgo: 9 * DAY_MINUTES,
        },
        {
          ...KRIS,
          contentMarkdown: "Ugh. Can we keep the dates and do it in Stockholm instead?",
          minutesAgo: 9 * DAY_MINUTES - 1,
        },
        {
          ...PIERRE,
          contentMarkdown: `Hotel Skeppsholmen has the conference wing free ${OFFSITE_DATES}. Same dates, no travel.`,
          minutesAgo: 9 * DAY_MINUTES - 2,
        },
        {
          ...KRIS,
          contentMarkdown: `Decided: offsite moves to Hotel Skeppsholmen in Stockholm, ${OFFSITE_DATES}. No ski gear needed.`,
          minutesAgo: 9 * DAY_MINUTES - 3,
        },
      ],
    },
    expectedOutput: {
      minMemos: 1,
      maxMemos: 2,
      conclusionMustState: `The offsite is at Hotel Skeppsholmen in Stockholm on ${OFFSITE_DATES}`,
      conclusionMustNotState: "The offsite is at Villa Fjällhem in Åre",
    },
  },

  {
    id: "booked-dinner-yields-nothing-001",
    name: "Selectivity: a booked table for this week is short-lived logistics, not a memo",
    input: {
      category: "transient",
      messages: [
        { ...PIERRE, contentMarkdown: "Ramen on Friday after work?", minutesAgo: 3 * DAY_MINUTES },
        {
          ...KRIS,
          contentMarkdown: "Yes! Booked a table at Ramen Ki for 18:00, four of us.",
          minutesAgo: 3 * DAY_MINUTES - 2,
        },
        { ...PIERRE, contentMarkdown: "Perfect", minutesAgo: 3 * DAY_MINUTES - 3 },
      ],
    },
    expectedOutput: {
      maxMemos: 0,
    },
  },
]
