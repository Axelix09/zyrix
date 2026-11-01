import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  jidNormalizedUser,
  jidType,
  normalizeJid,
  sameUser
} from '../src/jid.js'
import { text, extractText } from '../src/content.js'
import { parseMessage } from '../src/incoming.js'
import { gcmDecrypt, gcmEncrypt, hkdf } from '../src/crypto.js'
import { useFileAuthState } from '../src/auth.js'
import { Socket } from '../src/socket.js'
import { memoryAdapter, mongoAdapter, useAdapterAuthState } from '../src/authstore.js'
import { MAX_MONGO_DOCUMENT_BYTES } from '../src/auth.js'
import mediaMixin from '../src/media.js'
import { encryptMedia } from '../src/mediacrypto.js'
import { Readable } from 'node:stream'
import { toBuffer } from '../src/util.js'
import { parseAuthSnapshot, serializeAuthSnapshot } from '../src/auth-snapshot.js'

test('JID: normaliza identificadores, quita dispositivo y clasifica servidores', () => {
  assert.equal(normalizeJid(123456), '123456@s.whatsapp.net')
  assert.equal(jidNormalizedUser('123456:7@s.whatsapp.net'), '123456@s.whatsapp.net')
  assert.equal(jidType('123456@s.whatsapp.net'), 'pn')
  assert.equal(jidType('123456-42@g.us'), 'group')
  assert.equal(sameUser('123456:1@s.whatsapp.net', '123456@s.whatsapp.net'), true)
  assert.throws(() => normalizeJid('no-es-un-numero'), TypeError)
  assert.throws(() => normalizeJid('  '), TypeError)
})

test('contenido de texto aplica contexto y extractText devuelve el texto construido', () => {
  const message = text('hola', { mentions: ['123456'], expiration: 60 })
  assert.equal(message.extendedTextMessage.text, 'hola')
  assert.deepEqual(message.extendedTextMessage.contextInfo.mentionedJid, ['123456@s.whatsapp.net'])
  assert.equal(message.extendedTextMessage.contextInfo.expiration, 60)
  assert.equal(extractText(message), 'hola')
  assert.throws(() => text('hola', { expiration: -1 }), RangeError)
})

test('parseMessage extrae texto, identidad normalizada y tipo desde un evento entrante', () => {
  const event = {
    key: { id: 'msg-1', remoteJid: '123456@s.whatsapp.net', fromMe: false },
    message: { conversation: 'mensaje de prueba' },
    messageTimestamp: 1700000000,
    pushName: 'Prueba'
  }
  const parsed = parseMessage(event)
  assert.equal(parsed.id, 'msg-1')
  assert.equal(parsed.type, 'text')
  assert.equal(parsed.text, 'mensaje de prueba')
  assert.equal(parsed.sender, '123456@s.whatsapp.net')
  assert.equal(parsed.timestamp, 1700000000)
  assert.throws(() => parseMessage({ key: event.key }), TypeError)
})

test('AES-256-GCM conserva el plaintext y rechaza ciphertext alterado', () => {
  const key = Buffer.alloc(32, 7)
  const plaintext = Buffer.from('datos de prueba')
  const aad = Buffer.from('contexto')
  const ciphertext = gcmEncrypt(plaintext, key, 4, aad)
  assert.deepEqual(gcmDecrypt(ciphertext, key, 4, aad), plaintext)
  const tampered = Buffer.from(ciphertext)
  tampered[0] ^= 1
  assert.throws(() => gcmDecrypt(tampered, key, 4, aad))
  assert.throws(() => gcmDecrypt(ciphertext, key, 4, Buffer.from('otro contexto')))
  assert.throws(() => gcmEncrypt(plaintext, Buffer.alloc(16), 4), TypeError)
})

test('HKDF entrega la longitud solicitada y rechaza longitudes fuera de rango', () => {
  assert.equal(hkdf(Buffer.from('input'), 42, Buffer.from('salt'), Buffer.from('info')).length, 42)
  assert.throws(() => hkdf(Buffer.from('input'), 255 * 32 + 1), RangeError)
})

test('adaptador de auth persiste y restaura buffers sin exponer ni tocar archivos externos', async () => {
  const adapter = memoryAdapter()
  const auth = await useAdapterAuthState(adapter, { debounceMs: 60_000 })
  auth.state.creds.testBuffer = Buffer.from([0, 1, 254, 255])
  auth.state.keys.sessions['device-test'] = { record: Buffer.from('fixture') }
  auth.save()
  await auth.flush()

  const stored = adapter.read()
  assert.equal(typeof stored, 'string')
  assert.equal(stored.includes('testBuffer'), true)
  const restored = await useAdapterAuthState(adapter, { debounceMs: 60_000 })
  assert.deepEqual(restored.state.creds.testBuffer, Buffer.from([0, 1, 254, 255]))
  assert.deepEqual(restored.state.keys.sessions['device-test'].record, Buffer.from('fixture'))
  await restored.flush()
  await assert.rejects(useAdapterAuthState({ read: () => '{', write() {} }), /No se pudo leer la sesión/)
})

