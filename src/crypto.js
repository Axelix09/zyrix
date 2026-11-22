import crypto from 'crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import { ZyrixError, ErrorKind } from './errors.js'

// Curve25519 primitives used by the Signal protocol:
// - X25519 key agreement and key generation run on Node's native crypto.
// - Signatures are XEdDSA-style: the Montgomery private key is used as an Ed25519
//   scalar, and the sign bit of the Edwards public key travels in the top bit of
//   the signature (the convention of the Signal libraries and WhatsApp).

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')
const P = 2n ** 255n - 19n
const L = ed25519.Point.Fn.ORDER
const Point = ed25519.Point

const signalPub = (pub) => (pub.length === 33 ? Buffer.from(pub) : Buffer.concat([Buffer.from([5]), Buffer.from(pub)]))

const rawPub = (pub) => {
  const b = Buffer.from(pub)
  if (b.length === 33 && b[0] === 5) return b.subarray(1)
  if (b.length === 32) return b
  throw new ZyrixError('invalid Curve25519 public key', { kind: ErrorKind.INVALID, errorCode: 'CURVE_KEY_INVALID' })
}

const rawPriv = (priv) => {
  const b = Buffer.from(priv)
  if (b.length !== 32) throw new ZyrixError('invalid Curve25519 private key', { kind: ErrorKind.INVALID, errorCode: 'CURVE_KEY_INVALID' })
  return b
}

const clamp = (priv) => {
  const k = Buffer.from(priv)
  k[0] &= 248
  k[31] &= 127
  k[31] |= 64
  return k
}

const leToBig = (bytes) => {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}

const bigToLe = (n, length = 32) => {
  const out = Buffer.alloc(length)
  for (let i = 0; i < length; i++) {
    out[i] = Number(n & 255n)
    n >>= 8n
  }
  return out
}

const mod = (a, m) => {
  const r = a % m
  return r >= 0n ? r : r + m
}

const modPow = (base, exp, m) => {
  let result = 1n
  base = mod(base, m)
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % m
    base = (base * base) % m
    exp >>= 1n
  }
  return result
}

const privateKeyObject = (priv) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, rawPriv(priv)]), format: 'der', type: 'pkcs8' })
const publicKeyObject = (pub) => crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, rawPub(pub)]), format: 'der', type: 'spki' })

const publicFromPrivate = (priv) => Buffer.from(crypto.createPublicKey(privateKeyObject(priv)).export({ type: 'spki', format: 'der' }).subarray(-32))

const sha512 = (...parts) => crypto.createHash('sha512').update(Buffer.concat(parts)).digest()

const xeddsaSign = (priv, msg) => {
  const a = mod(leToBig(clamp(rawPriv(priv))), L)
  const A = Buffer.from(Point.BASE.multiply(a).toBytes())
  const signBit = A[31] & 0x80
  const prefix = Buffer.concat([Buffer.from([0xfe]), Buffer.alloc(31, 0xff)])
  const r = mod(leToBig(sha512(prefix, clamp(rawPriv(priv)), Buffer.from(msg), crypto.randomBytes(64))), L) || 1n
  const R = Buffer.from(Point.BASE.multiply(r).toBytes())
  const h = mod(leToBig(sha512(R, A, Buffer.from(msg))), L)
  const s = mod(r + h * a, L)
  const sig = Buffer.concat([R, bigToLe(s)])
  sig[63] |= signBit
  return sig
}

const xeddsaVerify = (pub, msg, sig) => {
  try {
    const signature = Buffer.from(sig)
    if (signature.length !== 64) return false
    const montgomery = Buffer.from(rawPub(pub))
    montgomery[31] &= 0x7f
    const u = mod(leToBig(montgomery), P)
    if (u === P - 1n) return false
    // Birational map from Montgomery u to Edwards y: y = (u - 1) / (u + 1)
    const y = mod((u - 1n) * modPow(u + 1n, P - 2n, P), P)
    const edPub = bigToLe(y)
    edPub[31] |= signature[63] & 0x80
    signature[63] &= 0x7f
    return ed25519.verify(signature, Buffer.from(msg), edPub, { zip215: false })
  } catch {
    return false
  }
}

