import type { EvalCase } from "../../framework/types"
import type { VoicePolishExpected, VoicePolishInput, VoicePolishStep } from "./types"

const steps = (values: Array<string | VoicePolishStep>): VoicePolishStep[] =>
  values.map((value) => (typeof value === "string" ? { rawTranscript: value } : value))
const c = (
  id: string,
  name: string,
  values: Array<string | VoicePolishStep>,
  expectedOutput: VoicePolishExpected,
  input: Omit<VoicePolishInput, "steps"> = {}
): EvalCase<VoicePolishInput, VoicePolishExpected> => ({
  id,
  name,
  input: { ...input, steps: steps(values) },
  expectedOutput,
})

// 10 sections ≈ 25s of continuous dictation. This is the representative upper
// bound for content-retention grading; provider jitter can exceed the deadline at
// any length, and at 12+ sections the frequency rises materially. Timeout behavior
// is owned by the run-level distribution gate; this case still stresses repeated-
// pattern retention and a retroactive correction on completed passes.
const longTake = Array.from(
  { length: 10 },
  (_, i) =>
    `Section ${i + 1} explains the rollout owner, validation evidence, customer impact, rollback trigger, and communication plan in natural detail.`
).join(" ")
const timeoutTake = Array.from(
  { length: 10 },
  (_, i) =>
    `The release note ${i + 1} records an owner, a concrete dependency, the validation result, and the fallback action for the regional rollout.`
).join(" ")

