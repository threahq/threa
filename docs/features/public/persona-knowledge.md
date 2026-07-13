---
title: Persona Knowledge
status: shipped
audience: public
since: 2026-07
surfaces: [persona-editor, scratchpads]
public_site: true
summary: >
  Attach files to a custom persona and their extracted content becomes standing
  context in every reply, with a per-file label showing exactly how each file
  lands in the persona's context.
related: [public/ai-companions.md, architecture/agent-runtime.md]
---

## What it does

A custom or personal persona carries a list of attached files, stored as ordinary
attachments bound to the persona through a `persona_attachments` join table. On every
turn the persona takes (companion replies, mentions, and editor test-drives alike),
the extracted text of those files is injected into its system prompt as a Knowledge
block: standing reference material the persona always has, not something it must be
asked to fetch.

Each file's content enters the prompt in one of three forms, decided per turn by a
single budget walk over the file list in order:

- **In full.** The file's extracted text, when it is 8,000 characters or less and
  fits the remaining budget.
- **Summary only.** The AI-generated summary from the extraction pipeline, used when
  the full text is too large for the inline cap or for what is left of the budget. A
  whole summary is preferred over a cut-off full text.
- **Name only.** When nothing fits, the filename still appears with an explicit
  truncation marker. A file is never silently dropped from the block.

The whole block is capped at 24,000 characters, at most one file is ever truncated,
and a file whose extraction failed says so explicitly instead of pretending it is
still processing. Uploading four huge PDFs is therefore cheap: each degrades to its
summary, and the block stays bounded no matter what is uploaded.

Limits: 50 files per persona, 20MB per file, text-bearing types only (PDF, Word,
Excel, CSV, JSON, Markdown, and anything `text/*`).

## How a user experiences it

The persona editor (for a workspace custom or one of your personal personas) has a
**Knowledge** section:

- **Add file** opens a multi-file picker. Uploads run through the same background
  upload machinery as sending a file in chat: per-file progress, retry on failure,
  and several files at once. Files that fail the type or size check are rejected
  before any upload starts.
- Each row shows the filename, its size, and a status: "Processing" while the
  extraction pipeline works on it, "Couldn't read this file" if extraction failed,
  and once ready, the context label: **In full**, **Summary only**, or **Name only**.
  That label is computed by the same budget walk that builds the prompt, so what the
  editor says is what the persona actually gets.
- A counter ("3 of 50 files") tracks the cap, and each row has a remove button.

Who can manage them follows persona editing exactly: workspace personas are
admin-managed; a personal persona's files are visible and editable only by its owner.
Another member, admins included, cannot see them, fetch their bytes, or learn they
exist.

## Boundaries

- Built-in personas (Ariadne and the other stock personas) cannot carry files; they
  resolve from code and have no owned row to bind to.
- The Knowledge block is the only access the persona has. There is no tool for it to
  read deeper into a large file on demand; a file bigger than the inline cap is
  represented by its summary.
- Files are not shared between personas and there is no deduplication; the same
  document uploaded to two personas is stored twice.
- Images, audio, and video are not supported; the allowlist is text-bearing types
  only.
- End-to-end encrypted scratchpads are unaffected: they always run the built-in
  Ariadne inside the enclave, which never receives a Knowledge block.

## Related

- [AI Companions](ai-companions.md) for personas, companion mode, and mentions.
- [Agent runtime](../architecture/agent-runtime.md) for how persona turns execute.
