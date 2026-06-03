# Make the Public Site AI-Discoverable

## Goal

Make the developer docs at threa.io/developers genuinely usable by AI agents and by
developers driving agents: machine-readable markdown artifacts that cannot drift from
the human pages, explicit discovery entry points (llms.txt, robots.txt, sitemap), and
an accurate OpenAPI spec (the previous auth metadata was stale and would misinform any
agent reading /openapi.json).

## What Was Built

### Build-time markdown mirrors + llms.txt (apps/public-site)

A post-build script converts the built docs HTML into markdown so the mirrors are
derived from the same artifact users see — no hand-maintained copies, no drift.

**Files:**

- `apps/public-site/scripts/build-llms.ts` — runs after `astro build` (wired into the
  package `build` script). Extracts each page's `<article class="docs-article">`,
  converts to markdown with turndown plus custom rules for the site's own components
  (code blocks, callouts, docs tables, API reference schema trees / op headers /
  scopes), and writes into `dist/`:
  - `developers/<page>.md` — one mirror per docs page
  - `llms.txt` — index per the llms.txt convention (llmstxt.org)
  - `llms-full.txt` — all pages concatenated for one-fetch consumption
- `apps/public-site/package.json` — `build` becomes `astro build && bun scripts/build-llms.ts`;
  adds `turndown` (+ types) and `@astrojs/sitemap`.

Key mechanics:

- Code samples are taken from each block's hidden raw `data-template`, not the rendered
  `<pre>` — the visible HTML renders `{{baseUrl}}/{{workspaceId}}/{{apiKey}}` as empty
  chips that the playground fills client-side, so scraping the pre would drop them.
  Tokens become literal placeholders (`https://app.threa.io`, `YOUR_WORKSPACE_ID`,
  `YOUR_API_KEY`); the OpenAPI-style `{workspaceId}` is substituted inside code fences
  only, leaving headings/prose in template form.
- Internal `/developers/*` links in mirrors are rewritten to the absolute `.md` mirror
  URLs so an agent following links stays in markdown; other root-relative links become
  absolute.
- Two fail-loudly guards: every `PAGES` entry must exist in dist, and every built
  `dist/developers/*` page must have a `PAGES` entry (a new docs page cannot silently
  ship without a mirror/llms.txt listing).

### Crawler/agent discovery surface

**Files:**

- `apps/public-site/public/robots.txt` — allows all crawlers; comments point agents at
  /llms.txt, /llms-full.txt, /openapi.json and the `.md` mirror convention; Sitemap line.
- `apps/public-site/astro.config.mjs` — adds the `@astrojs/sitemap` integration
  (emits `sitemap-index.xml`).

### Docs UI discoverability hooks

**Files:**

- `apps/public-site/src/layouts/DocsLayout.astro` — `<link rel="alternate"
  type="text/markdown">` per page, a "View as Markdown" footer link, and an
  `llms.txt` link in the sidebar footer. The markdown href is derived from the
  existing nav array.
- `apps/public-site/src/pages/developers/index.astro` — new "Working with an AI agent"
  section: explains the `.md` mirrors / llms.txt / OpenAPI spec, with a copyable
  prompt block (uses the live `{{baseUrl}}`/`{{workspaceId}}` credential chips) and a
  note to keep the API key in an env var rather than pasting it into a prompt.

### OpenAPI spec accuracy fix (apps/backend)

**Files:**

- `apps/backend/scripts/generate-api-docs.ts` — the spec's auth description claimed
  keys are `thr_`-prefixed and created by workspace admins. Reality (verified in
  `apps/backend/src/features/user-api-keys/service.ts` and
  `packages/types/src/api-keys.ts`): `threa_uk_` personal access keys (any member,
  Settings > API keys) and `threa_bk_` bot keys (minted from a bot's settings).
  Wording aligned with the auth docs page ("two prefixes", with both bot flavors
  described). Also links the spec description to threa.io/developers and /llms.txt.
- `docs/public-api/openapi.json` — regenerated; `generate:api-docs:check` passes.

## Design Decisions

### Mirrors generated from built HTML, not hand-authored markdown

**Chose:** A post-build HTML→markdown conversion of the exact pages the site ships.
**Why:** Hand-maintained `.md` copies drift; this repo already treats the OpenAPI spec
as a single source for the reference page, and the mirrors follow the same ethos.
**Alternatives considered:** Hand-authored markdown sources rendered into both HTML and
`.md` (would have required rewriting the docs pages and can't express the interactive
CodeBlock/playground components); Astro Container API (experimental).

### turndown with custom per-component rules

**Chose:** `turndown` (build-time only dependency) with rules keyed on the site's own
class names (`pg-block`, `note`, `api-props`, `api-op-head`, …).
**Why:** The markup is fully controlled by colocated components, so class-based rules
are stable; turndown handles the inline-whitespace/escaping subtleties a hand-rolled
converter gets wrong. The coupling is acknowledged in comments and guarded by a loud
build failure that names DocsLayout.astro.

### Placeholders over tokens in mirrors

**Chose:** Substitute the playground's `{{tokens}}` with `YOUR_WORKSPACE_ID` /
`YOUR_API_KEY` / the production base URL, explained in each mirror's front matter.
**Why:** Agents consume the mirrors outside the browser; empty token chips or raw
`{{...}}` would produce broken curl samples.

## What's NOT Included

- No MCP server (explicitly called out as not existing yet in llms.txt and the docs).
- No `.md` mirrors for marketing pages (`/`, `/about`) — llms.txt links `/about` as
  optional HTML; the agent-relevant content is the developer docs.
- The `.md` files are build artifacts: `astro dev` does not serve them (the footer
  link 404s in dev only). They exist in every deployed build.
- No content-negotiation (`Accept: text/markdown`) — not possible on static Cloudflare
  Pages hosting; explicit `.md` URLs instead.
- CORS_ALLOWED_ORIGINS for in-browser Run buttons is a deployment setting, unchanged
  by this PR.

## Status

- [x] Markdown mirrors + llms.txt + llms-full.txt generated and inspected
- [x] robots.txt + sitemap emitted
- [x] Layout/head/overview discoverability hooks
- [x] OpenAPI auth metadata fixed and regenerated (check passes)
- [x] Typecheck (public-site astro check, backend tsc) and full build green
- [x] Preview-server smoke test: all new URLs serve with correct content types
