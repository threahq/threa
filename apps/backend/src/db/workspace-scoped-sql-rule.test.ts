import { describe, test, expect } from "bun:test"
import { ESLint, RuleTester, type Linter, type Rule } from "eslint"
import tsParser from "@typescript-eslint/parser"
import threaPlugin from "../../../../eslint/threa-plugin.js"

/**
 * Pins the matcher behind `threa/workspace-scoped-sql`. The rule has no schema,
 * so every blind spot is a shape of text: these cases fix the shapes it must
 * read as a table reference, the ones it must leave alone, and the exact
 * message a developer gets.
 */

const rule = threaPlugin.rules!["workspace-scoped-sql"] as Rule.RuleModule
const RULE = "threa/workspace-scoped-sql"

RuleTester.describe = describe as unknown as typeof RuleTester.describe
RuleTester.it = test as unknown as typeof RuleTester.it

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser as Linter.Parser, ecmaVersion: "latest", sourceType: "module" },
})

const sqlTag = (body: string) => "const query = sql`" + body + "`"
const plain = (body: string) => "const query = `" + body + "`"

function unscoped(target: string, column: string) {
  return { messageId: "unscoped", data: { target, column } }
}

function unscopedInsert(target: string, column: string) {
  return { messageId: "unscopedInsert", data: { target, column } }
}

const hiddenTable = { messageId: "hiddenTable" }

