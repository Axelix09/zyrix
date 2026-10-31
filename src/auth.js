import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Curve, signalPub } from './crypto.js'

export const MAX_MONGO_DOCUMENT_BYTES = 16 * 1024 * 1024 - 2048

export function initKeys(initial = {}) {
  const base = {
    sessions: {},
    preKeys: {},
    identityKeys: {},
    senderKeys: {},
    jidMapping: {},
    appStateKeys: {},
    appStateVersions: {},
    appStateLTHash: {},
    ...initial
  }

  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'string' && prop !== 'toJSON' && prop !== 'then' && !(prop in target)) {
        target[prop] = {}
      }
      return target[prop]
    }
  })
}

export function repairCreds(creds) {
  const spk = creds && creds.signedPreKey
  if (!spk || !spk.keyPair || !creds.signedIdentityKey) return false
  const msg = signalPub(spk.keyPair.public)
  if (spk.signature && Curve.verify(creds.signedIdentityKey.public, msg, spk.signature)) return false
  spk.signature = Curve.sign(creds.signedIdentityKey.private, msg)
  return true
}

export function initCreds() {
  const identityKey = Curve.generateKeyPair()
  const signedPreKey = Curve.generateKeyPair()
  const signature = Curve.sign(identityKey.private, signalPub(signedPreKey.public))

  return {
    noiseKey: Curve.generateKeyPair(),
    pairingEphemeralKeyPair: Curve.generateKeyPair(),
    signedIdentityKey: identityKey,
    signedPreKey: {
      keyPair: signedPreKey,
      signature,
      keyId: 1
    },
    registrationId: Math.floor(Math.random() * 16380) + 1,
    advSecretKey: crypto.randomBytes(32).toString('base64'),
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    registered: false
  }
}

const bufferReviver = (k, v) => {
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) {
    return Buffer.from(v.data)
  }
  return v
}

export function useFileAuthState(dir, options = {}) {
  const debounceMs = options.debounceMs ?? 300
  const sessionDir = path.resolve(dir)
  const statePath = path.join(sessionDir, 'state.json')
  const backupPath = path.join(sessionDir, 'state.json.bak')
  const tempPath = path.join(sessionDir, 'state.json.tmp')

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  }

  let state = { creds: initCreds(), keys: initKeys() }
  let saveTimer = null
  let pendingData = null
  let isSaving = false
  let saveChain = Promise.resolve()

  if (fs.existsSync(statePath)) {
    try {
      const raw = fs.readFileSync(statePath, 'utf8')
      const parsed = JSON.parse(raw, bufferReviver)
      state = {
        creds: parsed.creds || initCreds(),
        keys: initKeys(parsed.keys)
      }
    } catch {
      if (fs.existsSync(backupPath)) {
        try {
          const rawBak = fs.readFileSync(backupPath, 'utf8')
          const parsedBak = JSON.parse(rawBak, bufferReviver)
          state = {
            creds: parsedBak.creds || initCreds(),
            keys: initKeys(parsedBak.keys)
          }
        } catch (err) {
          throw new Error('Archivo de sesión y respaldo corruptos: ' + err.message)
        }
      } else {
        throw new Error('Archivo de sesión corrupto sin respaldo disponible')
      }
    }
  }

  const writeDisk = (payload) => {
    const write = saveChain.then(async () => {
      isSaving = true
      try {
        await fsPromises.writeFile(tempPath, payload, { mode: 0o600, encoding: 'utf8' })
        if (fs.existsSync(statePath)) {
          await fsPromises.copyFile(statePath, backupPath)
        }
        await fsPromises.rename(tempPath, statePath)
      } catch (err) {
        if (typeof authObject.onSaveError === 'function') {
          authObject.onSaveError(err)
        }
      } finally {
        isSaving = false
      }
    })
    saveChain = write
    return write
  }

  const scheduleSave = () => {
    pendingData = JSON.stringify(state, null, 2)
    if (saveTimer) return

    saveTimer = setTimeout(async () => {
      saveTimer = null
      if (pendingData) {
        const toWrite = pendingData
        pendingData = null
        await writeDisk(toWrite)
      }
    }, debounceMs)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  const authObject = {
    state,
    save: scheduleSave,
    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      if (pendingData) {
        const toWrite = pendingData
        pendingData = null
        await writeDisk(toWrite)
      }
      await saveChain
    },
    onSaveError: null
  }

  if (repairCreds(state.creds)) scheduleSave()

  return authObject
}

export function memoryAdapter(initial = null) {
  let inMemory = initial ?? null
  return {
    read() {
      return inMemory
    },
    write(data) {
      inMemory = String(data)
    }
  }
}

export function mongoAdapter(collection, id = 'default') {
  if (!collection || typeof collection.findOne !== 'function' || typeof collection.updateOne !== 'function') {
    throw new Error('mongoAdapter requiere una colección válida con findOne y updateOne')
  }

  return {
    async read() {
      const doc = await collection.findOne({ _id: id })
      return doc?.data ?? null
    },

    async write(data) {
      if (typeof data !== 'string') {
        throw new Error('Los datos a persistir en mongoAdapter deben ser un string serializado')
      }

      const byteLength = Buffer.byteLength(data, 'utf8')
      if (byteLength > MAX_MONGO_DOCUMENT_BYTES) {
        const err = new Error(`El estado de la sesión supera el límite BSON de 16 MB (${(byteLength / (1024 * 1024)).toFixed(2)} MB).`)
        err.code = 'SESSION_TOO_LARGE'
        throw err
      }

      await collection.updateOne(
        { _id: id },
        { $set: { data, updatedAt: new Date(), byteLength } },
        { upsert: true }
      )
    }
  }
}

export async function useAdapterAuthState(adapter, options = {}) {
  const debounceMs = options.debounceMs ?? 300

  let state = { creds: initCreds(), keys: initKeys() }
  let saveTimer = null
  let pendingData = null
  let isSaving = false

  const initial = await adapter.read()
  if (initial) {
    try {
      const parsed = JSON.parse(initial, bufferReviver)
      state = {
        creds: parsed.creds || initCreds(),
        keys: initKeys(parsed.keys)
      }
    } catch (err) {
      throw new Error('El estado persistido en el adaptador no es un JSON válido: ' + err.message)
    }
  }

  const writeAdapter = async (payload) => {
    isSaving = true
    try {
      await adapter.write(payload)
    } catch (err) {
      if (typeof authObject.onSaveError === 'function') {
        authObject.onSaveError(err)
      }
    } finally {
      isSaving = false
    }
  }

  const scheduleSave = () => {
    pendingData = JSON.stringify(state, null, 2)
    if (saveTimer) return

    saveTimer = setTimeout(async () => {
      saveTimer = null
      if (pendingData) {
        const toWrite = pendingData
        pendingData = null
        await writeAdapter(toWrite)
      }
    }, debounceMs)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  const authObject = {
    state,
    save: scheduleSave,
    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      if (pendingData) {
        const toWrite = pendingData
        pendingData = null
        await writeAdapter(toWrite)
      }
      while (isSaving) {
        await new Promise(r => setTimeout(r, 10))
      }
    },
    onSaveError: null
  }

  return authObject
}

export async function useMemoryAuthState(initial = null) {
  return await useAdapterAuthState(memoryAdapter(initial), { debounceMs: 0 })
}
