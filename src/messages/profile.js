import { proto } from '../proto.js'
import { Curve } from '../crypto.js'
import { getChild, getChildren, jidDecode, jidEncode, isJidGroup } from '../binary.js'
import * as signal from '../signal.js'
import * as senderkey from '../senderkey.js'
import { S_WHATSAPP_NET as S, be, genId, pad, unpad, encodeAccount } from '../util.js'
import { buildMessage, REVOKE_TYPE, EDIT_TYPE } from '../content.js'
import { ZyrixError, ErrorKind } from '../errors.js'
import { normalizeJid, jidNormalizedUser, isJidLid, isJidPN, sameUser as sameIdentity, makeIdentityMap } from '../jid.js'

import { normalize, normalizeQuoted, userJid, sameUser, participantFromNode, parseGroupMetadata, nodeText, messageType, editAttribute, ackError, encodeMsg, ackAttrs, MAX_RETRIES, SKIP } from './shared.js'

export default {
  resolveJid(value) {
    const normalized = jidNormalizedUser(normalizeJid(value, S))
    const identities = makeIdentityMap(this.auth.state)
    return identities.map.get(normalized) || normalized
  },

  getJidAliases(value) {
    const normalized = jidNormalizedUser(normalizeJid(value, S))
    const identities = makeIdentityMap(this.auth.state)
    const alternate = identities.map.get(normalized)
    return alternate ? [normalized, alternate] : [normalized]
  },

  rememberContact(jid, patch) {
    if (!jid || !patch) return
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]))
    if (!Object.keys(clean).length) return
    let ids
    try {
      ids = this.getJidAliases(jid)
    } catch {
      return
    }
    const cache = (this.contactCache ||= new Map())
    for (const id of ids) {
      const previous = cache.get(id)
      cache.delete(id)
      cache.set(id, { ...(previous || {}), ...clean })
    }
    while (cache.size > 5000) cache.delete(cache.keys().next().value)
  },

  async contactQuery(jid) {
    if (!jid || !this.contactCache) return undefined
    let ids
    try {
      ids = this.getJidAliases(jid)
    } catch {
      return undefined
    }
    const found = ids.map((id) => this.contactCache.get(id)).filter(Boolean)
    if (!found.length) return undefined
    const data = Object.assign({}, ...[...found].reverse())
    const name = data.name || data.notify
    const shortName = data.shortName || data.notify
    if (!name && !shortName) return undefined
    return { id: ids[0], name, shortName, notify: data.notify }
  },

  async updateProfileStatus(status) {
    if (typeof status !== 'string' || status.length > 139) throw new RangeError('status debe tener entre 0 y 139 caracteres')
    return this.query({ tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'status' }, content: [{ tag: 'status', attrs: {}, content: Buffer.from(status, 'utf8') }] })
  },

  async updateProfileName(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 25) throw new RangeError('name debe tener entre 1 y 25 caracteres')
    const hasAppStateKey = Boolean(this.auth.state.creds.myAppStateKeyId || Object.keys(this.auth.state.keys.appStateKeys).length)
    const response = hasAppStateKey
      ? await this.appStatePatch({ type: 'critical_block', index: ['setting_pushName'], apiVersion: 1, syncAction: { pushNameSetting: { name } } })
      : await this.query({ tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'profile' }, content: [{ tag: 'profile', attrs: {}, content: [{ tag: 'name', attrs: {}, content: Buffer.from(name, 'utf8') }] }] })
    if (this.auth.state.creds.me) this.auth.state.creds.me.name = name
    this.auth.save()
    return response
  },

  async updateProfilePicture(jid, image) {
    if (!jid || !image || typeof image.length !== 'number' || image.length > this.maxMediaBytes) throw new TypeError('jid o imagen de perfil inválida')
    const normalized = jidNormalizedUser(jid)
    const me = this.auth.state.creds.me?.id
    const identities = makeIdentityMap(this.auth.state)
    const target = me && sameIdentity(normalized, me, identities.map) ? undefined : normalized
    return this.query({ tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'w:profile:picture', ...(target ? { target } : {}) }, content: [{ tag: 'picture', attrs: { type: 'image' }, content: Buffer.from(image) }] })
  },

  async removeProfilePicture(jid) {
    if (!jid) throw new TypeError('jid requerido')
    const normalized = jidNormalizedUser(jid)
    const me = this.auth.state.creds.me?.id
    const identities = makeIdentityMap(this.auth.state)
    const target = me && sameIdentity(normalized, me, identities.map) ? undefined : normalized
    return this.query({ tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'w:profile:picture', ...(target ? { target } : {}) } })
  },

  async profilePictureUrl(jid, type = 'preview') {
    if (!['preview', 'image'].includes(type)) throw new TypeError('type debe ser preview o image')
    const normalized = jidNormalizedUser(jid)
    const response = await this.query({ tag: 'iq', attrs: { target: normalized, to: S, type: 'get', xmlns: 'w:profile:picture' }, content: [{ tag: 'picture', attrs: { type } }] })
    return getChild(response, 'picture')?.attrs?.url
  },

  async fetchStatus(jid) {
    const normalized = jidNormalizedUser(jid)
    const response = await this.query({ tag: 'iq', attrs: { to: normalized, type: 'get', xmlns: 'status' }, content: [{ tag: 'status', attrs: {} }] })
    const node = getChild(response, 'status')
    return node ? { status: nodeText(node), setAt: node.attrs?.t ? Number(node.attrs.t) : undefined } : undefined
  },

  async getBusinessProfile(jid) {
    const normalized = jidNormalizedUser(jid)
    const response = await this.query({ tag: 'iq', attrs: { to: S, xmlns: 'w:biz', type: 'get' }, content: [{ tag: 'business_profile', attrs: { v: '244' }, content: [{ tag: 'profile', attrs: { jid: normalized } }] }] })
    const profile = getChild(getChild(response, 'business_profile'), 'profile')
    if (!profile) return undefined
    const child = (name) => nodeText(getChild(profile, name))
    return { jid: profile.attrs?.jid, address: child('address'), description: child('description') || '', website: child('website'), email: child('email'), category: nodeText(getChild(getChild(profile, 'categories'), 'category')) }
  },

  async fetchBlocklist() {
    const response = await this.query({ tag: 'iq', attrs: { xmlns: 'blocklist', to: S, type: 'get' } })
    return getChildren(getChild(response, 'list'), 'item').map((node) => node.attrs.jid).filter(Boolean)
  },

  async updateBlockStatus(jid, action) {
    if (!['block', 'unblock'].includes(action)) throw new TypeError('action debe ser block o unblock')
    const normalized = jidNormalizedUser(jid)
    const identities = makeIdentityMap(this.auth.state)
    const pn = isJidPN(normalized) ? normalized : identities.map.get(normalized)
    const lid = isJidLid(normalized) ? normalized : identities.map.get(normalized) && isJidLid(identities.map.get(normalized)) ? identities.map.get(normalized) : normalized
    if (!isJidLid(lid)) throw new Error('se necesita un mapeo LID para bloquear este usuario')
    const attrs = { action, jid: lid }
    if (action === 'block') {
      if (!pn || !isJidPN(pn)) throw new Error('se necesita el PN asociado al LID para bloquear')
      attrs.pn_jid = pn
    }
    return this.query({ tag: 'iq', attrs: { xmlns: 'blocklist', to: S, type: 'set' }, content: [{ tag: 'item', attrs }] })
  },

  async fetchPrivacySettings(force = false) {
    if (this.privacySettings && !force) return this.privacySettings
    const response = await this.query({ tag: 'iq', attrs: { xmlns: 'privacy', to: S, type: 'get' }, content: [{ tag: 'privacy', attrs: {} }] })
    const categories = getChildren(getChild(response, 'privacy'), 'category')
    this.privacySettings = Object.fromEntries(categories.filter((node) => node.attrs?.name).map((node) => [node.attrs.name, node.attrs.value]))
    return this.privacySettings
  },

  async updatePrivacyCategory(name, value) {
    const allowed = new Set(['all', 'contacts', 'contact_blacklist', 'none', 'match_last_seen'])
    if (!allowed.has(value)) throw new TypeError('valor de privacidad inválido')
    const names = new Set(['last', 'online', 'profile', 'status', 'readreceipts', 'groupadd', 'messages', 'calladd'])
    if (!names.has(name)) throw new TypeError('categoría de privacidad inválida')
    const response = await this.query({ tag: 'iq', attrs: { xmlns: 'privacy', to: S, type: 'set' }, content: [{ tag: 'privacy', attrs: {}, content: [{ tag: 'category', attrs: { name, value } }] }] })
    this.privacySettings = { ...(this.privacySettings || {}), [name]: value }
    return response
  },

  updateLastSeenPrivacy(value) { return this.updatePrivacyCategory('last', value) },
  updateOnlinePrivacy(value) { return this.updatePrivacyCategory('online', value) },
  updateProfilePicturePrivacy(value) { return this.updatePrivacyCategory('profile', value) },
  updateStatusPrivacy(value) { return this.updatePrivacyCategory('status', value) },
  async updateReadReceiptsPrivacy(value) {
    const result = await this.updatePrivacyCategory('readreceipts', value)
    this.readReceiptCache = undefined
    return result
  },
  updateGroupsAddPrivacy(value) { return this.updatePrivacyCategory('groupadd', value) },
  updateMessagesPrivacy(value) { return this.updatePrivacyCategory('messages', value) },
  updateCallPrivacy(value) { return this.updatePrivacyCategory('calladd', value) },

  async updateDefaultDisappearingMode(seconds) {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 7776000) throw new RangeError('duración predeterminada inválida')
    return this.query({ tag: 'iq', attrs: { xmlns: 'disappearing_mode', to: S, type: 'set' }, content: [{ tag: 'disappearing_mode', attrs: { duration: String(seconds) } }] })
  },
}
