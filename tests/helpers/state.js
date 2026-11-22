import { EventEmitter } from 'node:events'
import { initCreds, initKeys } from '../../src/auth.js'

export const makeState = () => {
  const state = { creds: initCreds(), keys: initKeys() }
  state.creds.registered = true
  state.creds.me = { id: '5491100000001:3@s.whatsapp.net', name: 'Yo' }
  return state
}

export const makeAuth = (state = makeState()) => ({
  state,
  save() {},
  flush() {},
  onSaveError: null
})

// Socket sin red: el handshake se marca como hecho y el transporte es un doble.
export const makeSocketLike = (extra = {}) => Object.assign(new EventEmitter(), {
  auth: makeAuth(extra.state ?? makeState()),
  groupCache: new Map(),
  deviceCache: new Map(),
  sentCache: new Map(),
  counter: 1,
  prefix: 'test',
  maxMediaBytes: 10 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  query: async () => ({}),
  sendNode() {},
  emitError(error) { this.emit('error', error) }
}, extra)
