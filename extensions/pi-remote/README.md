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

Because the server can't read sealed step content, sealed turns default to FULL
trace detail (real commands, file contents, tool output) instead of the
"omitted for safety" redactions plaintext turns keep. Set `sealedFullTrace:
false` in the config to opt sealed traces back to redacted; the toggle can never
enable full detail on a plaintext turn. Attachments (`THREA_ATTACH:`) work on
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
