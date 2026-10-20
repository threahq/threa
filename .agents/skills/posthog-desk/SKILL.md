---
name: posthog-desk
description: >-
  Use when a message in your active scratchpad carries `posthog.` metadata (an error-tracking
  alert with `posthog.issue`, or the weekly `posthog.event: tick`), or when asked to set up or
  repair the PostHog desk: the hook, the PostHog destinations, the tick.
---

# PostHog desk

One long-lived scratchpad is the desk. PostHog posts into it through a Threa incoming webhook,
and the desk session (you, when this fires) turns each alert into a triage thread spawned on the
alert message. The webhook stamps `posthog.issue` and `posthog.event` as message metadata; the
invocation prompt lists them under `Message metadata:`. Metadata is the trigger, never the text:
a human pasting a PostHog link in the desk is a conversation, not an alert.

## On an alert

The `<channel>` event's `stream_id` is the desk, `source_message_id` is the alert.

1. **Dedupe.** `threa messages find-by-metadata posthog.issue=<id> --stream <stream_id> --json`.
   A hit other than this message with `replyCount > 0` already has a triage thread: find it with
   `threa streams read <stream_id>` (messages carry `threadStreamId`), `reply` with one line
   linking that thread, and stop. A reopened or spiking issue with a thread goes there too:
   `threa messages send <threadStreamId> "<what PostHog reported>"` before you stop.
2. **Spawn the triage thread** on the alert message. Write the brief below to a `mktemp` file and
   run

   ```bash
   threa-harnessd spawn claude --name posthog-<first 8 chars of issue id> \
     --attach <stream_id> --anchor <source_message_id> --brief-file <path>
   ```

   harnessd deletes the brief file and delivers it as the thread's first prompt.

3. **Reply once** in the desk with the thread's name. The spawned session owns everything after.

Brief for an issue (fill the angle brackets from the alert message):

```text
PostHog error-tracking <created|reopened|spiking> issue <issue id>: <name> — <description>.
Open it: <issue link from the message>.

Triage it from this worktree. Load the `monitor-prod` skill and run
`bun run monitor status --only posthog --since 5d` for the surrounding picture, then query the
issue's own events over HogQL (`scripts/monitor/posthog.ts` holds the client, the UTC timestamp
rule and the `$exception` columns; `$exception_issue_id = '<issue id>'`). Find the cause in the
code, not just the symptom.

Reply in this thread with: what breaks and for whom, since when and how often, the cause
(file:line), and the fix. If the fix is small and safe, open a PR from a branch off main and link
it; never merge. If it is noise, say why and what filter would silence it.
```

## On the tick

`posthog.event: tick` arrives from the scheduled workflow once a week. Spawn the same way with
`--name posthog-tick-<YYYY-MM-DD>` and this brief:

```text
Weekly PostHog check-in. Load the `monitor-prod` skill, run
`bun run monitor status --only posthog --since 5d`, and triage every finding it reports: new
error templates, rate rises, new exception groups. Reply in this thread with one line per
finding (what, since when, cause or "noise because …", action taken). Open a PR for anything
small and safe; never merge.
```

## Setting up the desk

The pieces, in the order they depend on each other:

1. **Two bots.** The desk scratchpad is linked to the runtime bot that spawns you. The hook needs
   a _different_ bot (call it `posthog`): the route resolver ignores a bot's own posts, so a hook
   on the runtime bot would never invoke the desk.
2. **The hook.** In the `posthog` bot's settings create an incoming webhook targeting the desk
   scratchpad (a hook may target a channel or a root scratchpad). Keep the native URL; the
   `/slack` variant drops metadata.
3. **PostHog destinations** (Error tracking → Configuration → Alerting → New notification, one per
   trigger: issue created, issue reopened, issue spiking). Destination type HTTP Webhook, method
   POST, URL = the hook's native URL, header `Content-Type: application/json`, JSON body:

   ```json
   {
     "content": "🔴 **{event.properties.name}** created: {event.properties.description}\n\n[Open in PostHog]({project.url}/error_tracking/{event.distinct_id})",
     "metadata": {
       "posthog.issue": "{event.distinct_id}",
       "posthog.event": "{event.event}"
     }
   }
   ```

   Swap `created` for `reopened` or `spiking` in the other two destinations. The lifecycle
   event's `distinct_id` is the issue id; `event.event` is
   `$error_tracking_issue_created`, `$error_tracking_issue_reopened` or
   `$error_tracking_issue_spiking`. Use PostHog's "Test function" against the hook: the desk
   should spawn a thread on the test message, which is the whole loop proven once.

4. **The tick.** `.github/workflows/posthog-desk-tick.yml` posts to the hook every Monday; it
   reads the repository secret `THREA_POSTHOG_DESK_HOOK_URL` (the native URL) and skips when it
   is unset. `gh workflow run posthog-desk-tick.yml` fires it on demand.