ruleTester.run("workspace-scoped-sql", rule, {
  valid: [
    {
      name: "an aliased join naming every alias's workspace_id",
      code: sqlTag(`
        SELECT m.id FROM messages m JOIN streams s ON s.id = m.stream_id
        WHERE m.workspace_id = $1 AND s.workspace_id = $1`),
    },
    {
      name: "a CTE name is not a table, and the table inside it is scoped",
      code: sqlTag(`
        WITH recent AS (SELECT id FROM messages WHERE workspace_id = $1),
        newest AS MATERIALIZED (SELECT id FROM recent LIMIT 1)
        SELECT * FROM recent JOIN newest USING (id)`),
    },
    {
      name: "a recursive CTE with a column list",
      code: sqlTag(`
        WITH RECURSIVE chain (id, parent_id) AS (
          SELECT id, parent_stream_id FROM streams WHERE workspace_id = $1 AND id = $2
          UNION ALL SELECT s.id, s.parent_stream_id FROM streams s JOIN chain c ON c.parent_id = s.id
          WHERE s.workspace_id = $1
        ) SELECT * FROM chain`),
    },
    {
      name: "a function in FROM is not a table",
      code: sqlTag(`
        SELECT s.id FROM unnest($1::text[]) AS t(id) JOIN streams s ON s.id = t.id
        WHERE s.workspace_id = $2`),
    },
    {
      name: "a function alone is not a table",
      code: sqlTag(`SELECT value FROM jsonb_array_elements($1::jsonb) AS value`),
    },
    {
      name: "a single-table UPDATE with a bare workspace_id",
      code: sqlTag(`UPDATE streams SET name = $3 WHERE workspace_id = $1 AND id = $2`),
    },
    {
      name: "a single-table DELETE with a bare workspace_id",
      code: sqlTag(`DELETE FROM streams WHERE workspace_id = $1 AND id = $2`),
    },
    {
      name: "an unaliased table qualified by its own name",
      code: sqlTag(`SELECT * FROM streams WHERE streams.workspace_id = $1 AND streams.id = $2`),
    },
    {
      name: "an INSERT naming workspace_id in its column list",
      code: sqlTag(`INSERT INTO streams (id, workspace_id, name) VALUES ($1, $2, $3)`),
    },
    {
      name: "an INSERT … SELECT naming workspace_id and scoping its source",
      code: sqlTag(`
        INSERT INTO message_versions (id, workspace_id, message_id)
        SELECT $1, m.workspace_id, m.id FROM messages m WHERE m.workspace_id = $2 AND m.id = $3`),
    },
    {
      name: "an exempt table needs no workspace_id",
      code: sqlTag(`SELECT * FROM outbox WHERE id > $1`),
    },
    {
      name: "the workspaces root is exempt",
      code: sqlTag(`UPDATE workspaces SET name = $2 WHERE id = $1`),
    },
    {
      name: "a column-list constant has no statement verb",
      code: "const SESSION_SELECT_FIELDS = `id, workspace_id, session_id, created_at`",
    },
    {
      name: "a verb-less fragment alone is not a statement; the statement that inlines it is checked",
      code: sqlTag(`JOIN streams s ON s.id = m.stream_id`),
    },
    {
      name: "prose that mentions a verb in lowercase",
      code: plain(`Please select a stream to read from the sidebar, then join it.`),
    },
    {
      name: "a placeholder from sql.raw in the select list",
      code: sqlTag(`SELECT ${"${sql.raw(SELECT_FIELDS)}"} FROM streams s WHERE s.workspace_id = $1`),
    },
    {
      name: "FROM inside EXTRACT, DISTINCT FROM and FOR UPDATE are not table references",
      code: sqlTag(`
        SELECT EXTRACT(EPOCH FROM s.created_at) FROM streams s
        WHERE s.workspace_id = $1 AND s.name IS DISTINCT FROM $2 FOR UPDATE OF s SKIP LOCKED`),
    },
    {
      name: "ON CONFLICT … DO UPDATE SET is not a table reference",
      code: sqlTag(`
        INSERT INTO stream_read_state (workspace_id, stream_id, user_id) VALUES ($1, $2, $3)
        ON CONFLICT (workspace_id, stream_id, user_id) DO UPDATE SET user_id = EXCLUDED.user_id`),
    },
    {
      name: "catalog tables are not workspace-scoped",
      code: sqlTag(`SELECT pid FROM pg_stat_activity WHERE state = 'active'`),
    },
    {
      name: "a schema-qualified catalog table",
      code: sqlTag(`SELECT table_name FROM information_schema.tables`),
    },
    {
      name: "table words inside a comment or a string literal are ignored",
      code: sqlTag(`
        SELECT s.id FROM streams s -- joins messages m for the preview
        WHERE s.workspace_id = $1 AND s.name <> 'FROM messages'`),
    },
    {
      name: "a join pinned to a table whose workspace_id is pinned",
      code: sqlTag(`
        SELECT m.id FROM messages m JOIN streams s ON s.id = m.stream_id AND s.workspace_id = m.workspace_id
        WHERE m.workspace_id = $1`),
    },
    {
      name: "the value on the left of the comparison",
      code: sqlTag(`SELECT * FROM streams WHERE $1 = workspace_id AND id = $2`),
    },
    {
      name: "= ANY, IN and IS NOT DISTINCT FROM pin workspace_id",
      code: sqlTag(`
        SELECT s.id FROM streams s JOIN messages m ON m.stream_id = s.id JOIN reactions r ON r.message_id = m.id
        WHERE s.workspace_id = ANY($1) AND m.workspace_id IN ($2, $3) AND r.workspace_id IS NOT DISTINCT FROM $4`),
    },
    {
      name: "a same-file constant fragment is read into the statement",
      code: [
        "const FROM_STREAMS = `streams s LEFT JOIN e2e_streams e ON e.stream_id = s.id AND e.workspace_id = s.workspace_id`",
        "const query = sql`SELECT s.id FROM ${sql.raw(FROM_STREAMS)} WHERE s.workspace_id = $1`",
      ].join("\n"),
    },
    {
      name: "a constant fragment behind `as const`, a string literal and a bare interpolation",
      code: [
        'const STREAMS = "streams" as const',
        "const FROM_STREAMS = `${STREAMS} s` as const",
        "const query = `SELECT s.id FROM ${FROM_STREAMS} WHERE s.workspace_id = $1`",
      ].join("\n"),
    },
    {
      name: "a whole statement in a constant is checked where it is written",
      code: [
        "const MEMBER_STREAMS = sql`SELECT stream_id FROM stream_members WHERE workspace_id = $1`",
        "const query = sql`SELECT s.id FROM streams s WHERE s.workspace_id = $1 AND s.id IN (${MEMBER_STREAMS})`",
      ].join("\n"),
    },
    {
      name: "a scoped join appended to an inlined statement",
      code: [
        "const BASE = sql`SELECT m.id FROM messages m WHERE m.workspace_id = $1`",
        "const query = sql`${BASE} JOIN streams s ON s.id = m.stream_id AND s.workspace_id = m.workspace_id`",
      ].join("\n"),
    },
    {
      name: "prose opening with an interpolation is not SQL",
      code: "const prompt = `${intro}\nFetch from their workspace and do not guess.`",
    },
    {
      name: "a '--' inside a string literal does not start a comment",
      code: sqlTag(`SELECT * FROM streams WHERE name = '--' AND workspace_id = $1`),
    },
    {
      name: "a parenthesised join list with every table scoped",
      code: sqlTag(`
        SELECT * FROM (streams s JOIN messages m ON m.stream_id = s.id)
        WHERE s.workspace_id = $1 AND m.workspace_id = $1`),
    },
    {
      name: "JOIN … USING (columns) names no table",
      code: sqlTag(`
        SELECT * FROM streams s JOIN messages m USING (id)
        WHERE s.workspace_id = $1 AND m.workspace_id = $1`),
    },
    {
      name: "a comma-separated FROM list with every table scoped",
      code: sqlTag(`
        SELECT s.id FROM streams s, messages m
        WHERE s.workspace_id = $1 AND m.workspace_id = $1 AND m.stream_id = s.id`),
    },
    {
      name: "workspace_id IS NULL pins the rows to no workspace",
      code: sqlTag(`SELECT * FROM streams WHERE slug = $1 AND workspace_id IS NULL`),
    },
    {
      name: "a bare pin on an unaliased table carries into a subquery joined to it by name",
      code: sqlTag(`
        SELECT * FROM incoming_webhooks WHERE workspace_id = $1 AND EXISTS (
          SELECT 1 FROM bots WHERE bots.id = incoming_webhooks.bot_id
          AND bots.workspace_id = incoming_webhooks.workspace_id)`),
    },
    {
      name: "a join to an outer query's row is checked where that row is read",
      code: sqlTag(`
        EXISTS (SELECT 1 FROM messages m
          WHERE m.id = conversations.last_message_id AND m.workspace_id = conversations.workspace_id)`),
    },
    {
      name: "a join to a CTE alias is checked inside the CTE",
      code: sqlTag(`
        WITH updated AS (UPDATE streams SET name = $3 WHERE workspace_id = $1 AND id = $2 RETURNING *)
        SELECT * FROM updated u JOIN stream_members sm ON sm.workspace_id = u.workspace_id AND sm.stream_id = u.id`),
    },
    {
      name: "a join to a function's column list takes the value it was given",
      code: sqlTag(`
        SELECT s.id FROM unnest($1::text[], $2::text[]) AS ref(workspace_id, id)
        JOIN streams s ON s.workspace_id = ref.workspace_id AND s.id = ref.id`),
    },
    {
      name: "a scoped-or-global filter pins the table: every branch of the OR pins it",
      code: sqlTag(`SELECT id FROM personas WHERE (workspace_id = $1 OR workspace_id IS NULL) AND id = $2`),
    },
    {
      name: "a LEFT JOIN's ON pins the joined table to the preserved side once that side is pinned",
      code: sqlTag(`
        SELECT s.id FROM streams s LEFT JOIN messages m ON m.stream_id = s.id AND m.workspace_id = s.workspace_id
        WHERE s.workspace_id = $1`),
    },
    {
      name: "a comma inside an ARRAY in a join condition neither ends the condition nor starts a FROM item",
      code: sqlTag(`
        SELECT s.id FROM streams s JOIN messages m ON m.tag_ids && ARRAY[s.a, s.b] AND m.workspace_id = s.workspace_id
        WHERE s.workspace_id = $1`),
    },
  ],
  invalid: [
    {
      name: "an aliased join missing one alias's workspace_id",
      code: sqlTag(`
        SELECT m.id FROM messages m JOIN streams s ON s.id = m.stream_id
        WHERE m.workspace_id = $1`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "an unaliased lookup by id alone",
      code: sqlTag(`SELECT * FROM streams WHERE id = $1`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "workspace_id IS NOT NULL pins nothing",
      code: sqlTag(`SELECT * FROM streams WHERE id = $1 AND workspace_id IS NOT NULL`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "an unaliased name that repeats does not carry the outer bare pin inward",
      code: sqlTag(`
        SELECT * FROM streams WHERE workspace_id = $1
        AND EXISTS (SELECT 1 FROM streams WHERE id = $2)`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "a correlated join between two tables neither of which is pinned",
      code: sqlTag(`
        SELECT * FROM conversations c WHERE c.id = $1
        AND EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = c.workspace_id)`),
      errors: [unscoped("conversations c", "c.workspace_id"), unscoped("messages m", "m.workspace_id")],
    },
    {
      name: "the same table under two aliases is reported once per reference",
      code: sqlTag(`
        SELECT a.id FROM streams a JOIN streams b ON b.id = a.parent_stream_id
        WHERE a.workspace_id = $1`),
      errors: [unscoped("streams b", "b.workspace_id")],
    },
    {
      name: "a CTE name is skipped but the table inside it is not",
      code: sqlTag(`
        WITH recent AS (SELECT id FROM messages WHERE stream_id = $1)
        SELECT * FROM recent`),
      errors: [unscoped("messages", "messages.workspace_id")],
    },
    {
      name: "a function in FROM is skipped but a joined table is not",
      code: sqlTag(`SELECT s.id FROM unnest($1::text[]) AS t(id) JOIN streams s ON s.id = t.id`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a single-table UPDATE without workspace_id",
      code: sqlTag(`UPDATE streams SET name = $2 WHERE id = $1`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "a single-table DELETE without workspace_id",
      code: sqlTag(`DELETE FROM streams WHERE id = $1`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "an aliased UPDATE needs the alias, not a bare workspace_id",
      code: sqlTag(`UPDATE streams s SET name = $3 WHERE workspace_id = $1 AND s.id = $2`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "an INSERT without workspace_id in its column list",
      code: sqlTag(`INSERT INTO streams (id, name) VALUES ($1, $2)`),
      errors: [unscopedInsert("streams", "streams.workspace_id")],
    },
    {
      name: "an INSERT … SELECT that names workspace_id but reads an unscoped source",
      code: sqlTag(`
        INSERT INTO message_versions (id, workspace_id, message_id)
        SELECT $1, $2, m.id FROM messages m WHERE m.id = $3`),
      errors: [unscoped("messages m", "m.workspace_id")],
    },
    {
      name: "an exempt table beside a scoped table that is unconstrained",
      code: sqlTag(`SELECT s.id FROM outbox o JOIN streams s ON s.id = o.stream_id`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a placeholder in the select list does not hide the table",
      code: sqlTag(`SELECT ${"${sql.raw(SELECT_FIELDS)}"} FROM streams s WHERE s.id = $1`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a table behind an unresolved interpolation is reported, and so is the join",
      code: sqlTag(`SELECT * FROM ${"${sql.raw(table)}"} t JOIN streams s ON s.id = t.stream_id`),
      errors: [hiddenTable, unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a join appended to an inlined statement is checked",
      code: [
        "const BASE = sql`SELECT m.id FROM messages m WHERE m.workspace_id = $1`",
        "const query = sql`${BASE} JOIN streams s ON s.id = m.stream_id`",
      ].join("\n"),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a join appended to an unresolved statement is checked",
      code: sqlTag(`${"${base}"} JOIN streams s ON s.id = m.stream_id`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "an INSERT target behind an unresolved interpolation",
      code: sqlTag(`INSERT INTO ${"${sql.raw(table)}"} (id) VALUES ($1)`),
      errors: [hiddenTable],
    },
    {
      name: "a let binding is not a constant",
      code: [
        "let table = `streams`",
        "const query = sql`SELECT * FROM ${sql.raw(table)} WHERE workspace_id = $1`",
      ].join("\n"),
      errors: [hiddenTable],
    },
    {
      name: "a same-file constant fragment's table is checked in the statement",
      code: [
        "const FROM_STREAMS = `streams s`",
        "const query = sql`SELECT s.id FROM ${sql.raw(FROM_STREAMS)} WHERE s.id = $1`",
      ].join("\n"),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a workspace_id in the select list pins nothing",
      code: sqlTag(`SELECT workspace_id FROM agent_sessions WHERE id = $1`),
      errors: [unscoped("agent_sessions", "agent_sessions.workspace_id")],
    },
    {
      name: "RETURNING workspace_id pins nothing",
      code: sqlTag(`UPDATE streams SET name = $2 WHERE id = $1 RETURNING workspace_id`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "SET workspace_id = assigns, it does not pin",
      code: sqlTag(`UPDATE streams SET name = $3, workspace_id = $1 WHERE id = $2`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "!= and <= do not pin",
      code: sqlTag(
        `SELECT * FROM streams s JOIN messages m ON m.stream_id = s.id WHERE s.workspace_id != $1 AND m.workspace_id <= $1`
      ),
      errors: [unscoped("streams s", "s.workspace_id"), unscoped("messages m", "m.workspace_id")],
    },
    {
      name: "an INSERT column list does not pin the SELECT that feeds it",
      code: sqlTag(
        `INSERT INTO message_versions (id, workspace_id) SELECT $1, workspace_id FROM messages WHERE id = $2`
      ),
      errors: [unscoped("messages", "messages.workspace_id")],
    },
    {
      name: "a bare workspace_id outside a subquery does not pin the subquery's table",
      code: sqlTag(`
        SELECT * FROM streams WHERE workspace_id = $1
        AND id IN (SELECT stream_id FROM stream_members WHERE member_id = $2)`),
      errors: [unscoped("stream_members", "stream_members.workspace_id")],
    },
    {
      name: "a UNION branch is pinned on its own",
      code: sqlTag(`SELECT id FROM streams WHERE workspace_id = $1 UNION SELECT id FROM messages WHERE id = $2`),
      errors: [unscoped("messages", "messages.workspace_id")],
    },
    {
      name: "two tables joined on workspace_id with neither pinned to a value",
      code: sqlTag(`
        SELECT m.id FROM messages m JOIN streams s ON s.id = m.stream_id AND s.workspace_id = m.workspace_id
        WHERE s.id = $1`),
      errors: [unscoped("messages m", "m.workspace_id"), unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a subquery alias does not end the FROM list",
      code: sqlTag(`SELECT * FROM (SELECT 1) AS sub, messages m WHERE m.id = $1`),
      errors: [unscoped("messages m", "m.workspace_id")],
    },
    {
      name: "the first table of a parenthesised join",
      code: sqlTag(`SELECT * FROM (streams s JOIN messages m ON m.stream_id = s.id) WHERE m.workspace_id = $1`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "MERGE reads its target and its source",
      code: sqlTag(`
        MERGE INTO streams s USING messages m ON m.stream_id = s.id
        WHEN MATCHED THEN UPDATE SET name = m.content_markdown`),
      errors: [unscoped("streams s", "s.workspace_id"), unscoped("messages m", "m.workspace_id")],
    },
    {
      name: "UPDATE … FROM reads the joined table",
      code: sqlTag(
        `UPDATE messages m SET body = s.name FROM streams s WHERE s.id = m.stream_id AND m.workspace_id = $1`
      ),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "DELETE … USING reads the joined table",
      code: sqlTag(`DELETE FROM messages m USING streams s WHERE s.id = m.stream_id AND m.workspace_id = $1`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "schema-qualified and quoted table names",
      code: sqlTag(`SELECT * FROM public.streams s JOIN "messages" m ON m.stream_id = s.id WHERE s.id = $1`),
      errors: [unscoped("streams s", "s.workspace_id"), unscoped("messages m", "m.workspace_id")],
    },
    {
      name: "a placeholder for the column list cannot prove workspace_id",
      code: plain(`INSERT INTO access_log (${"${COLUMNS}"}) VALUES ($1)`),
      errors: [unscopedInsert("access_log", "access_log.workspace_id")],
    },
    {
      name: "a comma-separated FROM list reports the table that is missing",
      code: sqlTag(`
        SELECT s.id FROM streams s, messages m
        WHERE s.workspace_id = $1 AND m.stream_id = s.id`),
      errors: [unscoped("messages m", "m.workspace_id")],
    },
    {
      name: "workspace_id in a comment is not a constraint",
      code: sqlTag(`SELECT * FROM streams -- workspace_id comes later
        WHERE id = $1`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "a plain template literal is read like a tagged one",
      code: plain(`SELECT id FROM messages WHERE stream_id = $1`),
      errors: [unscoped("messages", "messages.workspace_id")],
    },
    {
      name: "a bare workspace_id on another table's alias does not satisfy this one",
      code: sqlTag(`SELECT m.id FROM messages m JOIN streams s ON s.id = m.stream_id WHERE s.workspace_id = $1`),
      errors: [unscoped("messages m", "m.workspace_id")],
    },
    {
      name: "an aliased UNION branch is pinned on its own",
      code: sqlTag(`
        SELECT s.id FROM streams s WHERE s.workspace_id = $1
        UNION SELECT s.id FROM streams s WHERE s.id = $2`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a pin inside a subquery does not reach an outer table under the same alias",
      code: sqlTag(`
        SELECT s.id FROM streams s
        WHERE s.id = $1 AND EXISTS (SELECT 1 FROM streams s WHERE s.workspace_id = $2)`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a correlated subquery's join does not pin the outer table",
      code: sqlTag(`
        SELECT m.id FROM messages m
        WHERE EXISTS (SELECT 1 FROM streams s WHERE s.workspace_id = $1 AND s.workspace_id = m.workspace_id)`),
      errors: [unscoped("messages m", "m.workspace_id")],
    },
    {
      name: "a CTE does not lend its pinned alias to the statement that reads it",
      code: sqlTag(`
        WITH picked AS (SELECT s.id FROM streams s WHERE s.workspace_id = $1)
        DELETE FROM streams s USING picked WHERE s.id = picked.id`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a data-modifying CTE body is its own scope",
      code: sqlTag(`
        WITH moved AS (UPDATE streams s SET name = $2 WHERE s.workspace_id = $1 RETURNING s.id)
        DELETE FROM streams s USING moved WHERE s.id = moved.id`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a pin on one branch of an OR pins nothing",
      code: sqlTag(`SELECT id FROM streams WHERE workspace_id = $1 OR id = $2`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "an optional workspace filter pins nothing",
      code: sqlTag(`SELECT i.id FROM bot_invocations i WHERE ($1::text IS NULL OR i.workspace_id = $1)`),
      errors: [unscoped("bot_invocations i", "i.workspace_id")],
    },
    {
      name: "a comparison under NOT pins nothing",
      code: sqlTag(`SELECT id FROM streams WHERE NOT (workspace_id = $1)`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "a comparison inside CASE pins nothing",
      code: sqlTag(`SELECT id FROM streams WHERE CASE WHEN workspace_id = $1 THEN true ELSE false END`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "an aggregate FILTER pins nothing",
      code: sqlTag(`SELECT count(*) FILTER (WHERE workspace_id = $1) FROM streams`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "workspace_id compared to another table's column pins nothing",
      code: sqlTag(`SELECT w.id FROM workspaces w JOIN users u ON u.workspace_id = w.id WHERE u.email = $1`),
      errors: [unscoped("users u", "u.workspace_id")],
    },
    {
      name: "a LEFT JOIN's ON does not pin the preserved side",
      code: sqlTag(`
        SELECT s.id FROM streams s
        LEFT JOIN messages m ON m.stream_id = s.id AND s.workspace_id = $1 AND m.workspace_id = $1`),
      errors: [unscoped("streams s", "s.workspace_id")],
    },
    {
      name: "a comma after a join chain continues the FROM list",
      code: sqlTag(`
        SELECT 1 FROM streams s JOIN messages m ON m.stream_id = s.id AND m.workspace_id = s.workspace_id, reactions r
        WHERE s.workspace_id = $1 AND r.message_id = m.id`),
      errors: [unscoped("reactions r", "r.workspace_id")],
    },
    {
      name: "a comma after USING continues the list",
      code: sqlTag(`
        DELETE FROM messages m USING streams s, reactions r
        WHERE m.workspace_id = $1 AND s.workspace_id = $1 AND r.message_id = m.id`),
      errors: [unscoped("reactions r", "r.workspace_id")],
    },
    {
      name: "a comma inside an ARRAY does not hide a later OR",
      code: sqlTag(`SELECT id FROM streams WHERE workspace_id = $1 AND tag_ids && ARRAY[$3, $4] OR id = $2`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "a left() call does not hide a later OR",
      code: sqlTag(`SELECT id FROM streams WHERE workspace_id = $1 AND left(name, 1) = $3 OR id = $2`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "workspace_id compared to an expression over its own column pins nothing",
      code: sqlTag(`SELECT id FROM streams WHERE workspace_id = COALESCE($1, workspace_id) AND id = $2`),
      errors: [unscoped("streams", "streams.workspace_id")],
    },
    {
      name: "workspace_id compared to a cast of another table's column pins nothing",
      code: sqlTag(`SELECT w.id FROM workspaces w JOIN users u ON u.workspace_id = w.id::text WHERE u.email = $1`),
      errors: [unscoped("users u", "u.workspace_id")],
    },
    {
      name: "a scalar subquery term does not lend its inner pins to the outer table",
      code: sqlTag(`
        SELECT m.id FROM messages m
        WHERE (SELECT count(*) = 0 FROM reactions r WHERE r.workspace_id = $1 AND r.message_id = $2 AND m.workspace_id = $1)`),
      errors: [unscoped("messages m", "m.workspace_id")],
    },
    {
      name: "a UNION branch inside a plain paren resolves outer aliases through the enclosing query",
      code: sqlTag(`
        SELECT m.id FROM messages m
        WHERE m.id = $1 AND m.id IN (
          (SELECT r.message_id FROM reactions r WHERE r.workspace_id = m.workspace_id)
          UNION (SELECT x.message_id FROM reactions x WHERE x.workspace_id = m.workspace_id))`),
      errors: [
        unscoped("messages m", "m.workspace_id"),
        unscoped("reactions r", "r.workspace_id"),
        unscoped("reactions x", "x.workspace_id"),
      ],
    },
    {
      name: "a RIGHT JOIN's ON pins nothing",
      code: sqlTag(`
        SELECT s.id FROM streams s
        RIGHT JOIN messages m ON m.stream_id = s.id AND s.workspace_id = $1 AND m.workspace_id = $1`),
      errors: [unscoped("streams s", "s.workspace_id"), unscoped("messages m", "m.workspace_id")],
    },
  ],
})

describe("the escape hatch the message names", () => {
  async function lint(code: string) {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: { files: ["**/*.ts"], plugins: { threa: threaPlugin }, rules: { [RULE]: "error" } },
    })
    const [result] = await eslint.lintText(code, { filePath: "queue.ts" })
    return result!.messages.filter((message) => message.ruleId === RULE)
  }

  test("a disable comment above the statement silences every reference in it", async () => {
    const code = [
      "// eslint-disable-next-line threa/workspace-scoped-sql -- queue claims are cross-workspace by design",
      "const query = sql`",
      "  SELECT m.id FROM messages m JOIN streams s ON s.id = m.stream_id",
      "`",
    ].join("\n")

    expect(await lint(code)).toEqual([])
  })

  test("the message tells the author how to scope the statement and when to opt out", async () => {
    const [message] = await lint("const query = sql`SELECT * FROM streams s WHERE s.id = $1`")

    expect(message!.message).toContain("`s.workspace_id`")
    expect(message!.message).toContain("INV-8")
    expect(message!.message).toContain("another workspace under the same id")
    expect(message!.message).toContain("// eslint-disable-next-line threa/workspace-scoped-sql -- <reason>")
  })
})
