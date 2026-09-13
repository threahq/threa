# GDPR Compliance Audit — Threa

- **Date:** 2026-07-17
- **Audited revision:** `3895bd0b` (branch `audit/gdpr-audit`)
- **Reference text:** Regulation (EU) 2016/679, consolidated EN version (CELEX 02016R0679-20160504), read in full (Articles 1–99)
- **Method:** six parallel code audits — (1) personal-data inventory & retention, (2) data-subject rights, (3) processors & international transfers, (4) security of processing, (5) transparency & consent, (6) AI layer / profiling — synthesized against the regulation. Every claim cites `path:line` at the audited revision. Deployment-console facts not visible in the repo are marked **unverified**.

---

## 1. Executive summary

Threa is **not currently in a defensible GDPR position for operating with external EU users**, but the gaps are concentrated and the foundations underneath are unusually good. Three structural problems dominate; almost everything else hangs off them:

1. **There is no erasure capability anywhere in the data lifecycle** (Art. 17, 5(1)(e)). No account deletion, no workspace deletion; message "deletion" is a soft flag whose content keeps being stored _and served_; attachments are never removed from S3; derived AI memory ignores source deletion. The event-sourced architecture has no redaction path.
2. **There is no transparency layer at all** (Art. 12–14). No privacy policy, no terms, no processing notice at signup or on the waitlist, no disclosure that all message content flows through US AI providers.
3. **The AI pipeline is an uncontrolled third-country egress** (Art. 44–49, 28). Nearly all content — not just explicit AI use, because GAM processes every conversation by default — exits to OpenRouter (US, hardcoded, no EU pinning or data-collection opt-out), with a second unmasked copy to Langfuse telemetry, and raw voice audio to ElevenLabs/Deepgram.

On top of these, GAM's personal-facts profiling (an AI-populated "about you" tier, DMs memorized by default, no special-category filter) needs a lawful-basis decision and a DPIA before external users arrive.

**What is genuinely strong** (and worth preserving as compliance evidence): all first-party infrastructure is physically EU (Railway europe-west4, S3 eu-north-1); there is **zero** third-party analytics, error tracking, or ad tech on any surface; cookies are strictly-necessary only (no banner needed); access control is centralized, fail-closed, and covered by real CI tests; API keys are hashed with timing-safe comparison; push payloads are RFC 8291-encrypted; voice audio and transcripts are never persisted server-side; E2E-encrypted scratchpads exist and are verifiably excluded from all AI/memory processing; evals never touch production data.

Because Threa is pre-GA (waitlist stage, essentially personal use today), none of this is an emergency **yet** — but every gap above becomes a live legal obligation the moment the first external EU user joins a workspace. The remediation roadmap in §6 is ordered accordingly.

---

## 2. Roles and applicability

- **Territorial scope (Art. 3):** applies. The service targets EU users (`threa.io`, EU hosting, EU-based operator).
- **Roles:** For platform accounts, the waitlist, and solo workspaces, Threa is the **controller**. Once teams onboard, the realistic framing is workspace owner = controller, Threa = **processor** for workspace content — which means Threa must be able to _offer_ an Art. 28 DPA downstream and hold DPAs with every sub-processor upstream. Nothing in the repo or public site expresses either today.
- **Users' household exemption (Art. 2(2)(c))** may cover an individual's own use, but never covers Threa as provider.
- **Current stage:** one active region (`eu-north-1`), waitlist-gated signup, no billing. This materially lowers present risk and is reflected in severities.

---

## 3. What is already in good shape

