import crypto from 'crypto'
import fs from 'fs'
import path from 'node:path'
import { hkdf, aesCbcEncrypt, aesCbcDecrypt, hmacSha256, sha256 } from './crypto.js'
import { ZyrixError, ErrorKind } from './errors.js'

const INFO = {
  image: 'WhatsApp Image Keys',
  video: 'WhatsApp Video Keys',
  audio: 'WhatsApp Audio Keys',
  document: 'WhatsApp Document Keys',
  sticker: 'WhatsApp Image Keys',
  'md-app-state': 'WhatsApp App State Keys'
}

const expand = (mediaKey, type) => {
  if (!INFO[type]) throw new ZyrixError(`unsupported media type: ${type}`, { kind: ErrorKind.INVALID, errorCode: 'MEDIA_TYPE_UNSUPPORTED' })
  if (!Buffer.isBuffer(mediaKey) || mediaKey.length !== 32) throw new TypeError('mediaKey must be 32 bytes')
  const k = hkdf(Buffer.from(mediaKey), 112, null, INFO[type])
  return { iv: k.subarray(0, 16), cipherKey: k.subarray(16, 48), macKey: k.subarray(48, 80) }
}

const encryptMedia = (buffer, type) => {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw new TypeError('media must be a Buffer or Uint8Array')
  buffer = Buffer.from(buffer)
  const mediaKey = crypto.randomBytes(32)
  const { iv, cipherKey, macKey } = expand(mediaKey, type)
  const enc = aesCbcEncrypt(buffer, cipherKey, iv)
  const mac = hmacSha256(Buffer.concat([iv, enc]), macKey).subarray(0, 10)
  const body = Buffer.concat([enc, mac])
  return { mediaKey, body, fileSha256: sha256(buffer), fileEncSha256: sha256(body), fileLength: buffer.length }
}

// Cifra desde un descriptor ya abierto: el tamaño y el contenido que se validan y el que se
// cifra son el mismo archivo, sin ventana TOCTOU entre stat(path) y open(path).
const encryptMediaFileFromHandle = async (handle, outputPath, type, { maxBytes = Infinity } = {}) => {
  const before = await handle.stat()
  if (!before.isFile()) throw new ZyrixError('media path must be a regular file', { kind: ErrorKind.MEDIA, errorCode: 'MEDIA_NOT_A_FILE' })
  if (!(maxBytes === Infinity || Number.isSafeInteger(maxBytes) && maxBytes > 0)) throw new TypeError('maxBytes must be a positive integer')
  if (before.size > maxBytes) throw new RangeError(`file exceeds the ${maxBytes}-byte limit`)
  const mediaKey = crypto.randomBytes(32)
  const { iv, cipherKey, macKey } = expand(mediaKey, type)
  const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
  const hmac = crypto.createHmac('sha256', macKey).update(iv)
  const plainHash = crypto.createHash('sha256')
  const encHash = crypto.createHash('sha256')
  const out = fs.createWriteStream(outputPath)
  const failed = new Promise((_, reject) => out.once('error', reject))
  failed.catch(() => {})
  const write = (chunk) =>
    Promise.race([new Promise((resolve) => (out.write(chunk) ? resolve() : out.once('drain', resolve))), failed])
  let fileLength = 0
  try {
    const source = handle.createReadStream({ autoClose: false, start: 0 })
    for await (const chunk of source) {
      fileLength += chunk.length
      // El límite se aplica durante toda la lectura, no solo antes: un archivo que crece en
      // paralelo no puede saltarse el contador.
      if (fileLength > maxBytes) throw new RangeError(`file exceeds the ${maxBytes}-byte limit`)
      plainHash.update(chunk)
      const enc = cipher.update(chunk)
      if (enc.length) {
        hmac.update(enc)
        encHash.update(enc)
        await write(enc)
      }
    }
    const tail = cipher.final()
    if (tail.length) {
      hmac.update(tail)
      encHash.update(tail)
      await write(tail)
    }
    const mac = hmac.digest().subarray(0, 10)
    encHash.update(mac)
    await write(mac)
    await new Promise((resolve, reject) => {
      out.once('error', reject)
      out.end(resolve)
    })
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new ZyrixError('the media file changed while it was being encrypted', { kind: ErrorKind.MEDIA, errorCode: 'MEDIA_FILE_CHANGED' })
    }
  } catch (error) {
    out.destroy()
    throw error
  }
  return { mediaKey, fileSha256: plainHash.digest(), fileEncSha256: encHash.digest(), fileLength }
}

