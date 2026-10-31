import { proto } from './proto.js'
import { Curve } from './crypto.js'
import { getChild, getChildren, jidDecode, jidEncode, isJidGroup } from './binary.js'
import * as signal from './signal.js'
import * as senderkey from './senderkey.js'
import { S_WHATSAPP_NET as S, be, genId, pad, unpad, encodeAccount } from './util.js'
import { buildMessage, REVOKE_TYPE, EDIT_TYPE } from './content.js'
import { ZyrixError, ErrorKind } from './errors.js'
import { normalizeJid, jidNormalizedUser, isJidLid, isJidPN, sameUser as sameIdentity, makeIdentityMap } from './jid.js'

const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']
const SKIP = new Set(['senderKeyDistributionMessage', 'messageContextInfo', 'deviceSentMessage'])
const MAX_RETRIES = 5

const normalize = (jid) => normalizeJid(jid, S)

const normalizeQuoted = (quoted, chat) => {
  if (!quoted || !quoted.message || typeof quoted.message !== 'object') return quoted
  const key = quoted.key || quoted
  const normalizedKey = {
    ...key,
    remoteJid: !key.remoteJid || key.remoteJid === 'status@broadcast' ? chat : key.remoteJid
  }
  if (normalizedKey.remoteJid === chat && normalizedKey.participant === '0@s.whatsapp.net') {
    delete normalizedKey.participant
  }
  return { ...quoted, key: normalizedKey }
}

const userJid = (jid) => {
  return jidNormalizedUser(jid)
}

const sameUser = (a, b, mapping) => {
  return sameIdentity(a, b, mapping)
}

const participantFromNode = (node, state) => {
  const attrs = node.attrs || {}
  const values = [attrs.jid, attrs.lid, attrs.phone_number, attrs.phoneNumber, attrs.participantAlt].filter(Boolean)
  const lid = values.find(isJidLid)
  const pn = values.find(isJidPN)
  const primary = lid || values[0]
  if (!primary) return null
  const identities = makeIdentityMap(state)
  if (lid && pn) identities.remember(lid, pn)
  const id = jidNormalizedUser(primary)
  return {
    id,
    jid: pn ? jidNormalizedUser(pn) : undefined,
    phoneNumber: pn ? jidNormalizedUser(pn) : undefined,
    lid: lid ? jidNormalizedUser(lid) : undefined,
    username: attrs.notify || attrs.username || attrs.name,
    admin: attrs.type || null,
    isAdmin: attrs.type === 'admin' || attrs.type === 'superadmin',
    isSuperAdmin: attrs.type === 'superadmin'
  }
}

const nodeText = (node) => {
  if (!node) return undefined
  if (typeof node.content === 'string') return node.content
  if (Buffer.isBuffer(node.content)) return node.content.toString('utf8')
  return undefined
}

const parseGroupMetadata = (jid, g, state) => {
  const owner = g.attrs.creator || g.attrs.owner
  const ownerAlt = g.attrs.creator_lid || g.attrs.creator_pn || g.attrs.owner_lid
  const identities = makeIdentityMap(state)
  if (owner && ownerAlt) identities.remember(owner, ownerAlt)
  const description = getChild(g, 'description')
  const body = description && getChild(description, 'body')
  const ephemeral = getChild(g, 'ephemeral')
  const participants = getChildren(g, 'participant').map((p) => participantFromNode(p, state)).filter(Boolean).map((participant) => {
    const isOwner = Boolean(owner && [participant.id, participant.jid, participant.lid].filter(Boolean).some((candidate) => sameIdentity(candidate, owner, identities.map)))
    return { ...participant, isOwner, isAdmin: participant.isAdmin || isOwner, isSuperAdmin: participant.isSuperAdmin || isOwner, admin: isOwner ? 'superadmin' : participant.admin }
  })
  return {
    id: jid,
    subject: g.attrs.subject,
    owner: owner ? jidNormalizedUser(owner) : undefined,
    desc: nodeText(body) || nodeText(description) || g.attrs.desc,
    descId: description?.attrs?.id,
    participants,
    announce: Boolean(getChild(g, 'announcement')) || g.attrs.announce === 'true',
    restrict: Boolean(getChild(g, 'locked')) || g.attrs.restrict === 'true',
    memberAddMode: nodeText(getChild(g, 'member_add_mode')) === 'all_member_add' || g.attrs.member_add_mode === 'all_member_add',
    joinApprovalMode: Boolean(getChild(g, 'membership_approval_mode')) || g.attrs.join_approval_mode === 'true',
    ephemeralDuration: ephemeral?.attrs?.expiration ? Number(ephemeral.attrs.expiration) : undefined,
    addressingMode: g.attrs.addressing_mode === 'lid' ? 'lid' : 'pn'
  }
}

