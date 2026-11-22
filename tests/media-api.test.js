import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import mediaMixin from '../src/media.js'
import { encryptMedia } from '../src/mediacrypto.js'
import { makeState } from './helpers/state.js'

const withFetch = async (fn, handler) => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push([url, options])
    return handler(url, options, calls.length)
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

const response = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers })

const make = (extra = {}) => Object.assign({}, mediaMixin, {
  auth: { state: makeState(), save() {} },
  maxMediaBytes: 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  mediaConnCache: null,
  deliver: async (...args) => { make.delivered = args; return { key: { id: 'x' }, message: args[1] } },
  ...extra
})

test('media: mediaConn cachea hosts y ttl', async () => {
  let calls = 0
  const sock = make({
    query: async () => {
      calls++
      return { tag: 'iq', content: [{ tag: 'media_conn', attrs: { auth: 'a', ttl: '60' }, content: [{ tag: 'host', attrs: { hostname: 'mmg.whatsapp.net' } }] }] }
    }
  })
  const conn = await sock.mediaConn()
  assert.equal(conn.auth, 'a')
  assert.deepEqual(conn.hosts, ['mmg.whatsapp.net'])
  assert.ok(conn.expires > Date.now())
  await sock.mediaConn()
  assert.equal(calls, 1)
})

test('media: uploadMedia sube cifrado, salta hosts no permitidos y limpia la caché en 401', async () => {
  const sock = make({
    mediaConn: async () => ({ auth: 'a b', hosts: ['evil.example.com', 'mmg1.whatsapp.net'] })
  })
  await withFetch(async (calls) => {
    const result = await sock.uploadMedia(Buffer.from('hola'), 'image')
    assert.equal(result.url, 'https://mmg.whatsapp.net/x')
    assert.equal(result.directPath, '/x')
    assert.equal(calls.length, 1)
    assert.ok(calls[0][1].body.length > 0)
  }, () => response(JSON.stringify({ url: 'https://mmg.whatsapp.net/x', direct_path: '/x' })))

  const cached = make({ mediaConnCache: { expires: Date.now() + 1000 }, mediaConn: async () => ({ auth: 'a', hosts: ['mmg.whatsapp.net'] }) })
  await withFetch(async () => {
    await assert.rejects(cached.uploadMedia(Buffer.from('x'), 'image'), { errorCode: 'MEDIA_UPLOAD_FAILED' })
    assert.equal(cached.mediaConnCache, null)
  }, () => response('', { status: 401 }))

  const invalid = make({ mediaConn: async () => ({ auth: 'a', hosts: ['mmg1.whatsapp.net'] }) })
  await withFetch(async () => {
    await assert.rejects(invalid.uploadMedia(Buffer.from('x'), 'image'), { errorCode: 'MEDIA_UPLOAD_FAILED' })
  }, () => response(JSON.stringify({ nope: true })))
})

test('media: uploadEncryptedMedia valida y sube bytes ya cifrados', async () => {
  const hash = Buffer.alloc(32, 1).toString('base64')
  const sock = make({ mediaConn: async () => ({ auth: 'a', hosts: ['mmg.whatsapp.net'] }) })
  await assert.rejects(sock.uploadEncryptedMedia(Buffer.from('x'), {}), TypeError)
  await assert.rejects(sock.uploadEncryptedMedia(Buffer.from('x'), { fileEncSha256B64: hash, mediaType: 'nope' }), TypeError)
  const result = await withFetch(() => sock.uploadEncryptedMedia(Buffer.from('x'), { fileEncSha256B64: hash, mediaType: 'image' }), () => response(JSON.stringify({ direct_path: '/d' })))
  assert.equal(result.directPath, '/d')
  assert.equal(result.url, undefined)
  await withFetch(() => assert.rejects(sock.uploadEncryptedMedia(Buffer.from('x'), { fileEncSha256B64: hash, mediaType: 'image' }), { errorCode: 'MEDIA_UPLOAD_FAILED' }), () => response('', { status: 403 }))
})

