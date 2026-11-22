import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Socket } from '../src/socket.js'
import { useFileAuthState, initCreds } from '../src/auth.js'
import { memoryAdapter, useAdapterAuthState } from '../src/authstore.js'
import { ZyrixError, ErrorCode } from '../src/errors.js'
import { DEFAULT_MESSAGES, MESSAGES_ES, mergeMessages } from '../src/locale.js'
import { Launcher } from '../src/launcher.js'

const newSocket = async (options = {}) => new Socket({ auth: await useAdapterAuthState(memoryAdapter()), ...options })

test('socket: sin listener ni logger, los errores salen como process warning (una vez por minuto)', async (t) => {
  const socket = await newSocket()
  const warnings = []
  const onWarning = (w) => warnings.push(w)
  process.on('warning', onWarning)
  t.after(() => process.off('warning', onWarning))
  socket.emit('error', new ZyrixError('se cortó', { errorCode: ErrorCode.KEEPALIVE_FAILED }))
  socket.emit('error', new ZyrixError('se cortó', { errorCode: ErrorCode.KEEPALIVE_FAILED }))
  await new Promise((resolve) => setImmediate(resolve))
  const ours = warnings.filter((w) => w.name === 'ZyrixWarning')
  assert.equal(ours.length, 1, 'el mismo error repetido no inunda la consola')
  assert.equal(ours[0].message, 'se cortó')
})

test('socket: con logger configurado, los errores van a logger.error', async () => {
  const logged = []
  const socket = await newSocket({ logger: { error: (obj, msg) => logged.push(msg), warn() {}, info() {}, debug() {}, trace() {} } })
  socket.emit('error', new Error('falló el guardado'))
  assert.deepEqual(logged, ['falló el guardado'])
})

test('socket: si el usuario registra su propio listener, el listener por defecto no reporta nada', async () => {
  const logged = []
  const socket = await newSocket({ logger: { error: (obj, msg) => logged.push(msg), warn() {}, info() {}, debug() {}, trace() {} } })
  const mine = []
  socket.on('error', (e) => mine.push(e.message))
  socket.emit('error', new Error('x'))
  assert.deepEqual(mine, ['x'])
  assert.deepEqual(logged, [])
})

test('auth: un state.json.tmp válido de un crash entre writeFile y rename se promueve', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-tmp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const seed = useFileAuthState(dir, { debounceMs: 1 })
  seed.state.creds.marker = 'recuperado-del-temporal'
  seed.save()
  await seed.flush()
  await copyFile(path.join(dir, 'state.json'), path.join(dir, 'state.json.tmp'))
  await rm(path.join(dir, 'state.json'))

  const recovered = useFileAuthState(dir, { debounceMs: 1 })
  assert.equal(recovered.state.creds.marker, 'recuperado-del-temporal')
  await assert.rejects(stat(path.join(dir, 'state.json.tmp')), { code: 'ENOENT' })
  await recovered.flush()
  const saved = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.creds.marker, 'recuperado-del-temporal')
})

test('auth: un state.json.tmp inválido sin state.json falla explícitamente en vez de borrarse', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-tmp-bad-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'state.json.tmp'), 'restos de un proceso que murió')
  assert.throws(() => useFileAuthState(dir, { debounceMs: 1 }), { errorCode: 'SESSION_TEMP_INVALID' })
  assert.equal((await readFile(path.join(dir, 'state.json.tmp'), 'utf8')), 'restos de un proceso que murió')
})

test('auth: un temporal viejo se descarta cuando state.json ya existe', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-tmp-stale-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const auth = useFileAuthState(dir, { debounceMs: 1 })
  auth.state.creds.marker = 'vigente'
  auth.save()
  await auth.flush()
  await writeFile(path.join(dir, 'state.json.tmp'), 'temporal viejo')
  useFileAuthState(dir, { debounceMs: 1 })
  await assert.rejects(stat(path.join(dir, 'state.json.tmp')), { code: 'ENOENT' })
})

test('auth: save() es barato — serializa recién al escribir, no en cada llamada', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-lazy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const auth = useFileAuthState(dir, { debounceMs: 50, encryptionKey: 'una clave de prueba suficientemente larga' })
  const started = performance.now()
  for (let i = 0; i < 1000; i++) auth.save()
  const elapsed = performance.now() - started
  assert.ok(elapsed < 100, `1000 save() tardaron ${elapsed.toFixed(1)} ms`)
  await auth.flush()
  const reopened = useFileAuthState(dir, { encryptionKey: 'una clave de prueba suficientemente larga' })
  assert.ok(reopened.state.creds.noiseKey)
})

test('auth: un fallo de escritura deja el estado pendiente y el siguiente flush lo reintenta', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-retry-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const auth = useFileAuthState(dir, { debounceMs: 1 })
  // Un directorio con el nombre del lock hace fallar la adquisición antes de escribir.
  const { mkdir, rmdir } = await import('node:fs/promises')
  await mkdir(path.join(dir, 'state.json.lock'))
  auth.state.creds.marker = 'pendiente'
  auth.save()
  await assert.rejects(auth.flush())
  await rmdir(path.join(dir, 'state.json.lock'))
  await auth.flush()
  const saved = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.creds.marker, 'pendiente')
})

test('auth: registrationId usa el rango válido de Signal (1..16380)', () => {
  for (let i = 0; i < 200; i++) {
    const { registrationId } = initCreds()
    assert.ok(Number.isInteger(registrationId) && registrationId >= 1 && registrationId <= 16380, String(registrationId))
  }
})

test('locale: los textos por defecto están en inglés y MESSAGES_ES conserva los anteriores', () => {
  assert.equal(DEFAULT_MESSAGES.disconnect.loggedOut, 'logged out')
  assert.equal(MESSAGES_ES.disconnect.loggedOut, 'sesión cerrada')
  assert.equal(mergeMessages(MESSAGES_ES).fatal.forbidden, MESSAGES_ES.fatal.forbidden)
})

test('launcher: clasifica errores por errorCode, no por el texto del mensaje', () => {
  const launcher = Object.create(Launcher.prototype)
  const issues = []
  launcher.emit = (name, payload) => issues.push(payload)
  let misses = 0
  launcher.noteSenderKeyMiss = () => misses++
  const ctx = { finished: false }
  launcher.onSockError(ctx, new ZyrixError('cualquier texto', { kind: 'closed', errorCode: ErrorCode.STREAM_ERROR, code: 515 }))
  launcher.onSockError(ctx, new ZyrixError('otro texto', { kind: 'rejected', errorCode: ErrorCode.CONNECTION_REJECTED, code: 403 }))
  launcher.onSockError(ctx, new ZyrixError('lo que sea', { kind: 'closed', errorCode: ErrorCode.CONNECTION_IDLE }))
  launcher.onSockError(ctx, new ZyrixError('abc', { kind: 'no-session', errorCode: ErrorCode.SENDER_KEY_MISSING }))
  launcher.onSockError(ctx, new ZyrixError('ws', { kind: 'closed', errorCode: ErrorCode.WEBSOCKET_CLOSED_BEFORE_HANDSHAKE }))
  assert.deepEqual(issues.map((i) => [i.type, i.code]), [['stream-error', 515], ['connection-rejected', 403], ['idle', undefined], ['websocket-handshake', 1006]])
  assert.equal(misses, 1)
})
