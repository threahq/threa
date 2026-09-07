function isIdentifierNamed(node, name) {
  return node?.type === "Identifier" && node.name === name
}

function isQueryClientGetQueryDataCall(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    isIdentifierNamed(node.property, "getQueryData") &&
    isIdentifierNamed(node.object, "queryClient")
  )
}

function isFunctionNode(node) {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  )
}

function isPascalCaseName(name) {
  return typeof name === "string" && /^[A-Z][A-Za-z0-9]*$/.test(name)
}

function getFunctionName(node) {
  if (!node) return null

  if (node.type === "FunctionDeclaration" && node.id) {
    return node.id.name
  }

  if (
    (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") &&
    node.parent?.type === "VariableDeclarator" &&
    node.parent.id.type === "Identifier"
  ) {
    return node.parent.id.name
  }

  return null
}

function functionReturnsJsx(node) {
  if (!node) return false

  if (node.type === "ArrowFunctionExpression" && node.body) {
    if (node.body.type === "JSXElement" || node.body.type === "JSXFragment") {
      return true
    }
  }

  if (!node.body || node.body.type !== "BlockStatement") {
    return false
  }

  const queue = [...node.body.body]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue

    if (isFunctionNode(current)) {
      continue
    }

    if (current.type === "ReturnStatement") {
      const argument = current.argument
      if (argument?.type === "JSXElement" || argument?.type === "JSXFragment") {
        return true
      }
      continue
    }

    if (current.type === "BlockStatement") {
      queue.push(...current.body)
      continue
    }

    for (const [key, value] of Object.entries(current)) {
      if (key === "parent") {
        continue
      }

      if (!value) continue
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item?.type) queue.push(item)
        }
      } else if (value.type) {
        queue.push(value)
      }
    }
  }

  return false
}

function isComponentFunction(node) {
  const name = getFunctionName(node)
  return isPascalCaseName(name) && functionReturnsJsx(node)
}

function isAllowedGetQueryDataUsage(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index]
    if (!isFunctionNode(ancestor)) {
      continue
    }

    return (
      ancestor.parent?.type === "Property" &&
      !ancestor.parent.computed &&
      isIdentifierNamed(ancestor.parent.key, "queryFn")
    )
  }

  return false
}

function getNearestComponentFunction(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index]
    if (isFunctionNode(ancestor) && isComponentFunction(ancestor)) {
      return ancestor
    }
  }

  return null
}

const noNestedComponentDefinitionsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow React component definitions inside other components",
    },
    schema: [],
    messages: {
      nested: "Do not define components inside other components (INV-18). Move this component to module scope.",
    },
  },
  create(context) {
    function check(node) {
      if (!isComponentFunction(node)) {
        return
      }

      const ancestors = context.sourceCode.getAncestors(node)
      const parentComponentFunction = getNearestComponentFunction(ancestors)

      if (parentComponentFunction) {
        context.report({ node, messageId: "nested" })
      }
    }

    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    }
  },
}

const noQueryClientGetQueryDataInRenderRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow queryClient.getQueryData reads directly during component render",
    },
    schema: [],
    messages: {
      renderRead:
        "Do not call queryClient.getQueryData() directly in render for reactive reads. Use a cache-only useQuery observer instead.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isQueryClientGetQueryDataCall(node.callee)) {
          return
        }

        const ancestors = context.sourceCode.getAncestors(node)
        if (isAllowedGetQueryDataUsage(ancestors)) {
          return
        }

        const nearestComponentFunction = getNearestComponentFunction(ancestors)

        if (nearestComponentFunction) {
          context.report({ node, messageId: "renderRead" })
        }
      },
    }
  },
}

function isNavigationCall(node) {
  if (node?.type !== "CallExpression") {
    return false
  }

  const callee = node.callee

  if (isIdentifierNamed(callee, "navigate")) {
    return true
  }

  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    (isIdentifierNamed(callee.property, "push") || isIdentifierNamed(callee.property, "replace")) &&
    (isIdentifierNamed(callee.object, "history") ||
      isIdentifierNamed(callee.object, "router") ||
      isIdentifierNamed(callee.object, "navigate"))
  )
}

// Walk a handler's body for a navigation call, without descending into nested
// function definitions (a nested function's navigation belongs to its own event,
// not this button's click).
function handlerNavigatesInline(fnNode) {
  const start = fnNode?.body
  if (!start) {
    return false
  }

  const queue = [start]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current.type !== "string") {
      continue
    }

    if (isNavigationCall(current)) {
      return true
    }

    if (current !== start && isFunctionNode(current)) {
      continue
    }

    for (const [key, value] of Object.entries(current)) {
      if (key === "parent" || !value) {
        continue
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item.type === "string") queue.push(item)
        }
      } else if (typeof value.type === "string") {
        queue.push(value)
      }
    }
  }

  return false
}

