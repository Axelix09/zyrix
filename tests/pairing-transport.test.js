import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import WebSocket from 'ws'
import pairing from '../src/pairing.js'
import { Transport, WA_HEADER } from '../src/transport.js'
import { Curve, hkdf, gcmEncrypt, aesCtr, pbkdf2 } from '../src/crypto.js'
import { makeState } from './helpers/state.js'

const makePairing = () => {
  const state = makeState()
  state.creds.pairingEphemeralKeyPair = Curve.generateKeyPair()
  state.creds.noiseKey = Curve.generateKeyPair()
  state.creds.advSecretKey = crypto.randomBytes(32).toString('base64')
  const queries = []
  const sock = Object.assign({}, pairing, {
    auth: { state, save() { sock.saved = (sock.saved || 0) + 1 } },
    query: async (node) => { queries.push(node); return { tag: 'iq' } },
    sendNode: (node) => queries.push(node),
    browser: ['Ubuntu', 'Chrome', '1.0'],
    prefix: 'p',
    counter: 0
  })
  return { sock, state, queries }
}

test('pairing: requestPairingCode genera código, envía el hello y persiste', async () => {
  const { sock, state, queries } = makePairing()
  const code = await sock.requestPairingCode('+54 911 0000-0002')
  assert.match(code, /^[123456789ABCDEFGHJKLMNPQRSTVWXYZ]{8}$/)
  assert.equal(state.creds.me.id, '5491100000002@s.whatsapp.net')
  assert.equal(sock.pairingMode, true)
  assert.equal(sock.saved, 1)
  assert.equal(queries[0].content[0].tag, 'link_code_companion_reg')
  assert.equal(queries[0].content[0].content.length, 5)

  const failing = makePairing()
  failing.state.creds.registered = false
  failing.sock.query = async () => { throw new Error('sin red') }
  await assert.rejects(failing.sock.requestPairingCode('5491100000002'), /sin red/)
  assert.equal(failing.state.creds.pairingCode, undefined)
})

test('pairing: onLinkCode descifra el bundle, deriva advSecretKey y responde', async () => {
  const { sock, state, queries } = makePairing()
  const code = await sock.requestPairingCode('5491100000002')
  const primary = Curve.generateKeyPair()
  const primaryIdentity = Curve.generateKeyPair()
  const salt = crypto.randomBytes(32)
  const iv = crypto.randomBytes(16)
  const key = pbkdf2(Buffer.from(code), salt, 2 << 16, 32)
  const wrapped = Buffer.concat([salt, iv, aesCtr(primary.public, key, iv)])
  const ref = crypto.randomBytes(16)
  const node = {
    tag: 'notification',
    content: [{
      tag: 'link_code_companion_reg',
      attrs: {},
      content: [
        { tag: 'link_code_pairing_ref', attrs: {}, content: ref },
        { tag: 'primary_identity_pub', attrs: {}, content: primaryIdentity.public },
        { tag: 'link_code_pairing_wrapped_primary_ephemeral_pub', attrs: {}, content: wrapped }
      ]
    }]
  }
  await sock.onLinkCode(node)
  assert.ok(state.creds.advSecretKey)
  const finish = queries.at(-1)
  assert.equal(finish.content[0].attrs.stage, 'companion_finish')
  assert.ok(finish.content[0].content[0].content.length > 32)

  await sock.onLinkCode({ tag: 'notification', content: [] })
  state.creds.pairingCode = undefined
  await sock.onLinkCode(node)
})

test('pairing: onLinkCode usa sendNode si no hay query', async () => {
  const { sock, state, queries } = makePairing()
  const code = await sock.requestPairingCode('5491100000002')
  const primary = Curve.generateKeyPair()
  const identity = Curve.generateKeyPair()
  const salt = crypto.randomBytes(32)
  const iv = crypto.randomBytes(16)
  const key = pbkdf2(Buffer.from(code), salt, 2 << 16, 32)
  delete sock.query
  await sock.onLinkCode({
    content: [{ tag: 'link_code_companion_reg', content: [
      { tag: 'link_code_pairing_ref', content: Buffer.from('r') },
      { tag: 'primary_identity_pub', content: identity.public },
      { tag: 'link_code_pairing_wrapped_primary_ephemeral_pub', content: Buffer.concat([salt, iv, aesCtr(primary.public, key, iv)]) }
    ] }]
  })
  assert.equal(queries.at(-1).content[0].attrs.stage, 'companion_finish')
  assert.ok(state.creds.advSecretKey)
  assert.equal(hkdf(Buffer.alloc(32), 32, null, 'x').length, 32)
  assert.equal(gcmEncrypt(Buffer.from('x'), Buffer.alloc(32), Buffer.alloc(12), Buffer.alloc(0)).length > 0, true)
})

test('transport: send agrega el header una vez, valida payload y framing', () => {
  const transport = new Transport()
  transport.used = true
  const sent = []
  transport.ws = { readyState: WebSocket.OPEN, send: (b) => sent.push(b) }
  transport.send(Buffer.from('a'))
  transport.send(new Uint8Array([98]))
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0].subarray(0, 4), WA_HEADER)
  assert.equal(sent[0][4], 0)
  assert.equal(sent[1][0], 0)
  assert.equal(sent[1][1], 0)
  assert.equal(sent[1][2], 1)
  assert.deepEqual(sent[1].subarray(3), Buffer.from('b'))
  assert.throws(() => transport.send('x'), TypeError)
  transport.ws = null
  assert.throws(() => transport.send(Buffer.from('x')), { errorCode: 'TRANSPORT_NOT_CONNECTED' })
})

test('transport: onData reensambla, rechaza tamaños y frames truncados', () => {
  const transport = new Transport()
  transport.used = true
  const frames = []
  transport.on('frame', (f) => frames.push(Buffer.from(f)))
  transport.onData(Buffer.from([0, 0, 2, 65]))
  assert.equal(frames.length, 0)
  transport.onData(Buffer.from([66, 0, 0, 1, 67]))
  assert.deepEqual(frames, [Buffer.from('AB'), Buffer.from('C')])
  transport.onData(new Uint8Array([0, 0, 0]))
  assert.equal(frames.length, 3)

  const fresh = new Transport()
  assert.throws(() => fresh.onData(Buffer.from([0, 0, 0])), { errorCode: 'TRANSPORT_NOT_CONNECTED' })
  fresh.used = true
  assert.throws(() => fresh.onData(Buffer.alloc(0xffffff * 2 + 10)), RangeError)
  assert.doesNotThrow(() => fresh.onData(Buffer.from([0xff, 0xff, 0xfe])))
  fresh.close()
})

test('transport: close es idempotente y connect no se puede reutilizar', () => {
  const transport = new Transport()
  transport.used = true
  transport.close()
  let closed = 0
  transport.ws = { readyState: WebSocket.OPEN, close: () => closed++ }
  transport.close()
  assert.equal(closed, 1)
  transport.ws.readyState = WebSocket.CLOSED
  transport.close()
  assert.equal(closed, 1)
  transport.used = true
  assert.throws(() => transport.connect(), { errorCode: 'TRANSPORT_REUSED' })
})
