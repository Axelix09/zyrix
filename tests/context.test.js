import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MessageContext, deriveEvents, socketMixin } from '../src/context.js'
import { REVOKE_TYPE, EDIT_TYPE } from '../src/content.js'

const messageKey = { id: 'm1', remoteJid: 'chat', fromMe: false }

const makeContext = (parsed = {}) => {
  const calls = []
  const sock = Object.assign(new EventEmitter(), {
    auth: { state: { creds: { me: { id: 'me:1@s.whatsapp.net', lid: 'me@lid' } } } },
    getJidAliases: (jid) => [jid, jid === 'me@s.whatsapp.net' ? 'me@lid' : jid],
    sendMessage: async (...args) => { calls.push(['sendMessage', ...args]); return 'sent' },
    sendReaction: async (...args) => { calls.push(['sendReaction', ...args]); return 'reacted' },
    sendDelete: async (...args) => { calls.push(['sendDelete', ...args]); return 'deleted' },
    sendEdit: async (...args) => { calls.push(['sendEdit', ...args]); return 'edited' },
    forward: async (...args) => { calls.push(['forward', ...args]); return 'forwarded' },
    readMessages: async (...args) => { calls.push(['readMessages', ...args]); return 'read' },
    downloadMedia: async (...args) => { calls.push(['downloadMedia', ...args]); return Buffer.from('x') },
    sendPresenceUpdate: (...args) => calls.push(['presence', ...args]),
    groupMetadata: async (...args) => { calls.push(['groupMetadata', ...args]); return { id: 'g' } },
    isGroupAdmin: async (...args) => { calls.push(['isAdmin', ...args]); return args[1] === 'me@lid' },
    parseMessage: (event) => ({ text: 'quoted', sender: 'a', chat: 'chat', message: event.message }),
    waitForMessage: () => Promise.resolve({ text: 'respuesta' })
  })
  const event = { key: messageKey, message: { conversation: 'hola' } }
  const ctx = new MessageContext(sock, event, Object.assign({
    text: 'hola',
    sender: 'me@s.whatsapp.net',
    senderAlt: 'me@lid',
    chat: 'chat',
    isGroup: true,
    key: messageKey,
    message: { conversation: 'hola' },
    quoted: { key: { id: 'q' }, message: { conversation: 'q' } },
    mentions: ['me@lid'],
    media: null,
    type: 'text'
  }, parsed))
  return { ctx, sock, calls, event }
}

test('context: getters, acciones y presence', async () => {
  const { ctx, calls } = makeContext()
  assert.equal(ctx.number, 'me')
  assert.equal(ctx.isMentioned, true)
  assert.equal(ctx.hasMedia, false)
  assert.equal(await ctx.reply('x'), 'sent')
  assert.equal(calls.at(-1)[3].quoted.key.id, 'm1')
  await ctx.say('x')
  await ctx.react('👍')
  assert.deepEqual(calls.at(-1), ['sendReaction', 'chat', messageKey, '👍'])
  await ctx.unreact()
  await ctx.delete()
  await ctx.edit('nuevo')
  await ctx.forward('otro')
  await ctx.read()
  await ctx.download()
  await ctx.typing(1)
  assert.deepEqual(calls.filter(([n]) => n === 'presence').map(([, ...a]) => a), [['composing', 'chat'], ['paused', 'chat']])
  assert.deepEqual(await ctx.group(), { id: 'g' })
  assert.equal(await ctx.isAdmin(), false)
  assert.equal(await ctx.isBotAdmin(), true)
  const quoted = ctx.getQuoted()
  assert.equal(quoted.text, 'quoted')
  assert.equal(quoted.constructor, MessageContext)
  ctx.sock.auth.state.creds.me = null
  assert.equal(await ctx.isBotAdmin(), false)
  assert.equal(ctx.isMentioned, false)
})

test('context: isMentioned es falso sin menciones y ask respeta filtros y aborta al fallar', async () => {
  const { ctx, sock } = makeContext({ mentions: undefined })
  assert.equal(ctx.isMentioned, false)
  const answer = await ctx.ask('¿?')
  assert.deepEqual(answer, { text: 'respuesta' })

  const strict = makeContext()
  strict.sock.waitForMessage = async () => null
  await assert.rejects(strict.ctx.ask('¿?', { strict: true }), /no reply/)
  assert.equal(await strict.ctx.ask('¿?'), null)

  const failing = makeContext()
  failing.ctx.reply = async () => { throw new Error('envío') }
  let aborted = false
  failing.sock.waitForMessage = (fn, timeout, { signal }) => {
    signal.addEventListener('abort', () => { aborted = true })
    return new Promise(() => {})
  }
  await assert.rejects(failing.ctx.ask('x'), /envío/)
  assert.equal(aborted, true)

  const filtered = makeContext()
  let passedFilter = false
  filtered.sock.waitForMessage = async (fn) => {
    passedFilter = fn({ chat: 'chat', sender: 'me@lid', senderAlt: undefined })
    fn({ chat: 'otro', sender: 'me@lid' })
    fn({ chat: 'chat', sender: 'otro' })
    return null
  }
  await filtered.ctx.ask(null, { filter: () => true })
  assert.equal(passedFilter, true)
  assert.equal((await sock.groupMetadata('chat')).id, 'g')
})