const encryptMediaFile = async (inputPath, outputPath, type, options = {}) => {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
  const handle = await fs.promises.open(inputPath, flags)
  try {
    return await encryptMediaFileFromHandle(handle, outputPath, type, options)
  } finally {
    await handle.close().catch(() => {})
  }
}

const decryptMediaToFile = async (encryptedStream, outputPath, mediaKey, type, { maxBytes = Infinity } = {}) => {
  if (!encryptedStream || typeof encryptedStream[Symbol.asyncIterator] !== 'function') throw new TypeError('encryptedStream must be async iterable')
  if (typeof outputPath !== 'string' || !outputPath) throw new TypeError('outputPath must be a non-empty path')
  if (!(maxBytes === Infinity || Number.isSafeInteger(maxBytes) && maxBytes > 0)) throw new TypeError('maxBytes must be a positive integer')
  const target = path.resolve(outputPath)
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`)
  const { iv, cipherKey, macKey } = expand(mediaKey, type)
  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv)
  const hmac = crypto.createHmac('sha256', macKey).update(iv)
  let handle
  let tail = Buffer.alloc(0)
  let encryptedBytes = 0
  let encryptedPayloadBytes = 0
  let plainBytes = 0
  const maxEncryptedBytes = maxBytes === Infinity ? Infinity : Math.ceil(maxBytes / 16) * 16 + 26
  const writeAll = async (buffer) => {
    let offset = 0
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset)
      if (!bytesWritten) throw new ZyrixError('could not write the decrypted file', { kind: ErrorKind.MEDIA, errorCode: 'MEDIA_WRITE_FAILED' })
      offset += bytesWritten
    }
  }
  try {
    handle = await fs.promises.open(temp, 'wx', 0o600)
    for await (const chunk of encryptedStream) {
      const part = Buffer.from(chunk)
      encryptedBytes += part.length
      if (encryptedBytes > maxEncryptedBytes) throw new RangeError(`media exceeds the ${maxBytes}-byte limit`)
      const joined = tail.length ? Buffer.concat([tail, part]) : part
      if (joined.length <= 10) {
        tail = joined
        continue
      }
      const split = joined.length - 10
      const cipherText = joined.subarray(0, split)
      tail = Buffer.from(joined.subarray(split))
      encryptedPayloadBytes += cipherText.length
      hmac.update(cipherText)
      const plain = decipher.update(cipherText)
      plainBytes += plain.length
      if (plainBytes > maxBytes) throw new RangeError(`media exceeds the ${maxBytes}-byte limit`)
      if (plain.length) await writeAll(plain)
    }
    if (tail.length !== 10 || encryptedPayloadBytes < 16 || encryptedPayloadBytes % 16 !== 0) {
      throw new ZyrixError('encrypted media is truncated or malformed', { kind: ErrorKind.DECRYPT, errorCode: 'MEDIA_TRUNCATED' })
    }
    const expected = hmac.digest().subarray(0, 10)
    if (!crypto.timingSafeEqual(expected, tail)) throw new ZyrixError('invalid media MAC', { kind: ErrorKind.DECRYPT, errorCode: 'MEDIA_MAC_INVALID' })
    const final = decipher.final()
    plainBytes += final.length
    if (plainBytes > maxBytes) throw new RangeError(`media exceeds the ${maxBytes}-byte limit`)
    if (final.length) await writeAll(final)
    await handle.sync()
    await handle.close()
    handle = null
    // link es atómico y falla si outputPath ya existe; nunca pisa un archivo del usuario.
    await fs.promises.link(temp, target)
    await fs.promises.rm(temp, { force: true })
    return target
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fs.promises.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

const decryptMedia = (body, mediaKey, type) => {
  if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) throw new TypeError('encrypted media must be a Buffer or Uint8Array')
  body = Buffer.from(body)
  if (body.length < 26 || (body.length - 10) % 16 !== 0) throw new ZyrixError('encrypted media is truncated or malformed', { kind: ErrorKind.DECRYPT, errorCode: 'MEDIA_TRUNCATED' })
  const { iv, cipherKey, macKey } = expand(mediaKey, type)
  const enc = body.subarray(0, body.length - 10)
  const mac = body.subarray(body.length - 10)
  const expected = hmacSha256(Buffer.concat([iv, enc]), macKey).subarray(0, 10)
  if (!crypto.timingSafeEqual(expected, mac)) throw new ZyrixError('invalid media MAC', { kind: ErrorKind.DECRYPT, errorCode: 'MEDIA_MAC_INVALID' })
  return aesCbcDecrypt(enc, cipherKey, iv)
}

export { encryptMedia, encryptMediaFile, encryptMediaFileFromHandle, decryptMedia, decryptMediaToFile }
