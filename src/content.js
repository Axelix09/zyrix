import { randomBytes } from 'node:crypto'
import { proto } from './proto.js'
import { toBuffer, sniffMimeType } from './util.js'

const CONTEXT_TYPES = new Set([
  'extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage',
  'contactMessage', 'contactsArrayMessage', 'locationMessage', 'liveLocationMessage', 'buttonsMessage',
  'listMessage', 'templateMessage', 'interactiveMessage', 'pollCreationMessage', 'pollCreationMessageV2',
  'pollCreationMessageV3', 'eventMessage', 'stickerPackMessage', 'albumMessage', 'groupInviteMessage'
])

const NON_CONTEXT_TYPES = new Set([
  'reactionMessage', 'protocolMessage', 'pollUpdateMessage',
  'senderKeyDistributionMessage', 'deviceSentMessage'
])

const assertText = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} debe ser texto no vacío`)
  return value
}

const prepareInteractiveImage = async function (options) {
  if (options.image === undefined) return options
  if (typeof this.uploadMedia !== 'function') throw new TypeError('el socket Zyrix no puede subir imágenes')
  const data = await toBuffer(options.image, this.maxMediaBytes)
  const uploaded = await this.uploadMedia(data, 'image')
  const header = {
    ...(options.header || {}),
    hasMediaAttachment: true,
    imageMessage: {
      url: uploaded.url,
      directPath: uploaded.directPath,
      mediaKey: uploaded.mediaKey,
      mimetype: options.imageMimetype || sniffMimeType(data, 'image/jpeg'),
      fileEncSha256: uploaded.fileEncSha256,
      fileSha256: uploaded.fileSha256,
      fileLength: uploaded.fileLength,
      mediaKeyTimestamp: Math.floor(Date.now() / 1000)
    }
  }
  const prepared = { ...options, header }
  delete prepared.image
  delete prepared.imageMimetype
  return prepared
}

const asJid = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('se esperaba un JID')
  return value.includes('@') ? value : `${value}@s.whatsapp.net`
}

const quoteInfo = (quoted) => {
  if (!quoted) return {}
  const key = quoted.key || quoted
  if (!key || !quoted.message || typeof quoted.message !== 'object') {
    throw new TypeError('quoted debe ser un mensaje con key y message')
  }
  const stanzaId = typeof key.id === 'string' && key.id ? key.id : randomBytes(16).toString('hex').toUpperCase()
  const context = { stanzaId, quotedMessage: proto.Message.fromObject(quoted.message) }
  if (key.participant) context.participant = key.participant
  else if (key.participantAlt) context.participant = key.participantAlt
  if (key.remoteJid) context.remoteJid = key.remoteJid
  return context
}

const quoteKey = (target) => {
  const key = target && (target.key || target)
  if (!key || typeof key.id !== 'string' || !key.id || typeof key.remoteJid !== 'string' || typeof key.fromMe !== 'boolean') {
    throw new TypeError('el mensaje objetivo debe incluir key.id, key.remoteJid y key.fromMe')
  }
  const result = { remoteJid: key.remoteJid, fromMe: key.fromMe, id: key.id }
  if (key.participant) result.participant = key.participant
  if (key.participantAlt) result.participantAlt = key.participantAlt
  if (key.remoteJidAlt) result.remoteJidAlt = key.remoteJidAlt
  return result
}

const applyContext = (message, options = {}) => {
  const context = {
    ...(options.contextInfo || {}),
    ...quoteInfo(options.quoted)
  }
  if (Array.isArray(options.mentions) && options.mentions.length) {
    context.mentionedJid = options.mentions.map(asJid)
  }
  if (options.expiration !== undefined) {
    if (!Number.isInteger(options.expiration) || options.expiration < 0) throw new RangeError('expiration debe ser un entero de segundos')
    if (options.expiration) context.expiration = options.expiration
  }
  if (!Object.keys(context).length) return message

  if (message.conversation !== undefined) {
    const text = message.conversation
    delete message.conversation
    message.extendedTextMessage = { text, contextInfo: context }
    return message
  }

  const wrapper = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage']
    .find((key) => message[key] && message[key].message)
  if (wrapper) {
    message[wrapper] = { ...message[wrapper], message: applyContext(message[wrapper].message, options) }
    return message
  }
  const type = Object.keys(message).find((key) => key.endsWith('Message') && message[key] != null)
  if (!type || NON_CONTEXT_TYPES.has(type)) return message
  if (!CONTEXT_TYPES.has(type)) throw new TypeError(`el formato ${type || 'desconocido'} no admite contextInfo en Zyrix`)
  message[type] = { ...message[type], contextInfo: { ...(message[type].contextInfo || {}), ...context } }
  return message
}

const isMessageShape = (value) => Object.keys(value).some((key) => key === 'conversation' || key === 'messageContextInfo' || key.endsWith('Message'))

const PROTOCOL_TYPE = proto.Message.ProtocolMessage?.Type || {}
const REVOKE_TYPE = PROTOCOL_TYPE.REVOKE ?? 0
const EDIT_TYPE = PROTOCOL_TYPE.MESSAGE_EDIT ?? 14

const buildRaw = (spec) => {
  const type = spec.type
  switch (type) {
    case 'text': {
      const value = assertText(spec.text, 'text')
      const preview = spec.linkPreview
      if (preview) {
        return {
          extendedTextMessage: {
            text: value,
            matchedText: assertText(preview.url, 'linkPreview.url'),
            canonicalUrl: preview.url,
            title: preview.title,
            description: preview.description,
            jpegThumbnail: preview.thumbnail,
            previewType: 0
          }
        }
      }
      return { conversation: value }
    }
    case 'delete':
      return { protocolMessage: { key: quoteKey(spec.target), type: REVOKE_TYPE } }
    case 'edit':
      return {
        protocolMessage: {
          key: quoteKey(spec.target),
          type: EDIT_TYPE,
          editedMessage: { conversation: assertText(spec.text, 'text') },
          timestampMs: Date.now()
        }
      }
    case 'contacts': {
      if (!Array.isArray(spec.contacts) || spec.contacts.length < 1 || spec.contacts.length > 20) throw new RangeError('contacts requiere entre 1 y 20 contactos')
      return {
        contactsArrayMessage: {
          displayName: spec.displayName || `${spec.contacts.length} contactos`,
          contacts: spec.contacts.map((c, i) => ({ displayName: assertText(c.displayName, `contacts[${i}].displayName`), vcard: assertText(c.vcard, `contacts[${i}].vcard`) }))
        }
      }
    }
    case 'groupInvite':
      return {
        groupInviteMessage: {
          groupJid: assertText(spec.groupJid, 'groupJid'),
          inviteCode: assertText(spec.inviteCode, 'inviteCode'),
          inviteExpiration: Number(spec.inviteExpiration) || Math.floor(Date.now() / 1000) + 3 * 86400,
          groupName: spec.groupName || '',
          caption: spec.caption || ''
        }
      }
    case 'buttons': {
      const buttons = spec.buttons
      if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 3) throw new RangeError('buttons requiere entre 1 y 3 opciones')
      return {
        buttonsMessage: {
          contentText: assertText(spec.text, 'text'),
          footerText: spec.footer || '',
          headerType: proto.Message.ButtonsMessage.HeaderType.TEXT,
          buttons: buttons.map((button, i) => ({
            buttonId: assertText(button.id, `buttons[${i}].id`),
            buttonText: { displayText: assertText(button.text, `buttons[${i}].text`) },
            type: 1
          }))
        }
      }
    }
    case 'interactive': {
      const buttons = spec.buttons
      if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 10) throw new RangeError('interactive requiere entre 1 y 10 opciones')
      const nativeButtons = buttons.map((button, i) => {
        const name = button.name || 'quick_reply'
        const params = button.params || { display_text: assertText(button.text, `buttons[${i}].text`), id: assertText(button.id, `buttons[${i}].id`) }
        return { name, buttonParamsJson: JSON.stringify(params) }
      })
      const interactiveMessage = {
        body: { text: assertText(spec.text, 'text') },
        nativeFlowMessage: { buttons: nativeButtons, messageVersion: 1, messageParamsJson: spec.messageParamsJson || undefined }
      }
      if (spec.title) interactiveMessage.header = { title: spec.title }
      if (spec.header) interactiveMessage.header = { ...spec.header }
      if (spec.footer) interactiveMessage.footer = { text: spec.footer }
      // Los clientes de WhatsApp esperan este metadata dentro del
      // interactiveMessage cuando el mensaje usa native-flow/botones.
      if (spec.contextInfo && typeof spec.contextInfo === 'object') {
        interactiveMessage.contextInfo = { ...spec.contextInfo }
      }
      return {
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2
            },
            interactiveMessage
          }
        }
      }
    }
    case 'list': {
      if (!Array.isArray(spec.sections) || !spec.sections.length) throw new TypeError('list requiere al menos una sección')
      const sections = spec.sections.map((section, si) => {
        if (!Array.isArray(section.rows) || !section.rows.length) throw new TypeError(`sections[${si}] requiere filas`)
        return {
          title: assertText(section.title, `sections[${si}].title`),
          rows: section.rows.map((row, ri) => ({
            title: assertText(row.title, `sections[${si}].rows[${ri}].title`),
            rowId: assertText(row.id, `sections[${si}].rows[${ri}].id`),
            description: row.description || ''
          }))
        }
      })
      return {
        listMessage: {
          title: spec.title || '',
          description: assertText(spec.text, 'text'),
          buttonText: assertText(spec.buttonText || 'Ver opciones', 'buttonText'),
          footerText: spec.footer || '',
          listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
          sections
        }
      }
    }
    case 'poll': {
      if (!Array.isArray(spec.options) || spec.options.length < 2 || spec.options.length > 12) throw new RangeError('poll requiere entre 2 y 12 opciones')
      const options = spec.options.map((option) => assertText(typeof option === 'string' ? option : option.name, 'poll option'))
      if (new Set(options).size !== options.length) throw new TypeError('las opciones de poll no pueden repetirse')
      const selectable = spec.selectableOptionsCount ?? 1
      if (!Number.isInteger(selectable) || selectable < 0 || selectable > options.length) throw new RangeError('selectableOptionsCount fuera de rango')
      return { pollCreationMessage: { name: assertText(spec.text, 'text'), options: options.map((optionName) => ({ optionName })), selectableOptionsCount: selectable } }
    }
    case 'location': {
      const lat = Number(spec.latitude)
      const lon = Number(spec.longitude)
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        throw new RangeError('latitude/longitude fuera de rango')
      }
      return { locationMessage: { degreesLatitude: lat, degreesLongitude: lon, name: spec.name, address: spec.address, comment: spec.comment } }
    }
    case 'contact':
      return { contactMessage: { displayName: assertText(spec.displayName, 'displayName'), vcard: assertText(spec.vcard, 'vcard') } }
    case 'reaction':
      return { reactionMessage: { key: quoteKey(spec.target || spec.quoted), text: typeof spec.text === 'string' ? spec.text : '', senderTimestampMs: Date.now() } }
    default:
      throw new TypeError(`tipo de contenido no soportado: ${String(type)}`)
  }
}

const FORWARD_BLOCKED = new Set(['senderKeyDistributionMessage', 'protocolMessage', 'reactionMessage', 'messageContextInfo', 'deviceSentMessage'])

const forwardMessage = (source) => {
  const message = unwrapMessage(source && source.message ? source.message : source)
  if (!message || typeof message !== 'object') throw new TypeError('no hay mensaje que reenviar')
  let type = Object.keys(message).find((key) => (key === 'conversation' || key.endsWith('Message')) && message[key] != null && !FORWARD_BLOCKED.has(key))
  if (!type) throw new TypeError('el mensaje no se puede reenviar')
  let out
  if (type === 'conversation') {
    type = 'extendedTextMessage'
    out = { extendedTextMessage: { text: message.conversation } }
  } else out = { [type]: { ...message[type] } }
  const context = { ...(out[type].contextInfo || {}) }
  delete context.stanzaId
  delete context.participant
  delete context.quotedMessage
  delete context.remoteJid
  context.isForwarded = true
  context.forwardingScore = (Number(context.forwardingScore) || 0) + 1
  out[type].contextInfo = context
  return out
}

const buildMessage = (input, options = {}) => {
  if (typeof input === 'string') input = { type: 'text', text: input }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('content debe ser texto o un objeto de mensaje')

  const settings = { ...input, ...options }
  const raw = input.delete
    ? buildRaw({ type: 'delete', target: input.delete })
    : input.edit
      ? buildRaw({ type: 'edit', target: input.edit, text: input.text })
      : input.forward
        ? forwardMessage(input.forward)
        : input.type
          ? buildRaw(settings)
          : typeof input.text === 'string' && !isMessageShape(input)
            ? buildRaw({ ...settings, type: 'text' })
            : { ...input }

  let message = applyContext(raw, settings)
  if (settings.viewOnce && ['imageMessage', 'videoMessage', 'audioMessage'].some((key) => message[key])) {
    message = { viewOnceMessage: { message } }
  }

  if (settings.messageContextInfo && typeof settings.messageContextInfo === 'object' && Object.keys(settings.messageContextInfo).length) {
    message = { ...message, messageContextInfo: { ...(message.messageContextInfo || {}), ...settings.messageContextInfo } }
  }
  const error = proto.Message.verify(message)
  if (error) throw new TypeError(`mensaje inválido: ${error}`)
  return message
}

const text = (value, options = {}) => buildMessage({ ...options, type: 'text', text: value })
const buttons = (options = {}) => buildMessage({ ...options, type: 'buttons' })
const interactive = (options = {}) => buildMessage({ ...options, type: 'interactive' })
const list = (options = {}) => buildMessage({ ...options, type: 'list' })
const poll = (options = {}) => buildMessage({ ...options, type: 'poll' })
const location = (options = {}) => buildMessage({ ...options, type: 'location' })
const contact = (options = {}) => buildMessage({ ...options, type: 'contact' })
const reaction = (target, emoji = '') => buildMessage({ type: 'reaction', target, text: emoji })
const contacts = (options = {}) => buildMessage({ ...options, type: 'contacts' })
const groupInvite = (options = {}) => buildMessage({ ...options, type: 'groupInvite' })
const deleteMessage = (target) => buildMessage({ delete: target })
const editMessage = (target, value) => buildMessage({ edit: target, text: value })
const forward = (source, options = {}) => buildMessage({ forward: source }, options)
const vcard = ({ name, number, organization } = {}) => {
  const display = assertText(name, 'name')
  const digits = String(number || '').replace(/\D/g, '')
  if (!digits) throw new TypeError('number debe contener dígitos')
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:;${display};;;`, `FN:${display}`]
  if (organization) lines.push(`ORG:${organization};`)
  lines.push(`TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`, 'END:VCARD')
  return lines.join('\n')
}
const stickerPack = (options = {}) => {
  if (!Array.isArray(options.stickers) || options.stickers.length < 1 || options.stickers.length > 100) throw new RangeError('stickers requiere entre 1 y 100 elementos')
  const stickers = options.stickers.map((sticker, i) => {
    if (!sticker || typeof sticker.fileName !== 'string' || !sticker.fileName.trim()) throw new TypeError(`stickers[${i}].fileName inválido`)
    return {
      fileName: sticker.fileName,
      isAnimated: Boolean(sticker.isAnimated),
      emojis: Array.isArray(sticker.emojis) ? sticker.emojis : [],
      accessibilityLabel: sticker.accessibilityLabel,
      isLottie: Boolean(sticker.isLottie),
      mimetype: sticker.mimetype || 'image/webp',
      premium: sticker.premium
    }
  })
  return buildMessage({ stickerPackMessage: {
    stickerPackId: options.stickerPackId || `zyrix-${Date.now()}`,
    name: assertText(options.name || 'Zyrix stickers', 'name'),
    publisher: assertText(options.publisher || 'Zyrix', 'publisher'),
    stickers,
    caption: options.caption,
    packDescription: options.packDescription,
    trayIconFileName: options.trayIconFileName,
    stickerPackOrigin: options.stickerPackOrigin ?? 2
  } }, options)
}

