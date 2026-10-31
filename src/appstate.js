import crypto from 'crypto'
import { proto } from './proto.js'
import { hkdf, hmacSha256, aesCbcEncrypt, aesCbcDecrypt } from './crypto.js'
import { getChild, getChildren } from './binary.js'
import { decryptMedia } from './mediacrypto.js'
import { S_WHATSAPP_NET as S, num } from './util.js'

const COLLECTIONS = ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular']
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

export default {
  async syncAppState(names = COLLECTIONS) {
    if (!Object.keys(this.auth.state.keys.appStateKeys).length || this.syncing) return
    this.syncing = true
    try { for (const name of names) await this.syncCollection(name) } finally { this.syncing = false }
  },

  async downloadBlob(ref) {
    const res = await fetch(`https://mmg.whatsapp.net${ref.directPath}`, { headers: { Origin: 'https://web.whatsapp.com' } })
    if (!res.ok) throw new Error('descarga de blob fallida ' + res.status)
    return decryptMedia(Buffer.from(await res.arrayBuffer()), ref.mediaKey, 'md-app-state')
  },

  async syncCollection(name) {
    const versions = this.auth.state.keys.appStateVersions
    for (let guard = 0; guard < 20; guard++) {
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
        if (blob.length < 64 || !record.index?.blob) throw new Error('registro app-state truncado')
        const content = blob.subarray(0, -32)
        const mac = blob.subarray(-32)
        const expanded = deriveKeys(keyData)
        const expectedMac = contentMac(operation, content, keyId, expanded.valueMacKey)
        if (!crypto.timingSafeEqual(expectedMac, mac)) throw new Error('MAC de valor app-state inválido')
        const plain = aesCbcDecrypt(content.subarray(16), expanded.valueEncryptionKey, content.subarray(0, 16))
        const data = proto.SyncActionData.decode(plain)
        const expectedIndexMac = hmacSha256(Buffer.from(data.index), expanded.indexKey)
        const indexMac = Buffer.from(record.index.blob)
        if (!crypto.timingSafeEqual(expectedIndexMac, indexMac)) throw new Error('MAC del índice app-state inválido')
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
    if (!Array.isArray(index) || !index.length || !syncAction || typeof syncAction !== 'object') throw new TypeError('patch app-state inválido')
    const state = this.auth.state
    const keyIdString = state.creds.myAppStateKeyId || Object.keys(state.keys.appStateKeys)[0]
    if (!keyIdString) throw new Error('no hay clave app-state disponible')
    const rawKey = state.keys.appStateKeys[keyIdString]
    const keyData = rawKey?.keyData || rawKey
    if (!keyData) throw new Error('clave app-state inválida')
    const keyId = Buffer.from(keyIdString, 'base64')
    const keys = deriveKeys(keyData)
    const indexBuffer = Buffer.from(JSON.stringify(index))
    const data = proto.SyncActionData.fromObject({ index: indexBuffer, value: syncAction, padding: Buffer.alloc(0), version: apiVersion })
    const encoded = Buffer.from(proto.SyncActionData.encode(data).finish())
    const iv = crypto.randomBytes(16)
    const encrypted = Buffer.concat([iv, aesCbcEncrypt(encoded, keys.valueEncryptionKey, iv)])
    const valueMac = contentMac(operation, encrypted, keyId, keys.valueMacKey)
    const indexMac = hmacSha256(indexBuffer, keys.indexKey)
    const lthash = getLTHash(state, type)
    mix(lthash, operation, indexMac, valueMac)
    lthash.version += 1
    const snapshotMac = hmacSha256(Buffer.concat([lthash.hash, to64(lthash.version), Buffer.from(type)]), keys.snapshotMacKey)
    const patchMac = hmacSha256(Buffer.concat([snapshotMac, valueMac, to64(lthash.version), Buffer.from(type)]), keys.patchMacKey)
    const patch = { patchMac, snapshotMac, keyId: { id: keyId }, version: { version: lthash.version }, mutations: [{ operation, record: { index: { blob: indexMac }, value: { blob: Buffer.concat([encrypted, valueMac]) }, keyId: { id: keyId } } }] }
    await this.query({ tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'w:sync:app:state' }, content: [{ tag: 'sync', attrs: {}, content: [{ tag: 'collection', attrs: { name: type, version: String(lthash.version - 1), return_snapshot: 'false' }, content: [{ tag: 'patch', attrs: {}, content: proto.SyncdPatch.encode(patch).finish() }] }] }] })
    state.keys.appStateVersions[type] = lthash.version
    this.auth.save()
    return patch
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
