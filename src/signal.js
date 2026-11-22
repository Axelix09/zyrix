import crypto from 'crypto'
import { jidDecode, getChild } from './binary.js'
import { Curve, signalPub, hkdf, hmacSha256, aesCbcEncrypt, aesCbcDecrypt } from './crypto.js'
import { pbEncode, pbDecode } from './pb.js'
import { ZyrixError, ErrorKind } from './errors.js'
import { readBE } from './util.js'

// Signal 1:1 sessions: X3DH key agreement and the Double Ratchet, written from the
// public Signal specifications (https://signal.org/docs/). Session records are
// stored as plain JSON with base64 fields; the layout matches the records that
// earlier Zyrix versions persisted, so existing sessions keep working.

const VERSION = 3
const VERSION_BYTE = (VERSION << 4) | VERSION
const MAC_LENGTH = 8
const MAX_COUNTER_JUMP = 2000
const MAX_ARCHIVED_SESSIONS = 40
const MAX_RECEIVING_CHAINS = 5
const SENDING = 1
const RECEIVING = 2
const BASE_OURS = 1
const BASE_THEIRS = 2

const fail = (message, errorCode, kind = ErrorKind.DECRYPT, extra = {}) => new ZyrixError(message, { kind, errorCode, ...extra })

const b64 = (buf) => Buffer.from(buf).toString('base64')
const unb64 = (str) => Buffer.from(str, 'base64')

const addrKey = (jid) => {
  const d = jidDecode(jid)
  if (!d?.user) throw fail(`invalid JID for a Signal address: ${jid}`, 'JID_INVALID', ErrorKind.INVALID)
  return `${d.user}.${d.device || 0}`
}

// ---------------------------------------------------------------------------
// Storage bridge (the shape kept from previous versions, so hooks keep working)

