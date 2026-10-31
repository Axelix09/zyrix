import { extractText, extractInteractiveId, unwrapMessage } from './content.js'
import { jidNormalizedUser, isJidGroup } from './jid.js'

const KINDS = [
  ['conversation', 'text'],
  ['extendedTextMessage', 'text'],
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
  ['stickerPackMessage', 'stickerPack'],
  ['locationMessage', 'location'],
  ['liveLocationMessage', 'liveLocation'],
  ['contactMessage', 'contact'],
  ['contactsArrayMessage', 'contacts'],
  ['pollCreationMessage', 'poll'],
  ['pollCreationMessageV2', 'poll'],
  ['pollCreationMessageV3', 'poll'],
  ['pollUpdateMessage', 'pollUpdate'],
  ['reactionMessage', 'reaction'],
  ['buttonsResponseMessage', 'buttonResponse'],
  ['listResponseMessage', 'listResponse'],
  ['templateButtonReplyMessage', 'templateReply'],
  ['interactiveResponseMessage', 'interactiveResponse'],
  ['groupInviteMessage', 'groupInvite'],
  ['protocolMessage', 'protocol']
]

const MEDIA = new Set(['image', 'video', 'audio', 'document', 'sticker'])

const safeNormalize = (value) => {
  if (!value) return undefined
  try {
    return jidNormalizedUser(value)
  } catch {
    return value
  }
}

const toNumber = (value) => (value && typeof value === 'object' && typeof value.toNumber === 'function' ? value.toNumber() : Number(value || 0))

const parseMessage = (event, { self } = {}) => {
  if (!event || !event.key || !event.message) throw new TypeError('parseMessage requiere un evento messages.upsert')
  const { key } = event
  const body = unwrapMessage(event.message) || {}
  const found = KINDS.find(([field]) => body[field] != null)
  const field = found ? found[0] : undefined
  const type = found ? found[1] : 'unknown'
  const payload = field ? body[field] : undefined
  const isGroup = isJidGroup(key.remoteJid)
  const context = payload && typeof payload === 'object' ? payload.contextInfo : undefined

  const sender = key.fromMe ? safeNormalize(self) : safeNormalize(isGroup ? key.participant : key.remoteJid)
  const senderAlt = key.fromMe ? undefined : safeNormalize(isGroup ? key.participantAlt : key.remoteJidAlt)

  let quoted = null
  if (context && context.stanzaId && context.quotedMessage) {
    quoted = {
      key: {
        id: context.stanzaId,
        remoteJid: key.remoteJid,
        remoteJidAlt: key.remoteJidAlt,
        participant: context.participant,
        participantAlt: context.participantAlt,
        fromMe: false
      },
      message: context.quotedMessage,
      sender: safeNormalize(context.participant || (isGroup ? undefined : key.remoteJid))
    }
  }

  let media = null
  if (MEDIA.has(type)) {
    media = {
      type,
      mimetype: payload.mimetype,
      fileName: payload.fileName,
      fileLength: toNumber(payload.fileLength),
      seconds: payload.seconds,
      width: payload.width,
      height: payload.height,
      caption: payload.caption,
      ptt: Boolean(payload.ptt),
      gif: Boolean(payload.gifPlayback)
    }
  }

  return {
    id: key.id,
    chat: key.remoteJid,
    sender,
    senderAlt,
    fromMe: Boolean(key.fromMe),
    isGroup,
    pushName: event.pushName,
    timestamp: toNumber(event.messageTimestamp),
    offline: Boolean(event.offline),
    type,
    text: extractText(body),
    buttonId: extractInteractiveId(body),
    mentions: (context && context.mentionedJid) || [],
    quoted,
    media,
    isForwarded: Boolean(context && context.isForwarded),
    expiration: context && context.expiration ? context.expiration : undefined,
    viewOnce: Boolean(event.message.viewOnceMessage || event.message.viewOnceMessageV2 || event.message.viewOnceMessageV2Extension || (payload && payload.viewOnce)),
    key,
    message: body
  }
}

export { parseMessage }
