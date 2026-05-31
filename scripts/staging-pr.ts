/**
 * Staging PR lifecycle management — deploys per-PR backend + database environments.
 *
 * Usage:
 *   bun scripts/staging-pr.ts --action=deploy  --pr=123 --branch=my-feature
 *   bun scripts/staging-pr.ts --action=teardown --pr=123
 *
 * Environment variables (set in GH Actions secrets):
 *   STAGING_DATABASE_URL    — postgres connection string to the shared staging PG
 *   RAILWAY_TOKEN           — Railway API token
 *   RAILWAY_PROJECT_ID      — Railway project ID for the staging project
 *   CLOUDFLARE_API_TOKEN    — CF API token with KV write access
 *   CLOUDFLARE_ACCOUNT_ID   — CF account ID
 *   STAGING_KV_NAMESPACE_ID — CF KV namespace ID for the staging workspace-router
 *   STAGING_INTERNAL_API_KEY — shared secret for inter-service auth
 *   STAGING_CONTROL_PLANE_URL — URL of the shared staging control plane
 *   STAGING_CORS_ORIGINS    — comma-separated CORS origins (CF Pages preview URLs)
 */

import { parseArgs } from "util"
import { $ } from "bun"
import path from "path"
import { readdir } from "fs/promises"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    action: { type: "string" },
    pr: { type: "string" },
    branch: { type: "string" },
  },
})

const action = values.action
const prNumber = values.pr
const branch = values.branch

if (!action || !prNumber) {
  console.error("Usage: --action=deploy|teardown --pr=<number> [--branch=<name>]")
  process.exit(1)
}

if (!/^\d+$/.test(prNumber)) {
  console.error("--pr must be a positive integer")
  process.exit(1)
}

if ((action === "deploy" || action === "reset-db") && !branch) {
  console.error("--branch is required for deploy and reset-db actions")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return val
}

const STAGING_DATABASE_URL = requireEnv("STAGING_DATABASE_URL")
const RAILWAY_TOKEN = requireEnv("RAILWAY_TOKEN")
const RAILWAY_PROJECT_ID = requireEnv("RAILWAY_PROJECT_ID")
const CLOUDFLARE_API_TOKEN = requireEnv("CLOUDFLARE_API_TOKEN")
const CLOUDFLARE_ACCOUNT_ID = requireEnv("CLOUDFLARE_ACCOUNT_ID")
const STAGING_KV_NAMESPACE_ID = requireEnv("STAGING_KV_NAMESPACE_ID")
const STAGING_INTERNAL_API_KEY = requireEnv("STAGING_INTERNAL_API_KEY")
const STAGING_CONTROL_PLANE_URL = requireEnv("STAGING_CONTROL_PLANE_URL")
const CLOUDFLARE_ZONE_ID = requireEnv("CLOUDFLARE_ZONE_ID")
const STAGING_WORKER_NAME = process.env.STAGING_WORKER_NAME ?? "workspace-router-staging"
const STAGING_CORS_ORIGINS = process.env.STAGING_CORS_ORIGINS ?? ""

const prDbName = `pr_${prNumber}`
const prCpDbName = `pr_${prNumber}_cp`
const regionName = `pr-${prNumber}`
const serviceName = `pr-${prNumber}-backend`
/** Flat subdomain: pr-228-staging.threa.io (covered by *.threa.io cert) */
const prHostname = `pr-${prNumber}-staging.threa.io`

// ---------------------------------------------------------------------------
// Database helpers (uses psql via STAGING_DATABASE_URL)
// ---------------------------------------------------------------------------

// STAGING_DATABASE_URL is the public proxy URL (required so GH Actions runners
// can reach Postgres for psql/pg_dump). Railway services in the same project
// must talk to Postgres over the internal network to avoid egress charges.
function toInternalDbUrl(publicUrl: string, dbName: string): string {
  const u = new URL(publicUrl)
  return `postgresql://${u.username}:${u.password}@postgres.railway.internal:5432/${dbName}`
}