const messageType = (m) => {
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) return 'poll'
  if (m.eventMessage) return 'event'
  if (MEDIA_KEYS.some((k) => m[k])) return 'media'
  if (m.reactionMessage) return 'reaction'
  return 'text'
}

const editAttribute = (message, chat) => {
  const pm = message.protocolMessage
  if (!pm) return undefined
  if (pm.type === EDIT_TYPE) return '1'
  if (pm.type === REVOKE_TYPE) return isJidGroup(chat) && pm.key && !pm.key.fromMe ? '8' : '7'
  return undefined
}

const ackError = (node) => {
  const code = node.attrs && node.attrs.error
  if (!code) return null
  return Object.assign(new ZyrixError(`el servidor rechazó el mensaje (${code})`, { kind: ErrorKind.REJECTED, code: Number(code) || code, details: node }), { node })
}
const encodeMsg = (m) => Buffer.from(proto.Message.encode(m).finish())

const ackAttrs = (node) => {
  const a = { id: node.attrs.id, to: node.attrs.from, class: node.tag }
  if (node.attrs.participant) a.participant = node.attrs.participant
  return a
}

export { participantFromNode, parseGroupMetadata, nodeText }

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
    if (!jid || !image || typeof image.length !== 'number' || image.length > this.maxMediaBytes) throw new TypeError('jid o imagen de perfil inválidos')
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

  async groupCreate(subject, participants = []) {
    if (typeof subject !== 'string' || !subject.trim()) throw new TypeError('subject debe ser texto no vacío')
    if (!Array.isArray(participants)) throw new TypeError('participants debe ser un arreglo')
    const response = await this.query({
      tag: 'iq',
      attrs: { type: 'set', xmlns: 'w:g2', to: S },
      content: [{ tag: 'create', attrs: { subject, key: genId() }, content: participants.map((participant) => ({ tag: 'participant', attrs: { jid: normalizeJid(participant, S) } })) }]
    })
    const group = getChild(response, 'group')
    const id = group && (group.attrs.id || group.attrs.jid)
    if (!id) throw new Error('respuesta de creación de grupo sin id')
    this.groupCache.delete(id)
    return { id, gid: id, subject }
  },

  async groupMetadata(jid) {
    const cached = this.groupCache.get(jid)
    if (cached) return cached
    const res = await this.query({
      tag: 'iq',
      attrs: { type: 'get', xmlns: 'w:g2', to: jid },
      content: [{ tag: 'query', attrs: { request: 'interactive' } }]
    })
    const g = getChild(res, 'group')
    if (!g || !g.attrs) throw new Error(`respuesta de metadata inválida para ${jid}`)
    const meta = parseGroupMetadata(jid, g, this.auth.state)
    this.groupCache.set(jid, meta)
    return meta
  },

  async getGroupParticipant(group, user) {
    if (!isJidGroup(group)) throw new TypeError('group debe ser un JID de grupo')
    const meta = await this.groupMetadata(group)
    const identities = makeIdentityMap(this.auth.state)
    const wanted = normalizeJid(user, S)
    return meta.participants.find((p) => [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean).some((candidate) => sameIdentity(candidate, wanted, identities.map)))
  },

  async isGroupAdmin(group, user) {
    const participant = await this.getGroupParticipant(group, user)
    return Boolean(participant && participant.isAdmin)
  },

  async getGroupAdmins(group) {
    const meta = await this.groupMetadata(group)
    return meta.participants.filter((participant) => participant.isAdmin)
  },

  async groupParticipantsUpdate(group, participants, action) {
    if (!isJidGroup(group)) throw new TypeError('group debe ser un JID de grupo')
    if (!['add', 'remove', 'promote', 'demote'].includes(action)) throw new TypeError('action debe ser add, remove, promote o demote')
    if (!Array.isArray(participants) || !participants.length) throw new TypeError('participants requiere al menos un JID')
    const nodes = participants.map((participant) => ({ tag: 'participant', attrs: { jid: normalizeJid(participant, S) } }))
    const response = await this.query({
      tag: 'iq',
      attrs: { type: 'set', xmlns: 'w:g2', to: group },
      content: [{ tag: action, attrs: {}, content: nodes }]
    })
    this.groupCache.delete(group)
    return getChildren(getChild(response, action), 'participant').map((p) => ({ ...p.attrs }))
  },

  async groupUpdateSubject(group, subject) {
    if (!isJidGroup(group) || typeof subject !== 'string' || !subject.trim()) throw new TypeError('group o subject inválido')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'subject', attrs: {}, content: subject }] })
    this.groupCache.delete(group)
    return response
  },

  async groupUpdateDescription(group, description) {
    if (!isJidGroup(group) || typeof description !== 'string') throw new TypeError('group o description inválido')
    const current = await this.groupMetadata(group)
    const attrs = description ? { id: genId(), ...(current.descId ? { prev: current.descId } : {}) } : { delete: 'true' }
    const content = description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf8') }] : undefined
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'description', attrs, content }] })
    this.groupCache.delete(group)
    return response
  },

  async groupSettingUpdate(group, setting) {
    if (!isJidGroup(group)) throw new TypeError('group debe ser un JID de grupo')
    const settings = new Set(['announcement', 'not_announcement', 'locked', 'unlocked'])
    if (!settings.has(setting)) throw new TypeError('setting inválido')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: setting, attrs: {} }] })
    this.groupCache.delete(group)
    return response
  },

  async groupLeave(group) {
    if (!isJidGroup(group)) throw new TypeError('group debe ser un JID de grupo')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: S }, content: [{ tag: 'leave', attrs: {}, content: [{ tag: 'group', attrs: { id: group } }] }] })
    this.groupCache.delete(group)
    return response
  },

  async groupInviteCode(group) {
    if (!isJidGroup(group)) throw new TypeError('group debe ser un JID de grupo')
    const response = await this.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:g2', to: group }, content: [{ tag: 'invite', attrs: {} }] })
    const invite = getChild(response, 'invite')
    return invite && (invite.attrs.code || (typeof invite.content === 'string' ? invite.content : undefined))
  },

  async groupRevokeInvite(group) {
    if (!isJidGroup(group)) throw new TypeError('group debe ser un JID de grupo')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'invite', attrs: {} }] })
    const invite = getChild(response, 'invite')
    return invite && (invite.attrs.code || (typeof invite.content === 'string' ? invite.content : undefined))
  },

  async groupAcceptInvite(code) {
    if (typeof code !== 'string' || !code.trim()) throw new TypeError('code de invitación inválido')
    const cleanCode = code.trim().replace(/^https:\/\/chat\.whatsapp\.com\//i, '')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: '@g.us' }, content: [{ tag: 'invite', attrs: { code: cleanCode } }] })
    return getChild(response, 'group')?.attrs?.jid || getChild(response, 'group')?.attrs?.id || response?.attrs?.from
  },

  async groupGetInviteInfo(code) {
    if (typeof code !== 'string' || !code.trim()) throw new TypeError('code de invitación inválido')
    const cleanCode = code.trim().replace(/^https:\/\/chat\.whatsapp\.com\//i, '')
    const response = await this.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:g2', to: '@g.us' }, content: [{ tag: 'invite', attrs: { code: cleanCode } }] })
    const group = getChild(response, 'group')
    return group ? parseGroupMetadata(group.attrs.id || group.attrs.jid, group, this.auth.state) : undefined
  },

  async groupAcceptInviteV4(keyOrJid, inviteMessage) {
    if (!inviteMessage || typeof inviteMessage.groupJid !== 'string' || !inviteMessage.inviteCode) throw new TypeError('inviteMessage inválido')
    const admin = typeof keyOrJid === 'string' ? keyOrJid : keyOrJid?.remoteJid
    if (!admin) throw new TypeError('se requiere el JID del administrador de la invitación')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: inviteMessage.groupJid }, content: [{ tag: 'accept', attrs: { code: inviteMessage.inviteCode, expiration: String(inviteMessage.inviteExpiration || 0), admin } }] })
    return getChild(response, 'group')?.attrs?.jid || response?.attrs?.from
  },

  async groupFetchAllParticipating() {
    const response = await this.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:g2', to: '@g.us' }, content: [{ tag: 'participating', attrs: {}, content: [{ tag: 'participants', attrs: {} }, { tag: 'description', attrs: {} }] }] })
    const groupsNode = getChild(response, 'groups')
    const result = {}
    for (const group of getChildren(groupsNode, 'group')) {
      const id = group.attrs.id || group.attrs.jid
      if (id) result[id] = parseGroupMetadata(id, group, this.auth.state)
    }
    this.emit('groups.update', Object.values(result))
    return result
  },

  async groupRequestParticipantsList(group) {
    if (!isJidGroup(group)) throw new TypeError('group debe ser un JID de grupo')
    const response = await this.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:g2', to: group }, content: [{ tag: 'membership_approval_requests', attrs: {} }] })
    return getChildren(getChild(response, 'membership_approval_requests'), 'membership_approval_request').map((node) => ({ ...node.attrs }))
  },

  async groupRequestParticipantsUpdate(group, participants, action) {
    if (!isJidGroup(group) || !['approve', 'reject'].includes(action) || !Array.isArray(participants) || !participants.length) throw new TypeError('solicitud de ingreso inválida')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'membership_requests_action', attrs: {}, content: [{ tag: action, attrs: {}, content: participants.map((jid) => ({ tag: 'participant', attrs: { jid: normalizeJid(jid, S) } })) }] }] })
    return getChildren(getChild(getChild(response, 'membership_requests_action'), action), 'participant').map((p) => ({ status: p.attrs.error || '200', jid: p.attrs.jid }))
  },

  async groupToggleEphemeral(group, seconds) {
    if (!isJidGroup(group) || !Number.isInteger(seconds) || seconds < 0 || seconds > 7776000) throw new RangeError('duración ephemeral inválida')
    const node = seconds ? { tag: 'ephemeral', attrs: { expiration: String(seconds) } } : { tag: 'not_ephemeral', attrs: {} }
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [node] })
    this.groupCache.delete(group)
    return response
  },

  async groupMemberAddMode(group, mode) {
    if (!isJidGroup(group) || !['admin_add', 'all_member_add'].includes(mode)) throw new TypeError('modo de miembros inválido')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'member_add_mode', attrs: {}, content: mode }] })
    this.groupCache.delete(group)
    return response
  },

  async groupJoinApprovalMode(group, mode) {
    if (!isJidGroup(group) || !['on', 'off'].includes(mode)) throw new TypeError('modo de aprobación inválido')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: mode } }] }] })
    this.groupCache.delete(group)
    return response
  },

  async getDevices(jids) {
    const me = jidDecode(this.auth.state.creds.me.id)
    const identities = makeIdentityMap(this.auth.state)
    const result = []
    const missing = []
    for (const jid of new Set(jids.map(userJid))) {
      const cachedDevices = this.deviceCache.get(jid)
      if (cachedDevices) result.push(...cachedDevices)
      else missing.push(jid)
    }
    if (missing.length) {
      const sid = `${this.prefix}-${++this.counter}`
      const res = await this.query({
        tag: 'iq',
        attrs: { to: S, type: 'get', xmlns: 'usync' },
        content: [
          {
            tag: 'usync',
            attrs: { context: 'message', mode: 'query', sid, last: 'true', index: '0' },
            content: [
              { tag: 'query', attrs: {}, content: [{ tag: 'devices', attrs: { version: '2' } }] },
              { tag: 'list', attrs: {}, content: missing.map((jid) => ({ tag: 'user', attrs: { jid } })) }
            ]
          }
        ]
      })
      const list = getChild(getChild(res, 'usync'), 'list')
      for (const user of getChildren(list, 'user')) {
        const u = jidDecode(user.attrs.jid)
        const deviceList = getChild(getChild(user, 'devices'), 'device-list')
        const devices = []
        for (const d of getChildren(deviceList, 'device')) {
          const id = +d.attrs.id
          if (id >= 99) continue
          devices.push(jidEncode(u.user, u.server, id))
        }
        this.deviceCache.set(userJid(user.attrs.jid), devices)
        result.push(...devices)
      }
    }
    const unique = []
    for (const j of new Set(result)) {
      const d = jidDecode(j)
      if (sameIdentity(j, this.auth.state.creds.me.id, identities.map) && (d.device || 0) === (me.device || 0)) continue
      const duplicate = unique.some((other) => {
        const otherDevice = jidDecode(other).device || 0
        return otherDevice === (d.device || 0) && sameIdentity(j, other, identities.map)
      })
      if (!duplicate) unique.push(j)
    }
    return unique
  },

  async fetchSessions(jids, force = false) {
    const state = this.auth.state
    const missing = force ? [...new Set(jids)] : jids.filter((j) => !signal.hasSession(state, j))
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50)
      const res = await this.query({
        tag: 'iq',
        attrs: { xmlns: 'encrypt', type: 'get', to: S },
        content: [{ tag: 'key', attrs: {}, content: chunk.map((jid) => ({ tag: 'user', attrs: force ? { jid, reason: 'identity' } : { jid } })) }]
      })
      for (const user of getChildren(getChild(res, 'list'), 'user')) {
        if (getChild(user, 'error')) continue
        try {
          await signal.injectSession(state, user.attrs.jid, signal.parseBundle(user), this.signalHooks)
        } catch (e) {
          this.emit('error', e)
        }
      }
    }
  },

  async participantNodes(jids, plainFor, extra) {
    const state = this.auth.state
    await this.fetchSessions(jids)
    const nodes = []
    let identity = false
    let pending = jids
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      if (attempt) await this.fetchSessions(pending, true)
      const missing = []
      for (const jid of pending) {
        if (!signal.hasSession(state, jid)) {
          missing.push(jid)
          continue
        }
        const { type, ciphertext } = await signal.encrypt(state, jid, plainFor(jid), this.signalHooks)
        if (type === 'pkmsg') identity = true
        nodes.push({ tag: 'to', attrs: { jid }, content: [{ tag: 'enc', attrs: { v: '2', type, ...extra }, content: ciphertext }] })
      }
      pending = missing
    }
    return { nodes, identity, missing: pending }
  },

  async throttle() {
    const gap = this.minSendIntervalMs
    if (!gap) return
    const wait = this.lastSendAt + gap - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    this.lastSendAt = Date.now()
  },

  waitForAck(id, timeout = 30000) {
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, timeout)
      this.pending.set(id, { resolve, reject, timer, tags: new Set(['ack']) })
    })
    promise.catch(() => {})
    return promise
  },

  async relay(chat, message, opts = {}) {
    const { id = genId(), mediaType, onlyDevice, edit, waitAck = false, ackTimeoutMs = 30000, additionalNodes = [], retryCount } = opts
    await this.throttle()
    const state = this.auth.state
    const identities = makeIdentityMap(state)
    const meJid = state.creds.me.id
    const plain = pad(encodeMsg(message))
    const extra = mediaType ? { mediatype: mediaType } : {}
    if (message.reactionMessage) extra['decrypt-fail'] = 'hide'
    const content = []
    const stanza = { tag: 'message', attrs: { id, to: chat, type: messageType(message) }, content }
    let identity = false

    if (isJidGroup(chat)) {
      const meta = await this.groupMetadata(chat)
      const mode = meta.addressingMode === 'lid' ? 'lid' : 'pn'
      const inMode = mode === 'lid' ? isJidLid : isJidPN
      const meLid = state.creds.me.lid
      if (meLid) identities.remember(meJid, meLid)
      const toMode = (value) => {
        if (!value) return undefined
        let normalized
        try {
          normalized = jidNormalizedUser(value)
        } catch {
          return value
        }
        if (inMode(normalized)) return value
        const alt = identities.map.get(normalized)
        if (!alt || !inMode(alt)) return value
        const d = jidDecode(value)
        const a = jidDecode(alt)
        return d && d.device && a ? jidEncode(a.user, a.server, d.device) : alt
      }
      const pickParticipant = (p) => {
        const candidates = [p.id, p.lid, p.jid, p.phoneNumber].filter(Boolean)
        const direct = candidates.find(inMode)
        if (direct) return direct
        for (const candidate of candidates) {
          const converted = toMode(candidate)
          if (converted && inMode(jidNormalizedUser(converted))) return converted
        }
        return candidates[0]
      }
      const own = signal.addrKey(meJid)
      const rec = senderkey.ensureOwn(state, chat, own)
      if (rec.sentMode !== mode) {
        rec.sentTo = {}
        rec.sentMode = mode
      }
      if (onlyDevice) {
        const target = toMode(onlyDevice)
        const carrier = {
          ...message,
          senderKeyDistributionMessage: { groupId: chat, axolotlSenderKeyDistributionMessage: senderkey.distribution(rec) }
        }
        const wrapped = sameIdentity(target, meJid, identities.map) ? { deviceSentMessage: { destinationJid: chat, message: carrier } } : carrier
        const r = await this.participantNodes([target], () => pad(encodeMsg(wrapped)), extra)
        if (!r.nodes.length) throw new Error('sin sesion con el dispositivo')
        const enc = r.nodes[0].content[0]
        if (retryCount) enc.attrs.count = String(retryCount)
        content.push(enc)
        identity = r.identity
        rec.sentTo[target] = true
        stanza.attrs.participant = target
      } else {
        const participantJids = meta.participants.map(pickParticipant).filter(Boolean)
        const ownSelf = mode === 'lid' && meLid ? meLid : meJid
        const devices = await this.getDevices([...participantJids, ownSelf])
        const targets = devices.filter((j) => !rec.sentTo[j])
        if (targets.length) {
          const skdm = pad(
            encodeMsg({
              senderKeyDistributionMessage: { groupId: chat, axolotlSenderKeyDistributionMessage: senderkey.distribution(rec) }
            })
          )
          const r = await this.participantNodes(targets, () => skdm, extra)
          if (r.nodes.length) content.push({ tag: 'participants', attrs: {}, content: r.nodes })
          if (r.missing.length) this.emit('send.warning', { id, chat, missingDevices: r.missing })
          identity = r.identity
          for (const n of r.nodes) rec.sentTo[n.attrs.jid] = true
        }
        content.push({ tag: 'enc', attrs: { v: '2', type: 'skmsg', ...extra }, content: senderkey.encrypt(state, chat, own, plain) })
      }
      if (!onlyDevice) stanza.attrs.addressing_mode = mode
    } else {
      const meLid = state.creds.me.lid
      if (meLid && isJidLid(chat)) identities.remember(meJid, meLid)
      const ownQuery = meLid && isJidLid(chat) ? jidNormalizedUser(meLid) : meJid
      const devices = onlyDevice ? [onlyDevice] : await this.getDevices([chat, ownQuery])
      const wrapped = pad(encodeMsg({ deviceSentMessage: { destinationJid: chat, message } }))
      const r = await this.participantNodes(devices, (j) => (sameUser(j, meJid, identities.map) ? wrapped : plain), extra)
      identity = r.identity
      if (!onlyDevice && !sameUser(chat, meJid, identities.map) && !r.nodes.some((n) => !sameUser(n.attrs.jid, meJid, identities.map))) {
        throw new Error(`no se pudo establecer sesión con ${chat}: el destinatario no tiene dispositivos o falló la descarga de claves`)
      }
      if (r.missing.length) this.emit('send.warning', { id, chat, missingDevices: r.missing })
      if (onlyDevice) {
        if (!r.nodes.length) throw new Error('sin sesion con el dispositivo')
        content.push(...r.nodes[0].content)
        if (retryCount) content[content.length - 1].attrs.count = String(retryCount)
        stanza.attrs.to = onlyDevice
        if (sameUser(onlyDevice, meJid, identities.map)) stanza.attrs.recipient = chat
      } else content.push({ tag: 'participants', attrs: {}, content: r.nodes })
    }

    if (identity) content.push({ tag: 'device-identity', attrs: {}, content: encodeAccount(state.creds.account, true) })
    if (Array.isArray(additionalNodes) && additionalNodes.length) content.push(...additionalNodes)
    if (edit) stanza.attrs.edit = edit
    this.auth.save()
    const ack = waitAck ? this.waitForAck(id, ackTimeoutMs) : undefined
    try {
      this.sendNode(stanza)
    } catch (e) {
      if (ack) {
        const pending = this.pending.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(id)
        }
      }
      throw e
    }
    this.sentCache.set(id, { chat, message, mediaType, edit })
    return { key: { remoteJid: chat, fromMe: true, id }, message, ack }
  },

  async deliver(chat, message, opts = {}) {
    const waitAck = opts.waitAck !== false
    const sent = await this.run(() => this.relay(chat, message, { ...opts, waitAck }))
    const node = waitAck ? await sent.ack : undefined
    const error = node && ackError(node)
    if (error) throw error
    return {
      key: sent.key,
      message: sent.message,
      status: node ? 'sent' : 'unconfirmed',
      messageTimestamp: node && node.attrs.t ? +node.attrs.t : Math.floor(Date.now() / 1000)
    }
  },

  async sendMessage(to, content, options = {}) {
    const chat = normalize(to)
    options = { ...options, quoted: normalizeQuoted(options.quoted, chat) }
    if (content && typeof content === 'object' && !Array.isArray(content) && !content.type) {
      const mediaType = ['image', 'video', 'audio', 'document', 'sticker'].find((type) => content[type] !== undefined)
      if (mediaType) return this.sendMedia(chat, { ...content, ...options, [mediaType]: content[mediaType] })
      if (content.buttons) return this.sendButtons(chat, { ...content, ...options })
      if (content.list) return this.sendList(chat, { ...content.list, ...options })
      if (content.poll) return this.sendPoll(chat, { ...content.poll, ...options })
      if (content.location) return this.sendLocation(chat, { ...content.location, ...options })
      if (content.contact) return this.sendContact(chat, { ...content.contact, ...options })
      if (content.contacts) return this.sendContacts(chat, { contacts: content.contacts, ...options })
    }
    const message = buildMessage(content, this.withGroupExpiration(chat, content, options))
    return this.deliver(chat, message, {
      edit: editAttribute(message, chat),
      additionalNodes: options.additionalNodes,
      id: options.messageId,
      ackTimeoutMs: options.ackTimeoutMs,
      waitAck: options.waitAck ?? messageType(message) !== 'reaction'
    })
  },

  withGroupExpiration(chat, content, options) {
    if (options.expiration !== undefined || !isJidGroup(chat)) return options
    const special = content && typeof content === 'object' && (
      content.delete || content.edit || content.forward ||
      content.reactionMessage || content.protocolMessage || content.pollUpdateMessage ||
      content.type === 'reaction'
    )
    if (special) return options
    const cached = this.groupCache.get(chat)
    return cached && cached.ephemeralDuration ? { ...options, expiration: cached.ephemeralDuration } : options
  },

  async onRetryReceipt(node) {
    const { id, from, participant } = node.attrs
    let cached = this.sentCache.get(id)
    if (!cached && typeof this.getMessage === 'function') {
      const recovered = await this.getMessage({ remoteJid: from, fromMe: true, id })
      if (recovered) cached = { chat: from, message: recovered.message || recovered }
    }
    if (!cached) return
    const retry = getChild(node, 'retry')
    if (retry && +retry.attrs.count > MAX_RETRIES) return
    const device = participant || from
    const state = this.auth.state
    const keys = getChild(node, 'keys')
    signal.deleteSession(state, device)
    if (keys) {
      const bundle = signal.parseBundle({ content: [getChild(node, 'registration'), ...keys.content] })
      await signal.injectSession(state, device, bundle, this.signalHooks)
    } else await this.fetchSessions([device])
    await this.relay(cached.chat, cached.message, { id, mediaType: cached.mediaType, edit: cached.edit, onlyDevice: device, retryCount: retry ? Number(retry.attrs.count) || 1 : 1 })
  },

  async sendRetry(node) {
    const { id, from, participant, t } = node.attrs
    const count = (this.retries.get(id) || 0) + 1
    if (count > MAX_RETRIES) return
    this.retries.set(id, count)
    const { creds, keys } = this.auth.state
    const receipt = {
      tag: 'receipt',
      attrs: { id, type: 'retry', to: from },
      content: [
        { tag: 'retry', attrs: { count: String(count), id, t, v: '1' } },
        { tag: 'registration', attrs: {}, content: be(creds.registrationId, 4) }
      ]
    }
    if (participant) receipt.attrs.participant = participant
    if (node.attrs.recipient) receipt.attrs.recipient = node.attrs.recipient
    if (count > 1) {
      const preKeyId = creds.nextPreKeyId++
      const kp = Curve.generateKeyPair()
      keys.preKeys[preKeyId] = kp
      receipt.content.push({
        tag: 'keys',
        attrs: {},
        content: [
          { tag: 'type', attrs: {}, content: Buffer.from([5]) },
          { tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
          {
            tag: 'key',
            attrs: {},
            content: [
              { tag: 'id', attrs: {}, content: be(preKeyId, 3) },
              { tag: 'value', attrs: {}, content: kp.public }
            ]
          },
          {
            tag: 'skey',
            attrs: {},
            content: [
              { tag: 'id', attrs: {}, content: be(creds.signedPreKey.keyId, 3) },
              { tag: 'value', attrs: {}, content: creds.signedPreKey.keyPair.public },
              { tag: 'signature', attrs: {}, content: creds.signedPreKey.signature }
            ]
          },
          { tag: 'device-identity', attrs: {}, content: encodeAccount(creds.account, true) }
        ]
      })
      this.auth.save()
    }
    this.sendNode(receipt)
  },

  async onMessage(node) {
    const { id, from, participant } = node.attrs
    const state = this.auth.state
    const sender = participant || from
    const seenKey = `${from}|${participant || ''}|${id}`
    if (this.seen.get(seenKey)) {
      this.sendNode({ tag: 'ack', attrs: { ...ackAttrs(node), class: 'message' } })
      return
    }
    const encs = getChildren(node, 'enc').sort((a, b) => (a.attrs.type === 'skmsg') - (b.attrs.type === 'skmsg'))
    let emitted = 0
    let failed = false
    for (const enc of encs) {
      const type = enc.attrs.type
      if (type !== 'pkmsg' && type !== 'msg' && type !== 'skmsg') continue
      let message
      try {
        const plain =
          type === 'skmsg'
            ? senderkey.decrypt(state, from, signal.addrKey(sender), enc.content)
            : await signal.decrypt(state, sender, type, enc.content, this.signalHooks)
        message = proto.Message.decode(unpad(Buffer.from(plain)))
      } catch (e) {
        failed = true
        this.emit('error', new Error(`${id} ${type}: ${e.message}`))
        continue
      }
      try {
        if (this.handleDecrypted(node, message)) emitted++
      } catch (e) {
        const error = new Error(`${id} ${type} processing: ${e.message}`)
        this.logger.error({ err: error, messageId: id }, 'error procesando mensaje descifrado')
        this.emit('error', error)
      } finally {
        this.seen.set(seenKey, true)
      }
    }
    this.auth.save()
    this.sendNode({ tag: 'ack', attrs: { ...ackAttrs(node), class: 'message' } })
    if (failed && !emitted) await this.sendRetry(node)
    else {
      const receipt = { id, to: from }
      if (participant) receipt.participant = participant
      this.sendNode({ tag: 'receipt', attrs: receipt })
    }
  },

  handleDecrypted(node, message) {
    const { id, from, participant, notify, t } = node.attrs
    const state = this.auth.state
    const sender = participant || from
    const identities = makeIdentityMap(state)
    this.learnAlternates(node.attrs, identities)
    const alternate = (value) => {
      if (!value) return undefined
      try {
        return identities.map.get(jidNormalizedUser(value))
      } catch {
        return undefined
      }
    }
    const skdm = message.senderKeyDistributionMessage
    if (skdm && skdm.axolotlSenderKeyDistributionMessage) {
      senderkey.processDistribution(state, skdm.groupId, signal.addrKey(sender), skdm.axolotlSenderKeyDistributionMessage)
    }
    const pm = message.protocolMessage
    let internal = false
    if (pm && pm.appStateSyncKeyShare) {
      for (const k of pm.appStateSyncKeyShare.keys || []) {
        const keyId = Buffer.from(k.keyId.keyId).toString('base64')
        state.keys.appStateKeys[keyId] = Buffer.from(k.keyData.keyData)
        state.creds.myAppStateKeyId ||= keyId
      }
      this.syncAppState().catch((e) => this.emit('error', e))
      internal = true
    }
    if (pm && pm.historySyncNotification) internal = true
    let key = { remoteJid: from, remoteJidAlt: alternate(from), fromMe: false, id, participant, participantAlt: alternate(participant) }
    let body = message
    if (message.deviceSentMessage) {
      key = { remoteJid: message.deviceSentMessage.destinationJid, remoteJidAlt: alternate(message.deviceSentMessage.destinationJid), fromMe: true, id }
      body = message.deviceSentMessage.message
    }
    const hasContent = Object.keys(body).some((k) => body[k] != null && !SKIP.has(k) && !(internal && k === 'protocolMessage'))
    if (!hasContent) return false
    const pushName = node.attrs.notify || notify
    if (pushName && !key.fromMe) this.rememberContact(sender, { notify: pushName })
    this.emit('messages.upsert', { key, message: body, pushName, messageTimestamp: +t, offline: node.attrs.offline !== undefined })
    return true
  },

  learnAlternates(attrs, identities) {
    const pairs = []
    const { from, participant } = attrs
    if (isJidGroup(from)) {
      if (participant && attrs.participant_pn) pairs.push([participant, attrs.participant_pn])
      if (participant && attrs.participant_lid) pairs.push([participant, attrs.participant_lid])
    } else {
      if (from && attrs.sender_pn) pairs.push([from, attrs.sender_pn])
      if (from && attrs.sender_lid) pairs.push([from, attrs.sender_lid])
    }
    for (const [a, b] of pairs) {
      try {
        if ((isJidLid(a) && isJidPN(b)) || (isJidPN(a) && isJidLid(b))) identities.remember(a, b)
      } catch {}
    }
  }
}
