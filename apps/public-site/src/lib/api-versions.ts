/*
 * Reads the per-version OpenAPI specs the backend generator emits under
 * docs/public-api/. The canonical docs/public-api/openapi.json is the current
 * version; docs/public-api/versions/<version>.json holds one spec per dated
 * version (identical to the canonical one apart from info.version until a
 * VersionChange carries a downgradeSpec). These helpers back the /openapi/<version>.json
 * endpoint and the reference version picker, both read at build time.
 */
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const canonicalUrl = new URL("../../../../docs/public-api/openapi.json", import.meta.url)
const versionsDirUrl = new URL("../../../../docs/public-api/versions/", import.meta.url)

/** All dated versions with an emitted spec, newest first. */
export function listApiVersions(): string[] {
  return readdirSync(fileURLToPath(versionsDirUrl))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort((a, b) => (a < b ? 1 : -1))
}

/** The current version, read from the canonical spec's info.version. */
export function currentApiVersion(): string {
  return JSON.parse(readFileSync(fileURLToPath(canonicalUrl), "utf8")).info.version
}

/** Raw JSON text of a version's spec, for serving verbatim. */
export function readApiVersionSpecText(version: string): string {
  return readFileSync(fileURLToPath(new URL(`${version}.json`, versionsDirUrl)), "utf8")
}

/** Parsed spec for a version, for rendering the reference. */
export function readApiVersionSpec(version: string): Record<string, unknown> {
  return JSON.parse(readApiVersionSpecText(version))
}