const noButtonNavigationRule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow navigation inside a button's onClick handler; navigation uses links (INV-40)",
    },
    schema: [],
    messages: {
      navInButton:
        "Navigation belongs in a <Link to={…}>, not a button onClick (INV-40). Reserve buttons for actions; use a link to navigate.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const elementName = node.name?.type === "JSXIdentifier" ? node.name.name : null
        if (elementName !== "button" && elementName !== "Button") {
          return
        }

        for (const attr of node.attributes) {
          if (attr.type !== "JSXAttribute" || attr.name?.name !== "onClick") {
            continue
          }

          const value = attr.value
          if (value?.type !== "JSXExpressionContainer") {
            continue
          }

          const expr = value.expression
          if (isFunctionNode(expr) && handlerNavigatesInline(expr)) {
            context.report({ node: attr, messageId: "navInButton" })
          }
        }
      },
    }
  },
}

// INV-68: SQL correctness is verified against a real schema. Asserting on the
// query TEXT a repository emits proves the string was built, never that it runs
// — not that the columns exist, not that an ON CONFLICT clause matches a real
// index. `SELECT th.name` (column renamed in 2025) and `WHERE workspace_id` on
// `messages` (no such column) both shipped green past suites spelled that way.
//
// Uppercase-only keywords, deliberately: matching `from`/`join`/`where`
// case-insensitively flags ordinary English in prompt and error-message
// assertions ("Spawned From", "Can only join public channels", `Buffer.from`).
const SQL_IN_LITERAL =
  /(SELECT\s|INSERT INTO|UPDATE\s+[a-z_]|DELETE FROM|ON CONFLICT|JOIN\s+[a-z_]|WHERE\s+[a-z_]|GROUP BY|ORDER BY|PARTITION BY|UNNEST|unnest\(|ILIKE|RETURNING|FOR UPDATE|CASE WHEN|FROM\s+[a-z_])/
const SQL_KEYWORD =
  /\b(SELECT|INSERT INTO|UPDATE\s|DELETE FROM|ON CONFLICT|JOIN|WHERE|GROUP BY|ORDER BY|PARTITION BY|UNNEST|ILIKE|RETURNING|ROW_NUMBER|FOR UPDATE|CASE WHEN|COALESCE|FROM)\b/
/** Names that mean "this value is a SQL statement", not a domain string. */
const STATEMENT_NAME = /^(text|sql|query|queries|statement|captured)$/i
const STATEMENT_SUFFIX = /(Sql|Query|Statement)$/
/** Statement-ish only in context: `.text` is also prompt, trace-step and digest text. */
const AMBIGUOUS_NAME = /^(text|captured)$/i
/** Matchers that ask "is this fragment inside that statement". */
const SQL_MATCHERS = new Set(["toContain", "toMatch", "toStartWith", "toInclude"])
/** …plus the equality matchers, when handed a separately-built statement. */
const STATEMENT_ARG_MATCHERS = new Set([...SQL_MATCHERS, "toEqual", "toBe"])

function walk(node, visit) {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node.type !== "string") return
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === "parent") continue
    walk(node[key], visit)
  }
}

function literalHoldsSql(node, pattern) {
  if (node?.type === "Literal") {
    const raw = typeof node.value === "string" ? node.value : (node.regex?.pattern ?? "")
    return pattern.test(raw)
  }
  if (node?.type === "TemplateLiteral") {
    return node.quasis.some((quasi) => pattern.test(quasi.value.raw))
  }
  return false
}

function subtreeHoldsSql(node) {
  let found = false
  walk(node, (child) => {
    if (!found && literalHoldsSql(child, SQL_KEYWORD)) found = true
  })
  return found
}

function namesAStatement(node) {
  let found = false
  walk(node, (child) => {
    if (found || child.type !== "Identifier") return
    if (STATEMENT_NAME.test(child.name) || STATEMENT_SUFFIX.test(child.name)) found = true
  })
  return found
}

function isStatementNamedIdentifier(node) {
  return node?.type === "Identifier" && (STATEMENT_NAME.test(node.name) || STATEMENT_SUFFIX.test(node.name))
}

function unwrap(node) {
  let current = node
  while (
    current?.type === "ChainExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSAsExpression"
  ) {
    current = current.expression
  }
  return current
}

