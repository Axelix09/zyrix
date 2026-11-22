import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

import * as signal from '../src/signal.js'
import { Curve } from '../src/crypto.js'
import { initCreds, initKeys } from '../src/auth.js'
import { parseMessage } from '../src/incoming.js'
import { MessageContext, socketMixin } from '../src/context.js'
import { createBot } from '../src/kit.js'

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
const identityKey = () => Buffer.concat([Buffer.from([5]), crypto.randomBytes(32)])
const idOf = '5491100000100@s.whatsapp.net'

test('identity: el primer contacto se confía sin registrar cambio', async () => {
  const state = makeParty()
  const events = []
  const storage = signal.makeStorage(state, { trustPolicy: 'tofu', onIdentityChange: (info) => events.push(info) })
  assert.equal(await storage.isTrustedIdentity(signal.addrKey(idOf), identityKey()), true)
  assert.deepEqual(events, [])
  // keys es un Proxy que materializa propiedades al leerlas; comprobar la propiedad real.
  assert.equal(Object.prototype.hasOwnProperty.call(state.keys, 'identityHistory'), false)
})

test('identity: tofu rechaza un cambio no autorizado, registra huellas y emite el evento', async () => {
  const state = makeParty()
  const events = []
  const storage = signal.makeStorage(state, { trustPolicy: 'tofu', onIdentityChange: (info) => events.push(info) })
  const id = signal.addrKey(idOf)
  await storage.isTrustedIdentity(id, identityKey())
  const stored = Buffer.from(state.keys.identityKeys[id])
  assert.equal(await storage.isTrustedIdentity(id, identityKey()), false)
  assert.deepEqual(Buffer.from(state.keys.identityKeys[id]), stored, 'la identidad guardada no cambia')
  assert.equal(events.length, 1)
  assert.equal(events[0].accepted, false)
  assert.equal(events[0].policy, 'tofu')
  assert.match(events[0].previous, /^[0-9a-f]{64}$/)
  assert.match(events[0].next, /^[0-9a-f]{64}$/)
  assert.equal(state.keys.identityHistory.length, 1)
})

test('identity: un rekey autorizado por política custom acepta y reemplaza', async () => {
  const state = makeParty()
  const events = []
  const seen = []
  const storage = signal.makeStorage(state, {
    trustPolicy: async (id, incoming, stored) => { seen.push([id, incoming.length, stored.length]); return true },
    onIdentityChange: (info) => events.push(info)
  })
  const id = signal.addrKey(idOf)
  await storage.isTrustedIdentity(id, identityKey())
  const next = identityKey()
  assert.equal(await storage.isTrustedIdentity(id, next), true)
  assert.deepEqual(Buffer.from(state.keys.identityKeys[id]), next)
  assert.deepEqual(seen, [[id, 33, 33]])
  assert.equal(events[0].accepted, true)
  assert.equal(events[0].policy, 'custom')
})

test('identity: la política update reemplaza, pero deja historial acotado', async () => {
  const state = makeParty()
  const storage = signal.makeStorage(state, { trustPolicy: 'update' })
  const id = signal.addrKey(idOf)
  await storage.isTrustedIdentity(id, identityKey())
  for (let i = 0; i < 60; i++) await storage.isTrustedIdentity(id, identityKey())
  assert.equal(state.keys.identityHistory.length, 50)
  assert.equal(state.keys.identityHistory.at(-1).accepted, true)
  assert.equal(state.keys.identityHistory.at(-1).policy, 'update')
})

test('identity: injectSession, encrypt y decrypt concurrentes quedan serializados por address', async () => {
  const alice = makeParty()
  const bob = makeParty()
  const aliceJid = '5491100000101@s.whatsapp.net'
  const bobJid = '5491100000102@s.whatsapp.net'

  const injected = signal.injectSession(alice, bobJid, bundleFor(bob, 11))
  const first = signal.encrypt(alice, bobJid, Buffer.from('concurrente'))
  const reinjected = signal.injectSession(alice, bobJid, bundleFor(bob, 12))
  await Promise.all([injected, reinjected])
  const message = await first
  assert.equal(message.type, 'pkmsg')
  const plaintext = await signal.decrypt(bob, aliceJid, message.type, message.ciphertext)
  assert.equal(Buffer.from(plaintext).toString(), 'concurrente')
})

// ---------------------------------------------------------------------------
// PN/LID aliases
// ---------------------------------------------------------------------------

