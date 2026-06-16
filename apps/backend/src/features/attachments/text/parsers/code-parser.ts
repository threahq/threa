import type { TextSection, CodeStructure } from "@threa/types"
import type { ParseResult, TextParser } from "./types"
import { EXTENSION_LANGUAGE_MAP, getFileExtension } from "../config"

const PREVIEW_LINES = 100
const LINES_PER_SECTION = 50

export const codeParser: TextParser = {
  parse(content: string, filename: string): ParseResult {
    const lines = content.split("\n")
    const totalLines = lines.length

    const ext = getFileExtension(filename.toLowerCase())
    const language = (ext && EXTENSION_LANGUAGE_MAP[ext]) || "unknown"

    const imports = extractImports(content, language)
    const exports = extractExports(content, language)

    const sections: TextSection[] = []
    if (totalLines > LINES_PER_SECTION) {
      let sectionStart = 0
      while (sectionStart < totalLines) {
        const sectionEnd = Math.min(sectionStart + LINES_PER_SECTION, totalLines)
        sections.push({
          type: "lines",
          path: `${sectionStart}-${sectionEnd - 1}`,
          title: `Lines ${sectionStart + 1}-${sectionEnd}`,
          startLine: sectionStart,
          endLine: sectionEnd,
        })
        sectionStart = sectionEnd
      }
    }

    const structure: CodeStructure = {
      language,
      exports: exports.length > 0 ? exports : null,
      imports: imports.length > 0 ? imports : null,
    }

    return {
      format: "code",
      sections,
      structure,
      previewContent: lines.slice(0, PREVIEW_LINES).join("\n"),
      totalLines,
    }
  },
}

function extractImports(content: string, language: string): string[] {
  const imports: string[] = []

  switch (language) {
    case "javascript":
    case "typescript": {
      // import { x } from 'y'
      // import x from 'y'
      // import 'y'
      // const x = require('y')
      const esImports = content.match(/import\s+(?:(?:\{[^}]+\}|[\w*]+)\s+from\s+)?['"]([^'"]+)['"]/g)
      const requireImports = content.match(/require\(['"]([^'"]+)['"]\)/g)

      if (esImports) {
        imports.push(...esImports.map((i) => i.replace(/import\s+(?:(?:\{[^}]+\}|[\w*]+)\s+from\s+)?/, "").trim()))
      }
      if (requireImports) {
        imports.push(...requireImports.map((i) => i.replace(/require\(['"]|['"]\)/g, "")))
      }
      break
    }

    case "python": {
      // import x
      // from x import y
      const pyImports = content.match(/^(?:import|from)\s+[\w.]+/gm)
      if (pyImports) {
        imports.push(...pyImports)
      }
      break
    }

    case "go": {
      // import "x"
      // import ( "x" "y" )
      const goImports = content.match(/import\s+(?:\([\s\S]*?\)|"[^"]+")/g)
      if (goImports) {
        imports.push(...goImports.flatMap((i) => i.match(/"[^"]+"/g) || []).map((i) => i.replace(/"/g, "")))
      }
      break
    }

    case "rust": {
      // use x::y;
      const rustImports = content.match(/use\s+[\w:]+;/g)
      if (rustImports) {
        imports.push(...rustImports.map((i) => i.replace(/^use\s+|;$/g, "")))
      }
      break
    }

    case "java":
    case "kotlin": {
      // import x.y.z;
      const javaImports = content.match(/import\s+[\w.]+;?/g)
      if (javaImports) {
        imports.push(...javaImports.map((i) => i.replace(/^import\s+|;$/g, "")))
      }
      break
    }
  }

  return [...new Set(imports)].slice(0, 20)
}

function extractExports(content: string, language: string): string[] {
  const exports: string[] = []

  switch (language) {
    case "javascript":
    case "typescript": {
      // export function x
      // export const x
      // export class x
      // export default x
      // export { x }
      const esExports = content.match(
        /export\s+(?:default\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/g
      )
      const namedExports = content.match(/export\s*\{([^}]+)\}/g)

      if (esExports) {
        exports.push(
          ...esExports.map((e) => {
            const match = e.match(/(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/)
            return match ? match[1] : e
          })
        )
      }
      if (namedExports) {
        for (const ne of namedExports) {
          const names = ne.match(/\{([^}]+)\}/)?.[1]
          if (names) {
            exports.push(...names.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]))
          }
        }
      }
      break
    }

    case "python": {
      // def x():
      // class X:
      // __all__ = [...]
      const defs = content.match(/^(?:def|class)\s+(\w+)/gm)
      if (defs) {
        exports.push(...defs.map((d) => d.replace(/^(?:def|class)\s+/, "")))
      }
      break
    }

    case "go": {
      // func X() - exported if capitalized
      // type X - exported if capitalized
      const goExports = content.match(/^(?:func|type|var|const)\s+([A-Z]\w*)/gm)
      if (goExports) {
        exports.push(...goExports.map((e) => e.match(/([A-Z]\w*)/)?.[1] || e))
      }
      break
    }

    case "rust": {
      // pub fn x
      // pub struct X
      // pub enum X
      const rustExports = content.match(/pub\s+(?:fn|struct|enum|trait|type|const|static)\s+(\w+)/g)
      if (rustExports) {
        exports.push(...rustExports.map((e) => e.match(/\s(\w+)$/)?.[1] || e))
      }
      break
    }
  }

  return [...new Set(exports)].slice(0, 20)
}
