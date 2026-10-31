import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { ZyrixError, ErrorKind } from './errors.js'

const toList = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value])
const userOf = (jid) => String(jid).split('@')[0].split(':')[0]
const noop = () => {}
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const rename = (obj, map) => {
  if (!isPlain(obj) || !map) return obj
  const out = {}
  for (const [key, value] of Object.entries(obj)) out[Object.hasOwn(map, key) ? map[key] : key] = value
  return out
}
const invert = (map) => Object.fromEntries(Object.entries(map || {}).map(([custom, canonical]) => [canonical, custom]))
const VOCAB_KEYS = ['options', 'command', 'messages', 'hears', 'plugin', 'context']

const vocabularioEs = Object.freeze({
  options: Object.freeze({ prefijo: 'prefix', prefijos: 'prefix', duenos: 'owners', dueños: 'owners', ignorarSinConexion: 'ignoreOffline', ignorarPropios: 'ignoreSelf', espera: 'cooldown', leerAuto: 'autoRead', distinguirMayusculas: 'caseSensitive', mensajes: 'messages' }),
  command: Object.freeze({ nombre: 'name', nombres: 'names', comandos: 'commands', ejecutar: 'run', descripcion: 'description', uso: 'usage', categoria: 'category', soloGrupo: 'group', soloPrivado: 'private', soloAdmin: 'admin', soloDueno: 'owner', soloDueño: 'owner', oculto: 'hidden', espera: 'cooldown' }),
  messages: Object.freeze({ soloGrupo: 'groupOnly', soloPrivado: 'privateOnly', soloDueno: 'ownerOnly', soloDueño: 'ownerOnly', soloAdmin: 'adminOnly', botAdmin: 'botAdmin', espera: 'cooldown', error: 'error' }),
  hears: Object.freeze({ patron: 'pattern', ejecutar: 'run', soloGrupo: 'group' }),
  plugin: Object.freeze({ comandos: 'commands', escuchar: 'hears', preparar: 'setup', limpiar: 'teardown' }),
  context: Object.freeze({ prefijo: 'prefix', argumentos: 'args', texto: 'text', comando: 'command' })
})

const buildVocabulary = (input) => {
  const vocab = {}
  for (const key of VOCAB_KEYS) vocab[key] = { ...(input?.[key] || {}) }
  vocab.reasons = invert(vocab.messages)
  vocab.contextOut = invert(vocab.context)
  return vocab
}
const isPluginFile = (name) => /\.(m?js)$/.test(name) && !path.basename(name).startsWith('_') && !path.basename(name).startsWith('.')

class Bot extends EventEmitter {
  constructor(sock, options = {}) {
    super({ captureRejections: true })
    if (!sock || typeof sock.on !== 'function') throw new ZyrixError('createBot requiere un socket de Zyrix', { kind: ErrorKind.INVALID })
    this.vocab = buildVocabulary(options.vocabulary ?? options.vocabulario)
    const { prefix = [], owners = [], ignoreOffline = true, ignoreSelf = true, cooldown = 0, autoRead = false, caseSensitive = false, messages = {} } = rename(options, this.vocab.options)
    this.sock = sock
    this.options = { ignoreOffline, ignoreSelf, cooldown, autoRead, caseSensitive }
    this.prefixes = toList(prefix).map(String).sort((a, b) => b.length - a.length)
    this.hasCommandRouting = this.prefixes.length > 0
    this.owners = toList(owners).map(String)
    this.messages = { ...rename(messages, this.vocab.messages) }
    this.commands = new Map()
    this.names = new Map()
    this.middlewares = []
    this.hearers = []
    this.cooldowns = new Map()
    this.cleanups = new Map()
    this.watchers = new Map()
    this.currentSource = null
    this.loadQueue = Promise.resolve()
    this.on('error', noop)
    this.handler = (m) => this.handle(m)
    sock.on('message', this.handler)
  }

  norm(name) {
    return this.options.caseSensitive ? String(name) : String(name).toLowerCase()
  }