const unwrapMessage = (message) => {
  let current = message
  for (let i = 0; i < 10 && current && typeof current === 'object'; i++) {
    const wrapper = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage']
      .find((key) => current[key] && current[key].message)
    if (!wrapper) break
    current = current[wrapper].message
  }
  return current
}

const extractInteractiveId = (input) => {
  const message = unwrapMessage(input && input.message ? input.message : input)
  const response = message?.interactiveResponseMessage || message?.nativeFlowResponseMessage
  const native = response?.nativeFlowResponseMessage || response
  const raw = native?.paramsJson || native?.messageParamsJson
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      return parsed.id || parsed.selectedId || parsed.selectedRowId || parsed.button_id || parsed.buttonId || parsed.display_text
    } catch {}
  }
  return response?.selectedId || response?.selectedRowId || response?.selectedDisplayText || native?.selectedId || native?.selectedRowId
}

const extractText = (input) => {
  const message = unwrapMessage(input && input.message ? input.message : input)
  if (!message || typeof message !== 'object') return undefined
  const interactiveId = extractInteractiveId(message)
  if (interactiveId) return interactiveId
  if (typeof message.conversation === 'string') return message.conversation
  for (const key of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage']) {
    if (typeof message[key]?.text === 'string') return message[key].text
    if (typeof message[key]?.caption === 'string') return message[key].caption
  }
  if (typeof message.audioMessage?.caption === 'string') return message.audioMessage.caption
  if (typeof message.buttonsResponseMessage?.selectedDisplayText === 'string') return message.buttonsResponseMessage.selectedDisplayText
  if (typeof message.buttonsResponseMessage?.selectedButtonId === 'string') return message.buttonsResponseMessage.selectedButtonId
  if (typeof message.listResponseMessage?.title === 'string') return message.listResponseMessage.title
  if (typeof message.listResponseMessage?.singleSelectReply?.selectedRowId === 'string') return message.listResponseMessage.singleSelectReply.selectedRowId
  if (typeof message.templateButtonReplyMessage?.selectedDisplayText === 'string') return message.templateButtonReplyMessage.selectedDisplayText
  if (typeof message.interactiveResponseMessage?.body?.text === 'string') return message.interactiveResponseMessage.body.text
  if (typeof message.pollCreationMessage?.name === 'string') return message.pollCreationMessage.name
  if (typeof message.reactionMessage?.text === 'string') return message.reactionMessage.text
  if (typeof message.stickerPackMessage?.caption === 'string') return message.stickerPackMessage.caption
  return undefined
}

