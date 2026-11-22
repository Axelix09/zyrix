import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createMessage, createMessageEnvelope, createMessageContent, createMessageId, clientProfiles,
  fetchProtocolVersion, useZyrixAuth, readMediaStream, attachMessageDelivery
} from '../src/client.js'
import messaging from '../src/messages/messaging.js'
import { makeAuth, makeState } from './helpers/state.js'

const makeMessaging = (extra = {}) => {
  const events = Object.assign(new EventEmitter(), {
    auth: makeAuth(makeState()),
    deviceCache: new Map(),
    pending: new Map(),
    retries: new Map(),
    seen: new Map(),
    sentCache: new Map(),
    groupCache: new Map(),
    counter: 0,
    prefix: 'p',
    minSendIntervalMs: 0,
    lastSendAt: 0,
    signalHooks: {},
    sendNode() {},
    query: async () => ({}),
    ...extra
  })
  return Object.assign(events, messaging)
}

test('client: mensajes, envelope, contenido y perfiles', async () => {
  const envelope = createMessageEnvelope('jid', { conversation: 'hola' }, { messageId: 'id1', userJid: 'u' })
  assert.equal(envelope.key.id, 'id1')
  assert.equal(envelope.key.participant, 'u')
  const created = await createMessage('jid', 'hola', { messageId: 'id2' })
  assert.equal(created.message.conversation, 'hola')
  assert.equal(created.key.id, 'id2')
  const media = await createMessage('jid', { image: Buffer.from('x') })
  assert.ok(media.message.imageMessage)
  const content = await createMessageContent({ text: 'x' })
  assert.equal(content.conversation, 'x')
  assert.ok((await createMessageContent({ video: Buffer.from('x') })).videoMessage)
  assert.match(createMessageId(), /^\d+_/)
  assert.equal(clientProfiles.ubuntu()[0], 'Ubuntu')
})

test('client: versión de protocolo, auth de archivo y media stream', async (t) => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('"client_revision":12345')
  try {
    assert.deepEqual(await fetchProtocolVersion(), { version: [2, 3000, 12345] })
  } finally {
    globalThis.fetch = original
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-client-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const auth = await useZyrixAuth(dir)
  assert.ok(auth.state.creds)
  assert.equal(typeof auth.saveCreds, 'function')

  const sock = { downloadMedia: async () => Buffer.alloc(70000) }
  const chunks = []
  for await (const chunk of await readMediaStream(sock, {}, 'image')) chunks.push(chunk)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].length, 65536)
  await assert.rejects(readMediaStream(null, {}, 'image'), TypeError)
})

test('client: attachMessageDelivery prepara envíos, ids y álbum', async () => {
  const sent = []
  const sock = {
    sendMessage: async (...args) => { sent.push(args); return args },
    sendPrepared: undefined
  }
  attachMessageDelivery(sock)
  assert.equal(sock.__zyrixMessageDelivery, true)
  attachMessageDelivery(sock)
  const content = await createMessage('jid', 'hola', { messageId: 'm1' })
  await sock.sendPrepared('jid', content.message)
  assert.equal(sent[0][2].messageId, 'm1')

  const parent = { remoteJid: 'jid', fromMe: true, id: 'parent' }
  const first = await createMessage('jid', { text: 'a' })
  first.message.messageContextInfo = { messageAssociation: { parentMessageKey: parent, associationType: 1 } }
  const second = await createMessage('jid', { text: 'b' })
  second.message.messageContextInfo = { messageAssociation: { parentMessageKey: parent, associationType: 1 } }
  await sock.sendPrepared('jid', first.message)
  await sock.sendPrepared('jid', second.message)
  assert.equal(first.message.messageContextInfo.messageAssociation.messageIndex, 0)
  assert.equal(second.message.messageContextInfo.messageAssociation.messageIndex, 1)

  const raw = await createMessageEnvelope('jid', { conversation: 'raw' }, { messageId: 'raw1' })
  await sock.sendPrepared('jid', raw.message)
  assert.equal(sent.at(-1)[2].messageId, 'raw1')
})

