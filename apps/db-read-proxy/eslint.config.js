import tsParser from "@typescript-eslint/parser"
import { dotenvRestrictedImportPattern, testRestrictedProperties } from "../../eslint/threa-plugin.js"

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
    files: ["**/*.{test,spec}.ts", "tests/**/*.ts"],
    rules: {
      "no-restricted-properties": ["error", ...testRestrictedProperties],
    },
  },
]
