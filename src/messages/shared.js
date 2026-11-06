import { proto } from '../proto.js'
import { Curve } from '../crypto.js'
import { getChild, getChildren, jidDecode, jidEncode, isJidGroup } from '../binary.js'
import * as signal from '../signal.js'
import * as senderkey from '../senderkey.js'
import { S_WHATSAPP_NET as S, be, genId, pad, unpad, encodeAccount } from '../util.js'
import { buildMessage, REVOKE_TYPE, EDIT_TYPE } from '../content.js'
import { ZyrixError, ErrorKind } from '../errors.js'
import { normalizeJid, jidNormalizedUser, isJidLid, isJidPN, sameUser as sameIdentity, makeIdentityMap } from '../jid.js'

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

export { MEDIA_KEYS, SKIP, MAX_RETRIES, normalize, normalizeQuoted, userJid, sameUser, participantFromNode, parseGroupMetadata, nodeText, messageType, editAttribute, ackError, encodeMsg, ackAttrs }
