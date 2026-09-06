/**
 * Sync WorkOS authorization config from code definitions.
 *
 * Reads WORKSPACE_PERMISSIONS and WORKSPACE_ROLE_DEFINITIONS from @threahq/types
 * and ensures they exist in WorkOS. Creates missing permissions, updates
 * name/description on existing ones, and ensures roles match the catalog.
 *
 * Usage:
 *   bun scripts/sync-workos-permissions.ts              # sync (create/update)
 *   bun scripts/sync-workos-permissions.ts --dry-run    # preview without changes
 *   bun scripts/sync-workos-permissions.ts --check      # check for drift, exit 1 on orphans (manual cleanup required)
 *   WORKOS_API_KEY=sk_... bun scripts/sync-workos-permissions.ts
 */

import * as fs from "fs"
import * as path from "path"
import { WORKSPACE_PERMISSION_SCOPES, WORKSPACE_PERMISSIONS, WORKSPACE_ROLE_DEFINITIONS } from "../packages/types/src"

const WORKOS_BASE = "https://api.workos.com"

function loadApiKey(): string {
  if (process.env.WORKOS_API_KEY) return process.env.WORKOS_API_KEY

  const envPath = path.resolve(import.meta.dir, "../apps/backend/.env")
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("WORKOS_API_KEY=")) {
        let value = trimmed.slice("WORKOS_API_KEY=".length)
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        return value
      }
    }
  }

  console.error("WORKOS_API_KEY not found. Set it as env var or in apps/backend/.env")
  process.exit(1)
}

interface WorkOSPermission {
  id: string
  slug: string
  name: string
  description: string
  system: boolean
}

class WorkOSHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string
  ) {
    super(`WorkOS ${method} ${path} → ${status}: ${body}`)
  }
}

// WorkOS 409 bodies include a machine-readable `code` like
// `permission_slug_conflict` (observed; the role API uses the same convention).
// Narrowing the reconcile path to slug-conflict keeps unrelated 409s loud.
function isSlugConflict(err: WorkOSHttpError): boolean {
  if (err.status !== 409) return false
  try {
    const parsed = JSON.parse(err.body) as { code?: unknown }
    return typeof parsed.code === "string" && parsed.code.includes("slug_conflict")
  } catch {
    return false
  }
}

async function workosRequest<T>(apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${WORKOS_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new WorkOSHttpError(res.status, method, path, text)
  }

  return res.json() as Promise<T>
}

// WorkOS list endpoints default to ~10 results per page; without pagination,
// listings silently truncate and the drift detector marks already-remote
// permissions as "missing", which then 409s on create.
interface WorkOSListPage<T> {
  data: T[]
  list_metadata?: { before?: string | null; after?: string | null }
  listMetadata?: { before?: string | null; after?: string | null }
}

async function listAllPages<T>(apiKey: string, basePath: string): Promise<T[]> {
  const results: T[] = []
  let after: string | undefined
  for (;;) {
    const params = new URLSearchParams({ limit: "100" })
    if (after) params.set("after", after)
    const sep = basePath.includes("?") ? "&" : "?"
    const page = await workosRequest<WorkOSListPage<T>>(apiKey, "GET", `${basePath}${sep}${params.toString()}`)
    results.push(...page.data)
    after = page.list_metadata?.after ?? page.listMetadata?.after ?? undefined
    if (!after) return results
  }
}

async function listPermissions(apiKey: string): Promise<WorkOSPermission[]> {
  return listAllPages<WorkOSPermission>(apiKey, "/authorization/permissions")
}

async function createPermission(
  apiKey: string,
  perm: { slug: string; name: string; description: string }
): Promise<WorkOSPermission> {
  return workosRequest<WorkOSPermission>(apiKey, "POST", "/authorization/permissions", perm)
}

async function updatePermission(
  apiKey: string,
  slug: string,
  updates: { name: string; description: string }
): Promise<WorkOSPermission> {
  return workosRequest<WorkOSPermission>(apiKey, "PATCH", `/authorization/permissions/${slug}`, updates)
}

interface RoleDefinition {
  slug: string
  name: string
  description: string
  permissions: string[]
}

// `widgets:api-keys:manage` is a WorkOS system permission (not a Threa-defined
// catalog slug) that gates rendering of the API Keys widget in AuthKit.
const ADMIN_OR_HIGHER_SYSTEM_PERMISSIONS = ["widgets:api-keys:manage"]

