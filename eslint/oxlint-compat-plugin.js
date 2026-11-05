import { createRequire } from "node:module"

const require = createRequire(new URL("../apps/frontend/package.json", import.meta.url))
const { builtinRules } = require("eslint/use-at-your-own-risk")

export default {
  rules: {
    "no-nested-ternary": builtinRules.get("no-nested-ternary"),
    "no-restricted-syntax": builtinRules.get("no-restricted-syntax"),
  },
}
