import libsignal from 'libsignal'
import crypto from 'crypto'
import { jidDecode, getChild } from './binary.js'
import { signalPub } from './crypto.js'
import { readBE } from './util.js'

const addr = (jid) => {
  const d = jidDecode(jid)
  return new libsignal.ProtocolAddress(d.user, d.device || 0)
}

const addrKey = (jid) => addr(jid).toString()

const makeStorage = (state, hooks = {}) => {
  state.keys.identityKeys ||= {}
  return {
  async loadSession(id) {
    const s = state.keys.sessions[id]
    return s ? libsignal.SessionRecord.deserialize(s) : null
  },
  async storeSession(id, record) {
    state.keys.sessions[id] = record.serialize()
  },
  async isTrustedIdentity(id, identityKey) {
    const incoming = Buffer.from(identityKey)
    const previous = state.keys.identityKeys[id]
    if (!previous) {
      state.keys.identityKeys[id] = Buffer.from(incoming)
      return true
    }
    const stored = Buffer.from(previous)
    if (stored.length === incoming.length && crypto.timingSafeEqual(stored, incoming)) return true
    const policy = hooks.trustPolicy || 'update'
    const accept = typeof policy === 'function' ? await policy(id, incoming, stored) : policy === 'update'
    if (accept) state.keys.identityKeys[id] = Buffer.from(incoming)
    if (typeof hooks.onIdentityChange === 'function') hooks.onIdentityChange({ id, accepted: Boolean(accept) })
    return Boolean(accept)
  },
  async loadPreKey(id) {
    const k = state.keys.preKeys[id]
    return k ? { privKey: Buffer.from(k.private), pubKey: Buffer.from(k.public) } : undefined
  },
  async removePreKey(id) {
    delete state.keys.preKeys[id]
  },
  async loadSignedPreKey() {
    const k = state.creds.signedPreKey.keyPair
    return { privKey: Buffer.from(k.private), pubKey: Buffer.from(k.public) }
  },
  getOurRegistrationId() {
    return state.creds.registrationId
  },
  getOurIdentity() {
    const k = state.creds.signedIdentityKey
    return { privKey: Buffer.from(k.private), pubKey: signalPub(k.public) }
  }
  }
}

const hasSession = (state, jid) => Boolean(state.keys.sessions[addrKey(jid)])

const deleteSession = (state, jid) => {
  delete state.keys.sessions[addrKey(jid)]
}

const deleteUserSessions = (state, jid) => {
  const prefix = `${jidDecode(jid).user}.`
  for (const key of Object.keys(state.keys.sessions)) {
    if (key.startsWith(prefix)) delete state.keys.sessions[key]
  }
}

const decrypt = async (state, jid, type, ciphertext, hooks) => {
  const cipher = new libsignal.SessionCipher(makeStorage(state, hooks), addr(jid))
  return type === 'pkmsg' ? cipher.decryptPreKeyWhisperMessage(ciphertext) : cipher.decryptWhisperMessage(ciphertext)
}

const encrypt = async (state, jid, data, hooks) => {
  const cipher = new libsignal.SessionCipher(makeStorage(state, hooks), addr(jid))
  const { type, body } = await cipher.encrypt(data)
  return { type: type === 3 ? 'pkmsg' : 'msg', ciphertext: Buffer.from(body, 'binary') }
}

const injectSession = async (state, jid, bundle, hooks) => {
  const builder = new libsignal.SessionBuilder(makeStorage(state, hooks), addr(jid))
  await builder.initOutgoing(bundle)
}

const parseBundle = (user) => {
  const skey = getChild(user, 'skey')
  const key = getChild(user, 'key')
  const part = (n) => ({
    keyId: readBE(getChild(n, 'id').content),
    publicKey: signalPub(getChild(n, 'value').content)
  })
  return {
    registrationId: readBE(getChild(user, 'registration').content),
    identityKey: signalPub(getChild(user, 'identity').content),
    signedPreKey: { ...part(skey), signature: getChild(skey, 'signature').content },
    preKey: key ? part(key) : undefined
  }
}

export { makeStorage, addrKey, hasSession, deleteSession, deleteUserSessions, decrypt, encrypt, injectSession, parseBundle }