| Area                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EU data residency (first-party) | All five Railway services + both Postgres DBs in `europe-west4` (`apps/backend/railway.toml:11` et al.); S3 bucket `eu-north-1` (`infra/aws/main.tf:14`); S3 SSE-AES256 + public access blocked (`infra/aws/modules/region/main.tf:24-52`)                                                                                                                                                                                                      |
| No tracking                     | Zero analytics/error-tracking/pixels on app, public site, backoffice (grep-verified across `gtag/posthog/plausible/segment/sentry/...`); no Redis; rate-limiter IPs in-memory only (`packages/backend-common/src/middleware/rate-limit.ts:32-72`)                                                                                                                                                                                               |
| Cookies                         | Only httpOnly `wos_session*` (SameSite=Lax, secure in prod, `packages/backend-common/src/cookies.ts:37-49`) + one functional sidebar cookie — no banner required on this inventory                                                                                                                                                                                                                                                              |
| Access control                  | Canonical stream-access predicates reused by search/attachments/memos (`apps/backend/src/features/streams/access.ts:72-189`); workspace middleware fails closed (`apps/backend/src/middleware/workspace.ts:36-58`); cross-workspace + thread-inheritance CI tests (`apps/backend/tests/integration/access-control.test.ts`)                                                                                                                     |
| Credential hygiene              | User/bot API keys stored as SHA-256 hash + prefix, timing-safe compare (`apps/backend/src/features/user-api-keys/service.ts:30-65`); integration OAuth tokens AES-256-GCM encrypted, AAD-bound (`apps/backend/src/features/workspace-integrations/crypto.ts:24-47`); no plaintext user credentials in DB                                                                                                                                        |
| Public API by design            | Registry-mounted routes with boot-time parity assertion; no route can exist without declared scopes (`apps/backend/src/features/public-api/mount.ts:14-27`, `apps/backend/src/routes.ts:1021-1031`); scopes clamped to owner's live permissions with `OWNER_INACTIVE` rejection (`apps/backend/src/middleware/public-api-auth.ts:68-92`)                                                                                                        |
| E2EE scratchpads                | Opt-in, HPKE envelope + per-stream keys, server enforces sealed-completeness both ways (`apps/backend/src/features/messaging/event-service.ts:342-378`); GAM extraction and embedding short-circuit on E2E streams (`apps/backend/src/features/memos/accumulator-outbox-handler.ts:61`, `embedding-outbox-handler.ts:36`); enclave = documented operator-trusted compute exception with separate API key (`apps/backend/src/routes.ts:364-389`) |
| Voice                           | Audio and transcripts never persisted server-side (`apps/backend/src/db/migrations/20260522104847_voice_sessions.sql:1-6`)                                                                                                                                                                                                                                                                                                                      |
| Push                            | Payloads RFC 8291-encrypted before FCM/Apple/Mozilla; E2E streams get leak-free labels (`apps/backend/src/features/push/service.ts:148-152,388-402`); stale subscriptions pruned on 404/410                                                                                                                                                                                                                                                     |
| Evals / test data               | Eval harness runs on local throwaway DBs with synthetic fixtures, never prod reads (`evals/framework/database.ts:15-85`)                                                                                                                                                                                                                                                                                                                        |
| Error handling                  | No stack traces to clients (`packages/backend-common/src/middleware/error-handler.ts:11-23`); enclave access log redacts bodies/cookies (`apps/enclave/src/access-log.ts:24-38`)                                                                                                                                                                                                                                                                |
| Waitlist minimisation           | Email + free-text source only, honeypot dropped, no IP (`apps/control-plane/src/features/waitlist/handlers.ts:6-18`)                                                                                                                                                                                                                                                                                                                            |

---

## 4. Findings

Severity: **Critical** (blocks lawful operation with external EU users) / **High** (clear Article violation or major exposure) / **Medium** (gap or risk needing a decision) / **Low** (hygiene).

### A. Erasure & storage limitation (Art. 17, 5(1)(e), 19)

**G-01 · Critical · No account or workspace deletion exists.**
No endpoint, flow, or tooling deletes a user or a workspace. Member removal only deletes the WorkOS org membership + two authz mirror rows (`apps/control-plane/src/features/workos-authz/admin-service.ts:135-157`; `apps/backend/src/features/workspace-authz/repository.ts:79-91`); the regional `users` row, all messages, memos, attachments, push subscriptions, and API keys survive — API keys are not even revoked (`revokeAllByUser` called only from a dead path, `apps/backend/src/features/user-api-keys/repository.ts:152-159`). A hard-delete path exists with zero callers (`apps/backend/src/features/workspaces/service.ts:319-329`), as do uncalled control-plane delete helpers (`apps/control-plane/src/features/workspaces/repository.ts:210-236`). `POST /api/accounts/remove` only revokes the session cookie (`apps/control-plane/src/features/accounts/service.ts:310-364`). The WorkOS identity is never deleted, and the WorkOS event poller doesn't even subscribe to `user.deleted` (`packages/backend-common/src/auth/workos-org-service.ts:52-54`).

