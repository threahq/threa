import { build as viteBuild } from "../../apps/frontend/node_modules/vite/dist/node/index.js"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const REPO_ROOT = resolve(__dirname, "../..")
const FRONTEND_DIR = join(REPO_ROOT, "apps", "frontend")
const VITE_CONFIG_PATH = join(FRONTEND_DIR, "vite.config.ts")
const ACTUAL_SRC = join(FRONTEND_DIR, "src")
const ACTUAL_NODE_MODULES = join(FRONTEND_DIR, "node_modules")
const ACTUAL_PUBLIC = join(FRONTEND_DIR, "public")
const BUILD_INFO_PATH = join(__dirname, ".build-info.json")

const FIXTURE_TSX = readFileSync(join(__dirname, "fixture.tsx"), "utf-8")
const INDEX_HTML = readFileSync(join(__dirname, "index.html"), "utf-8")

export interface GenerationInfo {
  version: string
  buildId: string
  dist: string
  entryAsset: string
}

export interface BuildInfo {
  generations: Record<string, GenerationInfo>
  buildRoot: string
  createdAt: string
}

function prepareGenerationRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "threa-app-update-build-"))
  symlinkSync(realpathSync(ACTUAL_NODE_MODULES), join(root, "node_modules"))
  symlinkSync(realpathSync(ACTUAL_PUBLIC), join(root, "public"))

  const srcDir = join(root, "src")
  mkdirSync(srcDir)
  symlinkSync(join(ACTUAL_SRC, "sw.ts"), join(srcDir, "sw.ts"))
  symlinkSync(join(__dirname, "lazy-chunk.ts"), join(srcDir, "lazy-chunk.ts"))
  writeFileSync(join(srcDir, "fixture.tsx"), FIXTURE_TSX)
  writeFileSync(join(root, "index.html"), INDEX_HTML)
  return root
}

export async function buildGenerations(versions: string[]): Promise<BuildInfo> {
  const generations: Record<string, GenerationInfo> = {}
  const buildRoot = mkdtempSync(join(tmpdir(), "threa-app-update-generations-"))
  rmSync(BUILD_INFO_PATH, { force: true })
  const previousCwd = process.cwd()
  process.chdir(FRONTEND_DIR)

  try {
    for (const version of versions) {
      const root = prepareGenerationRoot()
      try {
        const buildId = `${version}-${Date.now()}`
        const outDir = join(buildRoot, `dist-${version}`)
        const result = await viteBuild({
          configFile: VITE_CONFIG_PATH,
          root,
          logLevel: "error",
          css: { postcss: FRONTEND_DIR },
          define: {
            __APP_VERSION__: JSON.stringify(version),
            __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
            __APP_BUILD_ID__: JSON.stringify(buildId),
            __E2E_BUILD__: "false",
          },
          build: { outDir, emptyOutDir: true, sourcemap: false },
        })

        if (!("output" in result)) throw new Error(`unexpected multi-output build for generation ${version}`)
        const entryChunk = result.output.find((item) => item.type === "chunk" && item.isEntry)
        if (!entryChunk) throw new Error(`no entry chunk for generation ${version}`)

        writeFileSync(join(outDir, "version.json"), JSON.stringify({ version, buildId }))
        generations[version] = {
          version,
          buildId,
          dist: outDir,
          entryAsset: `/${entryChunk.fileName}`,
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    const info: BuildInfo = { generations, buildRoot, createdAt: new Date().toISOString() }
    writeFileSync(BUILD_INFO_PATH, JSON.stringify(info, null, 2))
    return info
  } catch (error) {
    rmSync(buildRoot, { recursive: true, force: true })
    rmSync(BUILD_INFO_PATH, { force: true })
    rmSync(join(__dirname, ".server-port"), { force: true })
    throw error
  } finally {
    process.chdir(previousCwd)
  }
}

if (import.meta.main) {
  await buildGenerations(["A", "B", "C"])
  console.log("Build info written to", BUILD_INFO_PATH)
}
