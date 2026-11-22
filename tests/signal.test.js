import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as signal from '../src/signal.js'
import { Curve } from '../src/crypto.js'
import { initCreds, initKeys } from '../src/auth.js'
import { jsonReviver } from '../src/util.js'
import { ErrorCode } from '../src/index.js'

// Sessions, messages and signatures in this fixture were produced by the libsignal
// 6.0.0 based implementation that Zyrix used up to 0.19.0. They check that the
// in-house implementation keeps reading and continuing those sessions.
const fixture = () => JSON.parse(fs.readFileSync(new URL('./fixtures/libsignal-sessions.json', import.meta.url), 'utf8'), jsonReviver)

const text = (b) => Buffer.from(b).toString()
const party = () => ({ creds: initCreds(), keys: initKeys() })
const withPrefix = (k) => Buffer.concat([Buffer.from([5]), k])
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
const pair = async () => {
  const alice = party()
  const bob = party()
  const aliceJid = '5491100000010@s.whatsapp.net'
  const bobJid = '5491100000020:2@s.whatsapp.net'
  await signal.injectSession(alice, bobJid, bundleFor(bob, 5))
  return { alice, bob, aliceJid, bobJid }
}
const b64 = (x) => Buffer.from(x.ciphertext, 'base64')

test('curve: XEdDSA signatures and X25519 agreement match the previous implementation', () => {
  for (const v of fixture().curveVectors) {
    assert.equal(Curve.verify(v.public, v.message, v.signature), true)
    const tampered = Buffer.from(v.signature)
    tampered[10] ^= 1
    assert.equal(Curve.verify(v.public, v.message, tampered), false)
    assert.equal(Curve.verify(v.public, Buffer.from('other'), v.signature), false)
    assert.equal(Curve.verify(v.public, v.message, v.signature.subarray(0, 63)), false)
    assert.deepEqual(Curve.sharedKey(v.private, v.otherPublic), v.shared)
  }
  const kp = Curve.generateKeyPair()
  const msg = Buffer.from('zyrix')
  const sig = Curve.sign(kp.private, msg)
  assert.equal(sig.length, 64)
  assert.equal(Curve.verify(kp.public, msg, sig), true)
  assert.equal(Curve.verify(withPrefix(kp.public), msg, sig), true, 'accepts 32 and 33 byte public keys')
})

test('signal: decrypts prekey messages from a session created by the previous implementation', async () => {
  const f = fixture()
  const bob = f.bobFresh
  for (const m of f.first) assert.equal(text(await signal.decrypt(bob, f.aliceJid, m.type, b64(m))), m.text)
  assert.equal(bob.keys.preKeys[31], undefined, 'one-time prekey is consumed')
})

test('signal: continues stored sessions from the previous implementation, in and out of order', async () => {
  const f = fixture()
  const bob = f.bobBefore
  const alice = f.aliceAfter
  const [p0, p1, p2, p3] = f.pending
  for (const m of [p2, p0, p3, p1]) assert.equal(text(await signal.decrypt(bob, f.aliceJid, m.type, b64(m))), m.text)
  await assert.rejects(signal.decrypt(bob, f.aliceJid, p0.type, b64(p0)), { errorCode: ErrorCode.SIGNAL_DUPLICATE_MESSAGE })

  const reply = await signal.encrypt(bob, f.aliceJid, Buffer.from('reply from the new implementation'))
  assert.equal(reply.type, 'msg')
  assert.equal(text(await signal.decrypt(alice, f.bobJid, reply.type, reply.ciphertext)), 'reply from the new implementation')
  for (let i = 0; i < 3; i++) {
    const m = await signal.encrypt(alice, f.bobJid, Buffer.from(`n${i}`))
    assert.equal(m.type, 'msg', 'pendingPreKey is cleared once the peer answered')
    assert.equal(text(await signal.decrypt(bob, f.aliceJid, m.type, m.ciphertext)), `n${i}`)
  }
})

test('signal: long conversation with ratchet steps, skipped and delayed messages', async () => {
  const { alice, bob, aliceJid, bobJid } = await pair()
  const delayed = []
  for (let round = 0; round < 20; round++) {
    const burst = []
    for (let i = 0; i < 3; i++) burst.push({ ...(await signal.encrypt(alice, bobJid, Buffer.from(`a${round}.${i}`))), t: `a${round}.${i}` })
    delayed.push(burst.shift())
    for (const m of burst.reverse()) assert.equal(text(await signal.decrypt(bob, aliceJid, m.type, m.ciphertext)), m.t)
    const r = await signal.encrypt(bob, aliceJid, Buffer.from(`b${round}`))
    assert.equal(text(await signal.decrypt(alice, bobJid, r.type, r.ciphertext)), `b${round}`)
  }
  // Delayed messages from the last few sending chains are still accepted.
  for (const m of delayed.slice(-4)) assert.equal(text(await signal.decrypt(bob, aliceJid, m.type, m.ciphertext)), m.t)
})

