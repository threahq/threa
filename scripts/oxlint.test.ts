import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import config from "../oxlint.config"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("should enforce migrated app protections and preserve accepted exceptions", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "threa-oxlint-"))
  try {
    const cases: Record<string, { source: string; rule?: string | null; severity?: "warning" }> = {
      "frontend/src/components/Nested.tsx": {
        source: "function Outer() { function Inner() { return <span /> }; return <Inner /> }",
        rule: "threa/no-nested-component-definitions",
      },
      "frontend/src/components/Query.tsx": {
        source: "function View() { const x = queryClient.getQueryData(['x']); return <div>{x}</div> }",
        rule: "threa/no-queryclient-getquerydata-in-render",
      },
      "frontend/src/components/Nav.tsx": {
        source: "function View() { return <button onClick={() => navigate('/x')}>go</button> }",
        rule: "threa/no-button-navigation",
      },
      "frontend/src/components/Db.tsx": { source: "import db from '@/db'", rule: "no-restricted-imports" },
      "frontend/src/components/DbAllowed.tsx": {
        source: "// eslint-disable-next-line no-restricted-imports -- IDB adapter boundary\nimport db from '@/db'",
      },
      "frontend/src/components/UnusedDisable.tsx": {
        source: "// eslint-disable-next-line no-restricted-imports -- stale fixture\nconst value = 1",
        rule: null,
        severity: "warning",
      },
      "frontend/src/components/Allowed.tsx": {
        source:
          "import { Link } from 'react-router-dom'; function View() { const q = useQuery({ queryFn: () => queryClient.getQueryData(['x']) }); return <Link to='/x'>{q.data}</Link> }",
      },
      "frontend/src/components/Action.tsx": {
        source: "function View() { return <button onClick={() => setOpen(true)}>open</button> }",
      },
      "frontend/src/test/mock.test.tsx": { source: "vi.mock('x')", rule: "eslint-compat/no-restricted-syntax" },
      "frontend/src/test/mock-reference.test.tsx": { source: "const replacement = vi.mock" },
      "frontend/src/test/skip.test.tsx": { source: "describe.skip('x', () => {})", rule: "no-restricted-properties" },
      "frontend/src/components/Ternary.tsx": {
        source: "const types = v ? ((Array.isArray(v) ? v : [v]) as string[]) : undefined",
      },
      "frontend/src/components/NestedTernary.tsx": {
        source: "const value = a ? b ? c : d : e",
        rule: "eslint-compat/no-nested-ternary",
      },
      "backoffice/src/components/Nested.tsx": {
        source: "function Outer() { const Inner = () => <span />; return <Inner /> }",
        rule: "threa/no-nested-component-definitions",
      },
      "control-plane/src/lib/Bad.ts": {
        source: "import x from '../features/users/internal.js'",
        rule: "no-restricted-imports",
      },
      "control-plane/src/features/example/Good.ts": { source: "import x from '../../auth'" },
      "db-read-proxy/tests/skip.test.ts": { source: "test.skip('x', () => {})", rule: "no-restricted-properties" },
      "enclave/src/env.ts": { source: "import 'dotenv/config'", rule: "no-restricted-imports" },
    }

    for (const [relative, item] of Object.entries(cases)) {
      const target = path.join(fixtureRoot, "apps", relative)
      await mkdir(path.dirname(target), { recursive: true })
      await Bun.write(target, item.source)
    }

    const configPath = path.join(fixtureRoot, "oxlint.config.json")
    await writeFile(configPath, JSON.stringify(config))
    const files = Object.keys(cases).map((relative) => path.join(fixtureRoot, "apps", relative))
    const result = Bun.spawnSync(
      [
        Bun.argv[0],
        path.join(repoRoot, "node_modules/oxlint/bin/oxlint"),
        "--threads=1",
        "--format=json",
        "--config",
        configPath,
        ...files,
      ],
      { cwd: fixtureRoot, stdout: "pipe", stderr: "pipe" }
    )
    const output = JSON.parse(result.stdout.toString()) as {
      diagnostics: Array<{ filename: string; code?: string; severity: string }>
    }
    const actual: Record<string, Array<{ rule: string | null; severity: string }>> = {}
    for (const { filename, code, severity } of output.diagnostics) {
      const relative = path
        .relative(path.join(fixtureRoot, "apps"), path.resolve(fixtureRoot, filename))
        .replaceAll(path.sep, "/")
      const rule = code?.replace(/^([^()]+)\(([^)]+)\)$/, "$1/$2").replace(/^eslint\//, "") ?? null
      const messages = (actual[relative] ??= [])
      messages.push({ rule, severity })
    }
    const expected = Object.fromEntries(
      Object.entries(cases).flatMap(([file, item]) =>
        item.rule !== undefined ? [[file, [{ rule: item.rule, severity: item.severity ?? "error" }]]] : []
      )
    )
    expect({ exitCode: result.exitCode, diagnostics: actual }).toEqual({ exitCode: 1, diagnostics: expected })
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
