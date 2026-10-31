import { jidDecode, jidEncode, isJidGroup } from './binary.js'

const PN_SERVERS = new Set(['s.whatsapp.net', 'c.us', 'hosted'])
const LID_SERVERS = new Set(['lid', 'hosted.lid'])

const decodeRequired = (value) => {
  const jid = normalizeJid(value)
  const decoded = jidDecode(jid)
  if (!decoded) throw new TypeError(`JID inválido: ${String(value)}`)
  return decoded
}

const jidNormalizedUser = (value) => {
  const d = decodeRequired(value)
  return jidEncode(d.user, d.server)
}

const normalizeJid = (value, defaultServer = 's.whatsapp.net') => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value)
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('se esperaba un JID o identificador no vacío')
  const trimmed = value.trim()
  if (trimmed.includes('@')) return trimmed
  if (!/^\d+$/.test(trimmed)) throw new TypeError(`identificador sin servidor inválido: ${value}`)
  return `${trimmed}@${defaultServer}`
}

const jidWithoutDevice = (value) => jidNormalizedUser(value)
const isJidUser = (value) => {
  const d = typeof value === 'string' ? jidDecode(value) : undefined
  return Boolean(d && (PN_SERVERS.has(d.server) || LID_SERVERS.has(d.server)))
}
const isJidLid = (value) => {
  const d = typeof value === 'string' ? jidDecode(value) : undefined
  return Boolean(d && LID_SERVERS.has(d.server))
}
const isJidPN = (value) => {
  const d = typeof value === 'string' ? jidDecode(value) : undefined
  return Boolean(d && PN_SERVERS.has(d.server))
}
const jidType = (value) => {
  const d = decodeRequired(value)
  if (isJidGroup(value)) return 'group'
  if (isJidLid(value)) return 'lid'
  if (isJidPN(value)) return 'pn'
  if (d.server === 'broadcast') return 'broadcast'
  if (d.server === 'newsletter') return 'newsletter'
  if (d.server === 'status') return 'status'
  return 'other'
}

const sameUser = (a, b, mapping = new Map()) => {
  const left = jidNormalizedUser(a)
  const right = jidNormalizedUser(b)
  if (left === right) return true
  return mapping.get(left) === right || mapping.get(right) === left
}

const identityCache = new WeakMap()

const makeIdentityMap = (state) => {
  state.keys.jidMapping ||= {}
  const cached = identityCache.get(state.keys.jidMapping)
  if (cached) return cached
  const map = new Map(Object.entries(state.keys.jidMapping))
  const remember = (first, second) => {
    if (!first || !second) return
    const a = jidNormalizedUser(first)
    const b = jidNormalizedUser(second)
    if (a === b) return
    map.set(a, b)
    map.set(b, a)
    state.keys.jidMapping[a] = b
    state.keys.jidMapping[b] = a
  }
  const identities = { map, remember }
  identityCache.set(state.keys.jidMapping, identities)
  return identities
}

export {
  jidDecode,
  jidEncode,
  normalizeJid,
  jidNormalizedUser,
  jidWithoutDevice,
  jidType,
  isJidUser,
  isJidLid,
  isJidPN,
  isJidGroup,
  sameUser,
  makeIdentityMap
}