/**
 * The value IS the statement — `sql`, `availableQuery`, `query.text`,
 * `queries[0]!.text` — rather than something with a statement somewhere inside
 * it. Asking whether a fragment is `toContain`ed in one of these is a SQL-text
 * assertion whether or not the fragment spells a keyword: `toContain("workspace_id = $2")`
 * pins the query's text exactly as much as `toContain("SELECT …")` does.
 *
 * A BARE `text` does not qualify, and that is the whole subtlety: in this repo
 * `.text` is also prompt text, trace-step text and session-digest text, so
 * `expect(text).toContain("## Previous sessions")` must stay legal. The object
 * holding it has to name a statement — `query.text` yes, `digest!.text` no.
 */
function isStatementValue(node) {
  const inner = unwrap(node)
  if (!inner) return false
  if (inner.type === "Identifier") return isStatementNamedIdentifier(inner) && !AMBIGUOUS_NAME.test(inner.name)
  if (inner.type !== "MemberExpression" || inner.computed) return false
  if (!isStatementNamedIdentifier(inner.property)) return false
  // `query.text` is a statement; `digest!.text` is a session digest.
  return !AMBIGUOUS_NAME.test(inner.property.name) || namesAStatement(inner.object)
}

/** The `.not.toContain(…)` tail hanging off an `expect(…)` call. */
function matcherChain(expectCall) {
  const links = []
  let current = expectCall
  for (;;) {
    const member = current.parent
    if (member?.type !== "MemberExpression" || member.object !== current || member.computed) break
    const name = member.property?.name
    const call = member.parent
    if (call?.type === "CallExpression" && call.callee === member) {
      links.push({ name, args: call.arguments })
      current = call
    } else {
      links.push({ name, args: [] })
      current = member
    }
  }
  return links
}

const noSqlTextAssertionRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow verifying a repository by asserting on the SQL text it emits (INV-68)",
    },
    schema: [],
    messages: {
      sqlTextAssertion:
        "Asserting on a query's TEXT proves the string was built, not that it runs — not that the columns exist, not that ON CONFLICT matches a real index (INV-68). Verify the statement in a DB-backed integration test: seed rows, run it, assert on what comes back. A fake Querier that ROUTES on query text is fine; the ban is on assertions.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isIdentifierNamed(node.callee, "expect")) return
        const subject = node.arguments[0]
        if (!subject) return

        const links = matcherChain(node)
        if (links.length === 0) return

        // A literal statement in the matcher settles it on its own: nothing but
        // SQL gets compared against "FROM calls", whatever the subject is called.
        const matcherHoldsSql = links.some(
          (link) => SQL_MATCHERS.has(link.name) && link.args.some((arg) => literalHoldsSql(arg, SQL_IN_LITERAL))
        )
        if (matcherHoldsSql) {
          context.report({ node, messageId: "sqlTextAssertion" })
          return
        }

        if (!namesAStatement(subject)) return

        // Asking whether a fragment sits inside a value that IS a statement.
        const fragmentsTheStatement =
          isStatementValue(subject) && links.some((link) => SQL_MATCHERS.has(link.name) && link.args.length > 0)
        // The statement can be built elsewhere — `toContain(expectedSql)` carries
        // no literal, so the argument's name is all there is to go on.
        const matcherNamesStatement = links.some(
          (link) => STATEMENT_ARG_MATCHERS.has(link.name) && link.args.some(isStatementNamedIdentifier)
        )
        const holdsSql = subtreeHoldsSql(subject) || links.some((link) => link.args.some(subtreeHoldsSql))
        if (fragmentsTheStatement || holdsSql || matcherNamesStatement) {
          context.report({ node, messageId: "sqlTextAssertion" })
        }
      },
    }
  },
}

export const dotenvRestrictedImportPattern = {
  group: ["dotenv", "dotenv/config"],
  message: "Bun auto-loads .env. Do not import dotenv in this repo.",
}

export const providerSdkRestrictedImportPattern = {
  group: ["@openrouter/ai-sdk-provider", "@langchain/openai", "openai", "@anthropic-ai/sdk", "anthropic"],
  message: "Import AI provider SDKs only inside src/lib/ai/ai.ts (INV-28). Use createAI elsewhere.",
}

export const testRestrictedProperties = [
  {
    object: "describe",
    property: "skip",
    message: "Do not commit skipped tests (INV-26).",
  },
  {
    object: "describe",
    property: "todo",
    message: "Do not commit todo tests (INV-26).",
  },
  {
    object: "test",
    property: "skip",
    message: "Do not commit skipped tests (INV-26).",
  },
  {
    object: "test",
    property: "todo",
    message: "Do not commit todo tests (INV-26).",
  },
  {
    object: "it",
    property: "skip",
    message: "Do not commit skipped tests (INV-26).",
  },
  {
    object: "it",
    property: "todo",
    message: "Do not commit todo tests (INV-26).",
  },
  {
    object: "mock",
    property: "module",
    message: "Avoid mock.module(); prefer scoped spyOn patterns (INV-48).",
  },
]

