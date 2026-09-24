import { createHash } from "node:crypto"
import { join } from "node:path"
import { BROKER_PORT } from "./box/broker"

/** Root-owned in the box; holds the CLI and the API broker. */
export const BOX_DIR = "/opt/threa"
export const CLI_WRAPPER = `#!/bin/sh\nexec node ${BOX_DIR}/threa.js "$@"\n`
/** The command's `threa` talks to the broker; the key is a placeholder the broker replaces. */
export const BOX_API_BASE_URL = `http://127.0.0.1:${BROKER_PORT}`
export const BOX_API_KEY_PLACEHOLDER = "sandbox"

export interface BoxFiles {
  broker: Uint8Array
  cli: Uint8Array
  /** Changes with either bundle, so a box installed by an older backend is recognized. */
  version: string
}

const CLI_DIR = join(import.meta.dir, "../../../../../packages/cli")
const CLI_ENTRY = join(CLI_DIR, "src/cli.ts")
const BROKER_ENTRY = join(import.meta.dir, "box/broker-main.ts")

async function bundle(entry: string): Promise<Uint8Array> {
  const result = await Bun.build({ entrypoints: [entry], target: "node", minify: true })
  if (!result.success) throw new Error(`bundling ${entry} failed: ${result.logs.join("\n")}`)
  return new Uint8Array(await result.outputs[0]!.arrayBuffer())
}

/** Single-file node bundles of the CLI and the broker, installed in every box. */
export async function buildBoxFiles(): Promise<BoxFiles> {
  const [broker, cli] = await Promise.all([bundle(BROKER_ENTRY), bundle(CLI_ENTRY)])
  const version = createHash("sha256").update(broker).update(cli).digest("hex").slice(0, 16)
  return { broker, cli, version }
}