test('estado de archivo se escribe solo dentro de un temporal y usa permisos restrictivos', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-auth-test-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))

  const auth = useFileAuthState(dir, { debounceMs: 60_000 })
  auth.state.keys.sessions['test-session'] = { marker: Buffer.from('temporary fixture') }
  auth.save()
  await auth.flush()

  const stateFile = path.join(dir, 'state.json')
  const info = await stat(stateFile)
  assert.equal(info.isFile(), true)
  assert.equal(info.mode & 0o077, 0, 'el archivo no debe conceder permisos a grupo u otros')
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(persisted.keys.sessions['test-session'].marker.type, 'Buffer')

  const restored = useFileAuthState(dir)
  assert.deepEqual(restored.state.keys.sessions['test-session'].marker, Buffer.from('temporary fixture'))
  assert.deepEqual((await readdir(dir)).sort(), ['state.json'])
})


test('snapshot cifrado autentica integridad y falla con clave incorrecta', () => {
  const state = { creds: { private: Buffer.from('secreto') }, keys: { sessions: { one: { key: Buffer.from([1, 2, 3]) } } } }
  const key = 'un secreto de prueba de al menos dieciséis bytes'
  const encrypted = serializeAuthSnapshot(state, key)
  assert.equal(encrypted.includes('secreto'), false)
  assert.deepEqual(parseAuthSnapshot(encrypted, key).keys.sessions.one.key, Buffer.from([1, 2, 3]))
  assert.throws(() => parseAuthSnapshot(encrypted, 'otra clave que tampoco coincide'), /no se pudo descifrar/)
  assert.throws(() => parseAuthSnapshot(encrypted), /sesión está cifrada/)
})

test('descarga remota de media rechaza direcciones loopback y privadas antes de hacer fetch', async () => {
  await assert.rejects(toBuffer({ url: 'http://127.0.0.1:8080/metadata' }, 1024), /URL de media no permitida/)
  await assert.rejects(toBuffer({ url: 'http://169.254.169.254/latest/meta-data/' }, 1024), /URL de media no permitida/)
  await assert.rejects(toBuffer({ url: 'http://localhost:8080/file' }, 1024), /URL de media no permitida/)
})


test('sesión heredada se migra a snapshot cifrado y rechaza claves equivocadas', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-auth-encrypted-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const legacy = useFileAuthState(dir, { debounceMs: 60_000 })
  legacy.state.keys.sessions['device-test'] = { secret: Buffer.from('no-plaintext') }
  legacy.save()
  await legacy.flush()

  const key = 'a test secret long enough for encryption'
  const encrypted = useFileAuthState(dir, { encryptionKey: key, debounceMs: 60_000 })
  await encrypted.flush()
  const disk = await readFile(path.join(dir, 'state.json'), 'utf8')
  const backup = await readFile(path.join(dir, 'state.json.bak'), 'utf8')
  assert.equal(JSON.parse(disk).format, 'zyrix-auth-encrypted-v1')
  assert.equal(JSON.parse(backup).format, 'zyrix-auth-encrypted-v1')
  assert.equal(disk.includes('no-plaintext'), false)
  assert.deepEqual(useFileAuthState(dir, { encryptionKey: key }).state.keys.sessions['device-test'].secret, Buffer.from('no-plaintext'))
  assert.throws(() => useFileAuthState(dir, { encryptionKey: 'a different secret long enough' }), /Archivo de sesión y respaldo corruptos/)
})


test('adapter con clave cifra el documento completo y requiere esa clave para restaurar', async () => {
  const adapter = memoryAdapter()
  const key = 'adapter key material that is safely long'
  const auth = await useAdapterAuthState(adapter, { encryptionKey: key })
  auth.state.creds.privateMarker = 'confidential-auth'
  auth.save()
  await auth.flush()
  assert.equal(adapter.read().includes('confidential-auth'), false)
  assert.equal((await useAdapterAuthState(adapter, { encryptionKey: key })).state.creds.privateMarker, 'confidential-auth')
  await assert.rejects(useAdapterAuthState(adapter), /sesión está cifrada/)
})