// INV-48: vi.mock is the Vitest equivalent of Bun's mock.module — both hoist
// module-level replacements globally. Prefer namespace imports + vi.spyOn so
// mocks scope to a single test and other exports stay real.
export const viMockRestrictedSyntax = {
  selector: "CallExpression[callee.type='MemberExpression'][callee.object.name='vi'][callee.property.name='mock']",
  message: "Avoid vi.mock(); prefer scoped spyOn patterns (INV-48).",
}

/**
 * Per-file count of SQL-text assertions that predate INV-68, the single source
 * of truth for both consumers: `eslint.config.js` exempts these files so `lint`
 * stays green, and the guard test compares live counts against them so the debt
 * can only shrink. ESLint cannot notice a count going DOWN — that is the half
 * the test owns.
 *
 * Converting a file's assertions to a DB-backed integration test and lowering
 * its number is always welcome. Raising one, or adding a file, is the thing
 * INV-68 exists to stop.
 */
export const sqlTextAssertionAllowlist = {
  "apps/backend/src/features/agents/agent-config-override-repository.test.ts": 4,
  "apps/backend/src/features/agents/follow-up-repository.test.ts": 16,
  "apps/backend/src/features/agents/persona-attachment-repository.test.ts": 10,
  "apps/backend/src/features/agents/persona-config-draft-repository.test.ts": 9,
  "apps/backend/src/features/agents/persona-config-revision-repository.test.ts": 8,
  "apps/backend/src/features/agents/persona-repository.test.ts": 22,
  "apps/backend/src/features/agents/session-repository.test.ts": 24,
  "apps/backend/src/features/ai-usage/usage-repository.test.ts": 4,
  "apps/backend/src/features/bot-access-requests/repository.test.ts": 5,
  "apps/backend/src/features/bot-runtimes/repository.test.ts": 64,
  "apps/backend/src/features/bot-runtimes/service.test.ts": 2,
  "apps/backend/src/features/calls/repository.test.ts": 64,
  "apps/backend/src/features/delegations/repository.test.ts": 19,
  "apps/backend/src/features/drafts/repository.test.ts": 39,
  "apps/backend/src/features/e2e-streams/actor-repository.test.ts": 9,
  "apps/backend/src/features/e2e-streams/key-wrap-repository.test.ts": 11,
  "apps/backend/src/features/e2e-streams/repository.test.ts": 10,
  "apps/backend/src/features/enclave-runtimes/invocations-repository.test.ts": 38,
  "apps/backend/src/features/enclave-runtimes/repository.test.ts": 12,
  "apps/backend/src/features/enclave-runtimes/rewrap-notifications-repository.test.ts": 7,
  "apps/backend/src/features/memos/service.test.ts": 3,
  "apps/backend/src/features/messaging/repository.test.ts": 2,
  "apps/backend/src/features/saved-messages/repository.test.ts": 51,
  "apps/backend/src/features/scheduled-messages/repository.test.ts": 51,
  "apps/backend/src/features/search/repository.test.ts": 8,
  "apps/backend/src/features/streams/access.test.ts": 4,
  "apps/backend/src/features/streams/brief-repository.test.ts": 9,
  "apps/backend/src/features/streams/effective-read-state.test.ts": 1,
  "apps/backend/src/features/streams/policy-repository.test.ts": 10,
  "apps/backend/src/features/streams/read-state-repository.test.ts": 27,
  "apps/backend/src/features/streams/repository.test.ts": 2,
  "apps/backend/src/features/user-e2e-keys/repository.test.ts": 10,
  "apps/backend/src/features/workspace-integrations/installation-routes.test.ts": 3,
  "apps/backend/src/features/workspace-integrations/linear-write-guards.test.ts": 2,
  "apps/backend/src/features/workspace-settings/handlers.test.ts": 1,
  // Not debt: `composeSql` builds the statement, so its emitted text IS the unit
  // under test. Nothing here claims a schema is correct.
  "packages/backend-common/src/db/compose.test.ts": 8,
}

/** The allowlist's paths, rebased onto a package that lints from its own root. */
export function sqlTextAssertionExemptions(packageDir) {
  const prefix = `${packageDir}/`
  return Object.keys(sqlTextAssertionAllowlist)
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
}

const threaPlugin = {
  rules: {
    "no-nested-component-definitions": noNestedComponentDefinitionsRule,
    "no-queryclient-getquerydata-in-render": noQueryClientGetQueryDataInRenderRule,
    "no-button-navigation": noButtonNavigationRule,
    "no-sql-text-assertion": noSqlTextAssertionRule,
  },
}

export default threaPlugin
