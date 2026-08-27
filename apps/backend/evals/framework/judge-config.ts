/**
 * The model every LLM-as-judge evaluator grades with.
 *
 * One constant rather than a literal per suite (INV-33): the judge is the
 * loudest single term in a companion score — it decides ~40% of case outcomes —
 * so a suite quietly grading with a different model than its neighbours makes
 * cross-suite numbers incomparable for a reason nobody can see.
 *
 * Luna over `gpt-5.4-nano`, matching the move production already made off the
 * 5.4 tiers (docs/model-reference.md): same $0.20 input, slightly cheaper
 * output ($1.20 vs $1.25), newer generation, and nano is specifically the model
 * that entry warns about for judgements where a miss is invisible — which is
 * exactly what a judge does.
 *
 * KNOWN BIAS, and it is not hypothetical: when a comparison has an OpenAI model
 * as a CANDIDATE, this judge shares its family. Read a narrow OpenAI win as
 * unproven and re-judge with a model from another family before acting on it.
 */
export const EVAL_JUDGE_MODEL = "openrouter:openai/gpt-5.6-luna"

/**
 * Judge model for a run whose candidate set includes `EVAL_JUDGE_MODEL`'s
 * family. Used to check whether a result survives a judge that cannot prefer
 * either candidate on family grounds.
 */
export const EVAL_CROSS_JUDGE_MODEL = "openrouter:google/gemini-3.5-flash-lite"
