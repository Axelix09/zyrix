import { Socket, fetchVersion } from './socket.js'
import { useFileAuthState } from './auth.js'
import { buildMessage } from './content.js'

const generated = new WeakMap()
const id = () => `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker']

export const clientProfiles = { ubuntu: (browser = 'Chrome') => ['Ubuntu', browser, '1.0.0'] }
export const fetchProtocolVersion = async () => ({ version: await fetchVersion() })

export async function useZyrixAuth(directory) {
  const auth = useFileAuthState(directory)
  return { state: auth.state, saveCreds: auth.save, auth }
}

export function createClient(options = {}) {
  const auth = options.auth?.state && typeof options.auth.save === 'function'
    ? options.auth
    : { state: options.auth, save: () => {} }
  const { auth: _ignored, version, browser, logger, printQRInTerminal, ...rest } = options
  const sock = new Socket({
    ...rest,
    auth,
    version,
    browser,
    logger,
    printQR: Boolean(printQRInTerminal),
  })
  attachMessageDelivery(sock)
  sock.start().catch((error) => sock.emit('error', error))
  return sock
}

export function createMessageId() {
  return id()
}

export function createMessageEnvelope(jid, message, options = {}) {
  const result = {
    key: { remoteJid: jid, fromMe: true, id: options.messageId || id(), participant: options.userJid },
    message,
  }
  generated.set(result.message, { kind: 'raw', content: result.message, options, id: result.key.id })
  return result
}

export async function createMessage(jid, content, options = {}) {
  const mediaType = MEDIA_TYPES.find((type) => content && content[type] !== undefined)
  const message = mediaType ? { [`${mediaType}Message`]: {} } : buildMessage(content, options)
  const result = {
    key: { remoteJid: jid, fromMe: true, id: options.messageId || id(), participant: options.userJid },
    message,
  }
  generated.set(result.message, { kind: 'content', content, options, id: result.key.id })
  return result
}

export async function createMessageContent(content, options = {}) {
  const mediaType = MEDIA_TYPES.find((type) => content && content[type] !== undefined)
  return mediaType ? { [`${mediaType}Message`]: {} } : buildMessage(content, options)
}

const albumIndex = new Map()

const MEDIA_CHUNK_BYTES = 64 * 1024

/**
 * Convierte media descargada en un AsyncIterable de trozos. NO es streaming real:
 * `downloadMedia()` descifra el medio completo en un Buffer antes de devolverlo, así que
 * el pico de memoria es el tamaño total del archivo. Se entrega en trozos de 64 KiB para
 * consumidores que prefieran una interfaz iterable; si necesitas memoria acotada usa
 * `downloadMediaToFile()`.
 */
export async function readMediaStream(sock, message, mediaType) {
  if (!sock || typeof sock.downloadMedia !== 'function') {
    throw new TypeError('readMediaStream requires a Zyrix socket')
  }
  const buffer = Buffer.from(await sock.downloadMedia(message, mediaType))
  return (async function* () {
    for (let offset = 0; offset < buffer.length; offset += MEDIA_CHUNK_BYTES) {
      yield buffer.subarray(offset, offset + MEDIA_CHUNK_BYTES)
    }
  })()
}

export function attachMessageDelivery(sock) {
  if (sock.__zyrixMessageDelivery) return sock
  Object.defineProperty(sock, '__zyrixMessageDelivery', { value: true, enumerable: false })

  if (!sock.sendPrepared) {
    sock.sendPrepared = async (jid, message, options = {}) => {
      const item = generated.get(message)
      const messageId = options.messageId || item?.id
      if (item?.kind === 'content') {
        const extra = {}
        if (message && typeof message === 'object') {
          if (message.messageContextInfo) extra.messageContextInfo = message.messageContextInfo
          if (message.contextInfo) extra.contextInfo = message.contextInfo
        }
        const association = extra.messageContextInfo?.messageAssociation
        if (association?.parentMessageKey?.id && association.messageIndex === undefined) {
          const parentId = association.parentMessageKey.id
          const index = albumIndex.get(parentId) || 0
          association.messageIndex = index
          albumIndex.set(parentId, index + 1)
          const timer = setTimeout(() => albumIndex.delete(parentId), 120000)
          if (typeof timer.unref === 'function') timer.unref()
        }
        return sock.sendMessage(jid, item.content, {
          quoted: item.options?.quoted,
          mentions: item.options?.mentions,
          contextInfo: item.options?.contextInfo,
          ...extra,
          messageId
        })
      }
      return sock.sendMessage(jid, message, { ...options, messageId })
    }
  }

  return sock
}
