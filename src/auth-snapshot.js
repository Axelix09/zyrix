import crypto from 'node:crypto'
import { jsonReplacer, jsonReviver } from './util.js'

const ENVELOPE = 'zyrix-auth-encrypted-v1'
const AAD = Buffer.from(ENVELOPE)
const normalizeKey = (keyMaterial) => {
  if (keyMaterial === undefined || keyMaterial === null) return null
  const input = typeof keyMaterial === 'string'
    ? Buffer.from(keyMaterial, 'utf8')
    : Buffer.isBuffer(keyMaterial) || keyMaterial instanceof Uint8Array
      ? Buffer.from(keyMaterial)
      : null
  if (!input || input.length < 16) throw new TypeError('encryptionKey debe ser una cadena o Uint8Array de al menos 16 bytes; usa un secreto aleatorio externo al almacenamiento')
  return input
}
const deriveKey = (keyMaterial, salt) => {
  const input = normalizeKey(keyMaterial)
  if (!input) return null
  return crypto.scryptSync(input, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}
export const validateSessionEncryptionKey = (keyMaterial) => { normalizeKey(keyMaterial); return keyMaterial }

export function serializeAuthSnapshot(state, encryptionKey) {
  const plaintext = JSON.stringify({ version: 1, ...state }, jsonReplacer)
  if (encryptionKey === undefined || encryptionKey === null) return plaintext

  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = deriveKey(encryptionKey, salt)
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

export function parseAuthSnapshot(serialized, encryptionKey) {
  if (typeof serialized !== 'string') throw new TypeError('el estado de autenticación debe ser una cadena')
  let parsed = JSON.parse(serialized)
  if (parsed?.format === ENVELOPE) {
    if (encryptionKey === undefined || encryptionKey === null) {
      throw new Error('la sesión está cifrada; proporciona la misma opción encryptionKey para abrirla')
    }
    try {
      const salt = Buffer.from(parsed.salt, 'base64')
      const iv = Buffer.from(parsed.iv, 'base64')
      const tag = Buffer.from(parsed.tag, 'base64')
      const ciphertext = Buffer.from(parsed.data, 'base64')
      if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('sobre de sesión inválido')
      const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(encryptionKey, salt), iv)
      decipher.setAAD(AAD)
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      parsed = JSON.parse(plaintext, jsonReviver)
    } catch (cause) {
      throw new Error('no se pudo descifrar la sesión; verifica encryptionKey y la integridad del archivo', { cause })
    }
  } else {
    parsed = JSON.parse(serialized, jsonReviver)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('snapshot de autenticación inválido')
  return parsed
}
