import crypto from 'crypto'
import { initCreds, initKeys } from './auth.js'
import { jsonReplacer, jsonReviver } from './util.js'
import { ZyrixError, ErrorKind } from './errors.js'

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
      await collection.updateOne({ _id: id }, { $set: { data, updatedAt: new Date() } }, { upsert: true })
    }
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const useAdapterAuthState = async (adapter, { debounceMs = 300 } = {}) => {
  if (!adapter || typeof adapter.read !== 'function' || typeof adapter.write !== 'function') {
    throw new TypeError('adapter debe tener read() y write(data)')
  }
  const raw = await adapter.read()
  let snapshot = null
  if (raw) {
    try {
      snapshot = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw), jsonReviver)
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

  const serialize = () => JSON.stringify({ version: 1, creds: state.creds, keys: state.keys }, jsonReplacer)
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
      chain = chain.then(() => adapter.write(data)).catch((err) => {
        dirty = true
        if (typeof auth.onSaveError === 'function') auth.onSaveError(err)
        else throw err
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
