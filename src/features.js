import { getChild, getChildren } from './binary.js'
import { S_WHATSAPP_NET as S } from './util.js'
import { jidNormalizedUser, normalizeJid, isJidGroup, isJidLid, isJidPN, makeIdentityMap } from './jid.js'
import * as signal from './signal.js'
import * as senderkey from './senderkey.js'
import { participantFromNode, nodeText } from './messages.js'
import { parseMessage } from './incoming.js'

const children = (node) => (node && Array.isArray(node.content) ? node.content : [])

const PRESENCE_STATES = new Set(['composing', 'recording', 'paused'])

const chatPatch = (name, jid, option) => {
  const timestamp = Date.now()
  switch (name) {
    case 'pin':
      return { type: 'regular_low', apiVersion: 5, index: ['pin_v1', jid], syncAction: { pinAction: { pinned: Boolean(option) }, timestamp } }
    case 'mute': {
      const muted = option !== null && option !== false && option !== undefined
      const end = muted && Number.isFinite(Number(option)) && option !== true ? Math.floor(Number(option)) : undefined
      return { type: 'regular_high', apiVersion: 2, index: ['mute', jid], syncAction: { muteAction: { muted, muteEndTimestamp: end }, timestamp } }
    }
    case 'archive':
      return { type: 'regular_low', apiVersion: 3, index: ['archive', jid], syncAction: { archiveChatAction: { archived: Boolean(option), messageRange: { lastMessageTimestamp: Math.floor(timestamp / 1000) } }, timestamp } }
    case 'markRead':
      return { type: 'regular_low', apiVersion: 3, index: ['markChatAsRead', jid], syncAction: { markChatAsReadAction: { read: Boolean(option), messageRange: { lastMessageTimestamp: Math.floor(timestamp / 1000) } }, timestamp } }
    default:
      throw new TypeError('modificación de chat no soportada: usa pin, mute, archive o markRead')
  }
}

