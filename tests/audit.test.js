import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, truncate, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { Socket } from '../src/socket.js'
import { Transport, WA_HEADER } from '../src/transport.js'
import { useFileAuthState, MAX_SESSION_FILE_BYTES } from '../src/auth.js'
import { memoryAdapter, useAdapterAuthState } from '../src/authstore.js'
import { Curve } from '../src/crypto.js'
import { Noise } from '../src/noise.js'
import { pbDecode, pbEncode } from '../src/pb.js'
import * as senderkey from '../src/senderkey.js'
import appstate from '../src/appstate.js'
import mediaMixin from '../src/media.js'
import { encryptMediaFileFromHandle } from '../src/mediacrypto.js'
import { parseMessage } from '../src/incoming.js'
import { MessageContext } from '../src/context.js'
import { createStore } from '../src/store.js'
import { createBot } from '../src/kit.js'
import { Launcher } from '../src/launcher.js'
import { redirectHeaders } from '../src/util.js'
import * as api from '../src/index.js'

const newSocket = async (options = {}) => new Socket({ auth: await useAdapterAuthState(memoryAdapter()), ...options })

const tempDir = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-audit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------------------
// 1-3. Session integrity
// ---------------------------------------------------------------------------

test('auth: snapshots JSON válidos pero no-sesión fallan y nunca crean credenciales', async (t) => {
  const invalid = [
    '{}',
    '{"creds":null,"keys":{}}',
    '{"creds":{},"keys":[]}',
    '{"version":99,"creds":{},"keys":{}}',
    '{"format":"otro-formato","creds":{},"keys":{}}'
  ]
  for (const body of invalid) {
    const dir = await tempDir(t)
    await writeFile(path.join(dir, 'state.json'), body)
    assert.throws(() => useFileAuthState(dir, { debounceMs: 1 }), { name: 'ZyrixError', errorCode: 'SESSION_CORRUPT' })
    assert.equal(await readFile(path.join(dir, 'state.json'), 'utf8'), body, 'el snapshot inválido no se reescribe')
    await assert.rejects(stat(path.join(dir, 'state.json.bak')), { code: 'ENOENT' })
  }
})

test('auth: un snapshot por encima del límite se rechaza antes de leerlo', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'state.json')
  await writeFile(file, '{}')
  await truncate(file, MAX_SESSION_FILE_BYTES + 1)
  assert.throws(() => useFileAuthState(dir, { debounceMs: 1 }), { errorCode: 'SESSION_TOO_LARGE' })
})

test('auth: el adaptador también rechaza un snapshot semánticamente inválido', async () => {
  await assert.rejects(useAdapterAuthState(memoryAdapter('{"creds":{},"keys":{}}')), { errorCode: 'SESSION_SNAPSHOT_INVALID' })
  await assert.rejects(useAdapterAuthState(memoryAdapter('{"creds":null,"keys":{}}')), { errorCode: 'SESSION_SNAPSHOT_INVALID' })
})

test('auth: si state.json está corrupto, el backup válido se restaura y se puede volver a guardar', async (t) => {
  const dir = await tempDir(t)
  const seed = useFileAuthState(dir, { debounceMs: 1 })
  seed.state.creds.marker = 'desde-backup'
  seed.save()
  await seed.flush()
  await writeFile(path.join(dir, 'state.json.bak'), await readFile(path.join(dir, 'state.json')))
  await writeFile(path.join(dir, 'state.json'), '{}')

  const restored = useFileAuthState(dir, { debounceMs: 1 })
  assert.equal(restored.state.creds.marker, 'desde-backup')
  restored.state.creds.afterRecovery = true
  restored.save()
  await restored.flush()
  assert.equal(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).creds.afterRecovery, true)
})

test('auth: dos instancias de archivo no se sobrescriben en silencio', async (t) => {
  const dir = await tempDir(t)
  const seed = useFileAuthState(dir, { debounceMs: 1 })
  seed.state.creds.seed = 'x'
  seed.save()
  await seed.flush()

  const first = useFileAuthState(dir, { debounceMs: 1 })
  const second = useFileAuthState(dir, { debounceMs: 1 })
  first.state.creds.fromFirst = 'a'
  first.save()
  await first.flush()
  second.state.creds.fromSecond = 'b'
  second.save()
  await assert.rejects(second.flush(), { errorCode: 'SESSION_WRITE_CONFLICT' })

  const disk = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(disk.creds.fromFirst, 'a')
  assert.equal(disk.creds.fromSecond, undefined, 'la escritura en conflicto no se aplicó')
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.lock')), [])
})

