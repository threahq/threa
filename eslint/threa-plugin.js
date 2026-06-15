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

const threaPlugin = {
  rules: {
    "no-nested-component-definitions": noNestedComponentDefinitionsRule,
    "no-queryclient-getquerydata-in-render": noQueryClientGetQueryDataInRenderRule,
    "no-button-navigation": noButtonNavigationRule,
  },
}

export default threaPlugin
