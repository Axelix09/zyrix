import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createBot } from '../src/kit.js'

const fakeSock = () => Object.assign(new EventEmitter(), { getJidAliases: (jid) => [jid, jid.startsWith('1') ? `1@lid` : jid] })
const message = (text, extra = {}) => ({
  text, sender: '5491100000001@s.whatsapp.net', fromMe: false, offline: false, isGroup: false,
  replies: [], reply: async (v) => { message.replies.push(v) },
  read: async () => {}, isAdmin: async () => false, isBotAdmin: async () => false, ...extra
})

test('kit: owner por alias, caseSensitive y prefijo vacío', async () => {
  const bot = createBot(fakeSock(), { prefix: [''], owners: ['5491100000001'], caseSensitive: true })
  let ran = false
  bot.command({ names: ['Ping'], run: () => { ran = true } })
  await bot.handle(message('Ping hola'))
  assert.equal(ran, true)
  await bot.handle(message('ping'))
  assert.equal(ran, true)
  assert.equal(bot.isOwner(message('x', { sender: '5491100000001@s.whatsapp.net' })), true)
  assert.equal(bot.isOwner(message('x', { sender: '2@s.whatsapp.net' })), false)
  assert.equal(bot.parse(''), null)
  assert.equal(bot.parse('   '), null)
  assert.equal(bot.parse('Ping').name, 'Ping')
})

test('kit: filtros admin, botAdmin, cooldown liberado y purga', async () => {
  const bot = createBot(fakeSock(), { prefix: '!', cooldown: 0 })
  const replies = []
  const m = message('!cmd', { isGroup: true, reply: async (v) => replies.push(v) })
  bot.command({ names: ['cmd'], admin: true, run() {} })
  await bot.handle(m)
  assert.equal(replies.at(-1), bot.messages.adminOnly)

  const botAdmin = createBot(fakeSock(), { prefix: '!' })
  botAdmin.command({ names: ['cmd'], botAdmin: true, run() {} })
  const m2 = message('!cmd', { isGroup: true, reply: async (v) => replies.push(v) })
  await botAdmin.handle(m2)
  assert.equal(replies.at(-1), botAdmin.messages.botAdmin)

  botAdmin.command({ names: ['priv'], botAdmin: true, run() {} })
  await botAdmin.handle(message('!priv', { reply: async (v) => replies.push(v) }))
  assert.equal(replies.at(-1), botAdmin.messages.groupOnly)

  const slow = createBot(fakeSock(), { prefix: '!', cooldown: 60 })
  slow.command({ names: ['a'], run() {} })
  slow.cooldowns.set('5491100000001|a', Date.now())
  await slow.handle(message('!a'))
  assert.equal(slow.cooldowns.size, 1)
  for (let i = 0; i < 5100; i++) slow.cooldowns.set(`u${i}|a`, 0)
  slow.command({ names: ['b'], run() {} })
  slow.handle(message('!b'))
  assert.ok(slow.cooldowns.size < 5100)
})

test('kit: errores en middleware, comandos y hearers', async () => {
  const bot = createBot(fakeSock(), { prefix: '!', messages: { error: 'falló' } })
  const replies = []
  const events = []
  bot.on('command.error', (e) => events.push(e))
  bot.use(async () => { throw new Error('middleware') })
  await bot.handle(message('!x', { reply: async (v) => replies.push(v) }))
  assert.equal(events.length, 1)

  const bot2 = createBot(fakeSock(), { prefix: '!', messages: { error: 'falló' } })
  bot2.on('command.error', (e) => events.push(e))
  bot2.command({ names: ['boom'], run: async () => { throw new Error('boom') } })
  await bot2.handle(message('!boom', { reply: async (v) => replies.push(v) }))
  assert.equal(replies.at(-1), 'falló')

  const bot3 = createBot(fakeSock(), { prefix: '!' })
  const unknown = []
  bot3.on('command.unknown', (e) => unknown.push(e.name))
  await bot3.handle(message('!nope'))
  assert.deepEqual(unknown, ['nope'])

  const bot4 = createBot(fakeSock(), { prefix: '!' })
  const heard = []
  bot4.hears(/hola/i, (m) => heard.push(['regex', m.match[0]]))
  bot4.hears('mundo', (m) => heard.push(['string', m.match[0]]))
  bot4.hears((m) => (m.text.includes('fn') ? ['fn'] : null), () => heard.push(['function']))
  bot4.hears(/grupo/, () => { throw new Error('hearer') }, { group: true })
  await bot4.handle(message('hola mundo fn'))
  assert.deepEqual(heard, [['regex', 'hola'], ['string', 'mundo'], ['function']])
  await bot4.handle(message('', { text: undefined }))
})

