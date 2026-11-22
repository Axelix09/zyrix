import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import dns from 'node:dns'

import { encodeNode, decodeNode, getChild, getChildren } from '../src/binary.js'
import { Noise } from '../src/noise.js'
import { Curve, hkdf, hmacSha256, aesCbcEncrypt } from '../src/crypto.js'
import { initCreds, initKeys } from '../src/auth.js'
import * as signal from '../src/signal.js'
import * as senderkey from '../src/senderkey.js'
import appstate from '../src/appstate.js'
import { proto } from '../src/proto.js'
import { ErrorCode, ZyrixError, isZyrixError } from '../src/errors.js'
import { isPublicAddress, publicOnlyLookup, toBuffer } from '../src/util.js'
import { createSnapshotCodec, parseAuthSnapshot } from '../src/auth-snapshot.js'

const roundTrip = (node) => decodeNode(encodeNode(node))

// ---------------------------------------------------------------------------
// Codificación binaria de nodos
// ---------------------------------------------------------------------------

test('binary: un nodo con atributos, hijos y bytes vuelve idéntico tras codificar y decodificar', () => {
  const node = {
    tag: 'iq',
    attrs: { id: '3EB0ABCDEF', type: 'get', xmlns: 'w:p', to: 's.whatsapp.net' },
    content: [
      { tag: 'ping', attrs: {} },
      { tag: 'value', attrs: {}, content: Buffer.from([0, 1, 2, 250, 255]) },
      { tag: 'list', attrs: {}, content: [{ tag: 'item', attrs: { n: '1' } }, { tag: 'item', attrs: { n: '2' } }] }
    ]
  }
  const decoded = roundTrip(node)
  assert.equal(decoded.tag, 'iq')
  assert.equal(decoded.attrs.id, '3EB0ABCDEF')
  assert.equal(decoded.attrs.type, 'get')
  assert.equal(decoded.attrs.to, 's.whatsapp.net')
  assert.equal(getChildren(decoded, 'item').length, 0)
  assert.deepEqual(Buffer.from(getChild(decoded, 'value').content), Buffer.from([0, 1, 2, 250, 255]))
  assert.deepEqual(getChildren(getChild(decoded, 'list'), 'item').map((n) => n.attrs.n), ['1', '2'])
})

test('binary: JIDs, cadenas numéricas, hex y texto libre conservan su valor', () => {
  const decoded = roundTrip({
    tag: 'message',
    attrs: {
      to: '5215551234567@s.whatsapp.net',
      participant: '5215551234567:12@s.whatsapp.net',
      lid: '123456789012345@lid',
      group: '120363000000000000@g.us',
      t: '1732240000',
      hex: '0A1B2C3D',
      free: 'texto con ñ y emojis 🚀'
    },
    content: 'contenido de texto'
  })
  assert.equal(decoded.attrs.to, '5215551234567@s.whatsapp.net')
  assert.equal(decoded.attrs.participant, '5215551234567:12@s.whatsapp.net')
  assert.equal(decoded.attrs.lid, '123456789012345@lid')
  assert.equal(decoded.attrs.group, '120363000000000000@g.us')
  assert.equal(decoded.attrs.t, '1732240000')
  assert.equal(decoded.attrs.hex, '0A1B2C3D')
  assert.equal(decoded.attrs.free, 'texto con ñ y emojis 🚀')
  assert.equal(String(decoded.content), 'contenido de texto')
})

test('binary: binarios grandes (BINARY_20) y listas de más de 255 hijos (LIST_16)', () => {
  const big = crypto.randomBytes(300_000)
  const many = Array.from({ length: 300 }, (_, i) => ({ tag: 'item', attrs: { i: String(i) } }))
  const decoded = roundTrip({ tag: 'root', attrs: {}, content: [{ tag: 'blob', attrs: {}, content: big }, { tag: 'many', attrs: {}, content: many }] })
  assert.ok(Buffer.from(getChild(decoded, 'blob').content).equals(big))
  const items = getChildren(getChild(decoded, 'many'), 'item')
  assert.equal(items.length, 300)
  assert.equal(items[299].attrs.i, '299')
})