test('messaging: getDevices consulta, cachea y deduplica dispositivos', async () => {
  const sock = makeMessaging()
  sock.query = async () => ({
    tag: 'iq', content: [{
      tag: 'usync', content: [{
        tag: 'list', content: [
          { tag: 'user', attrs: { jid: '5491100000002@s.whatsapp.net' }, content: [{ tag: 'devices', content: [{ tag: 'device-list', content: [{ tag: 'device', attrs: { id: '0' } }, { tag: 'device', attrs: { id: '2' } }, { tag: 'device', attrs: { id: '99' } }] }] }] },
          { tag: 'user', attrs: { jid: '5491100000001@s.whatsapp.net' }, content: [{ tag: 'devices', content: [{ tag: 'device-list', content: [{ tag: 'device', attrs: { id: '3' } }] }] }] }
        ]
      }]
    }]
  })
  const devices = await sock.getDevices(['5491100000002', '5491100000002@s.whatsapp.net', '5491100000001'])
  assert.deepEqual(devices, ['5491100000002@s.whatsapp.net', '5491100000002:2@s.whatsapp.net'])
  await sock.getDevices(['5491100000002'])
  assert.equal(sock.deviceCache.get('5491100000002@s.whatsapp.net').length, 2)
})

test('messaging: fetchSessions ignora usuarios con error y participantNodes informa faltantes', async () => {
  const sock = makeMessaging()
  const calls = []
  sock.query = async (node) => {
    calls.push(node)
    return { tag: 'iq', content: [{ tag: 'list', content: [
      { tag: 'user', attrs: { jid: 'a@s.whatsapp.net' }, content: [{ tag: 'error', attrs: {} }] },
      { tag: 'user', attrs: { jid: 'b@s.whatsapp.net' }, content: [] }
    ] }] }
  }
  const errors = []
  sock.on('error', (e) => errors.push(e))
  await sock.fetchSessions(['a@s.whatsapp.net', 'b@s.whatsapp.net'])
  assert.equal(calls[0].content[0].tag, 'key')
  await sock.fetchSessions(['a@s.whatsapp.net'], true)
  assert.equal(calls[1].content[0].content[0].attrs.reason, 'identity')

  const result = await sock.participantNodes(['x@s.whatsapp.net'], () => Buffer.from('p'))
  assert.equal(result.nodes.length, 0)
  assert.deepEqual(result.missing, ['x@s.whatsapp.net'])
})

test('messaging: throttle, waitForAck, deliver y withGroupExpiration', async () => {
  const sock = makeMessaging({ minSendIntervalMs: 20 })
  sock.lastSendAt = Date.now()
  const before = Date.now()
  await sock.throttle()
  assert.ok(Date.now() - before >= 10)

  const slow = makeMessaging()
  const ack = slow.waitForAck('id', 5)
  assert.equal(await ack, null)
  assert.equal(slow.pending.size, 0)

  const deliver = makeMessaging()
  deliver.run = (fn) => fn()
  deliver.relay = async (_chat, message, opts) => ({ key: { id: opts.id }, message, ack: Promise.resolve({ attrs: { t: '10' } }) })
  const sent = await deliver.deliver('jid', { conversation: 'x' }, { id: '1' })
  assert.equal(sent.status, 'sent')
  assert.equal(sent.messageTimestamp, 10)

  const failed = makeMessaging()
  failed.run = (fn) => fn()
  failed.relay = async (_chat, message) => ({ key: {}, message, ack: Promise.resolve({ attrs: { error: '403' } }) })
  await assert.rejects(failed.deliver('jid', {}, { id: '2' }), /server rejected/)

  const unconfirmed = makeMessaging()
  unconfirmed.run = (fn) => fn()
  unconfirmed.relay = async (chat, message) => ({ key: {}, message, ack: Promise.resolve(null) })
  assert.equal((await unconfirmed.deliver('jid', {}, { id: '3' })).status, 'unconfirmed')

  sock.groupCache.set('g@g.us', { ephemeralDuration: 3600 })
  assert.equal(sock.withGroupExpiration('g@g.us', {}, {}).expiration, 3600)
  assert.equal(sock.withGroupExpiration('g@g.us', {}, { expiration: 0 }).expiration, 0)
  assert.equal(sock.withGroupExpiration('g@g.us', { delete: {} }, {}).expiration, undefined)
  assert.equal(sock.withGroupExpiration('u@s.whatsapp.net', {}, {}).expiration, undefined)
})