test('auth: el adaptador genérico detecta un escritor concurrente con CAS optimista', async () => {
  const adapter = memoryAdapter()
  const first = await useAdapterAuthState(adapter, { debounceMs: 60_000 })
  first.state.creds.seed = 'x'
  first.save()
  await first.flush()

  const second = await useAdapterAuthState(adapter, { debounceMs: 60_000 })
  first.state.creds.fromFirst = 'a'
  first.save()
  await first.flush()
  second.state.creds.fromSecond = 'b'
  second.save()
  await assert.rejects(second.flush(), { errorCode: 'SESSION_WRITE_CONFLICT' })
  assert.equal(JSON.parse(adapter.read()).creds.fromSecond, undefined)
})

// ---------------------------------------------------------------------------
// 4-5. Socket closing and keep-alive
// ---------------------------------------------------------------------------

const stubTransport = () => ({ sent: [], send(payload) { this.sent.push(payload) }, close() {} })
const readySocket = async (options = {}) => {
  const socket = await newSocket(options)
  socket.handshakeDone = true
  socket.noise = { encrypt: (payload) => payload }
  socket.transport = stubTransport()
  return socket
}

test('socket: end() y terminate() rechazan las queries pendientes una sola vez', async () => {
  const socket = await readySocket()
  const pending = socket.query({ tag: 'iq', attrs: { type: 'get' } }, 60_000)
  assert.equal(socket.pending.size, 1)
  socket.end()
  await assert.rejects(pending, { errorCode: 'CONNECTION_CLOSING' })
  assert.equal(socket.pending.size, 0)
  socket.terminate(401)
  assert.equal(socket.pending.size, 0, 'un segundo cierre no deja nada pendiente')
})

test('socket: una respuesta tardía tras el cierre no revive ni borra otra query', async () => {
  const socket = await readySocket()
  const pending = socket.query({ tag: 'iq', attrs: { id: 'late', type: 'get' } }, 60_000)
  socket.end()
  await assert.rejects(pending)
  socket.onNode({ tag: 'iq', attrs: { id: 'late', type: 'result' }, content: [] })
  assert.equal(socket.pending.size, 0)
})

test('socket: ids de query duplicados fallan con un código estable', async () => {
  const socket = await readySocket()
  const first = socket.query({ tag: 'iq', attrs: { id: 'same', type: 'get' } }, 60_000)
  await assert.rejects(socket.query({ tag: 'iq', attrs: { id: 'same', type: 'get' } }, 60_000), { errorCode: 'QUERY_DUPLICATE_ID' })
  socket.end()
  await assert.rejects(first)
})

test('socket: keepAliveIntervalMs=0 desactiva el keep-alive y los valores inválidos se rechazan', async () => {
  const socket = await newSocket({ keepAliveIntervalMs: 0 })
  socket.startKeepAlive()
  assert.equal(socket.keepAlive, null)
  for (const value of [NaN, Infinity, -1]) {
    await assert.rejects(newSocket({ keepAliveIntervalMs: value }), TypeError)
  }
  for (const value of [1.5, 25 * 60 * 60 * 1000]) {
    await assert.rejects(newSocket({ keepAliveIntervalMs: value }), RangeError)
  }
})

test('socket: expone newsletters y communities con IQs reales', async () => {
  const socket = await newSocket()
  assert.equal(typeof socket.newsletters.create, 'function')
  assert.equal(typeof socket.communities.subgroups, 'function')
  let captured
  socket.query = async (node) => {
    captured = node
    return { content: [{ tag: 'newsletter', attrs: { id: '123' }, content: [{ tag: 'name', content: Buffer.from('Canal') }] }] }
  }
  const info = await socket.newsletters.metadata('123@newsletter')
  assert.equal(info.id, '123@newsletter')
  assert.equal(captured.attrs.xmlns, 'newsletter')
  socket.query = async (node) => {
    captured = node
    return { content: [{ tag: 'sub_groups', content: [{ tag: 'group', attrs: { id: '456' } }] }] }
  }
  assert.deepEqual(await socket.communities.subgroups('999@g.us'), ['456@g.us'])
  assert.equal(captured.attrs.xmlns, 'w:g2')
})