test('binary: decodifica frames comprimidos con zlib (flag 2)', () => {
  const raw = encodeNode({ tag: 'notification', attrs: { type: 'devices' }, content: [{ tag: 'x', attrs: {} }] })
  const compressed = Buffer.concat([Buffer.from([2]), zlib.deflateSync(raw.subarray(1))])
  const decoded = decodeNode(compressed)
  assert.equal(decoded.tag, 'notification')
  assert.equal(decoded.attrs.type, 'devices')
})

test('binary: un frame truncado falla con un ZyrixError de protocolo', () => {
  const raw = encodeNode({ tag: 'iq', attrs: { id: 'abc', type: 'result' }, content: [{ tag: 'ping', attrs: {} }] })
  assert.throws(() => decodeNode(raw.subarray(0, raw.length - 3)), { name: 'ZyrixError', kind: 'protocol', errorCode: ErrorCode.BINARY_EOF })
  assert.throws(() => encodeNode({ tag: 'iq', attrs: {}, content: 42 }), { errorCode: ErrorCode.BINARY_CONTENT_INVALID })
})

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

test('noise: tras finish() ambos lados derivan claves opuestas y los contadores avanzan', async () => {
  const client = new Noise(Curve.generateKeyPair())
  const server = new Noise(Curve.generateKeyPair())
  // Mismo material de mezcla en ambos lados: simula el handshake ya completado.
  const shared = crypto.randomBytes(32)
  client.salt = server.salt = sha(shared)
  await client.finish()
  await server.finish()
  // El servidor descifra lo que el cliente cifra con su clave de lectura = clave de escritura del cliente.
  server.decKey = client.encKey
  client.decKey = server.encKey
  const a = client.encrypt(Buffer.from('hola'))
  const b = client.encrypt(Buffer.from('hola'))
  assert.notDeepEqual(a, b, 'el mismo plaintext no debe repetir ciphertext (IV por contador)')
  assert.equal(server.decrypt(a).toString(), 'hola')
  assert.equal(server.decrypt(b).toString(), 'hola')
  assert.throws(() => server.decrypt(a), 'reproducir un frame viejo debe fallar porque el contador ya avanzó')
})

const sha = (d) => crypto.createHash('sha256').update(d).digest()

// ---------------------------------------------------------------------------
// Signal (1:1)
// ---------------------------------------------------------------------------

const makeParty = () => ({ creds: initCreds(), keys: initKeys() })
const bundleFor = (party, preKeyId = 1) => {
  const preKey = Curve.generateKeyPair()
  party.keys.preKeys[preKeyId] = preKey
  return {
    registrationId: party.creds.registrationId,
    identityKey: Buffer.concat([Buffer.from([5]), party.creds.signedIdentityKey.public]),
    signedPreKey: {
      keyId: party.creds.signedPreKey.keyId,
      publicKey: Buffer.concat([Buffer.from([5]), party.creds.signedPreKey.keyPair.public]),
      signature: party.creds.signedPreKey.signature
    },
    preKey: { keyId: preKeyId, publicKey: Buffer.concat([Buffer.from([5]), preKey.public]) }
  }
}

test('signal: sesión 1:1 completa — pkmsg, respuesta msg y consumo del prekey', async () => {
  const alice = makeParty()
  const bob = makeParty()
  const aliceJid = '5491100000001@s.whatsapp.net'
  const bobJid = '5491100000002@s.whatsapp.net'

  await signal.injectSession(alice, bobJid, bundleFor(bob, 7))
  assert.ok(signal.hasSession(alice, bobJid))

  const first = await signal.encrypt(alice, bobJid, Buffer.from('primer mensaje'))
  assert.equal(first.type, 'pkmsg')
  const plain = await signal.decrypt(bob, aliceJid, first.type, first.ciphertext)
  assert.equal(Buffer.from(plain).toString(), 'primer mensaje')
  assert.equal(bob.keys.preKeys[7], undefined, 'el prekey de un solo uso se elimina al consumirse')

  const reply = await signal.encrypt(bob, aliceJid, Buffer.from('respuesta'))
  assert.equal(reply.type, 'msg')
  assert.equal(Buffer.from(await signal.decrypt(alice, bobJid, reply.type, reply.ciphertext)).toString(), 'respuesta')

  // El ratchet avanza: varios mensajes seguidos siguen descifrando.
  for (let i = 0; i < 5; i++) {
    const m = await signal.encrypt(alice, bobJid, Buffer.from(`n${i}`))
    assert.equal(Buffer.from(await signal.decrypt(bob, aliceJid, m.type, m.ciphertext)).toString(), `n${i}`)
  }
})

