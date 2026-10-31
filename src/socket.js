import { EventEmitter } from 'events'
import crypto from 'crypto'
import qrcode from 'qrcode-terminal'
import { proto } from './proto.js'
import { Transport } from './transport.js'
import { Noise } from './noise.js'
import { Curve, md5, hmacSha256 } from './crypto.js'
import { encodeNode, decodeNode, getChild, getChildren, jidDecode } from './binary.js'
import { S_WHATSAPP_NET, be, encodeAccount, TTLCache, makeLogger } from './util.js'
import { DisconnectReason, isTerminalReason } from './reasons.js'
import messages from './messages.js'
import media from './media.js'
import business from './business.js'
import appstate from './appstate.js'
import pairing from './pairing.js'
import features from './features.js'
import { socketMethods } from './content.js'
import { socketMixin } from './context.js'
import { defineNamespaces } from './namespaces.js'
import { ZyrixError, ErrorKind } from './errors.js'

const FALLBACK_VERSION = [2, 3000, 1043857760]

const fetchVersion = async () => {
  try {
    const res = await fetch('https://web.whatsapp.com/sw.js', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) })
    const m = (await res.text()).match(/\\?"client_revision\\?":\s*(\d+)/)
    if (m) return [2, 3000, +m[1]]
  } catch {}
  return FALLBACK_VERSION
}

const ackAttrs = (node) => {
  const a = { id: node.attrs.id, to: node.attrs.from, class: node.tag }
  if (node.attrs.type) a.type = node.attrs.type
  if (node.attrs.participant) a.participant = node.attrs.participant
  return a
}

