import { REVOKE_TYPE, EDIT_TYPE, extractText } from './content.js'
import { userOf } from './jid.js'
import { sleep } from './util.js'

// Aliases de una identidad según el mapeo PN/LID persistido por el socket. Se usa la misma
// política en menciones, owners y filtros de ask(): nunca igualdad textual contra me.id.
const aliasesOf = (sock, values) => {
  const users = new Set()
  for (const value of [].concat(values)) {
    if (!value) continue
    const aliases = sock.getJidAliases?.(value) || [value]
    for (const alias of aliases) {
      const user = userOf(alias)
      if (user) users.add(user)
    }
  }
  return users
}

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
    const mine = aliasesOf(this.sock, [me.id, me.lid])
    return (this.mentions || []).some((jid) => {
      const mentioned = aliasesOf(this.sock, [jid])
      for (const user of mentioned) if (mine.has(user)) return true
      return false
    })
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
    // El listener se registra ANTES de enviar el prompt: una respuesta que llegue mientras
    // reply() todavía está en vuelo no puede perderse. Si el envío falla, se cancela el
    // listener y el timer para no dejar nada colgado.
    const aliases = aliasesOf(this.sock, [this.sender, this.senderAlt])
    const matches = (m) => {
      if (m.chat !== this.chat) return false
      const own = aliasesOf(this.sock, [m.sender, m.senderAlt])
      let same = false
      for (const user of own) if (aliases.has(user)) { same = true; break }
      if (!same) return false
      return !filter || filter(m)
    }
    const controller = new AbortController()
    const waiting = this.sock.waitForMessage(matches, timeout, { signal: controller.signal })
    waiting.catch(() => {})
    try {
      if (prompt) await this.reply(prompt)
    } catch (error) {
      controller.abort()
      throw error
    }
    const answer = await waiting
    if (!answer && strict) {
      const { ZyrixError, ErrorKind } = await import('./errors.js')
      throw new ZyrixError('no reply arrived in time', { kind: ErrorKind.TIMEOUT })
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

  waitForMessage(filter = () => true, timeout = 60000, { signal } = {}) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.off('message', onMessage)
        this.off('close', onClose)
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onMessage = (m) => {
        if (!m.fromMe && filter(m)) finish(m)
      }
      const onClose = (info) => {
        if (info && info.reconnecting === false) finish(null)
      }
      const onAbort = () => finish(null)
      const timer = setTimeout(() => finish(null), timeout)
      this.on('message', onMessage)
      this.on('close', onClose)
      if (signal) {
        if (signal.aborted) return finish(null)
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}

export { MessageContext, deriveEvents, socketMixin }
