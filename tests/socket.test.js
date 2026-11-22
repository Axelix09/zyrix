import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { proto } from '../src/proto.js'
import { Socket } from '../src/socket.js'
import { Curve } from '../src/crypto.js'
import { makeAuth, makeState } from './helpers/state.js'

const makeSocket = (options = {}) => {
  const state = options.state ?? makeState()
  const auth = options.auth ?? makeAuth(state)
  const sock = new Socket({ auth, printQR: false, reconnect: false, keepAliveIntervalMs: 0, ...options.socket })
  sock.version = [2, 3000, 1043857760]
  sock.handshakeDone = true
  sock.transport = { send() {}, close() {} }
  sock.noise = {}
  return sock
}

test('socket: valida auth, versión, límites y opciones numéricas', () => {
  assert.throws(() => new Socket(), TypeError)
  assert.throws(() => new Socket({ auth: { state: {} } }), TypeError)
  const auth = makeAuth()
  assert.throws(() => new Socket({ auth, version: [1, 2] }), TypeError)
  assert.throws(() => new Socket({ auth, version: [1, 2, -1] }), TypeError)
  assert.throws(() => new Socket({ auth, maxMediaBytes: 0 }), TypeError)
  assert.throws(() => new Socket({ auth, maxFileBytes: 1.5 }), TypeError)
  assert.throws(() => new Socket({ auth, browser: ['Ubuntu'] }), TypeError)
  assert.throws(() => new Socket({ auth, getMessage: 1 }), TypeError)
  assert.throws(() => new Socket({ auth, trustPolicy: 'nope' }), TypeError)
  assert.throws(() => new Socket({ auth, minSendIntervalMs: -1 }), TypeError)
  assert.throws(() => new Socket({ auth, keepAliveIntervalMs: -1 }), TypeError)
  assert.throws(() => new Socket({ auth, keepAliveIntervalMs: 1.5 }), RangeError)
  assert.throws(() => new Socket({ auth, keepAliveIntervalMs: 25 * 60 * 60 * 1000 }), RangeError)
  assert.throws(() => new Socket({ auth, queryTimeoutMs: 0 }), TypeError)
})

test('socket: getters, setConnection, flushAuth y rejectPending idempotente', async () => {
  const sock = makeSocket()
  assert.equal(sock.ev, sock)
  assert.equal(sock.user.name, 'Yo')
  assert.equal(sock.authState, sock.auth)
  assert.equal(sock.isOpen, false)
  const patches = []
  sock.on('connection.update', (p) => patches.push(p))
  sock.setConnection({ connection: 'open' })
  assert.equal(sock.isOpen, true)
  assert.deepEqual(patches, [{ connection: 'open' }])

  const rejected = []
  sock.pending.set('a', { reject: (e) => rejected.push(e), timer: setTimeout(() => {}, 1000) })
  sock.pending.set('b', { reject: (e) => rejected.push(e), timer: setTimeout(() => {}, 1000) })
  sock.rejectPending()
  sock.rejectPending()
  assert.equal(rejected.length, 2)
  assert.equal(sock.pending.size, 0)

  const failing = makeSocket({ auth: { ...makeAuth(), flush: async () => { throw new Error('flush roto') } } })
  const errors = []
  failing.on('error', (e) => errors.push(e))
  await failing.flushAuth()
  assert.equal(errors[0].message, 'flush roto')
})