// ---------------------------------------------------------------------------
// 6. App-state transactional patches
// ---------------------------------------------------------------------------

const makeAppState = (query) => {
  const keyId = Buffer.from('test-key').toString('base64')
  const state = {
    creds: { myAppStateKeyId: keyId },
    keys: { appStateKeys: { [keyId]: { keyData: Buffer.alloc(32, 3) } }, appStateLTHash: {}, appStateVersions: {} }
  }
  let saves = 0
  const socket = Object.assign(Object.create(null), appstate, {
    auth: { state, save: () => { saves++ } },
    query,
    emit() {}
  })
  const snapshot = () => JSON.stringify(state.keys.appStateLTHash, (key, value) => (Buffer.isBuffer(value) ? value.toString('hex') : value))
  return { socket, state, snapshot, saves: () => saves }
}

const patch = (index) => ({ type: 'regular_low', index: ['mute', index], syncAction: { markChatAsReadAction: { read: true } } })

test('app-state: un query rechazado deja LTHash, índice y versión byte a byte iguales', async () => {
  const { socket, snapshot, state } = makeAppState(async () => { throw new Error('sin red') })
  const before = snapshot()
  await assert.rejects(socket.appStatePatch(patch('a')), /sin red/)
  assert.equal(snapshot(), before)
  assert.equal(state.keys.appStateLTHash.regular_low, undefined)
  assert.equal(state.keys.appStateVersions.regular_low, undefined)
})

test('app-state: dos patches concurrentes producen versiones consecutivas y conservan ambos cambios', async () => {
  const seen = []
  const { socket, state } = makeAppState(async (node) => {
    const sync = node.content[0]
    seen.push(sync.content[0].attrs.version)
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { content: [{ tag: 'sync', content: [{ tag: 'collection', attrs: { name: 'regular_low' } }] }] }
  })
  await Promise.all([socket.appStatePatch(patch('a')), socket.appStatePatch(patch('b'))])
  assert.deepEqual(seen, ['0', '1'])
  assert.equal(state.keys.appStateLTHash.regular_low.version, 2)
  assert.equal(Object.keys(state.keys.appStateLTHash.regular_low.indexValueMap).length, 2)
  assert.equal(state.keys.appStateVersions.regular_low, 2)
})

test('app-state: un rechazo por versión resincroniza la colección y reintenta con el LTHash reconstruido', async () => {
  const sentVersions = []
  let resyncs = 0
  let calls = 0
  const { socket, state } = makeAppState(async (node) => {
    sentVersions.push(node.content[0].content[0].attrs.version)
    if (++calls === 1) {
      const conflict = new Error('query error 409')
      conflict.code = 409
      throw conflict
    }
    return { content: [{ tag: 'sync', content: [{ tag: 'collection', attrs: { name: 'regular_low' } }] }] }
  })
  socket.syncCollection = async (name) => {
    resyncs++
    state.keys.appStateLTHash[name] = { version: 4, hash: Buffer.alloc(128), indexValueMap: {} }
    state.keys.appStateVersions[name] = 4
  }
  const result = await socket.appStatePatch(patch('a'))
  assert.deepEqual(sentVersions, ['0', '4'])
  assert.equal(resyncs, 1)
  assert.equal(result.version.version, 5)
  assert.equal(state.keys.appStateLTHash.regular_low.version, 5)
})

test('app-state: si la resincronización falla, APPSTATE_PATCH_CONFLICT y estado intacto', async () => {
  const { socket, state, snapshot } = makeAppState(async () => {
    const conflict = new Error('version conflict')
    conflict.code = 409
    throw conflict
  })
  socket.syncCollection = async () => { throw new Error('sin red al resincronizar') }
  const before = snapshot()
  await assert.rejects(socket.appStatePatch(patch('a')), { errorCode: 'APPSTATE_PATCH_CONFLICT' })
  assert.equal(snapshot(), before)
  assert.equal(state.keys.appStateLTHash.regular_low, undefined)
})