async function runPsql(db: string, sql: string): Promise<string> {
  // Replace the database name in the URL
  const url = STAGING_DATABASE_URL.replace(/\/([^/?]+)(\?.*)?$/, `/${db}$2`)
  const result = await $`psql ${url} -tAc ${sql}`.quiet().nothrow()
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString()
    throw new Error(`psql failed: ${stderr}`)
  }
  return result.stdout.toString().trim()
}

async function runPsqlOnDefault(sql: string): Promise<string> {
  const result = await $`psql ${STAGING_DATABASE_URL} -tAc ${sql}`.quiet().nothrow()
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString()
    throw new Error(`psql failed: ${stderr}`)
  }
  return result.stdout.toString().trim()
}

async function databaseExists(dbName: string): Promise<boolean> {
  const result = await runPsqlOnDefault(`SELECT 1 FROM pg_database WHERE datname='${dbName}'`)
  return result === "1"
}

/**
 * Seed umzug_migrations in the cloned PR database for migrations that were
 * applied to the source DB before Umzug tracking was introduced.
 *
 * Strategy: copy the EXACT set of names from `sourceDb.umzug_migrations` into
 * `prDb.umzug_migrations`. Anything in the source's applied list represents
 * DDL that already exists in the cloned data — the backend's runMigrations()
 * must skip those. Anything NOT in the source's applied list is either:
 *   (a) a new PR-branch migration whose table the clone doesn't have, or
 *   (b) a migration the source somehow lost,
 * and in both cases the backend must run it on boot.
 *
 * We previously used a "high-water mark" range — seed every PR-branch file
 * lexicographically ≤ source's latest entry. That broke when a PR's new
 * migration timestamp landed BETWEEN two already-merged main migrations:
 * the new file slipped under the mark and got marked as applied even though
 * its table never existed on the clone. Symptom: `relation "<x>" does not
 * exist` on first write after deploy.
 */
async function seedPreExistingMigrations(prDb: string, sourceDb: string, migrationsRelPath: string): Promise<void> {
  // Ensure umzug_migrations exists in the PR DB (may be missing if source
  // was set up before Umzug, or if pg_dump didn't include it)
  await runPsql(
    prDb,
    "CREATE TABLE IF NOT EXISTS umzug_migrations (name VARCHAR(255) PRIMARY KEY, executed_at TIMESTAMPTZ DEFAULT NOW())"
  )

  // Pull the explicit set of applied migration names from the source DB.
  let appliedNames: string[] = []
  try {
    const raw = await runPsql(sourceDb, "SELECT name FROM umzug_migrations ORDER BY name")
    appliedNames = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    // Source DB may not have umzug_migrations at all (predates Umzug). Fall
    // back to seeding every file from disk so already-applied DDL doesn't
    // re-run and crash on "relation already exists". PRs that add brand-new
    // migrations against a fully-untracked source must fix the source's
    // umzug_migrations first — the script can't tell new from old without it.
    console.log(`Could not read umzug_migrations from '${sourceDb}' — seeding all files from disk`)
    const migrationsDir = path.join(import.meta.dirname, "..", migrationsRelPath)
    appliedNames = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()
  }

  if (appliedNames.length === 0) {
    console.log(`No applied migrations on source '${sourceDb}' — nothing to seed in '${prDb}'`)
    return
  }

  let seeded = 0
  for (const name of appliedNames) {
    const result = await runPsql(
      prDb,
      `INSERT INTO umzug_migrations (name) VALUES ('${name}') ON CONFLICT DO NOTHING RETURNING name`
    )
    if (result) seeded++
  }

  if (seeded > 0) {
    console.log(`Seeded ${seeded} pre-existing migration entries into '${prDb}' umzug_migrations`)
  } else {
    console.log(`All pre-existing migrations already tracked in '${prDb}'`)
  }
}

