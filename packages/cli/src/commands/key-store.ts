import { E2E_KEY_STORE_KINDS, type E2eKeyStoreKind } from "../../../../extensions/bot-runtime-client/src/keyring"
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

export function storeChoice(values: Record<string, unknown>): KeyStoreChoice {
  const requested = stringFlag(values, "key-store")
  if (requested !== undefined && !(E2E_KEY_STORE_KINDS as readonly string[]).includes(requested)) {
    throw new UsageError(`--key-store must be one of ${E2E_KEY_STORE_KINDS.join(", ")} — got "${requested}"`)
  }
  const dir = stringFlag(values, "key-dir")
  return {
    ...(requested === undefined ? {} : { requested: requested as E2eKeyStoreKind }),
    ...(dir === undefined ? {} : { dir }),
  }
}
