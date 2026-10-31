import zlib from 'zlib'
import { SINGLE_BYTE_TOKENS, DOUBLE_BYTE_TOKENS } from './constants.js'

const T = {
  LIST_EMPTY: 0,
  DICTIONARY_0: 236,
  INTEROP_JID: 245,
  FB_JID: 246,
  AD_JID: 247,
  LIST_8: 248,
  LIST_16: 249,
  JID_PAIR: 250,
  HEX_8: 251,
  BINARY_8: 252,
  BINARY_20: 253,
  BINARY_32: 254,
  NIBBLE_8: 255
}

const TOKEN_MAP = new Map()
SINGLE_BYTE_TOKENS.forEach((tok, i) => {
  if (tok) TOKEN_MAP.set(tok, { index: i })
})
DOUBLE_BYTE_TOKENS.forEach((dict, d) => dict.forEach((tok, i) => TOKEN_MAP.set(tok, { dict: d, index: i })))

const jidEncode = (user, server, device) => `${user || ''}${device ? `:${device}` : ''}@${server}`

const jidDecode = (jid) => {
  const at = typeof jid === 'string' ? jid.indexOf('@') : -1
  if (at <= 0 || at !== jid.lastIndexOf('@') || at === jid.length - 1) return undefined
  const server = jid.slice(at + 1)
  const [userAgent, device] = jid.slice(0, at).split(':')
  if (!userAgent || (device !== undefined && !/^\d{1,3}$/.test(device))) return undefined
  const user = userAgent.split('_')[0]
  if (!user) return undefined
  const domainType = server === 'lid' ? 1 : server === 'hosted' ? 128 : server === 'hosted.lid' ? 129 : 0
  return { server, user, domainType, device: device ? +device : undefined }
}

const isJidGroup = (jid) => typeof jid === 'string' && jid.endsWith('@g.us')

const getChildren = (node, tag) => (node && Array.isArray(node.content) ? node.content.filter((c) => c.tag === tag) : [])
const getChild = (node, tag) => getChildren(node, tag)[0]

const isNibble = (s) => s.length < 128 && /^[0-9.-]+$/.test(s)
const isHex = (s) => s.length < 128 && /^[0-9A-F]+$/.test(s)

const packNibble = (c) => {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48
  if (c === '-') return 10
  if (c === '.') return 11
  return 15
}

const packHex = (c) => {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48
  if (c >= 'A' && c <= 'F') return 10 + c.charCodeAt(0) - 65
  return 15
}

const unpackNibble = (v) => (v < 10 ? String(v) : v === 10 ? '-' : v === 11 ? '.' : v === 15 ? '\0' : null)
const unpackHex = (v) => (v < 10 ? String(v) : v < 16 ? String.fromCharCode(55 + v) : null)

function encodeNode(node) {
  const out = [0]
  const pushByte = (b) => out.push(b & 255)
  const pushBytes = (bytes) => {
    for (const b of bytes) out.push(b)
  }
  const pushInt = (v, n) => {
    for (let i = n - 1; i >= 0; i--) pushByte(v >> (i * 8))
  }

  const writeByteLength = (len) => {
    if (len >= 1 << 20) {
      pushByte(T.BINARY_32)
      pushInt(len, 4)
    } else if (len >= 256) {
      pushByte(T.BINARY_20)
      pushBytes([(len >> 16) & 15, (len >> 8) & 255, len & 255])
    } else {
      pushByte(T.BINARY_8)
      pushByte(len)
    }
  }

  const writeListStart = (n) => {
    if (n === 0) pushByte(T.LIST_EMPTY)
    else if (n < 256) {
      pushByte(T.LIST_8)
      pushByte(n)
    } else {
      pushByte(T.LIST_16)
      pushInt(n, 2)
    }
  }

  const writePacked = (str, type) => {
    pushByte(type === 'nibble' ? T.NIBBLE_8 : T.HEX_8)
    let rounded = Math.ceil(str.length / 2)
    if (str.length % 2) rounded |= 128
    pushByte(rounded)
    const pack = type === 'nibble' ? packNibble : packHex
    const pad = str.length % 2 ? str + '\0' : str
    for (let i = 0; i < pad.length; i += 2) pushByte((pack(pad[i]) << 4) | pack(pad[i + 1]))
  }

  const writeStringRaw = (str) => {
    const bytes = Buffer.from(str, 'utf8')
    writeByteLength(bytes.length)
    pushBytes(bytes)
  }

  const writeJid = ({ user, server, device, domainType }) => {
    if (device !== undefined) {
      pushByte(T.AD_JID)
      pushByte(domainType || 0)
      pushByte(device || 0)
      writeString(user)
    } else {
      pushByte(T.JID_PAIR)
      if (user.length) writeString(user)
      else pushByte(T.LIST_EMPTY)
      writeString(server)
    }
  }

  function writeString(str) {
    const token = TOKEN_MAP.get(str)
    if (token) {
      if (typeof token.dict === 'number') pushByte(T.DICTIONARY_0 + token.dict)
      pushByte(token.index)
    } else if (isNibble(str)) writePacked(str, 'nibble')
    else if (isHex(str)) writePacked(str, 'hex')
    else if (str) {
      const jid = jidDecode(str)
      if (jid) writeJid(jid)
      else writeStringRaw(str)
    } else writeByteLength(0)
  }

  function writeNode({ tag, attrs, content }) {
    const a = attrs || {}
    const keys = Object.keys(a).filter((k) => a[k] !== undefined && a[k] !== null)
    writeListStart(2 * keys.length + 1 + (content !== undefined ? 1 : 0))
    writeString(tag)
    for (const k of keys) {
      writeString(k)
      writeString(String(a[k]))
    }
    if (typeof content === 'string') writeString(content)
    else if (content instanceof Uint8Array) {
      writeByteLength(content.length)
      pushBytes(content)
    } else if (Array.isArray(content)) {
      const items = content.filter(Boolean)
      writeListStart(items.length)
      items.forEach(writeNode)
    } else if (content !== undefined && content !== null) throw new Error('contenido invalido')
  }

  writeNode(node)
  return Buffer.from(out)
}