test('kit: list, menu, help y categorías', () => {
  const bot = createBot(fakeSock(), { prefix: '!' })
  bot.command({ names: ['a'], description: 'A', usage: '[x]', category: 'Util', run() {} })
  bot.command({ names: ['b'], hidden: true, run() {} })
  assert.deepEqual(bot.list().map((c) => c.id), ['a'])
  assert.deepEqual(bot.list({ showHidden: true }).map((c) => c.id), ['a', 'b'])
  const menu = bot.menu()
  assert.equal(menu[0].category, 'Util')
  const help = bot.help({ title: 'Ayuda', uncategorized: 'Otros', bullet: '-', dash: ':' })
  assert.match(help, /Ayuda/)
  assert.match(help, /- !a \[x\] : A/)
  assert.match(bot.help({ showHidden: true }), /!b/)
})

test('kit: applyDefinition con array, setup, teardown, comandos anidados y hears', async () => {
  const bot = createBot(fakeSock(), { prefix: '!' })
  const cleaned = []
  await bot.applyDefinition([
    (b) => b.command({ names: ['fn'], run() {} }),
    {
      setup: (b) => b.command({ names: ['setup'], run() {} }),
      teardown: () => { cleaned.push('td') },
      commands: [{ names: ['nested'], run() {} }],
      hears: [{ pattern: 'eco', run() {} }]
    }
  ])
  assert.deepEqual(bot.list().map((c) => c.id).sort(), ['fn', 'nested', 'setup'])
  assert.equal(bot.hearers.length, 1)
  await assert.rejects(bot.applyDefinition(null), /plugin must export/)
  const nested = createBot(fakeSock(), { prefix: '!' })
  await nested.applyDefinition({ run() {}, names: ['solo'] })
  assert.deepEqual(nested.list().map((c) => c.id), ['solo'])
  await bot.stop()
  assert.ok(cleaned.includes('td'))
})

test('kit: loadPlugin recarga, avisa y descarga; scan/loadPlugins', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-kit-extra-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'uno.js'), "export default { commands: [{ names: ['uno'], run() {} }] }\n")
  await writeFile(path.join(dir, '_ignorado.js'), 'export default {}\n')
  await writeFile(path.join(dir, 'no.txt'), 'x')
  const bot = createBot(fakeSock(), { prefix: '!' })
  const loaded = await bot.loadPlugins(dir)
  assert.equal(loaded.failed.length, 0)
  assert.equal(loaded.loaded.length, 1)
  assert.equal(bot.list().length, 1)
  assert.equal(await bot.unloadPlugin(path.join(dir, 'uno.js')), 1)
  assert.equal(bot.list().length, 0)
  assert.equal(await bot.unloadPlugin(path.join(dir, 'uno.js'), { silent: true }), 0)
  assert.equal(await bot.loadPlugin(path.join(dir, 'no-existe.js')), false)
  await bot.loadPlugin(path.join(dir, 'uno.js'))
  const warnings = []
  bot.on('plugin.warning', (w) => warnings.push(w))
  bot.reloadCounts.set(path.join(dir, 'uno.js'), 49)
  await bot.loadPlugin(path.join(dir, 'uno.js'))
  assert.equal(warnings.length, 1)

  const recursive = path.join(dir, 'sub', 'deep')
  await import('node:fs/promises').then((fs) => fs.mkdir(recursive, { recursive: true }))
  await writeFile(path.join(recursive, 'dos.js'), 'export default function (b) { b.command({ names: ["dos"], run() {} }) }\n')
  const bot2 = createBot(fakeSock(), { prefix: '!' })
  const scanned = await bot2.loadPlugins(dir, { recursive: true })
  assert.equal(scanned.loaded.length, 2)
  await bot2.stop()
})
