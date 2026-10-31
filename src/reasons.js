export const DisconnectReason = Object.freeze({
  connectionClosed: 428,
  connectionLost: 408,
  timedOut: 408,
  connectionReplaced: 440,
  loggedOut: 401,
  forbidden: 403,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  clientOutdated: 405,
  unavailableService: 503
})

const NAMES = new Map()
for (const [name, code] of Object.entries(DisconnectReason)) if (!NAMES.has(code)) NAMES.set(code, name)

export const reasonName = (reason) => NAMES.get(Number(reason))

const TERMINAL = new Set([401, 403, 405, 411, 440, 500])

export const isTerminalReason = (reason) => TERMINAL.has(Number(reason))
