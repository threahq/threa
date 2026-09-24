/** Stdout and stderr together; the rest is dropped and the result says so. */
export const SANDBOX_MAX_OUTPUT_BYTES = 64 * 1024
export const SANDBOX_DEFAULT_TIMEOUT_SEC = 60
export const SANDBOX_MAX_TIMEOUT_SEC = 300
/** A token outlives its command's timeout by this much, covering box creation and file copies before exec. */
export const SANDBOX_TOKEN_GRACE_SEC = 180
