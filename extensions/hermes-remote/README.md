# @threahq/hermes-remote

A Threa connector for a local [Hermes Agent](https://github.com/NousResearch/hermes-agent) gateway. It links a Threa scratchpad to one Hermes
conversation: every turn the scratchpad hands it becomes one Hermes run (`POST /v1/runs`), the run's tool and
subagent events are traced back as steps on the turn, and the run's terminal event closes the turn: the final
output as the reply, a failure as a failed invocation, a cancellation as no response. Each run carries a short
`instructions` note (write markdown, load the `threa` skill); the skill holds Threa's markdown reference.

## Running it

```sh
npm install -g @threahq/hermes-remote
threa-hermes
```

From a checkout of the Threa repo, `bun run start` in this directory runs the same connector from source.

Environment:

| Variable                                                                                      | Required | Default                 |
| --------------------------------------------------------------------------------------------- | -------- | ----------------------- |
| `THREA_WORKSPACE_ID`                                                                          | yes      | none                    |
| `THREA_API_KEY`                                                                               | yes      | none                    |
| `THREA_BASE_URL`                                                                              | no       | `https://app.threa.io`  |
| `HERMES_API_URL`                                                                              | no       | `http://127.0.0.1:8642` |
| `HERMES_API_KEY`                                                                              | yes      | none                    |
| `THREA_E2E`, `THREA_IDLE_TIMEOUT_MS`, and the rest of the `@threahq/remote-session` variables | no       | see that package        |

The same keys can live in `~/.threa/hermes-remote/config.json` (the Hermes ones as `hermesApiUrl` / `hermesApiKey`);
environment variables win.

## What it writes

- `~/.threa/hermes-remote/work`: the connector's working directory, where reply attachments are resolved from.
- `~/.threa/hermes-remote/threa-cli.json`: a `ThreaConfig` (0600) for the `threa` MCP server on the Hermes side, so
  Hermes speaks to the same workspace as the same bot. Point that server's `THREA_CONFIG` at this file.
- `~/.threa/e2e-keys/`: the fall-back home for this install's end-to-end key when you ask for the file store rather
  than the OS keychain. See [Encrypted scratchpads](#encrypted-scratchpads).

Hermes' `MEDIA: <path>` output lines are rewritten to `THREA_ATTACH: <path>`, so the SDK uploads them as attachments;
an output of exactly `THREA_NO_RESPONSE` closes the turn silently.

## Commands and approvals

The scratchpad offers five session-control commands:

`/stop` stops every open run and closes its turn. `/steer` folds text into the running run; if Hermes will not take it
right now (the run is queued or already finishing) the text is held and prepended to the next turn instead. `/status`
reports the conversation id, every open run with its status, the model this process locked, and the gateway URL.
`/model` locks the conversation to one of the gateway's models, given as `provider::model`, a model id, or any
substring that matches exactly one of them. `/clear` starts a fresh conversation on the scratchpad, which is refused
while any run is open in the session; a model set with `/model` is locked onto the new conversation too, and the
command says so if that lock fails. Commands act on the scratchpad's conversation even when typed in a thread. The
generation counter lives in `~/.threa/hermes-remote/work/conversations.json`, so a new conversation survives a restart.

When Hermes asks to run a command, the request arrives in the scratchpad as a decision card with the command, its
description and the choices Hermes offered (allow once, allow this session, always allow, deny). Answering resolves the
run. A denial with a note sends the note back to the run as a steer. An unanswered card runs into the gateway's own
approval timeout, which denies it. Under Hermes's default `approvals.mode: smart`, its guardian model approves the
flagged commands it judges safe without a card, and only the ones it escalates become cards. Set `approvals.mode:
manual` for a card on every flagged command. The card expires at 5 minutes to match Hermes's default
`approvals.timeout`, and a run that ends withdraws any card still open.

## Threads

The scratchpad is one Hermes conversation, keyed by the stream id. A turn on a thread under the scratchpad or an aside
runs in its own conversation, forked once from the scratchpad's current conversation
(`POST /api/sessions/{root}/fork`), so a thread opens with the scratchpad's context and then diverges: nothing said in
a thread comes back to the scratchpad.

The fork happens on the thread's first turn and is recorded in `conversations.json`, so a restart does not re-fork. If
the scratchpad has not run a turn yet, there is nothing to fork from: the thread starts a fresh conversation and the
connector logs it. Any other fork error fails the turn with the error Hermes returned.

`/clear` bumps the scratchpad's generation only. Threads forked before it keep their own conversation, so their next
turn still carries the pre-clear context; a thread first used after the `/clear` forks from the new conversation.

A mention of the bot outside the scratchpad, in a channel, a DM or one of their threads, is never forked from the
scratchpad. It runs in a fresh conversation keyed by the stream it arrived on, so nothing from the scratchpad reaches
that audience through the conversation.

Conversation history stays per stream, but Hermes's built-in memory does not. Whatever the agent saves with its
`memory` tool lands in `~/.hermes/memories/MEMORY.md` and `USER.md`, which load into every new session on the profile,
channel mentions included. `X-Hermes-Session-Key` is keyed by the turn's root stream, and it only separates an
external memory provider (`memory.provider`, such as Honcho) and the prompt cache. Run a separate Hermes profile if a
channel audience must never see what the scratchpad saved (see [Several agents on one box](#several-agents-on-one-box)).

## Attachments

Inbound: the SDK downloads files attached to a message, including on sealed scratchpads, and appends a manifest of
names and local paths to the turn content. Hermes reads them from those paths.

Outbound: a `THREA_ATTACH: <path>` line in the run output uploads that file and replaces the line with an attachment.
Hermes' own `MEDIA: <path>` lines are rewritten to `THREA_ATTACH:` first, so both work. Relative paths resolve against
`~/.threa/hermes-remote/work`.

## Encrypted scratchpads

Set `THREA_E2E=1` and the scratchpad the connector links is created sealed. Turns, replies, steps and attachments are
encrypted end to end, and so are approval cards: the question and its button labels travel inside the ciphertext, and a
note you attach to the answer comes back to the agent decrypted. The server sees the option ids and tones, which is
what it needs to check that an answer names a button on the card.

You have to set up encryption in Threa first, under Settings, so there is an owner key to wrap the scratchpad to. Until
then the connector logs why it cannot create the scratchpad and retries on each poll.

Turning `THREA_E2E=1` on later does not seal the scratchpad you already have. The connector resumes it, warns that it
is plaintext and keeps going; archive it and the next start creates an encrypted one.

On first start the connector mints an identity key of its own and files it in the OS keychain, reached through that
keychain's command-line tool so a runtime upgrade does not lose it. `THREA_E2E_KEY_STORE=file` keeps it as a `0600`
file under `~/.threa/e2e-keys` instead (`THREA_E2E_KEY_DIR` moves that directory). If no keychain is available and you
have not chosen, start-up fails and names both options rather than quietly writing to disk. A `~/.threa/bik-hermes.json`
from an older build is adopted on first start, so scratchpads already sealed to it keep opening.

One key covers every sealed scratchpad this box serves. `THREA_E2E_KEY_SCOPE` narrows that: `identity` is one key for
this bot wherever it runs, `instance` one for this install alone, and `stream` mints a key per scratchpad as the bot is
invited into it, so a leaked key opens one scratchpad instead of all of them.

To let the agent into a scratchpad you created yourself, use "Invite agent" in its header and pick the bot. That is
what wraps the stream key to the connector's key. Removing the bot again deletes the wraps it could open and rolls the
scratchpad's key forward, so it reads nothing sent from then on; messages it already read stay readable to it. The
connector is told, drops the key it held for that scratchpad and re-advertises the rest. Under the default host scope
there is nothing to drop: the same key still opens your other scratchpads, and the roll is what closed this one.

## Installing

1. Install Hermes and its gateway:

   ```sh
   curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
   hermes gateway install
   ```

   Keep Hermes's default `approvals.mode: smart`. Its guardian model runs flagged commands it judges safe, and the
   connector turns every command it escalates into a Threa decision card. Use `approvals.mode: manual` instead for a
   card on every flagged command. Also set `approvals.unattended_mode: approve`. It covers the gates the API server
   cannot forward, such as plugin tool rules, and approves them. Register the `threa` MCP server in `~/.hermes/config.yaml`
   so Hermes can read and post in the workspace as the bot (the connector writes the config file it points at):

   ```yaml
   mcp_servers:
     threa:
       command: "npx"
       args: ["-y", "@threahq/cli", "mcp", "serve"]
       env:
         THREA_CONFIG: "/home/you/.threa/hermes-remote/threa-cli.json"
   ```

2. Write the connector's env file, `~/.config/threa/hermes-remote.env`:

   ```sh
   THREA_WORKSPACE_ID=ws_...
   THREA_API_KEY=...
   THREA_BASE_URL=https://app.threa.io
   THREA_E2E=0          # 1 seals the scratchpad end to end
   HERMES_API_URL=http://127.0.0.1:8642
   HERMES_API_KEY=...
   ```

3. Install the package and its systemd user service:

   ```sh
   npm install -g @threahq/hermes-remote
   threa-hermes-install --start
   ```

   The unit runs the installed package with the node that installed it, so `npm update -g @threahq/hermes-remote`
   and a `systemctl --user restart threa-hermes-remote` upgrade it. The installer refuses to run from `npx`, whose cache
   npm clears under a running unit. From a checkout, `bun run install-service --start` writes a unit that runs the
   checkout with bun instead.

   It writes `~/.config/systemd/user/threa-hermes-remote.service` (refusing to overwrite an existing one without
   `--force`), creates `~/.threa/hermes-remote/log/`, installs the `threa` skill into `~/.hermes/skills/threa/SKILL.md`
   and a starting `~/.hermes/SOUL.md` if there is none, then runs `systemctl --user daemon-reload` and
   `enable`. `--start` also restarts the unit; `--dry-run` prints every file and command without doing any of it,
   including an existing unit it would refuse. `--profile <name>` installs a second agent instead (below). Any other
   argument is rejected. Logs land in `~/.threa/hermes-remote/log/connector.log`. Linux only.

## From nothing to a sealed scratchpad

The whole path on a fresh box, if you have a Threa workspace and nothing else. It takes about fifteen minutes, most of
it waiting on the Hermes install.

1. **Set up your encryption key.** In Threa: Settings, the AI tab, "Encrypted scratchpads", "Set up encryption". Pick
   a passphrase and save it somewhere you trust. There is no recovery, and losing it loses every sealed scratchpad.
   Everything below wraps to this key, so it has to exist first.

2. **Make the bot.** Workspace settings, the Bots tab, "Create personal bot". Give it the `mentionable` and
   `active-scratchpad` traits. Then "Create key" on that bot with the scopes `bot-runtime:write`,
   `bot-invocations:write`, `messages:write`, `streams:read`, `messages:read` and `attachments:read`. Add
   `attachments:write` if you want the agent to send files back. Copy the `threa_bk_…` key; it is shown once.

3. **Install Hermes and the connector** as under [Installing](#installing), with `THREA_E2E=1` in the env file.

4. **Watch the scratchpad appear.** On first start the connector mints its own key, files it in your OS keychain, and
   creates a sealed scratchpad linked to itself. Write in it and the agent answers; the bodies, the trace steps, the
   attachments and the approval cards are all ciphertext on the server.

5. **Read it from the terminal, as you.** `threa e2e unlock` asks for the passphrase from step 1 and files your key
   next to the connector's. `threa streams read <stream_id>` then prints the messages rather than the placeholders the
   server stores, and `threa messages send <stream_id> "…"` seals before anything leaves the machine.

If step 4 logs that it cannot create the scratchpad, step 1 has not happened for the account the bot's key belongs to.
The connector retries on every poll, so finishing the setup in Threa is enough. No restart.

## Several agents on one box

Every path above belongs to one install. A second agent is a second Hermes profile with a connector of its own, and
`--profile <name>` is the only thing you pass differently: the name is the Hermes profile name, so one identifier
names the persona, the memories, the gateway route and the Threa bot behind it.

```sh
hermes profile create muse            # required first: the connector refuses a profile Hermes does not know
threa-hermes-install --profile muse --start
```

The named install shares nothing with the default one: unit `threa-hermes-muse.service`, env file
`~/.config/threa/hermes-muse.env`, config, work dir, logs and MCP config under `~/.threa/hermes-muse/`, and `SOUL.md`
plus the `threa` skill in the profile's home, `~/.hermes/profiles/muse/`. Give it its own `THREA_API_KEY`. A bot is one
agent, and two connectors on one key would answer each other's mentions.

The end-to-end key is the one thing they do share, on purpose: the default `host` scope is one key for every Threa
runtime on the machine, so inviting either agent into a sealed scratchpad lets both open it. Set
`THREA_E2E_KEY_SCOPE=identity` on each if they must be separable. `~/.threa/hermes-muse/bik.json` is only the
pre-keyring file a named install would adopt if one were ever written there.

Two things on the Hermes side:

- The gateway serves a secondary profile under `/p/<name>/` on the one listener, which is where the connector points
  by default. It 404s a prefix it does not serve, so a misrouted connector fails instead of reaching the wrong agent.
  Set `HERMES_API_URL` in the env file if your gateway is laid out differently.
- `HERMES_API_KEY` is per profile: read the new profile's `API_SERVER_KEY`, not the default profile's.

Point the profile's `threa` MCP server at its own config, `~/.threa/hermes-muse/threa-cli.json`, in
`~/.hermes/profiles/muse/config.yaml`. The skill the installer writes into that profile already names these paths.