test('messaging: sendMessage rutea cada tipo y envía texto', async () => {
  const sock = makeMessaging()
  const routed = []
  Object.assign(sock, {
    sendMedia: async (...a) => { routed.push(['media', ...a]) },
    sendButtons: async (...a) => { routed.push(['buttons', ...a]) },
    sendList: async (...a) => { routed.push(['list', ...a]) },
    sendPoll: async (...a) => { routed.push(['poll', ...a]) },
    sendLocation: async (...a) => { routed.push(['location', ...a]) },
    sendContact: async (...a) => { routed.push(['contact', ...a]) },
    sendContacts: async (...a) => { routed.push(['contacts', ...a]) },
    deliver: async (...a) => { routed.push(['deliver', ...a]); return 'ok' }
  })
  await sock.sendMessage('5491100000002', { image: Buffer.from('x') })
  await sock.sendMessage('5491100000002', { buttons: [{ id: 'a', text: 'A' }] })
  await sock.sendMessage('5491100000002', { list: { sections: [] } })
  await sock.sendMessage('5491100000002', { poll: { text: 'p', options: [] } })
  await sock.sendMessage('5491100000002', { location: { latitude: 0, longitude: 0 } })
  await sock.sendMessage('5491100000002', { contact: { displayName: 'A', vcard: 'v' } })
  await sock.sendMessage('5491100000002', { contacts: [] })
  assert.deepEqual(routed.map(([name]) => name), ['media', 'buttons', 'list', 'poll', 'location', 'contact', 'contacts'])

  const text = await sock.sendMessage('5491100000002', 'hola', { messageId: 'm' })
  assert.equal(text, 'ok')
  assert.equal(routed.at(-1)[0], 'deliver')
  assert.equal(routed.at(-1)[1], '5491100000002@s.whatsapp.net')
})

test('messaging: sendRetry limita intentos y adjunta claves desde el segundo', () => {
  const sock = makeMessaging()
  const state = sock.auth.state
  state.creds.registrationId = 7
  state.creds.nextPreKeyId = 1
  state.creds.signedPreKey = { keyId: 2, keyPair: { public: Buffer.alloc(32) }, signature: Buffer.alloc(64) }
  state.keys.preKeys = {}
  const sent = []
  sock.sendNode = (n) => sent.push(n)
  sock.sendRetry({ attrs: { id: 'x', from: 'a' } })
  assert.equal(sent[0].content.length, 2)
  sock.sendRetry({ attrs: { id: 'x', from: 'a', participant: 'p', recipient: 'r' } })
  assert.equal(sent[1].attrs.participant, 'p')
  assert.equal(sent[1].attrs.recipient, 'r')
  assert.ok(sent[1].content.some((n) => n.tag === 'keys'))
  for (let i = 0; i < 5; i++) sock.sendRetry({ attrs: { id: 'x', from: 'a' } })
  assert.equal(sent.length, 5)
})