// Roles that hold workspace:admin (or higher) automatically gain the AuthKit
// API-keys widget. Tying this to a catalog permission instead of a role-slug
// allowlist means any future role with admin scope inherits the widget.
const REQUIRED_ROLES: RoleDefinition[] = WORKSPACE_ROLE_DEFINITIONS.map((role) => ({
  slug: role.slug,
  name: role.name,
  description: role.description,
  permissions: role.permissions.includes(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
    ? [...role.permissions, ...ADMIN_OR_HIGHER_SYSTEM_PERMISSIONS]
    : [...role.permissions],
}))

interface WorkOSRole {
  id: string
  slug: string
  name: string
  description: string | null
  permissions: string[]
  type: string
}

async function listRoles(apiKey: string): Promise<WorkOSRole[]> {
  return listAllPages<WorkOSRole>(apiKey, "/authorization/roles")
}

async function createRole(
  apiKey: string,
  role: { slug: string; name: string; description: string }
): Promise<WorkOSRole> {
  return workosRequest<WorkOSRole>(apiKey, "POST", "/authorization/roles", role)
}

async function updateRole(
  apiKey: string,
  slug: string,
  updates: { name: string; description: string }
): Promise<WorkOSRole> {
  return workosRequest<WorkOSRole>(apiKey, "PATCH", `/authorization/roles/${slug}`, updates)
}

async function setRolePermissions(apiKey: string, roleSlug: string, permissions: string[]): Promise<void> {
  await workosRequest<unknown>(apiKey, "PUT", `/authorization/roles/${roleSlug}/permissions`, { permissions })
}

interface DriftReport {
  missing: typeof WORKSPACE_PERMISSIONS
  stale: { slug: string; fields: string[] }[]
  orphans: WorkOSPermission[]
}

function detectDrift(remote: WorkOSPermission[]): DriftReport {
  const remoteBySlug = new Map(remote.filter((p) => !p.system).map((p) => [p.slug, p]))
  const localSlugs = new Set<string>(WORKSPACE_PERMISSIONS.map((p) => p.slug))

  const missing = WORKSPACE_PERMISSIONS.filter((p) => !remoteBySlug.has(p.slug))

  const stale: DriftReport["stale"] = []
  for (const local of WORKSPACE_PERMISSIONS) {
    const existing = remoteBySlug.get(local.slug)
    if (!existing) continue
    const fields: string[] = []
    if (existing.name !== local.name) fields.push("name")
    if (existing.description !== local.description) fields.push("description")
    if (fields.length > 0) stale.push({ slug: local.slug, fields })
  }

  const orphans = remote.filter((p) => !p.system && !localSlugs.has(p.slug))

  return { missing, stale, orphans }
}

interface RoleDrift {
  slug: string
  exists: boolean
  fields: string[]
  missingPermissions: string[]
  extraPermissions: string[]
}

function detectRoleDrift(remoteRoles: WorkOSRole[]): RoleDrift[] {
  const remoteBySlug = new Map(remoteRoles.map((r) => [r.slug, r]))
  const drifts: RoleDrift[] = []

  for (const local of REQUIRED_ROLES) {
    const existing = remoteBySlug.get(local.slug)
    if (!existing) {
      drifts.push({
        slug: local.slug,
        exists: false,
        fields: [],
        missingPermissions: [...local.permissions],
        extraPermissions: [],
      })
      continue
    }

    const fields: string[] = []
    if (existing.name !== local.name) fields.push("name")
    if ((existing.description ?? "") !== local.description) fields.push("description")

    const localPerms = new Set(local.permissions)
    const existingPerms = new Set(existing.permissions)
    const missingPermissions = local.permissions.filter((p) => !existingPerms.has(p))
    const extraPermissions = existing.permissions.filter((p) => !localPerms.has(p))

    drifts.push({
      slug: local.slug,
      exists: true,
      fields,
      missingPermissions,
      extraPermissions,
    })
  }

  return drifts
}

function isRoleDriftClean(drift: RoleDrift): boolean {
  return (
    drift.exists &&
    drift.fields.length === 0 &&
    drift.missingPermissions.length === 0 &&
    drift.extraPermissions.length === 0
  )
}

function printDrift(drift: DriftReport): boolean {
  const hasDrift = drift.missing.length > 0 || drift.stale.length > 0 || drift.orphans.length > 0

  if (!hasDrift) {
    console.log("No drift detected. WorkOS permissions match code definitions.")
    return false
  }

  if (drift.missing.length > 0) {
    console.log(`Missing in WorkOS (${drift.missing.length}):`)
    for (const p of drift.missing) console.log(`  - ${p.slug} ("${p.name}")`)
    console.log()
  }

  if (drift.stale.length > 0) {
    console.log(`Out of date in WorkOS (${drift.stale.length}):`)
    for (const p of drift.stale) console.log(`  - ${p.slug} (${p.fields.join(", ")} differ)`)
    console.log()
  }

  if (drift.orphans.length > 0) {
    console.log(`Orphans in WorkOS not in code (${drift.orphans.length}):`)
    for (const p of drift.orphans) console.log(`  - ${p.slug} ("${p.name}") — delete via dashboard`)
    console.log()
  }

  return true
}

async function check() {
  const apiKey = loadApiKey()
  const remote = await listPermissions(apiKey)
  const drift = detectDrift(remote)

  // Missing and stale are informational — the sync on merge to main handles those.
  // Only orphans are a hard failure: they indicate permissions in WorkOS that have
  // been removed from code and need manual dashboard cleanup.
  if (drift.missing.length > 0) {
    console.log(`Pending (${drift.missing.length} — will be created on merge):`)
    for (const p of drift.missing) console.log(`  - ${p.slug} ("${p.name}")`)
    console.log()
  }

  if (drift.stale.length > 0) {
    console.log(`Stale (${drift.stale.length} — will be updated on merge):`)
    for (const p of drift.stale) console.log(`  - ${p.slug} (${p.fields.join(", ")} differ)`)
    console.log()
  }

  if (drift.orphans.length > 0) {
    console.log(`Orphans in WorkOS not in code (${drift.orphans.length}):`)
    for (const p of drift.orphans) console.log(`  - ${p.slug} ("${p.name}") — delete via dashboard`)
    console.log()
    console.error("Check failed: orphaned permissions found. Remove them from the WorkOS dashboard.")
    process.exit(1)
  }

  if (drift.missing.length === 0 && drift.stale.length === 0) {
    console.log("No drift detected. WorkOS permissions match code definitions.")
  }

  console.log("\n--- Roles ---\n")
  const remoteRoles = await listRoles(apiKey)
  const roleDrifts = detectRoleDrift(remoteRoles)
  let hasRoleDrift = false

  for (const roleDrift of roleDrifts) {
    if (!roleDrift.exists) {
      console.log(`  [MISSING] role "${roleDrift.slug}" — will be created on merge`)
      hasRoleDrift = true
      continue
    }

    if (isRoleDriftClean(roleDrift)) {
      console.log(`  [OK] role "${roleDrift.slug}"`)
      continue
    }

    const reasons: string[] = []
    if (roleDrift.fields.length > 0) reasons.push(`${roleDrift.fields.join(", ")} differ`)
    if (roleDrift.missingPermissions.length > 0) {
      reasons.push(`missing permissions: [${roleDrift.missingPermissions.join(", ")}]`)
    }
    if (roleDrift.extraPermissions.length > 0) {
      reasons.push(`extra permissions: [${roleDrift.extraPermissions.join(", ")}]`)
    }
    console.log(`  [STALE] role "${roleDrift.slug}" — ${reasons.join("; ")}`)
    hasRoleDrift = true
  }

  // Role drift (missing role, field drift, missing/extra permissions) is informational —
  // `sync` on merge to main resolves all of these via createRole/updateRole/setRolePermissions.
  // Only orphan permissions exit 1 because they require manual dashboard cleanup.
  if (!hasRoleDrift) {
    console.log("No role drift detected.")
  }
}

async function sync(dryRun: boolean) {
  const apiKey = loadApiKey()
  const remote = await listPermissions(apiKey)
  const drift = detectDrift(remote)

  console.log(`Found ${remote.length} permissions in WorkOS (${remote.filter((p) => !p.system).length} non-system)`)
  console.log(`Local definitions: ${WORKSPACE_PERMISSIONS.length}\n`)

  let created = 0
  let updated = 0
  let unchanged = 0

  for (const local of WORKSPACE_PERMISSIONS) {
    const isMissing = drift.missing.some((p) => p.slug === local.slug)
    const staleEntry = drift.stale.find((p) => p.slug === local.slug)

    if (isMissing) {
      if (dryRun) {
        console.log(`  [CREATE] ${local.slug} — "${local.name}"`)
        created++
      } else {
        try {
          await createPermission(apiKey, { slug: local.slug, name: local.name, description: local.description })
          console.log(`  [CREATED] ${local.slug} — "${local.name}"`)
          created++
        } catch (err) {
          // Concurrent run or stale list: slug already exists remotely. Reconcile
          // by updating instead of failing the sync.
          if (err instanceof WorkOSHttpError && isSlugConflict(err)) {
            await updatePermission(apiKey, local.slug, { name: local.name, description: local.description })
            console.log(`  [RECONCILED] ${local.slug} — already existed, updated name/description`)
            updated++
          } else {
            throw err
          }
        }
      }
    } else if (staleEntry) {
      if (dryRun) {
        console.log(`  [UPDATE] ${local.slug} (${staleEntry.fields.join(", ")})`)
      } else {
        await updatePermission(apiKey, local.slug, { name: local.name, description: local.description })
        console.log(`  [UPDATED] ${local.slug}`)
      }
      updated++
    } else {
      console.log(`  [OK] ${local.slug}`)
      unchanged++
    }
  }

  for (const orphan of drift.orphans) {
    console.log(`  [ORPHAN] ${orphan.slug} — exists in WorkOS but not in code (delete via dashboard)`)
  }

  console.log(`\n${dryRun ? "Dry run" : "Done"}: ${created} created, ${updated} updated, ${unchanged} unchanged`)
  if (drift.orphans.length > 0) {
    console.log(`${drift.orphans.length} orphan(s) need manual deletion in WorkOS dashboard`)
  }

  console.log("\n--- Roles ---\n")
  const remoteRoles = await listRoles(apiKey)
  const roleDriftsBySlug = new Map(detectRoleDrift(remoteRoles).map((d) => [d.slug, d]))

  for (const local of REQUIRED_ROLES) {
    // detectRoleDrift emits exactly one entry per REQUIRED_ROLES slug, so the lookup is total.
    const roleDrift = roleDriftsBySlug.get(local.slug)!

    if (!roleDrift.exists) {
      if (dryRun) {
        console.log(`  [CREATE] role "${local.slug}" — "${local.name}"`)
      } else {
        let reconciled = false
        try {
          await createRole(apiKey, { slug: local.slug, name: local.name, description: local.description })
        } catch (err) {
          // Concurrent run or stale list: role slug already exists. Fall through to
          // updateRole + setRolePermissions so we still reconcile.
          if (err instanceof WorkOSHttpError && isSlugConflict(err)) {
            await updateRole(apiKey, local.slug, { name: local.name, description: local.description })
            reconciled = true
          } else {
            throw err
          }
        }
        await setRolePermissions(apiKey, local.slug, local.permissions)
        const tag = reconciled ? "RECONCILED" : "CREATED"
        console.log(`  [${tag}] role "${local.slug}" with permissions: [${local.permissions.join(", ")}]`)
      }
      continue
    }

    if (isRoleDriftClean(roleDrift)) {
      console.log(`  [OK] role "${local.slug}"`)
      continue
    }

    const actions: string[] = []
    if (roleDrift.fields.length > 0) actions.push(`updating ${roleDrift.fields.join(", ")}`)
    if (roleDrift.missingPermissions.length > 0) {
      actions.push(`adding permissions: [${roleDrift.missingPermissions.join(", ")}]`)
    }
    if (roleDrift.extraPermissions.length > 0) {
      actions.push(`removing permissions: [${roleDrift.extraPermissions.join(", ")}]`)
    }

    if (dryRun) {
      console.log(`  [UPDATE] role "${local.slug}" — ${actions.join("; ")}`)
    } else {
      if (roleDrift.fields.length > 0) {
        await updateRole(apiKey, local.slug, { name: local.name, description: local.description })
      }
      if (roleDrift.missingPermissions.length > 0 || roleDrift.extraPermissions.length > 0) {
        await setRolePermissions(apiKey, local.slug, local.permissions)
      }
      console.log(`  [UPDATED] role "${local.slug}" — ${actions.join("; ")}`)
    }
  }
}

const mode = process.argv.includes("--check") ? "check" : process.argv.includes("--dry-run") ? "dry-run" : "sync"

const run = mode === "check" ? check() : sync(mode === "dry-run")

run.catch((err) => {
  console.error("Failed:", err.message)
  process.exit(1)
})