**G-02 · Critical · Message deletion retains and keeps serving content.**
`DELETE` sets `deleted_at` only (`apps/backend/src/features/messaging/repository.ts:668-677`). Content (plus pgvector embedding) survives in: the `messages` row; the `message_created` event payload in append-only `stream_events` (only a marker event is added, `apps/backend/src/features/messaging/event-service.ts:1061-1072`); `message_versions` (every prior edit, no delete method, `version-repository.ts:45-77`); `sync_log` (30 days _and_ a 2,000-row-per-workspace floor regardless of age, `apps/backend/src/features/sync/retention-worker.ts:16-22`); and every member's IndexedDB (`apps/frontend/src/sync/stream-sync.ts:916-926`). Worst: **bootstrap still ships the deleted content to clients** — the enrichment adds `deletedAt` but leaves `contentJson`/`contentMarkdown` in the payload (`event-service.ts:1894-1900,1931-1932`); the frontend merely renders a tombstone (`apps/frontend/src/components/timeline/event-item.tsx:83-85`). Search "erasure" is a `deleted_at IS NULL` query filter, not removal (`apps/backend/src/features/search/repository.ts:203-380`).

**G-03 · High · Message attachments are never deleted from S3.**
The attachment delete endpoint refuses attached files (`403 "Cannot delete attached files"`, `apps/backend/src/features/attachments/handlers.ts:385-391`), and the orphan sweep only collects rows with no `messageId` (`apps/backend/src/features/attachments/service.ts:447-468`) — so deleting a message strands rows, `attachment_extractions` full text, and S3 bytes forever. Even explicit deletes remove only the primary key, orphaning thumbnails/transcodes/posters (`service.ts:832-854`). There are **no S3 lifecycle rules** anywhere in `infra/aws/`, and original filenames are embedded in S3 keys (`apps/backend/src/middleware/upload.ts:75`).

**G-04 · High · GAM memory ignores erasure.**
No handler in `features/memos/` subscribes to `message:deleted` (grep-verified); memos keep stale `source_message_ids`, and the memo detail view **re-hydrates deleted message content** because `MessageRepository.findByIds` has no `deleted_at` filter (`apps/backend/src/features/memos/explorer-service.ts:441`; `messaging/repository.ts:200-206`). Hard delete exists only for the caller's private-tier memos; shared memos — including ones extracted from DMs — are archive-only (`explorer-service.ts:305-327`, `handlers.ts:275-282`), and archived memos remain stored and browsable. User removal leaves names in abstracts and ids in `participant_ids`.

**G-05 · High · Broad no-retention zones (Art. 5(1)(e)).**
Never cleaned up (verified zero production delete callers): `stream_events`, `message_versions`, `agent_sessions` + `agent_session_steps` (full reasoning/tool-I/O traces), LangGraph checkpoints (`apps/backend/src/lib/ai/postgresql-checkpointer.ts:6-18`), `agent_conversation_summaries`, `context_summaries`, `ai_usage_records`, `user_activity`, `emoji_usage` (append-only behavioral logs), `link_previews`, `attachment_extractions`, both DLQ tables, expired `workspace_invitations` / CP `invitation_shadows` / `waitlist` (insert-only). `queue_messages` has a retention function with **zero production callers** (`apps/backend/src/lib/queue/repository.ts:373-407`); `researcher_cache.expires_at` is filtered on read but rows are never purged (`20260110223231_researcher_cache.sql:12,19`). The **control-plane outbox retains workspace-owner email+name in payloads indefinitely** — the retention worker exists in backend-common but is not wired into the control-plane (`apps/control-plane/src/server.ts:156-170` vs `apps/backend/src/server.ts:1381-1391`). The backend outbox purge also silently stops entirely if any listener cursor goes missing (`packages/backend-common/src/outbox/retention-worker.ts:94-98`).

