import { proto } from '../proto.js'
import { Curve } from '../crypto.js'
import { getChild, getChildren, jidDecode, jidEncode, isJidGroup } from '../binary.js'
import * as signal from '../signal.js'
import * as senderkey from '../senderkey.js'
import { S_WHATSAPP_NET as S, be, genId, pad, unpad, encodeAccount } from '../util.js'
import { buildMessage, REVOKE_TYPE, EDIT_TYPE } from '../content.js'
import { ZyrixError, ErrorKind } from '../errors.js'
import { normalizeJid, jidNormalizedUser, isJidLid, isJidPN, sameUser as sameIdentity, makeIdentityMap } from '../jid.js'

import { normalize, normalizeQuoted, userJid, sameUser, participantFromNode, parseGroupMetadata, nodeText, messageType, editAttribute, ackError, encodeMsg, ackAttrs, MAX_RETRIES, SKIP } from './shared.js'

export default {
  async getDevices(jids) {
    const me = jidDecode(this.auth.state.creds.me.id)
    const identities = makeIdentityMap(this.auth.state)
    const result = []
    const missing = []
    for (const jid of new Set(jids.map(userJid))) {
      const cachedDevices = this.deviceCache.get(jid)
      if (cachedDevices) result.push(...cachedDevices)
      else missing.push(jid)
    }
    if (missing.length) {
      const sid = `${this.prefix}-${++this.counter}`
      const res = await this.query({
        tag: 'iq',
        attrs: { to: S, type: 'get', xmlns: 'usync' },
        content: [
          {
            tag: 'usync',
            attrs: { context: 'message', mode: 'query', sid, last: 'true', index: '0' },
            content: [
              { tag: 'query', attrs: {}, content: [{ tag: 'devices', attrs: { version: '2' } }] },
              { tag: 'list', attrs: {}, content: missing.map((jid) => ({ tag: 'user', attrs: { jid } })) }
            ]
          }
        ]
      })
      const list = getChild(getChild(res, 'usync'), 'list')
      for (const user of getChildren(list, 'user')) {
        const u = jidDecode(user.attrs.jid)
        const deviceList = getChild(getChild(user, 'devices'), 'device-list')
        const devices = []
        for (const d of getChildren(deviceList, 'device')) {
          const id = +d.attrs.id
          if (id >= 99) continue
          devices.push(jidEncode(u.user, u.server, id))
        }
        this.deviceCache.set(userJid(user.attrs.jid), devices)
        result.push(...devices)
      }
    }
    const unique = []
    for (const j of new Set(result)) {
      const d = jidDecode(j)
      if (sameIdentity(j, this.auth.state.creds.me.id, identities.map) && (d.device || 0) === (me.device || 0)) continue
      const duplicate = unique.some((other) => {
        const otherDevice = jidDecode(other).device || 0
        return otherDevice === (d.device || 0) && sameIdentity(j, other, identities.map)
      })
      if (!duplicate) unique.push(j)
    }
    return unique
  },

  async fetchSessions(jids, force = false) {
    const state = this.auth.state
    const missing = force ? [...new Set(jids)] : jids.filter((j) => !signal.hasSession(state, j))
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50)
      const res = await this.query({
        tag: 'iq',
        attrs: { xmlns: 'encrypt', type: 'get', to: S },
        content: [{ tag: 'key', attrs: {}, content: chunk.map((jid) => ({ tag: 'user', attrs: force ? { jid, reason: 'identity' } : { jid } })) }]
      })
      for (const user of getChildren(getChild(res, 'list'), 'user')) {
        if (getChild(user, 'error')) continue
        try {
          await signal.injectSession(state, user.attrs.jid, signal.parseBundle(user), this.signalHooks)
        } catch (e) {
          this.emit('error', e)
        }
      }
    }
  },

  async participantNodes(jids, plainFor, extra) {
    const state = this.auth.state
    await this.fetchSessions(jids)
    const nodes = []
    let identity = false
    let pending = jids
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      if (attempt) await this.fetchSessions(pending, true)
      const missing = []
      for (const jid of pending) {
        if (!signal.hasSession(state, jid)) {
          missing.push(jid)
          continue
        }
        const { type, ciphertext } = await signal.encrypt(state, jid, plainFor(jid), this.signalHooks)
        if (type === 'pkmsg') identity = true
        nodes.push({ tag: 'to', attrs: { jid }, content: [{ tag: 'enc', attrs: { v: '2', type, ...extra }, content: ciphertext }] })
      }
      pending = missing
    }
    return { nodes, identity, missing: pending }
  },

  async throttle() {
    const gap = this.minSendIntervalMs
    if (!gap) return
    const wait = this.lastSendAt + gap - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    this.lastSendAt = Date.now()
  },

  waitForAck(id, timeout = 30000) {
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, timeout)
      this.pending.set(id, { resolve, reject, timer, tags: new Set(['ack']) })
    })
    promise.catch(() => {})
    return promise
  },

  async relay(chat, message, opts = {}) {
    const { id = genId(), mediaType, onlyDevice, edit, waitAck = false, ackTimeoutMs = 30000, additionalNodes = [], retryCount } = opts
    await this.throttle()
    const state = this.auth.state
    const identities = makeIdentityMap(state)
    const meJid = state.creds.me.id
    const plain = pad(encodeMsg(message))
    const extra = mediaType ? { mediatype: mediaType } : {}
    if (message.reactionMessage) extra['decrypt-fail'] = 'hide'
    const content = []
    const stanza = { tag: 'message', attrs: { id, to: chat, type: messageType(message) }, content }
    let identity = false

    if (isJidGroup(chat)) {
      const meta = await this.groupMetadata(chat)
      const mode = meta.addressingMode === 'lid' ? 'lid' : 'pn'
      const inMode = mode === 'lid' ? isJidLid : isJidPN
      const meLid = state.creds.me.lid
      if (meLid) identities.remember(meJid, meLid)
      const toMode = (value) => {
        if (!value) return undefined
        let normalized
        try {
          normalized = jidNormalizedUser(value)
        } catch {
          return value
        }
        if (inMode(normalized)) return value
        const alt = identities.map.get(normalized)
        if (!alt || !inMode(alt)) return value
        const d = jidDecode(value)
        const a = jidDecode(alt)
        return d && d.device && a ? jidEncode(a.user, a.server, d.device) : alt
      }
      const pickParticipant = (p) => {
        const candidates = [p.id, p.lid, p.jid, p.phoneNumber].filter(Boolean)
        const direct = candidates.find(inMode)
        if (direct) return direct
        for (const candidate of candidates) {
          const converted = toMode(candidate)
          if (converted && inMode(jidNormalizedUser(converted))) return converted
        }
        return candidates[0]
      }
      const own = signal.addrKey(meJid)
      const rec = senderkey.ensureOwn(state, chat, own)
      if (rec.sentMode !== mode) {
        rec.sentTo = {}
        rec.sentMode = mode
      }
      if (onlyDevice) {
        const target = toMode(onlyDevice)
        const carrier = {
          ...message,
          senderKeyDistributionMessage: { groupId: chat, axolotlSenderKeyDistributionMessage: senderkey.distribution(rec) }
        }
        const wrapped = sameIdentity(target, meJid, identities.map) ? { deviceSentMessage: { destinationJid: chat, message: carrier } } : carrier
        const r = await this.participantNodes([target], () => pad(encodeMsg(wrapped)), extra)
        if (!r.nodes.length) throw new Error('sin sesion con el dispositivo')
        const enc = r.nodes[0].content[0]
        if (retryCount) enc.attrs.count = String(retryCount)
        content.push(enc)
        identity = r.identity
        rec.sentTo[target] = true
        stanza.attrs.participant = target
      } else {
        const participantJids = meta.participants.map(pickParticipant).filter(Boolean)
        const ownSelf = mode === 'lid' && meLid ? meLid : meJid
        const devices = await this.getDevices([...participantJids, ownSelf])
        const targets = devices.filter((j) => !rec.sentTo[j])
        if (targets.length) {
          const skdm = pad(
            encodeMsg({
              senderKeyDistributionMessage: { groupId: chat, axolotlSenderKeyDistributionMessage: senderkey.distribution(rec) }
            })
          )
          const r = await this.participantNodes(targets, () => skdm, extra)
          if (r.nodes.length) content.push({ tag: 'participants', attrs: {}, content: r.nodes })
          if (r.missing.length) this.emit('send.warning', { id, chat, missingDevices: r.missing })
          identity = r.identity
          for (const n of r.nodes) rec.sentTo[n.attrs.jid] = true
        }
        content.push({ tag: 'enc', attrs: { v: '2', type: 'skmsg', ...extra }, content: senderkey.encrypt(state, chat, own, plain) })
      }
      if (!onlyDevice) stanza.attrs.addressing_mode = mode
    } else {
      const meLid = state.creds.me.lid
      if (meLid && isJidLid(chat)) identities.remember(meJid, meLid)
      const ownQuery = meLid && isJidLid(chat) ? jidNormalizedUser(meLid) : meJid
      const devices = onlyDevice ? [onlyDevice] : await this.getDevices([chat, ownQuery])
      const wrapped = pad(encodeMsg({ deviceSentMessage: { destinationJid: chat, message } }))
      const r = await this.participantNodes(devices, (j) => (sameUser(j, meJid, identities.map) ? wrapped : plain), extra)
      identity = r.identity
      if (!onlyDevice && !sameUser(chat, meJid, identities.map) && !r.nodes.some((n) => !sameUser(n.attrs.jid, meJid, identities.map))) {
        throw new Error(`no se pudo establecer sesión con ${chat}: el destinatario no tiene dispositivos o falló la descarga de claves`)
      }
      if (r.missing.length) this.emit('send.warning', { id, chat, missingDevices: r.missing })
      if (onlyDevice) {
        if (!r.nodes.length) throw new Error('sin sesion con el dispositivo')
        content.push(...r.nodes[0].content)
        if (retryCount) content[content.length - 1].attrs.count = String(retryCount)
        stanza.attrs.to = onlyDevice
        if (sameUser(onlyDevice, meJid, identities.map)) stanza.attrs.recipient = chat
      } else content.push({ tag: 'participants', attrs: {}, content: r.nodes })
    }

    if (identity) content.push({ tag: 'device-identity', attrs: {}, content: encodeAccount(state.creds.account, true) })
    if (Array.isArray(additionalNodes) && additionalNodes.length) content.push(...additionalNodes)
    if (edit) stanza.attrs.edit = edit
    this.auth.save()
    const ack = waitAck ? this.waitForAck(id, ackTimeoutMs) : undefined
    try {
      this.sendNode(stanza)
    } catch (e) {
      if (ack) {
        const pending = this.pending.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(id)
        }
      }
      throw e
    }
    this.sentCache.set(id, { chat, message, mediaType, edit })
    return { key: { remoteJid: chat, fromMe: true, id }, message, ack }
  },

  async deliver(chat, message, opts = {}) {
    const waitAck = opts.waitAck !== false
    const sent = await this.run(() => this.relay(chat, message, { ...opts, waitAck }))
    const node = waitAck ? await sent.ack : undefined
    const error = node && ackError(node)
    if (error) throw error
    return {
      key: sent.key,
      message: sent.message,
      status: node ? 'sent' : 'unconfirmed',
      messageTimestamp: node && node.attrs.t ? +node.attrs.t : Math.floor(Date.now() / 1000)
    }
  },

  async sendMessage(to, content, options = {}) {
    const chat = normalize(to)
    options = { ...options, quoted: normalizeQuoted(options.quoted, chat) }
    if (content && typeof content === 'object' && !Array.isArray(content) && !content.type) {
      const mediaType = ['image', 'video', 'audio', 'document', 'sticker'].find((type) => content[type] !== undefined)
      if (mediaType) return this.sendMedia(chat, { ...content, ...options, [mediaType]: content[mediaType] })
      if (content.buttons) return this.sendButtons(chat, { ...content, ...options })
      if (content.list) return this.sendList(chat, { ...content.list, ...options })
      if (content.poll) return this.sendPoll(chat, { ...content.poll, ...options })
      if (content.location) return this.sendLocation(chat, { ...content.location, ...options })
      if (content.contact) return this.sendContact(chat, { ...content.contact, ...options })
      if (content.contacts) return this.sendContacts(chat, { contacts: content.contacts, ...options })
    }
    const message = buildMessage(content, this.withGroupExpiration(chat, content, options))
    return this.deliver(chat, message, {
      edit: editAttribute(message, chat),
      additionalNodes: options.additionalNodes,
      id: options.messageId,
      ackTimeoutMs: options.ackTimeoutMs,
      waitAck: options.waitAck ?? messageType(message) !== 'reaction'
    })
  },

  withGroupExpiration(chat, content, options) {
    if (options.expiration !== undefined || !isJidGroup(chat)) return options
    const special = content && typeof content === 'object' && (
      content.delete || content.edit || content.forward ||
      content.reactionMessage || content.protocolMessage || content.pollUpdateMessage ||
      content.type === 'reaction'
    )
    if (special) return options
    const cached = this.groupCache.get(chat)
    return cached && cached.ephemeralDuration ? { ...options, expiration: cached.ephemeralDuration } : options
  },

  async onRetryReceipt(node) {
    const { id, from, participant } = node.attrs
    let cached = this.sentCache.get(id)
    if (!cached && typeof this.getMessage === 'function') {
      const recovered = await this.getMessage({ remoteJid: from, fromMe: true, id })
      if (recovered) cached = { chat: from, message: recovered.message || recovered }
    }
    if (!cached) return
    const retry = getChild(node, 'retry')
    if (retry && +retry.attrs.count > MAX_RETRIES) return
    const device = participant || from
    const state = this.auth.state
    const keys = getChild(node, 'keys')
    signal.deleteSession(state, device)
    if (keys) {
      const bundle = signal.parseBundle({ content: [getChild(node, 'registration'), ...keys.content] })
      await signal.injectSession(state, device, bundle, this.signalHooks)
    } else await this.fetchSessions([device])
    await this.relay(cached.chat, cached.message, { id, mediaType: cached.mediaType, edit: cached.edit, onlyDevice: device, retryCount: retry ? Number(retry.attrs.count) || 1 : 1 })
  },

  async sendRetry(node) {
    const { id, from, participant, t } = node.attrs
    const count = (this.retries.get(id) || 0) + 1
    if (count > MAX_RETRIES) return
    this.retries.set(id, count)
    const { creds, keys } = this.auth.state
    const receipt = {
      tag: 'receipt',
      attrs: { id, type: 'retry', to: from },
      content: [
        { tag: 'retry', attrs: { count: String(count), id, t, v: '1' } },
        { tag: 'registration', attrs: {}, content: be(creds.registrationId, 4) }
      ]
    }
    if (participant) receipt.attrs.participant = participant
    if (node.attrs.recipient) receipt.attrs.recipient = node.attrs.recipient
    if (count > 1) {
      const preKeyId = creds.nextPreKeyId++
      const kp = Curve.generateKeyPair()
      keys.preKeys[preKeyId] = kp
      receipt.content.push({
        tag: 'keys',
        attrs: {},
        content: [
          { tag: 'type', attrs: {}, content: Buffer.from([5]) },
          { tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
          {
            tag: 'key',
            attrs: {},
            content: [
              { tag: 'id', attrs: {}, content: be(preKeyId, 3) },
              { tag: 'value', attrs: {}, content: kp.public }
            ]
          },
          {
            tag: 'skey',
            attrs: {},
            content: [
              { tag: 'id', attrs: {}, content: be(creds.signedPreKey.keyId, 3) },
              { tag: 'value', attrs: {}, content: creds.signedPreKey.keyPair.public },
              { tag: 'signature', attrs: {}, content: creds.signedPreKey.signature }
            ]
          },
          { tag: 'device-identity', attrs: {}, content: encodeAccount(creds.account, true) }
        ]
      })
      this.auth.save()
    }
    this.sendNode(receipt)
  },

  async onMessage(node) {
    const { id, from, participant } = node.attrs
    const state = this.auth.state
    const sender = participant || from
    const seenKey = `${from}|${participant || ''}|${id}`
    if (this.seen.get(seenKey)) {
      this.sendNode({ tag: 'ack', attrs: { ...ackAttrs(node), class: 'message' } })
      return
    }
    const encs = getChildren(node, 'enc').sort((a, b) => (a.attrs.type === 'skmsg') - (b.attrs.type === 'skmsg'))
    let emitted = 0
    let failed = false
    for (const enc of encs) {
      const type = enc.attrs.type
      if (type !== 'pkmsg' && type !== 'msg' && type !== 'skmsg') continue
      let message
      try {
        const plain =
          type === 'skmsg'
            ? senderkey.decrypt(state, from, signal.addrKey(sender), enc.content)
            : await signal.decrypt(state, sender, type, enc.content, this.signalHooks)
        message = proto.Message.decode(unpad(Buffer.from(plain)))
      } catch (e) {
        failed = true
        this.emit('error', new Error(`${id} ${type}: ${e.message}`))
        continue
      }
      try {
        if (this.handleDecrypted(node, message)) emitted++
      } catch (e) {
        const error = new Error(`${id} ${type} processing: ${e.message}`)
        this.logger.error({ err: error, messageId: id }, 'error procesando mensaje descifrado')
        this.emit('error', error)
      } finally {
        this.seen.set(seenKey, true)
      }
    }
    this.auth.save()
    this.sendNode({ tag: 'ack', attrs: { ...ackAttrs(node), class: 'message' } })
    if (failed && !emitted) await this.sendRetry(node)
    else {
      const receipt = { id, to: from }
      if (participant) receipt.participant = participant
      this.sendNode({ tag: 'receipt', attrs: receipt })
    }
  },

  handleDecrypted(node, message) {
    const { id, from, participant, notify, t } = node.attrs
    const state = this.auth.state
    const sender = participant || from
    const identities = makeIdentityMap(state)
    this.learnAlternates(node.attrs, identities)
    const alternate = (value) => {
      if (!value) return undefined
      try {
        return identities.map.get(jidNormalizedUser(value))
      } catch {
        return undefined
      }
    }
    const skdm = message.senderKeyDistributionMessage
    if (skdm && skdm.axolotlSenderKeyDistributionMessage) {
      senderkey.processDistribution(state, skdm.groupId, signal.addrKey(sender), skdm.axolotlSenderKeyDistributionMessage)
    }
    const pm = message.protocolMessage
    let internal = false
    if (pm && pm.appStateSyncKeyShare) {
      for (const k of pm.appStateSyncKeyShare.keys || []) {
        const keyId = Buffer.from(k.keyId.keyId).toString('base64')
        state.keys.appStateKeys[keyId] = Buffer.from(k.keyData.keyData)
        state.creds.myAppStateKeyId ||= keyId
      }
      this.syncAppState().catch((e) => this.emit('error', e))
      internal = true
    }
    if (pm && pm.historySyncNotification) internal = true
    let key = { remoteJid: from, remoteJidAlt: alternate(from), fromMe: false, id, participant, participantAlt: alternate(participant) }
    let body = message
    if (message.deviceSentMessage) {
      key = { remoteJid: message.deviceSentMessage.destinationJid, remoteJidAlt: alternate(message.deviceSentMessage.destinationJid), fromMe: true, id }
      body = message.deviceSentMessage.message
    }
    const hasContent = Object.keys(body).some((k) => body[k] != null && !SKIP.has(k) && !(internal && k === 'protocolMessage'))
    if (!hasContent) return false
    const pushName = node.attrs.notify || notify
    if (pushName && !key.fromMe) this.rememberContact(sender, { notify: pushName })
    this.emit('messages.upsert', { key, message: body, pushName, messageTimestamp: +t, offline: node.attrs.offline !== undefined })
    return true
  },

  learnAlternates(attrs, identities) {
    const pairs = []
    const { from, participant } = attrs
    if (isJidGroup(from)) {
      if (participant && attrs.participant_pn) pairs.push([participant, attrs.participant_pn])
      if (participant && attrs.participant_lid) pairs.push([participant, attrs.participant_lid])
    } else {
      if (from && attrs.sender_pn) pairs.push([from, attrs.sender_pn])
      if (from && attrs.sender_lid) pairs.push([from, attrs.sender_lid])
    }
    for (const [a, b] of pairs) {
      try {
        if ((isJidLid(a) && isJidPN(b)) || (isJidPN(a) && isJidLid(b))) identities.remember(a, b)
      } catch {}
    }
  }
}
