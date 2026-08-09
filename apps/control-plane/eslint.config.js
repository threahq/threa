import tsParser from "@typescript-eslint/parser"
import { dotenvRestrictedImportPattern, testRestrictedProperties } from "../../eslint/threa-plugin.js"

/**
 * ESLint configuration for the control plane.
 *
 * Enforces AGENTS.md invariants with clean syntactic signals:
 * - Runtime: do not import dotenv (Bun loads .env automatically)
 * - INV-47: no nested ternaries
 * - INV-51: lib/ is infrastructure — must not import from features/
 * - INV-52: Features import other features only through barrels (index.ts)
 * - INV-26 / INV-48: no skipped/todo tests and no mock.module()
 */
export default [
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
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
    files: ["src/lib/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            dotenvRestrictedImportPattern,
            {
              group: ["**/features/*", "**/features/**"],
              message:
                "lib/ is infrastructure — it must not import from features/ (INV-51). Move shared code to lib/ or invert the dependency.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["src/features/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            dotenvRestrictedImportPattern,
            {
              group: ["**/auth/**", "**/workspaces/**", "**/invitation-shadows/**"],
              message: "Import from feature barrels only (features/x/index.ts), not internals (INV-52).",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["**/*.{test,spec}.ts", "tests/**/*.ts"],
    rules: {
      "no-restricted-properties": ["error", ...testRestrictedProperties],
    },
  },
]