test('context: isAdmin y isBotAdmin fuera de grupos y sin sender', async () => {
  const { ctx } = makeContext({ isGroup: false })
  assert.equal(await ctx.isAdmin(), false)
  assert.equal(await ctx.isBotAdmin(), false)
  const noSender = makeContext({ sender: undefined })
  assert.equal(await noSender.ctx.isAdmin(), false)
})

test('context: deriveEvents cubre revoke, edit, reaction, poll y texto', () => {
  const { ctx } = makeContext()
  assert.equal(deriveEvents({ type: 'protocol', message: {} }, ctx).length, 0)
  const revoke = deriveEvents({ type: 'protocol', chat: 'chat', sender: 'a', message: { protocolMessage: { type: REVOKE_TYPE, key: messageKey } } }, ctx)
  assert.equal(revoke[0][0], 'message.revoke')
  const edit = deriveEvents({ type: 'protocol', chat: 'chat', sender: 'a', message: { protocolMessage: { type: EDIT_TYPE, key: messageKey, editedMessage: { conversation: 'nuevo' } } } }, ctx)
  assert.equal(edit[0][0], 'message.edit')
  assert.equal(edit[0][1].text, 'nuevo')
  const other = deriveEvents({ type: 'protocol', message: { protocolMessage: { type: 99 } } }, ctx)
  assert.equal(other.length, 0)
  const reaction = deriveEvents({ type: 'reaction', chat: 'chat', sender: 'a', message: { reactionMessage: { text: '👍', key: messageKey } } }, ctx)
  assert.equal(reaction[0][0], 'message.reaction')
  assert.equal(reaction[0][1].removed, false)
  const removed = deriveEvents({ type: 'reaction', chat: 'chat', sender: 'a', message: { reactionMessage: { text: '', key: messageKey } } }, ctx)
  assert.equal(removed[0][1].removed, true)
  const vote = deriveEvents({ type: 'pollUpdate', chat: 'chat', sender: 'a', message: { pollUpdateMessage: { pollCreationMessageKey: messageKey } } }, ctx)
  assert.equal(vote[0][0], 'poll.vote')
  assert.equal(deriveEvents({ type: 'text', message: {} }, ctx)[0][0], 'message')
})

test('context: emitDerived parsea, emite eventos derivados y reporta errores', () => {
  const { sock } = makeContext()
  Object.assign(sock, socketMixin)
  sock.parseMessage = () => ({ type: 'text', chat: 'chat', sender: 'a', message: {}, key: messageKey, isGroup: false })
  const emitted = []
  sock.on('message', (m) => emitted.push(m.text ?? 'ctx'))
  sock.on('error', (e) => emitted.push(e.message))
  sock.emitDerived({})
  assert.equal(emitted.length, 1)
  sock.parseMessage = () => { throw new Error('parse') }
  sock.emitDerived({})
  assert.equal(emitted.length, 1)

  sock.parseMessage = () => ({ type: 'reaction', chat: 'chat', sender: 'a', message: { reactionMessage: { text: 'x', key: messageKey } } })
  sock.on('message.reaction', () => { throw new Error('listener roto') })
  sock.emitDerived({})
  assert.equal(emitted.at(-1), 'listener roto')
})

test('context: waitForMessage resuelve por mensaje, cierre, abort y timeout', async () => {
  const sock = Object.assign(new EventEmitter(), socketMixin)
  const fast = sock.waitForMessage((m) => m.text === 'ok', 1000)
  sock.emit('message', { fromMe: true, text: 'ok' })
  sock.emit('message', { fromMe: false, text: 'no' })
  sock.emit('message', { fromMe: false, text: 'ok' })
  assert.deepEqual(await fast, { fromMe: false, text: 'ok' })

  const closed = sock.waitForMessage(() => true, 1000)
  sock.emit('close', { reconnecting: false })
  assert.equal(await closed, null)

  const controller = new AbortController()
  const aborted = sock.waitForMessage(() => true, 1000, { signal: controller.signal })
  controller.abort()
  assert.equal(await aborted, null)

  const already = sock.waitForMessage(() => true, 1000, { signal: AbortSignal.abort() })
  assert.equal(await already, null)

  assert.equal(await sock.waitForMessage(() => true, 5), null)
  const reconnecting = sock.waitForMessage(() => true, 5)
  sock.emit('close', { reconnecting: true })
  assert.equal(await reconnecting, null)
})
