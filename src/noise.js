import { Curve, sha256, hkdf, gcmEncrypt, gcmDecrypt } from './crypto.js'
import { WA_HEADER } from './transport.js'

const MODE = Buffer.from('Noise_XX_25519_AESGCM_SHA256\0\0\0\0')
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
    if (this.transport) return gcmEncrypt(Buffer.from(data), this.encKey, iv(this.writeCounter++), Buffer.alloc(0))
    const result = gcmEncrypt(Buffer.from(data), this.encKey, iv(this.counter++), this.hash)
    this.authenticate(result)
    return result
  }

  decrypt(data) {
    if (this.transport) return gcmDecrypt(Buffer.from(data), this.decKey, iv(this.readCounter++), Buffer.alloc(0))
    const result = gcmDecrypt(Buffer.from(data), this.decKey, iv(this.counter++), this.hash)
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
