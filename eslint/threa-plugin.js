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

/** Tables with no workspace_id column, each with the reason it is workspace-agnostic. */
export const workspaceIdExemptTables = {
  workspaces: "the root: its id is the workspace id",
  umzug_migrations: "migration runner metadata",
  outbox: "global delivery log; the workspace rides in the event payload",
  outbox_dead_letters: "outbox delivery failures, keyed by listener and outbox event id",
  outbox_listeners: "per-listener outbox cursors, keyed by listener id",
  backfill_chunks: "keyed by run_id; backfill_runs carries the workspace_id",
  socket_io_attachments: "Socket.IO postgres adapter payload spill table",
  sync_log_sweep_state: "singleton cursor of the outbox reconciliation sweep",
  enclave_runtimes: "global infra: enclave instances serve every workspace (INV-8 auth/infra exception)",
}

const SQL_STATEMENT_VERB = /\b(?:SELECT|INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO)\b|\bUPDATE\s[^;]*?\bSET\b/
// A `${…}` the rule cannot see into. A table in its place is reported, never assumed scoped.
const SQL_HIDDEN = "\u0000"
// A `${…}` holding a whole statement from this file, which the rule checks where it is written.
const SQL_CHECKED_ELSEWHERE = "\u0001"
const SQL_MAX_CONST_HOPS = 3
const SQL_TABLE_KEYWORDS = new Set(["FROM", "JOIN", "UPDATE", "INTO", "USING"])
// Keywords that can directly follow a table reference, so a bare word there is its alias unless it is one of these.
const SQL_KEYWORDS_AFTER_TABLE = new Set([
  "WHERE",
  "ON",
  "USING",
  "SET",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "FULL",
  "CROSS",
  "NATURAL",
  "ORDER",
  "GROUP",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "FOR",
  "FROM",
  "RETURNING",
  "WINDOW",
  "FETCH",
  "TABLESAMPLE",
  "VALUES",
  "SELECT",
  "DEFAULT",
  "OVERRIDING",
  "WITH",
])
// A `(` before one of these opens a nested statement: a subquery, or a data-modifying CTE body.
const SQL_SUBQUERY_STARTS = new Set(["SELECT", "WITH", "VALUES", "INSERT", "UPDATE", "DELETE"])
const SQL_SCOPE_BREAKS = new Set(["UNION", "INTERSECT", "EXCEPT", ";"])
// `EXTRACT(EPOCH FROM created_at)`: FROM introduces a column there, not a table.
const SQL_FROM_TAKES_A_COLUMN_IN = new Set(["EXTRACT", "TRIM", "SUBSTRING", "OVERLAY"])
const SQL_CONDITION_STARTS = new Set(["WHERE", "ON", "HAVING"])
const SQL_CONDITION_ENDS = new Set([
  ...SQL_SCOPE_BREAKS,
  ...SQL_CONDITION_STARTS,
  "GROUP",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "FETCH",
  "FOR",
  "WINDOW",
  "RETURNING",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "FULL",
  "CROSS",
  "NATURAL",
  "DO",
  "SET",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  ",",
])
// Keywords after which a `,` no longer separates FROM-list items.
const SQL_FROM_LIST_ENDS = new Set([
  ...SQL_SCOPE_BREAKS,
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "WINDOW",
  "FETCH",
  "FOR",
  "RETURNING",
  "SET",
  "WHEN",
  "DO",
  "SELECT",
  "VALUES",
])
// The owner of a `workspace_id` this statement does not define; it is checked where it is defined.
const SQL_OUTSIDE_OWNER = "outside"
const SQL_CTE_DEFINITION =
  /(?:\bWITH(?:\s+RECURSIVE)?|,)\s+(\w+)\s*(?:\([^)]*\))?\s+AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/gi

function unwrapTsExpression(node) {
  let current = node
  while (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(current?.type)) {
    current = current.expression
  }
  return current
}

function isSqlRawCall(node) {
  return (
    node.type === "CallExpression" &&
    node.arguments.length === 1 &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "sql" &&
    node.callee.property.name === "raw"
  )
}

