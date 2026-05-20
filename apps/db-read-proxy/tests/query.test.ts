import { describe, expect, test } from "bun:test"
import { stripLiteralsAndComments, validateSql, QueryValidationError } from "../src/query"

describe("stripLiteralsAndComments", () => {
  test("removes line comments", () => {
    expect(stripLiteralsAndComments("SELECT 1 -- nope\nFROM t")).toBe("SELECT 1 \nFROM t")
  })

  test("removes block comments", () => {
    expect(stripLiteralsAndComments("SELECT /* hi */ 1")).toBe("SELECT  1")
  })

  test("removes single-quoted strings including escaped quotes", () => {
    expect(stripLiteralsAndComments("SELECT 'a''b;c' AS x")).toBe("SELECT  AS x")
  })

  test("removes quoted identifiers", () => {
    expect(stripLiteralsAndComments('SELECT "weird;name" FROM t')).toBe("SELECT  FROM t")
  })

  test("removes dollar-quoted strings with tags", () => {
    expect(stripLiteralsAndComments("SELECT $body$one;two$body$ AS x")).toBe("SELECT  AS x")
  })

  test("removes bare dollar quotes", () => {
    expect(stripLiteralsAndComments("SELECT $$nasty;stuff$$ AS x")).toBe("SELECT  AS x")
  })
})

describe("validateSql", () => {
  test("accepts a plain SELECT", () => {
    expect(validateSql("SELECT 1")).toEqual({ sql: "SELECT 1", keyword: "SELECT" })
  })

  test("accepts WITH ... SELECT", () => {
    const { keyword } = validateSql("WITH x AS (SELECT 1) SELECT * FROM x")
    expect(keyword).toBe("WITH")
  })

  test("accepts EXPLAIN", () => {
    expect(validateSql("EXPLAIN ANALYZE SELECT 1").keyword).toBe("EXPLAIN")
  })

  test("accepts SHOW", () => {
    expect(validateSql("SHOW statement_timeout").keyword).toBe("SHOW")
  })

  test("strips a single trailing semicolon", () => {
    expect(validateSql("SELECT 1;").sql).toBe("SELECT 1")
  })

  test("tolerates leading comments and whitespace before the keyword", () => {
    expect(validateSql("-- comment\n  /* x */ SELECT 1").keyword).toBe("SELECT")
  })

  test("rejects an empty string", () => {
    expect(() => validateSql("")).toThrow(QueryValidationError)
    expect(() => validateSql("   ")).toThrow(QueryValidationError)
  })

  test("rejects INSERT / UPDATE / DELETE / DROP / TRUNCATE", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET x = 1",
      "DELETE FROM t",
      "DROP TABLE t",
      "TRUNCATE t",
      "ALTER TABLE t ADD COLUMN x int",
      "CREATE TABLE t (x int)",
      "GRANT SELECT ON t TO public",
    ]) {
      expect(() => validateSql(sql)).toThrow(QueryValidationError)
    }
  })

  test("rejects multi-statement SQL", () => {
    expect(() => validateSql("SELECT 1; SELECT 2")).toThrow(QueryValidationError)
    expect(() => validateSql("SELECT 1;\nSELECT 2")).toThrow(QueryValidationError)
  })

  test("ignores semicolons inside string literals", () => {
    expect(validateSql("SELECT ';' AS x").keyword).toBe("SELECT")
    expect(validateSql("SELECT 'a;b' AS x;").sql).toBe("SELECT 'a;b' AS x")
  })

  test("ignores semicolons inside block comments", () => {
    expect(validateSql("SELECT 1 /* ; */").keyword).toBe("SELECT")
  })

  test("ignores semicolons inside dollar-quoted strings", () => {
    expect(validateSql("SELECT $tag$ a; b $tag$ AS x").keyword).toBe("SELECT")
  })

  test("rejects SQL above the size limit", () => {
    const sql = "SELECT " + "1,".repeat(30_000) + "1"
    expect(() => validateSql(sql)).toThrow(QueryValidationError)
  })
})
