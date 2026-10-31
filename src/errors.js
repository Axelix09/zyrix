const ErrorKind = Object.freeze({
  TIMEOUT: 'timeout',
  CLOSED: 'closed',
  NOT_READY: 'not-ready',
  REJECTED: 'rejected',
  INVALID: 'invalid',
  NO_SESSION: 'no-session',
  DECRYPT: 'decrypt',
  MEDIA: 'media',
  AUTH: 'auth'
})

class ZyrixError extends Error {
  constructor(message, { kind = 'unknown', code, details, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ZyrixError'
    this.kind = kind
    if (code !== undefined) this.code = code
    if (details !== undefined) this.details = details
  }

  get retryable() {
    return this.kind === ErrorKind.TIMEOUT || this.kind === ErrorKind.CLOSED || this.kind === ErrorKind.NOT_READY
  }

  toJSON() {
    return { name: this.name, kind: this.kind, code: this.code, message: this.message, retryable: this.retryable }
  }
}

const isZyrixError = (value, kind) => value instanceof ZyrixError && (kind === undefined || value.kind === kind)

export { ZyrixError, ErrorKind, isZyrixError }
