import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Curve, signalPub } from './crypto.js'
import { createSnapshotCodec, validateSessionEncryptionKey } from './auth-snapshot.js'
import { ZyrixError, ErrorKind } from './errors.js'

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
    registrationId: crypto.randomInt(1, 16381),
    advSecretKey: crypto.randomBytes(32).toString('base64'),
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    registered: false
  }
}

const isEncryptedSnapshot = (raw) => {
  try { return JSON.parse(raw)?.format === 'zyrix-auth-encrypted-v1' } catch { return false }
}

export function useFileAuthState(dir, options = {}) {
  const debounceMs = options.debounceMs ?? 300
  const encryptionKey = validateSessionEncryptionKey(options.encryptionKey)
  const codec = createSnapshotCodec(encryptionKey)
  const sessionDir = path.resolve(dir)
  const statePath = path.join(sessionDir, 'state.json')
  const backupPath = path.join(sessionDir, 'state.json.bak')
  const tempPath = path.join(sessionDir, 'state.json.tmp')

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  }
  const dirInfo = fs.lstatSync(sessionDir)
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new ZyrixError('the session directory must be a real directory, not a symlink', { kind: ErrorKind.AUTH, errorCode: 'SESSION_DIR_INVALID' })
  if (process.platform !== 'win32') fs.chmodSync(sessionDir, 0o700)
  for (const file of [statePath, backupPath]) {
    let info
    try { info = fs.lstatSync(file) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new ZyrixError(`invalid session file or symlink: ${file}`, { kind: ErrorKind.AUTH, errorCode: 'SESSION_FILE_INVALID' })
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  }
  // Un temporal huérfano solo puede venir de un proceso que murió entre escribir y renombrar:
  // nunca contiene el estado vigente, y si se deja, la escritura con flag 'wx' fallaría.
  try {
    const tmpInfo = fs.lstatSync(tempPath)
    if (tmpInfo.isFile() || tmpInfo.isSymbolicLink()) fs.rmSync(tempPath, { force: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  let state = { creds: initCreds(), keys: initKeys() }
  let saveTimer = null
  let dirty = false
  let saveChain = Promise.resolve()
  let shouldMigratePlaintext = false

  if (fs.existsSync(statePath)) {
    try {
      const raw = fs.readFileSync(statePath, 'utf8')
      const parsed = codec.parse(raw)
      shouldMigratePlaintext = Boolean(encryptionKey) && !isEncryptedSnapshot(raw)
      state = {
        creds: parsed.creds || initCreds(),
        keys: initKeys(parsed.keys)
      }
    } catch {
      if (fs.existsSync(backupPath)) {
        try {
          const rawBak = fs.readFileSync(backupPath, 'utf8')
          const parsedBak = codec.parse(rawBak)
          shouldMigratePlaintext = Boolean(encryptionKey) && !isEncryptedSnapshot(rawBak)
          state = {
            creds: parsedBak.creds || initCreds(),
            keys: initKeys(parsedBak.keys)
          }
        } catch (err) {
          throw new ZyrixError('session file and backup are corrupt: ' + err.message, { kind: ErrorKind.AUTH, errorCode: 'SESSION_CORRUPT' })
        }
      } else {
        throw new ZyrixError('session file is corrupt and no backup is available', { kind: ErrorKind.AUTH, errorCode: 'SESSION_CORRUPT' })
      }
    }
  }

  // La serialización (JSON + cifrado) se hace recién al escribir, no en cada save():
  // save() se llama muchas veces por mensaje y el debounce agrupa todas en una escritura.
  const writeDisk = () => {
    const write = saveChain.catch(() => {}).then(async () => {
      if (!dirty) return
      dirty = false
      const payload = codec.serialize(state)
      try {
        await fsPromises.writeFile(tempPath, payload, { mode: 0o600, encoding: 'utf8', flag: 'wx' })
        if (process.platform !== 'win32') await fsPromises.chmod(tempPath, 0o600)
        if (fs.existsSync(statePath)) {
          const previous = await fsPromises.readFile(statePath, 'utf8')
          if (encryptionKey && !isEncryptedSnapshot(previous)) {
            await fsPromises.writeFile(backupPath, payload, { mode: 0o600, encoding: 'utf8' })
          } else {
            await fsPromises.copyFile(statePath, backupPath)
          }
          if (process.platform !== 'win32') await fsPromises.chmod(backupPath, 0o600)
        }
        await fsPromises.rename(tempPath, statePath)
        if (process.platform !== 'win32') await fsPromises.chmod(statePath, 0o600)
      } catch (err) {
        dirty = true
        await fsPromises.rm(tempPath, { force: true }).catch(() => {})
        if (typeof authObject.onSaveError === 'function') authObject.onSaveError(err)
        throw err
      }
    })
    saveChain = write
    return write
  }

  const scheduleSave = () => {
    dirty = true
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      writeDisk().catch(() => {})
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
      if (dirty) await writeDisk()
      await saveChain
    },
    onSaveError: null
  }

  if (repairCreds(state.creds) || shouldMigratePlaintext) scheduleSave()

  return authObject
}
