import crypto from 'crypto'
import { proto } from './proto.js'
import { hkdf, hmacSha256, aesCbcEncrypt, aesCbcDecrypt } from './crypto.js'
import { getChild, getChildren } from './binary.js'
import { decryptMedia } from './mediacrypto.js'
import { S_WHATSAPP_NET as S, num } from './util.js'
import { ZyrixError, ErrorKind } from './errors.js'

const COLLECTIONS = ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular']
const MAX_SYNC_PAGES = 20
const isVersionConflict = (error) => error?.code === 409 || /version|conflict/i.test(String(error?.message || ''))
const SET = 0
const REMOVE = 1
const lthashItem = (value) => hkdf(Buffer.from(value), 128, null, 'WhatsApp Patch Integrity')
const to64 = (value) => { const b = Buffer.alloc(8); b.writeUInt32BE(value, 4); return b }
const pointwise = (base, input, subtract) => {
  for (let i = 0; i < base.length; i += 2) {
    const x = base.readUInt16LE(i)
    const y = input.readUInt16LE(i)
    base.writeUInt16LE(subtract ? (x - y) & 0xffff : (x + y) & 0xffff, i)
  }
}
const contentMac = (operation, content, keyId, key) => {
  const op = Buffer.from([operation === REMOVE ? 2 : 1])
  const id = Buffer.isBuffer(keyId) ? keyId : Buffer.from(keyId, 'base64')
  const data = Buffer.concat([op, id, content, to64(id.length + 1)])
  return crypto.createHmac('sha512', key).update(data).digest().subarray(0, 32)
}
const deriveKeys = (keyData) => {
  const k = hkdf(Buffer.from(keyData), 160, null, 'WhatsApp Mutation Keys')
  return { indexKey: k.subarray(0, 32), valueEncryptionKey: k.subarray(32, 64), valueMacKey: k.subarray(64, 96), snapshotMacKey: k.subarray(96, 128), patchMacKey: k.subarray(128, 160) }
}
const newLTHash = () => ({ version: 0, hash: Buffer.alloc(128), indexValueMap: {} })
const getLTHash = (state, name, reset = false) => {
  state.keys.appStateLTHash ||= {}
  if (reset || !state.keys.appStateLTHash[name]) state.keys.appStateLTHash[name] = newLTHash()
  const current = state.keys.appStateLTHash[name]
  if (!Buffer.isBuffer(current.hash) || current.hash.length !== 128) current.hash = Buffer.alloc(128)
  current.indexValueMap ||= {}
  current.version = Number.isSafeInteger(current.version) ? current.version : 0
  return current
}
const mix = (state, operation, indexMac, valueMac) => {
  const key = Buffer.from(indexMac).toString('base64')
  const previous = state.indexValueMap[key]
  if (previous?.valueMac) pointwise(state.hash, lthashItem(previous.valueMac), true)
  if (operation === REMOVE) delete state.indexValueMap[key]
  else {
    state.indexValueMap[key] = { valueMac: Buffer.from(valueMac) }
    pointwise(state.hash, lthashItem(valueMac), false)
  }
}

const cloneLTHash = (source) => ({
  version: source.version,
  hash: Buffer.from(source.hash),
  indexValueMap: Object.fromEntries(Object.entries(source.indexValueMap || {}).map(([key, entry]) => [key, { valueMac: Buffer.from(entry.valueMac) }]))
})

