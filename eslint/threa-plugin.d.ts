import type { ESLint } from "eslint"

declare const threaPlugin: ESLint.Plugin
export default threaPlugin

export declare const dotenvRestrictedImportPattern: { group: string[]; message: string }
export declare const providerSdkRestrictedImportPattern: { group: string[]; message: string }
export declare const testRestrictedProperties: Array<{ object: string; property: string; message: string }>
export declare const viMockRestrictedSyntax: { selector: string; message: string }

/** Repo-relative test file -> count of SQL-text assertions predating INV-68. */
export declare const sqlTextAssertionAllowlist: Record<string, number>
/** The allowlist's paths, rebased onto a package that lints from its own root. */
export declare function sqlTextAssertionExemptions(packageDir: string): string[]