const nonNegative = (value, name) => {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} debe ser un número no negativo`)
}

class Socket extends EventEmitter {
  constructor({
    auth,
    version,
    browser = ['Mac OS', 'Chrome', '4.0.0'],
    printQR = true,
    phoneNumber,
    maxMediaBytes = 100 * 1024 * 1024,
    maxFileBytes = 2 * 1024 * 1024 * 1024,
    logger,
    getMessage,
    autoRejectCalls = false,
    markOnlineOnConnect = true,
    syncFullHistory = false,
    minSendIntervalMs = 0,
    keepAliveIntervalMs = 25000,
    trustPolicy = 'update',
    reconnect = true,
    maxReconnectAttempts = Infinity,
    sentCacheSize = 500,
    groupCacheSize = 500,
    queryTimeoutMs = 60000
  } = {}) {
    super({ captureRejections: true })
    if (!auth || !auth.state || !auth.state.creds || !auth.state.keys || typeof auth.save !== 'function') {
      throw new TypeError('auth debe incluir state.creds, state.keys y una función save()')
    }
    if (version && (!Array.isArray(version) || version.length !== 3 || version.some((n) => !Number.isInteger(n) || n < 0))) {
      throw new TypeError('version debe ser un arreglo de tres enteros no negativos')
    }
    if (!Number.isSafeInteger(maxMediaBytes) || maxMediaBytes < 1) throw new TypeError('maxMediaBytes debe ser un entero positivo')
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new TypeError('maxFileBytes debe ser un entero positivo')
    if (!Array.isArray(browser) || browser.length < 2) throw new TypeError('browser debe ser [sistema, navegador, versión]')
    if (getMessage !== undefined && typeof getMessage !== 'function') throw new TypeError('getMessage debe ser una función')
    if (!['update', 'tofu'].includes(trustPolicy) && typeof trustPolicy !== 'function') throw new TypeError("trustPolicy debe ser 'update', 'tofu' o una función")
    nonNegative(minSendIntervalMs, 'minSendIntervalMs')
    nonNegative(keepAliveIntervalMs, 'keepAliveIntervalMs')
    nonNegative(queryTimeoutMs, 'queryTimeoutMs')
    this.auth = auth
    this.version = version
    this.browser = browser
    this.printQR = printQR
    this.phoneNumber = phoneNumber
    this.maxMediaBytes = maxMediaBytes
    this.maxFileBytes = maxFileBytes
    this.logger = makeLogger(logger)
    this.getMessage = getMessage
    this.autoRejectCalls = autoRejectCalls
    this.markOnlineOnConnect = markOnlineOnConnect
    this.syncFullHistory = syncFullHistory
    this.minSendIntervalMs = minSendIntervalMs
    this.keepAliveIntervalMs = keepAliveIntervalMs
    this.reconnectEnabled = reconnect
    this.maxReconnectAttempts = maxReconnectAttempts
    this.queryTimeoutMs = queryTimeoutMs
    this.signalHooks = { trustPolicy, onIdentityChange: (info) => this.emit('identity.changed', info) }
    this.pending = new Map()
    this.closing = false
    this.pairingMode = false
    this.pairingReady = false
    this.queue = Promise.resolve()
    this.rqueue = Promise.resolve()
    this.counter = 0
    this.prefix = crypto.randomBytes(3).toString('hex')
    this.deviceCache = new TTLCache({ max: 5000, ttl: 3600000 })
    this.groupCache = new TTLCache({ max: groupCacheSize, ttl: 300000 })
    this.sentCache = new TTLCache({ max: sentCacheSize, ttl: 3600000 })
    this.retries = new TTLCache({ max: 1000, ttl: 600000 })
    this.seen = new TTLCache({ max: 5000, ttl: 600000 })
    this.reconnectAttempt = 0
    this.reconnectTimer = null
    this.started = false
    this.lastSendAt = 0
    this.lastRecv = Date.now()
    this.pingFailures = 0
    this.pendingReason = undefined
    this.fastReconnect = false
    this.connectionState = { connection: 'close' }
    if (typeof auth.flush === 'function' && !auth.onSaveError) auth.onSaveError = (e) => this.emit('error', e)
    this.on('error', () => {})
    this.on('messages.upsert', (event) => this.emitDerived(event))
  }

  get isOpen() {
    return this.connectionState.connection === 'open'
  }

  // API de eventos y usuario de Zyrix.
  get ev() {
    return this
  }

  get user() {
    return this.auth.state.creds.me
  }

  get authState() {
    return this.auth
  }

  setConnection(patch) {
    Object.assign(this.connectionState, patch)
    this.emit('connection.update', patch)
  }

  flushAuth() {
    return Promise.resolve(typeof this.auth.flush === 'function' ? this.auth.flush() : undefined).catch((e) => this.emit('error', e))
  }

  async start() {
    if (this.started) return this
    this.started = true
    if (!this.version) this.version = await fetchVersion()
    if (this.closing) return this
    this.connect()
    return this
  }

  waitForOpen(timeout = 60000) {
    if (this.isOpen) return Promise.resolve(this)
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        this.off('open', onOpen)
        this.off('close', onClose)
      }
      const onOpen = () => {
        cleanup()
        resolve(this)
      }
      const onClose = (info) => {
        if (info && info.reconnecting === false) {
          cleanup()
          reject(new ZyrixError('la conexión se cerró sin posibilidad de reconexión', { kind: ErrorKind.CLOSED }))
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new ZyrixError('timeout esperando la conexión', { kind: ErrorKind.TIMEOUT }))
      }, timeout)
      this.on('open', onOpen)
      this.on('close', onClose)
    })
  }

  run(fn) {
    const p = this.queue.then(fn)
    this.queue = p.catch(() => {})
    return p
  }

  enqueue(fn) {
    const p = this.rqueue.then(fn)
    this.rqueue = p.catch(() => {})
    p.catch((e) => this.emit('error', e))
  }

  connect() {
    if (this.closing) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    clearInterval(this.keepAlive)
    this.handshakeDone = false
    this.restartingAfterPair = false
    this.noise = new Noise(Curve.generateKeyPair())
    const t = new Transport()
    this.transport = t
    this.setConnection({ connection: 'connecting' })
    t.on('open', () => t === this.transport && this.sendHello())
    t.on('frame', (f) => t === this.transport && this.onFrame(f))
    t.on('close', (code) => t === this.transport && this.onClose(code))
    t.on('error', (e) => t === this.transport && this.emit('error', e))
    t.connect()
  }

  sendHello() {
    const msg = proto.HandshakeMessage.encode({ clientHello: { ephemeral: this.noise.ephemeral.public } }).finish()
    this.transport.send(Buffer.from(msg))
  }

  sendUnifiedSession() {
    if (!this.handshakeDone) return
    const id = String((Date.now() + 3 * 86400000) % (7 * 86400000))
    this.sendNode({
      tag: 'ib',
      attrs: {},
      content: [{ tag: 'unified_session', attrs: { id } }]
    })
  }

  buildPayload() {
    const { creds } = this.auth.state
    const v = this.version
    const CP = proto.ClientPayload
    const android = String(this.browser[1]).toLowerCase().includes('android')
    const base = {
      connectType: CP.ConnectType.WIFI_UNKNOWN,
      connectReason: CP.ConnectReason.USER_ACTIVATED,
      userAgent: {
        appVersion: { primary: v[0], secondary: v[1], tertiary: v[2] },
        platform: android ? CP.UserAgent.Platform.ANDROID : CP.UserAgent.Platform.WEB,
        releaseChannel: CP.UserAgent.ReleaseChannel.RELEASE,
        osVersion: '0.1',
        device: 'Desktop',
        osBuildNumber: '0.1',
        localeLanguageIso6391: 'en',
        mnc: '000',
        mcc: '000',
        localeCountryIso31661Alpha2: 'US'
      },
      ...(android ? {} : { webInfo: { webSubPlatform: CP.WebInfo.WebSubPlatform.WEB_BROWSER } })
    }
    if (creds.me && creds.registered) {
      const { user, device } = jidDecode(creds.me.id)
      return { ...base, username: +user, device: device || 0, passive: true, pull: true, lidDbMigrated: false }
    }
    const deviceProps = proto.DeviceProps.encode({
      os: this.browser[0],
      platformType: String(this.browser[1]).toUpperCase().includes('ANDROID') ? proto.DeviceProps.PlatformType.ANDROID_PHONE : proto.DeviceProps.PlatformType.CHROME,
      requireFullSync: this.syncFullHistory,
      historySyncConfig: {
        storageQuotaMb: 10240,
        inlineInitialPayloadInE2EeMsg: true,
        supportCallLogHistory: false,
        supportBotUserAgentChatHistory: true,
        supportCagReactionsAndPolls: true,
        supportBizHostedMsg: true,
        supportRecentSyncChunkMessageCountTuning: true,
        supportHostedGroupMsg: true,
        supportFbidBotChatHistory: true,
        supportMessageAssociation: true,
        supportGroupHistory: false
      },
      version: { primary: 10, secondary: 15, tertiary: 7 }
    }).finish()
    return {
      ...base,
      passive: false,
      pull: false,
      devicePairingData: {
        buildHash: md5(v.join('.')),
        deviceProps: Buffer.from(deviceProps),
        eRegid: be(creds.registrationId, 4),
        eKeytype: Buffer.from([5]),
        eIdent: creds.signedIdentityKey.public,
        eSkeyId: be(creds.signedPreKey.keyId, 3),
        eSkeyVal: creds.signedPreKey.keyPair.public,
        eSkeySig: creds.signedPreKey.signature
      }
    }
  }

  async finishHandshake(frame) {
    const hs = proto.HandshakeMessage.decode(frame)
    const keyEnc = this.noise.processServerHello(hs.serverHello, this.auth.state.creds.noiseKey)
    const payload = this.noise.encrypt(Buffer.from(proto.ClientPayload.encode(this.buildPayload()).finish()))
    const msg = proto.HandshakeMessage.encode({ clientFinish: { static: keyEnc, payload } }).finish()
    this.transport.send(Buffer.from(msg))
    await this.noise.finish()
    this.handshakeDone = true
    this.emit('handshake')
  }

  onFrame(frame) {
    this.lastRecv = Date.now()
    let node
    try {
      if (!this.handshakeDone) {
        this.finishHandshake(frame).catch((e) => {
          this.emit('error', e)
          this.transport?.close()
        })
        return
      }
      node = decodeNode(this.noise.decrypt(frame))
    } catch (e) {
      this.emit('error', e)
      this.transport?.close()
      return
    }
    try {
      this.emit('node', node)
      this.onNode(node)
    } catch (e) {
      this.logger.error({ err: e, tag: node.tag }, 'error procesando nodo')
      this.emit('error', e)
    }
  }

  sendNode(node) {
    if (!this.handshakeDone) throw new ZyrixError('la sesión de Zyrix aún no está lista', { kind: ErrorKind.NOT_READY })
    this.transport.send(this.noise.encrypt(encodeNode(node)))
  }

  query(node, timeout = this.queryTimeoutMs) {
    if (!Number.isFinite(timeout) || timeout <= 0) return Promise.reject(new TypeError('timeout debe ser un número positivo'))
    node.attrs = node.attrs || {}
    node.attrs.id = node.attrs.id || `${this.prefix}-${++this.counter}`
    const id = node.attrs.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ZyrixError('timeout', { kind: ErrorKind.TIMEOUT }))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.sendNode(node)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  onNode(node) {
    const { id, from, type } = node.attrs
    const waiting = id ? this.pending.get(id) : undefined
    if (waiting && node.tag !== 'message' && (!waiting.tags || waiting.tags.has(node.tag))) {
      this.pending.delete(id)
      clearTimeout(waiting.timer)
      if (type === 'error' && node.tag !== 'ack') {
        const err = getChild(node, 'error')
        const code = err ? err.attrs.code : ''
        waiting.reject(new ZyrixError('error ' + code, { kind: ErrorKind.REJECTED, code: Number(code) || undefined }))
      } else waiting.resolve(node)
      if (node.tag === 'iq' && getChild(node, 'pair-success')) this.enqueue(() => this.onPairSuccess(node))
      return
    }
    switch (node.tag) {
      case 'iq':
        return this.onIq(node)
      case 'success':
        return this.enqueue(() => this.onSuccess(node))
      case 'failure':
        return this.onFailure(node)
      case 'stream:error':
        return this.onStreamError(node)
      case 'message':
        return this.enqueue(() => this.onMessage(node))
      case 'receipt':
        this.sendNode({ tag: 'ack', attrs: ackAttrs(node) })
        this.emit('receipt', { id, from, participant: node.attrs.participant, type: type || 'delivery' })
        if (type === 'retry') this.enqueue(() => this.onRetryReceipt(node))
        return
      case 'notification':
        return this.onNotification(node)
      case 'call':
        this.sendNode({ tag: 'ack', attrs: ackAttrs(node) })
        return this.onCall(node)
      case 'ib':
        return this.onIb(node)
      case 'presence':
        return this.onPresenceNode(node)
      case 'chatstate':
        return this.onChatState(node)
    }
  }

  onNotification(node) {
    this.sendNode({ tag: 'ack', attrs: ackAttrs(node) })
    const { type } = node.attrs
    if (getChild(node, 'link_code_companion_reg')) return this.enqueue(() => this.onLinkCode(node))
    switch (type) {
      case 'server_sync': {
        const names = getChildren(node, 'collection').map((c) => c.attrs.name)
        this.syncAppState(names.length ? names : undefined).catch((e) => this.emit('error', e))
        return
      }
      case 'w:gp2':
        return this.onGroupNotification(node)
      case 'devices':
        return this.onDevicesNotification(node)
      case 'encrypt':
        return this.onEncryptNotification(node)
    }
  }

  onIq(node) {
    if (getChild(node, 'pair-device')) return this.onPairDevice(node)
    if (getChild(node, 'pair-success')) {
      try {
        return this.onPairSuccess(node)
      } catch (e) {
        return this.emit('error', e)
      }
    }
    if (node.attrs.xmlns === 'urn:xmpp:ping') {
      return this.sendNode({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'result', id: node.attrs.id } })
    }
  }

  onPairDevice(node) {
    this.sendNode({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'result', id: node.attrs.id } })
    this.pairingReady = true
    const { creds } = this.auth.state
    if (this.phoneNumber && !creds.registered) {
      this.requestPairingCode(this.phoneNumber)
        .then((code) => this.emit('pairing-code', code))
        .catch((e) => this.emit('error', e))
      return
    }
    if (this.pairingMode) return
    const refs = getChildren(getChild(node, 'pair-device'), 'ref').map((r) => r.content.toString())
    this.runQR(refs, true)
  }

  runQR(refs, first) {
    const ref = refs.shift()
    if (!ref) {
      this.closing = true
      this.emit('close', { reason: 'qr-timeout', reconnecting: false })
      this.setConnection({ connection: 'close', lastDisconnect: { reason: 'qr-timeout', date: new Date() } })
      return this.transport.close()
    }
    const { creds } = this.auth.state
    const qr = [ref, creds.noiseKey.public.toString('base64'), creds.signedIdentityKey.public.toString('base64'), creds.advSecretKey].join(',')
    this.emit('qr', qr)
    this.setConnection({ qr })
    if (this.printQR) qrcode.generate(qr, { small: true })
    this.qrTimer = setTimeout(() => this.runQR(refs, false), first ? 60000 : 20000)
    this.qrTimer.unref?.()
  }

  onPairSuccess(node) {
    clearTimeout(this.qrTimer)
    const ps = getChild(node, 'pair-success')
    const identityNode = getChild(ps, 'device-identity')
    const deviceNode = getChild(ps, 'device')
    const bizNode = getChild(ps, 'biz')
    const { creds } = this.auth.state
    const hmac = proto.ADVSignedDeviceIdentityHMAC.decode(identityNode.content)
    const expected = hmacSha256(Buffer.from(hmac.details), Buffer.from(creds.advSecretKey, 'base64'))
    if (!expected.equals(Buffer.from(hmac.hmac))) throw new Error('hmac invalido')
    const account = proto.ADVSignedDeviceIdentity.decode(hmac.details)
    const details = Buffer.from(account.details)
    const accountKey = Buffer.from(account.accountSignatureKey)
    const accountMsg = Buffer.concat([Buffer.from([6, 0]), details, creds.signedIdentityKey.public])
    if (!Curve.verify(accountKey, accountMsg, account.accountSignature)) throw new Error('firma de cuenta invalida')
    const deviceMsg = Buffer.concat([Buffer.from([6, 1]), details, creds.signedIdentityKey.public, accountKey])
    account.deviceSignature = Curve.sign(creds.signedIdentityKey.private, deviceMsg)
    const deviceIdentity = proto.ADVDeviceIdentity.decode(details)
    creds.me = { id: deviceNode.attrs.jid, name: bizNode ? bizNode.attrs.name : undefined }
    creds.account = account
    creds.registered = true
    delete creds.pairingCode
    this.auth.save()
    this.flushAuth()
    this.setConnection({ isNewLogin: true })
    this.sendNode({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'result', id: node.attrs.id },
      content: [
        {
          tag: 'pair-device-sign',
          attrs: {},
          content: [{ tag: 'device-identity', attrs: { 'key-index': String(deviceIdentity.keyIndex) }, content: encodeAccount(account, false) }]
        }
      ]
    })
    this.sendUnifiedSession()
    const pairingTransport = this.transport
    this.restartingAfterPair = true
    setTimeout(() => {
      if (this.closing || this.transport !== pairingTransport) return
      this.fastReconnect = true
      pairingTransport?.close()
    }, 5000)
  }

  async uploadPreKeys(count) {
    const { creds, keys } = this.auth.state
    const list = []
    for (let i = 0; i < count; i++) {
      const id = creds.nextPreKeyId++
      const kp = Curve.generateKeyPair()
      keys.preKeys[id] = kp
      list.push({
        tag: 'key',
        attrs: {},
        content: [
          { tag: 'id', attrs: {}, content: be(id, 3) },
          { tag: 'value', attrs: {}, content: kp.public }
        ]
      })
    }
    this.auth.save()
    await this.query({
      tag: 'iq',
      attrs: { xmlns: 'encrypt', type: 'set', to: S_WHATSAPP_NET },
      content: [
        { tag: 'registration', attrs: {}, content: be(creds.registrationId, 4) },
        { tag: 'type', attrs: {}, content: Buffer.from([5]) },
        { tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
        { tag: 'list', attrs: {}, content: list },
        {
          tag: 'skey',
          attrs: {},
          content: [
            { tag: 'id', attrs: {}, content: be(creds.signedPreKey.keyId, 3) },
            { tag: 'value', attrs: {}, content: creds.signedPreKey.keyPair.public },
            { tag: 'signature', attrs: {}, content: creds.signedPreKey.signature }
          ]
        }
      ]
    })
  }

  ensurePreKeys() {
    if (this.preKeyJob) return this.preKeyJob
    this.preKeyJob = (async () => {
      const res = await this.query({ tag: 'iq', attrs: { xmlns: 'encrypt', type: 'get', to: S_WHATSAPP_NET }, content: [{ tag: 'count', attrs: {} }] })
      const count = +getChild(res, 'count').attrs.value
      if (count < 5) await this.uploadPreKeys(30)
    })().finally(() => {
      this.preKeyJob = null
    })
    return this.preKeyJob
  }

  startKeepAlive() {
    clearInterval(this.keepAlive)
    this.pingFailures = 0
    this.lastRecv = Date.now()
    const interval = this.keepAliveIntervalMs
    this.keepAlive = setInterval(() => {
      if (Date.now() - this.lastRecv > interval * 3 + 5000) {
        this.emit('error', new Error('conexión sin actividad: se reinicia'))
        this.transport?.close()
        return
      }
      this.query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] }, 20000)
        .then(() => {
          this.pingFailures = 0
        })
        .catch(() => {
          if (++this.pingFailures >= 2) {
            this.emit('error', new Error('keepalive fallido: se reinicia la conexión'))
            this.transport?.close()
          }
        })
    }, interval)
    this.keepAlive.unref?.()
  }

  async onSuccess(node) {
    this.reconnectAttempt = 0
    const { creds } = this.auth.state
    if (node.attrs.lid && creds.me) creds.me.lid = node.attrs.lid
    this.auth.save()
    try {
      await this.ensurePreKeys()
    } catch (e) {
      this.emit('error', e)
    }
    this.sendNode({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, xmlns: 'passive', type: 'set', id: `${this.prefix}-${++this.counter}` },
      content: [{ tag: 'active', attrs: {} }]
    })
    if (this.markOnlineOnConnect) this.sendNode({ tag: 'presence', attrs: { name: (creds.me && creds.me.name) || 'zyrix', type: 'available' } })
    this.startKeepAlive()
    this.emit('open')
    this.setConnection({ connection: 'open', qr: undefined })
    this.sendUnifiedSession()
    this.syncAppState().catch((e) => this.emit('error', e))
  }

  terminate(reason, extra = {}) {
    this.closing = true
    clearInterval(this.keepAlive)
    clearTimeout(this.qrTimer)
    this.emit('close', { reason, loggedOut: reason === DisconnectReason.loggedOut, reconnecting: false, ...extra })
    this.setConnection({ connection: 'close', lastDisconnect: { reason, date: new Date() } })
    this.transport?.close()
    this.flushAuth()
  }

  onFailure(node) {
    const reason = +node.attrs.reason
    if (this.restartingAfterPair && (reason === DisconnectReason.badSession || reason === DisconnectReason.unavailableService)) {
      this.pendingReason = DisconnectReason.restartRequired
      this.fastReconnect = true
      this.transport.close()
      return
    }
    if (isTerminalReason(reason)) return this.terminate(reason)
    this.pendingReason = reason
    this.emit('error', new Error(`WhatsApp rechazó la conexión (${node.attrs.reason})`))
    this.transport.close()
  }

  onStreamError(node) {
    const attrs = node.attrs || {}
    let code = +attrs.code
    const conflict = getChild(node, 'conflict')
    if (conflict) code = conflict.attrs?.type === 'device_removed' ? DisconnectReason.loggedOut : DisconnectReason.connectionReplaced
    if (this.restartingAfterPair && (code === DisconnectReason.badSession || code === DisconnectReason.unavailableService)) {
      this.pendingReason = DisconnectReason.restartRequired
      this.fastReconnect = true
      this.transport.close()
      return
    }
    if (code === DisconnectReason.restartRequired) {
      this.pendingReason = code
      this.fastReconnect = true
      return this.transport.close()
    }
    if (isTerminalReason(code)) return this.terminate(code)
    this.pendingReason = code || undefined
    this.emit('error', new Error(`WhatsApp stream error: ${JSON.stringify(attrs)}`))
    this.transport.close()
  }

  onClose(code) {
    clearInterval(this.keepAlive)
    clearTimeout(this.qrTimer)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new ZyrixError('conexion cerrada', { kind: ErrorKind.CLOSED }))
    }
    this.pending.clear()
    this.pairingMode = false
    this.pairingReady = false
    if (this.closing) return
    const reason = this.pendingReason ?? code
    this.pendingReason = undefined
    const reconnecting = this.reconnectEnabled && this.reconnectAttempt < this.maxReconnectAttempts
    this.emit('close', { code, reason, reconnecting })
    this.setConnection({ connection: 'close', lastDisconnect: { reason, code, date: new Date() } })
    if (!reconnecting) {
      this.closing = true
      this.flushAuth()
      return
    }
    let delay
    if (this.fastReconnect) {
      this.fastReconnect = false
      delay = 250
    } else {
      const base = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 5))
      delay = base + Math.floor(Math.random() * Math.min(1000, base / 4))
    }
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  sendPresence(to, state) {
    if (state !== 'composing' && state !== 'paused' && state !== 'recording') throw new TypeError('state debe ser composing, recording o paused')
    return this.sendPresenceUpdate(state, to)
  }

  async logout() {
    const me = this.auth.state.creds.me
    try {
      if (me && this.handshakeDone) {
        await this.query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'md' }, content: [{ tag: 'remove-companion-device', attrs: { jid: me.id, reason: 'user_initiated' } }] }, 10000)
      }
    } catch {}
    this.terminate(DisconnectReason.loggedOut)
    await this.flushAuth()
  }

  end() {
    this.closing = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    clearInterval(this.keepAlive)
    clearTimeout(this.qrTimer)
    this.transport?.close()
    for (const p of this.pending.values()) clearTimeout(p.timer)
    return this.flushAuth()
  }
}

Object.assign(Socket.prototype, messages, media, business, appstate, pairing, features, socketMethods, socketMixin)
defineNamespaces(Socket.prototype)

export { Socket, fetchVersion }