test('signal: a tampered message is rejected and leaves the session untouched', async () => {
  const { alice, bob, aliceJid, bobJid } = await pair()
  const first = await signal.encrypt(alice, bobJid, Buffer.from('hi'))
  await signal.decrypt(bob, aliceJid, first.type, first.ciphertext)
  const reply = await signal.encrypt(bob, aliceJid, Buffer.from('ok'))
  await signal.decrypt(alice, bobJid, reply.type, reply.ciphertext)
  const m = await signal.encrypt(alice, bobJid, Buffer.from('second'))
  assert.equal(m.type, 'msg')
  const before = structuredClone(bob.keys.sessions)
  const tampered = Buffer.from(m.ciphertext)
  tampered[tampered.length - 1] ^= 1
  await assert.rejects(signal.decrypt(bob, aliceJid, m.type, tampered), { errorCode: ErrorCode.SIGNAL_MAC_INVALID })
  assert.deepEqual(bob.keys.sessions, before)
  assert.equal(text(await signal.decrypt(bob, aliceJid, m.type, m.ciphertext)), 'second')
})

test('signal: stable error codes for missing session, prekey, bad signature, version and counter jump', async () => {
  const alice = party()
  await assert.rejects(signal.encrypt(alice, '1@s.whatsapp.net', Buffer.from('x')), { errorCode: ErrorCode.SIGNAL_SESSION_NOT_FOUND, kind: 'no-session' })

  const bob = party()
  const badBundle = bundleFor(bob, 1)
  badBundle.signedPreKey.signature = Buffer.alloc(64)
  await assert.rejects(signal.injectSession(alice, '2@s.whatsapp.net', badBundle), { errorCode: ErrorCode.SIGNAL_SIGNED_PREKEY_INVALID })

  const s = await pair()
  const m = await signal.encrypt(s.alice, s.bobJid, Buffer.from('x'))
  delete s.bob.keys.preKeys[5]
  await assert.rejects(signal.decrypt(s.bob, s.aliceJid, m.type, m.ciphertext), { errorCode: ErrorCode.SIGNAL_PREKEY_NOT_FOUND })

  const wrongVersion = Buffer.from(m.ciphertext)
  wrongVersion[0] = 0x22
  await assert.rejects(signal.decrypt(s.bob, s.aliceJid, 'pkmsg', wrongVersion), { errorCode: ErrorCode.SIGNAL_VERSION_UNSUPPORTED })

  const t = await pair()
  const hello = await signal.encrypt(t.alice, t.bobJid, Buffer.from('hello'))
  await signal.decrypt(t.bob, t.aliceJid, hello.type, hello.ciphertext)
  const record = t.alice.keys.sessions[signal.addrKey(t.bobJid)]
  const session = Object.values(record._sessions)[0]
  session._chains[session.currentRatchet.ephemeralKeyPair.pubKey].chainKey.counter += 2005
  const far = await signal.encrypt(t.alice, t.bobJid, Buffer.from('far'))
  await assert.rejects(signal.decrypt(t.bob, t.aliceJid, far.type, far.ciphertext), { errorCode: ErrorCode.SIGNAL_COUNTER_JUMP })
})

test('signal: tofu policy blocks a session with a changed identity', async () => {
  const alice = party()
  const jid = '3@s.whatsapp.net'
  const hooks = { trustPolicy: 'tofu' }
  await signal.injectSession(alice, jid, bundleFor(party(), 1), hooks)
  await assert.rejects(signal.injectSession(alice, jid, bundleFor(party(), 1), hooks), { errorCode: ErrorCode.SIGNAL_UNTRUSTED_IDENTITY })
})

test('signal: a new session from the peer keeps old in-flight messages readable without reopening the old session', async () => {
  const { alice, bob, aliceJid, bobJid } = await pair()
  const m1 = await signal.encrypt(alice, bobJid, Buffer.from('x1'))
  await signal.decrypt(bob, aliceJid, m1.type, m1.ciphertext)
  const r1 = await signal.encrypt(bob, aliceJid, Buffer.from('y1'))
  await signal.decrypt(alice, bobJid, r1.type, r1.ciphertext)
  const late = await signal.encrypt(alice, bobJid, Buffer.from('late'))
  await signal.injectSession(alice, bobJid, bundleFor(bob, 6))
  const m2 = await signal.encrypt(alice, bobJid, Buffer.from('x2'))
  assert.equal(m2.type, 'pkmsg')
  assert.equal(text(await signal.decrypt(bob, aliceJid, m2.type, m2.ciphertext)), 'x2')
  assert.equal(text(await signal.decrypt(bob, aliceJid, late.type, late.ciphertext)), 'late')
  const r2 = await signal.encrypt(bob, aliceJid, Buffer.from('y2'))
  assert.equal(text(await signal.decrypt(alice, bobJid, r2.type, r2.ciphertext)), 'y2', 'reply goes on the new session')
})

test('signal: concurrent encryptions to the same device are serialized', async () => {
  const { alice, bob, aliceJid, bobJid } = await pair()
  const msgs = await Promise.all(Array.from({ length: 20 }, (_, i) => signal.encrypt(alice, bobJid, Buffer.from(`c${i}`))))
  const plain = await Promise.all(msgs.map((m) => signal.decrypt(bob, aliceJid, m.type, m.ciphertext)))
  assert.deepEqual(plain.map(text), msgs.map((_, i) => `c${i}`))
})

test('signal: archived sessions are capped', async () => {
  const alice = party()
  const bob = party()
  const jid = '4@s.whatsapp.net'
  for (let i = 0; i < 45; i++) await signal.injectSession(alice, jid, bundleFor(bob, i + 1))
  const sessions = Object.values(alice.keys.sessions[signal.addrKey(jid)]._sessions)
  assert.equal(sessions.length, 41, 'one open session plus 40 archived')
  assert.equal(sessions.filter((s) => s.indexInfo.closed === -1).length, 1)
})
