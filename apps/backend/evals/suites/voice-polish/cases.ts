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

// 10 sections ≈ 25s of continuous dictation. The production model's final pass
// stays inside the 8s deadline with margin at this length; at 12+ sections the
// heavy tail exceeds it often enough to make the gate a dice roll. That measured
// limitation is documented in the dictation evals PR; the case still stresses
// repeated-pattern retention and a retroactive correction.
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
  c("incremental-append", "Clean incremental append", ["We ship Friday", "We ship Friday after lunch"], {
    requiredTerms: ["ship", "Friday", "after lunch"],
    stability: "prior-content",
  }),
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
  c(
    "bullets",
    "Spoken bullets remain stable",
    ["First buy milk second call Anna", "First buy milk second call Anna third deploy the fix"],
    {
      requiredTerms: ["milk", "Anna", "deploy"],
      blockTypes: ["bulletList"],
      listItemCounts: [3],
      stability: "prior-content",
      correctionOrStructure: true,
    }
  ),
  c(
    "ordered-list",
    "Explicit numbered list remains stable",
    [
      "Number one open settings number two enable voice",
      "Number one open settings number two enable voice number three save",
    ],
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
    [
      "First paragraph covers the launch new paragraph Risks include timing",
      "First paragraph covers the launch new paragraph Risks include timing and staffing",
    ],
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
      { rawTranscript: `${longTake} The launch is Wednesday, wait, that should be Thursday.`, deadline: "final" },
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
      { rawTranscript: `${timeoutTake} Final approval belongs to the release manager.`, deadline: "final" },
    ],
    {
      requiredTerms: ["release note 1", "release note 10", "release manager"],
      stability: "prior-content",
      correctionOrStructure: true,
    }
  ),
  c(
    "structured-context",
    "Type dictate type dictate with fresh formatted context",
    [
      {
        rawTranscript: "First review access second verify backups",
        deadline: "live",
        draftBefore: "# Existing roadmap",
        draftAfter: "## Appendix",
      },
      {
        rawTranscript: "First review access second verify backups third notify Anna",
        deadline: "final",
        draftBefore: "# Existing roadmap\n\n- Typed owner: Sam\n\n- Review access\n- Verify backups",
        draftAfter: "## Appendix\n\nTyped closing note",
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