test('app-state: un timeout no dispara una resincronización ni modifica el estado', async () => {
  let resyncs = 0
  const { socket, snapshot } = makeAppState(async () => {
    const timeout = new Error('query timed out')
    timeout.kind = 'timeout'
    timeout.errorCode = 'TIMEOUT'
    throw timeout
  })
  socket.syncCollection = async () => { resyncs++ }
  const before = snapshot()
  await assert.rejects(socket.appStatePatch(patch('a')), { errorCode: 'TIMEOUT' })
  assert.equal(resyncs, 0)
  assert.equal(snapshot(), before)
})

test('app-state: el límite de páginas has_more_updates no se ignora en silencio', async () => {
  let queries = 0
  const fake = Object.assign(Object.create(null), appstate, {
    auth: { state: { keys: { appStateVersions: {}, appStateLTHash: {} } }, save() {} },
    emit() {},
    query: async () => {
      queries++
      return { content: [{ tag: 'sync', content: [{ tag: 'collection', attrs: { has_more_updates: 'true' } }] }] }
    }
  })
  await assert.rejects(appstate.syncCollection.call(fake, 'regular_low'), { errorCode: 'APPSTATE_PAGINATION_LIMIT' })
  assert.equal(queries, 20)
})

// ---------------------------------------------------------------------------
// 7-8. Media descriptors and URLs
// ---------------------------------------------------------------------------

const fakeHandle = (sizes, chunks) => {
  let calls = 0
  return {
    async stat() {
      const size = sizes[Math.min(calls++, sizes.length - 1)]
      return { isFile: () => true, size, mtimeMs: 1 }
    },
    createReadStream() { return Readable.from(chunks) }
  }
}

test('media: el contador de bytes se aplica durante la lectura y aborta un archivo que crece', async (t) => {
  const dir = await tempDir(t)
  const out = path.join(dir, 'out.enc')
  const handle = fakeHandle([4, 4], [Buffer.alloc(8, 1)])
  await assert.rejects(encryptMediaFileFromHandle(handle, out, 'image', { maxBytes: 4 }), RangeError)
  await assert.rejects(stat(out), { code: 'ENOENT' })
})

test('media: un archivo que cambia de tamaño durante el cifrado aborta con MEDIA_FILE_CHANGED', async (t) => {
  const dir = await tempDir(t)
  const out = path.join(dir, 'changed.enc')
  const handle = fakeHandle([4, 8], [Buffer.alloc(4, 1)])
  await assert.rejects(encryptMediaFileFromHandle(handle, out, 'image', { maxBytes: 8 }), { errorCode: 'MEDIA_FILE_CHANGED' })
})

test('media: uploadMediaFile no sigue symlinks (O_NOFOLLOW)', async (t) => {
  const dir = await tempDir(t)
  const real = path.join(dir, 'real.bin')
  const link = path.join(dir, 'link.bin')
  await writeFile(real, 'datos')
  await symlink(real, link)
  await assert.rejects(mediaMixin.uploadMediaFile.call({ maxFileBytes: 1024 }, link, 'image'), (error) => ['ELOOP', 'EMLINK', 'MEDIA_NOT_A_FILE'].includes(error.code || error.errorCode))
})

test('media: auth y token se codifican con URLSearchParams sin romper la query', async (t) => {
  const auth = 'a+b&c=d#e%f?g/ñ'
  const fake = Object.assign(Object.create(null), mediaMixin, {
    maxMediaBytes: 1024,
    mediaConn: async () => ({ auth, hosts: ['mmg.whatsapp.net'] })
  })
  let captured
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    captured = url
    return new Response(JSON.stringify({ url: 'https://mmg.whatsapp.net/x', direct_path: '/x' }), { status: 200 })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  await mediaMixin.uploadMedia.call(fake, Buffer.from('hola'), 'image')
  const url = new URL(captured)
  assert.equal(url.searchParams.get('auth'), auth)
  assert.equal(url.searchParams.get('token'), url.pathname.split('/').pop())
  assert.equal(url.search.split('&').length, 2, 'solo hay dos parámetros de query')
})

