import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Launcher, createLauncher, start, parsePhoneNumber, formatPairingCode, promptPhone } from '../src/launcher.js'
import { makeState } from './helpers/state.js'

const fakeSock = () => {
  const sock = new EventEmitter()
  sock.isOpen = false
  sock.end = async () => { sock.ended = true }
  sock.logout = async () => { sock.loggedOut = true }
  return sock
}

const fakeSession = (registered = true) => {
  const state = makeState()
  state.creds.registered = registered
  if (!registered) state.creds.me = null
  return { state, save() {}, flush() {}, clear: async () => {} }
}

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

test('launcher: utilidades de teléfono y código', async () => {
  assert.equal(parsePhoneNumber('+54 911 0000-0002'), '5491100000002')
  assert.equal(parsePhoneNumber('123'), null)
  assert.equal(parsePhoneNumber(null), null)
  assert.equal(parsePhoneNumber('1'.repeat(16)), null)
  assert.equal(formatPairingCode('12345678'), '1234-5678')
  assert.equal(formatPairingCode('123'), '123')
  assert.equal(await promptPhone('?', { input: { isTTY: false } }), null)
  // promptPhone interactivo necesita un TTY real; el camino no-TTY es el que se
  // puede verificar de forma determinista en CI.
  assert.equal(await promptPhone('?', { input: { isTTY: false }, attempts: 0 }), null)
})

test('launcher: arranca, conecta, reporta open y expone el socket', async () => {
  let connectorOptions
  const child = fakeSock()
  const launcher = new Launcher({
    session: fakeSession(),
    connector: async (options) => { connectorOptions = options; setImmediate(() => child.emit('open')); return child },
    watchSession: false,
    signals: false
  })
  const statuses = []
  launcher.on('status', (s) => statuses.push(s))
  const ready = launcher.start()
  assert.equal(await ready, launcher)
  assert.equal(connectorOptions.auth.state.creds.registered, true)
  assert.equal(connectorOptions.phoneNumber, undefined)
  assert.equal(launcher.isOpen, false)
  assert.deepEqual(statuses.map((s) => s.state), ['connecting', 'open'])
  child.isOpen = true
  assert.equal(launcher.isOpen, true)
  await launcher.stop()
  assert.equal(child.ended, true)
})

test('launcher: sesión no registrada pide teléfono o acepta función', async () => {
  const child = fakeSock()
  const launcher = new Launcher({
    session: fakeSession(false),
    phoneNumber: async () => '+54 911 0000-0002',
    connector: async (options) => { launcher.received = options; setImmediate(() => child.emit('open')); return child },
    watchSession: false
  })
  await launcher.start()
  assert.equal(launcher.received.phoneNumber, '5491100000002')
  assert.equal(launcher.received.printQR, false)
  await launcher.stop()

  const invalid = new Launcher({ session: fakeSession(false), phoneNumber: '123', watchSession: false })
  const fatal = []
  invalid.on('fatal', (f) => fatal.push(f))
  await assert.rejects(invalid.start(), /could not keep the connection/)
  assert.equal(fatal[0].reason, 'invalid-phone')

  const none = new Launcher({ session: fakeSession(false), phoneNumber: null, watchSession: false, connector: async () => { throw new Error('no') } })
  const fatal2 = []
  none.on('fatal', (f) => fatal2.push(f))
  await assert.rejects(none.start())
  assert.equal(fatal2[0].reason, 'connect-error')
})

