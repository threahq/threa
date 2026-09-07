import { afterEach, describe, expect, it } from "vitest"
import { build, type Plugin } from "vite"
import { createHash } from "node:crypto"
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { postHogSourceMapPlugins } from "./posthog-source-maps"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("postHogSourceMapPlugins", () => {
  it("does nothing when upload credentials are absent", () => {
    expect(postHogSourceMapPlugins({})).toEqual([])
    expect(postHogSourceMapPlugins({ POSTHOG_CLI_TOKEN: "token" })).toEqual([])
  })

  it("annotates before hashing and exposes maps to both upload boundaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "posthog-source-maps-"))
    temporaryDirectories.push(root)
    await writeFile(path.join(root, "entry.js"), "export const answer = 42\n")

    const uploadObservations: Array<{ fileName: string; code: string; hasMap: boolean }> = []
    const postHogPlugins = postHogSourceMapPlugins({
      POSTHOG_CLI_TOKEN: "test-token",
      POSTHOG_ENV_ID_EU: "eu-project",
      POSTHOG_ENV_ID_US: "us-project",
    })

    for (const plugin of postHogPlugins) {
      plugin.writeBundle = async (_options, bundle) => {
        const chunk = Object.values(bundle).find((entry) => entry.type === "chunk")
        if (!chunk || chunk.type !== "chunk") throw new Error("expected an emitted chunk")
        uploadObservations.push({
          fileName: chunk.fileName,
          code: chunk.code,
          hasMap: await access(path.join(root, "dist", `${chunk.fileName}.map`)).then(
            () => true,
            () => false
          ),
        })
      }
    }

    const integrityPlugin: Plugin = {
      name: "test-integrity-manifest",
      generateBundle(_options, bundle) {
        const chunk = Object.values(bundle).find((entry) => entry.type === "chunk")
        if (!chunk || chunk.type !== "chunk") throw new Error("expected an emitted chunk")
        this.emitFile({
          type: "asset",
          fileName: "integrity.json",
          source: JSON.stringify({
            fileName: chunk.fileName,
            integrity: `sha384-${createHash("sha384").update(chunk.code).digest("base64")}`,
          }),
        })
      },
    }

    await build({
      root,
      logLevel: "silent",
      plugins: [...postHogPlugins, integrityPlugin],
      build: {
        outDir: "dist",
        rollupOptions: { input: path.join(root, "entry.js") },
      },
    })

    const manifest = JSON.parse(await readFile(path.join(root, "dist", "integrity.json"), "utf8")) as {
      fileName: string
      integrity: string
    }
    const finalCode = await readFile(path.join(root, "dist", manifest.fileName), "utf8")
    const finalIntegrity = `sha384-${createHash("sha384").update(finalCode).digest("base64")}`
    const maps = (await readdir(path.join(root, "dist", "assets"))).filter((file) => file.endsWith(".map"))
    const chunkIds = finalCode.match(/^\/\/# chunkId=(\S+)$/gm) ?? []

    expect({
      integrityMatchesFinalBytes: manifest.integrity === finalIntegrity,
      maps,
      chunkIds,
      uploadObservations,
      hasVisibleMapReference: finalCode.includes("sourceMappingURL="),
    }).toEqual({
      integrityMatchesFinalBytes: true,
      maps: [`${path.basename(manifest.fileName)}.map`],
      chunkIds: [expect.stringMatching(/^\/\/# chunkId=\S+$/)],
      uploadObservations: [
        { fileName: manifest.fileName, code: finalCode, hasMap: true },
        { fileName: manifest.fileName, code: finalCode, hasMap: true },
      ],
      hasVisibleMapReference: false,
    })
  })
})
