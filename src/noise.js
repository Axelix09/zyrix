import { Curve, sha256, hkdf, gcmEncrypt, gcmDecrypt } from './crypto.js'
import { WA_HEADER } from './transport.js'
import { ZyrixError, ErrorKind } from './errors.js'

const MODE = Buffer.from('Noise_XX_25519_AESGCM_SHA256\0\0\0\0')
const MAX_COUNTER = 0xffffffff
// El nonce es un contador de 32 bits. Antes de desbordarlo se falla con un error estable en
// vez de dejar que iv() lance un RangeError crudo desde dentro de un callback del protocolo.
const nextCounter = (owner, field) => {
  if (owner[field] === undefined) owner[field] = 0
  if (!Number.isSafeInteger(owner[field]) || owner[field] < 0 || owner[field] >= MAX_COUNTER) {
    throw new ZyrixError('the Noise counter is exhausted; the connection must be rekeyed', { kind: ErrorKind.PROTOCOL, errorCode: 'SIGNAL_COUNTER_OVERFLOW' })
  }
  return owner[field]++
}
const iv = (counter) => {
  const value = Buffer.alloc(12)
  value.writeUInt32BE(counter, 8)
  return value
}

class Noise {
  constructor(ephemeral) {
    this.ephemeral = ephemeral
    this.hash = MODE.length === 32 ? MODE : sha256(MODE)
    this.salt = this.hash
    this.encKey = this.hash
    this.decKey = this.hash
    this.counter = 0
    this.transport = false
    this.authenticate(WA_HEADER)
    this.authenticate(ephemeral.public)
  }

  authenticate(data) {
    if (!this.transport) this.hash = sha256(Buffer.concat([this.hash, Buffer.from(data)]))
  }

  encrypt(data) {
    if (this.transport) return gcmEncrypt(Buffer.from(data), this.encKey, iv(nextCounter(this, 'writeCounter')), Buffer.alloc(0))
    const result = gcmEncrypt(Buffer.from(data), this.encKey, iv(nextCounter(this, 'counter')), this.hash)
    this.authenticate(result)
    return result
  }

  decrypt(data) {
    if (this.transport) return gcmDecrypt(Buffer.from(data), this.decKey, iv(nextCounter(this, 'readCounter')), Buffer.alloc(0))
    const result = gcmDecrypt(Buffer.from(data), this.decKey, iv(nextCounter(this, 'counter')), this.hash)
    this.authenticate(data)
    return result
  }

  mix(data) {
    const keys = hkdf(Buffer.from(data), 64, this.salt, '')
    this.salt = keys.subarray(0, 32)
    this.encKey = keys.subarray(32)
    this.decKey = keys.subarray(32)
    this.counter = 0
  }

  processServerHello(serverHello, noiseKey) {
    const serverEphemeral = Buffer.from(serverHello.ephemeral)
    this.authenticate(serverEphemeral)
    this.mix(Curve.sharedKey(this.ephemeral.private, serverEphemeral))
    const serverStatic = this.decrypt(serverHello.static)
    this.mix(Curve.sharedKey(this.ephemeral.private, serverStatic))
    this.decrypt(serverHello.payload)
    const key = this.encrypt(noiseKey.public)
    this.mix(Curve.sharedKey(noiseKey.private, serverEphemeral))
    return key
  }

  async finish() {
    const keys = hkdf(Buffer.alloc(0), 64, this.salt, '')
    this.encKey = keys.subarray(0, 32)
    this.decKey = keys.subarray(32)
    this.writeCounter = 0
    this.readCounter = 0
    this.transport = true
  }
}

export { Noise }