const makeStorage = (state, hooks = {}) => {
  state.keys.identityKeys ||= {}
  return {
    async loadSession(id) {
      return state.keys.sessions[id] || null
    },
    async storeSession(id, record) {
      state.keys.sessions[id] = record
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
      return k ? { privKey: Buffer.from(k.private), pubKey: signalPub(k.public) } : undefined
    },
    async removePreKey(id) {
      delete state.keys.preKeys[id]
    },
    async loadSignedPreKey() {
      const k = state.creds.signedPreKey.keyPair
      return { privKey: Buffer.from(k.private), pubKey: signalPub(k.public) }
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

// One operation at a time per address: every step reads and rewrites the record.
const queues = new WeakMap()
const serialize = (state, id, fn) => {
  let perState = queues.get(state)
  if (!perState) queues.set(state, (perState = new Map()))
  const previous = perState.get(id) || Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.then(
    () => {},
    () => {}
  )
  perState.set(id, tail)
  tail.then(() => {
    if (perState.get(id) === tail) perState.delete(id)
  })
  return run
}

// ---------------------------------------------------------------------------
// Key derivation

const newKeyPair = () => {
  const kp = Curve.generateKeyPair()
  return { pubKey: b64(signalPub(kp.public)), privKey: b64(kp.private) }
}

const dh = (privB64OrBuf, pub) => Curve.sharedKey(typeof privB64OrBuf === 'string' ? unb64(privB64OrBuf) : privB64OrBuf, pub)

// KDF_RK: new root key and chain key from the current root key and a DH output
const rootStep = (rootKey, dhOut) => {
  const out = hkdf(dhOut, 64, rootKey, 'WhisperRatchet')
  return { rootKey: out.subarray(0, 32), chainKey: out.subarray(32, 64) }
}

const x3dhSecrets = (parts) => {
  const out = hkdf(Buffer.concat([Buffer.alloc(32, 0xff), ...parts]), 64, Buffer.alloc(32), 'WhisperText')
  return { rootKey: out.subarray(0, 32), chainKey: out.subarray(32, 64) }
}

const messageKeysFromSeed = (seed) => {
  const out = hkdf(seed, 80, Buffer.alloc(32), 'WhisperMessageKeys')
  return { cipherKey: out.subarray(0, 32), macKey: out.subarray(32, 64), iv: out.subarray(64, 80) }
}

// chainKey.counter is the index of the last message key derived from the chain
// (-1 for a fresh chain); chainKey.key derives index counter + 1.
const fillMessageKeys = (chain, counter) => {
  if (chain.chainKey.counter >= counter) return
  if (counter - chain.chainKey.counter > MAX_COUNTER_JUMP) {
    throw fail(`message counter jumps more than ${MAX_COUNTER_JUMP} messages ahead`, 'SIGNAL_COUNTER_JUMP')
  }
  if (chain.chainKey.key === undefined) throw fail('chain is closed', 'SIGNAL_CHAIN_CLOSED')
  let key = unb64(chain.chainKey.key)
  while (chain.chainKey.counter < counter) {
    chain.chainKey.counter += 1
    chain.messageKeys[chain.chainKey.counter] = b64(hmacSha256(Buffer.from([1]), key))
    key = hmacSha256(Buffer.from([2]), key)
  }
  chain.chainKey.key = b64(key)
}

const macFor = (macKey, senderIdentity, receiverIdentity, serialized) =>
  hmacSha256(Buffer.concat([signalPub(senderIdentity), signalPub(receiverIdentity), serialized]), macKey).subarray(0, MAC_LENGTH)

// ---------------------------------------------------------------------------
// Session records

const emptyRecord = () => ({ _sessions: {}, version: 'v1' })

const loadRecord = (raw) => {
  if (!raw) return emptyRecord()
  if (typeof raw !== 'object' || typeof raw._sessions !== 'object' || raw._sessions === null) {
    throw fail('corrupt Signal session record', 'SESSION_CORRUPT', ErrorKind.INVALID)
  }
  if (raw.version !== undefined && raw.version !== 'v1') throw fail(`unsupported session record version ${raw.version}`, 'SESSION_CORRUPT', ErrorKind.INVALID)
  return structuredClone({ ...raw, version: 'v1' })
}

const sessionsByUse = (record) => Object.values(record._sessions).sort((a, b) => (b.indexInfo.used || 0) - (a.indexInfo.used || 0))

const openSession = (record) => Object.values(record._sessions).find((s) => s.indexInfo.closed === -1)

const closeSession = (session) => {
  if (session.indexInfo.closed === -1) session.indexInfo.closed = Date.now()
}

const pruneArchived = (record) => {
  const closed = Object.entries(record._sessions)
    .filter(([, s]) => s.indexInfo.closed !== -1)
    .sort(([, a], [, b]) => a.indexInfo.closed - b.indexInfo.closed)
  while (closed.length > MAX_ARCHIVED_SESSIONS) delete record._sessions[closed.shift()[0]]
}

const putSession = (record, session) => {
  for (const s of Object.values(record._sessions)) if (s !== session) closeSession(s)
  session.indexInfo.closed = -1
  record._sessions[session.indexInfo.baseKey] = session
  pruneArchived(record)
}

const pruneReceivingChains = (session) => {
  const receiving = Object.keys(session._chains).filter((k) => session._chains[k].chainType === RECEIVING)
  while (receiving.length > MAX_RECEIVING_CHAINS) delete session._chains[receiving.shift()]
}

// ---------------------------------------------------------------------------
// Wire format

const parseWhisper = (data) => {
  const buf = Buffer.from(data)
  if (buf.length < 1 + MAC_LENGTH) throw fail('truncated Signal message', 'SIGNAL_MESSAGE_MALFORMED')
  checkVersion(buf[0])
  const body = pbDecode(buf.subarray(1, buf.length - MAC_LENGTH), 'SIGNAL_MESSAGE_MALFORMED')
  if (!Buffer.isBuffer(body[1]) || !Number.isInteger(body[2]) || !Buffer.isBuffer(body[4])) throw fail('incomplete Signal message', 'SIGNAL_MESSAGE_MALFORMED')
  return {
    ratchetKey: signalPub(body[1]),
    counter: body[2],
    previousCounter: body[3] || 0,
    ciphertext: body[4],
    serialized: buf.subarray(0, buf.length - MAC_LENGTH),
    mac: buf.subarray(buf.length - MAC_LENGTH)
  }
}

const parsePreKeyWhisper = (data) => {
  const buf = Buffer.from(data)
  if (buf.length < 2) throw fail('truncated Signal prekey message', 'SIGNAL_MESSAGE_MALFORMED')
  checkVersion(buf[0])
  const body = pbDecode(buf.subarray(1), 'SIGNAL_MESSAGE_MALFORMED')
  if (!Buffer.isBuffer(body[2]) || !Buffer.isBuffer(body[3]) || !Buffer.isBuffer(body[4]) || !Number.isInteger(body[6])) {
    throw fail('incomplete Signal prekey message', 'SIGNAL_MESSAGE_MALFORMED')
  }
  return {
    preKeyId: body[1],
    baseKey: signalPub(body[2]),
    identityKey: signalPub(body[3]),
    message: body[4],
    registrationId: body[5] || 0,
    signedPreKeyId: body[6]
  }
}

const checkVersion = (byte) => {
  const version = byte >> 4
  if (version !== VERSION) throw fail(`unsupported Signal message version ${version}`, 'SIGNAL_VERSION_UNSUPPORTED')
}

// ---------------------------------------------------------------------------
// Ratchet steps

const stepRatchet = (session, theirRatchetKey, previousCounter) => {
  const theirKey = b64(theirRatchetKey)
  if (session._chains[theirKey]) return
  const ratchet = session.currentRatchet
  const previous = session._chains[ratchet.lastRemoteEphemeralKey]
  if (previous && previous.chainType === RECEIVING) {
    fillMessageKeys(previous, previousCounter)
    delete previous.chainKey.key
  }
  const receiving = rootStep(unb64(ratchet.rootKey), dh(ratchet.ephemeralKeyPair.privKey, theirRatchetKey))
  session._chains[theirKey] = { chainKey: { counter: -1, key: b64(receiving.chainKey) }, chainType: RECEIVING, messageKeys: {} }

  const oldSending = session._chains[ratchet.ephemeralKeyPair.pubKey]
  if (oldSending && oldSending.chainType === SENDING) {
    ratchet.previousCounter = Math.max(oldSending.chainKey.counter, 0)
    delete session._chains[ratchet.ephemeralKeyPair.pubKey]
  }
  const ours = newKeyPair()
  const sending = rootStep(receiving.rootKey, dh(ours.privKey, theirRatchetKey))
  session._chains[ours.pubKey] = { chainKey: { counter: -1, key: b64(sending.chainKey) }, chainType: SENDING, messageKeys: {} }
  ratchet.ephemeralKeyPair = ours
  ratchet.rootKey = b64(sending.rootKey)
  ratchet.lastRemoteEphemeralKey = theirKey
  pruneReceivingChains(session)
}

// Decrypts on a copy; the caller only keeps the copy when the MAC checks out.
const decryptWithSession = (original, message, ourIdentityKey) => {
  const session = structuredClone(original)
  stepRatchet(session, message.ratchetKey, message.previousCounter)
  const chain = session._chains[b64(message.ratchetKey)]
  if (chain.chainType !== RECEIVING) throw fail('message uses our own sending chain', 'SIGNAL_MESSAGE_MALFORMED')
  fillMessageKeys(chain, message.counter)
  const seed = chain.messageKeys[message.counter]
  if (seed === undefined) throw fail('message key already used or never derived (duplicate or very old message)', 'SIGNAL_DUPLICATE_MESSAGE')
  delete chain.messageKeys[message.counter]
  const keys = messageKeysFromSeed(unb64(seed))
  const expected = macFor(keys.macKey, unb64(session.indexInfo.remoteIdentityKey), ourIdentityKey, message.serialized)
  if (!crypto.timingSafeEqual(expected, message.mac)) throw fail('bad Signal message MAC', 'SIGNAL_MAC_INVALID')
  let plaintext
  try {
    plaintext = aesCbcDecrypt(message.ciphertext, keys.cipherKey, keys.iv)
  } catch (cause) {
    throw fail('Signal message could not be decrypted', 'SESSION_DECRYPT_FAILED', ErrorKind.DECRYPT, { cause })
  }
  delete session.pendingPreKey
  session.indexInfo.used = Date.now()
  return { session, plaintext }
}

const decryptWithAnySession = (record, data, ourIdentityKey) => {
  const message = parseWhisper(data)
  const sessions = sessionsByUse(record)
  if (!sessions.length) throw fail('no Signal session for this sender', 'SIGNAL_SESSION_NOT_FOUND', ErrorKind.NO_SESSION)
  const errors = []
  for (const session of sessions) {
    try {
      return decryptWithSession(session, message, ourIdentityKey)
    } catch (error) {
      errors.push(error)
    }
  }
  const worst = errors.find((e) => e.errorCode === 'SIGNAL_DUPLICATE_MESSAGE') || errors.find((e) => e.errorCode === 'SIGNAL_MAC_INVALID') || errors[0]
  throw fail(`no Signal session could decrypt the message: ${worst.message}`, worst.errorCode || 'SESSION_DECRYPT_FAILED', ErrorKind.DECRYPT, { cause: worst, details: { attempts: errors.length } })
}

// ---------------------------------------------------------------------------
// Public operations

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

const untrusted = (id) => fail(`identity key for ${id} is not trusted`, 'SIGNAL_UNTRUSTED_IDENTITY', ErrorKind.REJECTED)

const injectSession = (state, jid, bundle, hooks) => {
  const id = addrKey(jid)
  return serialize(state, id, async () => {
    const storage = makeStorage(state, hooks)
    const identityKey = signalPub(bundle.identityKey)
    const signedPreKey = signalPub(bundle.signedPreKey.publicKey)
    if (!Curve.verify(identityKey, signedPreKey, bundle.signedPreKey.signature)) {
      throw fail('signed prekey signature is invalid', 'SIGNAL_SIGNED_PREKEY_INVALID', ErrorKind.REJECTED)
    }
    if (!(await storage.isTrustedIdentity(id, identityKey))) throw untrusted(id)
    const ours = storage.getOurIdentity()
    const baseKey = newKeyPair()
    const parts = [dh(ours.privKey, signedPreKey), dh(baseKey.privKey, identityKey), dh(baseKey.privKey, signedPreKey)]
    if (bundle.preKey) parts.push(dh(baseKey.privKey, signalPub(bundle.preKey.publicKey)))
    const master = x3dhSecrets(parts)
    const sendingKey = newKeyPair()
    const sending = rootStep(master.rootKey, dh(sendingKey.privKey, signedPreKey))
    const now = Date.now()
    const session = {
      registrationId: bundle.registrationId,
      currentRatchet: {
        ephemeralKeyPair: sendingKey,
        lastRemoteEphemeralKey: b64(signedPreKey),
        previousCounter: 0,
        rootKey: b64(sending.rootKey)
      },
      indexInfo: { baseKey: baseKey.pubKey, baseKeyType: BASE_OURS, closed: -1, used: now, created: now, remoteIdentityKey: b64(identityKey) },
      _chains: { [sendingKey.pubKey]: { chainKey: { counter: -1, key: b64(sending.chainKey) }, chainType: SENDING, messageKeys: {} } },
      pendingPreKey: { signedKeyId: bundle.signedPreKey.keyId, baseKey: baseKey.pubKey, preKeyId: bundle.preKey?.keyId }
    }
    if (session.pendingPreKey.preKeyId === undefined) delete session.pendingPreKey.preKeyId
    const record = loadRecord(await storage.loadSession(id))
    putSession(record, session)
    await storage.storeSession(id, record)
  })
}

const encrypt = (state, jid, data, hooks) => {
  const id = addrKey(jid)
  return serialize(state, id, async () => {
    const storage = makeStorage(state, hooks)
    const record = loadRecord(await storage.loadSession(id))
    const session = openSession(record)
    if (!session) throw fail(`no open Signal session for ${id}`, 'SIGNAL_SESSION_NOT_FOUND', ErrorKind.NO_SESSION)
    const remoteIdentity = unb64(session.indexInfo.remoteIdentityKey)
    if (!(await storage.isTrustedIdentity(id, remoteIdentity))) throw untrusted(id)
    const ours = storage.getOurIdentity()
    const ratchet = session.currentRatchet
    const chain = session._chains[ratchet.ephemeralKeyPair.pubKey]
    if (!chain || chain.chainType !== SENDING) throw fail('Signal session has no sending chain', 'SESSION_CORRUPT', ErrorKind.INVALID)
    const counter = chain.chainKey.counter + 1
    fillMessageKeys(chain, counter)
    const keys = messageKeysFromSeed(unb64(chain.messageKeys[counter]))
    delete chain.messageKeys[counter]
    const body = pbEncode([
      [1, unb64(ratchet.ephemeralKeyPair.pubKey)],
      [2, counter],
      [3, ratchet.previousCounter],
      [4, aesCbcEncrypt(Buffer.from(data), keys.cipherKey, keys.iv)]
    ])
    const serialized = Buffer.concat([Buffer.from([VERSION_BYTE]), body])
    const whisper = Buffer.concat([serialized, macFor(keys.macKey, ours.pubKey, remoteIdentity, serialized)])
    session.indexInfo.used = Date.now()
    let result = { type: 'msg', ciphertext: whisper }
    if (session.pendingPreKey) {
      const pending = session.pendingPreKey
      const preKeyMessage = pbEncode([
        [1, pending.preKeyId],
        [2, unb64(pending.baseKey)],
        [3, ours.pubKey],
        [4, whisper],
        [5, storage.getOurRegistrationId()],
        [6, pending.signedKeyId]
      ])
      result = { type: 'pkmsg', ciphertext: Buffer.concat([Buffer.from([VERSION_BYTE]), preKeyMessage]) }
    }
    await storage.storeSession(id, record)
    return result
  })
}

const decryptPreKey = async (storage, id, data) => {
  const message = parsePreKeyWhisper(data)
  if (!(await storage.isTrustedIdentity(id, message.identityKey))) throw untrusted(id)
  const record = loadRecord(await storage.loadSession(id))
  const ours = storage.getOurIdentity()
  const existing = record._sessions[b64(message.baseKey)]
  if (existing) {
    const { session, plaintext } = decryptWithSession(existing, parseWhisper(message.message), ours.pubKey)
    record._sessions[session.indexInfo.baseKey] = session
    await storage.storeSession(id, record)
    return plaintext
  }
  let preKey
  if (message.preKeyId !== undefined) {
    preKey = await storage.loadPreKey(message.preKeyId)
    if (!preKey) throw fail(`prekey ${message.preKeyId} not found (already used or never uploaded)`, 'SIGNAL_PREKEY_NOT_FOUND')
  }
  const signedPreKey = await storage.loadSignedPreKey(message.signedPreKeyId)
  if (!signedPreKey) throw fail(`signed prekey ${message.signedPreKeyId} not found`, 'SIGNAL_PREKEY_NOT_FOUND')
  const parts = [dh(signedPreKey.privKey, message.identityKey), dh(ours.privKey, message.baseKey), dh(signedPreKey.privKey, message.baseKey)]
  if (preKey) parts.push(dh(preKey.privKey, message.baseKey))
  const master = x3dhSecrets(parts)
  const now = Date.now()
  const fresh = {
    registrationId: message.registrationId,
    currentRatchet: {
      ephemeralKeyPair: { pubKey: b64(signalPub(signedPreKey.pubKey)), privKey: b64(signedPreKey.privKey) },
      lastRemoteEphemeralKey: b64(message.baseKey),
      previousCounter: 0,
      rootKey: b64(master.rootKey)
    },
    indexInfo: { baseKey: b64(message.baseKey), baseKeyType: BASE_THEIRS, closed: -1, used: now, created: now, remoteIdentityKey: b64(message.identityKey) },
    _chains: {}
  }
  const { session, plaintext } = decryptWithSession(fresh, parseWhisper(message.message), ours.pubKey)
  putSession(record, session)
  await storage.storeSession(id, record)
  if (message.preKeyId !== undefined) await storage.removePreKey(message.preKeyId)
  return plaintext
}

const decryptWhisper = async (storage, id, data) => {
  const record = loadRecord(await storage.loadSession(id))
  const ours = storage.getOurIdentity()
  const { session, plaintext } = decryptWithAnySession(record, data, ours.pubKey)
  if (!(await storage.isTrustedIdentity(id, unb64(session.indexInfo.remoteIdentityKey)))) throw untrusted(id)
  // A late message on an archived session must not reopen it: the peer has moved on.
  record._sessions[session.indexInfo.baseKey] = session
  await storage.storeSession(id, record)
  return plaintext
}

const decrypt = (state, jid, type, ciphertext, hooks) => {
  const id = addrKey(jid)
  return serialize(state, id, () => {
    const storage = makeStorage(state, hooks)
    return type === 'pkmsg' ? decryptPreKey(storage, id, ciphertext) : decryptWhisper(storage, id, ciphertext)
  })
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
