# Claude Code Web

How to develop Threa in [Claude Code web](https://claude.ai/code) sandbox sessions.

## Sandbox Environment

Ubuntu 24.04 VM with Docker 29, Bun, Node 22, and git pre-installed. No systemd. The VM resets between every conversation turn — only the git working directory persists.

## Setup Script (`scripts/claude-code-web-setup.sh`)

Paste this script into **CC web Settings > Setup Script**. It runs as root on each new session and:

- Starts the Docker daemon with the egress proxy (`$https_proxy`) so it can pull images
- Downloads and installs the `gh` CLI binary from GitHub Releases (apt is unreachable)

## SessionStart Hook

The `.claude/settings.json` SessionStart hook runs after clone and:

- Copies `.env.remote-dev` to `.env` (if not already present)
- Runs `docker compose up -d --wait` to start PostgreSQL 17 with pgvector and MinIO
- Runs `bun install`
- Runs `scripts/ensure-xlsx.sh` to repair the xlsx dependency (see below)

This uses the same `docker-compose.yml` and ports as local dev (Postgres 5454, MinIO 9099).

## The xlsx dependency (`scripts/ensure-xlsx.sh`)

`apps/backend` pins `xlsx` to a CDN tarball (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`), not an npm-registry package. The SessionStart hook does `rm -rf node_modules && bun install` on every session start **and resume**, and `bun install` regularly reports success ("N packages installed") yet leaves xlsx **absent** from the `.bun` store — the CDN fetch through the egress proxy stalls or is dropped while registry deps resolve fine.

Symptom: any backend `bun test` or `tsc` dies immediately with `ENOENT reading .../node_modules/xlsx`, seemingly unrelated to your change. Two shapes occur — the root `node_modules/xlsx` symlink is wiped but the store copy survives (needs relinking), or the store copy itself is gone (needs re-fetching).

`scripts/ensure-xlsx.sh` fixes both. It is idempotent (exits fast when xlsx already resolves) and, when the store copy is missing, `curl`s the pinned tarball straight into the store (curl succeeds where bun's fetch stalled) and recreates the root **and** `apps/backend` symlinks with an absolute path (a relative root link fails from the store's depth). It's wired into the SessionStart hook, so a fresh session self-heals — but if you hit the ENOENT mid-session (a resume re-ran the hook and it timed out, etc.), just run:

```bash
bash scripts/ensure-xlsx.sh
```

If the xlsx pin in `apps/backend/package.json` ever bumps version, update `STORE_DIR` and `XLSX_URL` in the script to match.

## Environment

`.env.remote-dev` is copied to `.env` automatically. It matches `docker-compose.yml` port mappings (5454 for Postgres, 9099 for MinIO) with stub auth enabled, and it is shared with the Codex cloud bootstrap flow.

## Manual UI Configuration

- **Network allowlist:** Add `openrouter.ai` if AI features are needed.
- **Secrets:** Environment variables like `OPENROUTER_API_KEY` and `WORKOS_*` go in the CC web secrets panel, not in files.

## Limitations

- **No browser tests.** Playwright and browser-based E2E tests cannot run in the sandbox. Use GitHub Actions CI for those (`bun run test:e2e`).
- **No apt access.** `archive.ubuntu.com` DNS resolution fails from the sandbox. System packages must be pre-installed or downloaded as binaries through the egress proxy.
