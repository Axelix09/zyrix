import { initCreds, initKeys } from './auth.js'
import { createSnapshotCodec, validateSessionEncryptionKey } from './auth-snapshot.js'
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
    throw new TypeError('collection must be a MongoDB collection with findOne and updateOne')
  }
  return {
    async read() {
      const doc = await collection.findOne({ _id: id })
      return doc ? doc.data : null
    },
    async write(data) {
      if (typeof data !== 'string') throw new TypeError('mongoAdapter requires a snapshot serialized as a string')
      const byteLength = Buffer.byteLength(data, 'utf8')
      if (byteLength > MAX_MONGO_DOCUMENT_BYTES) {
        const err = new ZyrixError(`the session state exceeds the safe 16 MB BSON limit (${(byteLength / (1024 * 1024)).toFixed(2)} MB)`, { kind: ErrorKind.AUTH, errorCode: 'SESSION_TOO_LARGE' })
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
  const codec = createSnapshotCodec(encryptionKey)
  if (!adapter || typeof adapter.read !== 'function' || typeof adapter.write !== 'function') {
    throw new TypeError('adapter must have read() and write(data)')
  }
  const raw = await adapter.read()
  let snapshot = null
  if (raw) {
    try {
      snapshot = codec.parse(typeof raw === 'string' ? raw : JSON.stringify(raw))
    } catch (cause) {
      throw new ZyrixError(`could not read the session from the adapter: ${cause.message}`, { kind: ErrorKind.AUTH, errorCode: cause?.errorCode || 'SESSION_READ_FAILED', cause })
    }
    if (!isPlainObject(snapshot) || !isPlainObject(snapshot.creds) || !isPlainObject(snapshot.keys)) {
      throw new ZyrixError('the session stored in the adapter has an invalid format', { kind: ErrorKind.AUTH, errorCode: 'SESSION_SNAPSHOT_INVALID' })
    }
  }
  const defaults = initKeys()
  const savedKeys = (snapshot && snapshot.keys) || {}
  for (const key of Object.keys(defaults)) {
    if (savedKeys[key] !== undefined && !isPlainObject(savedKeys[key])) {
      throw new ZyrixError(`invalid format for ${key} in the adapter session`, { kind: ErrorKind.AUTH, errorCode: 'SESSION_SNAPSHOT_INVALID' })
    }
  }
  const state = {
    creds: Object.assign(initCreds(), (snapshot && snapshot.creds) || {}),
    keys: initKeys(Object.fromEntries(Object.keys(defaults).map((key) => [key, Object.assign(defaults[key], savedKeys[key] || {})])))
  }

  const serialize = () => codec.serialize({ creds: state.creds, keys: state.keys })
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
