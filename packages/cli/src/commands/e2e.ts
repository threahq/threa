import { e2eKeyStatus, lockE2eKey, unlockE2eKey } from "../e2e-keys"
import { UsageError, type NounSpec, type VerbSpec } from "../output"
import { KEY_STORE_FLAGS as STORE_FLAGS, KEY_STORE_OPTIONS, storeChoice } from "./key-store"

/**
 * Read the passphrase without it reaching argv, a shell history, or the
 * terminal. A pipe is read to EOF; an interactive terminal is put in raw mode
 * so nothing echoes as it is typed.
 */
export async function readPassphrase(readStdin: () => Promise<string>): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) return (await readStdin()).replace(/\r?\n$/, "")

  process.stderr.write("Passphrase: ")
  input.setRawMode(true)
  input.resume()
  input.setEncoding("utf8")
  try {
    let typed = ""
    for await (const chunk of input as AsyncIterable<string>) {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return typed
        // Ctrl-C reaches us instead of the process while raw mode is on.
        if (char === "\u0003") throw new UsageError("cancelled")
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1)
        else typed += char
      }
    }
    return typed
  } finally {
    input.setRawMode(false)
    input.pause()
    process.stderr.write("\n")
  }
}

const unlockVerb: VerbSpec = {
  name: "unlock",
  summary: "Open your encryption key with your passphrase and keep it on this machine",
  usage: "threa e2e unlock [--key-store keychain|file] [--key-dir <path>]",
  help:
    "threa e2e unlock [flags]\n\n" +
    "Fetch the encrypted bundle holding your identity key, open it with your passphrase, and file the key on " +
    "this machine so sealed streams can be read and written here. The passphrase is typed at the prompt (never " +
    "echoed) or piped on stdin; it is never sent anywhere, and neither is the key. Run it again after changing " +
    "your passphrase or rotating the key — it replaces what this machine holds.\n\n" +
    "Flags:\n" +
    STORE_FLAGS +
    "  --json                      force JSON output\n" +
    "  --help                      show this help",
  options: KEY_STORE_OPTIONS,
  run: async (ctx, _positionals, values) => {
    // The store choice is validated before the prompt: an unusable --key-store
    // should not first make someone type a passphrase that goes nowhere.
    const choice = storeChoice(values)
    return unlockE2eKey({
      client: ctx.client,
      workspaceId: ctx.config.workspaceId,
      passphrase: await readPassphrase(ctx.readStdin),
      choice,
    })
  },
  render: (payload) => {
    const p = payload as { keyId?: string; storeDescription?: string; unchanged?: boolean }
    return p.unchanged
      ? `${p.keyId ?? "?"} was already unlocked in ${p.storeDescription ?? "?"}`
      : `unlocked ${p.keyId ?? "?"} into ${p.storeDescription ?? "?"}`
  },
}

const statusVerb: VerbSpec = {
  name: "status",
  summary: "Show whether this machine holds your encryption key, and whether it is current",
  usage: "threa e2e status [--key-store keychain|file] [--key-dir <path>]",
  help:
    "threa e2e status [flags]\n\n" +
    "Report the key this machine holds and the key the workspace has active for you. They differ after the web " +
    "app rotates your key, which is when sealed streams stop opening here until you unlock again.\n\n" +
    "Flags:\n" +
    STORE_FLAGS +
    "  --json                      force JSON output\n" +
    "  --help                      show this help",
  options: KEY_STORE_OPTIONS,
  run: (ctx, _positionals, values) =>
    e2eKeyStatus({ client: ctx.client, workspaceId: ctx.config.workspaceId, choice: storeChoice(values) }),
  render: (payload) => {
    const p = payload as { held?: boolean; keyId?: string; serverKeyId?: string; current?: boolean }
    if (!p.held) {
      return p.serverKeyId
        ? `no key on this machine — run "threa e2e unlock" to open ${p.serverKeyId}`
        : "no key on this machine, and none set up in the workspace"
    }
    return p.current
      ? `holding ${p.keyId ?? "?"} (current)`
      : `holding ${p.keyId ?? "?"}, but the workspace has moved to ${p.serverKeyId ?? "no key"} — unlock again`
  },
}

const lockVerb: VerbSpec = {
  name: "lock",
  summary: "Forget the encryption key this machine holds",
  usage: "threa e2e lock [--key-store keychain|file] [--key-dir <path>]",
  help:
    "threa e2e lock [flags]\n\n" +
    "Remove your identity key from this machine. Sealed streams stop opening here until you unlock again. The " +
    "key itself is untouched everywhere else — this forgets a copy, it does not revoke anything.\n\n" +
    "Flags:\n" +
    STORE_FLAGS +
    "  --json                      force JSON output\n" +
    "  --help                      show this help",
  options: KEY_STORE_OPTIONS,
  run: (ctx, _positionals, values) =>
    lockE2eKey({ client: ctx.client, workspaceId: ctx.config.workspaceId, choice: storeChoice(values) }),
  render: (payload) => {
    const p = payload as { removed?: boolean; storeDescription?: string }
    return p.removed ? `forgot the key in ${p.storeDescription ?? "?"}` : "no key was held on this machine"
  },
}

export const e2eNoun: NounSpec = {
  name: "e2e",
  summary: "Unlock, inspect, and forget your end-to-end encryption key on this machine",
  verbs: [unlockVerb, statusVerb, lockVerb],
}
