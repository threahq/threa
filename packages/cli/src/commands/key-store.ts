import { E2E_KEY_STORE_KINDS, type E2eKeyStoreKind } from "../../../../extensions/bot-runtime-client/src/keyring"
import type { ThreaConfig } from "../config"
import type { KeyStoreChoice } from "../e2e-keys"
import { stringFlag, UsageError, type ParseOptions } from "../output"

/** Where the identity key is kept, shared by every command that needs it. */
export const KEY_STORE_OPTIONS: ParseOptions = {
  "key-store": { type: "string" },
  "key-dir": { type: "string" },
}

export const KEY_STORE_FLAGS =
  "  --key-store keychain|file   where the key is kept (default: the OS keychain)\n" +
  "  --key-dir <path>            directory for a file store (default: ~/.threa/e2e-keys)\n"

/** The flags win over the config file, which is how a runtime hands its own settings to the CLI it launches. */
export function storeChoice(values: Record<string, unknown>, config: ThreaConfig): KeyStoreChoice {
  const requested = stringFlag(values, "key-store")
  if (requested !== undefined && !(E2E_KEY_STORE_KINDS as readonly string[]).includes(requested)) {
    throw new UsageError(`--key-store must be one of ${E2E_KEY_STORE_KINDS.join(", ")} — got "${requested}"`)
  }
  const dir = stringFlag(values, "key-dir") ?? config.keyDir
  const store = (requested as E2eKeyStoreKind | undefined) ?? config.keyStore
  return {
    ...(store === undefined ? {} : { requested: store }),
    ...(dir === undefined ? {} : { dir }),
  }
}