function resolveConstInit(sourceCode, identifier) {
  for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name)
    if (!variable) continue
    const [definition] = variable.defs
    const isConst = variable.defs.length === 1 && definition.type === "Variable" && definition.parent.kind === "const"
    return isConst ? definition.node.init : null
  }
  return null
}

/** What `${expression}` contributes to the statement: a same-file constant's text, or a marker. */
function fragmentText(sourceCode, expression, hops) {
  const node = unwrapTsExpression(expression)
  if (!node) return SQL_HIDDEN
  if (isSqlRawCall(node)) return fragmentText(sourceCode, node.arguments[0], hops)
  if (node.type === "Identifier") {
    return hops < SQL_MAX_CONST_HOPS
      ? fragmentText(sourceCode, resolveConstInit(sourceCode, node), hops + 1)
      : SQL_HIDDEN
  }
  const isSqlTag = node.type === "TaggedTemplateExpression" && node.tag.type === "Identifier" && node.tag.name === "sql"
  const template = isSqlTag ? node.quasi : node
  if (template.type === "TemplateLiteral") {
    const text = templateText(sourceCode, template, hops)
    return SQL_STATEMENT_VERB.test(text) ? SQL_CHECKED_ELSEWHERE : text
  }
  if (node.type === "Literal" && typeof node.value === "string" && !SQL_STATEMENT_VERB.test(node.value))
    return node.value
  return SQL_HIDDEN
}

function templateText(sourceCode, template, hops) {
  return template.quasis
    .map((quasi, index) => {
      const fragment = index === 0 ? "" : fragmentText(sourceCode, template.expressions[index - 1], hops)
      return fragment + (quasi.value.cooked ?? quasi.value.raw)
    })
    .join("")
}

/** The statement's text with comments and string literals blanked and quoted identifiers unquoted. */
function cleanSqlText(text) {
  return text
    .replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (match) => (match.startsWith("'") ? "''" : " "))
    .replace(/"/g, " ")
}

function tokenizeSql(text) {
  return text.match(/[A-Za-z_][A-Za-z0-9_]*|\S/g) ?? []
}

function isFreeSqlWord(token) {
  return token !== undefined && /^[A-Za-z_]/.test(token) && !SQL_KEYWORDS_AFTER_TABLE.has(token.toUpperCase())
}

function matchingParen(tokens, openIndex) {
  let depth = 0
  for (let index = openIndex; index < tokens.length; index++) {
    if (tokens[index] === "(") depth++
    else if (tokens[index] === ")" && --depth === 0) return index
  }
  return tokens.length - 1
}

/** Per token, the index where its subquery or set-operation branch starts (-1 for the top level), and each branch's enclosing branch. */
function sqlScopes(tokens) {
  // `opensScope` is false for a plain `(`, whose entry repeats the enclosing scope.
  const stack = [{ scope: -1, opensScope: true }]
  const parents = new Map()
  const scopes = tokens.map((token, index) => {
    if (token === ")" && stack.length > 1) stack.pop()
    const top = stack.at(-1)
    const { scope } = top
    if (token === "(") {
      const opensSubquery = SQL_SUBQUERY_STARTS.has(tokens[index + 1]?.toUpperCase())
      if (opensSubquery) parents.set(index, scope)
      stack.push({ scope: opensSubquery ? index : scope, opensScope: opensSubquery })
    } else if (SQL_SCOPE_BREAKS.has(token.toUpperCase())) {
      parents.set(index, top.opensScope ? parents.get(scope) : scope)
      stack[stack.length - 1] = { scope: index, opensScope: true }
    }
    return scope
  })
  return { scopes, parents }
}

/** Matching `(`/`)`, `[`/`]` and `CASE`/`END` token indexes, mapped both ways. */
function sqlPairs(tokens) {
  const pairs = new Map()
  const closers = { ")": "(", "]": "[", END: "CASE" }
  const open = { "(": [], "[": [], CASE: [] }
  tokens.forEach((token, index) => {
    const word = token.toUpperCase()
    if (word in open) open[word].push(index)
    const opener = word in closers ? open[closers[word]].pop() : undefined
    if (opener !== undefined) pairs.set(opener, index).set(index, opener)
  })
  return pairs
}

