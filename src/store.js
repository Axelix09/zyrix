import fs from 'fs'
import { jsonReplacer, jsonReviver } from './util.js'

const trim = (map, max) => {
  while (map.size > max) map.delete(map.keys().next().value)
}

const touch = (map, key, value) => {
  map.delete(key)
  map.set(key, value)
}

const createStore = (socket, { maxMessagesPerChat = 200, maxChats = 1000, maxContacts = 5000 } = {}) => {
  if (!socket || typeof socket.on !== 'function') throw new TypeError('createStore requiere un socket de Zyrix')
  const messages = new Map()
  const chats = new Map()
  const contacts = new Map()
  const groups = new Map()
  const presences = new Map()

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
    fromJSON(data) {
      if (!data || typeof data !== 'object') throw new TypeError('datos de store inválidos')
      for (const [jid, list] of data.messages || []) {
        const map = new Map()
        for (const event of list) map.set(event.key.id, event)
        messages.set(jid, map)
      }
      for (const chat of data.chats || []) chats.set(chat.id, chat)
      for (const contact of data.contacts || []) contacts.set(contact.id, contact)
      for (const group of data.groups || []) groups.set(group.id, group)
      return store
    },
    async writeToFile(file) {
      const temp = `${file}.${process.pid}.tmp`
      await fs.promises.writeFile(temp, JSON.stringify(store.toJSON(), jsonReplacer), 'utf8')
      await fs.promises.rename(temp, file)
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
  let proxy
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
  proxy = new Proxy(facade, {
    get(target, property) {
      if (property in target) return target[property]
      return (...args) => {
        if (!store) throw new Error('makeInMemoryStore debe enlazarse con store.bind(socket) antes de usarse')
        const value = store[property]
        if (typeof value !== 'function') return value
        return value.apply(store, args)
      }
    }
  })
  return proxy
}

export { createStore, makeInMemoryStore }
