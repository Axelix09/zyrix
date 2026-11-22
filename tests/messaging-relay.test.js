import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import messaging from '../src/messages/messaging.js'
import * as signal from '../src/signal.js'
import * as senderkey from '../src/senderkey.js'
import { Curve } from '../src/crypto.js'
import { initCreds, initKeys } from '../src/auth.js'
import { makeState } from './helpers/state.js'

const party = () => ({ creds: initCreds(), keys: initKeys() })
const withPrefix = (key) => Buffer.concat([Buffer.from([5]), key])
const bundleFor = (p, preKeyId = 1) => {
  const preKey = Curve.generateKeyPair()
  p.keys.preKeys[preKeyId] = preKey
  return {
    registrationId: p.creds.registrationId,
    identityKey: withPrefix(p.creds.signedIdentityKey.public),
    signedPreKey: { keyId: p.creds.signedPreKey.keyId, publicKey: withPrefix(p.creds.signedPreKey.keyPair.public), signature: p.creds.signedPreKey.signature },
    preKey: { keyId: preKeyId, publicKey: withPrefix(preKey.public) }
  }
}

const BOB = '5491100000020:2@s.whatsapp.net'
const BOB_CHAT = '5491100000020@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'

const makeSock = (state, extra = {}) => {
  const sent = []
  const warnings = []
  const errors = []
  const sock = Object.assign(new EventEmitter(), messaging, {
    auth: { state, save() {} },
    deviceCache: new Map(),
    groupCache: new Map(),
    sentCache: new Map(),
    pending: new Map(),
    retries: new Map(),
    seen: new Map(),
    signalHooks: {},
    minSendIntervalMs: 0,
    counter: 0,
    prefix: 't',
    logger: { error() {} },
    sendNode(node) { sent.push(node) },
    query: async () => ({}),
    ...extra
  })
  sock.on('send.warning', (w) => warnings.push(w))
  sock.on('error', (e) => errors.push(e))
  return { sock, sent, warnings, errors }
}

const direct = async () => {
  const alice = makeState()
  const bob = party()
  await signal.injectSession(alice, BOB, bundleFor(bob))
  return { alice, bob }
}

test('messaging: relay directo cifra por dispositivo, guarda el mensaje y adjunta identity', async () => {
  const { alice } = await direct()
  const { sock, sent } = makeSock(alice, { getDevices: async () => [BOB] })
  const result = await sock.relay(BOB_CHAT, { conversation: 'hola' }, { id: 'd1', mediaType: 'image' })
  assert.equal(result.key.id, 'd1')
  assert.equal(sent.length, 1)
  const stanza = sent[0]
  assert.equal(stanza.tag, 'message')
  assert.equal(stanza.attrs.id, 'd1')
  assert.equal(stanza.attrs.to, BOB_CHAT)
  assert.equal(stanza.attrs.type, 'text')
  const enc = stanza.content.find((n) => n.tag === 'participants').content[0].content[0]
  assert.equal(enc.attrs.type, 'pkmsg')
  assert.equal(enc.attrs.mediatype, 'image')
  assert.ok(stanza.content.some((n) => n.tag === 'device-identity'), 'incluye la identidad al crear sesión')
  assert.equal(sock.sentCache.get('d1').chat, BOB_CHAT)
})

test('messaging: relay directo solo a un dispositivo, con retryCount y recipient propio', async () => {
  const { alice } = await direct()
  const { sock, sent } = makeSock(alice)
  await sock.relay(BOB_CHAT, { conversation: 'x' }, { id: 'only', onlyDevice: BOB, retryCount: 2 })
  const stanza = sent[0]
  assert.equal(stanza.attrs.to, BOB)
  assert.equal(stanza.content.find((n) => n.tag === 'enc').attrs.count, '2')
  assert.equal(stanza.content.some((n) => n.tag === 'participants'), false)

  const missing = makeSock(alice, {})
  await assert.rejects(missing.sock.relay(BOB_CHAT, { conversation: 'x' }, { onlyDevice: '5491100000099:1@s.whatsapp.net' }), { errorCode: 'DEVICE_SESSION_MISSING' })
})

test('messaging: relay falla si el destinatario no tiene dispositivos y limpia el ack pendiente', async () => {
  const { alice } = await direct()
  const { sock } = makeSock(alice, { getDevices: async () => [] })
  await assert.rejects(sock.relay(BOB_CHAT, { conversation: 'x' }, { id: 'none' }), { errorCode: 'RECIPIENT_SESSION_FAILED' })

  const { sock: failing } = makeSock(alice, {
    getDevices: async () => [BOB],
    sendNode() { throw new Error('sin red') }
  })
  await assert.rejects(failing.relay(BOB_CHAT, { conversation: 'x' }, { id: 'offline', waitAck: true }), /sin red/)
  assert.equal(failing.pending.has('offline'), false)
})