function readQualifiedName(tokens, start) {
  let index = start
  let name = tokens[index++]
  let schema = null
  while (tokens[index] === "." && isFreeSqlWord(tokens[index + 1])) {
    schema ??= name
    name = tokens[index + 1]
    index += 2
  }
  return { name, schema, next: index }
}

function readAlias(tokens, start) {
  let index = start
  if (tokens[index]?.toUpperCase() === "AS") index++
  const alias = isFreeSqlWord(tokens[index]) ? tokens[index++] : null
  return { alias, next: index }
}

function skipColumnAliases(tokens, index) {
  return tokens[index] === "(" ? matchingParen(tokens, index) + 1 : index
}

/** One FROM-list item: a table, a function call or a parenthesised subquery. `table` is null for the last two. */
function readFromItem(tokens, start) {
  let index = start
  while (["LATERAL", "ONLY"].includes(tokens[index]?.toUpperCase())) index++

  if (tokens[index] === "(") {
    const { alias, next } = readAlias(tokens, matchingParen(tokens, index) + 1)
    const afterParen = alias ? skipColumnAliases(tokens, next) : next
    // `FROM (a JOIN b ON …)`: the first table sits behind the paren; the scan finds the joins on its own.
    if (SQL_SUBQUERY_STARTS.has(tokens[index + 1]?.toUpperCase())) return { table: null, next: afterParen }
    return { ...readFromItem(tokens, index + 1), next: afterParen }
  }
  if (tokens[index] === SQL_HIDDEN) {
    return { hidden: true, next: skipColumnAliases(tokens, readAlias(tokens, index + 1).next) }
  }
  if (!isFreeSqlWord(tokens[index])) return { table: null, next: index + 1 }

  const { name, schema, next } = readQualifiedName(tokens, index)
  // `unnest($1) AS t(id)`: a function, with an optional column-alias list.
  const isFunction = tokens[next] === "("
  const { alias, next: afterAlias } = readAlias(tokens, isFunction ? matchingParen(tokens, next) + 1 : next)
  return {
    table: isFunction || /^(?:pg_|information_schema)/i.test(schema ?? name) ? null : name,
    alias,
    at: index,
    next: skipColumnAliases(tokens, afterAlias),
  }
}

/** `INSERT INTO t [AS a] (cols)`: the `(` after the table is a column list, not a function call. */
function readInsertTarget(tokens, start) {
  if (tokens[start] === SQL_HIDDEN) return { hidden: true }
  if (!isFreeSqlWord(tokens[start])) return { table: null }
  const { name, next } = readQualifiedName(tokens, start)
  const { alias, next: afterAlias } = readAlias(tokens, next)
  const namesWorkspaceId =
    tokens[afterAlias] === "(" &&
    tokens
      .slice(afterAlias + 1, matchingParen(tokens, afterAlias))
      .some((token) => token.toLowerCase() === "workspace_id")
  return { table: name, alias, at: start, isInsert: true, namesWorkspaceId }
}

/** The index of the `workspace_id` token when tokens[start, end) is exactly `[q.]workspace_id`, else -1. */
function workspaceIdRef(tokens, start, end) {
  const index = end - 1
  if (tokens[index]?.toLowerCase() !== "workspace_id") return -1
  if (end - start === 1) return index
  return end - start === 3 && tokens[start + 1] === "." ? index : -1
}

/** The sides of the comparison tokens[from, to) when it is `=`, `IS NOT DISTINCT FROM`, `IN` or `IS NULL`; `right` is null for the last two. */
function sqlComparison(tokens, pairs, from, to) {
  for (let index = from; index < to; index++) {
    if (pairs.get(index) > index) {
      index = pairs.get(index)
      continue
    }
    const word = tokens[index].toUpperCase()
    if (word === "=" && !["<", ">", "!"].includes(tokens[index - 1])) {
      return { left: [from, index], right: [index + 1, to] }
    }
    if (word === "IN" && tokens[index - 1]?.toUpperCase() !== "NOT") return { left: [from, index], right: null }
    if (word === "IS") {
      const rest = tokens.slice(index + 1, to).map((token) => token.toUpperCase())
      if (rest.join(" ") === "NULL") return { left: [from, index], right: null }
      if (rest.slice(0, 3).join(" ") === "NOT DISTINCT FROM") return { left: [from, index], right: [index + 4, to] }
      return null
    }
  }
  return null
}

