import crypto from 'crypto'
import libsignal from 'libsignal'

const signalPub = (pub) => (pub.length === 33 ? Buffer.from(pub) : Buffer.concat([Buffer.from([5]), Buffer.from(pub)]))

const verifyOutcome = (pub, msg, sig) => {
  try {
    return `valor:${String(libsignal.curve.verifySignature(pub, msg, sig))}`
  } catch {
    return 'error'
  }
}

const calibrateVerify = () => {
  const { pubKey, privKey } = libsignal.curve.generateKeyPair()
  const msg = Buffer.from('zyrix-calibracion')
  const sig = Buffer.from(libsignal.curve.calculateSignature(privKey, msg))
  const broken = Buffer.from(sig)
  broken[0] ^= 1
  const good = verifyOutcome(pubKey, msg, sig)
  if (good === verifyOutcome(pubKey, msg, broken) || good === verifyOutcome(pubKey, Buffer.from('otro'), sig)) {
    throw new Error('libsignal no permite distinguir una firma válida de una inválida')
  }
  return good
}

const VALID_OUTCOME = calibrateVerify()

const Curve = {
  generateKeyPair() {
    const { pubKey, privKey } = libsignal.curve.generateKeyPair()
    return { private: Buffer.from(privKey), public: Buffer.from(pubKey.slice(1)) }
  },
  sharedKey(priv, pub) {
    return Buffer.from(libsignal.curve.calculateAgreement(signalPub(pub), priv))
  },
  sign(priv, msg) {
    return Buffer.from(libsignal.curve.calculateSignature(priv, msg))
  },
  verify(pub, msg, sig) {
    return verifyOutcome(signalPub(pub), msg, sig) === VALID_OUTCOME
  }
}

const sha256 = (d) => crypto.createHash('sha256').update(d).digest()
const md5 = (d) => crypto.createHash('md5').update(d).digest()
const hmacSha256 = (data, key) => crypto.createHmac('sha256', key).update(data).digest()

const hkdf = (ikm, length, salt, info) => {
  if (!Number.isInteger(length) || length < 0 || length > 255 * 32) throw new RangeError('longitud HKDF fuera de rango')
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
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('AES-256-GCM requiere una clave de 32 bytes')
  const c = crypto.createCipheriv('aes-256-gcm', key, iv(counter))
  if (aad !== undefined) c.setAAD(aad)
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
}

const gcmDecrypt = (data, key, counter, aad) => {
  if (!Buffer.isBuffer(data) || data.length < 16) throw new Error('ciphertext AES-GCM truncado')
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('AES-256-GCM requiere una clave de 32 bytes')
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
