---
name: deslopify
description: Rewrite or audit user-facing copy (marketing pages, docs, headings, UI microcopy, READMEs, PR descriptions) to remove AI-slop and salesy tone while preserving the writer's voice. Use when asked to "deslopify", "deslop", "remove the AI slop", "make this less salesy/less AI-sounding", "make the copy plainer", or detect whether copy contains slop patterns.
---

# Deslopify

Turn copy that reads as AI-generated or salesy into plain, understated, factual
prose. Preserve meaning, voice, and technical accuracy. Cut the tells, don't
flatten everything into mush.

Slop isn't only word choice. It's also presentation: a colorized highlight on one
word in every heading reads as generated even when the words are good. Watch the
markup, not just the prose.

Audience note: developers and technical readers are especially allergic to slop.
For API docs, CLIs, and engineering content, lean terse and literal.

## Modes

- **Edit (default):** Make the minimum effective edit. Return the full revision
  for pasted text; for file edits, change the files and report only material
  changes.
- **Detect:** When asked to audit, scan, or judge copy without rewriting, name
  each pattern, quote the affected line, and suggest the fix in a few words.
  Don't score the draft, rewrite it, or guess whether AI wrote it. Pattern
  evidence is useful; AI-authorship guesses aren't.

## When to use

Any user-facing text: landing pages, section copy, headings, button/label
microcopy, docs, READMEs, changelogs, PR/release descriptions, notification
strings. Also use for slop audits. Not for code identifiers, log lines, or
internal comments.

If no draft or file is provided, ask for it. Infer the audience, format, and
intended reader outcome from context when possible. If one remains unclear and
would materially change the edit, ask one focused question before rewriting.

## The tells (hunt and remove)

1. **Em-dashes (—).** The single biggest tell. Restructure with a period, comma,
   colon, or parentheses. Applies to dialogue and examples too (people don't type
   em-dashes in chat). After editing, grep to be sure: `grep -rn '—' <files>`.
2. **"Thing. Why-thing." headers** — two-sentence headlines like "Open source.
   Your knowledge stays yours." Use one plain declarative line.
