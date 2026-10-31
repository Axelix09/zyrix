import { REVOKE_TYPE, EDIT_TYPE, extractText } from './content.js'
import { sleep } from './util.js'

const userOf = (jid) => (jid ? String(jid).split('@')[0].split(':')[0] : undefined)

class MessageContext {
  constructor(sock, event, parsed) {
    Object.assign(this, parsed)
    Object.defineProperties(this, {
      sock: { value: sock },
      event: { value: event }
    })
  }

  get number() {
    return userOf(this.sender)
  }

  get isMentioned() {
    const me = this.sock.auth.state.creds.me
    if (!me) return false
    const mine = new Set([me.id, me.lid].filter(Boolean).map(userOf))
    return (this.mentions || []).some((jid) => mine.has(userOf(jid)))
  }

  get hasMedia() {
    return Boolean(this.media)
  }

  reply(content, options = {}) {
    return this.sock.sendMessage(this.chat, content, { ...options, quoted: this.event })
  }

  say(content, options = {}) {
    return this.sock.sendMessage(this.chat, content, options)
  }

  react(emoji = '👍') {
    return this.sock.sendReaction(this.chat, this.key, emoji)
  }

  unreact() {
    return this.react('')
  }

  delete() {
    return this.sock.sendDelete(this.chat, this.key)
  }

  edit(text) {
    return this.sock.sendEdit(this.chat, this.key, text)
  }

  forward(to, options = {}) {
    return this.sock.forward(to, this.event, options)
  }

  read() {
    return this.sock.readMessages([this.key])
  }

  download() {
    return this.sock.downloadMedia(this.message)
  }

  async typing(ms = 1000, state = 'composing') {
    this.sock.sendPresenceUpdate(state, this.chat)
    await sleep(ms)
    this.sock.sendPresenceUpdate('paused', this.chat)
  }

  group() {
    return this.isGroup ? this.sock.groupMetadata(this.chat) : Promise.resolve(null)
  }

  async isAdmin() {
    if (!this.isGroup || !this.sender) return false
    return this.sock.isGroupAdmin(this.chat, this.sender)
  }

  async isBotAdmin() {
    if (!this.isGroup) return false
    const me = this.sock.auth.state.creds.me
    if (!me) return false
    for (const candidate of [me.lid, me.id].filter(Boolean)) {
      if (await this.sock.isGroupAdmin(this.chat, candidate)) return true
    }
    return false
  }

  getQuoted() {
    if (!this.quoted) return null
    const event = { key: this.quoted.key, message: this.quoted.message }
    return new MessageContext(this.sock, event, this.sock.parseMessage(event))
  }

  async ask(prompt, { timeout = 60000, filter, strict = false } = {}) {
    if (prompt) await this.reply(prompt)
    const answer = await this.sock.waitForMessage((m) => m.chat === this.chat && m.sender === this.sender && (!filter || filter(m)), timeout)
    if (!answer && strict) {
      const { ZyrixError, ErrorKind } = await import('./errors.js')
      throw new ZyrixError('no hubo respuesta a tiempo', { kind: ErrorKind.TIMEOUT })
    }
    return answer
  }
}

const deriveEvents = (parsed, ctx) => {
  const body = parsed.message || {}
  if (parsed.type === 'protocol') {
    const pm = body.protocolMessage
    if (!pm) return []
    if (pm.type === REVOKE_TYPE) return [['message.revoke', { chat: parsed.chat, key: pm.key, author: parsed.sender, ctx }]]
    if (pm.type === EDIT_TYPE) {
      const edited = pm.editedMessage || {}
      return [['message.edit', { chat: parsed.chat, key: pm.key, author: parsed.sender, text: extractText(edited), message: edited, ctx }]]
    }
    return []
  }
  if (parsed.type === 'reaction') {
    const r = body.reactionMessage || {}
    const emoji = r.text || ''
    return [['message.reaction', { chat: parsed.chat, key: r.key, emoji, removed: !emoji, author: parsed.sender, ctx }]]
  }
  if (parsed.type === 'pollUpdate') {
    const u = body.pollUpdateMessage || {}
    return [['poll.vote', { chat: parsed.chat, pollKey: u.pollCreationMessageKey, author: parsed.sender, raw: u, ctx }]]
  }
  return [['message', ctx]]
}

const socketMixin = {
  emitDerived(event) {
    let parsed
    try {
      parsed = this.parseMessage(event)
    } catch {
      return
    }
    const ctx = new MessageContext(this, event, parsed)
    for (const [name, payload] of deriveEvents(parsed, ctx)) {
      try {
        this.emit(name, payload)
      } catch (error) {
        this.emit('error', error)
      }
    }
  },

  waitForMessage(filter = () => true, timeout = 60000) {
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer)
        this.off('message', onMessage)
        this.off('close', onClose)
        resolve(value)
      }
      const onMessage = (m) => {
        if (!m.fromMe && filter(m)) finish(m)
      }
      const onClose = (info) => {
        if (info && info.reconnecting === false) finish(null)
      }
      const timer = setTimeout(() => finish(null), timeout)
      this.on('message', onMessage)
      this.on('close', onClose)
    })
  }
}

export { MessageContext, deriveEvents, socketMixin }