/** The ranges of tokens[from, to) between its top-level occurrences of `word`. */
function splitSqlCondition(tokens, pairs, from, to, word) {
  const parts = []
  let start = from
  for (let index = from; index < to; index++) {
    if (pairs.get(index) > index) index = pairs.get(index)
    else if (tokens[index].toUpperCase() === word) {
      parts.push([start, index])
      start = index + 1
    }
  }
  parts.push([start, to])
  return parts
}

/** Where the WHERE, ON or HAVING condition starting at `start` ends. */
function sqlConditionEnd(tokens, pairs, start) {
  for (let index = start; index < tokens.length; index++) {
    const word = tokens[index].toUpperCase()
    const isFunctionCall = (word === "LEFT" || word === "RIGHT") && tokens[index + 1] === "("
    if (pairs.get(index) > index) index = pairs.get(index)
    else if (word === ")" || (SQL_CONDITION_ENDS.has(word) && !isFunctionCall)) return index
  }
  return tokens.length
}

/**
 * The tables a statement pins to one workspace. A
 * WHERE, ON or HAVING condition pins a table when one of its top-level AND terms
 * compares the table's workspace_id to a value (`= $1`, `= ANY(…)`, `IN (…)`, `IS NOT
 * DISTINCT FROM`, `IS NULL`), or equates it to the workspace_id of a pinned table, and
 * the condition filters that table's rows: a WHERE filters its own branch, a LEFT JOIN's
 * ON only the joined side, a RIGHT or FULL JOIN's ON nothing. An OR pins only what each of
 * its branches pins. A term under NOT or CASE, inside a function call, subquery or FILTER,
 * or in a select list, RETURNING or SET pins nothing.
 */