export default {
  async syncAppState(names = COLLECTIONS) {
    if (!Object.keys(this.auth.state.keys.appStateKeys).length || this.syncing) return
    this.syncing = true
    try { for (const name of names) await this.syncCollection(name) } finally { this.syncing = false }
  },

  async downloadBlob(ref) {
    const res = await fetch(`https://mmg.whatsapp.net${ref.directPath}`, { headers: { Origin: 'https://web.whatsapp.com' } })
    if (!res.ok) throw new ZyrixError('app-state blob download failed: ' + res.status, { kind: ErrorKind.PROTOCOL, errorCode: 'APPSTATE_BLOB_DOWNLOAD_FAILED' })
    return decryptMedia(Buffer.from(await res.arrayBuffer()), ref.mediaKey, 'md-app-state')
  },

  async syncCollection(name) {
    const versions = this.auth.state.keys.appStateVersions
    for (let guard = 0; guard < MAX_SYNC_PAGES; guard++) {
      const version = versions[name] || 0
      const res = await this.query({ tag: 'iq', attrs: { to: S, xmlns: 'w:sync:app:state', type: 'set' }, content: [{ tag: 'sync', attrs: {}, content: [{ tag: 'collection', attrs: { name, version: String(version), return_snapshot: String(!version) } }] }] })
      const col = getChild(getChild(res, 'sync'), 'collection')
      if (!col || getChild(col, 'error')) return
      const snapshot = getChild(col, 'snapshot')
      const patches = getChildren(getChild(col, 'patches'), 'patch')
      if (snapshot?.content) {
        const ref = proto.ExternalBlobReference.decode(snapshot.content)
        const snap = proto.SyncdSnapshot.decode(await this.downloadBlob(ref))
        getLTHash(this.auth.state, name, true)
        const r = this.applyMutations(snap.records.map((record) => ({ operation: SET, record })), name)
        if (r.missing) return
        versions[name] = num(snap.version && snap.version.version)
        getLTHash(this.auth.state, name).version = versions[name]
      }
      for (const p of patches) {
        const patch = proto.SyncdPatch.decode(p.content)
        let mutations = [...patch.mutations]
        if (patch.externalMutations) mutations = mutations.concat(proto.SyncdMutations.decode(await this.downloadBlob(patch.externalMutations)).mutations)
        const r = this.applyMutations(mutations, name)
        if (r.missing) return
        versions[name] = num(patch.version && patch.version.version)
        getLTHash(this.auth.state, name).version = versions[name]
      }
      this.auth.save()
      if (col.attrs.has_more_updates !== 'true') return
    }
    // Nunca fingir que una colección quedó sincronizada cuando el servidor sigue paginando.
    throw new ZyrixError(`app-state collection ${name} still has updates after ${MAX_SYNC_PAGES} pages`, { kind: ErrorKind.PROTOCOL, errorCode: 'APPSTATE_PAGINATION_LIMIT' })
  },

  applyMutations(list, collection) {
    const keys = this.auth.state.keys.appStateKeys
    const decoded = []
    let missing = 0
    for (const { operation, record } of list) {
      try {
        const keyId = Buffer.from(record.keyId.id)
        const rawKey = keys[keyId.toString('base64')]
        const keyData = rawKey?.keyData || rawKey
        if (!keyData) { missing++; continue }
        const blob = Buffer.from(record.value.blob)
        if (blob.length < 64 || !record.index?.blob) throw new ZyrixError('truncated app-state record', { kind: ErrorKind.DECRYPT, errorCode: 'APPSTATE_RECORD_TRUNCATED' })
        const content = blob.subarray(0, -32)
        const mac = blob.subarray(-32)
        const expanded = deriveKeys(keyData)
        const expectedMac = contentMac(operation, content, keyId, expanded.valueMacKey)
        if (!crypto.timingSafeEqual(expectedMac, mac)) throw new ZyrixError('invalid app-state value MAC', { kind: ErrorKind.DECRYPT, errorCode: 'APPSTATE_VALUE_MAC_INVALID' })
        const plain = aesCbcDecrypt(content.subarray(16), expanded.valueEncryptionKey, content.subarray(0, 16))
        const data = proto.SyncActionData.decode(plain)
        const expectedIndexMac = hmacSha256(Buffer.from(data.index), expanded.indexKey)
        const indexMac = Buffer.from(record.index.blob)
        if (!crypto.timingSafeEqual(expectedIndexMac, indexMac)) throw new ZyrixError('invalid app-state index MAC', { kind: ErrorKind.DECRYPT, errorCode: 'APPSTATE_INDEX_MAC_INVALID' })
        decoded.push({ index: JSON.parse(Buffer.from(data.index).toString('utf8')), value: data.value, operation: operation === REMOVE ? 'remove' : 'set', rawOperation: operation, record, valueMac: mac })
      } catch (e) { missing++; this.emit('error', e) }
    }
    if (missing) return { applied: 0, missing }
    if (collection) {
      const lthash = getLTHash(this.auth.state, collection)
      for (const mutation of decoded) mix(lthash, mutation.rawOperation, mutation.record.index.blob, mutation.valueMac)
    }
    for (const mutation of decoded) this.emitMutation(mutation.index, mutation.value, mutation.operation)
    return { applied: decoded.length, missing: 0 }
  },

  async appStatePatch({ type = 'critical_block', index, syncAction, apiVersion = 1, operation = SET }) {
    if (!Array.isArray(index) || !index.length || !syncAction || typeof syncAction !== 'object') throw new TypeError('invalid app-state patch')
    const state = this.auth.state
    const keyIdString = state.creds.myAppStateKeyId || Object.keys(state.keys.appStateKeys)[0]
    if (!keyIdString) throw new ZyrixError('no app-state key available', { kind: ErrorKind.NO_SESSION, errorCode: 'APPSTATE_KEY_MISSING' })
    const rawKey = state.keys.appStateKeys[keyIdString]
    const keyData = rawKey?.keyData || rawKey
    if (!keyData) throw new ZyrixError('invalid app-state key', { kind: ErrorKind.DECRYPT, errorCode: 'APPSTATE_KEY_INVALID' })
    const keyId = Buffer.from(keyIdString, 'base64')
    const keys = deriveKeys(keyData)
    const indexBuffer = Buffer.from(JSON.stringify(index))
    const data = proto.SyncActionData.fromObject({ index: indexBuffer, value: syncAction, padding: Buffer.alloc(0), version: apiVersion })
    const encoded = Buffer.from(proto.SyncActionData.encode(data).finish())
    const iv = crypto.randomBytes(16)
    const encrypted = Buffer.concat([iv, aesCbcEncrypt(encoded, keys.valueEncryptionKey, iv)])
    const valueMac = contentMac(operation, encrypted, keyId, keys.valueMacKey)
    const indexMac = hmacSha256(indexBuffer, keys.indexKey)
    // El patch se calcula sobre una copia y se publica en el estado recién después del ACK.
    // Si el query falla, LTHash, indexValueMap y versión quedan idénticos al estado previo.
    // La cola por colección garantiza versiones consecutivas cuando dos patches concurren.
    // Si el servidor rechaza por versión, se resincroniza la colección y se reintenta una
    // sola vez con el LTHash reconstruido. Si el reintento o la resincronización fallan, el
    // error es estable y el estado local sigue intacto.
    const buildPatch = () => {
      state.keys.appStateLTHash ||= {}
      const current = state.keys.appStateLTHash[type] || newLTHash()
      const candidate = cloneLTHash(current)
      mix(candidate, operation, indexMac, valueMac)
      candidate.version += 1
      const snapshotMac = hmacSha256(Buffer.concat([candidate.hash, to64(candidate.version), Buffer.from(type)]), keys.snapshotMacKey)
      const patchMac = hmacSha256(Buffer.concat([snapshotMac, valueMac, to64(candidate.version), Buffer.from(type)]), keys.patchMacKey)
      const patch = { patchMac, snapshotMac, keyId: { id: keyId }, version: { version: candidate.version }, mutations: [{ operation, record: { index: { blob: indexMac }, value: { blob: Buffer.concat([encrypted, valueMac]) }, keyId: { id: keyId } } }] }
      return { patch, current, candidate }
    }
    const sendPatch = ({ patch, current }) => this.query({
      tag: 'iq',
      attrs: { to: S, type: 'set', xmlns: 'w:sync:app:state' },
      content: [{ tag: 'sync', attrs: {}, content: [{ tag: 'collection', attrs: { name: type, version: String(current.version), return_snapshot: 'false' }, content: [{ tag: 'patch', attrs: {}, content: proto.SyncdPatch.encode(patch).finish() }] }] }]
    })
    const applyPatch = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const built = buildPatch()
        try {
          await sendPatch(built)
          state.keys.appStateLTHash[type] = built.candidate
          state.keys.appStateVersions[type] = built.candidate.version
          this.auth.save()
          return built.patch
        } catch (error) {
          if (!isVersionConflict(error)) throw error
          if (attempt === 1) {
            throw new ZyrixError('app-state patch was rejected again after resynchronization', { kind: ErrorKind.PROTOCOL, errorCode: 'APPSTATE_PATCH_CONFLICT', cause: error })
          }
          try {
            await this.syncCollection(type)
          } catch (syncError) {
            throw new ZyrixError('app-state patch conflicted and the collection could not be resynchronized', { kind: ErrorKind.PROTOCOL, errorCode: 'APPSTATE_PATCH_CONFLICT', cause: syncError })
          }
        }
      }
    }
    if (!this.appStateQueues) this.appStateQueues = new Map()
    const previous = this.appStateQueues.get(type) || Promise.resolve()
    const run = previous.then(applyPatch, applyPatch)
    this.appStateQueues.set(type, run.catch(() => {}))
    return run
  },

  async downloadBlobAndApply(ref) { return this.downloadBlob(ref) },

  emitMutation(index, value, operation) {
    const [action, id] = index
    this.emit('app-state.mutation', { action, index, value, operation })
    if (!value) return
    if (action === 'contact' && value.contactAction) {
      this.rememberContact(id, { name: value.contactAction.fullName, shortName: value.contactAction.firstName })
      this.emit('contacts.upsert', { id, name: value.contactAction.fullName || value.contactAction.firstName, operation })
    } else if (action === 'mute' && value.muteAction) this.emit('chats.update', { id, muted: Boolean(value.muteAction.muted), muteEndTimestamp: num(value.muteAction.muteEndTimestamp) })
    else if (action === 'archive' && value.archiveChatAction) this.emit('chats.update', { id, archived: Boolean(value.archiveChatAction.archived) })
    else if (action === 'pin_v1' && value.pinAction) this.emit('chats.update', { id, pinned: Boolean(value.pinAction.pinned) })
  }
}
