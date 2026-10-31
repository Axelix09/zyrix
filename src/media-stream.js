import crypto from 'node:crypto'
import { Transform } from 'node:stream'

export function createMediaDecryptionStream(mediaKey, type) {
  const infoMap = {
    image: 'WhatsApp Image Keys',
    video: 'WhatsApp Video Keys',
    audio: 'WhatsApp Audio Keys',
    document: 'WhatsApp Document Keys',
    sticker: 'WhatsApp Image Keys'
  }

  const info = infoMap[type] || 'WhatsApp Document Keys'
  const expanded = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(0), Buffer.from(info, 'utf8'), 112))
  const iv = expanded.subarray(0, 16)
  const cipherKey = expanded.subarray(16, 48)
  const macKey = expanded.subarray(48, 80)

  const hmac = crypto.createHmac('sha256', macKey)
  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv)

  let trailingBuffer = Buffer.alloc(0)

  const transform = new Transform({
    transform(chunk, encoding, callback) {
      try {
        const full = Buffer.concat([trailingBuffer, chunk])
        if (full.length <= 10) {
          trailingBuffer = full
          return callback()
        }

        const toProcess = full.subarray(0, full.length - 10)
        trailingBuffer = full.subarray(full.length - 10)

        hmac.update(toProcess)
        const decrypted = decipher.update(toProcess)
        callback(null, decrypted)
      } catch (err) {
        callback(err)
      }
    },
    flush(callback) {
      try {
        const finalDecrypted = decipher.final()
        callback(null, finalDecrypted)
      } catch (err) {
        callback(new Error('Fallo al descifrar el bloque final del stream de media: ' + err.message))
      }
    }
  })

  return {
    stream: transform,
    getMac: () => hmac.digest().subarray(0, 10),
    getExpectedMac: () => trailingBuffer
  }
}

export function createMediaEncryptionStream(mediaKey, type) {
  const infoMap = {
    image: 'WhatsApp Image Keys',
    video: 'WhatsApp Video Keys',
    audio: 'WhatsApp Audio Keys',
    document: 'WhatsApp Document Keys',
    sticker: 'WhatsApp Image Keys'
  }

  const info = infoMap[type] || 'WhatsApp Document Keys'
  const expanded = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(0), Buffer.from(info, 'utf8'), 112))
  const iv = expanded.subarray(0, 16)
  const cipherKey = expanded.subarray(16, 48)
  const macKey = expanded.subarray(48, 80)

  const hmac = crypto.createHmac('sha256', macKey)
  const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
  const fileSha256 = crypto.createHash('sha256')
  const fileEncSha256 = crypto.createHash('sha256')

  let plainLength = 0
  let encLength = 0

  const transform = new Transform({
    transform(chunk, encoding, callback) {
      try {
        plainLength += chunk.length
        fileSha256.update(chunk)

        const enc = cipher.update(chunk)
        encLength += enc.length
        fileEncSha256.update(enc)
        hmac.update(enc)

        callback(null, enc)
      } catch (err) {
        callback(err)
      }
    },
    flush(callback) {
      try {
        const finalEnc = cipher.final()
        encLength += finalEnc.length
        fileEncSha256.update(finalEnc)
        hmac.update(finalEnc)

        const mac = hmac.digest().subarray(0, 10)
        fileEncSha256.update(mac)

        this.push(Buffer.concat([finalEnc, mac]))
        callback()
      } catch (err) {
        callback(new Error('Fallo al cifrar el bloque final del stream de media: ' + err.message))
      }
    }
  })

  return {
    stream: transform,
    getMetrics: () => ({
      plainLength,
      encLength: encLength + 10,
      fileSha256: fileSha256.digest(),
      fileEncSha256: fileEncSha256.digest()
    })
  }
}