test('messaging: onRetryReceipt sin caché, con tope y con reintento', async () => {
  const sock = makeMessaging()
  const sent = []
  sock.sendNode = (n) => sent.push(n)
  await sock.onRetryReceipt({ attrs: { id: 'nope', from: 'a@s.whatsapp.net' } })
  assert.equal(sent.length, 0)

  sock.sentCache.set('id', { chat: 'chat', message: { conversation: 'x' } })
  await sock.onRetryReceipt({ attrs: { id: 'id', from: 'a@s.whatsapp.net' }, content: [{ tag: 'retry', attrs: { count: '9' } }] })
  assert.equal(sent.length, 0)

  const relayed = []
  sock.relay = async (...args) => relayed.push(args)
  sock.fetchSessions = async () => {}
  await sock.onRetryReceipt({ attrs: { id: 'id', from: 'a@s.whatsapp.net', participant: 'p@s.whatsapp.net' }, content: [{ tag: 'retry', attrs: { count: '1' } }] })
  assert.equal(relayed.length, 1)
  assert.equal(relayed[0][2].onlyDevice, 'p@s.whatsapp.net')
  assert.equal(relayed[0][2].retryCount, 1)

  const recovered = makeMessaging({ getMessage: async () => ({ message: { conversation: 'r' } }) })
  recovered.query = async () => ({ tag: 'iq', content: [] })
  recovered.relay = async (...args) => relayed.push(args)
  await recovered.onRetryReceipt({ attrs: { id: 'x', from: 'a@s.whatsapp.net' } })
  assert.equal(relayed.length, 2)
})

test('messaging: onMessage deduplica, falla y reintenta con ack', async () => {
  const sock = makeMessaging()
  const sent = []
  sock.sendNode = (n) => sent.push(n)
  sock.seen.set('a@s.whatsapp.net||1', true)
  await sock.onMessage({ attrs: { id: '1', from: 'a@s.whatsapp.net' }, content: [] })
  assert.equal(sent[0].tag, 'ack')
  assert.equal(sent.length, 1)

  const failing = makeMessaging()
  failing.sendNode = (n) => sent.push(n)
  const retried = []
  failing.sendRetry = async (n) => retried.push(n)
  const errors = []
  failing.on('error', (e) => errors.push(e))
  await failing.onMessage({ attrs: { id: '2', from: 'a@s.whatsapp.net' }, content: [{ tag: 'enc', attrs: { type: 'msg' }, content: Buffer.from('x') }] })
  assert.ok(errors[0].errorCode)
  assert.equal(retried.length, 1)

  const processed = makeMessaging()
  processed.sendNode = (n) => sent.push(n)
  processed.handleDecrypted = () => true
  processed.seen.set('a@s.whatsapp.net||3', false)
  await processed.onMessage({ attrs: { id: '3', from: 'a@s.whatsapp.net' }, content: [{ tag: 'enc', attrs: { type: 'desconocido' }, content: Buffer.from('x') }] })
  assert.ok(sent.some((n) => n.tag === 'receipt'))
})

test('messaging: handleDecrypted cubre deviceSent, protocolo interno y contenido vacío', () => {
  const sock = makeMessaging()
  const upserts = []
  sock.on('messages.upsert', (e) => upserts.push(e))
  sock.syncAppState = async () => {}
  sock.rememberContact = () => {}
  assert.equal(sock.handleDecrypted({ attrs: { id: '1', from: 'a', notify: 'Ana', t: '10' } }, { conversation: 'hola' }), true)
  assert.equal(upserts[0].pushName, 'Ana')
  assert.equal(sock.handleDecrypted({ attrs: { id: '2', from: 'a' } }, { deviceSentMessage: { destinationJid: 'b', message: { conversation: 'yo' } } }), true)
  assert.equal(upserts[1].key.fromMe, true)
  assert.equal(sock.handleDecrypted({ attrs: { id: '3', from: 'a' } }, { protocolMessage: { appStateSyncKeyShare: { keys: [{ keyId: { keyId: Buffer.from('k') }, keyData: { keyData: Buffer.from('d') } }] } } }), false)
  assert.equal(sock.handleDecrypted({ attrs: { id: '4', from: 'a' } }, { protocolMessage: { historySyncNotification: {} } }), false)
  assert.equal(sock.handleDecrypted({ attrs: { id: '5', from: 'a' } }, { senderKeyDistributionMessage: {} }), false)
  sock.learnAlternates({ from: 'g@g.us', participant: 'p@lid', participant_pn: 'p@s.whatsapp.net' }, { remember() {} })
  sock.learnAlternates({ from: 'a@s.whatsapp.net', sender_lid: 'l@lid' }, { remember() {} })
})
