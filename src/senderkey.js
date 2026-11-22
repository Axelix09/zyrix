import crypto from 'crypto'
import { Curve, hmacSha256, hkdf, signalPub, aesCbcEncrypt, aesCbcDecrypt } from './crypto.js'
import { ZyrixError, ErrorKind } from './errors.js'
import { pbEncode, pbDecode as decodePb } from './pb.js'

const VERSION = 0x33
const MAX_SKIP = 2000
const MAX_SKIPPED = 4096

const pbDecode = (buf) => decodePb(buf, 'SENDER_KEY_MALFORMED')

const msgSeed = (chain) => hmacSha256(Buffer.from([1]), chain)
const nextChain = (chain) => hmacSha256(Buffer.from([2]), chain)

const messageKeys = (seed) => {
  const d = hkdf(seed, 48, Buffer.alloc(32), 'WhisperGroup')
  return { iv: d.subarray(0, 16), cipherKey: d.subarray(16, 48) }
}

const nameOf = (group, address) => `${group}::${address}`

const ensureOwn = (state, group, address) => {
  const name = nameOf(group, address)
  let rec = state.keys.senderKeys[name]
  if (!rec) {
    const kp = Curve.generateKeyPair()
    rec = {
      keyId: crypto.randomInt(1, 2147483647),
      iteration: 0,
      chain: crypto.randomBytes(32),
      signingPublic: signalPub(kp.public),
      signingPrivate: kp.private,
      skipped: {},
      sentTo: {}
    }
    state.keys.senderKeys[name] = rec
  }
  return rec
}

const distribution = (rec) =>
  Buffer.concat([Buffer.from([VERSION]), pbEncode([[1, rec.keyId], [2, rec.iteration], [3, rec.chain], [4, rec.signingPublic]])])

const processDistribution = (state, group, address, data) => {
  const raw = Buffer.from(data)
  if (raw.length < 2 || raw[0] !== VERSION) throw new ZyrixError('invalid sender key version', { kind: ErrorKind.DECRYPT, errorCode: 'SENDER_KEY_MALFORMED' })
  const b = pbDecode(raw.subarray(1))
  if (!Number.isSafeInteger(b[1]) || !Number.isSafeInteger(b[2]) || !b[3] || !b[4]) throw new ZyrixError('incomplete sender key', { kind: ErrorKind.DECRYPT, errorCode: 'SENDER_KEY_MALFORMED' })
  const name = nameOf(group, address)
  const current = state.keys.senderKeys[name]
  if (current && current.keyId === b[1]) return
  state.keys.senderKeys[name] = {
    keyId: b[1],
    iteration: b[2] || 0,
    chain: Buffer.from(b[3]),
    signingPublic: Buffer.from(b[4]),
    skipped: {},
    sentTo: {}
  }
}

const encrypt = (state, group, address, plaintext) => {
  const rec = ensureOwn(state, group, address)
  const { iv, cipherKey } = messageKeys(msgSeed(rec.chain))
  const ct = aesCbcEncrypt(plaintext, cipherKey, iv)
  const iteration = rec.iteration
  rec.chain = nextChain(rec.chain)
  rec.iteration++
  const signed = Buffer.concat([Buffer.from([VERSION]), pbEncode([[1, rec.keyId], [2, iteration], [3, ct]])])
  return Buffer.concat([signed, Curve.sign(rec.signingPrivate, signed)])
}

const decrypt = (state, group, address, data) => {
  const name = nameOf(group, address)
  const rec = state.keys.senderKeys[name]
  if (!rec) throw new ZyrixError('no sender key', { kind: ErrorKind.NO_SESSION, errorCode: 'SENDER_KEY_MISSING' })
  const buf = Buffer.from(data)
  if (buf.length < 66 || buf[0] !== VERSION) throw new ZyrixError('invalid sender key message', { kind: ErrorKind.DECRYPT, errorCode: 'SENDER_KEY_MALFORMED' })
  const signed = buf.subarray(0, buf.length - 64)
  const sig = buf.subarray(buf.length - 64)
  const body = pbDecode(signed.subarray(1))
  if (body[1] !== rec.keyId) throw new ZyrixError('sender key id mismatch', { kind: ErrorKind.DECRYPT, errorCode: 'SENDER_KEY_ID_MISMATCH' })
  if (!Curve.verify(rec.signingPublic, signed, sig)) throw new ZyrixError('invalid sender key signature', { kind: ErrorKind.DECRYPT, errorCode: 'SENDER_KEY_SIGNATURE_INVALID' })
  const target = body[2] || 0
  // El ratchet avanza sobre variables locales. iteration, chain, skipped y las claves nuevas
  // se publican recién después de que el descifrado CBC (y su padding) hayan sido verificados.
  // Un mensaje con firma válida pero padding inválido deja el estado byte a byte igual.
  let seed
  let chain = rec.chain
  let iteration = rec.iteration
  let skipped = rec.skipped
  let commitSkipped
  if (target < iteration) {
    const k = skipped[target]
    if (!k) throw new ZyrixError('duplicate or old message', { kind: ErrorKind.DECRYPT, errorCode: 'SENDER_KEY_DUPLICATE' })
    seed = Buffer.from(k)
    commitSkipped = () => { delete skipped[target] }
  } else {
    if (target - iteration > MAX_SKIP) throw new ZyrixError('iteration jump too large', { kind: ErrorKind.DECRYPT, errorCode: 'SENDER_KEY_JUMP_TOO_LARGE' })
    skipped = { ...skipped }
    while (iteration < target) {
      skipped[iteration] = msgSeed(chain)
      if (Object.keys(skipped).length > MAX_SKIPPED) delete skipped[iteration - MAX_SKIPPED]
      chain = nextChain(chain)
      iteration++
    }
    seed = msgSeed(chain)
    chain = nextChain(chain)
    iteration++
  }
  const { iv, cipherKey } = messageKeys(seed)
  const plaintext = aesCbcDecrypt(body[3], cipherKey, iv)
  if (commitSkipped) commitSkipped()
  rec.chain = chain
  rec.iteration = iteration
  rec.skipped = skipped
  return plaintext
}

const resetOwn = (state, group, address) => {
  delete state.keys.senderKeys[nameOf(group, address)]
}

export { ensureOwn, resetOwn, distribution, processDistribution, encrypt, decrypt, pbEncode, pbDecode }