test('launcher: QR, pairing-code, setup, cleanup y issues de setup', async () => {
  const child = fakeSock()
  let cleaned = 0
  const launcher = new Launcher({
    session: fakeSession(false),
    connector: async () => { setImmediate(() => child.emit('open')); return child },
    setup: async () => () => { cleaned++ },
    watchSession: false,
    printCode: false
  })
  const events = []
  launcher.on('qr', (q) => events.push(['qr', q]))
  launcher.on('pairing-code', (c, f) => events.push(['code', c, f]))
  await launcher.start()
  child.emit('qr', 'qr-data')
  child.emit('pairing-code', '12345678')
  assert.deepEqual(events, [['qr', 'qr-data'], ['code', '12345678', '1234-5678']])
  await launcher.stop()
  assert.equal(cleaned, 1)

  const cleanupObject = fakeSock()
  const launcher2 = new Launcher({
    session: fakeSession(),
    connector: async () => { setImmediate(() => cleanupObject.emit('open')); return cleanupObject },
    setup: async () => ({ stop: async () => { cleaned++ } }),
    watchSession: false
  })
  await launcher2.start()
  await launcher2.logout()
  assert.equal(cleaned, 2)
  assert.equal(cleanupObject.loggedOut, true)

  const brokenSetup = fakeSock()
  const launcher3 = new Launcher({
    session: fakeSession(),
    connector: async () => { setImmediate(() => brokenSetup.emit('open')); return brokenSetup },
    setup: async () => { throw new Error('setup') },
    watchSession: false
  })
  const issues = []
  launcher3.on('issue', (i) => issues.push(i))
  await launcher3.start()
  assert.equal(issues[0].type, 'setup-error')
  await launcher3.stop()
})

test('launcher: cierre terminal, reconexión y auto-reset de sesión', async () => {
  const children = []
  let launches = 0
  const session = fakeSession()
  let cleared = 0
  session.clear = async () => { cleared++ }
  const launcher = new Launcher({
    session,
    connector: async () => {
      launches++
      const child = fakeSock()
      children.push(child)
      setImmediate(() => child.emit('open'))
      return child
    },
    watchSession: false,
    relaunchDelayMs: 1
  })
  const statuses = []
  launcher.on('status', (s) => statuses.push(s))
  await launcher.start()
  children[0].emit('close', { reconnecting: true, reason: 515 })
  assert.equal(statuses.at(-1).state, 'reconnecting')
  assert.equal(statuses.at(-1).restart, true)

  children[0].emit('close', { reconnecting: false, reason: 401 })
  await wait(50)
  assert.equal(cleared, 1)
  assert.equal(launches, 2)
  assert.ok(statuses.some((s) => s.state === 'relaunching'))

  const fatal = []
  launcher.on('fatal', (f) => fatal.push(f))
  children[1].emit('close', { reconnecting: false, reason: 403 })
  await wait(30)
  assert.equal(fatal[0].reason, 'forbidden')

  const plain = new Launcher({ session: fakeSession(), connector: async () => { throw new Error('x') }, watchSession: false })
  const plainFatal = []
  plain.on('fatal', (f) => plainFatal.push(f))
  await assert.rejects(plain.start())
  assert.equal(plainFatal[0].reason, 'connect-error')
})

test('launcher: límite de relanzamientos y sesión corrupta', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-launcher-'))
  const session = path.join(dir, 'session')
  const launcher = new Launcher({ session, maxRelaunches: 0, relaunchDelayMs: 1, watchSession: false, connector: async () => { throw new Error('no') } })
  const fatal = []
  launcher.on('fatal', (f) => fatal.push(f))
  await launcher.relaunch('test')
  assert.equal(fatal[0].reason, 'too-many-relaunches')
  assert.equal(launcher.canClear(), true)
  await launcher.clear()

  const corrupt = new Launcher({
    session,
    autoReset: true,
    watchSession: false,
    connector: async () => { throw new Error('no') }
  })
  let relaunched = false
  corrupt.relaunch = async () => { relaunched = true }
  corrupt.resolveAuth = async () => { throw new Error('corrupt session') }
  await corrupt.launch()
  assert.equal(relaunched, true)
  await rm(dir, { recursive: true, force: true })
})

test('launcher: watcher detecta la sesión borrada y onSaveError la reporta', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-watch-'))
  const session = path.join(dir, 'session')
  await mkdir(session, { recursive: true })
  await writeFile(path.join(session, 'state.json'), '{}')
  const child = fakeSock()
  const launcher = new Launcher({
    session,
    connector: async () => child,
    watchIntervalMs: 5,
    watchSession: true,
    autoReset: false
  })
  const issues = []
  launcher.on('issue', (i) => issues.push(i))
  launcher.onSessionMissing = async (ctx) => {
    ctx.finished = true
    issues.push({ type: 'session-deleted' })
  }
  const ctx = { sock: child, auth: { state: { creds: { registered: false } } }, finished: false, seenState: false, cleanup: null }
  launcher.current = ctx
  launcher.sock = child
  launcher.startWatcher(ctx)
  await rm(session, { recursive: true, force: true })
  await wait(60)
  assert.ok(issues.some((i) => i.type === 'session-deleted'))

  await mkdir(session, { recursive: true })
  const saveCtx = { finished: false, auth: { state: { creds: { registered: false } } } }
  launcher.onSaveError(saveCtx, Object.assign(new Error('falta'), { code: 'ENOENT' }))
  await wait(20)
  assert.ok(issues.filter((i) => i.type === 'session-deleted').length >= 2)
  launcher.onSaveError({ finished: true }, new Error('x'))
  launcher.onSaveError({ finished: false }, new Error('otro'))
  assert.equal(issues.at(-1).type, 'save-error')
  clearInterval(ctx.watcher)
  await launcher.stop()
  await rm(dir, { recursive: true, force: true })
})