**G-06 · Medium · Client-side residue survives logout.**
`clearAllCachedData()` deliberately preserves `drafts`, `pendingMessages`, and `uploadJobs` (file bytes as Blobs) across logout (`apps/frontend/src/db/database.ts:1389,1408-1430`); per-keystroke plaintext draft staging in localStorage has no E2E carve-out (`apps/frontend/src/lib/drafts/draft-staging.ts:88`); the service-worker `PUSH_BOOTSTRAP_CACHE` holds member names/emails outside the logout-cleared stores (`apps/frontend/src/sw.ts:315-323`, clearing **unverified**). Shared-device exposure.

**G-07 · High · Art. 19 is structurally unmet.**
Because erasure doesn't propagate, there is no mechanism to notify recipients (Langfuse, model providers, other members' devices, local agents holding delegation briefs) of any erasure — the obligation can't be discharged until G-01..G-04 exist.

### B. Transparency, lawful basis, consent (Art. 5(1)(a), 6, 7, 8, 12–14, 21)

**G-08 · Critical · No privacy policy, terms, imprint, or DPA — anywhere.**
Public site pages are index/about/developers only (`apps/public-site/src/pages/`); footers link no legal pages (`index.astro:882-886`, `about.astro:194-205`); the app, login, user-setup, and join screens contain no notice or terms reference (`apps/frontend/src/pages/login.tsx:23-25`, `user-setup.tsx:137`, `join.tsx:174-231`); repo-wide search for user-facing "privacy policy"/"terms of service": zero. Nothing configures a ToS/privacy display on the WorkOS hosted screen (`apps/control-plane/src/features/auth/handlers.ts:145-155`).

**G-09 · High · Waitlist collects emails with no Art. 13 notice and no exit.**
Only adjacent copy is "early 2026 · no spam" (`apps/public-site/src/pages/index.astro:871`). The confirmation email promises a future "spot" email but has no unsubscribe/removal link (`apps/control-plane/src/features/waitlist/email.ts:15-21`); the table is insert-only with no deletion path (`waitlist/repository.ts`).

**G-10 · High · AI processing is undisclosed and on by default.**
All message content flows to LLMs via OpenRouter and voice to ElevenLabs/Deepgram, disclosed nowhere user-facing. Memory extraction defaults to on (`memoryMode` default `'auto'`, `apps/backend/src/db/migrations/20260617120000_stream_memory_mode.sql:9`) and the only control is a per-stream toggle framed as a noise setting ("Extract and save knowledge from this stream's conversations", `apps/frontend/src/components/stream-settings/general-tab.tsx:402-431`). There is **no user-level or workspace-level AI/memory opt-out** (verified across `preferences.ts` / `workspace-settings.ts` keys). Under Art. 13(1)(c)+(e) and 5(1)(a) this processing must be named, given a lawful basis, and made controllable before external users join.

**G-11 · Medium · Non-member data subjects have no Art. 14 story.**
Invitee emails persist in two databases (`apps/backend/src/features/invitations/repository.ts:77`; CP `invitation_shadows`); the Linear integration stores the authorizing user's id/name/email (`apps/backend/src/features/workspace-integrations/service.ts:947-953`); external actors and people merely named in chat land in memos and suggestions (§D). No notice mechanism exists.

**G-12 · Medium · No age gating (Art. 8).** No age statement or gate anywhere (grep-verified); no ToS to carry a 16+ clause.

**G-13 · Medium · Undisclosed third-party requests from the browser.**
`fonts.cdnfonts.com` is loaded unconditionally for every app user (OpenDyslexic preload, `apps/frontend/index.html:71-77`) — the exact pattern of the German Google-Fonts rulings; the backoffice loads Google Fonts (`apps/backoffice/index.html:20-23`); Giphy renditions are fetched client-side from Giphy's CDN (`apps/backend/src/features/giphy/client.ts:104-105`). All trivially fixable (fonts are otherwise already self-hosted).

### C. Processors & international transfers (Art. 28, 44–49)

**G-14 · Critical · All content exits to OpenRouter (US) with no safeguards expressible in code.**
The endpoint is hardcoded (`packages/agent-runtime/src/ai/ai.ts:29`); there is no provider pinning, no EU routing, no ZDR/`data_collection` opt-out anywhere (grep-verified incl. models.yaml). Because GAM classifies/memorizes nearly every conversation, embeds **every message ≥10 chars** (`apps/backend/src/features/memos/embedding-worker.ts:36-46`), and enriches with attachment text and base64 images, this is a near-total egress of workspace content — not an opt-in feature. `docs/model-reference.md` notes an EU-pinned model exists, but no code pins it. Required: DPAs + SCC/transfer assessment with OpenRouter (and transitively Anthropic/OpenAI/Google), or EU-pinned direct endpoints.

