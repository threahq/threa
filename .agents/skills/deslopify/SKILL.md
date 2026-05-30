---
name: deslopify
description: Rewrite user-facing copy (marketing pages, docs, headings, UI microcopy, READMEs, PR descriptions) to strip AI-slop and salesy tone, leaving plain, understated, factual prose. Use when asked to "deslopify", "deslop", "remove the AI slop", "make this less salesy/less AI-sounding", "make the copy plainer", or when reviewing copy for slop tells.
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

## When to use

Any user-facing text: landing pages, section copy, headings, button/label
microcopy, docs, READMEs, changelogs, PR/release descriptions, notification
strings. Not for code identifiers, log lines, or internal comments.

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
10. **Formulaic colorized highlights** — one accent-colored word in every heading
    (and pull-quote), e.g. `<span class="accent">…</span>` on a word per `<h2>`.
    It reads as generated even when the words are fine, because the *placement* is
    mechanical: every heading, always one phrase. Reserve the accent for rare,
    deliberate emphasis (the page's primary headline, or hero + closing CTA as
    bookends) and let body headings stand in plain ink. The brand color still
    carries the page through eyebrows, labels, links, card edges, and rules, so
    trimming heading highlights doesn't drain the color, it just stops the tell.
    This is a visual tell, not a word choice: hunt the markup (`grep -rn
    'class="accent"'`), not the prose.

## Rewrite principles

- **Plain and understated beats polished and salesy.** Short declaratives. Say
  what it is and what it does.
- **Preserve the author's voice and any first-person framing.** Deslop ≠ rewrite
  in your voice. Keep their cadence, just remove the tells.
- **Be conservative.** Change a sentence only if it carries a tell or reads as
  marketing. Don't rephrase clean copy for its own sake.
- **Never add claims.** Don't invent benefits, features, or numbers to fill the
  hole a cut cliché left. If a line only had hype, it can often just go.
- **Stay honest.** Describe the real, current mechanic — not aspirations dressed
  as fact. If copy claims something the product doesn't do yet, flag it rather
  than smoothing it over. (This is a hard rule for sales/marketing surfaces.)
- **Keep technical accuracy.** Don't change endpoint names, types, numbers, or
  behavior while editing prose around them.

## Process

1. **Locate the copy in scope.** A file, a selection, a section, or "the whole
   page". For multi-file sweeps, list the files first.
2. **Scan for each tell** above. Read for tone, not just keywords — slop is often
   structural (cadence, contrast, triples), not a single word.
3. **Rewrite in place**, one tell at a time, keeping voice and accuracy.
4. **Re-scan mechanically.** At minimum `grep -rn '—' <files>` for stray
   em-dashes; spot-check for the cliché list. Em-dashes hide in page `<title>`s
   and alt text too.
5. **Report** what changed: the notable before→after rewrites and anything you
   flagged as a possibly-false claim rather than edited.

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

## Guardrails

- Don't touch code blocks, identifiers, or config except to fix prose around them.
- Don't strip meaning to hit a "plainer" target; a clear two-clause sentence beats
  a terse but vague one.
- When the only honest fix is structural (the claim is wrong, not just sloppy),
  say so and propose the corrected claim rather than quietly rewording.
