import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { getChild, getChildren } from './binary.js'
import { encryptMedia, encryptMediaFile, decryptMedia } from './mediacrypto.js'
import { postFile } from './upload.js'
import { S_WHATSAPP_NET as S } from './util.js'
import { buildMessage, stickerPack, unwrapMessage } from './content.js'
import { normalizeJid } from './jid.js'
import { toBuffer, genId, sniffMimeType } from './util.js'

const PATH = { image: '/mms/image', video: '/mms/video', audio: '/mms/audio', document: '/mms/document', sticker: '/mms/image', 'sticker-pack': '/mms/sticker-pack' }
const TYPES = ['image', 'video', 'audio', 'document', 'sticker']
const MIME = { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/mpeg', document: 'application/octet-stream', sticker: 'image/webp' }
const ALLOWED_MEDIA_HOSTS = new Set(['mmg.whatsapp.net'])
const isAllowedUploadHost = (host) => typeof host === 'string' && (/^mmg\d+\.whatsapp\.net$/i.test(host) || host.toLowerCase() === 'mmg.whatsapp.net')

const localMediaPath = (input) => {
  if (typeof input === 'string') return /^(https?:\/\/|data:)/i.test(input) ? null : input
  if (!input || typeof input !== 'object' || Buffer.isBuffer(input) || input instanceof Uint8Array) return null
  const candidate = [input.file, input.path, input.url].find((value) => typeof value === 'string')
  return candidate && !/^(https?:\/\/|data:)/i.test(candidate) ? candidate : null
}

const readHead = async (filePath, length = 4096) => {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const assertMediaSize = (buffer, limit) => {
  if (!buffer || typeof buffer.length !== 'number') throw new TypeError('el media debe ser un Buffer o Uint8Array')
  if (buffer.length > limit) throw new RangeError(`el media supera el límite de ${limit} bytes`)
}

const readResponse = async (res, limit) => {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new RangeError(`la descarga supera el límite de ${limit} bytes`)
  const chunks = []
  let total = 0
  if (!res.body) return Buffer.alloc(0)
  for await (const chunk of res.body) {
    total += chunk.length
    if (total > limit) throw new RangeError(`la descarga supera el límite de ${limit} bytes`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total)
}

const mediaUrl = (message) => {
  if (message.directPath) {
    if (typeof message.directPath !== 'string' || !message.directPath.startsWith('/')) throw new TypeError('directPath de media inválido')
    return `https://mmg.whatsapp.net${message.directPath}`
  }
  const url = new URL(message.url)
  if (url.protocol !== 'https:' || !ALLOWED_MEDIA_HOSTS.has(url.hostname)) throw new Error('host de media no permitido')
  return url.href
}

const b64url = (buf) => encodeURIComponent(buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))

export default {
  sendImage(to, image, options = {}) { return this.sendMedia(to, { ...options, image }) },
  sendVideo(to, video, options = {}) { return this.sendMedia(to, { ...options, video }) },
  sendAudio(to, audio, options = {}) { return this.sendMedia(to, { ...options, audio }) },
  sendDocument(to, document, options = {}) { return this.sendMedia(to, { ...options, document }) },
  sendSticker(to, sticker, options = {}) { return this.sendMedia(to, { ...options, sticker }) },

  async sendAlbum(to, items, options = {}) {
    if (!Array.isArray(items) || items.length < 2 || items.length > 30) throw new RangeError('album requiere entre 2 y 30 elementos')
    if (items.some((item) => !item || (!item.image && !item.video) || (item.image && item.video))) throw new TypeError('cada elemento del album debe tener image o video')
    const chat = normalizeJid(to, S)
    const counts = items.reduce((acc, item) => { acc[item.image ? 'image' : 'video']++; return acc }, { image: 0, video: 0 })
    const caption = options.caption || options.text || ''

    const parentKey = { remoteJid: chat, fromMe: true, id: options.messageId || genId() }
    const parentMessage = buildMessage(
      { albumMessage: { expectedImageCount: counts.image, expectedVideoCount: counts.video } },
      { ...options, quoted: options.quoted }
    )
    const parent = await this.deliver(chat, parentMessage, { id: parentKey.id, waitAck: options.waitAck })

    const sent = [parent]
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      sent.push(await this.sendMedia(chat, {
        ...options,
        ...item,
        quoted: item.quoted || options.quoted,
        caption: item.caption ?? (i === 0 ? caption : undefined),
        messageContextInfo: {
          ...(item.messageContextInfo || {}),
          messageAssociation: { associationType: 1, parentMessageKey: parentKey, messageIndex: i }
        }
      }))
    }
    return { messages: sent, key: { ...parentKey }, expectedImageCount: counts.image, expectedVideoCount: counts.video }
  },

  async sendStickerPack(to, options = {}) {
    const source = options.pack || options.file || options.archive
    if (!source) throw new TypeError('sendStickerPack requiere pack/file/archive')
    const pack = await toBuffer(source, this.maxMediaBytes)
    const metadata = stickerPack(options).stickerPackMessage
    const up = await this.uploadMedia(pack, 'sticker')
    const body = {
      ...metadata,
      fileLength: up.fileLength,
      fileSha256: up.fileSha256,
      fileEncSha256: up.fileEncSha256,
      mediaKey: up.mediaKey,
      directPath: up.directPath,
      mediaKeyTimestamp: Math.floor(Date.now() / 1000),
      stickerPackSize: up.fileLength
    }
    const message = buildMessage({ stickerPackMessage: body }, options)
    return this.deliver(normalizeJid(to, S), message, { mediaType: 'sticker' })
  },

  async mediaConn() {
    if (this.mediaConnCache && Date.now() < this.mediaConnCache.expires) return this.mediaConnCache
    const res = await this.query({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:m', to: S }, content: [{ tag: 'media_conn', attrs: {} }] })
    const mc = getChild(res, 'media_conn')
    this.mediaConnCache = {
      auth: mc.attrs.auth,
      hosts: getChildren(mc, 'host').map((h) => h.attrs.hostname),
      expires: Date.now() + (+mc.attrs.ttl || 300) * 1000 - 5000
    }
    return this.mediaConnCache
  },

  async uploadMedia(buffer, type) {
    assertMediaSize(buffer, this.maxMediaBytes)
    const enc = encryptMedia(buffer, type)
    const conn = await this.mediaConn()
    const token = b64url(enc.fileEncSha256)
    let lastError
    for (const host of conn.hosts) {
      if (!isAllowedUploadHost(host)) continue
      try {
        const res = await fetch(`https://${host}${PATH[type]}/${token}?auth=${conn.auth}&token=${token}`, {
          method: 'POST',
          body: enc.body,
          headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://web.whatsapp.com' }
        })
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) this.mediaConnCache = null
          lastError = new Error(`el host ${host} respondió ${res.status}`)
          continue
        }
        const json = await res.json()
        if (json.url) return { ...enc, url: json.url, directPath: json.direct_path }
      } catch (e) {
        lastError = e
      }
    }
    throw new Error(`no se pudo subir el media${lastError ? `: ${lastError.message}` : ''}`, { cause: lastError })
  },

  async uploadMediaFile(filePath, type) {
    const { size } = await fs.promises.stat(filePath)
    if (size > this.maxFileBytes) throw new RangeError(`el archivo supera el límite de ${this.maxFileBytes} bytes`)
    const encPath = path.join(os.tmpdir(), `zyrix-${randomUUID()}.enc`)
    try {
      const enc = await encryptMediaFile(filePath, encPath, type)
      const { size: encSize } = await fs.promises.stat(encPath)
      const conn = await this.mediaConn()
      const token = b64url(enc.fileEncSha256)
      let lastError
      for (const host of conn.hosts) {
        if (!isAllowedUploadHost(host)) continue
        try {
          const res = await postFile(host, `${PATH[type]}/${token}?auth=${conn.auth}&token=${token}`, encPath, encSize)
          if (res.status < 200 || res.status >= 300) {
            if (res.status === 401 || res.status === 403) this.mediaConnCache = null
            lastError = new Error(`el host ${host} respondió ${res.status}`)
            continue
          }
          const json = JSON.parse(res.body)
          if (json.url) return { ...enc, url: json.url, directPath: json.direct_path }
        } catch (e) {
          lastError = e
        }
      }
      throw new Error(`no se pudo subir el media${lastError ? `: ${lastError.message}` : ''}`, { cause: lastError })
    } finally {
      await fs.promises.rm(encPath, { force: true }).catch(() => {})
    }
  },

  async uploadEncryptedMedia(input, { fileEncSha256B64, mediaType } = {}) {
    if (typeof fileEncSha256B64 !== 'string' || !fileEncSha256B64) throw new TypeError('fileEncSha256B64 es obligatorio')
    if (!PATH[mediaType]) throw new TypeError(`mediaType no soportado: ${String(mediaType)}`)
    const body = await toBuffer(input, this.maxMediaBytes + 64)
    const conn = await this.mediaConn()
    const token = b64url(Buffer.from(fileEncSha256B64, 'base64'))
    let lastError
    for (const host of conn.hosts) {
      if (!isAllowedUploadHost(host)) continue
      try {
        const res = await fetch(`https://${host}${PATH[mediaType]}/${token}?auth=${conn.auth}&token=${token}`, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://web.whatsapp.com' }
        })
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) this.mediaConnCache = null
          lastError = new Error(`el host ${host} respondió ${res.status}`)
          continue
        }
        const json = await res.json()
        if (json.url || json.direct_path) return { url: json.url, directPath: json.direct_path }
      } catch (e) {
        lastError = e
      }
    }
    throw new Error(`no se pudo subir el media cifrado${lastError ? `: ${lastError.message}` : ''}`, { cause: lastError })
  },

  async sendMedia(to, opts) {
    const type = TYPES.find((t) => opts[t])
    if (!type) throw new Error('falta image, video, audio, document o sticker')
    const localFile = localMediaPath(opts[type])
    const data = localFile ? await readHead(localFile) : await toBuffer(opts[type], this.maxMediaBytes)
    const up = localFile ? await this.uploadMediaFile(localFile, type) : await this.uploadMedia(data, type)
    const defaultMime = type === 'audio' && opts.ptt ? 'audio/ogg; codecs=opus' : MIME[type]
    const body = {
      url: up.url,
      directPath: up.directPath,
      mediaKey: up.mediaKey,
      mimetype: opts.mimetype || sniffMimeType(data, defaultMime) || defaultMime,
      fileEncSha256: up.fileEncSha256,
      fileSha256: up.fileSha256,
      fileLength: up.fileLength,
      mediaKeyTimestamp: Math.floor(Date.now() / 1000)
    }
    if (opts.caption && (type === 'image' || type === 'video' || type === 'document')) body.caption = opts.caption
    if (opts.thumbnail && type !== 'audio') body.jpegThumbnail = Buffer.from(opts.thumbnail)
    if (Number.isInteger(opts.width)) body.width = opts.width
    if (Number.isInteger(opts.height)) body.height = opts.height
    if (Number.isInteger(opts.seconds) && (type === 'audio' || type === 'video')) body.seconds = opts.seconds
    if (type === 'audio' && opts.waveform) body.waveform = Buffer.from(opts.waveform)
    if (type === 'video' && (opts.gif || opts.gifPlayback)) body.gifPlayback = true
    if (type === 'audio' && opts.ptt) body.ptt = true
    if (type === 'document') body.fileName = opts.fileName || 'archivo'
    const mediaType = type === 'video' && (opts.gif || opts.gifPlayback) ? 'gif' : type === 'audio' && opts.ptt ? 'ptt' : type
    const chat = normalizeJid(to, S)
    const message = buildMessage({ [`${type}Message`]: body }, opts)
    return this.deliver(chat, message, { mediaType, id: opts.messageId, waitAck: opts.waitAck })
  },

  async downloadMedia(input, mediaType) {
    const message = unwrapMessage(input && input.message ? input.message : input) || {}
    const type = message.stickerPackMessage
      ? 'sticker'
      : TYPES.find((t) => message[`${t}Message`]) || (mediaType && TYPES.includes(mediaType) && (message.mediaKey || message.directPath || message.url) ? mediaType : undefined)
    if (!type) throw new Error('el mensaje no tiene media')
    const m = message.stickerPackMessage || message[`${type}Message`] || message
    const url = mediaUrl(m)
    const res = await fetch(url, { headers: { Origin: 'https://web.whatsapp.com' } })
    if (!res.ok) throw new Error('descarga fallida ' + res.status)
    return decryptMedia(await readResponse(res, this.maxMediaBytes + 26), m.mediaKey, type)
  }
}