async function cloneDatabase(sourceDb: string, targetDb: string): Promise<void> {
  console.log(`Cloning '${sourceDb}' → '${targetDb}'...`)
  const sourceUrl = STAGING_DATABASE_URL.replace(/\/([^/?]+)(\?.*)?$/, `/${sourceDb}$2`)
  const targetUrl = STAGING_DATABASE_URL.replace(/\/([^/?]+)(\?.*)?$/, `/${targetDb}$2`)

  // Use versioned pg_dump path if available (GH Actions installs PG 18 client alongside default PG 16)
  const pgDump =
    (await $`which /usr/lib/postgresql/18/bin/pg_dump`.quiet().nothrow()).exitCode === 0
      ? "/usr/lib/postgresql/18/bin/pg_dump"
      : "pg_dump"
  // Pipe pg_dump output into psql. Bun shell handles the pipe operator natively
  // and escapes interpolated values, avoiding bash -c string interpolation issues
  // with passwords containing shell-special characters ($, !, quotes, etc.)
  const result = await $`${pgDump} --clean --if-exists ${sourceUrl} | psql ${targetUrl}`.quiet().nothrow()

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString()
    throw new Error(`Database clone failed: ${stderr}`)
  }

  // Sync sequences (same pattern as setup-worktree.ts)
  console.log("Syncing sequences...")
  await runPsql(targetDb, "SELECT setval('outbox_id_seq', COALESCE((SELECT MAX(id) FROM outbox), 0) + 1, false)")

  // Reset outbox listener cursors
  console.log("Resetting outbox listener cursors...")
  await runPsql(targetDb, "UPDATE outbox_listeners SET last_processed_id = COALESCE((SELECT MAX(id) FROM outbox), 0)")

  console.log(`Cloned '${sourceDb}' → '${targetDb}'`)
}

async function dropDatabase(dbName: string): Promise<void> {
  if (!(await databaseExists(dbName))) {
    console.log(`Database '${dbName}' does not exist, skipping drop`)
    return
  }
  console.log(`Dropping database '${dbName}'...`)
  await runPsqlOnDefault(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid <> pg_backend_pid()`
  )
  await runPsqlOnDefault(`DROP DATABASE "${dbName}"`)
  console.log(`Dropped '${dbName}'`)
}

async function updateWorkspaceSlug(dbName: string, branchName: string): Promise<void> {
  const slug = branchName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)

  const name = `PR #${prNumber}`

  console.log(`Updating workspace slug to '${slug}' and name to '${name}'...`)
  await runPsql(
    dbName,
    `UPDATE workspaces SET slug = '${slug}', name = '${name}' WHERE id = (SELECT id FROM workspaces LIMIT 1)`
  )
}

// ---------------------------------------------------------------------------
// Railway helpers (uses Railway CLI via RAILWAY_TOKEN)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Railway GraphQL API helpers (replaces CLI calls for CI reliability)
// ---------------------------------------------------------------------------

const RAILWAY_API = "https://backboard.railway.com/graphql/v2"

// Railway's API gateway intermittently answers with a non-JSON body (an HTML
// 5xx page, an empty 502/504, or a rate-limit notice) instead of a GraphQL
// envelope. The old code called `res.json()` blind, so those turned into an
// opaque "SyntaxError: Failed to parse JSON" with no status or body — which
// took down PR staging deploys with no way to tell a transient blip from a real
// rejection. Read the body as text, surface the HTTP status + a snippet on
// failure, and retry transient failures (network error, 5xx, non-JSON). Every
// caller here is idempotent (serviceCreate is existence-guarded; instance
// update and variable upsert are upserts), so retrying is safe.
const RAILWAY_GQL_MAX_ATTEMPTS = 3

async function railwayGql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= RAILWAY_GQL_MAX_ATTEMPTS; attempt++) {
    let res: Response
    let text: string
    try {
      res = await fetch(RAILWAY_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RAILWAY_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      })
      text = await res.text()
    } catch (err) {
      // Network-level failure (DNS, connection reset, timeout) — transient.
      lastError = new Error(`Railway API network error: ${err instanceof Error ? err.message : String(err)}`)
      if (attempt < RAILWAY_GQL_MAX_ATTEMPTS) {
        await Bun.sleep(1000 * attempt)
        continue
      }
      throw lastError
    }

    // Non-2xx: retry 5xx (gateway/transient), fail fast on 4xx (real rejection).
    if (!res.ok) {
      const snippet = text.slice(0, 500)
      lastError = new Error(`Railway API HTTP ${res.status}: ${snippet}`)
      if (res.status >= 500 && attempt < RAILWAY_GQL_MAX_ATTEMPTS) {
        await Bun.sleep(1000 * attempt)
        continue
      }
      throw lastError
    }

    let json: { data?: unknown; errors?: { message: string }[] }
    try {
      json = JSON.parse(text) as { data?: unknown; errors?: { message: string }[] }
    } catch {
      // 2xx but not JSON — almost always a gateway page slipped through. Retry.
      lastError = new Error(`Railway API returned non-JSON (HTTP ${res.status}): ${text.slice(0, 500)}`)
      if (attempt < RAILWAY_GQL_MAX_ATTEMPTS) {
        await Bun.sleep(1000 * attempt)
        continue
      }
      throw lastError
    }

    // A GraphQL `errors` array is a deterministic rejection — don't retry it.
    if (json.errors?.length) {
      throw new Error(`Railway API error: ${json.errors[0].message}`)
    }
    return json.data
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw lastError ?? new Error("Railway API request failed")
}