function decodeNode(buffer) {
  const data = buffer[0] & 2 ? zlib.inflateSync(buffer.subarray(1)) : buffer.subarray(1)
  let i = 0

  const need = (n) => {
    if (i + n > data.length) throw new Error('fin de buffer')
  }
  const readByte = () => {
    need(1)
    return data[i++]
  }
  const readBytes = (n) => {
    need(n)
    const b = data.subarray(i, i + n)
    i += n
    return Buffer.from(b)
  }
  const readInt = (n) => {
    let v = 0
    for (let k = 0; k < n; k++) v = v * 256 + readByte()
    return v
  }
  const readByteLength = (tag) => {
    if (tag === T.BINARY_8) return readByte()
    if (tag === T.BINARY_20) return ((readByte() & 15) << 16) + (readByte() << 8) + readByte()
    return readInt(4)
  }
  const readPacked = (tag) => {
    const start = readByte()
    const unpack = tag === T.NIBBLE_8 ? unpackNibble : unpackHex
    let value = ''
    for (let k = 0; k < (start & 127); k++) {
      const cur = readByte()
      value += unpack((cur & 0xf0) >> 4) + unpack(cur & 0x0f)
    }
    return start >> 7 ? value.slice(0, -1) : value
  }
  const readListSize = (tag) => {
    if (tag === T.LIST_EMPTY) return 0
    if (tag === T.LIST_8) return readByte()
    if (tag === T.LIST_16) return readInt(2)
    throw new Error('tag de lista invalido ' + tag)
  }

  function readString(tag) {
    if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) return SINGLE_BYTE_TOKENS[tag]
    switch (tag) {
      case 236:
      case 237:
      case 238:
      case 239: {
        const dict = tag - T.DICTIONARY_0
        const idx = readByte()
        return DOUBLE_BYTE_TOKENS[dict][idx]
      }
      case T.LIST_EMPTY:
        return ''
      case T.BINARY_8:
      case T.BINARY_20:
      case T.BINARY_32:
        return readBytes(readByteLength(tag)).toString('utf8')
      case T.JID_PAIR: {
        const u = readString(readByte())
        const s = readString(readByte())
        if (!s) throw new Error('jid invalido')
        return (u || '') + '@' + s
      }
      case T.AD_JID: {
        const domainType = readByte()
        const device = readByte()
        const user = readString(readByte())
        const server = domainType === 1 ? 'lid' : domainType === 128 ? 'hosted' : domainType === 129 ? 'hosted.lid' : 's.whatsapp.net'
        return jidEncode(user, server, device)
      }
      case T.HEX_8:
      case T.NIBBLE_8:
        return readPacked(tag)
      default:
        throw new Error('tag no soportado ' + tag)
    }
  }

  const isList = (t) => t === T.LIST_EMPTY || t === T.LIST_8 || t === T.LIST_16

  function readNode() {
    const size = readListSize(readByte())
    const tag = readString(readByte())
    if (!size || !tag) throw new Error('nodo invalido')
    const attrs = {}
    for (let n = (size - 1) >> 1; n > 0; n--) {
      const k = readString(readByte())
      attrs[k] = readString(readByte())
    }
    let content
    if (size % 2 === 0) {
      const t = readByte()
      if (isList(t)) {
        const len = readListSize(t)
        content = []
        for (let n = 0; n < len; n++) content.push(readNode())
      } else if (t === T.BINARY_8 || t === T.BINARY_20 || t === T.BINARY_32) content = readBytes(readByteLength(t))
      else content = readString(t)
    }
    return { tag, attrs, content }
  }

  return readNode()
}

export { encodeNode, decodeNode, getChild, getChildren, jidDecode, jidEncode, isJidGroup }