test('signal: trustPolicy tofu rechaza un cambio de identidad y avisa por el hook', async () => {
  const bob = makeParty()
  const jid = '5491100000003@s.whatsapp.net'
  const storage = signal.makeStorage(bob, { trustPolicy: 'tofu', onIdentityChange: (info) => events.push(info) })
  const events = []
  const id = signal.addrKey(jid)
  assert.equal(await storage.isTrustedIdentity(id, crypto.randomBytes(33)), true, 'primera identidad: se confía')
  assert.equal(await storage.isTrustedIdentity(id, crypto.randomBytes(33)), false, 'identidad distinta: tofu la rechaza')
  assert.equal(events.length, 1)
  assert.equal(events[0].id, id)
  assert.equal(events[0].accepted, false)
  assert.equal(events[0].policy, 'tofu')
  assert.match(events[0].previous, /^[0-9a-f]{64}$/)
  assert.match(events[0].next, /^[0-9a-f]{64}$/)
  assert.equal(bob.keys.identityHistory.length, 1, 'el cambio rechazado queda auditado')
})

// ---------------------------------------------------------------------------
// Sender keys (grupos)
// ---------------------------------------------------------------------------

test('senderkey: distribución, cifrado en orden y fuera de orden, y rechazo de duplicados', () => {
  const sender = makeParty()
  const receiver = makeParty()
  const group = '120363000000000001@g.us'
  const address = '5491100000004.0'

  const own = senderkey.ensureOwn(sender, group, address)
  senderkey.processDistribution(receiver, group, address, senderkey.distribution(own))

  const m0 = senderkey.encrypt(sender, group, address, Buffer.from('cero'))
  const m1 = senderkey.encrypt(sender, group, address, Buffer.from('uno'))
  const m2 = senderkey.encrypt(sender, group, address, Buffer.from('dos'))

  assert.equal(senderkey.decrypt(receiver, group, address, m0).toString(), 'cero')
  assert.equal(senderkey.decrypt(receiver, group, address, m2).toString(), 'dos', 'salta la iteración 1 y guarda su clave')
  assert.equal(senderkey.decrypt(receiver, group, address, m1).toString(), 'uno', 'la clave saltada se usa una vez')
  assert.throws(() => senderkey.decrypt(receiver, group, address, m1), { errorCode: ErrorCode.SENDER_KEY_DUPLICATE })
})

test('senderkey: sin clave, firma alterada o salto excesivo dan errores con código estable', () => {
  const sender = makeParty()
  const receiver = makeParty()
  const group = '120363000000000002@g.us'
  const address = '5491100000005.0'
  const own = senderkey.ensureOwn(sender, group, address)
  const message = senderkey.encrypt(sender, group, address, Buffer.from('hola'))

  assert.throws(() => senderkey.decrypt(receiver, group, address, message), (err) => isZyrixError(err) && err.errorCode === ErrorCode.SENDER_KEY_MISSING && err.kind === 'no-session')

  senderkey.processDistribution(receiver, group, address, senderkey.distribution(own))
  const tampered = Buffer.from(message)
  tampered[tampered.length - 1] ^= 1
  assert.throws(() => senderkey.decrypt(receiver, group, address, tampered), { errorCode: ErrorCode.SENDER_KEY_SIGNATURE_INVALID })

  // Salta la iteración del emisor más allá de MAX_SKIP (2000) sin cifrar miles de mensajes.
  own.iteration += 2005
  const far = senderkey.encrypt(sender, group, address, Buffer.from('lejos'))
  assert.throws(() => senderkey.decrypt(receiver, group, address, far), { errorCode: ErrorCode.SENDER_KEY_JUMP_TOO_LARGE })
})

