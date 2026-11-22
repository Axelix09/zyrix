import crypto from 'crypto'
import fs from 'fs'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { proto } from './proto.js'
import { ZyrixError, ErrorKind } from './errors.js'

const S_WHATSAPP_NET = 's.whatsapp.net'

const be = (n, len) => {
  const b = Buffer.alloc(len)
  for (let i = len - 1; i >= 0; i--) {
    b[i] = n & 255
    n = Math.floor(n / 256)
  }
  return b
}

const readBE = (buf) => buf.reduce((a, b) => a * 256 + b, 0)
const genId = () => '3EB0' + crypto.randomBytes(9).toString('hex').toUpperCase()

const pad = (buf) => {
  let n = crypto.randomBytes(1)[0] & 15
  if (!n) n = 15
  return Buffer.concat([buf, Buffer.alloc(n, n)])
}

const unpad = (buf) => buf.subarray(0, buf.length - buf[buf.length - 1])

const num = (v) => (v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v || 0))

const encodeAccount = (account, includeKey) => {
  const a = { ...account }
  if (!includeKey) a.accountSignatureKey = null
  return Buffer.from(proto.ADVSignedDeviceIdentity.encode(a).finish())
}


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class TTLCache {
  constructor({ max = 1000, ttl = 0 } = {}) {
    this.max = max
    this.ttl = ttl
    this.map = new Map()
  }

  get(key) {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (entry.exp && entry.exp < Date.now()) {
      this.map.delete(key)
      return undefined
    }
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  has(key) {
    return this.get(key) !== undefined
  }

  set(key, value) {
    this.map.delete(key)
    this.map.set(key, { value, exp: this.ttl ? Date.now() + this.ttl : 0 })
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
    return this
  }

  delete(key) {
    return this.map.delete(key)
  }

  clear() {
    this.map.clear()
  }

  get size() {
    return this.map.size
  }
}

const jsonReplacer = function (key, value) {
  const raw = this[key]
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return { type: 'Buffer', data: Buffer.from(raw).toString('base64') }
  return value
}

const jsonReviver = (_, value) => {
  if (value && value.type === 'Buffer' && typeof value.data === 'string') return Buffer.from(value.data, 'base64')
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data)
  return value
}

const readStreamLimited = async (stream, limit) => {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (total > limit) throw new RangeError(`media exceeds the ${limit}-byte limit`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total)
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// En un redirect a otro origen solo viaja lo que no identifica al usuario ni transporta
// credenciales. Host, Authorization, Cookie, Proxy-Authorization y cualquier x-* se caen.
const CROSS_ORIGIN_REDIRECT_HEADERS = new Set(['user-agent', 'accept', 'accept-encoding', 'accept-language', 'range', 'if-none-match', 'if-modified-since'])
const redirectHeaders = (headers, sameOrigin) => {
  if (sameOrigin) return headers
  return Object.fromEntries(Object.entries(headers).filter(([name]) => CROSS_ORIGIN_REDIRECT_HEADERS.has(name.toLowerCase())))
}

const DATA_URL = /^data:([^;,]+)?(;base64)?,/i

const decodeDataUrl = (value) => {
  const match = DATA_URL.exec(value)
  if (!match) throw new TypeError('invalid data URL')
  const payload = value.slice(match[0].length)
  return match[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'binary')
}

const sniffMimeType = (buffer, fallback = undefined) => {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length < 4) return fallback
  const b = buffer
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12)
    if (brand.startsWith('qt')) return 'video/quicktime'
    if (b.toString('ascii', 4, 12).includes('webm')) return 'video/webm'
    return 'video/mp4'
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'
  if (b.length > 8 && b.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg'
  if (b.toString('ascii', 4, 8) === 'ftyp' && b.length > 12 && b.toString('ascii', 8, 11) === 'M4A') return 'audio/mp4'
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg'
  if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'
  return fallback
}

const isPrivateV4 = (ip) => {
  const a = ip.split('.').map(Number)
  return a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
    (a[0] === 169 && a[1] === 254) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
    (a[0] === 192 && (a[1] === 0 || a[1] === 2 || a[1] === 168 || (a[1] === 88 && a[2] === 99))) ||
    (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
    (a[0] === 198 && (a[1] === 18 || a[1] === 19 || a[1] === 51 && a[2] === 100)) ||
    (a[0] === 203 && a[1] === 0 && a[2] === 113)
}
const isPublicAddress = (ip) => {
  const family = net.isIP(ip)
  if (family === 4) return !isPrivateV4(ip)
  if (family !== 6) return false
  const normalized = ip.toLowerCase().split('%')[0]
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPublicAddress(mapped[1])
  // Solo direcciones IPv6 globales unicast; descarta loopback, ULA, link-local y rangos especiales.
  return /^2|^3/.test(normalized) && !normalized.startsWith('2001:db8:')
}
const assertMediaUrlShape = (value) => {
  const url = value instanceof URL ? value : new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['', '80', '443'].includes(url.port)) {
    throw new ZyrixError('media URL not allowed: only public HTTP(S) on ports 80/443', { kind: ErrorKind.MEDIA, errorCode: 'MEDIA_URL_BLOCKED' })
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test')) {
    throw new ZyrixError('media URL not allowed: local host', { kind: ErrorKind.MEDIA, errorCode: 'MEDIA_URL_BLOCKED' })
  }
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new ZyrixError('media URL not allowed: the host does not resolve exclusively to public IPs', { kind: ErrorKind.MEDIA, errorCode: 'MEDIA_URL_BLOCKED' })
  }
  return url
}