const Curve = {
  generateKeyPair() {
    const priv = clamp(crypto.randomBytes(32))
    return { private: priv, public: publicFromPrivate(priv) }
  },
  sharedKey(priv, pub) {
    try {
      return crypto.diffieHellman({ privateKey: privateKeyObject(priv), publicKey: publicKeyObject(pub) })
    } catch (cause) {
      if (cause?.errorCode) throw cause
      throw new ZyrixError('Curve25519 key agreement failed', { kind: ErrorKind.DECRYPT, errorCode: 'CURVE_AGREEMENT_FAILED', cause })
    }
  },
  sign(priv, msg) {
    return xeddsaSign(priv, msg)
  },
  verify(pub, msg, sig) {
    return xeddsaVerify(pub, msg, sig)
  }
}

const sha256 = (d) => crypto.createHash('sha256').update(d).digest()
const md5 = (d) => crypto.createHash('md5').update(d).digest()
const hmacSha256 = (data, key) => crypto.createHmac('sha256', key).update(data).digest()

const hkdf = (ikm, length, salt, info) => {
  if (!Number.isInteger(length) || length < 0 || length > 255 * 32) throw new RangeError('HKDF length out of range')
  const prk = hmacSha256(ikm, salt && salt.length ? salt : Buffer.alloc(32))
  const infoBuf = info ? Buffer.from(info) : Buffer.alloc(0)
  const blocks = []
  let prev = Buffer.alloc(0)
  let total = 0
  for (let i = 1; total < length; i++) {
    prev = hmacSha256(Buffer.concat([prev, infoBuf, Buffer.from([i])]), prk)
    blocks.push(prev)
    total += prev.length
  }
  return Buffer.concat(blocks).subarray(0, length)
}

const iv = (counter) => {
  if (Buffer.isBuffer(counter)) return counter
  const b = Buffer.alloc(12)
  b.writeUInt32BE(counter, 8)
  return b
}

const gcmEncrypt = (plaintext, key, counter, aad) => {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('AES-256-GCM requires a 32-byte key')
  const c = crypto.createCipheriv('aes-256-gcm', key, iv(counter))
  if (aad !== undefined) c.setAAD(aad)
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
}

const gcmDecrypt = (data, key, counter, aad) => {
  if (!Buffer.isBuffer(data) || data.length < 16) throw new ZyrixError('truncated AES-GCM ciphertext', { kind: ErrorKind.DECRYPT, errorCode: 'CIPHERTEXT_TRUNCATED' })
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('AES-256-GCM requires a 32-byte key')
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv(counter))
  if (aad !== undefined) d.setAAD(aad)
  d.setAuthTag(data.subarray(data.length - 16))
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()])
}

const aesCbcEncrypt = (data, key, ivBuf) => {
  const c = crypto.createCipheriv('aes-256-cbc', key, ivBuf)
  return Buffer.concat([c.update(data), c.final()])
}

const aesCbcDecrypt = (data, key, ivBuf) => {
  const d = crypto.createDecipheriv('aes-256-cbc', key, ivBuf)
  return Buffer.concat([d.update(data), d.final()])
}

const aesCtr = (data, key, ivBuf) => {
  const c = crypto.createCipheriv('aes-256-ctr', key, ivBuf)
  return Buffer.concat([c.update(data), c.final()])
}

const pbkdf2 = (pass, salt, iterations, length) => crypto.pbkdf2Sync(pass, salt, iterations, length, 'sha256')

export {
  Curve,
  signalPub,
  sha256,
  md5,
  hmacSha256,
  hkdf,
  gcmEncrypt,
  gcmDecrypt,
  aesCbcEncrypt,
  aesCbcDecrypt,
  aesCtr,
  pbkdf2
}
