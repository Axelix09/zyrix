import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Curve, signalPub } from './crypto.js'
import { createSnapshotCodec, validateSessionEncryptionKey } from './auth-snapshot.js'
import { ZyrixError, ErrorKind } from './errors.js'

export const MAX_MONGO_DOCUMENT_BYTES = 16 * 1024 * 1024 - 2048
export const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024

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

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const KEY_SECTIONS = ['sessions', 'preKeys', 'identityKeys', 'senderKeys', 'jidMapping', 'appStateKeys', 'appStateVersions', 'appStateLTHash']

// Validación estructural compartida por el adaptador de archivo y los adaptadores genéricos.
// Un snapshot que es JSON válido pero no representa una sesión Signal debe fallar en vez de
// convertirse silenciosamente en una sesión nueva: crear credenciales nuevas sin querer es
// indistinguible de perder la cuenta y suele terminar en un pairing inesperado.
export function validateSessionSnapshot(snapshot, errorCode = 'SESSION_SNAPSHOT_INVALID') {
  const fail = (message) => new ZyrixError(message, { kind: ErrorKind.AUTH, errorCode })
  if (!isPlainObject(snapshot)) throw fail('the session snapshot is not a JSON object')
  if (snapshot.format !== undefined) throw fail(`unknown session snapshot format: ${String(snapshot.format)}`)
  if (snapshot.version !== undefined && snapshot.version !== 1) throw fail(`unsupported session snapshot version: ${String(snapshot.version)}`)
  const { creds, keys } = snapshot
  if (!isPlainObject(creds)) throw fail('the session snapshot has no valid creds object')
  if (!isPlainObject(keys)) throw fail('the session snapshot has no valid keys object')
  for (const field of ['noiseKey', 'signedIdentityKey']) {
    const kp = creds[field]
    if (!isPlainObject(kp) || !Buffer.isBuffer(kp.public) || !Buffer.isBuffer(kp.private)) throw fail(`the session snapshot has an invalid ${field}`)
  }
  const ephemeral = creds.pairingEphemeralKeyPair
  if (ephemeral !== undefined && (!isPlainObject(ephemeral) || !Buffer.isBuffer(ephemeral.public) || !Buffer.isBuffer(ephemeral.private))) {
    throw fail('the session snapshot has an invalid pairingEphemeralKeyPair')
  }
  const spk = creds.signedPreKey
  if (!isPlainObject(spk) || !isPlainObject(spk.keyPair) || !Buffer.isBuffer(spk.keyPair.public) || !Buffer.isBuffer(spk.keyPair.private) || !Buffer.isBuffer(spk.signature) || !Number.isSafeInteger(spk.keyId)) {
    throw fail('the session snapshot has an invalid signedPreKey')
  }
  if (!Number.isSafeInteger(creds.registrationId) || creds.registrationId < 1) throw fail('the session snapshot has an invalid registrationId')
  for (const section of KEY_SECTIONS) {
    if (keys[section] !== undefined && !isPlainObject(keys[section])) throw fail(`the session snapshot has an invalid keys.${section}`)
  }
  return snapshot
}

const STALE_TEMP_MS = 30000
const dirQueues = new Map()

const withDirQueue = (key, fn) => {
  const previous = dirQueues.get(key) || Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  dirQueues.set(key, tail)
  tail.then(() => { if (dirQueues.get(key) === tail) dirQueues.delete(key) })
  return run
}

// Lock entre procesos: 'wx' es atómico en la mayoría de sistemas de archivos. Un lock más
// viejo que STALE_TEMP_MS se considera abandonado por un proceso que murió.
const acquireLockFile = async (lockPath, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fsPromises.writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 })
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const info = await fsPromises.stat(lockPath)
        if (Date.now() - info.mtimeMs > STALE_TEMP_MS) { await fsPromises.rm(lockPath, { force: true }); continue }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() > deadline) throw new ZyrixError('timed out waiting for the session file lock', { kind: ErrorKind.AUTH, errorCode: 'SESSION_LOCK_TIMEOUT' })
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