**G-15 · High · Langfuse receives unmasked prompts, completions, and identity.**
`experimental_telemetry` is enabled with no `recordInputs/recordOutputs: false` and no mask function (`packages/agent-runtime/src/ai/ai.ts:611-636`; `apps/backend/src/lib/langfuse/langfuse.ts:42-53`); traces carry `userId`/`sessionId` (`langfuse.ts:81-92`); the agent observer writes tool I/O and final content onto spans (`packages/agent-runtime/src/runtime/otel-observer.ts:47-98`). Production `LANGFUSE_BASE_URL` is **unverified** (default is localhost); if it points at a hosted instance this is a second full-content processor with no retention control.

**G-16 · High · Voice audio streams to hardcoded US endpoints.**
`wss://api.elevenlabs.io/...` (`apps/backend/src/features/voice-transcription/transcription/realtime-elevenlabs.ts:16`) and `wss://api.deepgram.com/...` (`realtime-deepgram.ts:16`), plus user/workspace steering vocabulary (often names, `realtime-gateway.ts:245-250`). No EU endpoint option. Dictation polish also sends surrounding composer draft context to the LLM (`apps/frontend/src/hooks/use-voice-dictation.ts:720-726`).

**G-17 · High · `S3_REGION` silently defaults to `us-east-1`.**
`apps/backend/src/lib/env.ts:182` — while infra provisions only `eu-north-1`. A missing env var re-homes attachments/avatars to the US with no error, violating the repo's own fail-loudly principle (INV-11). Live prod value **unverified**.

**G-18 · Medium · Remaining sub-processor posture.**
WorkOS (US) is the canonical identity store (emails, names, invitation emails) with no region-configurable endpoint (`packages/backend-common/src/auth/types.ts:1-6`); Resend receives waitlist emails; Tavily receives conversation-derived search queries (regex redaction catches secrets, not natural-language personal data, `packages/agent-runtime/src/tools/web-search-tool.ts:51-63`); Cloudflare Workers TLS-terminate all API traffic (bodies, cookies, IPs) with no regional-services/data-localization config in any wrangler file; link-preview/oEmbed/`read_url` fetches disclose posted URLs server-side. A sub-processor register does not exist (→ G-34).

### D. AI layer & profiling (Art. 4(4), 5(1)(b), 9, 22, 35)

**G-19 · High · GAM builds personal profiles by default (Art. 4(4)) without a lawful-basis decision.**
The `save_memo` tool defines a per-user tier: _"'user' files it privately for the person you're helping (their 'about you' tier — personal facts, preferences)"_ (`apps/backend/src/features/agents/tools/save-memo-tool.ts:47-53`); passive extraction auto-files scratchpad content there (`memos/service.ts:81-86`). Whole conversations — **including DMs** (`service.ts:73-86`) — are sent identity-tagged (authorId, real names, timestamps, timezones/locales) to the classifier/memorizer (`apps/backend/src/lib/ai/message-formatter.ts:36-102`; `service.ts:325-351`); single messages qualify (`MIN_CONVERSATION_MESSAGES = 1`, `service.ts:44`). Memos are born `active` with no human review (`service.ts:582`), indefinitely retained, workspace-visible per access rules, and exposed via the public API (`features/public-api/routes.ts:302-347`). Adjacent profiling surfaces: rolling per-user conversation summaries, episode digests, AI task attribution with a **dismissed-suggestions negative-feedback loop deliberately retained** (`20260612181741_saved_suggestions.sql:11-13`; `saved-suggestions/config.ts:96,127-131`), per-user AI cost/quota records.