const socketMethods = {
  reply(to, value, quoted, options = {}) { return this.sendText(to, value, { ...options, quoted }) },
  sendText(to, value, options = {}) { return this.sendMessage(to, text(value, options)) },
  sendButtons(to, options = {}) {
    return this.sendInteractive(to, {
      ...options,
      buttons: (options.buttons || []).map((button) => {
        const text = button.text || button.displayText || button.title || ''
        const id = button.id || button.buttonId || ''
        if (!button.type) return {
          name: button.name || 'quick_reply',
          text,
          id,
          params: button.params || { display_text: text, id }
        }
        if (button.type === 'quick_reply') return {
          name: 'quick_reply',
          text,
          id,
          params: button.params || { display_text: text, id }
        }
        if (button.type === 'cta_url') return {
          name: 'cta_url',
          text,
          id,
          params: { display_text: text, url: button.url, merchant_url: button.url }
        }
        if (button.type === 'cta_copy') return {
          name: 'cta_copy',
          text,
          id: button.id || 'copy_code',
          params: { display_text: text, id: button.id || 'copy_code', copy_code: button.copyText || text }
        }
        if (button.type === 'cta_call') return {
          name: 'cta_call',
          text,
          id: button.id || button.phoneNumber,
          params: { display_text: text, id: button.phoneNumber }
        }
        if (button.type === 'single_select') return {
          name: 'single_select',
          text,
          id: button.id,
          params: { title: button.title || 'Ver opciones', sections: button.sections || [] }
        }
        if (button.type === 'inapp_signup') return { name: 'inapp_signup', text: button.text, params: {} }
        throw new TypeError(`tipo de botón desconocido: ${button.type}`)
      })
    })
  },
  async sendInteractive(to, options = {}) {
    options = await prepareInteractiveImage.call(this, options)
    const additionalNodes = options.additionalNodes || [
      {
        tag: 'biz',
        attrs: {},
        content: [{
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
        }]
      },
      ...(!String(to).endsWith('@g.us') ? [{ tag: 'bot', attrs: { biz_bot: '1' } }] : [])
    ]
    return this.sendMessage(to, interactive(options), { ...options, additionalNodes })
  },
  sendList(to, options = {}) {
    if (options.image !== undefined) {
      const sections = (options.sections || []).map((section) => ({
        ...section,
        rows: (section.rows || []).map((row) => ({ ...row, id: row.id || row.rowId }))
      }))
      return this.sendInteractive(to, {
        ...options,
        text: options.text || options.description,
        footer: options.footer || options.footerText,
        buttons: [{
          name: 'single_select',
          text: options.buttonText || 'Ver opciones',
          params: {
            title: options.buttonText || 'Ver opciones',
            sections
          }
        }]
      })
    }
    return this.sendMessage(to, list(options))
  },
  sendPoll(to, options) { return this.sendMessage(to, poll(options)) },
  sendLocation(to, options) { return this.sendMessage(to, location(options)) },
  sendContact(to, options) { return this.sendMessage(to, contact(options)) },
  sendReaction(to, target, emoji = '', options = {}) {
    return this.sendMessage(to, reaction(target, emoji), { waitAck: true, ackTimeoutMs: 5000, ...options })
  },
  sendContacts(to, options) { return this.sendMessage(to, contacts(options)) },
  sendGroupInvite(to, options) { return this.sendMessage(to, groupInvite(options)) },
  sendDelete(to, target) { return this.sendMessage(to, deleteMessage(target)) },
  sendEdit(to, target, value) { return this.sendMessage(to, editMessage(target, value)) },
  forward(to, source, options = {}) { return this.sendMessage(to, forward(source, options)) }
}

export { buildMessage, text, buttons, interactive, list, poll, location, contact, contacts, groupInvite, reaction, deleteMessage, editMessage, forward, vcard, stickerPack, extractText, extractInteractiveId, unwrapMessage, REVOKE_TYPE, EDIT_TYPE, socketMethods }
