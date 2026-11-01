import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { EventEmitter } from 'node:events'
import { ZyrixError, ErrorKind, isZyrixError } from './errors.js'
import { DisconnectReason, reasonName } from './reasons.js'

const noop = () => {}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const withTimeout = (promise, ms) => Promise.race([Promise.resolve(promise), sleep(ms)])

const parsePhoneNumber = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '')
  return /^\d{8,15}$/.test(digits) ? digits : null
}

const formatPairingCode = (code) => {
  const text = String(code)
  return text.length === 8 ? `${text.slice(0, 4)}-${text.slice(4)}` : text
}

const promptPhone = async (question, { input = process.stdin, output = process.stdout, attempts = 3, invalid } = {}) => {
  if (!input.isTTY) return null
  const rl = readline.createInterface({ input, output })
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const number = parsePhoneNumber(await rl.question(question))
      if (number) return number
      if (invalid) output.write(`${invalid}\n`)
    }
    return null
  } finally {
    rl.close()
  }
}

const RESET_WHY = new Map([
  [DisconnectReason.loggedOut, 'logged-out'],
  [DisconnectReason.badSession, 'bad-session'],
  [DisconnectReason.multideviceMismatch, 'multidevice-mismatch']
])

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP']

const defaultConnector = async (options) => {
  const { Socket } = await import('./socket.js')
  return new Socket(options).start()
}

class Launcher extends EventEmitter {
  constructor(options = {}) {
    super({ captureRejections: true })
    const {
      session = 'session',
      sessionEncryptionKey,
      phoneNumber,
      setup,
      connector = defaultConnector,
      autoReset = true,
      maxRelaunches = 4,
      relaunchWindowMs = 10 * 60 * 1000,
      relaunchDelayMs = 1500,
      watchSession = true,
      watchIntervalMs = 2000,
      signals = false,
      exit = true,
      printCode = true,
      on,
      ...socketOptions
    } = options
    if (setup !== undefined && typeof setup !== 'function') throw new ZyrixError('setup debe ser una función', { kind: ErrorKind.INVALID })
    if (typeof connector !== 'function') throw new ZyrixError('connector debe ser una función', { kind: ErrorKind.INVALID })
    this.session = session
    this.sessionEncryptionKey = sessionEncryptionKey
    this.phoneOption = phoneNumber
    this.setup = setup
    this.connector = connector
    this.autoReset = autoReset
    this.maxRelaunches = maxRelaunches
    this.relaunchWindowMs = relaunchWindowMs
    this.relaunchDelayMs = relaunchDelayMs
    this.watchSession = watchSession
    this.watchIntervalMs = watchIntervalMs
    this.signalList = signals === true ? SIGNALS : Array.isArray(signals) ? signals : []
    this.exitOnSignal = exit
    this.printCode = printCode
    this.socketOptions = socketOptions
    this.sock = null
    this.current = null
    this.stopping = false
    this.knownPhone = null
    this.relaunchTimes = []
    this.first = null
    this.misses = 0
    this.senderKeyMisses = 0
    this.senderKeyTimer = null
    this.signalHandlers = new Map()
    this.on('error', noop)
    if (on && typeof on === 'object') for (const [event, handler] of Object.entries(on)) this.on(event, handler)
  }

  get isOpen() {
    return Boolean(this.sock?.isOpen)
  }

  start() {
    const first = new Promise((resolve, reject) => {
      this.first = { resolve, reject }
    })
    first.catch(noop)
    this.hookSignals()
    this.launch().catch((error) => this.fatal('launch-error', error))
    return first
  }

  async resolveAuth() {
    if (typeof this.session === 'string') return (await import('./auth.js')).useFileAuthState(this.session, this.sessionEncryptionKey === undefined ? {} : { encryptionKey: this.sessionEncryptionKey })
    if (this.session?.state && typeof this.session.save === 'function') return this.session
    return (await import('./authstore.js')).useAdapterAuthState(this.session, this.sessionEncryptionKey === undefined ? {} : { encryptionKey: this.sessionEncryptionKey })
  }

  canClear() {
    return typeof this.session === 'string' || typeof this.session?.clear === 'function'
  }

  async clear() {
    if (typeof this.session === 'string') fs.rmSync(path.resolve(this.session), { recursive: true, force: true })
    else await this.session.clear()
  }

  async resolvePhone() {
    const option = this.phoneOption
    if (option === undefined || option === null) return null
    const value = typeof option === 'function' ? await option() : option
    if (value === undefined || value === null || value === '') return null
    const phone = parsePhoneNumber(value)
    if (!phone) throw new ZyrixError('el número de teléfono debe tener entre 8 y 15 dígitos, con código de país', { kind: ErrorKind.INVALID })
    return phone
  }