  command(names, handler, meta = {}) {
    if (!this.hasCommandRouting) throw new ZyrixError('define `prefix` en createBot (usa \'\' para comandos sin prefijo) antes de registrar comandos', { kind: ErrorKind.INVALID })
    const spec = names && typeof names === 'object' && !Array.isArray(names) ? { ...rename(names, this.vocab.command) } : { ...rename(meta, this.vocab.command), names, run: handler }
    const list = toList(spec.commands ?? spec.names ?? spec.command ?? spec.name).map(String).filter(Boolean)
    const run = spec.run ?? spec.handler
    if (!list.length) throw new ZyrixError('el comando necesita al menos un nombre', { kind: ErrorKind.INVALID })
    if (typeof run !== 'function') throw new ZyrixError(`el comando ${list[0]} necesita una función run`, { kind: ErrorKind.INVALID })
    const entry = {
      id: this.norm(list[0]),
      names: list.map((n) => this.norm(n)),
      description: spec.description || '',
      usage: spec.usage || '',
      category: spec.category || spec.tag || null,
      group: Boolean(spec.group),
      private: Boolean(spec.private),
      admin: Boolean(spec.admin),
      botAdmin: Boolean(spec.botAdmin),
      owner: Boolean(spec.owner),
      hidden: Boolean(spec.hidden),
      cooldown: spec.cooldown,
      run,
      source: this.currentSource
    }
    this.commands.set(entry.id, entry)
    for (const name of entry.names) this.names.set(name, entry)
    return this
  }

  hears(pattern, handler, meta = {}) {
    if (typeof handler !== 'function') throw new ZyrixError('hears necesita una función', { kind: ErrorKind.INVALID })
    const opts = rename(meta, this.vocab.hears) || {}
    this.hearers.push({ pattern, run: handler, group: Boolean(opts.group), source: this.currentSource })
    return this
  }

  use(fn) {
    if (typeof fn !== 'function') throw new ZyrixError('use necesita una función (m, next)', { kind: ErrorKind.INVALID })
    this.middlewares.push({ fn, source: this.currentSource })
    return this
  }

  onUnload(fn) {
    if (typeof fn !== 'function') throw new ZyrixError('onUnload necesita una función', { kind: ErrorKind.INVALID })
    const key = this.currentSource || '*'
    this.cleanups.set(key, [...(this.cleanups.get(key) || []), fn])
    return this
  }

  isOwner(m) {
    if (!this.owners.length) return false
    const identities = [m.sender, m.senderAlt].filter(Boolean)
    const mine = new Set()
    for (const id of identities) {
      let aliases = [id]
      try {
        aliases = this.sock.getJidAliases(id)
      } catch {}
      for (const alias of aliases) mine.add(userOf(alias))
    }
    return this.owners.some((owner) => mine.has(userOf(owner)))
  }

  parse(text) {
    const raw = typeof text === 'string' ? text.trim() : ''
    if (!raw) return null
    for (const prefix of this.prefixes) {
      if (!raw.startsWith(prefix)) continue
      const rest = raw.slice(prefix.length).trimStart()
      if (!rest) continue
      const first = rest.split(/\s+/)[0]
      const name = this.norm(first)
      if (prefix === '' && !this.names.has(name)) continue
      const argText = rest.slice(first.length).trim()
      return { prefix, name, argText, args: argText ? argText.split(/\s+/) : [] }
    }
    return null
  }

  async check(entry, m) {
    if (entry.group && !m.isGroup) return { reason: 'groupOnly' }
    if (entry.private && m.isGroup) return { reason: 'privateOnly' }
    const owner = this.isOwner(m)
    if (entry.owner && !owner) return { reason: 'ownerOnly' }
    if (entry.admin && !owner) {
      if (!m.isGroup) return { reason: 'groupOnly' }
      if (!(await m.isAdmin())) return { reason: 'adminOnly' }
    }
    if (entry.botAdmin) {
      if (!m.isGroup) return { reason: 'groupOnly' }
      if (!(await m.isBotAdmin())) return { reason: 'botAdmin' }
    }
    const seconds = entry.cooldown ?? this.options.cooldown
    if (seconds > 0 && !owner) {
      const key = `${m.sender}|${entry.id}`
      const now = Date.now()
      const last = this.cooldowns.get(key) || 0
      const remaining = last + seconds * 1000 - now
      if (remaining > 0) return { reason: 'cooldown', value: Math.ceil(remaining / 1000) }
      this.cooldowns.set(key, now)
      if (this.cooldowns.size > 5000) {
        for (const [k, t] of this.cooldowns) if (now - t > 3600000) this.cooldowns.delete(k)
      }
    }
    return null
  }