// Resuelve el host y valida TODAS las direcciones dentro del propio lookup del socket.
// Así la IP que se valida es exactamente la IP a la que se conecta (sin ventana de DNS rebinding).
const publicOnlyLookup = (hostname, options, callback) => {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }]
    if (!list.length || list.some(({ address }) => !isPublicAddress(address))) {
      return callback(new ZyrixError('media URL not allowed: the host does not resolve exclusively to public IPs', { kind: ErrorKind.MEDIA, errorCode: 'MEDIA_URL_BLOCKED' }))
    }
    if (options && options.all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

const assertPublicMediaUrl = async (value) => {
  const url = assertMediaUrlShape(value)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!net.isIP(host)) {
    await new Promise((resolve, reject) => publicOnlyLookup(host, { all: true }, (err) => (err ? reject(err) : resolve())))
  }
  return url
}

const pinnedGet = (url, headers, timeout) => new Promise((resolve, reject) => {
  const client = url.protocol === 'https:' ? https : http
  const req = client.request(url, { method: 'GET', headers, lookup: publicOnlyLookup, agent: false, signal: AbortSignal.timeout(timeout) }, resolve)
  req.on('error', reject)
  req.end()
})

const fetchToBuffer = async (url, { limit = Infinity, timeout = 30000, headers = {} } = {}) => {
  let current = await assertPublicMediaUrl(url)
  let requestHeaders = { 'user-agent': BROWSER_UA, accept: '*/*', ...headers }
  for (let redirects = 0; redirects <= 5; redirects++) {
    assertMediaUrlShape(current)
    const res = await pinnedGet(current, requestHeaders, timeout)
    const status = res.statusCode || 0
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = res.headers.location
      res.resume()
      if (!location || redirects === 5) throw new ZyrixError('invalid or too long media redirect', { kind: ErrorKind.MEDIA, errorCode: 'MEDIA_REDIRECT_INVALID' })
      const next = new URL(location, current)
      requestHeaders = redirectHeaders(requestHeaders, next.origin === current.origin)
      current = next
      continue
    }
    if (status < 200 || status >= 300) {
      res.resume()
      throw new ZyrixError(`download failed ${status}${res.statusMessage ? ` ${res.statusMessage}` : ''}`, { kind: ErrorKind.MEDIA, errorCode: 'MEDIA_DOWNLOAD_FAILED', code: status })
    }
    const declared = Number(res.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      res.destroy()
      throw new RangeError(`media exceeds the ${limit}-byte limit`)
    }
    try {
      return await readStreamLimited(res, limit)
    } catch (err) {
      res.destroy()
      throw err
    }
  }
  throw new ZyrixError('too many redirects downloading media', { kind: ErrorKind.MEDIA, errorCode: 'MEDIA_REDIRECT_INVALID' })
}

const toBuffer = async (input, limit = Infinity) => {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (input.length > limit) throw new RangeError(`media exceeds the ${limit}-byte limit`)
    return Buffer.from(input)
  }
  if (typeof input === 'string') {
    if (/^https?:\/\//i.test(input)) input = { url: input }
    else if (DATA_URL.test(input)) input = { data: input }
    else input = { path: input }
  }
  if (input && typeof input === 'object') {
    if (typeof input.url === 'string') {
      if (/^https?:\/\//i.test(input.url)) {
        return fetchToBuffer(input.url, { limit, timeout: input.timeout || 30000, headers: input.headers || {} })
      }
      if (DATA_URL.test(input.url)) {
        const buffer = decodeDataUrl(input.url)
        if (buffer.length > limit) throw new RangeError(`media exceeds the ${limit}-byte limit`)
        return buffer
      }
      const localStat = await fs.promises.stat(input.url)
      if (localStat.size > limit) throw new RangeError(`media exceeds the ${limit}-byte limit`)
      return fs.promises.readFile(input.url)
    }
    if (typeof input.data === 'string') {
      const buffer = DATA_URL.test(input.data) ? decodeDataUrl(input.data) : Buffer.from(input.data, 'base64')
      if (buffer.length > limit) throw new RangeError(`media exceeds the ${limit}-byte limit`)
      return buffer
    }
    if (typeof input.path === 'string') {
      const stat = await fs.promises.stat(input.path)
      if (stat.size > limit) throw new RangeError(`media exceeds the ${limit}-byte limit`)
      return fs.promises.readFile(input.path)
    }
    if (input.stream && typeof input.stream[Symbol.asyncIterator] === 'function') return readStreamLimited(input.stream, limit)
  }
  throw new TypeError('media must be a Buffer, Uint8Array, path, URL, { url }, { path } or { stream }')
}

const noop = () => {}

const makeLogger = (option) => {
  const levels = ['trace', 'debug', 'info', 'warn', 'error']
  if (!option) return Object.fromEntries(levels.map((level) => [level, noop]))
  const base = option === true ? console : option
  return Object.fromEntries(
    levels.map((level) => {
      const fn = base[level] || (level === 'trace' || level === 'debug' ? base.log : undefined) || base.log
      return [level, typeof fn === 'function' ? fn.bind(base) : noop]
    })
  )
}

export { S_WHATSAPP_NET, be, readBE, genId, pad, unpad, num, encodeAccount, sleep, TTLCache, jsonReplacer, jsonReviver, toBuffer, makeLogger }
export { toBuffer as toBufferFetcher, sniffMimeType, BROWSER_UA, assertPublicMediaUrl, publicOnlyLookup, isPublicAddress, redirectHeaders }
