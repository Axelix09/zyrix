import crypto from 'crypto'
import { initCreds, initKeys } from './auth.js'
import { parseAuthSnapshot, serializeAuthSnapshot, validateSessionEncryptionKey } from './auth-snapshot.js'
import { ZyrixError, ErrorKind } from './errors.js'
import { MAX_MONGO_DOCUMENT_BYTES } from './auth.js'

const memoryAdapter = (initial = null) => {
  let data = initial
  return {
    read: () => data,
    write: (value) => {
      data = value
    }
  }
}

const mongoAdapter = (collection, id = 'zyrix-session') => {
  if (!collection || typeof collection.findOne !== 'function' || typeof collection.updateOne !== 'function') {
    throw new TypeError('collection debe ser una colección de MongoDB con findOne y updateOne')
  }
  return {
    async read() {
      const doc = await collection.findOne({ _id: id })
      return doc ? doc.data : null
    },
    async write(data) {
      if (typeof data !== 'string') throw new TypeError('mongoAdapter requiere un snapshot serializado como string')
      const byteLength = Buffer.byteLength(data, 'utf8')
      if (byteLength > MAX_MONGO_DOCUMENT_BYTES) {
        const err = new Error(`El estado de sesión supera el límite BSON seguro de 16 MB (${(byteLength / (1024 * 1024)).toFixed(2)} MB).`)
        err.code = 'SESSION_TOO_LARGE'
        throw err
      }
      await collection.updateOne({ _id: id }, { $set: { data, updatedAt: new Date(), byteLength } }, { upsert: true })
    }
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const useAdapterAuthState = async (adapter, { debounceMs = 300, encryptionKey: suppliedKey } = {}) => {
  const encryptionKey = validateSessionEncryptionKey(suppliedKey)
  if (!adapter || typeof adapter.read !== 'function' || typeof adapter.write !== 'function') {
    throw new TypeError('adapter debe tener read() y write(data)')
  }
  const raw = await adapter.read()
  let snapshot = null
  if (raw) {
    try {
      snapshot = parseAuthSnapshot(typeof raw === 'string' ? raw : JSON.stringify(raw), encryptionKey)
    } catch (cause) {
      throw new ZyrixError(`No se pudo leer la sesión del adaptador: ${cause.message}`, { kind: ErrorKind.AUTH, cause })
    }
    if (!isPlainObject(snapshot) || !isPlainObject(snapshot.creds) || !isPlainObject(snapshot.keys)) {
      throw new ZyrixError('La sesión guardada en el adaptador tiene un formato inválido', { kind: ErrorKind.AUTH })
    }
  }
  const defaults = initKeys()
  const savedKeys = (snapshot && snapshot.keys) || {}
  for (const key of Object.keys(defaults)) {
    if (savedKeys[key] !== undefined && !isPlainObject(savedKeys[key])) {
      throw new ZyrixError(`Formato inválido para ${key} en la sesión del adaptador`, { kind: ErrorKind.AUTH })
    }
  }
  const state = {
    creds: Object.assign(initCreds(), (snapshot && snapshot.creds) || {}),
    keys: Object.fromEntries(Object.keys(defaults).map((key) => [key, Object.assign(defaults[key], savedKeys[key] || {})]))
  }

  const serialize = () => serializeAuthSnapshot({ creds: state.creds, keys: state.keys }, encryptionKey)
  const auth = { state, save: null, flush: null, onSaveError: null }
  let timer = null
  let dirty = false
  let chain = Promise.resolve()

  const flush = () => {
    clearTimeout(timer)
    timer = null
    if (dirty) {
      dirty = false
      const data = serialize()
      chain = chain.catch(() => {}).then(() => adapter.write(data)).catch((err) => {
        dirty = true
        if (typeof auth.onSaveError === 'function') auth.onSaveError(err)
        throw err
      })
    }
    return chain
  }

  auth.save = () => {
    dirty = true
    if (!timer) {
      timer = setTimeout(() => {
        timer = null
        flush().catch(() => {})
      }, debounceMs)
    }
  }
  auth.flush = flush
  await adapter.write(serialize())
  return auth
}

const useMemoryAuthState = (initial) => useAdapterAuthState(memoryAdapter(initial))

export { useAdapterAuthState, useMemoryAuthState, memoryAdapter, mongoAdapter }