test('media: sendMedia arma el cuerpo con opciones y usa upload', async () => {
  const up = { url: 'u', directPath: 'd', mediaKey: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32), fileSha256: Buffer.alloc(32), fileLength: 4 }
  const sock = make({ uploadMedia: async () => up })
  const result = await sock.sendMedia('5491100000002', {
    image: Buffer.from([0xff, 0xd8, 0xff, 0x00]), caption: 'cap', width: 10, height: 20, thumbnail: Buffer.from('t'), mimetype: 'image/jpeg'
  })
  assert.equal(result.message.imageMessage.caption, 'cap')
  assert.equal(result.message.imageMessage.width, 10)
  assert.deepEqual(result.message.imageMessage.jpegThumbnail, Buffer.from('t'))
  assert.equal(make.delivered[2].mediaType, 'image')

  const audio = await sock.sendMedia('5491100000002', { audio: Buffer.from('x'), ptt: true, seconds: 5, waveform: Buffer.from('w') })
  assert.equal(audio.message.audioMessage.ptt, true)
  assert.equal(audio.message.audioMessage.seconds, 5)
  assert.equal(audio.message.audioMessage.mimetype, 'audio/ogg; codecs=opus')
  assert.equal(make.delivered[2].mediaType, 'ptt')

  const video = await sock.sendMedia('5491100000002', { video: Buffer.from('x'), gif: true })
  assert.equal(video.message.videoMessage.gifPlayback, true)
  assert.equal(make.delivered[2].mediaType, 'gif')

  const doc = await sock.sendMedia('5491100000002', { document: Buffer.from('%PDF-1.4') })
  assert.equal(doc.message.documentMessage.fileName, 'archivo')
  assert.equal(doc.message.documentMessage.mimetype, 'application/pdf')

  const sticker = await sock.sendMedia('5491100000002', { sticker: Buffer.from('x') })
  assert.ok(sticker.message.stickerMessage)
  await assert.rejects(sock.sendMedia('5491100000002', {}), { errorCode: 'MEDIA_CONTENT_MISSING' })
  await assert.rejects(sock.sendMedia('5491100000002', { image: Buffer.alloc(2 * 1024 * 1024) }), RangeError)
})

test('media: sendMedia con archivo local y stream no dejan temporales', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-media-send-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'foto.jpg')
  await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0x00]))
  const uploaded = []
  const sock = make({ uploadMediaFile: async (p, type) => { uploaded.push([p, type]); return { url: 'u', directPath: 'd', mediaKey: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32), fileSha256: Buffer.alloc(32), fileLength: 4 } } })
  const result = await sock.sendMedia('5491100000002', { image: file })
  assert.equal(result.message.imageMessage.mimetype, 'image/jpeg')
  assert.equal(uploaded.length, 1)
  assert.equal(uploaded[0][1], 'image')

  const streamed = await sock.sendMedia('5491100000002', { image: { stream: Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0x00])]) } })
  assert.ok(streamed.message.imageMessage)
  assert.equal(uploaded.length, 2)
  assert.equal(uploaded[1][1], 'image')
  await assert.rejects(sock.sendMedia('5491100000002', { image: { stream: Readable.from(['texto']) } }), TypeError)
})

test('media: alias sendImage/sendVideo/sendAudio/sendDocument/sendSticker', async () => {
  const sock = make()
  sock.sendMedia = async (to, opts) => opts
  assert.ok((await sock.sendImage('j', Buffer.from('x'))).image)
  assert.ok((await sock.sendVideo('j', Buffer.from('x'))).video)
  assert.ok((await sock.sendAudio('j', Buffer.from('x'))).audio)
  assert.ok((await sock.sendDocument('j', Buffer.from('x'))).document)
  assert.ok((await sock.sendSticker('j', Buffer.from('x'))).sticker)
})

