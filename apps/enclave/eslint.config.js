import tsParser from "@typescript-eslint/parser"
import { dotenvRestrictedImportPattern, testRestrictedProperties } from "../../eslint/threa-plugin.js"

/**
 * ESLint configuration for the enclave service.
 *
 * - Runtime: do not import dotenv (Bun loads .env automatically)
 * - INV-47: no nested ternaries
 * - INV-26 / INV-48: no skipped/todo tests and no mock.module()
 */
export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      "no-nested-ternary": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [dotenvRestrictedImportPattern],
        },
      ],
    },
  },

  {
    files: ["src/**/*.{test,spec}.ts"],
    rules: {
      "no-restricted-properties": ["error", ...testRestrictedProperties],
    },
  },
]
