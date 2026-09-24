/** Stdout and stderr together; the rest is dropped and the result says so. */
export const SANDBOX_MAX_OUTPUT_BYTES = 64 * 1024
export const SANDBOX_DEFAULT_TIMEOUT_SEC = 60
export const SANDBOX_MAX_TIMEOUT_SEC = 300
/** A token outlives its command's timeout by this much, covering the exec lock wait and the broker start. */
export const SANDBOX_TOKEN_GRACE_SEC = 30

/** Installed in every box: data and charts, spreadsheets, PDFs and Office documents. */
export const SANDBOX_APT_PACKAGES = [
  "poppler-utils",
  "libreoffice-writer-nogui",
  "libreoffice-calc-nogui",
  "libreoffice-impress-nogui",
  "fonts-dejavu-core",
]
export const SANDBOX_PYTHON_PACKAGES = [
  "numpy",
  "pandas",
  "scipy",
  "matplotlib",
  "openpyxl",
  "pypdf",
  "pdfplumber",
  "reportlab",
  "python-docx",
  "python-pptx",
]