**G-20 · High · No Art. 9 special-category filter in extraction.**
The prompts are explicitly topic-neutral (_"Both turn on what the participants PRODUCED, never on the subject — any topic can pass or fail"_, `apps/backend/src/features/memos/config.ts:287`), and the memorizer is instructed to resolve pronouns to real names (`config.ts:345`) and treats person-events (e.g. hiring) as valid memos (`config.ts:338`). A durable statement about someone's health accommodation, religion, or politics passes every gate by design. The only redaction anywhere is secret-shaped (log headers, API-key patterns in bot traces). Config comments record the anti-gossip gate leaking in production under a prior model (`config.ts:31-33`).

**G-21 · Medium · Art. 22 — likely not triggered, but document it.**
No automation makes decisions with legal or similarly significant effects on humans: no AI moderation, suspension, access revocation, or delivery gating (grep-verified); persona auto-actions have no destructive tools and are timeline-visible; suggestions are pull-only; quota logic affects bots, not humans; rate limits are 429-only. Memo creation is the strongest candidate and still falls short of "legal or similarly significant effect" — but this assessment should be recorded, and human-contest paths (edit/archive/off-switch) kept intact as they are today.

**G-22 · High · No DPIA exists, and one is warranted (Art. 35).**
Systematic large-scale evaluation of personal aspects with innovative technology (automatic memory extraction, profiling tiers, workspace-wide knowledge synthesis) matches Art. 35(3)(a) and WP248 criteria. No DPIA, LIA, or processing-risk document exists in the repo.

**G-23 · Low · Purpose-limitation hygiene.**
Eval fixtures are modeled on the developers' real conversations with ids `user_kris`/`user_pierre` (`evals/suites/boundary-extraction/cases.ts:428-812`) and eval I/O forwards to Langfuse when keys are set (`evals/framework/langfuse.ts:76-84`); real names sit in frontend test fixtures (`apps/frontend/src/hooks/use-in-app-link-chip.test.ts:13`). No training/fine-tuning pipelines exist (verified).

### E. Data-subject-rights machinery (Art. 15, 16, 18, 20)

**G-24 · High · Art. 15 access cannot be satisfied for "data about me".**
Authored/readable data is enumerable via the public API/CLI (cursor-complete, access-scoped, presigned attachment downloads — `features/public-api/handlers.ts:1953-2261`), but data _about_ a person is not findable: memos have no subject index and `participant_ids` is never a query predicate (verified across `memos/repository.ts` search paths); Langfuse traces, LangGraph checkpoints, edit histories of others, push rows, CP tables, and logs are all out of reach. No consolidated access surface exists.

**G-25 · Medium · No export (Art. 20).**
No takeout/DSAR/export feature (grep-verified across export/takeout/dsar/csv/ndjson/zip/content-disposition); the public API is a de-facto portability path but requires the subject to script it with an API key.

**G-26 · Medium · No restriction mechanism (Art. 18).**
No flag pauses processing of a subject's data (verified); the only restriction-shaped control is E2E streams. A workspace/user-level "pause AI processing" switch would double as the Art. 18 mechanism.

**G-27 · Medium · Rectification leaves an immutable trail (Art. 16).**
Edits work, but every prior version is retained in `message_versions` and `message_edited` event payloads, and the full history is viewable by any stream reader (`GET /messages/:messageId/versions`, `apps/backend/src/routes.ts:587`) with no redaction path. Third parties described in memos have no rectification route at all (they lack stream access by definition).

**G-28 · Medium · AI-usage endpoint over-exposes.**
`GET /ai-usage` returns workspace-wide per-user cost records to **any** member (`apps/backend/src/routes.ts:712-713`; `features/ai-usage/handlers.ts:45-100`) — a minimisation/access-control mismatch in the other direction.

### F. Security of processing (Art. 32, 25)

**G-29 · High · No supply-chain security in CI.**
No dependency-vulnerability scanning, SAST, secret scanning, or Dependabot anywhere (`.github/` grep-verified for snyk/codeql/dependabot/trivy/semgrep/gitleaks/osv; no `dependabot.yml`). For an Art. 32 "state of the art" argument this is the weakest point.

