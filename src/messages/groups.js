import { getChild, getChildren, isJidGroup } from '../binary.js'
import { S_WHATSAPP_NET as S, genId } from '../util.js'
import { ZyrixError, ErrorKind } from '../errors.js'
import { normalizeJid, sameUser as sameIdentity, makeIdentityMap } from '../jid.js'

import { parseGroupMetadata } from './shared.js'

export default {
  async groupCreate(subject, participants = []) {
    if (typeof subject !== 'string' || !subject.trim()) throw new TypeError('subject must be a non-empty string')
    if (!Array.isArray(participants)) throw new TypeError('participants must be an array')
    const response = await this.query({
      tag: 'iq',
      attrs: { type: 'set', xmlns: 'w:g2', to: S },
      content: [{ tag: 'create', attrs: { subject, key: genId() }, content: participants.map((participant) => ({ tag: 'participant', attrs: { jid: normalizeJid(participant, S) } })) }]
    })
    const group = getChild(response, 'group')
    const id = group && (group.attrs.id || group.attrs.jid)
    if (!id) throw new ZyrixError('group creation response has no id', { kind: ErrorKind.PROTOCOL, errorCode: 'GROUP_RESPONSE_INVALID' })
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
    if (!g || !g.attrs) throw new ZyrixError(`invalid metadata response for ${jid}`, { kind: ErrorKind.PROTOCOL, errorCode: 'GROUP_RESPONSE_INVALID' })
    const meta = parseGroupMetadata(jid, g, this.auth.state)
    this.groupCache.set(jid, meta)
    return meta
  },

  async getGroupParticipant(group, user) {
    if (!isJidGroup(group)) throw new TypeError('group must be a group JID')
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
    if (!isJidGroup(group)) throw new TypeError('group must be a group JID')
    if (!['add', 'remove', 'promote', 'demote'].includes(action)) throw new TypeError('action must be add, remove, promote or demote')
    if (!Array.isArray(participants) || !participants.length) throw new TypeError('participants requires at least one JID')
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
    if (!isJidGroup(group) || typeof subject !== 'string' || !subject.trim()) throw new TypeError('invalid group or subject')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'subject', attrs: {}, content: subject }] })
    this.groupCache.delete(group)
    return response
  },

  async groupUpdateDescription(group, description) {
    if (!isJidGroup(group) || typeof description !== 'string') throw new TypeError('invalid group or description')
    const current = await this.groupMetadata(group)
    const attrs = description ? { id: genId(), ...(current.descId ? { prev: current.descId } : {}) } : { delete: 'true' }
    const content = description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf8') }] : undefined
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'description', attrs, content }] })
    this.groupCache.delete(group)
    return response
  },

  async groupSettingUpdate(group, setting) {
    if (!isJidGroup(group)) throw new TypeError('group must be a group JID')
    const settings = new Set(['announcement', 'not_announcement', 'locked', 'unlocked'])
    if (!settings.has(setting)) throw new TypeError('invalid setting')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: setting, attrs: {} }] })
    this.groupCache.delete(group)
    return response
  },

  async groupLeave(group) {
    if (!isJidGroup(group)) throw new TypeError('group must be a group JID')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: S }, content: [{ tag: 'leave', attrs: {}, content: [{ tag: 'group', attrs: { id: group } }] }] })
    this.groupCache.delete(group)
    return response
  },

  async groupInviteCode(group) {
    if (!isJidGroup(group)) throw new TypeError('group must be a group JID')
    const response = await this.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:g2', to: group }, content: [{ tag: 'invite', attrs: {} }] })
    const invite = getChild(response, 'invite')
    return invite && (invite.attrs.code || (typeof invite.content === 'string' ? invite.content : undefined))
  },

  async groupRevokeInvite(group) {
    if (!isJidGroup(group)) throw new TypeError('group must be a group JID')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'invite', attrs: {} }] })
    const invite = getChild(response, 'invite')
    return invite && (invite.attrs.code || (typeof invite.content === 'string' ? invite.content : undefined))
  },

  async groupAcceptInvite(code) {
    if (typeof code !== 'string' || !code.trim()) throw new TypeError('invalid invite code')
    const cleanCode = code.trim().replace(/^https:\/\/chat\.whatsapp\.com\//i, '')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: '@g.us' }, content: [{ tag: 'invite', attrs: { code: cleanCode } }] })
    return getChild(response, 'group')?.attrs?.jid || getChild(response, 'group')?.attrs?.id || response?.attrs?.from
  },

  async groupGetInviteInfo(code) {
    if (typeof code !== 'string' || !code.trim()) throw new TypeError('invalid invite code')
    const cleanCode = code.trim().replace(/^https:\/\/chat\.whatsapp\.com\//i, '')
    const response = await this.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:g2', to: '@g.us' }, content: [{ tag: 'invite', attrs: { code: cleanCode } }] })
    const group = getChild(response, 'group')
    return group ? parseGroupMetadata(group.attrs.id || group.attrs.jid, group, this.auth.state) : undefined
  },

  async groupAcceptInviteV4(keyOrJid, inviteMessage) {
    if (!inviteMessage || typeof inviteMessage.groupJid !== 'string' || !inviteMessage.inviteCode) throw new TypeError('invalid inviteMessage')
    const admin = typeof keyOrJid === 'string' ? keyOrJid : keyOrJid?.remoteJid
    if (!admin) throw new TypeError('the JID of the invite admin is required')
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
    if (!isJidGroup(group)) throw new TypeError('group must be a group JID')
    const response = await this.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:g2', to: group }, content: [{ tag: 'membership_approval_requests', attrs: {} }] })
    return getChildren(getChild(response, 'membership_approval_requests'), 'membership_approval_request').map((node) => ({ ...node.attrs }))
  },

  async groupRequestParticipantsUpdate(group, participants, action) {
    if (!isJidGroup(group) || !['approve', 'reject'].includes(action) || !Array.isArray(participants) || !participants.length) throw new TypeError('invalid join request')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'membership_requests_action', attrs: {}, content: [{ tag: action, attrs: {}, content: participants.map((jid) => ({ tag: 'participant', attrs: { jid: normalizeJid(jid, S) } })) }] }] })
    return getChildren(getChild(getChild(response, 'membership_requests_action'), action), 'participant').map((p) => ({ status: p.attrs.error || '200', jid: p.attrs.jid }))
  },

  async groupToggleEphemeral(group, seconds) {
    if (!isJidGroup(group) || !Number.isInteger(seconds) || seconds < 0 || seconds > 7776000) throw new RangeError('invalid ephemeral duration')
    const node = seconds ? { tag: 'ephemeral', attrs: { expiration: String(seconds) } } : { tag: 'not_ephemeral', attrs: {} }
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [node] })
    this.groupCache.delete(group)
    return response
  },

  async groupMemberAddMode(group, mode) {
    if (!isJidGroup(group) || !['admin_add', 'all_member_add'].includes(mode)) throw new TypeError('invalid member-add mode')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'member_add_mode', attrs: {}, content: mode }] })
    this.groupCache.delete(group)
    return response
  },

  async groupJoinApprovalMode(group, mode) {
    if (!isJidGroup(group) || !['on', 'off'].includes(mode)) throw new TypeError('invalid approval mode')
    const response = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2', to: group }, content: [{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: mode } }] }] })
    this.groupCache.delete(group)
    return response
  },
}
