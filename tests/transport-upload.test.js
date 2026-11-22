import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { Transport, WA_HEADER, MAX_FRAME_SIZE } from '../src/transport.js'
import { postFile } from '../src/upload.js'

// Doble del cliente ws: mismos eventos y readyState que usa Transport.
class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.readyState = WebSocket.CONNECTING
    this.sent = []
    this.closed = 0
  }
  send(buffer) { this.sent.push(buffer) }
  close() { this.closed++; this.readyState = WebSocket.CLOSED; this.emit('close', 1000) }
  open() { this.readyState = WebSocket.OPEN; this.emit('open') }
}

const connected = (options = {}) => {
  const fake = new FakeSocket()
  const calls = []
  const transport = new Transport({ createWebSocket: (url, opts) => { calls.push([url, opts]); return fake }, ...options })
  transport.connect()
  return { transport, fake, calls }
}

test('transport: connect negocia el handshake y reenvía open, frames y close', () => {
  const { transport, fake, calls } = connected()
  assert.equal(calls.length, 1)
  assert.match(calls[0][0], /^wss:\/\/web\.whatsapp\.com\/ws\/chat$/)
  assert.equal(calls[0][1].origin, 'https://web.whatsapp.com')
  assert.equal(calls[0][1].handshakeTimeout, 20000)
  const events = []
  transport.on('open', () => events.push('open'))
  transport.on('frame', (f) => events.push(f.toString()))
  transport.on('close', (code) => events.push(`close:${code}`))
  transport.on('error', (e) => events.push(`error:${e.errorCode || e.message}`))

  fake.open()
  assert.deepEqual(events, ['open'])
  fake.emit('message', Buffer.from([0, 0, 2, 65, 66]))
  fake.emit('message', [Buffer.from([0, 0, 1]), Buffer.from([67])])
  fake.emit('message', new Uint8Array([0, 0, 0]))
  assert.deepEqual(events.slice(1), ['AB', 'C', ''])
  fake.emit('close', 1000)
  assert.equal(events.at(-1), 'close:1000')
})

test('transport: connect envía el header una vez y propaga errores del socket', () => {
  const { transport, fake } = connected()
  fake.open()
  transport.send(Buffer.from('hola'))
  transport.send(Buffer.from('mundo'))
  assert.deepEqual(fake.sent[0].subarray(0, 4), WA_HEADER)
  assert.deepEqual(fake.sent[0].subarray(4), Buffer.from([0, 0, 4, 104, 111, 108, 97]))
  assert.deepEqual(fake.sent[1], Buffer.from([0, 0, 5, 109, 117, 110, 100, 111]))
  assert.throws(() => transport.send(Buffer.alloc(MAX_FRAME_SIZE + 1)), RangeError)

  const errors = []
  transport.on('error', (e) => errors.push(e))
  const boom = new Error('socket roto')
  fake.emit('error', boom)
  assert.equal(errors[0], boom)
})

test('transport: un cierre 1006 antes del open explica el fallo del pairing', () => {
  const { transport, fake } = connected()
  const errors = []
  transport.on('error', (e) => errors.push(e))
  fake.emit('close', 1006)
  assert.equal(errors[0].errorCode, 'WEBSOCKET_CLOSED_BEFORE_HANDSHAKE')
  assert.equal(errors[0].name, 'WebSocketHandshakeError')
  assert.equal(errors[0].code, 1006)
})

test('transport: el timeout de apertura emite error y cierra', async () => {
  const { transport, fake } = connected({ openTimeoutMs: 5 })
  const errors = []
  transport.on('error', (e) => errors.push(e))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(errors[0].errorCode, 'WEBSOCKET_OPEN_TIMEOUT')
  assert.equal(fake.closed, 1)
  assert.equal(transport.openTimer, null)
})

test('transport: un frame inválido emitido por el socket se reporta y cierra', () => {
  const { transport, fake } = connected()
  fake.open()
  const errors = []
  transport.on('error', (e) => errors.push(e))
  fake.emit('message', Buffer.alloc(MAX_FRAME_SIZE * 2 + 10))
  assert.equal(errors[0] instanceof RangeError, true)
  assert.equal(fake.closed, 1)
  transport.close()
  assert.equal(fake.closed, 1)
})

const fakeRequest = (handler) => (options, onResponse) => {
  const req = new Writable({
    write(chunk, _encoding, callback) {
      req.body.push(Buffer.from(chunk))
      callback()
    }
  })
  req.body = []
  req.options = options
  req.timeoutMs = null
  req.setTimeout = (ms, fn) => { req.timeoutMs = ms; req.timeoutFn = fn }
  req.destroy = (error) => { req.destroyedWith = error; if (error) process.nextTick(() => req.emit('error', error)) }
  handler(req, onResponse)
  return req
}

const responseOf = (body, statusCode = 200) => {
  const res = Readable.from([Buffer.from(body)])
  res.statusCode = statusCode
  return res
}

test('upload: postFile hace POST del archivo con headers y devuelve cuerpo y estado', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-upload-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'media.bin')
  await writeFile(file, Buffer.from('contenido'))
  let seen
  const request = fakeRequest((req, onResponse) => {
    seen = req
    req.on('finish', () => onResponse(responseOf('{"url":"https://mmg.whatsapp.net/x"}')))
  })
  const result = await postFile('mmg.whatsapp.net', '/mms/image/token', file, 9, 5000, { request })
  assert.deepEqual(result, { status: 200, body: '{"url":"https://mmg.whatsapp.net/x"}' })
  assert.equal(seen.options.host, 'mmg.whatsapp.net')
  assert.equal(seen.options.method, 'POST')
  assert.equal(seen.options.path, '/mms/image/token')
  assert.equal(seen.options.headers['Content-Length'], 9)
  assert.equal(seen.options.headers.Origin, 'https://web.whatsapp.com')
  assert.equal(seen.timeoutMs, 5000)
  assert.deepEqual(Buffer.concat(seen.body), Buffer.from('contenido'))
})

test('upload: postFile rechaza respuestas enormes, errores de red, timeout y archivo ilegible', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-upload-err-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'media.bin')
  await writeFile(file, Buffer.from('x'))

  const huge = fakeRequest((req, onResponse) => {
    req.on('finish', () => onResponse(responseOf(Buffer.alloc(64 * 1024 + 1))))
  })
  await assert.rejects(postFile('h', '/p', file, 1, 1000, { request: huge }), { errorCode: 'UPLOAD_RESPONSE_TOO_LARGE' })

  const network = fakeRequest((req) => process.nextTick(() => req.emit('error', new Error('ECONNRESET'))))
  await assert.rejects(postFile('h', '/p', file, 1, 1000, { request: network }), /ECONNRESET/)

  let timedOutRequest
  const timedOut = fakeRequest((req) => { timedOutRequest = req })
  const timeout = postFile('h', '/p', file, 1, 50, { request: timedOut })
  await new Promise((resolve) => setTimeout(resolve, 10))
  timedOutRequest.timeoutFn()
  await assert.rejects(timeout, { errorCode: 'UPLOAD_TIMEOUT' })
  assert.equal(timedOutRequest.destroyedWith.errorCode, 'UPLOAD_TIMEOUT')

  const unreadable = (await import('node:fs')).createReadStream(path.join(dir, 'no-existe.bin'))
  const missing = fakeRequest(() => {})
  await assert.rejects(postFile('h', '/p', file, 1, 1000, { request: missing, createReadStream: () => unreadable }), /ENOENT/)
})
