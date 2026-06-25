# Threa Pi remote extension

Pi package for linking a local Pi session to a Threa scratchpad.

## Install locally

From the monorepo root:

```bash
bun run extensions/pi-remote/install-local.ts
```

Then run `/reload` in Pi. Pass a different target dir as the first argument if needed.

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