test('senderkey: pbEncode/pbDecode hacen ida y vuelta con varints grandes', () => {
  const encoded = senderkey.pbEncode([[1, 2147483646], [2, 300], [3, Buffer.from('abc')]])
  const decoded = senderkey.pbDecode(encoded)
  assert.equal(decoded[1], 2147483646)
  assert.equal(decoded[2], 300)
  assert.equal(Buffer.from(decoded[3]).toString(), 'abc')
  assert.throws(() => senderkey.pbDecode(Buffer.from([0x1a, 0x05, 0x61])), { errorCode: ErrorCode.SENDER_KEY_MALFORMED })
})

// ---------------------------------------------------------------------------
// App-state (sincronización de chats)
// ---------------------------------------------------------------------------

const buildMutation = (keyId, keyData, index, value) => {
  const k = hkdf(keyData, 160, null, 'WhatsApp Mutation Keys')
  const indexKey = k.subarray(0, 32)
  const valueEncryptionKey = k.subarray(32, 64)
  const valueMacKey = k.subarray(64, 96)
  const indexBuf = Buffer.from(JSON.stringify(index))
  const plain = Buffer.from(proto.SyncActionData.encode({ index: indexBuf, value, padding: Buffer.alloc(0), version: 2 }).finish())
  const iv = crypto.randomBytes(16)
  const content = Buffer.concat([iv, aesCbcEncrypt(plain, valueEncryptionKey, iv)])
  const len = Buffer.alloc(8)
  len.writeUInt32BE(keyId.length + 1, 4)
  const mac = crypto.createHmac('sha512', valueMacKey).update(Buffer.concat([Buffer.from([1]), keyId, content, len])).digest().subarray(0, 32)
  return {
    operation: 0,
    record: { keyId: { id: keyId }, value: { blob: Buffer.concat([content, mac]) }, index: { blob: hmacSha256(indexBuf, indexKey) } }
  }
}

const fakeAppStateSocket = (keyId, keyData) => {
  const state = { creds: initCreds(), keys: initKeys() }
  state.keys.appStateKeys[keyId.toString('base64')] = { keyData }
  const mutations = []
  const errors = []
  return {
    auth: { state, save() {} },
    mutations,
    errors,
    emitMutation: (index, value, operation) => mutations.push({ index, value, operation }),
    emit: (name, err) => name === 'error' && errors.push(err)
  }
}

test('app-state: una mutación válida se descifra, se emite y actualiza el LTHash', () => {
  const keyId = crypto.randomBytes(6)
  const keyData = crypto.randomBytes(32)
  const sock = fakeAppStateSocket(keyId, keyData)
  const mutation = buildMutation(keyId, keyData, ['mute', '5491100000006@s.whatsapp.net'], { timestamp: 1732240000, muteAction: { muted: true, muteEndTimestamp: 0 } })
  const result = appstate.applyMutations.call(sock, [mutation], 'regular_high')
  assert.deepEqual(result, { applied: 1, missing: 0 })
  assert.deepEqual(sock.mutations[0].index, ['mute', '5491100000006@s.whatsapp.net'])
  assert.equal(sock.mutations[0].value.muteAction.muted, true)
  const lthash = sock.auth.state.keys.appStateLTHash.regular_high
  assert.ok(lthash.hash.some((b) => b !== 0), 'el LTHash deja de ser cero')
  assert.equal(Object.keys(lthash.indexValueMap).length, 1)
})

