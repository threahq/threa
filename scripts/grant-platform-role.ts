#!/usr/bin/env bun
/**
 * Grant a platform role to a WorkOS user in the control-plane database.
 *
 * Usage:
 *   bun scripts/grant-platform-role.ts <workos_user_id> [role]
 *   DATABASE_URL=... bun scripts/grant-platform-role.ts user_01ABCDEF admin
 *
 * Defaults:
 *   - role = "admin"
 *   - DATABASE_URL is read from apps/control-plane/.env if not set in the environment
 *
 * This is the recommended way to bootstrap a new platform admin in any
 * environment (local dev with stub auth, staging, production). For a one-shot
 * bootstrap via environment variable, see PLATFORM_ADMIN_WORKOS_USER_IDS in
 * the control-plane config.
 */

import { readFileSync, existsSync } from "fs"
import { createDatabasePool, withTransaction, OutboxRepository } from "../packages/backend-common/src"
import { PlatformRoleRepository, isValidPlatformRole } from "../apps/control-plane/src/features/backoffice"
import { OUTBOX_PLATFORM_ADMIN_SYNC } from "../apps/control-plane/src/features/platform-admin"

function loadEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (!existsSync(filePath)) return env
  const content = readFileSync(filePath, "utf-8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq)
    let value = trimmed.slice(eq + 1)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL

  const cpEnv = loadEnvFile("apps/control-plane/.env")
  if (cpEnv.DATABASE_URL) return cpEnv.DATABASE_URL

  // Fall back to the dev convention used by scripts/dev.ts: <backend db>_cp
  const backendEnv = loadEnvFile("apps/backend/.env")
  const backendDb = backendEnv.DATABASE_URL ?? "postgresql://threa:threa@localhost:5454/threa"
  return backendDb.replace(/\/([^/?]+)(\?.*)?$/, "/$1_cp$2")
}

async function main() {
  const [userIdArg, roleArg] = process.argv.slice(2)
  if (!userIdArg) {
    console.error("usage: bun scripts/grant-platform-role.ts <workos_user_id> [role]")
    process.exit(1)
  }

  const role = roleArg ?? "admin"
  if (!isValidPlatformRole(role)) {
    console.error(`error: unknown platform role "${role}"`)
    process.exit(1)
  }

  const databaseUrl = resolveDatabaseUrl()
  const pool = createDatabasePool(databaseUrl, { max: 1 })
  try {
    // Grant and regional fan-out commit atomically (INV-7) so a running
    // control-plane pushes the new admin's mirror rows without a restart.
    const row = await withTransaction(pool, async (client) => {
      const granted = await PlatformRoleRepository.upsert(client, userIdArg, role)
      await OutboxRepository.insert(client, OUTBOX_PLATFORM_ADMIN_SYNC, { workosUserId: userIdArg })
      return granted
    })
    console.log(`granted platform role "${row.role}" to ${row.workos_user_id}`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
