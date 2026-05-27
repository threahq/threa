# Threa Pi remote extension

Pi package for linking a local Pi session to a Threa scratchpad.

## Install locally

```bash
rm -f ~/.pi/agent/extensions/threa-remote.ts
rm -rf ~/.pi/agent/extensions/threa-remote
mkdir -p ~/.pi/agent/extensions/threa-remote
cp -R extensions/pi-remote/. ~/.pi/agent/extensions/threa-remote/
cd ~/.pi/agent/extensions/threa-remote
npm install
```

Then run `/reload` in Pi.

The package declares `socket.io-client` because the `/bot` WebSocket transport is required. Pi discovers the extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/threa-remote.ts"]
  }
}
```