test('redirects: solo headers seguros cruzan a otro origen', () => {
  const headers = {
    'user-agent': 'ua',
    accept: '*/*',
    authorization: 'Bearer secret',
    cookie: 'sid=1',
    'proxy-authorization': 'x',
    host: 'evil.example',
    'x-api-key': 'secret'
  }
  assert.deepEqual(redirectHeaders(headers, true), headers)
  assert.deepEqual(redirectHeaders(headers, false), { 'user-agent': 'ua', accept: '*/*' })
})

// ---------------------------------------------------------------------------
// 9, 11. Sender keys and protobuf
// ---------------------------------------------------------------------------

test('senderkey: padding CBC inválido con firma válida no modifica el estado y el siguiente mensaje funciona', () => {
  const sender = { creds: null, keys: { senderKeys: {} } }
  const receiver = { creds: null, keys: { senderKeys: {} } }
  const group = '120363000000000009@g.us'
  const address = '5491100000009.0'
  const own = senderkey.ensureOwn(sender, group, address)
  senderkey.processDistribution(receiver, group, address, senderkey.distribution(own))

  const valid = senderkey.encrypt(sender, group, address, Buffer.from('primero'))
  assert.equal(senderkey.decrypt(receiver, group, address, valid).toString(), 'primero')

  const snapshot = () => {
    const rec = receiver.keys.senderKeys[`${group}::${address}`]
    return { iteration: rec.iteration, chain: Buffer.from(rec.chain).toString('hex'), skipped: JSON.stringify(rec.skipped) }
  }
  const before = snapshot()
  const badCiphertext = Buffer.alloc(16, 7)
  const signed = Buffer.concat([Buffer.from([0x33]), senderkey.pbEncode([[1, own.keyId], [2, 1], [3, badCiphertext]])])
  const forged = Buffer.concat([signed, Curve.sign(own.signingPrivate, signed)])
  assert.throws(() => senderkey.decrypt(receiver, group, address, forged))
  assert.deepEqual(snapshot(), before, 'iteration, chain y skipped no cambiaron')

  const next = senderkey.encrypt(sender, group, address, Buffer.from('después'))
  assert.equal(senderkey.decrypt(receiver, group, address, next).toString(), 'después')
})

test('protobuf: field 0, duplicados, varints no canónicos, campos fuera de rango y tamaño se rechazan', () => {
  assert.throws(() => pbDecode(Buffer.from([0x00])), { errorCode: 'PROTOBUF_MALFORMED' })
  assert.throws(() => pbDecode(Buffer.from([0x08, 0x01, 0x08, 0x02])), { errorCode: 'PROTOBUF_MALFORMED' })
  assert.throws(() => pbDecode(Buffer.from([0x08, 0x80, 0x00])), { errorCode: 'PROTOBUF_MALFORMED' })
  assert.throws(() => pbDecode(Buffer.alloc(1024 * 1024 + 1, 1)), { errorCode: 'PROTOBUF_MALFORMED' })
  const hugeField = Buffer.concat([Buffer.from([0x80, 0x80, 0x80, 0x80, 0x20]), Buffer.from([0x00])])
  assert.throws(() => pbDecode(hugeField), { errorCode: 'PROTOBUF_MALFORMED' })
  assert.throws(() => pbEncode([[0, Buffer.alloc(1)]]), RangeError)
  const roundTrip = pbDecode(pbEncode([[1, 300], [2, Buffer.from('ok')]]))
  assert.equal(roundTrip[1], 300)
  assert.equal(roundTrip[2].toString(), 'ok')
})

test('noise: el contador agotado da SIGNAL_COUNTER_OVERFLOW en vez de RangeError', async () => {
  const noise = new Noise(Curve.generateKeyPair())
  await noise.finish()
  noise.writeCounter = 0xffffffff
  assert.throws(() => noise.encrypt(Buffer.from('x')), { errorCode: 'SIGNAL_COUNTER_OVERFLOW' })
})

// ---------------------------------------------------------------------------
// 13-14. Interactive messages and ask()
// ---------------------------------------------------------------------------

const incoming = (message) => parseMessage({ key: { id: 'm1', remoteJid: '1@s.whatsapp.net', fromMe: false }, message })