3. **"X, not Y" constructions** — "A memo, not a transcript.", "the process, not
   just the artifact." Drop the rhetorical contrast; state the thing.
   (Plainly factual "returns 404, not 403" in technical prose is fine if it's
   describing behavior, not scoring a point — judge by whether it's a flourish.)
4. **Triples / parallelism** — "Your data. Your agent. Yours to take.", "We don't
   train it. We don't sell it. We don't borrow it." Keep one clause; a literal
   list of items (a, b, and c) is fine.
5. **Cutesy / self-aware headlines** — "Things worth actually doing.", "Every
   endpoint, all 26.", "The one most people are here for." Name the thing plainly.
6. **Clichés and filler** — "that's the whole point", "the whole point of X", "on
   the radar", "black hole", "light up", "no vendor lock", "say so", "out of the
   box", "under the hood", "first-class", "seamless", "effortless", "powerful",
   "robust", "leverage", "unlock", "elevate", "supercharge", "delight", "magic",
   "buttery", "blazingly fast", "we've got you covered", "and more".
7. **Hype adjectives / adverbs** — "incredibly", "actually", "simply", "just"
   (as filler), "truly", "genuinely" (when padding), "extremely". Delete or replace
   with something concrete.
8. **Naming competitors** — even when one motivated the product. Describe the gap,
   not the rival.
9. **Aspirational claims stated as present fact** — see the honesty rule below.
10. **Throat-clearing openers** — "Here's the thing:", "Here's what X does", "It
    turns out", "The truth is", "What you need to know:". Filler before the
    point. Delete it and open on the point itself.
11. **Self-posed rhetorical questions** — "Want faster builds?", "The result?
    Faster builds." Question-then-answer is a setup, not information. State the
    thing. A genuine question to the reader is fine; the manufactured one isn't.
12. **The "serves as" dodge** — "serves as", "stands as", "acts as",
    "represents"/"marks" when they just mean *is*. Use "is", or better, say what
    the thing does. ("This endpoint serves as the entry point" → "Start here.")
13. **False agency** — inanimate subjects doing human things to dodge the actor:
    "errors surface themselves", "the config decides", "the data tells us". Name
    who or what acts (the worker, the user, the query). Deliberate
    personification as voice is fine; the tell is the reflexive dodge.
14. **Listicle in prose** — "The first… The second… The third…": a list wearing
    a sentence costume. Weave the points into real prose, or make it a real
    list. A genuine enumerated list is fine.
15. **Vague attributions** — "experts agree", "studies show", "it's widely
    known", "many teams". No nameable source means no source: cut the claim or
    name it.
16. **Invented concept labels** — christening a plain idea to sound deep: "the
    calibration paradox", "the X effect", a quoted neologism. Describe the
    mechanic instead of naming it.
17. **Bold-first bullets** — every bullet led by a `**bolded phrase** —` then a
    gloss. One or two for genuine emphasis is fine; a whole list of them is a
    template tell. Like the accent spans it's markup, so hunt it (`grep -rn
    '^[[:space:]]*[-*] \*\*' <files>`), not the prose.
18. **Formulaic colorized highlights** — one accent-colored word in every heading
    (and pull-quote), e.g. `<span class="accent">…</span>` on a word per `<h2>`.
    It reads as generated even when the words are fine, because the *placement* is
    mechanical: every heading, always one phrase. Reserve the accent for rare,
    deliberate emphasis (the page's primary headline, or hero + closing CTA as
    bookends) and let body headings stand in plain ink. The brand color still
    carries the page through eyebrows, labels, links, card edges, and rules, so
    trimming heading highlights doesn't drain the color, it just stops the tell.
    This is a visual tell, not a word choice: hunt the markup (`grep -rn
    'class="accent"'`), not the prose.
19. **Faux-insight setups** — "what nobody tells you", "the part everyone
    misses", "what most people get wrong". These manufacture authority instead
    of supporting the claim. Cut the setup and state the claim.
20. **Dramatic colon reveals** — a setup followed by a colon and a punchline:
    "The best part: it learns." Write a normal sentence. Keep colons for lists,
    labels, and quotations; use sentence case after them unless grammar requires
    otherwise.
21. **Decorative analysis** — trailing clauses with "highlighting",
    "underscoring", "reflecting", or "showcasing" that attach vague importance
    to a fact. Explain the concrete consequence or stop at the fact.
22. **Importance puffery** — "marks a pivotal moment", "plays a vital role",
    "stands as a testament", "underscores its significance". State what happened
    and let the reader judge its importance.
23. **Synonym cycling** — renaming the same thing in adjacent sentences ("agent",
    then "assistant", then "tool") to avoid repetition. Repeat the precise term.
24. **Negative listing and dramatic fragments** — "Not X. Not Y. Z.", "X. And Y.
    And Z.", "That's it. That's the whole thing." Use one complete sentence.
25. **Robotic rhythm** — repeated sentence shapes, identical paragraph patterns,
    or a stack of equally punchy fragments. Preserve useful cadence, but vary the
    structure when the repetition is mechanical.
26. **Fake-profound endings** — a closing metaphor, aphorism, or mic-drop line
    that adds no information. Delete it rather than polishing the metaphor. End
    on the last concrete point or next action.
27. **Recap endings** — "In conclusion", "Ultimately", "Overall", or a final
    paragraph that merely repeats the piece. Trust the reader; end on the last
    useful point.
28. **Formatting decoration** — emoji in headings, bold scattered through
    sentences, bullets that would read better as two sentences, or headings over
    tiny sections. Let structure follow the content rather than decorating it.

## Rewrite principles

- **Plain and understated beats polished and salesy.** Short declaratives. Say
  what it is and what it does.
- **Preserve the author's voice and any first-person framing.** Deslop ≠ rewrite
  in your voice. Keep distinctive vocabulary, cadence, bluntness, humor,
  uncertainty, rough edges, and useful digressions. Don't make every paragraph
  equally tidy.
- **Be conservative.** Change a sentence only if it carries a tell, reads as
  marketing, repeats itself, or is hard to follow. Don't rephrase clean copy for
  consistency.
- **Use direct verbs and concrete facts.** Prefer "can" to "has the ability to";
  name the actor instead of hiding it in passive voice. Protect names, numbers,
  dates, mechanisms, and examples instead of smoothing them into abstractions.
- **Never add claims.** Don't invent benefits, features, numbers, opinions, or
  sources to fill the hole a cut cliché left. If a line only had hype, it can
  often just go.
- **Stay honest.** Describe the real, current mechanic — not aspirations dressed
  as fact. If copy claims something the product doesn't do yet, flag it rather
  than smoothing it over. (This is a hard rule for sales/marketing surfaces.)
- **Keep technical accuracy.** Don't change endpoint names, types, numbers, or
  behavior while editing prose around them.

## Process

1. **Locate and read all copy in scope.** For multi-file sweeps, list the files
   first. Identify the core point and the writer's voice before changing anything.
2. **Scan for each tell** above. Read for tone, not just keywords — slop is often
   structural (cadence, contrast, symmetry), not a single word.
3. For **detect mode**, report each named pattern with the exact line and a short
   fix, then stop. Don't silently switch to editing.
4. For **edit mode**, rewrite one tell at a time, keeping voice and accuracy.
5. **Re-scan mechanically.** At minimum `grep -rn '—' <files>` for stray
   em-dashes; `grep -rn 'class="accent"' <files>` for highlight tells and
   `grep -rn '^[[:space:]]*[-*] \*\*' <files>` for bold-first bullets; spot-check
   the cliché list and openers ("Here's", "It turns out"). Em-dashes hide in page
   `<title>`s and alt text too.
6. **Run the self-check in `eval.md`.** Fix every failed check before returning.
7. **Report** the full edited copy when working from pasted text. For in-repo
   edits, report only the files and material changes. Flag claims that may be
   false or unsourced instead of quietly rewriting them.

## Examples

- `Build on the same workspace Threa reads.` → `Threa's public API.`
- `Things worth actually doing.` → `Worked examples.`
- `Every endpoint, all 26.` → `API reference.`
- `It opens a prefilled issue — no black hole.` → `It opens a prefilled issue on
  the public repo for you to review and submit.`
- `The stack we deploy is the stack you run. Nothing held back.` →
  `Fork it and run your own build. It's the same code we ship.`
- `messages and memos are sealed end-to-end (rolling out now)` → (also a factual
  fix) `turn on end-to-end encryption for sensitive conversations; those hold
  ciphertext and produce no memos.`
- Six headings each with `<span class="accent">one word</span>` → accent only the
  hero and the closing CTA; the rest plain. (Trim the highlight, keep the words.)
- `Here's the thing: setup is one command.` → `Setup is one command.`
- `This service serves as the entry point for auth.` → `Authenticate here.`
- `Want faster builds? Here's how.` → (cut the question; lead with the steps.)
- `The first benefit is speed; the second is caching.` → `It's faster, and it
  caches results between runs.`

## Guardrails

- Don't touch code blocks, identifiers, or config except to fix prose around them.
- Don't strip meaning to hit a "plainer" target; a clear two-clause sentence beats
  a terse but vague one.
- When the only honest fix is structural (the claim is wrong, not just sloppy),
  say so and propose the corrected claim rather than quietly rewording.

## Credits

The tell catalog incorporates ideas from Stephen Turner's `skill-deslop`
(github.com/stephenturner/skill-deslop, MIT), Peter Yang's `no-ai-slop`
(github.com/petergyang/no-ai-slop, MIT), and tropes.fyi.
