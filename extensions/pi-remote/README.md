# Threa Pi remote extension

Pi package for linking a local Pi session to a Threa scratchpad.

## End-to-end encrypted scratchpads

The extension serves sealed (E2EE) turns via `@threa/bot-runtime-client`'s sealed
module. On first presence write it mints a BIK (Bot Identity Key, an X25519
keypair persisted `0600` at `~/.pi/agent/threa-remote-bik.json`) and registers
the public half on every hello/presence. Once the scratchpad owner invites this
bot into an encrypted scratchpad (which wraps the stream key to the BIK), claims
arrive sealed: the extension decrypts the trigger + history locally, runs the
turn, and seals every reply and trace step back under the stream key — the
server only ever stores ciphertext.

## Trace detail

Plaintext traces default to `traceMode: "headline"`. This records tool categories and safe file summaries but hides shell commands, file bodies, patches, and tool results.

Set `traceMode: "commands"` in `~/.pi/agent/threa-remote.json` to include only the Bash command field. Commands are capped at 2,000 characters; write/edit payloads and every tool result remain hidden. Multiline commands show only their first line in the headline; the bounded command stays in the collapsed Details section. Inline scripts and heredocs are part of that command and may appear up to the cap. Plaintext commands are sent to Threa and stored with the trace, so leave headline mode enabled when commands may contain credentials or file content.

Because the server can't read sealed step content, sealed turns default to FULL
trace detail (real commands, file contents, tool output) instead of the
"omitted for safety" redactions headline mode keeps. Set `sealedFullTrace:
false` to use the configured `traceMode` on sealed turns too. For command-only
traces everywhere, use `traceMode: "commands"` with `sealedFullTrace: false`.
The toggle can never enable full detail on a plaintext turn. Attachments (`THREA_ATTACH:`) work on
sealed turns too: the file is encrypted locally under a fresh single-use key,
only ciphertext is uploaded (placeholder name/mime on the server), and the key
rides sealed inside the reply payload — inbound attachments are likewise
fetched as ciphertext and decrypted locally. Deleting the BIK file orphans the
owner's key wraps; the owner must re-invite the bot after it registers a fresh
key.

## Install locally

From the monorepo root:

```bash
bun run extensions/pi-remote/install-local.ts
```

Then run `/reload` in Pi. Pass a different target dir as the first argument if needed.

For harness-managed sessions, `/kick` in the linked scratchpad asks harnessd to send Enter to the session's recorded tmux pane, useful when Pi is waiting on a blocking prompt. `/reconnect [--force]` is offered only to a live, linked Pi running in tmux; it acknowledges first, then asks harnessd to replace the pane process and resume the same Pi session. `--force` may bypass only local Pi activity; an owned pending Threa invocation always fails closed and must be cleared with `/stop` first. The command cannot recover a disconnected runtime. Direct `harnessd reconnect` for Pi has no activity signal, so `--force` is currently inert there; this intentionally does not add IPC, status reporting, or another supervisor.

`/key <name>` sends one key to the exact live linked Pi pane. Allowed names are `escape`, `enter`, `up`, `down`, `left`, `right`, `tab`, `backspace`, `ctrl-c`, `ctrl-d`, and `ctrl-u`. Names are case-sensitive; text, aliases, sequences, and repeats are rejected.

The script rebuilds `~/.pi/agent/extensions/threa-remote` from scratch each time, so re-running it is the supported way to update.

### Why a script and not `cp -R` + `bun install`

`@threa/bot-runtime-client` is a private sibling package referenced via
`file:../bot-runtime-client`. That resolves inside the monorepo, but a standalone copy
has no sibling and the package isn't on npm, so a plain copy + install can't resolve it.
The script vendors bot-runtime-client's source into `src/vendor/bot-runtime-client/`,
repoints the import, and drops the dependency. Its only runtime dependency,
`socket.io-client`, stays a direct dependency because the `/bot` WebSocket transport
requires it. Pi discovers the extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/threa-remote.ts"]
  }
}
```