test('flush del adapter rechaza errores de escritura y permite reintentar el estado pendiente', async () => {
  let persisted = null
  let fail = false
  const adapter = {
    read: () => persisted,
    write: async (data) => {
      if (fail) throw new Error('disco temporalmente no disponible')
      persisted = data
    }
  }
  const auth = await useAdapterAuthState(adapter, { debounceMs: 60_000 })
  auth.onSaveError = () => {}
  auth.state.creds.flushMarker = 'must-persist'
  auth.save()
  fail = true
  await assert.rejects(auth.flush(), /disco temporalmente no disponible/)
  fail = false
  await auth.flush()
  assert.equal(JSON.parse(persisted).creds.flushMarker, 'must-persist')
})

test('clave de cifrado demasiado corta se rechaza al crear estado de sesión', () => {
  assert.throws(() => useFileAuthState(path.join(tmpdir(), 'zyrix-invalid-key'), { encryptionKey: 'short' }), /al menos 16 bytes/)
})


test('mongoAdapter aísla los snapshots por sessionId y rechaza documentos por encima del límite BSON', async () => {
  const docs = new Map()
  const collection = {
    async findOne(filter) { return docs.get(filter._id) ?? null },
    async updateOne(filter, update) { docs.set(filter._id, update.$set) }
  }
  const first = mongoAdapter(collection, 'bot-alpha')
  const second = mongoAdapter(collection, 'bot-beta')
  await first.write('alpha-data')
  await second.write('beta-data')
  assert.equal(await first.read(), 'alpha-data')
  assert.equal(await second.read(), 'beta-data')
  assert.equal(docs.size, 2)
  await assert.rejects(first.write('x'.repeat(MAX_MONGO_DOCUMENT_BYTES + 1)), (error) => error.code === 'SESSION_TOO_LARGE')
})


test('sendMedia acepta stream, lo cifra a través de un archivo temporal y limpia ese temporal', async () => {
  const payload = Buffer.from('streamed-file-payload')
  let uploadedPath
  const fake = {
    maxFileBytes: 1024,
    maxMediaBytes: 1024,
    async uploadMediaFile(filePath, type) {
      assert.equal(type, 'image')
      uploadedPath = filePath
      assert.deepEqual(await readFile(filePath), payload)
      return {
        url: 'https://mmg.whatsapp.net/media', directPath: '/media', mediaKey: Buffer.alloc(32),
        fileEncSha256: Buffer.alloc(32), fileSha256: Buffer.alloc(32), fileLength: payload.length
      }
    },
    async deliver(chat, message) { return { chat, message } }
  }
  const result = await mediaMixin.sendMedia.call(fake, '123456@s.whatsapp.net', {
    image: { stream: Readable.from([payload.subarray(0, 7), payload.subarray(7)]) },
    caption: 'stream test'
  })
  assert.equal(result.chat, '123456@s.whatsapp.net')
  assert.equal(result.message.imageMessage.caption, 'stream test')
  await assert.rejects(readFile(uploadedPath), { code: 'ENOENT' })
})

test('downloadMediaToFile transmite, autentica y descifra a disco sin publicar MAC inválido', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-media-stream-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const source = Buffer.from('streamed-download-content '.repeat(2000))
  const encrypted = encryptMedia(source, 'image')
  const output = path.join(dir, 'downloaded.jpg')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(Readable.toWeb(Readable.from([
    encrypted.body.subarray(0, 13), encrypted.body.subarray(13, 1024), encrypted.body.subarray(1024)
  ])), { status: 200 })
  try {
    const fake = { maxFileBytes: source.length + 1024 }
    await mediaMixin.downloadMediaToFile.call(fake, {
      imageMessage: { url: 'https://mmg.whatsapp.net/file', mediaKey: encrypted.mediaKey }
    }, output)
    assert.deepEqual(await readFile(output), source)
    await assert.rejects(mediaMixin.downloadMediaToFile.call(fake, {
      imageMessage: { url: 'https://mmg.whatsapp.net/file', mediaKey: encrypted.mediaKey }
    }, output), { code: 'EEXIST' })

    const tamperedPath = path.join(dir, 'bad.jpg')
    const tampered = Buffer.from(encrypted.body)
    tampered[tampered.length - 1] ^= 1
    globalThis.fetch = async () => new Response(tampered, { status: 200 })
    await assert.rejects(mediaMixin.downloadMediaToFile.call(fake, {
      imageMessage: { url: 'https://mmg.whatsapp.net/file', mediaKey: encrypted.mediaKey }
    }, tamperedPath), /MAC de media inválido/)
    await assert.rejects(readFile(tamperedPath), { code: 'ENOENT' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Socket público expone downloadMediaToFile sin iniciar una conexión', async () => {
  const auth = await useAdapterAuthState(memoryAdapter())
  const socket = new Socket({ auth })
  assert.equal(typeof socket.sendMedia, 'function')
  assert.equal(typeof socket.downloadMediaToFile, 'function')
})
