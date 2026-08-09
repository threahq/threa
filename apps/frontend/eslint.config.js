import tsParser from "@typescript-eslint/parser"
import threaPlugin, {
  dotenvRestrictedImportPattern,
  testRestrictedProperties,
  viMockRestrictedSyntax,
} from "../../eslint/threa-plugin.js"

/**
 * ESLint configuration for Threa frontend.
 *
 * Enforces AGENTS.md invariants with clean syntactic signals:
 * - Runtime: do not import dotenv (Bun loads .env automatically)
 * - INV-15: components/pages do not reach into persistence directly
 * - INV-18: do not define components inside other components
 * - INV-26 / INV-48: no skipped/todo tests and no mock.module()/vi.mock();
 *   prefer scoped spyOn patterns so mocks don't leak across tests
 * - INV-40: navigation uses links — no navigate()/router.push() in a button onClick
 * - INV-47: no nested ternaries
 * - Frontend Patterns: no direct queryClient.getQueryData() reads during render
 *
 * Components should handle UI rendering and local state only. They receive
 * capabilities via props/context and call them without knowing implementation.
 * This keeps components testable, reusable, and decoupled from persistence.
 */
export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      threa: threaPlugin,
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

  // INV-15: Components must not access database or persistence layer directly.
  // They receive capabilities (sendMessage, rename, etc.) via props or context.
  {
    files: ["src/components/**/*.{ts,tsx}", "src/pages/**/*.{ts,tsx}"],
    rules: {
      "threa/no-nested-component-definitions": "error",
      "threa/no-queryclient-getquerydata-in-render": "error",
      "threa/no-button-navigation": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            dotenvRestrictedImportPattern,
            {
              group: ["@/db", "@/db/*"],
              message: "Components must not import database directly (INV-15). Use hooks or context to access data.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["src/**/*.{test,spec}.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-properties": ["error", ...testRestrictedProperties],
      "no-restricted-syntax": ["error", viMockRestrictedSyntax],
    },
  },
]
