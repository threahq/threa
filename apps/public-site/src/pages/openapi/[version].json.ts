import type { APIRoute, GetStaticPaths } from "astro"
import { listApiVersions, readApiVersionSpecText } from "../../lib/api-versions"

// Serve each dated version's spec at /openapi/<version>.json, from the generated
// docs/public-api/versions/<version>.json. /openapi.json stays the current
// version. In static output these prerender to plain files at build.
export const getStaticPaths: GetStaticPaths = () => listApiVersions().map((version) => ({ params: { version } }))

export const GET: APIRoute = ({ params }) => {
  const json = readApiVersionSpecText(params.version!)
  return new Response(json, {
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}
