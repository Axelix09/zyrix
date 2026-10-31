import { Socket } from './socket.js'
import { useFileAuthState } from './auth.js'
import { proto } from './proto.js'
import { createStore, makeInMemoryStore } from './store.js'
import { useAdapterAuthState, useMemoryAuthState, memoryAdapter, mongoAdapter } from './authstore.js'
import { ZyrixError, ErrorKind, isZyrixError } from './errors.js'
import { MessageContext } from './context.js'
import { parseMessage } from './incoming.js'
import { DisconnectReason, reasonName } from './reasons.js'
import { DEFAULT_MESSAGES, mergeMessages } from './locale.js'
import { Launcher, createLauncher, start, parsePhoneNumber, formatPairingCode, promptPhone } from './launcher.js'
import * as contentModule from './content.js'
import {
  jidDecode, jidEncode, normalizeJid, jidNormalizedUser, jidWithoutDevice, jidType, isJidUser, isJidLid, isJidPN, isJidGroup
} from './jid.js'

const { socketMethods, ...builders } = contentModule
const content = Object.freeze({ ...builders })

const makeSocket = (options) => new Socket(options).start()

const connect = async ({ session = 'session', auth, ...options } = {}) => {
  const state = auth || (typeof session === 'string' ? useFileAuthState(session) : await useAdapterAuthState(session))
  return makeSocket({ ...options, auth: state })
}

export {
  start, createLauncher, Launcher, parsePhoneNumber, formatPairingCode, promptPhone, reasonName,
  connect, makeSocket, Socket, useAdapterAuthState, useMemoryAuthState, memoryAdapter, mongoAdapter, ZyrixError, ErrorKind, isZyrixError, MessageContext, useFileAuthState, createStore, makeInMemoryStore, parseMessage, DisconnectReason, DEFAULT_MESSAGES, mergeMessages, proto, content,
  jidDecode, jidEncode, normalizeJid, jidNormalizedUser, jidWithoutDevice, jidType, isJidUser, isJidLid, isJidPN, isJidGroup
}

export * from './client.js'
export { sniffMimeType } from './util.js'