export function useFileAuthState(dir, options = {}) {
  const debounceMs = options.debounceMs ?? 300
  const encryptionKey = validateSessionEncryptionKey(options.encryptionKey)
  const codec = createSnapshotCodec(encryptionKey)
  const sessionDir = path.resolve(dir)
  const statePath = path.join(sessionDir, 'state.json')
  const backupPath = path.join(sessionDir, 'state.json.bak')
  const tempPath = path.join(sessionDir, 'state.json.tmp')
  const lockPath = path.join(sessionDir, 'state.json.lock')

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
    if (info.size > MAX_SESSION_FILE_BYTES) throw new ZyrixError(`the session file exceeds the ${MAX_SESSION_FILE_BYTES}-byte limit`, { kind: ErrorKind.AUTH, errorCode: 'SESSION_TOO_LARGE' })
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  }
  // Un temporal huérfano puede ser la única copia válida si el proceso murió entre writeFile
  // y rename. Si ya existe state.json, el temporal es viejo y se descarta; si no existe, se
  // valida y se promueve, o se falla explícitamente. Nunca se borra a ciegas una copia buena.
  let tmpInfo = null
  try { tmpInfo = fs.lstatSync(tempPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (tmpInfo && (tmpInfo.isSymbolicLink() || !tmpInfo.isFile())) {
    throw new ZyrixError('the temporary session file must be a regular file, not a symlink', { kind: ErrorKind.AUTH, errorCode: 'SESSION_FILE_INVALID' })
  }
  const stateExists = fs.existsSync(statePath)
  if (tmpInfo) {
    if (!stateExists) {
      try {
        const rawTmp = fs.readFileSync(tempPath, 'utf8')
        validateSessionSnapshot(codec.parse(rawTmp), 'SESSION_TEMP_INVALID')
        if (process.platform !== 'win32') fs.chmodSync(tempPath, 0o600)
        fs.renameSync(tempPath, statePath)
      } catch (cause) {
        throw new ZyrixError('a temporary session file exists but is not a valid snapshot: ' + cause.message, { kind: ErrorKind.AUTH, errorCode: 'SESSION_TEMP_INVALID', cause })
      }
    } else {
      fs.rmSync(tempPath, { force: true })
    }
  }

  let state = { creds: initCreds(), keys: initKeys() }
  // Contenido exacto que esta instancia leyó o escribió por última vez. Si state.json cambia
  // por debajo, la escritura falla con SESSION_WRITE_CONFLICT en vez de pisar a la otra instancia.
  let lastRaw = null
  let saveTimer = null
  let dirty = false
  let saveChain = Promise.resolve()
  let shouldMigratePlaintext = false

  const readSnapshot = (file) => {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = codec.parse(raw)
    validateSessionSnapshot(parsed)
    return { parsed, raw }
  }

  if (fs.existsSync(statePath)) {
    try {
      const { parsed, raw } = readSnapshot(statePath)
      shouldMigratePlaintext = Boolean(encryptionKey) && !isEncryptedSnapshot(raw)
      lastRaw = raw
      state = { creds: parsed.creds, keys: initKeys(parsed.keys) }
    } catch (primary) {
      if (fs.existsSync(backupPath)) {
        try {
          const { parsed, raw } = readSnapshot(backupPath)
          shouldMigratePlaintext = Boolean(encryptionKey) && !isEncryptedSnapshot(raw)
          // El state.json primario está corrupto: permitir reemplazarlo en la próxima escritura.
          lastRaw = null
          state = { creds: parsed.creds, keys: initKeys(parsed.keys) }
        } catch (err) {
          throw new ZyrixError('session file and backup are corrupt: ' + err.message, { kind: ErrorKind.AUTH, errorCode: 'SESSION_CORRUPT', cause: err })
        }
      } else {
        throw new ZyrixError('session file is corrupt and no backup is available: ' + primary.message, { kind: ErrorKind.AUTH, errorCode: 'SESSION_CORRUPT', cause: primary })
      }
    }
  }

  // La serialización (JSON + cifrado) se hace recién al escribir, no en cada save():
  // save() se llama muchas veces por mensaje y el debounce agrupa todas en una escritura.
  // Una escritura completa ocurre dentro del lock de sesión y del mutex en proceso. Sin
  // esto, dos instancias pueden intercalar sus temporales y el rename de una pisa los
  // cambios de la otra sin ninguna señal (last-writer-wins silencioso).
  const persist = async () => {
    // La comparación ocurre dentro del lock, así que entre leer y renombrar no hay carrera
    // con otra instancia cooperativa.
    const existing = fs.existsSync(statePath) ? await fsPromises.readFile(statePath, 'utf8') : null
    if (lastRaw !== null && existing !== lastRaw) {
      throw new ZyrixError('the session file was modified by another instance since it was read', { kind: ErrorKind.AUTH, errorCode: 'SESSION_WRITE_CONFLICT' })
    }
    const payload = codec.serialize(state)
    try {
      await fsPromises.writeFile(tempPath, payload, { mode: 0o600, encoding: 'utf8', flag: 'wx' })
      if (process.platform !== 'win32') await fsPromises.chmod(tempPath, 0o600)
      if (existing !== null) {
        if (encryptionKey && !isEncryptedSnapshot(existing)) {
          await fsPromises.writeFile(backupPath, payload, { mode: 0o600, encoding: 'utf8' })
        } else {
          await fsPromises.copyFile(statePath, backupPath)
        }
        if (process.platform !== 'win32') await fsPromises.chmod(backupPath, 0o600)
      }
      await fsPromises.rename(tempPath, statePath)
      if (process.platform !== 'win32') await fsPromises.chmod(statePath, 0o600)
      lastRaw = payload
    } catch (err) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => {})
      throw err
    }
  }

  const writeDisk = () => {
    const write = saveChain.catch(() => {}).then(() => withDirQueue(statePath, async () => {
      if (!dirty) return
      await acquireLockFile(lockPath)
      try {
        if (!dirty) return
        dirty = false
        try {
          await persist()
        } catch (err) {
          dirty = true
          if (typeof authObject.onSaveError === 'function') authObject.onSaveError(err)
          throw err
        }
      } finally {
        await fsPromises.rm(lockPath, { force: true }).catch(() => {})
      }
    }))
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