async function getEnvironmentId(): Promise<string> {
  const data = (await railwayGql(`{
    project(id: "${RAILWAY_PROJECT_ID}") {
      environments { edges { node { id name } } }
    }
  }`)) as { project: { environments: { edges: { node: { id: string; name: string } }[] } } }
  const prod = data.project.environments.edges.find((e) => e.node.name === "production")
  if (!prod) throw new Error("No production environment found")
  return prod.node.id
}

async function listServices(): Promise<{ id: string; name: string }[]> {
  const data = (await railwayGql(`{
    project(id: "${RAILWAY_PROJECT_ID}") {
      services { edges { node { id name } } }
    }
  }`)) as { project: { services: { edges: { node: { id: string; name: string } }[] } } }
  return data.project.services.edges.map((e) => e.node)
}

async function railwayServiceExists(): Promise<boolean> {
  const services = await listServices()
  return services.some((s) => s.name === serviceName)
}

async function createRailwayService(): Promise<string> {
  console.log(`Creating Railway service '${serviceName}'...`)

  let serviceId: string
  const services = await listServices()
  const existing = services.find((s) => s.name === serviceName)

  if (existing) {
    console.log(`Railway service '${serviceName}' already exists, reusing...`)
    serviceId = existing.id
  } else {
    const data = (await railwayGql(`mutation {
      serviceCreate(input: { name: "${serviceName}", projectId: "${RAILWAY_PROJECT_ID}" }) { id }
    }`)) as { serviceCreate: { id: string } }
    serviceId = data.serviceCreate.id
  }

  // Configure service instance to use Dockerfile (same as main backend)
  const environmentId = await getEnvironmentId()
  await railwayGql(`mutation {
    serviceInstanceUpdate(
      serviceId: "${serviceId}",
      environmentId: "${environmentId}",
      input: {
        dockerfilePath: "Dockerfile.backend",
        healthcheckPath: "/health",
        restartPolicyType: ON_FAILURE,
        restartPolicyMaxRetries: 5,
        watchPatterns: ["apps/backend/**", "packages/**", "Dockerfile.backend", "bun.lock"]
      }
    )
  }`)

  // Copy env vars from the main staging backend, then override PR-specific ones.
  // This ensures new vars (API keys, feature flags) propagate automatically.
  const mainBackend = (await listServices()).find((s) => s.name === "backend")
  let baseEnvVars: Record<string, string> = {}
  if (mainBackend) {
    baseEnvVars = (await railwayGql(`{
      variables(projectId: "${RAILWAY_PROJECT_ID}", environmentId: "${environmentId}", serviceId: "${mainBackend.id}")
    }`)) as Record<string, string>
    // The query returns { variables: { ... } }, extract it
    baseEnvVars = (baseEnvVars as unknown as { variables: Record<string, string> }).variables ?? {}
  }

  const prDbUrl = toInternalDbUrl(STAGING_DATABASE_URL, prDbName)
  const envVars: Record<string, string> = {
    ...baseEnvVars,
    // PR-specific overrides
    DATABASE_URL: prDbUrl,
    REGION: regionName,
    CORS_ALLOWED_ORIGINS: STAGING_CORS_ORIGINS,
    FAST_SHUTDOWN: "true",
  }

  await railwayGql(
    `mutation($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }`,
    {
      input: {
        projectId: RAILWAY_PROJECT_ID,
        environmentId,
        serviceId,
        variables: envVars,
      },
    }
  )

  console.log(`Railway service '${serviceName}' ready (ID: ${serviceId})`)
  return serviceId
}