**G-30 · Medium · Deployment-dependent assurances not asserted in code.**
DB TLS: `createDatabasePool` sets no `ssl` option — encryption depends entirely on the deploy-time `DATABASE_URL` (`packages/backend-common/src/db/index.ts:38-43`). Backups/restore/DR: nothing in the repo (Railway-managed, no restore-test evidence, no RPO/RTO). `/internal/*` on the internet-reachable backend rests on one static shared secret (timing-safe compare, but no rotation/mTLS — `packages/backend-common/src/middleware/internal-auth.ts:12-27`). The migration append-only guard runs only in bypassable pre-commit, not CI (`scripts/check-migrations.ts:95-122`; `.github/workflows/ci.yml:34-41`). The db-read-proxy exposes read-only prod SQL behind a single shared secret (`apps/db-read-proxy/src/auth.ts:4-25`).

**G-31 · Medium · PII in operational logs.**
Base pino logger has no `redact` config (`packages/backend-common/src/logger.ts:14-37`); raw emails logged at info/debug in auth and invitation paths (`packages/backend-common/src/auth/auth-service.ts:186,237`; `workos-org-service.ts:195`; `apps/backend/src/features/invitations/service.ts:218`; `apps/control-plane/src/features/invitation-shadows/service.ts:302`); client IP + full headers + URL logged on every 4xx/5xx via the default req serializer (`apps/backend/src/app.ts:71-108`); control-plane response bodies logged verbatim (`apps/backend/src/lib/control-plane-client.ts:62,93,199`); user search queries logged in several agent/search paths. Log retention is Railway-side, **unverified**. Message content itself is not logged (verified).

**G-32 · Medium · Miscellaneous Art. 25 defaults.**
Avatars (face images) served unauthenticated via unguessable URLs with `Cache-Control: public, max-age=31536000, immutable` — no revocation on membership change (`apps/backend/src/routes.ts:709-710`; `features/workspaces/handlers.ts:446-468`). `bot_invocations.claim_token` stored cleartext while the sibling `delegated_tasks` hashes its token (`20260516190000_bot_runtime_invocations.sql:76` vs `20260709100000_delegated_tasks.sql:32`). CSRF defense is SameSite=Lax only (no token, no tests). Continuous device-timezone harvesting via socket heartbeats into `users.timezone` (`apps/backend/src/socket.ts:92-105`) plus fine-grained `last_interaction_at` presence — functional, but a coarse location/behavior signal collected without notice. S3 CORS `GET` from `*`. 30-day sealed session cookies.

### G. Accountability (Art. 24, 30, 33/34, 37)

**G-33 · High · No records of processing (Art. 30).**
The Art. 30(5) small-org derogation is unavailable — processing is not occasional. No ROPA, sub-processor register, or DPA inventory exists. (§5 of this document is a starter.)

**G-34 · High · No breach process (Art. 33/34).**
Nothing in the repo detects, documents, or routes a personal-data-breach notification (72-hour clock). The observability stack (Grafana/metrics) is operational, not breach-oriented; the outbox DLQ has no alert (`unDlq()` uncalled, `apps/backend/src/lib/queue/repository.ts:354`).

**G-35 · Low · DPO (Art. 37) likely not yet mandatory** at current scale, but designate a named privacy owner and revisit at team-onboarding scale — GAM is arguably "regular and systematic monitoring" if it grows large-scale.

---

## 5. Personal-data inventory (ROPA starter)

Condensed; full per-table detail with migration citations lives in the audit working notes. **Regional DB (workspace-scoped, EU):** identity/profile (`users` — email, name, pronouns, phone, github, timezone, status; trigram-indexed name+email), content (`messages` + embeddings + reactions, `stream_events` append-only, `message_versions`, `drafts`, `scheduled_messages`, `attachments` + extractions + PDF/OCR text), AI derivatives (`memos` + `participant_ids` + embeddings, `conversations` + topic summaries, `agent_sessions`/`agent_session_steps` full traces, conversation/episode summaries, `saved_suggestions`, `ai_usage_records` per user, `agent_follow_ups`, `delegated_tasks`, personas + attachments, `bot_invocations` incl. prompt text), behavioral/device (`user_activity`, `emoji_usage`, `user_sessions` presence, `push_subscriptions` + raw user-agent, read receipts, preferences/layout), crypto/keys (`user_api_keys` hashed, `user_e2e_keys` wrapped, E2E key wraps, encrypted integration credentials), infra-with-content (`outbox`, `sync_log`, `queue_messages`, DLQs, `socket_io_attachments`). **Control-plane DB (global, EU-hosted):** workspace registry, memberships, `invitation_shadows` (emails), `platform_roles`, WorkOS mirrors, `waitlist` (emails), CP outbox (owner email+name in payloads). **Outside Postgres:** S3 (attachments incl. filename-bearing keys, avatars, video), client IndexedDB/localStorage/SW caches, push vendors (encrypted), Langfuse (prompts/completions + ids), OpenRouter (all AI I/O), ElevenLabs/Deepgram (live audio), WorkOS (identity), Resend (waitlist), Railway stdout logs, user-machine extension state (API keys, `~/.pi/agent/threa-remote.json`).