  async launch() {
    if (this.stopping) return
    let auth
    try {
      auth = await this.resolveAuth()
    } catch (error) {
      if (/corrupt/i.test(String(error?.message)) && this.autoReset && this.canClear()) {
        await this.clear()
        return this.relaunch('corrupt-session')
      }
      return this.fatal('auth-error', error)
    }
    const registered = Boolean(auth.state.creds.registered)
    let phone = null
    if (registered) {
      phone = parsePhoneNumber(/^\d+/.exec(String(auth.state.creds.me?.id ?? ''))?.[0])
    } else {
      try {
        phone = this.knownPhone ?? (await this.resolvePhone())
      } catch (error) {
        return this.fatal('invalid-phone', error)
      }
    }
    if (phone) this.knownPhone = phone
    this.emit('status', { state: 'connecting', registered, phoneNumber: phone })
    let sock
    try {
      sock = await this.connector({
        ...this.socketOptions,
        auth,
        phoneNumber: registered ? undefined : phone ?? undefined,
        printQR: this.socketOptions.printQR ?? !phone
      })
    } catch (error) {
      return this.fatal('connect-error', error)
    }
    if (this.stopping) {
      await withTimeout(Promise.resolve(sock.end?.()).catch(noop), 5000)
      return
    }
    const ctx = { sock, auth, finished: false, watcher: null, seenState: false, cleanup: null }
    this.current = ctx
    this.sock = sock
    auth.onSaveError = (error) => this.onSaveError(ctx, error)
    sock.on('error', (error) => this.onSockError(ctx, error))
    sock.on('qr', (qr) => this.emit('qr', qr))
    sock.on('pairing-code', (code) => {
      const formatted = formatPairingCode(code)
      this.emit('status', { state: 'pairing' })
      if (!this.emit('pairing-code', code, formatted) && this.printCode) process.stdout.write(`${formatted}\n`)
    })
    sock.on('open', () => {
      this.emit('status', { state: 'open' })
      this.emit('open', sock)
      const first = this.first
      this.first = null
      first?.resolve(this)
    })
    sock.on('close', (info) => void this.onClose(ctx, info))
    this.emit('socket', sock)
    this.startWatcher(ctx)
    if (this.setup) {
      try {
        const cleanup = await this.setup(sock, this)
        if (typeof cleanup === 'function') ctx.cleanup = cleanup
        else if (cleanup && typeof cleanup.stop === 'function') ctx.cleanup = () => cleanup.stop()
      } catch (error) {
        this.emit('issue', { type: 'setup-error', error })
      }
    }
  }

  startWatcher(ctx) {
    if (!this.watchSession || typeof this.session !== 'string' || !this.watchIntervalMs) return
    const dir = path.resolve(this.session)
    const statePath = path.join(dir, 'state.json')
    let misses = 0
    ctx.watcher = setInterval(() => {
      if (ctx.finished) return
      const stateExists = fs.existsSync(statePath)
      if (stateExists) ctx.seenState = true
      const missing = !fs.existsSync(dir) || (ctx.seenState && !stateExists)
      misses = missing ? misses + 1 : 0
      if (misses >= 2) void this.onSessionMissing(ctx)
    }, this.watchIntervalMs)
    ctx.watcher.unref?.()
  }

  async retire(ctx, { logout }) {
    ctx.finished = true
    clearInterval(ctx.watcher)
    if (ctx.cleanup) {
      try {
        await ctx.cleanup()
      } catch (error) {
        this.emit('issue', { type: 'cleanup-error', error })
      }
    }
    if (logout) await withTimeout(Promise.resolve(ctx.sock.logout?.()).catch(noop), 12000)
    await withTimeout(Promise.resolve(ctx.sock.end?.()).catch(noop), 5000)
    if (this.current === ctx) {
      this.current = null
      this.sock = null
    }
  }

  async onSessionMissing(ctx) {
    if (ctx.finished || this.stopping) return
    this.emit('issue', { type: 'session-deleted' })
    await this.retire(ctx, { logout: Boolean(ctx.auth?.state?.creds?.registered) })
    await this.clear()
    return this.relaunch('session-deleted')
  }

  onSaveError(ctx, error) {
    if (ctx.finished) return
    if (typeof this.session === 'string' && (error?.code === 'ENOENT' || !fs.existsSync(path.resolve(this.session)))) return void this.onSessionMissing(ctx)
    this.emit('issue', { type: 'save-error', error })
  }