function pinnedTables(tokens, tables) {
  const { scopes, parents } = sqlScopes(tokens)
  const pairs = sqlPairs(tokens)
  const keyOf = ({ table, alias, at }) => `${scopes[at]}:${(alias ?? table).toLowerCase()}`
  const keyed = tables
    .filter((table) => !table.isInsert)
    .map((table) => ({ ...table, scope: scopes[table.at], key: keyOf(table) }))
  const keys = new Set(keyed.map((table) => table.key))

  // A qualifier no table here owns is an outer query's row, a CTE, a subquery or function
  // alias, or `excluded`; each is checked where it is defined, so its workspace_id is a value.
  const ownerOf = (index) => {
    if (tokens[index - 1] !== ".") {
      const candidates = keyed.filter(
        (table) =>
          table.scope === scopes[index] &&
          !table.alias &&
          !Object.hasOwn(workspaceIdExemptTables, table.table.toLowerCase())
      )
      return candidates.length === 1 ? candidates[0].key : null
    }
    const qualifier = tokens[index - 2].toLowerCase()
    for (let scope = scopes[index]; scope !== undefined; scope = parents.get(scope)) {
      if (keys.has(`${scope}:${qualifier}`)) return `${scope}:${qualifier}`
    }
    return SQL_OUTSIDE_OWNER
  }
  // `w.id`, `w.id::text` and `COALESCE($1, workspace_id)` read this statement's rows, so they are not values.
  const isValue = ([start, end]) => {
    for (let index = start; index < end; index++) {
      if (tokens[index] === "(" && SQL_SUBQUERY_STARTS.has(tokens[index + 1]?.toUpperCase())) index = pairs.get(index)
      else if (tokens[index].toLowerCase() === "workspace_id") return false
      else if (tokens[index - 1] === "." && ownerOf(index) !== SQL_OUTSIDE_OWNER) return false
    }
    return true
  }

  const termPins = (from, to) => {
    const isGroup = tokens[from] === "(" && pairs.get(from) === to - 1
    if (isGroup && !SQL_SUBQUERY_STARTS.has(tokens[from + 1]?.toUpperCase())) return conditionPins(from + 1, to - 1)
    const comparison = sqlComparison(tokens, pairs, from, to)
    if (!comparison) return { values: new Set(), edges: [] }
    const { left, right } = comparison
    const leftRef = workspaceIdRef(tokens, ...left)
    const rightRef = right ? workspaceIdRef(tokens, ...right) : -1
    if (leftRef !== -1 && rightRef !== -1) return { values: new Set(), edges: [[ownerOf(leftRef), ownerOf(rightRef)]] }
    const ref = leftRef === -1 ? rightRef : leftRef
    const other = leftRef === -1 ? left : right
    if (ref === -1 || (other && !isValue(other))) return { values: new Set(), edges: [] }
    return { values: new Set([ownerOf(ref)]), edges: [] }
  }

  const conditionPins = (from, to) => {
    const branches = splitSqlCondition(tokens, pairs, from, to, "OR").map(([start, end]) => {
      const terms = splitSqlCondition(tokens, pairs, start, end, "AND").map(([a, b]) => termPins(a, b))
      return { values: new Set(terms.flatMap((term) => [...term.values])), edges: terms.flatMap((term) => term.edges) }
    })
    if (branches.length === 1) return branches[0]
    const [first, ...rest] = branches
    return {
      values: new Set([...first.values].filter((owner) => rest.every((branch) => branch.values.has(owner)))),
      edges: [],
    }
  }

  const filteredBy = (clause) => {
    const inScope = keyed.filter((table) => table.scope === scopes[clause])
    if (tokens[clause].toUpperCase() !== "ON") return inScope
    let join = clause - 1
    while (join >= 0 && !["JOIN", "USING", "FROM", "(", ";"].includes(tokens[join].toUpperCase())) {
      join = tokens[join] === ")" ? pairs.get(join) - 1 : join - 1
    }
    if (tokens[join]?.toUpperCase() !== "JOIN") return inScope
    const side = tokens[tokens[join - 1]?.toUpperCase() === "OUTER" ? join - 2 : join - 1]?.toUpperCase()
    if (side === "LEFT") return inScope.filter((table) => table.at > join && table.at < clause)
    return side === "RIGHT" || side === "FULL" ? [] : inScope
  }

  const pinned = new Set([SQL_OUTSIDE_OWNER])
  const flows = []
  tokens.forEach((token, clause) => {
    const word = token.toUpperCase()
    if (!SQL_CONDITION_STARTS.has(word)) return
    const previous = tokens[clause - 1]?.toUpperCase()
    // `ON CONFLICT`, `DISTINCT ON (…)` and `FILTER (WHERE …)` filter no table's rows.
    if (word === "ON" && (previous === "DISTINCT" || tokens[clause + 1]?.toUpperCase() === "CONFLICT")) return
    if (word === "WHERE" && previous === "(" && tokens[clause - 2]?.toUpperCase() === "FILTER") return
    const { values, edges } = conditionPins(clause + 1, sqlConditionEnd(tokens, pairs, clause + 1))
    const filtered = new Set(filteredBy(clause).map((table) => table.key))
    for (const owner of values) if (filtered.has(owner)) pinned.add(owner)
    for (const [left, right] of edges) {
      if (filtered.has(right)) flows.push([left, right])
      if (filtered.has(left)) flows.push([right, left])
    }
  })

  for (let grew = true; grew; ) {
    grew = false
    for (const [from, to] of flows) {
      if (!pinned.has(from) || pinned.has(to)) continue
      pinned.add(to)
      grew = true
    }
  }
  return new Set(tables.filter((table) => !table.isInsert && pinned.has(keyOf(table))))
}

