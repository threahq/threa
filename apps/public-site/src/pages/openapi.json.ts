import type { APIRoute } from "astro"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Serve the canonical OpenAPI spec at /openapi.json from the single source
// (docs/public-api/openapi.json) instead of committing a copy under public/.
// In static output this prerenders to a plain openapi.json file at build.
export const GET: APIRoute = () => {
  const specPath = fileURLToPath(new URL("../../../../docs/public-api/openapi.json", import.meta.url))
  const json = readFileSync(specPath, "utf8")
  return new Response(json, {
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}
