import fs from 'fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { jsonReplacer, jsonReviver } from './util.js'
import { ZyrixError, ErrorKind } from './errors.js'

const trim = (map, max) => {
  while (map.size > max) map.delete(map.keys().next().value)
}

const touch = (map, key, value) => {
  map.delete(key)
  map.set(key, value)
}

const createStore = (socket, { maxMessagesPerChat = 200, maxChats = 1000, maxContacts = 5000 } = {}) => {
  if (!socket || typeof socket.on !== 'function') throw new TypeError('createStore requires a Zyrix socket')
  const messages = new Map()
  const chats = new Map()
  const contacts = new Map()
  const groups = new Map()
  const presences = new Map()
  let writeChain = Promise.resolve()

  const assertArray = (value, name) => {
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`)
    return value
  }
  const assertRecord = (value, name) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
    return value
  }

  const rememberMessage = (event) => {
    const jid = event.key.remoteJid
    const list = messages.get(jid) || new Map()
    list.delete(event.key.id)
    list.set(event.key.id, event)
    trim(list, maxMessagesPerChat)
    touch(messages, jid, list)
    trim(messages, maxChats)
    const chat = chats.get(jid) || { id: jid }
    touch(chats, jid, { ...chat, lastMessageTimestamp: event.messageTimestamp, unread: event.key.fromMe ? chat.unread || 0 : (chat.unread || 0) + 1 })
    trim(chats, maxChats)
  }

  const handlers = {
    'messages.upsert': (event) => event && event.key && event.key.id && rememberMessage(event),
    'chats.update': (update) => {
      if (!update || !update.id) return
      touch(chats, update.id, { ...(chats.get(update.id) || {}), ...update })
      trim(chats, maxChats)
    },
    'contacts.upsert': (contact) => {
      if (!contact || !contact.id) return
      touch(contacts, contact.id, { ...(contacts.get(contact.id) || {}), ...contact })
      trim(contacts, maxContacts)
    },
    'groups.update': (list) => {
      for (const update of Array.isArray(list) ? list : [list]) {
        if (!update || !update.id) continue
        touch(groups, update.id, { ...(groups.get(update.id) || {}), ...update })
      }
      trim(groups, maxChats)
    },
    'group-participants.update': ({ id, action, participantsInfo = [] }) => {
      const group = groups.get(id)
      if (!group || !Array.isArray(group.participants)) return
      const ids = new Set(participantsInfo.map((p) => p.id))
      if (action === 'add') {
        const known = new Set(group.participants.map((p) => p.id))
        group.participants = group.participants.concat(participantsInfo.filter((p) => !known.has(p.id)))
      } else if (action === 'remove' || action === 'leave') {
        group.participants = group.participants.filter((p) => !ids.has(p.id))
      } else if (action === 'promote' || action === 'demote') {
        group.participants = group.participants.map((p) => (ids.has(p.id) ? { ...p, isAdmin: action === 'promote', admin: action === 'promote' ? 'admin' : null } : p))
      }
    },
    'presence.update': ({ id, presences: update }) => {
      touch(presences, id, { ...(presences.get(id) || {}), ...update })
      trim(presences, maxChats)
    }
  }

  for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler)

  const store = {
    loadMessage(jid, id) {
      const list = messages.get(jid)
      return list ? list.get(id) : undefined
    },
    getMessage(key) {
      const event = key && store.loadMessage(key.remoteJid, key.id)
      return event ? event.message : undefined
    },
    getMessages(jid, limit = 50) {
      const list = messages.get(jid)
      return list ? [...list.values()].slice(-limit) : []
    },
    getChat: (jid) => chats.get(jid),
    getChats: () => [...chats.values()],
    getContact: (jid) => contacts.get(jid),
    getContacts: () => [...contacts.values()],
    getGroup: (jid) => groups.get(jid),
    getGroups: () => [...groups.values()],
    getPresence: (jid) => presences.get(jid),
    toJSON() {
      return {
        version: 1,
        messages: [...messages.entries()].map(([jid, list]) => [jid, [...list.values()]]),
        chats: [...chats.values()],
        contacts: [...contacts.values()],
        groups: [...groups.values()]
      }
    },
    // Restaurar datos no puede saltarse los límites del store: se validan tipos y se recortan
    // mensajes/chats/contactos a los mismos máximos que aplica el uso en memoria.
    fromJSON(data) {
      assertRecord(data, 'store data')
      if (data.version !== undefined && data.version !== 1) throw new TypeError('unsupported store version')
      messages.clear()
      chats.clear()
      contacts.clear()
      groups.clear()
      for (const pair of assertArray(data.messages, 'messages')) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('every messages entry must be [jid, list]')
        const [jid, list] = pair
        if (typeof jid !== 'string' || !jid) throw new TypeError('the message jid must be a non-empty string')
        const map = new Map()
        for (const event of assertArray(list, 'message list')) {
          assertRecord(event, 'message event')
          assertRecord(event.key, 'message key')
          if (typeof event.key.id !== 'string' || typeof event.key.remoteJid !== 'string') throw new TypeError('the message key needs id and remoteJid')
          map.set(event.key.id, event)
        }
        trim(map, maxMessagesPerChat)
        messages.set(jid, map)
      }
      trim(messages, maxChats)
      const push = (source, target, max, name) => {
        for (const item of assertArray(source, name)) {
          assertRecord(item, name + ' item')
          if (typeof item.id !== 'string' || !item.id) throw new TypeError(`${name} items need a string id`)
          touch(target, item.id, item)
        }
        trim(target, max)
      }
      push(data.chats, chats, maxChats, 'chats')
      push(data.contacts, contacts, maxContacts, 'contacts')
      push(data.groups, groups, maxChats, 'groups')
      return store
    },
    // Serializa las escrituras por destino y usa un temporal único: dos llamadas concurrentes
    // nunca comparten el mismo archivo temporal ni intercalan rename. Gana la última llamada
    // (por orden de invocación) y no quedan temporales tras éxito ni tras error.
    writeToFile(file) {
      const target = path.resolve(file)
      const snapshot = JSON.stringify(store.toJSON(), jsonReplacer)
      const run = writeChain.then(async () => {
        const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
        try {
          await fs.promises.writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
          await fs.promises.rename(temp, target)
        } catch (error) {
          await fs.promises.rm(temp, { force: true }).catch(() => {})
          throw error
        }
      })
      writeChain = run.catch(() => {})
      return run
    },
    readFromFile(file) {
      if (!fs.existsSync(file)) return store
      return store.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8'), jsonReviver))
    },
    unbind() {
      for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler)
    }
  }
  return store
}

const makeInMemoryStore = (options = {}) => {
  let store
  const facade = {
    bind(socket) {
      store?.unbind()
      store = createStore(socket, options)
      return proxy
    },
    unbind() {
      store?.unbind()
      store = undefined
    }
  }
  const proxy = new Proxy(facade, {
    get(target, property) {
      if (property in target) return target[property]
      return (...args) => {
        if (!store) throw new ZyrixError('makeInMemoryStore must be bound with store.bind(socket) before use', { kind: ErrorKind.NOT_READY, errorCode: 'STORE_NOT_BOUND' })
        const value = store[property]
        if (typeof value !== 'function') return value
        return value.apply(store, args)
      }
    }
  })
  return proxy
}

export { createStore, makeInMemoryStore }