test('media: sendAlbum valida, envía el padre y numera los hijos', async () => {
  const sent = []
  const sock = make({
    sendMedia: async (to, opts) => { sent.push(opts); return opts },
    deliver: async (chat, message, opts) => ({ key: { id: opts.id }, message })
  })
  const result = await sock.sendAlbum('5491100000002', [{ image: Buffer.from('a') }, { video: Buffer.from('b') }], { caption: 'cap' })
  assert.equal(result.expectedImageCount, 1)
  assert.equal(result.expectedVideoCount, 1)
  assert.equal(sent.length, 2)
  assert.equal(sent[0].caption, 'cap')
  assert.equal(sent[0].messageContextInfo.messageAssociation.messageIndex, 0)
  assert.equal(sent[1].messageContextInfo.messageAssociation.messageIndex, 1)
  await assert.rejects(sock.sendAlbum('j', [{ image: Buffer.from('a') }]), RangeError)
  await assert.rejects(sock.sendAlbum('j', Array.from({ length: 31 }, () => ({ image: Buffer.from('a') }))), RangeError)
  await assert.rejects(sock.sendAlbum('j', [{ image: Buffer.from('a'), video: Buffer.from('b') }, { image: Buffer.from('a') }]), TypeError)
  await assert.rejects(sock.sendAlbum('j', [{}, { image: Buffer.from('a') }]), TypeError)
})

test('media: sendStickerPack sube el paquete y envía metadatos', async () => {
  const sock = make({ uploadMedia: async () => ({ url: 'u', directPath: 'd', mediaKey: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32), fileSha256: Buffer.alloc(32), fileLength: 10 }) })
  const result = await sock.sendStickerPack('5491100000002', { pack: Buffer.from('zip'), stickers: [{ fileName: 'a.webp' }] })
  assert.equal(result.message.stickerPackMessage.stickerPackSize, 10)
  await assert.rejects(sock.sendStickerPack('j', {}), TypeError)
})

test('media: downloadMedia descarga, valida el host y descifra', async () => {
  const body = Buffer.from('contenido')
  const enc = encryptMedia(body, 'image')
  const sock = make()
  const result = await withFetch(() => sock.downloadMedia({ imageMessage: { url: 'https://mmg.whatsapp.net/f', mediaKey: enc.mediaKey } }), () => response(enc.body, { headers: { 'content-length': String(enc.body.length) } }))
  assert.deepEqual(result, body)

  await assert.rejects(sock.downloadMedia({}), { errorCode: 'MEDIA_NOT_FOUND' })
  await assert.rejects(sock.downloadMedia({ imageMessage: { url: 'https://evil.example.com/f', mediaKey: enc.mediaKey } }), { errorCode: 'MEDIA_HOST_NOT_ALLOWED' })
  await withFetch(() => assert.rejects(sock.downloadMedia({ imageMessage: { url: 'https://mmg.whatsapp.net/f', mediaKey: enc.mediaKey } }), { errorCode: 'MEDIA_DOWNLOAD_FAILED' }), () => response('', { status: 500 }))
})

test('media: downloadMediaToFile valida límites y respuestas', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-media-dl-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const body = Buffer.from('hola')
  const enc = encryptMedia(body, 'image')
  const output = path.join(dir, 'out.jpg')
  const sock = make()
  await assert.rejects(sock.downloadMediaToFile({}, output), { errorCode: 'MEDIA_NOT_FOUND' })
  const message = { imageMessage: { directPath: '/f', mediaKey: enc.mediaKey } }
  await assert.rejects(sock.downloadMediaToFile(message, output, { maxBytes: 0 }), RangeError)
  await assert.rejects(sock.downloadMediaToFile(message, output, { timeout: 0 }), RangeError)
  await withFetch(() => assert.rejects(sock.downloadMediaToFile(message, output), { errorCode: 'MEDIA_DOWNLOAD_FAILED' }), () => response('', { status: 404 }))
  await withFetch(() => assert.rejects(sock.downloadMediaToFile(message, output, { maxBytes: 10 }), RangeError), () => response(enc.body, { headers: { 'content-length': '999999' } }))
  await withFetch(() => assert.rejects(sock.downloadMediaToFile(message, output), { errorCode: 'MEDIA_DOWNLOAD_FAILED' }), () => new Response(null, { status: 200 }))
  await withFetch(() => sock.downloadMediaToFile(message, output), () => response(enc.body))
  assert.deepEqual(await import('node:fs/promises').then((fs) => fs.readFile(output)), body)
})