test('parseMessage: extrae buttonId de botones, listas, plantillas y native flow', () => {
  const button = incoming({ buttonsResponseMessage: { selectedButtonId: 'btn-1', selectedDisplayText: 'Sí' } })
  assert.equal(button.type, 'buttonResponse')
  assert.equal(button.buttonId, 'btn-1')
  assert.equal(button.text, 'Sí')

  const list = incoming({ listResponseMessage: { title: 'Opciones', singleSelectReply: { selectedRowId: 'row-9' } } })
  assert.equal(list.type, 'listResponse')
  assert.equal(list.buttonId, 'row-9')
  assert.equal(list.text, 'Opciones')

  const template = incoming({ templateButtonReplyMessage: { selectedId: 'tpl-3', selectedDisplayText: 'Tres' } })
  assert.equal(template.type, 'templateReply')
  assert.equal(template.buttonId, 'tpl-3')
  assert.equal(template.text, 'Tres')

  const native = incoming({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"nf-1"}' } } })
  assert.equal(native.type, 'interactiveResponse')
  assert.equal(native.buttonId, 'nf-1')
})

test('ask(): registra el listener antes de enviar y una respuesta durante reply() no se pierde', async () => {
  let registered = false
  let resolveWait
  const sock = {
    waitForMessage(filter, timeout, opts) {
      registered = true
      sock.filter = filter
      sock.signal = opts.signal
      return new Promise((resolve) => { resolveWait = resolve })
    }
  }
  const ctx = new MessageContext(sock, { key: {} }, { chat: '1@s.whatsapp.net', sender: '1@s.whatsapp.net' })
  ctx.reply = async () => {
    assert.equal(registered, true)
    resolveWait({ chat: '1@s.whatsapp.net', sender: '1@s.whatsapp.net' })
  }
  const answer = await ctx.ask('hola')
  assert.equal(answer.sender, '1@s.whatsapp.net')
  assert.equal(sock.filter({ chat: '1@s.whatsapp.net', sender: '1@s.whatsapp.net' }), true)
  assert.equal(sock.filter({ chat: '2@s.whatsapp.net', sender: '1@s.whatsapp.net' }), false)
})

test('ask(): si reply() falla, cancela el listener y el timer', async () => {
  let signal
  const sock = { waitForMessage(filter, timeout, opts) { signal = opts.signal; return new Promise(() => {}) } }
  const ctx = new MessageContext(sock, { key: {} }, { chat: '1@s.whatsapp.net', sender: '1@s.whatsapp.net' })
  ctx.reply = async () => { throw new Error('send failed') }
  await assert.rejects(ctx.ask('hola'), /send failed/)
  assert.equal(signal.aborted, true)
})

// ---------------------------------------------------------------------------
// 18. Transport contract
// ---------------------------------------------------------------------------

test('transport: frames parciales y múltiples frames se reensamblan', () => {
  const transport = new Transport()
  transport.used = true
  const frames = []
  transport.on('frame', (frame) => frames.push(Buffer.from(frame).toString()))
  const header = (length) => Buffer.from([length >> 16, (length >> 8) & 255, length & 255])
  const one = Buffer.concat([header(3), Buffer.from('abc')])
  const two = Buffer.concat([header(2), Buffer.from('de'), one])
  transport.onData(two.subarray(0, 2))
  assert.deepEqual(frames, [])
  transport.onData(two.subarray(2, 6))
  assert.deepEqual(frames, ['de'])
  transport.onData(two.subarray(6))
  assert.deepEqual(frames, ['de', 'abc'])
})

test('transport: WA_HEADER se envía una sola vez y el transporte no se reutiliza', () => {
  const transport = new Transport()
  transport.used = true
  const sent = []
  transport.ws = { readyState: 1, send: (payload) => sent.push(Buffer.from(payload)) }
  transport.send(Buffer.from('abc'))
  transport.send(Buffer.from('de'))
  assert.deepEqual([...sent[0].subarray(0, 4)], [...WA_HEADER])
  assert.equal(sent[0].length, 4 + 3 + 3)
  assert.equal(sent[1].length, 3 + 2)
  assert.throws(() => new Transport().onData(Buffer.from([0, 0, 0])), { errorCode: 'TRANSPORT_NOT_CONNECTED' })
  const fresh = new Transport()
  fresh.used = true
  assert.throws(() => fresh.connect(), { errorCode: 'TRANSPORT_REUSED' })
})

// ---------------------------------------------------------------------------
// 20-24. Launcher, store and kit
// ---------------------------------------------------------------------------

test('launcher: stop() desregistra los handlers de señal vigentes', async () => {
  const signal = 'SIGUSR2'
  const before = process.listenerCount(signal)
  const launcher = new Launcher({ session: '/nonexistent', watchSession: false, signals: [signal] })
  launcher.hookSignals()
  assert.equal(process.listenerCount(signal), before + 1)
  await launcher.stop()
  assert.equal(process.listenerCount(signal), before)
})

test('store: 20 escrituras concurrentes dejan JSON válido y ningún temporal', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'store.json')
  const socket = new EventEmitter()
  const store = createStore(socket, { maxMessagesPerChat: 2, maxChats: 2, maxContacts: 2 })
  const writes = []
  for (let i = 0; i < 20; i++) {
    socket.emit('chats.update', { id: `c${i}` })
    writes.push(store.writeToFile(file))
  }
  await Promise.all(writes)
  const data = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(data.version, 1)
  assert.equal(data.chats.length, 2)
  assert.deepEqual(data.chats.map((chat) => chat.id).sort(), ['c18', 'c19'])
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.tmp')), [])
})