  onSockError(ctx, error) {
    if (ctx.finished) return
    const message = String(error?.message ?? error)
    const code = error?.code ?? error?.errno ?? error?.cause?.code
    if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME'].includes(code)) {
      return this.emit('issue', { type: 'dns', code, hostname: error?.hostname, name: error?.name, error })
    }
    if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'].includes(code)) {
      return this.emit('issue', { type: 'network', code, name: error?.name, error })
    }
    if (Number(code) === 1006 || /WebSocket cerr[oó] antes del handshake|closed.*before.*handshake/i.test(message)) {
      return this.emit('issue', { type: 'websocket-handshake', code: 1006, name: error?.name, error })
    }
    if (/sin sender key/.test(message)) return this.noteSenderKeyMiss()
    if (isZyrixError(error, ErrorKind.CLOSED)) return
    const stream = /^WhatsApp stream error: (.+)$/.exec(message)
    if (stream) {
      let code
      try {
        code = Number(JSON.parse(stream[1]).code)
      } catch {}
      return this.emit('issue', { type: 'stream-error', code, name: reasonName(code), error })
    }
    const rejected = /rechazó la conexión \((\d+)\)/.exec(message)
    if (rejected) return this.emit('issue', { type: 'connection-rejected', code: Number(rejected[1]), name: reasonName(Number(rejected[1])), error })
    if (/sin actividad|keepalive/.test(message)) return this.emit('issue', { type: 'idle', error })
    if (isZyrixError(error, ErrorKind.TIMEOUT)) return this.emit('issue', { type: 'timeout', error })
    this.emit('issue', { type: 'error', error })
  }

  noteSenderKeyMiss() {
    this.senderKeyMisses++
    if (this.senderKeyTimer) return
    this.senderKeyTimer = setTimeout(() => {
      const count = this.senderKeyMisses
      this.senderKeyMisses = 0
      this.senderKeyTimer = null
      this.emit('issue', { type: 'sender-key-miss', count })
    }, 10000)
    this.senderKeyTimer.unref?.()
  }

  async onClose(ctx, info) {
    if (ctx.finished || this.stopping) return
    const reason = info?.reason
    if (info?.reconnecting) {
      this.emit('status', { state: 'reconnecting', reason, name: reasonName(reason), restart: reason === DisconnectReason.restartRequired })
      return
    }
    await this.retire(ctx, { logout: false })
    const why = RESET_WHY.get(reason)
    if (why && this.autoReset && this.canClear()) {
      await this.clear()
      return this.relaunch(why)
    }
    return this.fatal(reasonName(reason) ?? 'closed', null, { code: reason })
  }

  async relaunch(why) {
    if (this.stopping) return
    const now = Date.now()
    this.relaunchTimes = this.relaunchTimes.filter((time) => now - time < this.relaunchWindowMs)
    if (this.relaunchTimes.length >= this.maxRelaunches) return this.fatal('too-many-relaunches', null, { why })
    this.relaunchTimes.push(now)
    this.emit('status', { state: 'relaunching', why })
    await sleep(this.relaunchDelayMs)
    return this.launch()
  }

  fatal(reason, error, extra = {}) {
    const info = { reason, error, ...extra }
    this.emit('fatal', info)
    const first = this.first
    this.first = null
    first?.reject(new ZyrixError(`Zyrix no pudo mantener la conexión (${reason})`, { kind: ErrorKind.CLOSED, code: extra.code, cause: error ?? undefined, details: info }))
  }

  hookSignals() {
    for (const signal of this.signalList) {
      if (this.signalHandlers.has(signal)) continue
      const handler = async () => {
        if (this.stopping) return process.exit(1)
        this.emit('signal', signal)
        await withTimeout(this.stop(), 8000)
        if (this.exitOnSignal) process.exit(0)
      }
      this.signalHandlers.set(signal, handler)
      process.on(signal, handler)
    }
  }

  unhookSignals() {
    for (const [signal, handler] of this.signalHandlers) process.off(signal, handler)
    this.signalHandlers.clear()
  }

  async stop() {
    if (this.stopping && !this.current) return
    this.stopping = true
    clearTimeout(this.senderKeyTimer)
    this.senderKeyTimer = null
    if (this.current) await this.retire(this.current, { logout: false })
    this.emit('stopped')
  }

  async logout() {
    this.stopping = true
    if (this.current) await this.retire(this.current, { logout: true })
    if (this.canClear()) await this.clear()
    this.emit('stopped')
  }
}

const createLauncher = (options) => new Launcher(options)
const start = (options) => new Launcher(options).start()

export { Launcher, createLauncher, start, parsePhoneNumber, formatPairingCode, promptPhone }