---

## 6. Remediation roadmap

### P0 — before any external EU user joins a workspace

1. **Transparency layer** (G-08, G-09, G-10, G-13): privacy policy + ToS on the public site and linked from login/setup/join; terms acceptance at signup; waitlist notice + removal link; disclose all processors including the AI chain; self-host the OpenDyslexic font.
2. **Erasure, designed once, applied everywhere** (G-01..G-04, G-07): account deletion (WorkOS identity + regional purge + S3 + client-notify), workspace deletion with full cascade, hard message deletion that redacts `stream_events`/`message_versions` payloads and deletes attachment objects + derivatives, memo propagation on source deletion (or subject-scoped memo purge). The event log needs a redaction mechanism — payload scrubbing or crypto-shredding (per-message keys); append-only (INV-17) governs migration files, not row content.
3. **Transfer control for the AI chain** (G-14, G-15, G-16, G-17): DPAs/SCCs with OpenRouter (or move to EU-pinned direct provider endpoints), enable whatever ZDR/data-collection opt-outs exist; set `recordInputs/recordOutputs: false` or a mask function for Langfuse telemetry + pin an EU/self-hosted instance with retention; make `S3_REGION` required (fail loudly); document the voice-provider transfer basis or gate dictation behind explicit opt-in.
4. **Accountability minimum** (G-22, G-33, G-34): DPIA covering GAM + a legitimate-interest assessment for default memory extraction; ROPA (start from §5); a one-page breach-response runbook with the 72-hour path.

### P1 — shortly after / alongside team onboarding

5. **Retention** (G-05): wire `deleteOldMessages`; add CP outbox retention; TTLs for agent traces/checkpoints/summaries, DLQ policy, researcher_cache purge, expired-invitation and waitlist cleanup; fix the null-watermark outbox purge stall.
6. **AI consent & controls** (G-19, G-20): a real user/workspace-level AI-processing setting; decide DM-memorization policy (opt-in is the defensible default); reframe `memoryMode` as a privacy control; add a special-category guard to classifier/memorizer prompts with an eval; document the Art. 22 assessment (G-21).
7. **DSR machinery** (G-24..G-27): export endpoint (JSON takeout); make `participant_ids` queryable for subject search; an Art. 18 restriction flag (can reuse the AI-processing pause); a policy for edit-history redaction.
8. **Security** (G-29..G-32): Dependabot + osv/gitleaks in CI; assert `sslmode=require`; base-logger redact paths for emails/IPs; auth or short-TTL URLs for avatars; hash `bot_invocations.claim_token`; scope `/ai-usage` to admins or self; move the migration guard into CI.

### P2 — hygiene

9. Clear drafts/pending/upload stores + SW caches on logout (G-06); age statement in ToS (G-12); Art. 14 wording for invitees/integration identities (G-11); document backup/restore + a restore test (G-30); CSRF token; sub-processor page; purge real names from test/eval fixtures (G-23); presence/timezone collection note in the privacy policy (G-32).

---

## 7. Unverified items (deployment console, not repo)

Production values of `LANGFUSE_BASE_URL` (and whether Langfuse is enabled in prod), `S3_REGION`, `DATABASE_URL` sslmode; Railway log retention and backup/PITR configuration; whether `ws-eu.threa.io` is Cloudflare-proxied; SW cache clearing on logout; `socket_io_attachments` adapter cleanup; any out-of-band control-plane outbox pruning; physical processing regions of OpenRouter, WorkOS, Tavily, ElevenLabs, Deepgram, Resend, Giphy; existence of signed DPAs with any provider.
