---
title: Custom Personas
status: shipped
audience: public
since: 2026-07
surfaces: [persona-editor, workspace-settings, settings, stream-settings]
public_site: true
summary: >
  Fork any persona into an editable copy, shared with the workspace or personal
  to you: prompt, model, tone, tools, avatar, and attached knowledge files, with
  a test scratchpad and restorable revision history.
related: [public/ai-companions.md, architecture/agent-runtime.md]
---

## What it does

A persona is a data row, not code: a name, avatar, system prompt, model (plus an
optional escalation model), tone and brevity guidance, a toolset, sampling
settings, and a list of attached knowledge files. The built-in personas (Ariadne
and her stock siblings) resolve from code and are bounded; a custom persona is a
row the workspace owns and every field is editable.

Custom personas come in two scopes:

- **Workspace personas.** Managed by admins from workspace settings, usable by
  everyone in the workspace: they appear in every member's companion picker and
  mention suggestions.
- **Personal personas.** Any member can create their own from Settings > AI >
  "My personas". A personal persona is visible and usable only by its owner. It
  never appears in anyone else's picker, roster, or mention suggestions, and other
  members (admins included) cannot open, edit, or even confirm it exists.

Creation is always a fork: pick any persona you can see (a built-in, a workspace
custom, one of your own, or a blank) and it becomes an editable copy with the
prompt, tools, model, and style carried over. Personas get a mention slug derived
from their name. Workspace personas share one slug namespace; personal personas
are namespaced per owner, so two people can both have their own `@coach` without
stepping on each other, and a bare `@coach` you type resolves to your own persona
first, then a workspace one, then a built-in.

A persona is used wherever a companion is chosen: pinned to a scratchpad through
the companion picker, invoked by mention, or set as a default (a workspace default
for everyone, and a personal default that overrides it for you). Defaults apply
when a scratchpad is created; changing a default never switches an existing
scratchpad's agent.

## The editor

Every custom persona (workspace or personal) opens the same editor:

- **Identity:** name, description, and an avatar (an emoji or an uploaded image).
- **Behavior:** the free-form system prompt, free-text Tone and Brevity guidance,
  the toolset, the model and optional escalation model, temperature, and max
  tokens.
- **Knowledge:** the attached files section, described below.
- **Test drive:** edits sync into a server-side draft, and a bound test scratchpad
  lets you talk to the candidate persona before saving anything.
- **Revisions:** every save appends a restorable revision.
- **Archive:** a custom persona can be archived and restored from an Archived
  list. A scratchpad pointing at an archived persona degrades to the effective
  default at reply time.

Built-in personas open a bounded editor instead: toolset, model, and preset Tone
and Brevity choices; the prompt is read-only and the identity is fixed.

## Attached knowledge

A persona can carry attached knowledge: files whose extracted content rides as
standing context in every reply the persona gives (companion turns, mentions, and
test drives alike). The persona does not have to be asked to fetch anything; the
content is simply present. Today knowledge is attached by uploading files, through
the same upload machinery as sending a file in chat (per-file progress, retry,
several files at once) and the same extraction pipeline (PDF, Word, Excel, CSV,
JSON, Markdown, plain text).

Because context is bounded, each file lands in one of three forms, decided by a
single budget walk over the list in order, and each row in the editor shows which
form its file gets so there is no guessing:

- **In full.** The extracted text, when it is 8,000 characters or less and fits
  the remaining budget.
- **Summary only.** The AI-generated summary, when the full text is too large for
  the inline cap or for what is left of the budget. A whole summary is preferred
  over a cut-off full text.
- **Name only.** When nothing fits, the filename still appears with an explicit
  truncation marker. A file is never silently dropped.

The whole knowledge block is capped at 24,000 characters and at most one file is
ever truncated. Big uploads are cheap by design: a huge PDF degrades to its
summary and the block stays bounded regardless of what is attached. A file whose
extraction failed says so on its row and in the persona's context, instead of
pretending it is still processing.

Limits: 50 files per persona, 20MB per file, text-bearing types only. Managing a
persona's knowledge follows the same permissions as editing it.

## Boundaries

- Built-in personas cannot carry knowledge files and keep their fixed identity
  and prompt.
- There is no promotion path from a personal persona to a workspace one, and no
  sharing of one persona (or its files) between members or workspaces.
- Knowledge is attach-by-upload only today; referencing an existing workspace
  file by link is not built. There is also no on-demand deep read: a file larger
  than the inline cap is represented by its summary.
- When a member leaves, their personal personas simply stop being visible or
  dispatchable; nothing cleans them up.
- If a scratchpad pinned to someone's personal persona is later shared, other
  members see a generic "AI Companion" as the author name rather than the
  persona's identity.
- End-to-end encrypted scratchpads always run the built-in Ariadne inside the
  encryption enclave; custom personas and knowledge never apply there.

## Related

- [AI Companions](ai-companions.md) for companion mode, mentions, the activity
  card, and traces.
- [Agent runtime](../architecture/agent-runtime.md) for how persona turns execute.
