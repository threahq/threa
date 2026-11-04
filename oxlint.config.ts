import { fileURLToPath } from "node:url"
import controlPlane from "./apps/control-plane/eslint.config.js"
import frontend from "./apps/frontend/eslint.config.js"
import backoffice from "./apps/backoffice/eslint.config.js"
import dbReadProxy from "./apps/db-read-proxy/eslint.config.js"
import enclave from "./apps/enclave/eslint.config.js"

const root = new URL(".", import.meta.url)
const threaPlugin = fileURLToPath(new URL("eslint/threa-plugin.js", root))
const compatPlugin = fileURLToPath(new URL("eslint/oxlint-compat-plugin.js", root))
const apps = [
  ["control-plane", controlPlane],
  ["frontend", frontend],
  ["backoffice", backoffice],
  ["db-read-proxy", dbReadProxy],
  ["enclave", enclave],
] as const

function convertRuleName(name: string) {
  return name === "no-nested-ternary" || name === "no-restricted-syntax" ? `eslint-compat/${name}` : name
}

const overrides = apps.flatMap(([app, config]) =>
  config.map(({ files, rules }) => ({
    files: files.map((pattern) => `apps/${app}/${pattern}`),
    rules: Object.fromEntries(Object.entries(rules).map(([name, rule]) => [convertRuleName(name), rule])),
  }))
)

export default {
  plugins: [],
  categories: { correctness: "off" },
  options: { reportUnusedDisableDirectives: "warn" },
  jsPlugins: [
    { name: "threa", specifier: threaPlugin },
    { name: "eslint-compat", specifier: compatPlugin },
  ],
  overrides,
}