test('socket: waitForOpen resuelve al abrir, rechaza al cerrar y por timeout', async () => {
  const sock = makeSocket()
  const waiting = sock.waitForOpen(1000)
  sock.emit('open')
  assert.equal(await waiting, sock)

  const closing = sock.waitForOpen(1000)
  sock.emit('close', { reconnecting: false })
  await assert.rejects(closing, /closed/i)

  const reconnecting = sock.waitForOpen(1000)
  sock.emit('close', { reconnecting: true })
  let settled = false
  reconnecting.then(() => { settled = true }, () => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(settled, false)
  await assert.rejects(sock.waitForOpen(5), { kind: 'timeout' })
})

test('socket: run serializa y enqueue reporta el error', async () => {
  const sock = makeSocket()
  const order = []
  await Promise.all([
    sock.run(async () => { await new Promise((r) => setTimeout(r, 10)); order.push(1) }),
    sock.run(async () => order.push(2))
  ])
  assert.deepEqual(order, [1, 2])
  const errors = []
  sock.on('error', (e) => errors.push(e))
  sock.enqueue(async () => { throw new Error('enqueue') })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(errors[0].message, 'enqueue')
})

test('socket: sendHello, sendUnifiedSession y buildPayload registrado/emparejado/android', () => {
  const sock = makeSocket()
  sock.version = [2, 3000, 1043857760]
  const sent = []
  sock.transport = { send: (b) => sent.push(b), close() {} }
  sock.noise = { ephemeral: Curve.generateKeyPair(), encrypt: (b) => b }
  sock.sendHello()
  assert.deepEqual(Buffer.from(proto.HandshakeMessage.decode(sent[0]).clientHello.ephemeral), Buffer.from(sock.noise.ephemeral.public))

  sock.handshakeDone = false
  sock.sendUnifiedSession()
  assert.equal(sent.length, 1)
  sock.handshakeDone = true
  sock.sendUnifiedSession()
  assert.equal(sent.length, 2)

  const registered = sock.buildPayload()
  assert.equal(registered.username, 5491100000001)
  assert.equal(registered.device, 3)
  assert.equal(registered.passive, true)

  const fresh = makeSocket()
  fresh.auth.state.creds.registered = false
  fresh.auth.state.creds.me = null
  const payload = fresh.buildPayload()
  assert.equal(payload.passive, false)
  assert.ok(payload.devicePairingData.deviceProps.length > 0)

  const android = makeSocket({ socket: { browser: ['Android', 'Android', '2.24.1'] } })
  const androidPayload = android.buildPayload()
  assert.equal(androidPayload.webInfo, undefined)
  assert.equal(androidPayload.passive, true)
})

test('socket: finishHandshake envía clientFinish y marca el handshake', async () => {
  const sock = makeSocket()
  sock.handshakeDone = false
  sock.version = [2, 3000, 1043857760]
  const sent = []
  sock.transport = { send: (b) => sent.push(b), close() {} }
  sock.noise = {
    processServerHello: () => Buffer.alloc(32, 1),
    encrypt: () => Buffer.alloc(16, 2),
    finish: async () => {}
  }
  const frame = Buffer.from(proto.HandshakeMessage.encode({ serverHello: { ephemeral: Buffer.alloc(32) } }).finish())
  let handshake = 0
  sock.on('handshake', () => handshake++)
  await sock.finishHandshake(frame)
  assert.equal(sock.handshakeDone, true)
  assert.equal(handshake, 1)
  assert.equal(sent.length, 1)
  const decoded = proto.HandshakeMessage.decode(sent[0])
  assert.equal(decoded.clientFinish.static.length, 32)
})

test('socket: onFrame desencripta y rutea; un frame inválido cierra el transporte', () => {
  const sock = makeSocket()
  let closed = 0
  sock.transport = { send() {}, close: () => closed++ }
  const updates = []
  sock.on('presence.update', (p) => updates.push(p))
  const node = { tag: 'chatstate', attrs: { from: '54911@s.whatsapp.net' }, content: [{ tag: 'composing', attrs: {} }] }
  sock.noise = { decrypt: () => Buffer.from([1]) }
  // encodeNode real para que decodeNode produzca el nodo
  return import('../src/binary.js').then(({ encodeNode }) => {
    sock.noise = { decrypt: () => encodeNode(node) }
    sock.onFrame(Buffer.alloc(1))
    assert.equal(updates.length, 1)
    sock.noise = { decrypt: () => { throw new Error('bad frame') } }
    const errors = []
    sock.on('error', (e) => errors.push(e))
    sock.onFrame(Buffer.alloc(1))
    assert.equal(errors[0].message, 'bad frame')
    assert.equal(closed, 1)
  })
})

test('socket: query resuelve, expira, rechaza ids duplicados y falla si no hay sesión', async () => {
  const sock = makeSocket()
  const sent = []
  sock.transport = { send: (b) => sent.push(b), close() {} }
  sock.noise = { encrypt: (b) => b }
  const promise = sock.query({ tag: 'iq', attrs: {} }, 1000)
  const node = { tag: 'iq', attrs: { id: sock.pending.keys().next().value, type: 'result' } }
  sock.onNode(node)
  assert.equal((await promise).tag, 'iq')

  await assert.rejects(sock.query({ tag: 'iq', attrs: {} }, 0), TypeError)
  await assert.rejects(sock.query({ tag: 'iq', attrs: {} }, 5), /timed out/i)

  const query = { tag: 'iq', attrs: { id: 'dup' } }
  sock.query(query, 1000).catch(() => {})
  await assert.rejects(sock.query({ tag: 'iq', attrs: { id: 'dup' } }, 1000), { errorCode: 'QUERY_DUPLICATE_ID' })
  sock.rejectPending()

  const notReady = makeSocket()
  notReady.handshakeDone = false
  await assert.rejects(notReady.query({ tag: 'iq', attrs: {} }, 1000), /not ready yet/i)
})

test('socket: onNode cubre receipts, notifications, calls, ib, presence y chatstate', () => {
  const sock = makeSocket()
  const sent = []
  sock.transport = { send: (b) => sent.push(b), close() {} }
  sock.noise = { encrypt: (b) => b }
  const events = []
  for (const name of ['receipt', 'presence.update', 'call']) sock.on(name, (e) => events.push([name, e]))

  sock.onNode({ tag: 'receipt', attrs: { id: '1', from: 'a', type: 'read' } })
  sock.onNode({ tag: 'call', attrs: { from: 'a' }, content: [{ tag: 'offer', attrs: { 'call-id': 'c1', 'call-creator': 'a', type: 'group', 'group-jid': 'g@g.us' }, content: [{ tag: 'video', attrs: {} }] }] })
  sock.onNode({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_preview', attrs: {} }, { tag: 'dirty', attrs: { type: 'groups', timestamp: '1' } }] })
  sock.onNode({ tag: 'presence', attrs: { from: 'a', type: 'available', last: '10' } })
  sock.onNode({ tag: 'chatstate', attrs: { from: 'a', participant: 'p' }, content: [{ tag: 'composing', attrs: { media: 'audio' } }] })
  sock.onNode({ tag: 'presence', attrs: { type: 'subscribe' } })
  sock.onNode({ tag: 'unknown', attrs: {} })
  assert.equal(events.filter(([n]) => n === 'receipt').length, 1)
  assert.equal(events.find(([n]) => n === 'call')[1].status, 'offer')
  assert.equal(events.filter(([n]) => n === 'presence.update').length, 2)
  assert.ok(sent.length >= 3)
})

test('socket: onNotification rutea server_sync, grupos, devices y encrypt', () => {
  const sock = makeSocket()
  const sent = []
  sock.transport = { send: (b) => sent.push(b), close() {} }
  sock.noise = { encrypt: (b) => b }
  let synced = null
  sock.syncAppState = async (names) => { synced = names }
  sock.onNotification({ tag: 'notification', attrs: { type: 'server_sync' }, content: [{ tag: 'collection', attrs: { name: 'regular' } }] })
  assert.deepEqual(synced, ['regular'])
  sock.onNotification({ tag: 'notification', attrs: { type: 'server_sync' } })
  assert.equal(synced, undefined)

  const groupUpdates = []
  sock.on('group-participants.update', (u) => groupUpdates.push(u))
  sock.onGroupNotification({
    tag: 'notification', attrs: { type: 'w:gp2', from: 'g@g.us', participant: 'a', t: '10' },
    content: [
      { tag: 'add', attrs: {}, content: [{ tag: 'participant', attrs: { jid: '54911@s.whatsapp.net', type: 'admin' } }] },
      { tag: 'leave', attrs: {}, content: [{ tag: 'participant', attrs: { jid: '54912@s.whatsapp.net' } }] }
    ]
  })
  assert.equal(groupUpdates.length, 2)
  sock.onGroupNotification({ tag: 'notification', attrs: { from: 'no-group' }, content: [] })

  sock.deviceCache.set('54911@s.whatsapp.net', ['x'])
  sock.onDevicesNotification({ tag: 'notification', attrs: { from: '54911:2@s.whatsapp.net' } })
  assert.equal(sock.deviceCache.get('54911@s.whatsapp.net'), undefined)

  const errors = []
  sock.on('error', (e) => errors.push(e))
  sock.onEncryptNotification({ tag: 'notification', attrs: { from: '54911@s.whatsapp.net' }, content: [{ tag: 'identity', attrs: {} }] })
  assert.equal(errors.length, 0)
  sock.onEncryptNotification({ tag: 'notification', attrs: { from: '54911@s.whatsapp.net' }, content: [] })
})

test('socket: onIq responde ping, pair-device QR y pair-success inválido', () => {
  const sock = makeSocket()
  const sent = []
  sock.transport = { send: (b) => sent.push(b), close() {} }
  sock.noise = { encrypt: (b) => b }
  sock.onIq({ tag: 'iq', attrs: { id: '1', xmlns: 'urn:xmpp:ping' } })
  assert.equal(sent.length, 1)

  const qrs = []
  sock.on('qr', (qr) => qrs.push(qr))
  sock.onIq({ tag: 'iq', attrs: { id: '2' }, content: [{ tag: 'pair-device', attrs: {}, content: [{ tag: 'ref', attrs: {}, content: Buffer.from('ref1') }] }] })
  assert.equal(qrs.length, 1)
  clearTimeout(sock.qrTimer)

  const errors = []
  sock.on('error', (e) => errors.push(e))
  sock.onIq({ tag: 'iq', attrs: { id: '3' }, content: [{ tag: 'pair-success', attrs: {}, content: [] }] })
  assert.equal(errors.length, 1)
})

test('socket: onPairDevice pide pairing code cuando hay teléfono y falla sin listener', async () => {
  const sock = makeSocket({ socket: { phoneNumber: '5491100000001' } })
  sock.pairingMode = false
  sock.auth.state.creds.registered = false
  const sent = []
  sock.transport = { send: (b) => sent.push(b), close() {} }
  sock.noise = { encrypt: (b) => b }
  sock.requestPairingCode = async () => { throw new Error('sin red') }
  const errors = []
  sock.on('error', (e) => errors.push(e))
  sock.onPairDevice({ tag: 'iq', attrs: { id: '1' }, content: [{ tag: 'pair-device', attrs: {}, content: [] }] })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(errors[0].message, 'sin red')
  assert.equal(sock.pairingReady, true)
})

test('socket: runQR emite QR y cierra cuando se agotan las referencias', () => {
  const sock = makeSocket()
  const sent = []
  sock.transport = { send: (b) => sent.push(b), close() {} }
  sock.noise = { encrypt: (b) => b }
  sock.transport.close = () => { sock.closed = true }
  const qrs = []
  sock.on('qr', (q) => qrs.push(q))
  sock.runQR(['ref1'], true)
  assert.equal(qrs.length, 1)
  clearTimeout(sock.qrTimer)
  sock.runQR([], false)
  assert.equal(sock.closed, true)
  assert.equal(sock.closing, true)
})

test('socket: onPairSuccess rechaza un HMAC de emparejamiento inválido', () => {
  const sock = makeSocket()
  const sent = []
  sock.transport = { send: (b) => sent.push(b), close() {} }
  sock.noise = { encrypt: (b) => b }
  sock.auth.state.creds.advSecretKey = crypto.randomBytes(32).toString('base64')
  const hmac = proto.ADVSignedDeviceIdentityHMAC.encode({ details: Buffer.from('detalle'), hmac: Buffer.alloc(32) }).finish()
  assert.throws(() => sock.onPairSuccess({
    tag: 'iq', attrs: { id: '1' },
    content: [{ tag: 'pair-success', attrs: {}, content: [{ tag: 'device-identity', attrs: {}, content: hmac }] }]
  }), { errorCode: 'PAIRING_HMAC_INVALID' })
})

test('socket: uploadPreKeys y ensurePreKeys suben claves solo si faltan', async () => {
  const sock = makeSocket()
  const queries = []
  sock.query = async (node) => {
    queries.push(node)
    if (node.content?.[0]?.tag === 'count') return { tag: 'iq', content: [{ tag: 'count', attrs: { value: '2' } }] }
    return { tag: 'iq', attrs: { type: 'result' } }
  }
  const before = sock.auth.state.creds.nextPreKeyId
  await sock.uploadPreKeys(3)
  assert.equal(sock.auth.state.creds.nextPreKeyId, before + 3)
  assert.equal(Object.keys(sock.auth.state.keys.preKeys).length >= 3, true)
  await sock.ensurePreKeys()
  assert.equal(queries.length, 3)
  assert.equal(queries[1].content[0].tag, 'count')
  assert.equal(queries[2].content.some((n) => n.tag === 'list'), true)

  const plenty = makeSocket()
  plenty.query = async () => ({ tag: 'iq', content: [{ tag: 'count', attrs: { value: '50' } }] })
  await plenty.ensurePreKeys()
  assert.equal(plenty.preKeyJob, null)
})

test('socket: onSuccess marca abierto, asegura prekeys y activa la sesión', async () => {
  const sock = makeSocket()
  sock.auth.state.creds.me = { id: '5491100000001:3@s.whatsapp.net', name: 'Yo' }
  const sent = []
  sock.transport = { send: (b) => sent.push(b), close() {} }
  sock.noise = { encrypt: (b) => b }
  sock.ensurePreKeys = async () => {}
  sock.syncAppState = async () => {}
  sock.startKeepAlive = () => { sock.keepAliveStarted = true }
  const opened = []
  sock.on('open', () => opened.push(1))
  await sock.onSuccess({ tag: 'success', attrs: { lid: '999@lid' } })
  assert.equal(sock.auth.state.creds.me.lid, '999@lid')
  assert.equal(opened.length, 1)
  assert.equal(sock.keepAliveStarted, true)
  assert.equal(sock.isOpen, true)
  assert.ok(sent.length >= 3)

  const failing = makeSocket()
  failing.transport = { send() {}, close() {} }
  failing.noise = { encrypt: (b) => b }
  failing.ensurePreKeys = async () => { throw new Error('prekeys') }
  const errors = []
  failing.on('error', (e) => errors.push(e))
  failing.syncAppState = async () => {}
  failing.startKeepAlive = () => {}
  await failing.onSuccess({ tag: 'success', attrs: {} })
  assert.equal(errors[0].message, 'prekeys')
})

test('socket: onFailure y onStreamError distinguen terminal, restart y rechazo', () => {
  const make = () => {
    const sock = makeSocket()
    sock.transport = { send() {}, close: () => { sock.closed = (sock.closed || 0) + 1 } }
    sock.noise = { encrypt: (b) => b }
    return sock
  }
  const errors = []
  const terminal = make()
  terminal.on('close', (info) => errors.push(info.reason))
  terminal.onFailure({ tag: 'failure', attrs: { reason: '401' } })
  assert.equal(terminal.closing, true)

  const restart = make()
  restart.restartingAfterPair = true
  restart.onFailure({ tag: 'failure', attrs: { reason: '500' } })
  assert.equal(restart.fastReconnect, true)
  assert.equal(restart.closed, 1)

  const transient = make()
  const seen = []
  transient.on('error', (e) => seen.push(e))
  transient.onFailure({ tag: 'failure', attrs: { reason: '515' } })
  assert.equal(seen[0].errorCode, 'CONNECTION_REJECTED')

  const stream = make()
  const streamErrors = []
  stream.on('error', (e) => streamErrors.push(e))
  stream.onStreamError({ tag: 'stream:error', attrs: { code: '500' }, content: [{ tag: 'conflict', attrs: { type: 'device_removed' } }] })
  assert.equal(stream.closing, true)

  const streamRestart = make()
  streamRestart.onStreamError({ tag: 'stream:error', attrs: { code: '515' } })
  assert.equal(streamRestart.fastReconnect, true)
  assert.equal(streamRestart.closed, 1)

  const streamTransient = make()
  const transientErrors = []
  streamTransient.on('error', (e) => transientErrors.push(e))
  streamTransient.onStreamError({ tag: 'stream:error', attrs: { code: '503' } })
  assert.equal(transientErrors[0].errorCode, 'STREAM_ERROR')
})

test('socket: onClose programa reconexión o cierra definitivamente', async () => {
  const sock = makeSocket({ socket: { reconnect: true, maxReconnectAttempts: 1 } })
  sock.transport = { send() {}, close() {} }
  sock.noise = { encrypt: (b) => b }
  const closes = []
  sock.on('close', (info) => closes.push(info))
  sock.run = (fn) => fn()
  sock.connect = () => { sock.reconnected = true }
  sock.onClose(1006)
  assert.equal(closes[0].reconnecting, true)
  clearTimeout(sock.reconnectTimer)

  const stopped = makeSocket()
  stopped.closing = true
  stopped.onClose(1006)
  assert.equal(stopped.pending.size, 0)

  const exhausted = makeSocket({ socket: { reconnect: false } })
  exhausted.transport = { send() {}, close() {} }
  const infos = []
  exhausted.on('close', (info) => infos.push(info))
  exhausted.onClose(428)
  assert.equal(infos[0].reconnecting, false)
  assert.equal(exhausted.closing, true)
})

test('socket: terminate, logout y end dejan el socket cerrado y las queries rechazadas', async () => {
  const sock = makeSocket()
  sock.transport = { send() {}, close: () => { sock.closed = true } }
  sock.noise = { encrypt: (b) => b }
  const closes = []
  sock.on('close', (info) => closes.push(info))
  sock.pending.set('x', { reject() {}, timer: setTimeout(() => {}, 1000) })
  sock.terminate(401)
  assert.equal(sock.closed, true)
  assert.equal(closes[0].loggedOut, true)

  const loggingOut = makeSocket()
  loggingOut.transport = { send() {}, close() {} }
  loggingOut.noise = { encrypt: (b) => b }
  loggingOut.handshakeDone = true
  loggingOut.query = async () => ({ tag: 'iq' })
  loggingOut.terminate = () => { loggingOut.terminated = true }
  await loggingOut.logout()
  assert.equal(loggingOut.terminated, true)

  const ending = makeSocket()
  ending.transport = { send() {}, close: () => { ending.closed = true } }
  ending.handshakeDone = false
  await ending.end()
  assert.equal(ending.closed, true)
  assert.equal(ending.closing, true)
})

test('socket: sendPresence valida el estado y delega en sendPresenceUpdate', () => {
  const sock = makeSocket()
  assert.throws(() => sock.sendPresence('a', 'nope'), TypeError)
  let called
  sock.sendPresenceUpdate = (state, to) => { called = [state, to] }
  sock.sendPresence('a', 'composing')
  assert.deepEqual(called, ['composing', 'a'])
})

