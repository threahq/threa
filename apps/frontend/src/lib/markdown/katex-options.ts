/**
 * The KaTeX options every Threa surface renders math with. `rehype-katex`
 * forwards them to KaTeX, so a composer preview built with the same object
 * cannot draw an equation the posted message renders differently.
 *
 * `maxSize` caps \rule/\kern/\raisebox, whose lengths are otherwise unbounded:
 * `$\rule{1em}{200em}$` is a one-line 3200px black bar in everyone's timeline.
 * `strict: "ignore"` — KaTeX's warnings are about TeX we can't control (pasted
 * unicode, \newline in display mode) and would otherwise flood the console on
 * every message that carries math.
 */
export const KATEX_OPTIONS = { strict: "ignore", maxSize: 10, throwOnError: false } as const