async function deployRailwayService(): Promise<string> {
  console.log(`Deploying to Railway service '${serviceName}'...`)

  const services = await listServices()
  const service = services.find((s) => s.name === serviceName)
  if (!service) throw new Error("Service not found")

  const environmentId = await getEnvironmentId()

  // Connect service to the repo + branch (idempotent — updates if already connected)
  await railwayGql(
    `mutation($id: String!, $input: ServiceConnectInput!) {
      serviceConnect(id: $id, input: $input) { id }
    }`,
    { id: service.id, input: { repo: "threahq/threa", branch } }
  )

  // Trigger deploy from latest commit on the branch
  await railwayGql(`mutation {
    serviceInstanceDeploy(serviceId: "${service.id}", environmentId: "${environmentId}")
  }`)

  console.log("Deploy triggered — Railway will build from the branch")

  // Get or create service domain
  const domainData = (await railwayGql(`{
    serviceInstance(serviceId: "${service.id}", environmentId: "${environmentId}") {
      domains { serviceDomains { domain } }
    }
  }`)) as { serviceInstance: { domains: { serviceDomains: { domain: string }[] } } }

  const existingDomain = domainData.serviceInstance.domains.serviceDomains[0]?.domain
  if (existingDomain) return `https://${existingDomain}`

  // Create a service domain if none exists
  const newDomain = (await railwayGql(`mutation {
    serviceDomainCreate(input: { serviceId: "${service.id}", environmentId: "${environmentId}" }) { domain }
  }`)) as { serviceDomainCreate: { domain: string } }
  return `https://${newDomain.serviceDomainCreate.domain}`
}

async function deleteRailwayService(): Promise<void> {
  const services = await listServices()
  const service = services.find((s) => s.name === serviceName)
  if (!service) {
    console.log(`Railway service '${serviceName}' does not exist, skipping`)
    return
  }
  console.log(`Deleting Railway service '${serviceName}'...`)
  await railwayGql(`mutation { serviceDelete(id: "${service.id}") }`)
  console.log(`Deleted Railway service '${serviceName}'`)
}

// ---------------------------------------------------------------------------
// Cloudflare KV helpers
// ---------------------------------------------------------------------------

const CF_KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${STAGING_KV_NAMESPACE_ID}`

async function kvGet(key: string): Promise<string | null> {
  const res = await fetch(`${CF_KV_BASE}/values/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
  })
  if (!res.ok) return null
  return res.text()
}