export const voicePolishCases = [
  c(
    "four-final-rollover",
    "Exact four-final rollover",
    [
      "Project Alpha belongs to Ana",
      "Project Beta belongs to Bo",
      "Project Gamma belongs to Gia",
      "Project Delta belongs to Dan",
      "Project Epsilon belongs to Eva",
    ],
    { requiredTerms: ["Alpha", "Ana", "Epsilon", "Eva"] }
  ),
  c("scalar-rollover", "Exact 1,200-scalar rollover", [longTake.slice(0, 1_200), "final omega marker"], {
    requiredTerms: ["Section 1", "omega marker"],
  }),
  c(
    "boundary-list-continuation",
    "Cross-boundary list continuation",
    ["first apples", "second pears", "third plums", "fourth bread", "fifth coffee"],
    {
      requiredTerms: ["apples", "coffee"],
      blockTypes: ["bulletList"],
      listItemCounts: [5],
      correctionOrStructure: true,
      expectedScope: "widen_previous",
    }
  ),
  c(
    "boundary-paragraph-continuation",
    "Cross-boundary paragraph continuation",
    [
      "First paragraph covers the launch",
      "and its owners",
      "New paragraph covers evidence",
      "for each region",
      "with rollback triggers",
    ],
    {
      requiredTerms: ["launch", "rollback triggers"],
      blockTypes: ["paragraph", "paragraph"],
      correctionOrStructure: true,
      expectedScope: "widen_previous",
    }
  ),
  c(
    "predecessor-correction-en",
    "Immediate predecessor correction in English",
    ["The meeting is Monday", "with Sam", "in Stockholm", "at nine", "Actually Tuesday, not Monday"],
    {
      requiredTerms: ["Tuesday"],
      forbiddenTerms: ["Monday"],
      correctionOrStructure: true,
      expectedScope: "widen_previous",
    }
  ),
  c(
    "predecessor-correction-sv",
    "Immediate predecessor correction in Swedish",
    ["Mötet är på måndag", "med Sam", "i Stockholm", "klockan nio", "Nej tisdag, inte måndag"],
    {
      requiredTerms: ["tisdag"],
      forbiddenTerms: ["måndag"],
      correctionOrStructure: true,
      expectedScope: "widen_previous",
    }
  ),
  c(
    "predecessor-correction-de",
    "Immediate predecessor correction in German",
    ["Das Treffen ist Montag", "mit Sam", "in Berlin", "um neun", "Nein Dienstag, nicht Montag"],
    {
      requiredTerms: ["Dienstag"],
      forbiddenTerms: ["Montag"],
      correctionOrStructure: true,
      expectedScope: "widen_previous",
    }
  ),
  c(
    "out-of-horizon",
    "Out-of-horizon correction preserves raw",
    [
      "The first date is Monday",
      "Second detail",
      "Third detail",
      "Fourth detail",
      "Fifth detail",
      "Sixth detail",
      "Seventh detail",
      "Eighth detail",
      "Change the first date to Tuesday",
    ],
    { requiredTerms: ["Monday", "Tuesday"], expectedScope: "preserve_raw", predecessorStable: true }
  ),
  c(
    "stop-exact-reuse",
    "Stop without a new final reuses the acknowledged live result",
    [
      { rawTranscript: "Ready to ship", deadline: "live" },
      { rawTranscript: "", deadline: "final", stopWithoutNewFinal: true },
    ],
    { requiredTerms: ["Ready to ship"], expectedFinalResult: "reused", expectedFinalModelCalls: 0 }
  ),
  c(
    "final-locked-retains-raw",
    "Rejected final retains accepted prefix and raw tail",
    [
      "accepted one",
      "accepted two",
      "accepted three",
      { rawTranscript: "accepted four", deadline: "live" },
      { rawTranscript: "raw locked tail", deadline: "final", ackStatus: "locked" },
    ],
    { requiredTerms: ["accepted one", "raw locked tail"], expectedFinalResult: "rejected", expectedAckStatus: "locked" }
  ),
  c("incremental-append", "Clean incremental append", ["We ship Friday", "after lunch"], {
    requiredTerms: ["ship", "Friday", "after lunch"],
    stability: "prior-content",
  }),
  c(
    "clean-boundary-tail",
    "Clean later window stays tail",
    ["one", "two", "three", "four", "Separately, the budget review starts tomorrow"],
    {
      requiredTerms: ["one", "budget review starts tomorrow"],
      expectedScope: "tail",
      predecessorStable: true,
    }
  ),
  c("inline-correction", "Inline correction", ["Meet at nine no sorry eight"], {
    requiredTerms: ["eight"],
    forbiddenTerms: ["nine", "sorry"],
    correctionOrStructure: true,
  }),
  c(
    "retroactive-correction",
    "Retroactive correction",
    ["Merge the poor frequence before lunch no no pull request not poor frequence"],
    {
      requiredTerms: ["pull request", "before lunch"],
      forbiddenTerms: ["poor frequence", "no no"],
      correctionOrStructure: true,
    }
  ),
  c("repeated-words", "Repeated words", ["I I think we we should ship"], {
    requiredTerms: ["think", "should ship"],
    forbiddenTerms: ["I I", "we we"],
  }),
  c("false-start", "Abandoned false start", ["We could maybe let's just ship the patch"], {
    requiredTerms: ["ship the patch"],
    forbiddenTerms: ["could maybe"],
  }),
  c("start-over", "Start over", ["Book Monday let me start over book Tuesday afternoon"], {
    requiredTerms: ["Tuesday afternoon"],
    forbiddenTerms: ["Monday", "start over"],
    correctionOrStructure: true,
  }),
  c("bullets", "Spoken bullets remain stable", ["First buy milk second call Anna", "third deploy the fix"], {
    requiredTerms: ["milk", "Anna", "deploy"],
    blockTypes: ["bulletList"],
    listItemCounts: [3],
    stability: "prior-content",
    correctionOrStructure: true,
  }),
  c(
    "ordered-list",
    "Explicit numbered list remains stable",
    ["Number one open settings number two enable voice", "number three save"],
    {
      requiredTerms: ["settings", "voice", "save"],
      blockTypes: ["orderedList"],
      listItemCounts: [3],
      stability: "prior-content",
      correctionOrStructure: true,
    }
  ),
  c(
    "paragraphs",
    "Paragraph structure remains stable",
    ["First paragraph covers the launch new paragraph Risks include timing", "and staffing"],
    {
      requiredTerms: ["launch", "Risks", "staffing"],
      blockTypes: ["paragraph", "paragraph"],
      stability: "prior-content",
      correctionOrStructure: true,
    }
  ),
  c("swedish", "Swedish remains Swedish", ["Vi lanserar på fredag men nej på torsdag efter lunch"], {
    requiredTerms: ["Vi", "torsdag", "efter lunch"],
    forbiddenTerms: ["fredag"],
    languageMarkers: ["Vi", "på", "efter"],
    forbiddenTranslations: ["we launch", "Thursday", "after lunch"],
  }),
  c("german", "German remains German", ["Wir treffen uns am Montag nein am Dienstag im Büro"], {
    requiredTerms: ["Dienstag", "Büro"],
    forbiddenTerms: ["Montag"],
    languageMarkers: ["Wir", "am", "im"],
    forbiddenTranslations: ["we meet", "Tuesday", "office"],
  }),
  c("mixed-proper-nouns", "Mixed-language proper nouns", ["Vi deployar Threa med Kubernetes på fredag"], {
    requiredTerms: ["Threa", "Kubernetes", "fredag"],
    languageMarkers: ["Vi", "deployar", "med", "på"],
    forbiddenTranslations: ["with Kubernetes", "on Friday"],
  }),
  c(
    "late-correction",
    "Genuinely long take with late correction",
    [
      { rawTranscript: `${longTake} The launch is Wednesday.`, deadline: "live" },
      { rawTranscript: "Wait, the launch should be Thursday, not Wednesday.", deadline: "final" },
    ],
    {
      requiredTerms: ["Section 1", "Section 10", "Thursday"],
      forbiddenTerms: ["Wednesday", "wait"],
      correctionOrStructure: true,
    }
  ),
  c(
    "timeout-length",
    "Natural timeout-bound take",
    [
      { rawTranscript: timeoutTake, deadline: "live" },
      { rawTranscript: "Final approval belongs to the release manager.", deadline: "final" },
    ],
    {
      requiredTerms: ["release note 1", "release note 10", "release manager"],
      stability: "prior-content",
      correctionOrStructure: true,
    }
  ),
  c(
    "structured-context",
    "Multi-final take keeps its initial composer context",
    [
      {
        rawTranscript: "First review access second verify backups",
        deadline: "live",
        draftBefore: "# Existing roadmap",
        draftAfter: "## Appendix",
      },
      {
        rawTranscript: "third notify Anna",
        deadline: "final",
      },
    ],
    {
      requiredTerms: ["review access", "verify backups", "notify Anna"],
      forbiddenContextTerms: ["Existing roadmap", "Appendix", "Typed owner", "Sam", "Typed closing note"],
      blockTypes: ["bulletList"],
      listItemCounts: [3],
      stability: "prior-content",
      correctionOrStructure: true,
    }
  ),
  c(
    "minor-conservative",
    "Minor polish stays conservative",
    ["um i think we should ship no sorry wait"],
    { requiredTerms: ["um", "no sorry", "wait"] },
    { level: "minor" }
  ),
] satisfies EvalCase<VoicePolishInput, VoicePolishExpected>[]