/** Every FROM, JOIN, UPDATE, INTO and USING item in the statement, in order. */
function sqlTableReferences(tokens) {
  const references = []
  const levels = [{ opener: undefined, inFromList: false }]
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const previous = tokens[index - 1]?.toUpperCase()
    if (token === "(" || token === "[") {
      levels.push({ opener: previous, inFromList: false })
      continue
    }
    if (token === ")" || token === "]") {
      if (levels.length > 1) levels.pop()
      continue
    }

    const level = levels.at(-1)
    const keyword = token.toUpperCase()
    if (token === ",") {
      if (level.inFromList) references.push(readFromItem(tokens, index + 1))
      continue
    }
    if (SQL_FROM_LIST_ENDS.has(keyword)) level.inFromList = false
    if (!SQL_TABLE_KEYWORDS.has(keyword)) continue
    if (keyword === "FROM" && (previous === "DISTINCT" || SQL_FROM_TAKES_A_COLUMN_IN.has(level.opener))) continue
    if (keyword === "UPDATE" && ["FOR", "KEY", "DO"].includes(previous)) continue
    // `JOIN t USING (id)` names join columns; `MERGE … USING (SELECT …)` is a subquery.
    if (keyword === "USING" && tokens[index + 1] === "(") continue

    if (keyword === "INTO" && previous === "INSERT") {
      references.push(readInsertTarget(tokens, index + 1))
      continue
    }
    if (keyword === "FROM" || keyword === "USING") level.inFromList = true
    references.push(readFromItem(tokens, index + 1))
  }
  return references
}

/** Table references in one SQL statement whose `workspace_id` the statement never pins. */
function findUnscopedTableReferences(text, extendsStatement) {
  if (!SQL_STATEMENT_VERB.test(text) && !extendsStatement) return []

  const tokens = tokenizeSql(text)
  const cteNames = new Set([...text.matchAll(SQL_CTE_DEFINITION)].map((match) => match[1].toLowerCase()))
  const references = sqlTableReferences(tokens)
  const tables = references.filter((item) => item.table && !cteNames.has(item.table.toLowerCase()))
  const pinned = pinnedTables(tokens, tables)

  const isUnscoped = (item) => {
    if (Object.hasOwn(workspaceIdExemptTables, item.table.toLowerCase())) return false
    return item.isInsert ? !item.namesWorkspaceId : !pinned.has(item)
  }
  return references.filter((item) => item.hidden || (tables.includes(item) && isUnscoped(item)))
}

const CONNECT_COPY_RISK =
  "A copy of the row can exist in another workspace under the same id (INV-8): Connect holds read-only copies of a shared stream's rows in a partner workspace."
const CROSS_WORKSPACE_ESCAPE =
  "if this statement is cross-workspace by design (queue claims, sweepers, lookups by a global secret such as a key hash), or the name is a CTE defined in another fragment, add `// eslint-disable-next-line threa/workspace-scoped-sql -- <reason>`."

const workspaceScopedSqlRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require every workspace-scoped table in a SQL statement to be constrained by workspace_id (INV-8)",
    },
    schema: [],
    messages: {
      unscoped: `Table \`{{target}}\` is not pinned by \`{{column}}\` (compare it to a value, or to a pinned table's workspace_id). ${CONNECT_COPY_RISK} Constrain \`{{column}}\`, or, ${CROSS_WORKSPACE_ESCAPE}`,
      unscopedInsert: `INSERT INTO \`{{target}}\` does not name workspace_id in its column list. ${CONNECT_COPY_RISK} Name workspace_id in the column list, or, ${CROSS_WORKSPACE_ESCAPE}`,
      hiddenTable: `A table in this statement sits behind a \`\${…}\` that is not a constant in this file, so its workspace_id cannot be checked. ${CONNECT_COPY_RISK} Write the table name into the statement or a same-file \`const\`, or, ${CROSS_WORKSPACE_ESCAPE}`,
    },
  },
  create(context) {
    return {
      TemplateLiteral(node) {
        const text = cleanSqlText(templateText(context.sourceCode, node, 0))
        // A template opening with a statement fragment extends that statement, so the joins it appends are checked
        // here. An unresolved fragment only counts inside a SQL tag; a plain template opening with one is usually prose.
        const opening = text.trimStart()[0]
        const isSqlTagged =
          node.parent.type === "TaggedTemplateExpression" &&
          node.parent.tag.type === "Identifier" &&
          (node.parent.tag.name === "sql" || node.parent.tag.name === "composeSql")
        const extendsStatement = opening === SQL_CHECKED_ELSEWHERE || (opening === SQL_HIDDEN && isSqlTagged)
        for (const { table, alias, isInsert, hidden } of findUnscopedTableReferences(text, extendsStatement)) {
          if (hidden) {
            context.report({ node, messageId: "hiddenTable" })
            continue
          }
          const target = alias ? `${table} ${alias}` : table
          context.report({
            node,
            messageId: isInsert ? "unscopedInsert" : "unscoped",
            data: { target, column: `${alias ?? table}.workspace_id` },
          })
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
  "apps/backend/src/features/agents/session-repository.test.ts": 18,
  "apps/backend/src/features/ai-usage/usage-repository.test.ts": 4,
  "apps/backend/src/features/bot-access-requests/repository.test.ts": 5,
  "apps/backend/src/features/bot-runtimes/repository.test.ts": 49,
  "apps/backend/src/features/bot-runtimes/service.test.ts": 2,
  "apps/backend/src/features/calls/repository.test.ts": 61,
  "apps/backend/src/features/delegations/repository.test.ts": 19,
  "apps/backend/src/features/drafts/repository.test.ts": 39,
  "apps/backend/src/features/e2e-streams/actor-repository.test.ts": 9,
  "apps/backend/src/features/e2e-streams/key-wrap-repository.test.ts": 11,
  "apps/backend/src/features/e2e-streams/repository.test.ts": 10,
  "apps/backend/src/features/e2e-streams/rewrap-notifications-repository.test.ts": 7,
  "apps/backend/src/features/enclave-runtimes/invocations-repository.test.ts": 37,
  "apps/backend/src/features/enclave-runtimes/repository.test.ts": 12,
  "apps/backend/src/features/memos/service.test.ts": 3,
  "apps/backend/src/features/messaging/repository.test.ts": 2,
  "apps/backend/src/features/saved-messages/repository.test.ts": 48,
  "apps/backend/src/features/scheduled-messages/repository.test.ts": 51,
  "apps/backend/src/features/search/repository.test.ts": 8,
  "apps/backend/src/features/streams/access.test.ts": 4,
  "apps/backend/src/features/streams/brief-repository.test.ts": 9,
  "apps/backend/src/features/streams/effective-read-state.test.ts": 1,
  "apps/backend/src/features/streams/policy-repository.test.ts": 10,
  "apps/backend/src/features/streams/read-state-repository.test.ts": 27,
  "apps/backend/src/features/streams/repository.test.ts": 1,
  "apps/backend/src/features/user-e2e-keys/repository.test.ts": 10,
  "apps/backend/src/features/workspace-integrations/installation-routes.test.ts": 3,
  "apps/backend/src/features/workspace-integrations/linear-write-guards.test.ts": 2,
  "apps/backend/src/features/workspace-settings/handlers.test.ts": 1,
  // Not debt: `composeSql` builds the statement, so its emitted text IS the unit
  // under test. Nothing here claims a schema is correct.
  "packages/backend-common/src/db/compose.test.ts": 8,
}

/** The allowlist's paths, rebased onto a package that lints from its own root. */
function pathsUnderPackage(allowlist, packageDir) {
  const prefix = `${packageDir}/`
  return Object.keys(allowlist)
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
}

export function sqlTextAssertionExemptions(packageDir) {
  return pathsUnderPackage(sqlTextAssertionAllowlist, packageDir)
}

/**
 * Per-file count of SQL table references that predate `threa/workspace-scoped-sql`
 * (INV-8), the single source of truth for both consumers: `eslint.config.js`
 * exempts these files so `lint` stays green, and the ratchet test compares live
 * counts against them so the debt can only shrink. Fixing a statement and
 * lowering its file's number is always welcome; raising one, or adding a file,
 * is what the rule exists to stop.
 */
export const unscopedSqlAllowlist = {}

export function unscopedSqlExemptions(packageDir) {
  return pathsUnderPackage(unscopedSqlAllowlist, packageDir)
}

const threaPlugin = {
  rules: {
    "no-nested-component-definitions": noNestedComponentDefinitionsRule,
    "no-queryclient-getquerydata-in-render": noQueryClientGetQueryDataInRenderRule,
    "no-button-navigation": noButtonNavigationRule,
    "no-sql-text-assertion": noSqlTextAssertionRule,
    "workspace-scoped-sql": workspaceScopedSqlRule,
  },
}

export default threaPlugin