  async handle(m) {
    if (this.options.ignoreSelf && m.fromMe) return
    if (this.options.ignoreOffline && m.offline) return
    const chain = [...this.middlewares]
    let index = -1
    const next = async () => {
      index++
      const layer = chain[index]
      if (layer) return layer.fn(m, next)
      return this.dispatch(m)
    }
    try {
      await next()
    } catch (error) {
      this.sock.logger?.error?.({ err: error }, 'error en el pipeline del bot')
      this.emit('command.error', { m, error })
    }
  }

  async dispatch(m) {
    const parsed = this.parse(m.text)
    if (!parsed) return this.runHearers(m)
    const entry = this.names.get(parsed.name)
    if (!entry) {
      this.emit('command.unknown', { m, name: parsed.name })
      return
    }
    m.prefix = parsed.prefix
    m.command = parsed.name
    m.args = parsed.args
    m.argText = parsed.argText
    const denied = await this.check(entry, m)
    if (denied) {
      this.emit('command.denied', { m, command: entry, reason: this.vocab.reasons[denied.reason] ?? denied.reason })
      const message = this.messages[denied.reason]
      if (message) await m.reply(typeof message === 'function' ? message(denied.value) : message).catch(noop)
      return
    }
    try {
      if (this.options.autoRead) m.read().catch(noop)
      await entry.run(m, rename({ bot: this, sock: this.sock, command: entry, prefix: parsed.prefix, args: parsed.args, text: parsed.argText }, this.vocab.contextOut))
      this.emit('command', { m, command: entry })
    } catch (error) {
      this.sock.logger?.error?.({ err: error, command: entry.id }, 'error ejecutando comando')
      this.emit('command.error', { m, command: entry, error })
      if (this.messages.error) await m.reply(this.messages.error).catch(noop)
    }
  }

  async runHearers(m) {
    const text = typeof m.text === 'string' ? m.text : ''
    for (const hearer of this.hearers) {
      if (hearer.group && !m.isGroup) continue
      let match = null
      if (hearer.pattern instanceof RegExp) {
        hearer.pattern.lastIndex = 0
        match = hearer.pattern.exec(text)
      } else if (typeof hearer.pattern === 'function') {
        match = hearer.pattern(m) || null
      } else if (typeof hearer.pattern === 'string') {
        match = text.toLowerCase().includes(hearer.pattern.toLowerCase()) ? [hearer.pattern] : null
      }
      if (!match) continue
      m.match = match
      try {
        await hearer.run(m, { bot: this, sock: this.sock })
      } catch (error) {
        this.emit('command.error', { m, error })
      }
    }
  }

  list({ showHidden = false } = {}) {
    return [...this.commands.values()].filter((entry) => showHidden || !entry.hidden)
  }

  menu({ showHidden = false } = {}) {
    const groups = new Map()
    for (const entry of this.list({ showHidden })) {
      const bucket = groups.get(entry.category) || []
      bucket.push(entry)
      groups.set(entry.category, bucket)
    }
    return [...groups].map(([category, commands]) => ({ category, commands }))
  }

  help({ title, uncategorized, showHidden = false, bullet = '\u2022', dash = '\u2014' } = {}) {
    const prefix = this.prefixes[0] ?? ''
    const lines = title ? [`*${title}*`] : []
    for (const { category, commands } of this.menu({ showHidden })) {
      const label = category ?? uncategorized
      if (lines.length) lines.push('')
      if (label) lines.push(`*${label}*`)
      for (const entry of commands) {
        const usage = entry.usage ? ` ${entry.usage}` : ''
        lines.push(`${bullet} ${prefix}${entry.id}${usage}${entry.description ? ` ${dash} ${entry.description}` : ''}`)
      }
    }
    return lines.join('\n')
  }

  removeSource(source) {
    let removed = 0
    for (const [id, entry] of this.commands) {
      if (entry.source !== source) continue
      this.commands.delete(id)
      removed++
      for (const name of entry.names) if (this.names.get(name) === entry) this.names.delete(name)
    }
    this.hearers = this.hearers.filter((h) => h.source !== source)
    this.middlewares = this.middlewares.filter((layer) => layer.source !== source)
    const cleanups = this.cleanups.get(source) || []
    this.cleanups.delete(source)
    for (const fn of cleanups) {
      try {
        fn()
      } catch (error) {
        this.emit('plugin.error', { file: source, error })
      }
    }
    return removed
  }