export default {
  parseMessage(event) {
    const me = this.auth.state.creds.me
    return parseMessage(event, { self: me && me.id })
  },

  async sendReceipt(jid, participant, messageIds, type) {
    if (!Array.isArray(messageIds) || !messageIds.length) throw new TypeError('messageIds requiere al menos un id')
    const attrs = { id: messageIds[0] }
    if (type === 'read' || type === 'read-self') attrs.t = String(Math.floor(Date.now() / 1000))
    if (type === 'sender' && isJidPN(jid)) {
      attrs.recipient = jid
      attrs.to = participant
    } else {
      attrs.to = jid
      if (participant) attrs.participant = participant
    }
    if (type) attrs.type = type
    const node = { tag: 'receipt', attrs }
    if (messageIds.length > 1) {
      node.content = [{ tag: 'list', attrs: {}, content: messageIds.slice(1).map((id) => ({ tag: 'item', attrs: { id } })) }]
    }
    this.sendNode(node)
  },

  async readReceiptType() {
    const cached = this.readReceiptCache
    if (cached && Date.now() - cached.at < 600000) return cached.type
    const privacy = await this.fetchPrivacySettings().catch(() => null)
    if (!privacy) return cached?.type ?? 'read'
    const type = !privacy.readreceipts || privacy.readreceipts === 'all' ? 'read' : 'read-self'
    this.readReceiptCache = { type, at: Date.now() }
    return type
  },

  async readMessages(keys) {
    if (!Array.isArray(keys) || !keys.length) throw new TypeError('keys requiere al menos una clave de mensaje')
    const type = await this.readReceiptType()
    const groups = new Map()
    for (const key of keys) {
      if (!key || key.fromMe || !key.id || !key.remoteJid) continue
      const group = `${key.remoteJid}|${key.participant || ''}`
      if (!groups.has(group)) groups.set(group, { jid: key.remoteJid, participant: key.participant, ids: [] })
      groups.get(group).ids.push(key.id)
    }
    for (const { jid, participant, ids } of groups.values()) await this.sendReceipt(jid, participant, ids, type)
  },

  sendPresenceUpdate(type, to) {
    if (type === 'available' || type === 'unavailable') {
      const name = (this.auth.state.creds.me && this.auth.state.creds.me.name) || 'zyrix'
      return this.sendNode({ tag: 'presence', attrs: { name, type } })
    }
    if (!PRESENCE_STATES.has(type)) throw new TypeError('type debe ser available, unavailable, composing, recording o paused')
    if (!to) throw new TypeError('to es obligatorio para composing, recording y paused')
    const jid = normalizeJid(to, S)
    const tag = type === 'paused' ? 'paused' : 'composing'
    return this.sendNode({ tag: 'chatstate', attrs: { to: jid }, content: [{ tag, attrs: type === 'recording' ? { media: 'audio' } : {} }] })
  },

  presenceSubscribe(jid) {
    return this.sendNode({ tag: 'presence', attrs: { to: normalizeJid(jid, S), type: 'subscribe' } })
  },

  async rejectCall(callId, callFrom) {
    const me = this.auth.state.creds.me
    if (!me) throw new Error('la sesión aún no está registrada')
    return this.query({
      tag: 'call',
      attrs: { from: me.id, to: callFrom },
      content: [{ tag: 'reject', attrs: { 'call-id': callId, 'call-creator': callFrom, count: '0' } }]
    })
  },

  async onWhatsApp(...phones) {
    const numbers = phones.flat().map((p) => String(p).replace(/\D/g, '')).filter(Boolean)
    if (!numbers.length) throw new TypeError('onWhatsApp requiere al menos un número')
    const sid = `${this.prefix}-${++this.counter}`
    const res = await this.query({
      tag: 'iq',
      attrs: { to: S, type: 'get', xmlns: 'usync' },
      content: [
        {
          tag: 'usync',
          attrs: { context: 'interactive', mode: 'query', sid, last: 'true', index: '0' },
          content: [
            { tag: 'query', attrs: {}, content: [{ tag: 'contact', attrs: {} }, { tag: 'lid', attrs: {} }] },
            { tag: 'list', attrs: {}, content: numbers.map((n) => ({ tag: 'user', attrs: {}, content: [{ tag: 'contact', attrs: {}, content: `+${n}` }] })) }
          ]
        }
      ]
    })
    const identities = makeIdentityMap(this.auth.state)
    const results = []
    for (const user of getChildren(getChild(getChild(res, 'usync'), 'list'), 'user')) {
      const contact = getChild(user, 'contact')
      const lidNode = getChild(user, 'lid')
      const lid = lidNode && lidNode.attrs && (lidNode.attrs.val || lidNode.attrs.jid)
      const jid = user.attrs.jid
      if (!jid) continue
      if (lid && isJidLid(lid) && isJidPN(jid)) identities.remember(lid, jid)
      results.push({ jid, exists: Boolean(contact && contact.attrs && contact.attrs.type === 'in'), lid: lid || undefined })
    }
    if (results.length) this.auth.save()
    return results
  },

  async chatModify(modification, jid) {
    const entries = Object.entries(modification || {})
    if (entries.length !== 1) throw new TypeError('chatModify espera exactamente una modificación')
    const [name, option] = entries[0]
    return this.appStatePatch(chatPatch(name, normalizeJid(jid, S), option))
  },

  onCall(node) {
    const info = children(node)[0]
    if (!info) return
    const reason = info.attrs && info.attrs.reason
    const status =
      info.tag === 'offer' ? 'offer' : info.tag === 'terminate' ? (reason === 'timeout' ? 'timeout' : 'terminate') : info.tag === 'reject' ? 'reject' : info.tag === 'accept' ? 'accept' : 'ringing'
    const call = {
      chatId: node.attrs.from,
      from: info.attrs['call-creator'] || info.attrs.from || node.attrs.from,
      id: info.attrs['call-id'],
      date: node.attrs.t ? new Date(+node.attrs.t * 1000) : new Date(),
      offline: node.attrs.offline !== undefined,
      status
    }
    if (status === 'offer') {
      call.isVideo = Boolean(getChild(info, 'video'))
      call.isGroup = info.attrs.type === 'group' || Boolean(info.attrs['group-jid'])
      call.groupJid = info.attrs['group-jid']
    }
    this.emit('call', call)
    if (status === 'offer' && this.autoRejectCalls && call.id) {
      this.rejectCall(call.id, call.from).catch((e) => this.emit('error', e))
    }
  },

  onPresenceNode(node) {
    const { from, type, last } = node.attrs
    if (!from || type === 'subscribe') return
    const lastSeen = last && last !== 'deny' && last !== 'none' && Number.isFinite(Number(last)) ? Number(last) : undefined
    this.emit('presence.update', { id: from, presences: { [from]: { lastKnownPresence: type === 'unavailable' ? 'unavailable' : 'available', lastSeen } } })
  },

  onChatState(node) {
    const { from, participant } = node.attrs
    const info = children(node)[0]
    if (!from || !info) return
    const state = info.tag === 'composing' ? (info.attrs && info.attrs.media === 'audio' ? 'recording' : 'composing') : info.tag === 'paused' ? 'paused' : undefined
    if (!state) return
    this.emit('presence.update', { id: from, presences: { [participant || from]: { lastKnownPresence: state } } })
  },

  onDevicesNotification(node) {
    if (!node.attrs.from) return
    try {
      this.deviceCache.delete(jidNormalizedUser(node.attrs.from))
    } catch {}
  },

  onEncryptNotification(node) {
    if (getChild(node, 'identity')) {
      try {
        signal.deleteUserSessions(this.auth.state, node.attrs.from)
        this.auth.save()
        this.emit('identity.changed', { id: node.attrs.from })
      } catch (e) {
        this.emit('error', e)
      }
      return
    }
    this.ensurePreKeys().catch((e) => this.emit('error', e))
  },

  onIb(node) {
    for (const child of children(node)) {
      if (child.tag === 'offline_preview') {
        this.sendNode({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_batch', attrs: { count: '100' } }] })
      } else if (child.tag === 'dirty') {
        const type = child.attrs && child.attrs.type
        if (type === 'groups') this.groupCache.clear()
        if (type === 'account_sync' || type === 'groups') {
          const attrs = { type }
          if (child.attrs.timestamp) attrs.timestamp = child.attrs.timestamp
          this.query({ tag: 'iq', attrs: { to: S, type: 'set', xmlns: 'urn:xmpp:whatsapp:dirty' }, content: [{ tag: 'clean', attrs }] }).catch(() => {})
        }
      }
    }
  },

  onGroupNotification(node) {
    const { from, participant: author } = node.attrs
    if (!from || !isJidGroup(from)) return
    this.groupCache.delete(from)
    const state = this.auth.state
    const timestamp = node.attrs.t ? +node.attrs.t : undefined
    const offline = node.attrs.offline !== undefined
    const updates = []
    for (const child of children(node)) {
      const action = child.tag === 'leave' ? 'remove' : child.tag
      if (['add', 'remove', 'promote', 'demote'].includes(action)) {
        const info = getChildren(child, 'participant').map((p) => participantFromNode(p, state)).filter(Boolean)
        if (!info.length) continue
        if (action === 'remove') {
          const me = state.creds.me
          if (me) senderkey.resetOwn(state, from, signal.addrKey(me.id))
        }
        this.emit('group-participants.update', {
          id: from,
          author,
          authorPn: node.attrs.participant_pn,
          action: child.tag === 'leave' ? 'leave' : action,
          participants: info.map((p) => p.id),
          participantsInfo: info,
          timestamp,
          offline
        })
        continue
      }
      const update = { id: from, author, timestamp, offline }
      const a = child.attrs || {}
      switch (child.tag) {
        case 'subject':
          update.subject = a.subject
          update.subjectOwner = a.s_o
          update.subjectTime = a.s_t ? +a.s_t : undefined
          break
        case 'description':
          update.desc = a.delete === 'true' ? undefined : nodeText(getChild(child, 'body'))
          update.descId = a.id
          break
        case 'announcement':
          update.announce = true
          break
        case 'not_announcement':
          update.announce = false
          break
        case 'locked':
          update.restrict = true
          break
        case 'unlocked':
          update.restrict = false
          break
        case 'ephemeral':
          update.ephemeralDuration = a.expiration ? +a.expiration : 0
          break
        case 'not_ephemeral':
          update.ephemeralDuration = 0
          break
        case 'membership_approval_mode': {
          const mode = getChild(child, 'group_join')
          update.joinApprovalMode = Boolean(mode && mode.attrs && mode.attrs.state === 'on')
          break
        }
        case 'member_add_mode':
          update.memberAddMode = nodeText(child) === 'all_member_add'
          break
        default:
          continue
      }
      updates.push(update)
    }
    if (updates.length) this.emit('groups.update', updates)
  }
}
