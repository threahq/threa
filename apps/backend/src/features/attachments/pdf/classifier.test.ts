import { describe, test, expect } from "bun:test"
import { classifyPage, type ClassificationInput, type TextItemWithPosition } from "./classifier"

describe("PDF Page Classifier", () => {
  describe("text_rich classification", () => {
    test("classifies page with substantial text and no images as text_rich", () => {
      const input: ClassificationInput = {
        rawText: "a".repeat(150), // More than 100 chars
        imageCount: 0,
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("text_rich")
    })

    test("classifies page with text exactly at threshold as text_rich", () => {
      const input: ClassificationInput = {
        rawText: "a".repeat(100), // Exactly at threshold
        imageCount: 0,
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("text_rich")
    })
  })

  describe("scanned classification", () => {
    test("classifies page with minimal text and images as scanned", () => {
      const input: ClassificationInput = {
        rawText: "a".repeat(30), // Less than 50 chars
        imageCount: 1, // Has images
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("scanned")
    })

    test("classifies page with images but very little text as scanned", () => {
      const input: ClassificationInput = {
        rawText: "abc",
        imageCount: 2,
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("scanned")
    })
  })

  describe("empty classification", () => {
    test("classifies page with no text and no images as empty", () => {
      const input: ClassificationInput = {
        rawText: "",
        imageCount: 0,
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("empty")
    })

    test("classifies page with null text and no images as empty", () => {
      const input: ClassificationInput = {
        rawText: null,
        imageCount: 0,
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("empty")
    })

    test("classifies page with very minimal text (< 10 chars) and no images as empty", () => {
      const input: ClassificationInput = {
        rawText: "abc",
        imageCount: 0,
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("empty")
    })
  })

  describe("complex_layout classification", () => {
    test("classifies page with tables as complex_layout", () => {
      const input: ClassificationInput = {
        rawText: "a".repeat(150),
        imageCount: 0,
        hasTables: true,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("complex_layout")
    })

    test("classifies page with multi-column layout as complex_layout", () => {
      const input: ClassificationInput = {
        rawText: "a".repeat(150),
        imageCount: 0,
        hasTables: false,
        isMultiColumn: true,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("complex_layout")
    })

    test("classifies page with both tables and multi-column as complex_layout", () => {
      const input: ClassificationInput = {
        rawText: "a".repeat(150),
        imageCount: 0,
        hasTables: true,
        isMultiColumn: true,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("complex_layout")
    })

    test("tables take priority over images for classification", () => {
      const input: ClassificationInput = {
        rawText: "a".repeat(150),
        imageCount: 2,
        hasTables: true,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("complex_layout")
    })
  })

  describe("mixed classification", () => {
    test("classifies page with substantial text and images as mixed", () => {
      const input: ClassificationInput = {
        rawText: "a".repeat(150), // More than 100 chars (text_rich threshold)
        imageCount: 2,
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("mixed")
    })

    test("classifies page with text exactly at threshold and images as mixed", () => {
      const input: ClassificationInput = {
        rawText: "a".repeat(100), // At text_rich threshold
        imageCount: 1,
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("mixed")
    })
  })

  describe("edge cases and priority", () => {
    test("handles text between scanned and text_rich thresholds with images", () => {
      // Text between 50-100 with images
      const input: ClassificationInput = {
        rawText: "a".repeat(75),
        imageCount: 1,
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      // Not enough text for mixed, but has images - falls to scanned
      expect(result.classification).toBe("scanned")
    })

    test("handles text between thresholds without images", () => {
      const input: ClassificationInput = {
        rawText: "a".repeat(75), // Between 10 and 100
        imageCount: 0,
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      // Falls through to empty fallback
      expect(result.classification).toBe("empty")
    })

    test("returns confidence scores", () => {
      const input: ClassificationInput = {
        rawText: "a".repeat(150),
        imageCount: 0,
        hasTables: false,
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.confidence).toBeGreaterThan(0)
      expect(result.confidence).toBeLessThanOrEqual(1)
    })
  })

  describe("auto-detection of tables", () => {
    test("detects tables from pipe characters in text", () => {
      const input: ClassificationInput = {
        rawText: `
| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |
`.repeat(5), // Ensure we have enough text
        imageCount: 0,
        // hasTables not provided - should be auto-detected
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("complex_layout")
    })

    test("detects tables from tab-separated content", () => {
      const input: ClassificationInput = {
        rawText: `
Column A\tColumn B\tColumn C
Value 1\tValue 2\tValue 3
Value 4\tValue 5\tValue 6
`.repeat(5),
        imageCount: 0,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("complex_layout")
    })

    test("detects tables from grid-like text positions", () => {
      // Simulate a table with text items at regular grid positions
      const textItems: TextItemWithPosition[] = []

      // Create a 5x4 grid of text items (table-like structure)
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 4; col++) {
          textItems.push({
            str: `Cell_${row}_${col}`,
            x: 50 + col * 100, // Regular column spacing
            y: 500 - row * 20, // Regular row spacing
            width: 50,
            height: 12,
          })
        }
      }

      const input: ClassificationInput = {
        rawText: textItems.map((t) => t.str).join(" "),
        imageCount: 0,
        textItems,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("complex_layout")
    })

    test("does not falsely detect tables in simple paragraphs", () => {
      const input: ClassificationInput = {
        rawText: "This is a simple paragraph with no table structure. ".repeat(10),
        imageCount: 0,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("text_rich")
    })
  })

  describe("auto-detection of multi-column layout", () => {
    test("detects multi-column layout from text positions", () => {
      // Simulate a two-column layout
      const textItems: TextItemWithPosition[] = []

      // Left column (x ~ 50)
      for (let i = 0; i < 15; i++) {
        textItems.push({
          str: `Left column line ${i}`,
          x: 50 + Math.random() * 5, // Small variation around x=50
          y: 700 - i * 20,
          width: 150,
          height: 12,
        })
      }

      // Right column (x ~ 300) - gap of 250
      for (let i = 0; i < 15; i++) {
        textItems.push({
          str: `Right column line ${i}`,
          x: 300 + Math.random() * 5, // Small variation around x=300
          y: 700 - i * 20,
          width: 150,
          height: 12,
        })
      }

      const input: ClassificationInput = {
        rawText: textItems.map((t) => t.str).join(" "),
        imageCount: 0,
        textItems,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("complex_layout")
    })

    test("does not detect multi-column in single-column text", () => {
      // Simulate single-column text (all items at similar x-position)
      const textItems: TextItemWithPosition[] = []

      for (let i = 0; i < 30; i++) {
        textItems.push({
          str: `Line ${i} of single column text`,
          x: 50 + Math.random() * 10, // All at similar x-position
          y: 700 - i * 20,
          width: 400,
          height: 12,
        })
      }

      const input: ClassificationInput = {
        rawText: textItems.map((t) => t.str).join(" "),
        imageCount: 0,
        textItems,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("text_rich")
    })

    test("requires sufficient text items for multi-column detection", () => {
      // Too few items to reliably detect columns
      const textItems: TextItemWithPosition[] = [
        { str: "Left", x: 50, y: 700, width: 50, height: 12 },
        { str: "Right", x: 300, y: 700, width: 50, height: 12 },
      ]

      const input: ClassificationInput = {
        rawText: "a".repeat(150), // Enough text
        imageCount: 0,
        textItems,
      }

      const result = classifyPage(input)
      // Not enough text items for column detection, falls back to text_rich
      expect(result.classification).toBe("text_rich")
    })
  })

  describe("explicit vs auto-detected flags", () => {
    test("explicit hasTables=false overrides auto-detection", () => {
      const input: ClassificationInput = {
        rawText: `| A | B | C |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |` + "a".repeat(100),
        imageCount: 0,
        hasTables: false, // Explicitly set to false
        isMultiColumn: false,
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("text_rich")
    })

    test("explicit isMultiColumn=false overrides auto-detection", () => {
      const textItems: TextItemWithPosition[] = []
      for (let i = 0; i < 10; i++) {
        textItems.push({ str: `L${i}`, x: 50, y: 700 - i * 20, width: 50, height: 12 })
        textItems.push({ str: `R${i}`, x: 300, y: 700 - i * 20, width: 50, height: 12 })
      }

      const input: ClassificationInput = {
        rawText: textItems.map((t) => t.str).join(" ") + "a".repeat(100),
        imageCount: 0,
        textItems,
        isMultiColumn: false, // Explicitly set to false
      }

      const result = classifyPage(input)
      expect(result.classification).toBe("text_rich")
    })
  })
})