test('app-state: un MAC alterado no aplica nada y emite APPSTATE_VALUE_MAC_INVALID', () => {
  const keyId = crypto.randomBytes(6)
  const keyData = crypto.randomBytes(32)
  const sock = fakeAppStateSocket(keyId, keyData)
  const mutation = buildMutation(keyId, keyData, ['pin_v1', '5491100000007@s.whatsapp.net'], { timestamp: 1, pinAction: { pinned: true } })
  mutation.record.value.blob[mutation.record.value.blob.length - 1] ^= 1
  const result = appstate.applyMutations.call(sock, [mutation], 'regular_low')
  assert.deepEqual(result, { applied: 0, missing: 1 })
  assert.equal(sock.mutations.length, 0)
  assert.equal(sock.errors[0].errorCode, ErrorCode.APPSTATE_VALUE_MAC_INVALID)
})

// ---------------------------------------------------------------------------
// Descarga de media: protección contra DNS rebinding
// ---------------------------------------------------------------------------

test('media: isPublicAddress clasifica rangos privados, especiales y públicos', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isPublicAddress(ip), false, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip)
})

test('media: el lookup usado al conectar rechaza hosts que resuelven a IPs privadas', async () => {
  await assert.rejects(
    new Promise((resolve, reject) => publicOnlyLookup('localhost', {}, (err, address) => (err ? reject(err) : resolve(address)))),
    /does not resolve exclusively to public IPs/
  )
})

test('media: un DNS que cambia de respuesta (rebinding) no logra conectar a una IP interna', async (t) => {
  // Primera resolución: IP pública (pasa la validación previa). Segunda, al conectar: loopback.
  // Antes, fetch volvía a resolver por su cuenta y conectaba a 127.0.0.1; ahora la conexión
  // usa el mismo lookup validado y se corta antes de abrir el socket.
  let calls = 0
  t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    if (typeof options === 'function') callback = options
    calls++
    const address = calls === 1 ? '93.184.216.34' : '127.0.0.1'
    callback(null, [{ address, family: 4 }])
  })
  await assert.rejects(toBuffer({ url: 'http://rebind.example/secret' }, 1024), { errorCode: ErrorCode.MEDIA_URL_BLOCKED })
  assert.ok(calls >= 2, 'la conexión volvió a pasar por el lookup validado')
})

// ---------------------------------------------------------------------------
// Snapshot cifrado: la clave se deriva una sola vez por sesión
// ---------------------------------------------------------------------------

test('auth: el codec reutiliza la clave derivada pero usa un IV distinto en cada escritura', () => {
  const codec = createSnapshotCodec('una clave de prueba suficientemente larga')
  const state = { creds: { a: 1 }, keys: { b: Buffer.from('x') } }
  const one = JSON.parse(codec.serialize(state))
  const two = JSON.parse(codec.serialize(state))
  assert.equal(one.salt, two.salt, 'mismo salt: no se vuelve a correr scrypt')
  assert.notEqual(one.iv, two.iv, 'IV nuevo en cada escritura')
  assert.notEqual(one.data, two.data)
  const restored = parseAuthSnapshot(JSON.stringify(two), 'una clave de prueba suficientemente larga')
  assert.equal(restored.creds.a, 1)
  assert.ok(Buffer.isBuffer(restored.keys.b))
})

test('auth: serializar muchas veces con el codec es mucho más rápido que derivar cada vez', () => {
  const codec = createSnapshotCodec('una clave de prueba suficientemente larga')
  const state = { creds: initCreds(), keys: {} }
  codec.serialize(state)
  const started = performance.now()
  for (let i = 0; i < 50; i++) codec.serialize(state)
  const elapsed = performance.now() - started
  // 50 derivaciones scrypt tardarían >1 s; con la clave en caché son milisegundos.
  assert.ok(elapsed < 500, `50 serializaciones tardaron ${elapsed.toFixed(1)} ms`)
})

test('errors: ZyrixError expone errorCode en toJSON y ErrorCode es inmutable', () => {
  const err = new ZyrixError('x', { kind: 'media', errorCode: ErrorCode.MEDIA_URL_BLOCKED })
  assert.equal(err.toJSON().errorCode, 'MEDIA_URL_BLOCKED')
  assert.ok(Object.isFrozen(ErrorCode))
})