async function kvPut(key: string, value: string): Promise<void> {
  const res = await fetch(`${CF_KV_BASE}/values/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
    body: value,
  })
  if (!res.ok) {
    throw new Error(`KV put failed for key '${key}': ${await res.text()}`)
  }
}

/**
 * Register this PR's region in the shared KV regions config.
 *
 * WARNING: read-modify-write race condition. If two PR deploys run concurrently,
 * one write can clobber the other's region entry. This is acceptable for now
 * because staging PR deploys are infrequent and the lost region is re-registered
 * on the next push. A proper fix would use KV metadata + compare-and-swap or a
 * mutex (e.g. Cloudflare Durable Object lock).
 */
async function registerRegion(backendUrl: string): Promise<void> {
  // Read current regions config from KV
  const existing = await kvGet("__regions_config__")
  const regions: Record<string, { apiUrl: string; wsUrl: string }> = existing ? JSON.parse(existing) : {}

  // Add this PR's region
  regions[regionName] = { apiUrl: backendUrl, wsUrl: backendUrl }
  await kvPut("__regions_config__", JSON.stringify(regions))
  console.log(`Registered region '${regionName}' → ${backendUrl}`)
}

/**
 * Ensure the "staging" region in `__regions_config__` points at the stable
 * main staging backend (Railway service named "backend"). Idempotent — runs on
 * every PR deploy so the entry self-heals if the URL changes or KV is wiped.
 *
 * Without this, staging.threa.io has no region to route to, since the worker's
 * hostname-pinned routing for staging.threa.io looks up region "staging" in the
 * regions map.
 */
async function registerStagingRegion(): Promise<void> {
  const services = await listServices()
  const mainBackend = services.find((s) => s.name === "backend")
  if (!mainBackend) {
    throw new Error("Main staging 'backend' service not found; cannot register 'staging' region")
  }

  const environmentId = await getEnvironmentId()
  const domainData = (await railwayGql(`{
    serviceInstance(serviceId: "${mainBackend.id}", environmentId: "${environmentId}") {
      domains { serviceDomains { domain } }
    }
  }`)) as { serviceInstance: { domains: { serviceDomains: { domain: string }[] } } }

  const domain = domainData.serviceInstance.domains.serviceDomains[0]?.domain
  if (!domain) {
    throw new Error(
      `Main staging 'backend' (service ${mainBackend.id}, env ${environmentId}) has no service domain; cannot register 'staging' region`
    )
  }
  const backendUrl = `https://${domain}`

  const existing = await kvGet("__regions_config__")
  const regions: Record<string, { apiUrl: string; wsUrl: string }> = existing ? JSON.parse(existing) : {}
  const current = regions["staging"]
  if (current?.apiUrl === backendUrl && current?.wsUrl === backendUrl) {
    console.log(`Staging region already registered → ${backendUrl}`)
    return
  }

  regions["staging"] = { apiUrl: backendUrl, wsUrl: backendUrl }
  await kvPut("__regions_config__", JSON.stringify(regions))
  console.log(`Registered 'staging' region → ${backendUrl}`)
}

async function unregisterRegion(): Promise<void> {
  const existing = await kvGet("__regions_config__")
  if (!existing) return

  const regions: Record<string, unknown> = JSON.parse(existing)
  delete regions[regionName]
  await kvPut("__regions_config__", JSON.stringify(regions))
  console.log(`Unregistered region '${regionName}'`)
}

// ---------------------------------------------------------------------------
// Cloudflare DNS + Worker Route helpers (per-PR subdomain)
// ---------------------------------------------------------------------------

const CF_ZONE_BASE = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}`

async function cfApi(
  path: string,
  method: string,
  body?: unknown
): Promise<{ success: boolean; result?: Record<string, unknown>; errors?: { message: string }[] }> {
  const res = await fetch(`${CF_ZONE_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return res.json() as Promise<{ success: boolean; result?: Record<string, unknown>; errors?: { message: string }[] }>
}

async function findDnsRecord(name: string): Promise<string | null> {
  const res = await fetch(`${CF_ZONE_BASE}/dns_records?name=${name}`, {
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
  })
  const data = (await res.json()) as { result: { id: string }[] }
  return data.result?.[0]?.id ?? null
}

async function findWorkerRoute(pattern: string): Promise<string | null> {
  const res = await fetch(`${CF_ZONE_BASE}/workers/routes`, {
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
  })
  const data = (await res.json()) as { result: { id: string; pattern: string }[] }
  return data.result?.find((r) => r.pattern === pattern)?.id ?? null
}