test('launcher: errores del socket se clasifican sin mirar el texto', () => {
  const launcher = new Launcher({ session: fakeSession(), watchSession: false })
  const issues = []
  launcher.on('issue', (i) => issues.push(i))
  const ctx = { finished: false }
  launcher.onSockError(ctx, { code: 'ENOTFOUND', hostname: 'h' })
  launcher.onSockError(ctx, { code: 'ECONNRESET', name: 'Error' })
  launcher.onSockError(ctx, { errorCode: 'WEBSOCKET_CLOSED_BEFORE_HANDSHAKE' })
  launcher.onSockError(ctx, { errorCode: 'SENDER_KEY_MISSING' })
  launcher.onSockError(ctx, { errorCode: 'STREAM_ERROR', code: 515, message: 'WhatsApp stream error: {"code":515}' })
  launcher.onSockError(ctx, { errorCode: 'STREAM_ERROR', message: 'WhatsApp stream error: {"code":503}' })
  launcher.onSockError(ctx, { errorCode: 'CONNECTION_REJECTED', code: 403 })
  launcher.onSockError(ctx, { errorCode: 'CONNECTION_REJECTED', message: 'rechazado (405)' })
  launcher.onSockError(ctx, { errorCode: 'CONNECTION_IDLE' })
  launcher.onSockError(ctx, { errorCode: 'KEEPALIVE_FAILED' })
  launcher.onSockError(ctx, { errorCode: 'WEBSOCKET_OPEN_TIMEOUT' })
  launcher.onSockError(ctx, { code: 1006 })
  launcher.onSockError(ctx, Object.assign(new Error('closed'), { kind: 'closed' }))
  launcher.onSockError(ctx, Object.assign(new Error('timeout'), { kind: 'timeout' }))
  launcher.onSockError(ctx, new Error('otro'))
  launcher.onSockError({ finished: true }, new Error('ignorado'))
  const types = issues.map((i) => i.type)
  assert.deepEqual(types, [
    'dns', 'network', 'websocket-handshake', 'stream-error', 'stream-error', 'connection-rejected',
    'connection-rejected', 'idle', 'idle', 'error', 'websocket-handshake', 'error', 'error', 'error'
  ])
  assert.equal(launcher.senderKeyMisses, 1)
  clearTimeout(launcher.senderKeyTimer)
})

test('launcher: señales se registran y se retiran al parar', async () => {
  const child = fakeSock()
  const launcher = new Launcher({
    session: fakeSession(),
    connector: async () => { setImmediate(() => child.emit('open')); return child },
    watchSession: false,
    signals: ['SIGUSR2'],
    exit: false
  })
  await launcher.start()
  assert.equal(launcher.signalHandlers.size, 1)
  const signals = []
  launcher.on('signal', (s) => signals.push(s))
  await launcher.stop()
  assert.equal(launcher.signalHandlers.size, 0)
  assert.equal(signals.length, 0)
  assert.equal(launcher.stopping, true)
  await launcher.stop()
})

test('launcher: valida opciones y conectores', () => {
  assert.throws(() => new Launcher({ setup: 'x' }), /setup must be a function/)
  assert.throws(() => new Launcher({ connector: 'x' }))
  const launcher = new Launcher({ session: fakeSession(), watchSession: false, on: { open: () => {} } })
  assert.equal(launcher.session.state.creds.registered, true)
  assert.equal(createLauncher({ session: fakeSession(), watchSession: false }) instanceof Launcher, true)
  assert.equal(typeof start, 'function')
})