test('messaging: relay a grupo distribuye sender key una vez y emite skmsg', async () => {
  const { alice } = await direct()
  const { sock, sent } = makeSock(alice, {
    groupMetadata: async () => ({ addressingMode: 'pn', participants: [{ id: BOB }] }),
    getDevices: async () => [BOB]
  })
  await sock.relay(GROUP, { conversation: 'grupo' }, { id: 'g1' })
  const first = sent[0]
  assert.equal(first.attrs.addressing_mode, 'pn')
  assert.ok(first.content.some((n) => n.tag === 'participants'), 'la primera vez manda la distribución')
  assert.equal(first.content.find((n) => n.tag === 'enc').attrs.type, 'skmsg')

  await sock.relay(GROUP, { conversation: 'otra' }, { id: 'g2' })
  assert.equal(sent[1].content.some((n) => n.tag === 'participants'), false, 'ya no redistribuye')
  assert.equal(sent[1].content.find((n) => n.tag === 'enc').attrs.type, 'skmsg')

  const warn = makeSock(alice, {
    groupMetadata: async () => ({ addressingMode: 'pn', participants: [{ id: '5491100000099@s.whatsapp.net' }] }),
    getDevices: async () => ['5491100000099@s.whatsapp.net']
  })
  await warn.sock.relay(GROUP, { conversation: 'x' }, { id: 'g3' })
  assert.equal(warn.warnings[0].missingDevices[0], '5491100000099@s.whatsapp.net')
})

test('messaging: relay a grupo LID elige el participante LID y su modo', async () => {
  const { alice } = await direct()
  alice.creds.me.lid = '100000000000001@lid'
  const lidJid = '200000000000002@lid'
  await signal.injectSession(alice, lidJid, bundleFor(party()))
  const { sock, sent } = makeSock(alice, {
    groupMetadata: async () => ({ addressingMode: 'lid', participants: [{ id: BOB_CHAT, lid: lidJid, phoneNumber: BOB_CHAT }] }),
    getDevices: async () => [lidJid]
  })
  await sock.relay(GROUP, { conversation: 'lid' }, { id: 'l1' })
  assert.equal(sent[0].attrs.addressing_mode, 'lid')
  assert.ok(sent[0].content.some((n) => n.tag === 'participants'))

  await sock.relay(GROUP, { conversation: 'lid' }, { id: 'l2', onlyDevice: lidJid })
  assert.equal(sent[1].attrs.participant, lidJid)
  assert.equal(sent[1].content.some((n) => n.tag === 'participants'), false)
})

test('messaging: onRetryReceipt reinyecta las claves incluidas y reenvía al dispositivo', async () => {
  const { alice, bob } = await direct()
  const { sock, sent } = makeSock(alice)
  sock.sentCache.set('r1', { chat: BOB_CHAT, message: { conversation: 'recuperado' } })
  const preKey = Curve.generateKeyPair()
  bob.keys.preKeys[77] = preKey
  const node = {
    attrs: { id: 'r1', from: BOB_CHAT, participant: BOB },
    content: [
      { tag: 'retry', attrs: { count: '1' } },
      { tag: 'registration', attrs: {}, content: Buffer.from([0, 0, 0, 4]) },
      { tag: 'keys', attrs: {}, content: [
        { tag: 'type', attrs: {}, content: Buffer.from([5]) },
        { tag: 'identity', attrs: {}, content: withPrefix(bob.creds.signedIdentityKey.public) },
        { tag: 'key', attrs: {}, content: [
          { tag: 'id', attrs: {}, content: Buffer.from([0, 0, 77]) },
          { tag: 'value', attrs: {}, content: withPrefix(preKey.public) }
        ] },
        { tag: 'skey', attrs: {}, content: [
          { tag: 'id', attrs: {}, content: Buffer.from([0, 0, bob.creds.signedPreKey.keyId]) },
          { tag: 'value', attrs: {}, content: withPrefix(bob.creds.signedPreKey.keyPair.public) },
          { tag: 'signature', attrs: {}, content: bob.creds.signedPreKey.signature }
        ] }
      ] }
    ]
  }
  await sock.onRetryReceipt(node)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].attrs.to, BOB)
  assert.equal(sent[0].content.find((n) => n.tag === 'enc').attrs.count, '1')
  assert.ok(signal.hasSession(alice, BOB))
})

test('messaging: onMessage registra fallos de procesamiento y responde receipt con participant', async () => {
  const { alice, bob } = await direct()
  await signal.injectSession(bob, alice.creds.me.id, bundleFor(alice))
  const plain = await signal.encrypt(bob, alice.creds.me.id, Buffer.from('hola'))
  const { sock, sent, errors } = makeSock(alice)
  const logged = []
  sock.logger = { error: (...args) => logged.push(args) }
  sock.handleDecrypted = () => { throw new Error('fallo interno') }
  await sock.onMessage({
    attrs: { id: 'p1', from: BOB_CHAT, participant: BOB },
    content: [{ tag: 'enc', attrs: { type: plain.type }, content: plain.ciphertext }]
  })
  assert.equal(errors[0].errorCode, 'MESSAGE_PROCESSING_FAILED')
  assert.equal(logged.length, 1)
  const receipt = sent.find((n) => n.tag === 'receipt')
  assert.equal(receipt.attrs.participant, BOB)
})

test('messaging: handleDecrypted procesa una distribución de sender key del grupo', async () => {
  const alice = makeState()
  const sender = makeState()
  const address = signal.addrKey(sender.creds.me.id)
  const own = senderkey.ensureOwn(sender, GROUP, address)
  const message = { conversation: 'con distribución', senderKeyDistributionMessage: { groupId: GROUP, axolotlSenderKeyDistributionMessage: senderkey.distribution(own) } }
  const { sock } = makeSock(alice)
  sock.rememberContact = () => {}
  const received = []
  sock.on('messages.upsert', (e) => received.push(e))
  assert.equal(sock.handleDecrypted({ attrs: { id: 'sk1', from: GROUP, participant: sender.creds.me.id } }, message), true)
  assert.equal(received.length, 1)
  assert.equal(senderkey.decrypt(alice, GROUP, address, senderkey.encrypt(sender, GROUP, address, Buffer.from('x'))).toString(), 'x')
})
