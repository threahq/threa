---
title: Link Previews
status: shipped
audience: public
since: 2026-03
surfaces: [timeline, message-composer]
public_site: false
summary: >
  Post a URL and Threa renders a preview card under the message: a generic web
  card, a rich GitHub or Linear card when that integration is connected, or a
  native card for a link to another Threa message, stream, or memo.
related: [public/in-this-stream.md]
---

## What it does

When a message contains URLs, Threa renders preview cards beneath it. Up to five
URLs per message become cards; the rest of the links stay as plain text.

There are two families of preview.

**External web links** get a generic card with the page's title, description,
image, site name, and favicon. Threa reads these from the page's OpenGraph and
Twitter meta tags, or from an oEmbed endpoint for a few known providers (YouTube,
Vimeo, and X/Twitter). A link that points at a PDF or an image is recognised as
that kind and shown accordingly.

**GitHub and Linear links** upgrade to a richer card when the workspace has that
integration connected. GitHub links resolve pull requests, issues, commits,
files, diffs, and comments; Linear links resolve issues, comments, projects, and
documents, each carrying the structured state (status, author, labels, and so on)
from the provider's API. Without the integration, the same link falls back to a
generic web card.

**In-app links** are links to other things inside Threa: another message, a
stream, or a captured memo. These render as native cards rather than web scrapes,
resolved for the viewer who's looking:

- A **message** card shows the author, a snippet of the message, and the stream
  it lives in.
- A **stream** card shows the stream's name, whether it's public or private, and
  its description.
- A **memo** card shows the memo's title, its knowledge type, a snippet of its
  abstract, and the stream the knowledge came from.

In-app cards are access-checked against the viewer. If you can't see the target,
the card collapses to a minimal form ("In a private conversation", "Private
conversation", "From a private conversation") instead of leaking its contents. A
link into a different workspace shows "In another workspace" and is never
inspected at all, so the card can't reveal whether the target exists. A link to a
message that has since been deleted shows "This message was deleted".

## How a user experiences it

In the timeline, cards stack under the message. Three show by default, with a
"Show N more" control for the rest. Each card collapses and expands on its own,
and a long body clamps with its own show-more toggle. Hovering a URL in the
message text highlights the card it produced. The dismiss (X) button removes a
card for you without affecting anyone else.

In the composer, links you've typed show as a compact chip row beneath the input
while you draft, so you can see what will attach before you send. In-app links
are the exception: they render inline within the draft text rather than as chips.

Web and integration cards fill in a moment after you send, because a background
worker fetches the page and publishes the result. In-app cards need no network
fetch and resolve right away.

## Boundaries

- **Previews are fetched once and cached.** A successful web or integration
  preview is reused for about a day; a failed fetch retries on a shorter window.
  Nothing re-fetches on a schedule, so an updated page or a newly-permitted
  GitHub link only refreshes when the message itself is edited.
- **Rich GitHub and Linear cards require the integration.** They depend on the
  workspace having that integration connected and active. Without it, those links
  render as generic web cards (and Linear's login wall usually means no card at
  all).
- **The oEmbed provider list is fixed** (YouTube, Vimeo, X/Twitter). Every other
  site goes through HTML meta-tag scraping; sites that serve a metadata-less page
  to bots produce no card.
- **Encrypted streams are skipped.** Extraction never runs on E2E streams, where
  the message content is ciphertext, so messages there carry no previews.
- **Dismissals and collapse state differ in scope.** Dismissing a card is
  per-user and syncs across your devices. Whether a card is collapsed is a
  per-device preference stored locally and does not sync live across tabs.
- **In-app snippets are plain text.** The message, stream, and memo snippets on
  in-app cards are stripped of markdown and truncated (around 200 characters)
  before they leave the server, so the card never ships literal `**bold**` or a
  half-cut link (INV-60).
- **GitHub comment and diff anchors are stored but not surfaced.** The URL parser
  keeps line and comment anchors for deduplication, but the card has no
  jump-to-line or quoted-comment view.

## Related

- [In This Stream](in-this-stream.md) gathers the links from these preview cards
  (plus other URLs in the text) into a per-stream overview.