async function createPrDnsAndRoute(): Promise<void> {
  // Create proxied AAAA record for pr-N-staging.threa.io
  const existingDns = await findDnsRecord(prHostname)
  if (!existingDns) {
    const dns = await cfApi("/dns_records", "POST", {
      type: "AAAA",
      name: `pr-${prNumber}-staging`,
      content: "100::",
      proxied: true,
      comment: `Staging PR #${prNumber}`,
    })
    if (!dns.success) {
      throw new Error(`Failed to create DNS record: ${dns.errors?.[0]?.message}`)
    }
    console.log(`Created DNS record for ${prHostname}`)
  } else {
    console.log(`DNS record for ${prHostname} already exists`)
  }

  // Create worker route
  const routePattern = `${prHostname}/*`
  const existingRoute = await findWorkerRoute(routePattern)
  if (!existingRoute) {
    const route = await cfApi("/workers/routes", "POST", {
      pattern: routePattern,
      script: STAGING_WORKER_NAME,
    })
    if (!route.success) {
      throw new Error(`Failed to create worker route: ${route.errors?.[0]?.message}`)
    }
    console.log(`Created worker route ${routePattern} → ${STAGING_WORKER_NAME}`)
  } else {
    console.log(`Worker route for ${prHostname} already exists`)
  }
}