test('store: fromJSON no evade los límites y valida tipos', () => {
  const socket = new EventEmitter()
  const store = createStore(socket, { maxMessagesPerChat: 1, maxChats: 2, maxContacts: 2 })
  const event = (id) => ({ key: { id, remoteJid: 'a@s.whatsapp.net', fromMe: false }, message: { conversation: id } })
  store.fromJSON({
    version: 1,
    messages: [['a@s.whatsapp.net', [event('1'), event('2')]]],
    chats: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
    contacts: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }],
    groups: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }]
  })
  assert.equal(store.getMessages('a@s.whatsapp.net').length, 1)
  assert.equal(store.getChats().length, 2)
  assert.equal(store.getContacts().length, 2)
  assert.equal(store.getGroups().length, 2)
  assert.throws(() => store.fromJSON({ version: 2 }), TypeError)
  assert.throws(() => store.fromJSON({ messages: 'nope' }), TypeError)
  assert.throws(() => store.fromJSON({ messages: [['a@s.whatsapp.net', [{ key: {} }]]] }), TypeError)
})

test('kit: reemplazar un comando elimina los aliases de la definición anterior', () => {
  const sock = new EventEmitter()
  const bot = createBot(sock, { prefix: '.', owners: [] })
  bot.command(['a', 'b'], () => {})
  bot.command(['a', 'c'], () => {})
  assert.equal(bot.names.has('b'), false)
  assert.equal(bot.names.has('c'), true)
  assert.equal(bot.names.get('c').id, 'a')
  bot.stop()
})

test('kit: el cooldown se reserva atómicamente y los JIDs se normalizan', async () => {
  const sock = new EventEmitter()
  const bot = createBot(sock, { prefix: '.', owners: [] })
  bot.command({ names: ['limited'], cooldown: 60, run() {} })
  const entry = bot.commands.get('limited')
  const m = { sender: '54911:7@s.whatsapp.net', isGroup: false }
  const results = await Promise.all([bot.check(entry, m), bot.check(entry, m)])
  assert.equal(results.filter((result) => result && result.reason === 'cooldown').length, 1)
  assert.equal(bot.cooldowns.has('54911|limited'), true)
  bot.stop()
})

// ---------------------------------------------------------------------------
// 27. Runtime/types contract
// ---------------------------------------------------------------------------

test('runtime: los exports raíz y los builders de contenido existen', () => {
  for (const name of ['Socket', 'useFileAuthState', 'useAdapterAuthState', 'createStore', 'createClient', 'attachMessageDelivery', 'createMessage', 'createMessageContent', 'parseMessage', 'connect', 'makeSocket']) {
    assert.equal(typeof api[name], 'function', `${name} missing`)
  }
  for (const name of ['text', 'buttons', 'interactive', 'list', 'poll', 'location', 'contact', 'reaction', 'stickerPack', 'extractInteractiveId']) {
    assert.equal(typeof api.content[name], 'function', `content.${name} missing`)
  }
})