  async applyDefinition(def) {
    if (typeof def === 'function') return def(this)
    if (Array.isArray(def)) {
      for (const item of def) await this.applyDefinition(item)
      return
    }
    if (!def || typeof def !== 'object') throw new ZyrixError('el plugin debe exportar una función, un objeto o un arreglo', { kind: ErrorKind.INVALID })
    def = rename(rename(def, this.vocab.plugin), this.vocab.command)
    if (typeof def.setup === 'function') await def.setup(this)
    if (typeof def.teardown === 'function') this.onUnload(def.teardown)
    const nested = Array.isArray(def.commands) && def.commands.some((c) => c && typeof c === 'object')
    if (nested) for (const sub of def.commands) this.command(sub)
    else if (def.run || def.handler) this.command(def)
    for (const raw of toList(def.hears)) {
      const h = rename(raw, this.vocab.hears)
      this.hears(h.pattern, h.run, h)
    }
  }

  loadPlugin(file) {
    const abs = path.resolve(file)
    const job = async () => {
      this.unloadPlugin(abs, { silent: true })
      try {
        const mod = await import(`${pathToFileURL(abs).href}?v=${Date.now()}`)
        const def = mod.default !== undefined ? mod.default : { ...mod }
        this.currentSource = abs
        try {
          await this.applyDefinition(def)
        } finally {
          this.currentSource = null
        }
        const commands = [...this.commands.values()].filter((entry) => entry.source === abs).map((entry) => entry.id)
        this.emit('plugin.loaded', { file: abs, commands })
        return true
      } catch (error) {
        this.currentSource = null
        this.removeSource(abs)
        this.sock.logger?.error?.({ err: error, file: abs }, 'no se pudo cargar el plugin')
        this.emit('plugin.error', { file: abs, error })
        return false
      }
    }
    const promise = this.loadQueue.then(job)
    this.loadQueue = promise.catch(noop)
    return promise
  }

  unloadPlugin(file, { silent = false } = {}) {
    const abs = path.resolve(file)
    const removed = this.removeSource(abs)
    if (!silent && removed) this.emit('plugin.unloaded', { file: abs, commands: removed })
    return removed
  }

  async scan(dir, recursive) {
    const files = []
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive && !entry.name.startsWith('.') && entry.name !== 'node_modules') files.push(...(await this.scan(full, recursive)))
      } else if (isPluginFile(entry.name)) files.push(full)
    }
    return files.sort()
  }

  async loadPlugins(dir, { watch = false, recursive = false } = {}) {
    const abs = path.resolve(dir)
    const loaded = []
    const failed = []
    for (const file of await this.scan(abs, recursive)) (await this.loadPlugin(file) ? loaded : failed).push(file)
    if (watch) this.watch(abs, { recursive })
    return { loaded, failed }
  }

  watch(dir, { recursive = false } = {}) {
    const abs = path.resolve(dir)
    if (this.watchers.has(abs)) return this
    const timers = new Map()
    const watcher = fs.watch(abs, { recursive }, (_, name) => {
      if (!name || !isPluginFile(name)) return
      const file = path.join(abs, name)
      clearTimeout(timers.get(file))
      const timer = setTimeout(() => {
        timers.delete(file)
        if (fs.existsSync(file)) this.loadPlugin(file)
        else this.unloadPlugin(file)
      }, 150)
      if (typeof timer.unref === 'function') timer.unref()
      timers.set(file, timer)
    })
    watcher.on('error', (error) => this.emit('plugin.error', { file: abs, error }))
    this.watchers.set(abs, watcher)
    return this
  }

  stop() {
    this.sock.off('message', this.handler)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    const sources = new Set([...this.commands.values()].map((entry) => entry.source).concat([...this.cleanups.keys()]))
    for (const source of sources) if (source) this.removeSource(source)
    this.commands.clear()
    this.names.clear()
    this.hearers = []
    this.middlewares = []
  }
}

const createBot = (sock, options) => new Bot(sock, options)

export { Bot, createBot, vocabularioEs }
