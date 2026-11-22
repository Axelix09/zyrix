import crypto from 'node:crypto'
import { jsonReplacer, jsonReviver } from './util.js'
import { ZyrixError, ErrorKind } from './errors.js'

const ENVELOPE = 'zyrix-auth-encrypted-v1'
const AAD = Buffer.from(ENVELOPE)
const normalizeKey = (keyMaterial) => {
  if (keyMaterial === undefined || keyMaterial === null) return null
  const input = typeof keyMaterial === 'string'
    ? Buffer.from(keyMaterial, 'utf8')
    : Buffer.isBuffer(keyMaterial) || keyMaterial instanceof Uint8Array
      ? Buffer.from(keyMaterial)
      : null
  if (!input || input.length < 16) throw new TypeError('encryptionKey must be a string or Uint8Array of at least 16 bytes; use a random secret kept outside the storage')
  return input
}
const deriveKey = (keyMaterial, salt) => {
  const input = normalizeKey(keyMaterial)
  if (!input) return null
  return crypto.scryptSync(input, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}
export const validateSessionEncryptionKey = (keyMaterial) => { normalizeKey(keyMaterial); return keyMaterial }

const encryptWith = (plaintext, key, salt) => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return JSON.stringify({
    format: ENVELOPE,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  })
}

const decryptEnvelope = (parsed, keyForSalt) => {
  try {
    const salt = Buffer.from(parsed.salt, 'base64')
    const iv = Buffer.from(parsed.iv, 'base64')
    const tag = Buffer.from(parsed.tag, 'base64')
    const ciphertext = Buffer.from(parsed.data, 'base64')
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new ZyrixError('invalid session envelope', { kind: ErrorKind.AUTH, errorCode: 'SESSION_ENVELOPE_INVALID' })
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyForSalt(salt), iv)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    return JSON.parse(plaintext, jsonReviver)
  } catch (cause) {
    throw new ZyrixError('could not decrypt the session; check encryptionKey and the file integrity', { kind: ErrorKind.AUTH, errorCode: 'SESSION_DECRYPT_FAILED', cause })
  }
}

const finishParse = (parsed) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ZyrixError('invalid auth snapshot', { kind: ErrorKind.AUTH, errorCode: 'SESSION_SNAPSHOT_INVALID' })
  return parsed
}

const parseWith = (serialized, encryptionKey, keyForSalt) => {
  if (typeof serialized !== 'string') throw new TypeError('the auth state must be a string')
  const parsed = JSON.parse(serialized)
  if (parsed?.format === ENVELOPE) {
    if (encryptionKey === undefined || encryptionKey === null) {
      throw new ZyrixError('the session is encrypted; pass the same encryptionKey option to open it', { kind: ErrorKind.AUTH, errorCode: 'SESSION_ENCRYPTED' })
    }
    return finishParse(decryptEnvelope(parsed, keyForSalt))
  }
  return finishParse(JSON.parse(serialized, jsonReviver))
}

export function serializeAuthSnapshot(state, encryptionKey) {
  const plaintext = JSON.stringify({ version: 1, ...state }, jsonReplacer)
  if (encryptionKey === undefined || encryptionKey === null) return plaintext
  const salt = crypto.randomBytes(16)
  return encryptWith(plaintext, deriveKey(encryptionKey, salt), salt)
}

export function parseAuthSnapshot(serialized, encryptionKey) {
  return parseWith(serialized, encryptionKey, (salt) => deriveKey(encryptionKey, salt))
}

/**
 * Codec con caché de la clave derivada. scrypt es deliberadamente costoso (~30-50 ms y
 * bloquea el event loop), así que se deriva una sola vez por sesión: se reutiliza el
 * salt del snapshot leído (o uno aleatorio nuevo) y cada escritura usa un IV aleatorio
 * de 96 bits distinto, que es lo que AES-GCM exige para reutilizar la clave con seguridad.
 */
export function createSnapshotCodec(encryptionKey) {
  validateSessionEncryptionKey(encryptionKey)
  const encrypted = encryptionKey !== undefined && encryptionKey !== null
  const derived = new Map()
  let writeSalt = null
  const keyForSalt = (salt) => {
    const id = salt.toString('base64')
    let key = derived.get(id)
    if (!key) {
      key = deriveKey(encryptionKey, salt)
      derived.set(id, key)
    }
    return key
  }
  return {
    encrypted,
    serialize(state) {
      const plaintext = JSON.stringify({ version: 1, ...state }, jsonReplacer)
      if (!encrypted) return plaintext
      if (!writeSalt) writeSalt = derived.size ? Buffer.from(derived.keys().next().value, 'base64') : crypto.randomBytes(16)
      return encryptWith(plaintext, keyForSalt(writeSalt), writeSalt)
    },
    parse(serialized) {
      return parseWith(serialized, encryptionKey, keyForSalt)
    }
  }
}
