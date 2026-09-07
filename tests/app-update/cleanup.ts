import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const infoPath = join(__dirname, ".build-info.json")

export default function cleanup(): void {
  try {
    const { buildRoot } = JSON.parse(readFileSync(infoPath, "utf-8")) as { buildRoot?: string }
    const expectedParent = resolve(tmpdir()) + sep
    if (
      buildRoot?.startsWith(expectedParent) &&
      buildRoot.split(sep).pop()?.startsWith("threa-app-update-generations-")
    ) {
      rmSync(buildRoot, { recursive: true, force: true })
    }
  } catch {
    // A failed build removes its own partial output.
  }
  rmSync(infoPath, { force: true })
  rmSync(join(__dirname, ".server-port"), { force: true })
}
