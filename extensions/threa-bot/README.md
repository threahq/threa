# @threahq/bot

Run any command as a Threa bot.

```sh
npx @threahq/bot connect
npx @threahq/bot run -- my-agent --answer
```

`connect` prints a URL and a code. Open it, pick a workspace, confirm, and the
bot plus its key are created for you; the key lands in `~/.threa/bot.json`.
`run` then executes `my-agent --answer` once per turn with the message text on
stdin. Whatever it prints to stdout is posted as the reply; stderr lines appear
as trace steps while it works. That is the whole contract, so a shell script, a
Python program, or an agent CLI all qualify.

Node 20+ or Bun, on macOS or Linux (the agent runs in its own process group and
is stopped with POSIX signals; Windows is not supported yet).

## Credentials without connect

`run` also reads `THREA_WORKSPACE_ID` and `THREA_API_KEY` from the environment
(`THREA_BASE_URL` defaults to `https://app.threa.io`), or a JSON file passed
with `--config`. The key has to be a `threa_bk_` bot key with
`bot-runtime:write`, `bot-invocations:write`, `messages:write`,
`messages:read`, `streams:read`, `attachments:read`. `THREA_BOT_CONFIG` moves
the file `connect` writes.

## Two modes

`threa-bot run -- <command>` links a scratchpad for the directory you run it in
and prints its URL. `--session <name>` runs several side by side in one
directory, each with its own scratchpad; the same name resumes the same one. Every message in that scratchpad is a turn; `/stop` kills
the running command, `/steer <text>` kills it and starts a new turn with the
steer text. Restarting in the same directory returns to the same scratchpad.

`threa-bot run --mention -- <command>` owns nothing. Whenever someone
`@mentions` the bot in any stream, the command runs with that message and the
reply lands in the same stream.

## What the command sees

- stdin: the turn's text. In scratchpad mode this includes recent scratchpad
  history after the message, formatted the way the SDK hands it to any
  connector.
- `THREA_INVOCATION_ID`, `THREA_STREAM_ID`, `THREA_SOURCE_MESSAGE_ID` in the
  environment. The bot key is not passed on: everything the command writes to
  stderr becomes trace visible to the stream, so a command that needs the API
  gets its own key.
- Output over 48 000 characters is cut with a note; a non-zero exit posts the
  exit code and the last lines of stderr as the reply; `--timeout <ms>` kills a
  turn that runs too long.

## Options

```text
connect --base-url <url>   Threa origin (default https://app.threa.io)
connect --name <name>      shown to whoever approves

run --mention      answer @mentions instead of owning a scratchpad
run --session <s>  run several sessions in one directory; same name = same scratchpad
--name <prefix>    scratchpad name prefix (default: the command's basename)
--config <file>    JSON config; environment variables win over it
--timeout <ms>     kill the command after this long per turn
```

Built on [`@threahq/remote-session`](https://www.npmjs.com/package/@threahq/remote-session);
a connector that needs more than stdin/stdout (mid-turn steering, interim
messages, attachments) starts from that package instead.