async function deletePrDnsAndRoute(): Promise<void> {
  // Delete worker route
  const routePattern = `${prHostname}/*`
  const routeId = await findWorkerRoute(routePattern)
  if (routeId) {
    await cfApi(`/workers/routes/${routeId}`, "DELETE")
    console.log(`Deleted worker route for ${prHostname}`)
  }

  // Delete DNS record
  const dnsId = await findDnsRecord(prHostname)
  if (dnsId) {
    await cfApi(`/dns_records/${dnsId}`, "DELETE")
    console.log(`Deleted DNS record for ${prHostname}`)
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Restart the existing PR Railway service without reconnecting to a branch.
 * Used after a DB reset so the backend picks up fresh connections and re-runs
 * migrations against the newly cloned database.
 */
async function redeployRailwayService(): Promise<void> {
  const services = await listServices()
  const service = services.find((s) => s.name === serviceName)
  if (!service) {
    console.log(`Railway service '${serviceName}' not found — skipping restart`)
    return
  }
  const environmentId = await getEnvironmentId()
  // Re-connect to the branch before deploying — mirrors deployRailwayService so
  // serviceInstanceDeploy has a valid deployment source to build from.
  await railwayGql(
    `mutation($id: String!, $input: ServiceConnectInput!) {
      serviceConnect(id: $id, input: $input) { id }
    }`,
    { id: service.id, input: { repo: "threahq/threa", branch } }
  )
  console.log(`Restarting Railway service '${serviceName}'...`)
  await railwayGql(`mutation {
    serviceInstanceDeploy(serviceId: "${service.id}", environmentId: "${environmentId}")
  }`)
  console.log(`Restart triggered — service will reconnect to the fresh database and run pending migrations`)
}

async function deploy(): Promise<void> {
  console.log(`\n=== Deploying staging environment for PR #${prNumber} (branch: ${branch}) ===\n`)

  // 1. Create and clone databases on first deploy only.
  //    We check pure existence — NOT data integrity. Dropping a live DB to
  //    "re-clone" kills the running backend's connections and causes cascading
  //    failures. If a clone was partial, the backend's runMigrations() will
  //    either fix it or fail loudly on its own.
  const dbExists = await databaseExists(prDbName)
  const cpDbExists = await databaseExists(prCpDbName)
  const needsClone = !dbExists || !cpDbExists

  if (needsClone) {
    if (!dbExists) {
      console.log(`Creating and cloning backend database '${prDbName}'...`)
      await runPsqlOnDefault(`CREATE DATABASE "${prDbName}"`)
      await cloneDatabase("staging_main", prDbName)
      await updateWorkspaceSlug(prDbName, branch!)
    } else {
      console.log(`Backend database '${prDbName}' already exists — skipping clone`)
    }

    if (!cpDbExists) {
      console.log(`Creating and cloning control-plane database '${prCpDbName}'...`)
      await runPsqlOnDefault(`CREATE DATABASE "${prCpDbName}"`)
      await cloneDatabase("staging_main_cp", prCpDbName)
    } else {
      console.log(`Control-plane database '${prCpDbName}' already exists — skipping clone`)
    }
  } else {
    console.log(`Databases already exist — skipping clone`)
  }

  // Always ensure umzug_migrations tracks pre-existing migrations. This is
  // idempotent (ON CONFLICT DO NOTHING) and uses staging_main's latest
  // tracked entry as a high-water mark — migrations after that point are
  // new PR-branch additions that the backend's runMigrations() will execute.
  await seedPreExistingMigrations(prDbName, "staging_main", "apps/backend/src/db/migrations")
  await seedPreExistingMigrations(prCpDbName, "staging_main_cp", "apps/control-plane/src/db/migrations")

  // 2. Create and deploy Railway service
  await createRailwayService()
  const backendUrl = await deployRailwayService()

  // 3. Register in Cloudflare KV
  //    - This PR's ephemeral region (pr-N → PR backend URL)
  //    - The stable "staging" region (idempotent, self-healing)
  //
  //    We do NOT write a workspace_id → region mapping. The worker resolves
  //    region from hostname (pr-N-staging.threa.io → pr-N, staging.threa.io →
  //    staging) for all staging traffic, so the per-workspace KV mapping is
  //    unnecessary in staging — and actively harmful, since cloned PR DBs
  //    share workspace IDs with staging_main and would clobber each other.
  await registerRegion(backendUrl)
  await registerStagingRegion()

  // 4. Create DNS record + worker route for pr-N-staging.threa.io
  await createPrDnsAndRoute()

  console.log(`\n=== Staging environment deployed ===`)
  console.log(`Frontend: https://${prHostname}`)
  console.log(`Backend: ${backendUrl}`)
  console.log(`Region: ${regionName}`)
  console.log(`Database: ${prDbName}`)
}

async function resetDb(): Promise<void> {
  console.log(`\n=== Resetting databases for PR #${prNumber} (branch: ${branch}) ===\n`)

  // Drop and re-clone backend database
  await dropDatabase(prDbName)
  await runPsqlOnDefault(`CREATE DATABASE "${prDbName}"`)
  await cloneDatabase("staging_main", prDbName)
  await updateWorkspaceSlug(prDbName, branch!)

  // Drop and re-clone control-plane database
  await dropDatabase(prCpDbName)
  await runPsqlOnDefault(`CREATE DATABASE "${prCpDbName}"`)
  await cloneDatabase("staging_main_cp", prCpDbName)

  // Re-seed migration tracking so the backend skips already-applied DDL
  await seedPreExistingMigrations(prDbName, "staging_main", "apps/backend/src/db/migrations")
  await seedPreExistingMigrations(prCpDbName, "staging_main_cp", "apps/control-plane/src/db/migrations")

  // Restart the Railway service so it starts with fresh DB connections and runs
  // any new PR-branch migrations against the restored schema
  await redeployRailwayService()

  console.log(`\n=== Database reset complete ===`)
  console.log(`Backend DB:       ${prDbName} (cloned from staging_main)`)
  console.log(`Control-plane DB: ${prCpDbName} (cloned from staging_main_cp)`)
}

async function teardown(): Promise<void> {
  console.log(`\n=== Tearing down staging environment for PR #${prNumber} ===\n`)

  // 1. Unregister this PR's region from KV
  await unregisterRegion()

  // 2. Delete DNS record + worker route
  await deletePrDnsAndRoute()

  // 3. Delete Railway service
  await deleteRailwayService()

  // 4. Drop databases
  await dropDatabase(prDbName)
  await dropDatabase(prCpDbName)

  console.log(`\n=== Staging environment torn down ===`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  switch (action) {
    case "deploy":
      await deploy()
      break
    case "teardown":
      await teardown()
      break
    case "reset-db":
      await resetDb()
      break
    default:
      console.error(`Unknown action: ${action}`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error("Staging PR script failed:", err)
  process.exit(1)
})