const self = { id: '111111111111@s.whatsapp.net', lid: '999999999999999@lid' }
const ownOptions = { self: self.id, aliases: [self.lid] }
const event = (key, message) => ({ key: { id: 'm1', ...key }, message })

test('PN/LID: un mensaje propio enviado por PN o por LID se reconoce igual', () => {
  const viaPn = parseMessage(event({ remoteJid: '222@s.whatsapp.net', fromMe: true }, { conversation: 'pn' }), ownOptions)
  assert.equal(viaPn.fromMe, true)
  assert.equal(viaPn.sender, self.id)
  assert.equal(viaPn.senderAlt, self.lid, 'el alias LID propio queda disponible')

  const viaLid = parseMessage(event({ remoteJid: '222@lid', fromMe: true }, { conversation: 'lid' }), ownOptions)
  assert.equal(viaLid.fromMe, true)
  assert.equal(viaLid.sender, self.id)
})

test('PN/LID: grupo conserva participant y participantAlt y el quote con alias propio es fromMe', () => {
  const parsed = parseMessage(event(
    { remoteJid: '120363000000000000@g.us', fromMe: false, participant: '333@s.whatsapp.net', participantAlt: '888888888888888@lid' },
    {
      extendedTextMessage: {
        text: 'hola',
        contextInfo: { stanzaId: 'q1', participant: self.lid, participantAlt: self.id, quotedMessage: { conversation: 'mío' } }
      }
    }
  ), ownOptions)
  assert.equal(parsed.sender, '333@s.whatsapp.net')
  assert.equal(parsed.senderAlt, '888888888888888@lid')
  assert.equal(parsed.quoted.key.fromMe, true, 'el quote se compara contra PN y LID, no solo me.id')
  assert.equal(parsed.quoted.sender, self.lid)
})

const aliasSock = (extra = {}) => {
  const aliases = new Map([
    ['111111111111@s.whatsapp.net', ['111111111111@s.whatsapp.net', '999999999999999@lid']],
    ['999999999999999@lid', ['999999999999999@lid', '111111111111@s.whatsapp.net', '777777777777@s.whatsapp.net']],
    ['777777777777@s.whatsapp.net', ['777777777777@s.whatsapp.net', '999999999999999@lid']]
  ])
  return Object.assign(new EventEmitter(), {
    getJidAliases: (jid) => aliases.get(jid) || [jid],
    auth: { state: { creds: { me: self } } }
  }, extra)
}

test('PN/LID: isMentioned resuelve el alias PN y LID de la misma persona', () => {
  const ctx = new MessageContext(aliasSock(), {}, { chat: '120363000000000000@g.us', sender: '333@s.whatsapp.net', senderAlt: '444@lid', mentions: ['777777777777@s.whatsapp.net'] })
  assert.equal(ctx.isMentioned, true)
  const other = new MessageContext(aliasSock(), {}, { chat: '120363000000000000@g.us', sender: '333@s.whatsapp.net', senderAlt: '444@lid', mentions: ['555555555555@s.whatsapp.net'] })
  assert.equal(other.isMentioned, false)
})

test('PN/LID: owner se reconoce tanto en PN como en LID', () => {
  const byLid = createBot(aliasSock(), { prefix: '!', owners: ['999999999999999@lid'] })
  assert.equal(byLid.isOwner({ sender: '111111111111@s.whatsapp.net', senderAlt: undefined }), true)
  byLid.stop()
  const byPn = createBot(aliasSock(), { prefix: '!', owners: ['111111111111@s.whatsapp.net'] })
  assert.equal(byPn.isOwner({ sender: '999999999999999@lid', senderAlt: undefined }), true)
  byPn.stop()
})

test('PN/LID: ask() acepta una respuesta del mismo usuario con alias equivalente', async () => {
  const sock = aliasSock()
  sock.waitForMessage = (filter, timeout, options) => socketMixin.waitForMessage.call(sock, filter, timeout, options)
  const ctx = new MessageContext(sock, {}, { chat: '222@s.whatsapp.net', sender: '111111111111@s.whatsapp.net', senderAlt: '999999999999999@lid' })
  ctx.reply = async () => {
    sock.emit('message', { chat: '222@s.whatsapp.net', sender: '999999999999999@lid', fromMe: false })
  }
  const answer = await ctx.ask('¿sí?')
  assert.equal(answer.sender, '999999999999999@lid')
})
