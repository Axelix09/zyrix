import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createBot } from '../src/kit.js'

const fakeSock = () => {
  const sock = new EventEmitter()
  sock.getJidAliases = (jid) => [jid]
  return sock
}

const message = (text, extra = {}) => {
  const replies = []
  return {
    text,
    sender: '5491100000010@s.whatsapp.net',
    fromMe: false,
    offline: false,
    isGroup: false,
    replies,
    reply: async (value) => { replies.push(value) },
    read: async () => {},
    isAdmin: async () => false,
    isBotAdmin: async () => false,
    ...extra
  }
}

test('kit: despacha comandos por prefijo, alias y argumentos', async () => {
  const bot = createBot(fakeSock(), { prefix: ['!', '.'] })
  const calls = []
  bot.command({ names: ['ping', 'p'], run: (m, ctx) => calls.push({ args: ctx.args, text: ctx.text, prefix: ctx.prefix }) })
  await bot.handle(message('!ping uno dos'))
  await bot.handle(message('.P tres'))
  assert.deepEqual(calls, [
    { args: ['uno', 'dos'], text: 'uno dos', prefix: '!' },
    { args: ['tres'], text: 'tres', prefix: '.' }
  ])
})

test('kit: ignora mensajes propios y offline por defecto', async () => {
  const bot = createBot(fakeSock(), { prefix: '!' })
  let count = 0
  bot.command('x', () => count++)
  await bot.handle(message('!x', { fromMe: true }))
  await bot.handle(message('!x', { offline: true }))
  await bot.handle(message('!x'))
  assert.equal(count, 1)
})

test('kit: groupOnly, ownerOnly y adminOnly niegan con el motivo correcto y responden el texto configurado', async () => {
  const bot = createBot(fakeSock(), { prefix: '!', owners: ['5491199999999'], messages: { groupOnly: 'solo grupos', ownerOnly: 'solo dueño', adminOnly: 'solo admins' } })
  bot.command('g', () => {}, { group: true })
  bot.command('o', () => {}, { owner: true })
  bot.command('a', () => {}, { admin: true })
  const denied = []
  bot.on('command.denied', ({ reason }) => denied.push(reason))

  const m1 = message('!g')
  await bot.handle(m1)
  const m2 = message('!o')
  await bot.handle(m2)
  const m3 = message('!a', { isGroup: true })
  await bot.handle(m3)

  assert.deepEqual(denied, ['groupOnly', 'ownerOnly', 'adminOnly'])
  assert.deepEqual([m1.replies, m2.replies, m3.replies], [['solo grupos'], ['solo dueño'], ['solo admins']])
})

test('kit: el dueño saltea admin y cooldown', async () => {
  const bot = createBot(fakeSock(), { prefix: '!', owners: ['5491100000010'], cooldown: 60 })
  let runs = 0
  bot.command('a', () => runs++, { admin: true })
  await bot.handle(message('!a', { isGroup: true }))
  await bot.handle(message('!a', { isGroup: true }))
  assert.equal(runs, 2)
})

test('kit: cooldown bloquea la segunda ejecución e informa los segundos restantes', async () => {
  const bot = createBot(fakeSock(), { prefix: '!', messages: { cooldown: (s) => `esperá ${s}s` } })
  let runs = 0
  bot.command('c', () => runs++, { cooldown: 30 })
  await bot.handle(message('!c'))
  const second = message('!c')
  await bot.handle(second)
  assert.equal(runs, 1)
  assert.match(second.replies[0], /^esperá (29|30)s$/)
})

test('kit: un comando que tira no rompe el bot y emite command.error', async () => {
  const bot = createBot(fakeSock(), { prefix: '!', messages: { error: 'falló' } })
  bot.command('boom', () => { throw new Error('kaboom') })
  bot.command('ok', () => {})
  const errors = []
  bot.on('command.error', ({ error }) => errors.push(error.message))
  const m = message('!boom')
  await bot.handle(m)
  await bot.handle(message('!ok'))
  assert.deepEqual(errors, ['kaboom'])
  assert.deepEqual(m.replies, ['falló'])
})

test('kit: middleware corre en orden y puede cortar la cadena', async () => {
  const bot = createBot(fakeSock(), { prefix: '!' })
  const order = []
  bot.use(async (m, next) => { order.push('a'); await next() })
  bot.use(async (m, next) => { order.push('b'); if (m.text !== '!stop') await next() })
  bot.command('go', () => order.push('cmd'))
  bot.command('stop', () => order.push('nunca'))
  await bot.handle(message('!go'))
  await bot.handle(message('!stop'))
  assert.deepEqual(order, ['a', 'b', 'cmd', 'a', 'b'])
})

test('kit: hears con regex, string y función', async () => {
  const bot = createBot(fakeSock(), { prefix: '!' })
  const heard = []
  bot.hears(/hola (\w+)/i, (m) => heard.push(`re:${m.match[1]}`))
  bot.hears('gracias', () => heard.push('str'))
  await bot.handle(message('Hola mundo'))
  await bot.handle(message('muchas GRACIAS'))
  assert.deepEqual(heard, ['re:mundo', 'str'])
})

test('kit: comando desconocido emite command.unknown', async () => {
  const bot = createBot(fakeSock(), { prefix: '!' })
  bot.command('x', () => {})
  const unknown = []
  bot.on('command.unknown', ({ name }) => unknown.push(name))
  await bot.handle(message('!nada'))
  assert.deepEqual(unknown, ['nada'])
})

test('kit: vocabulario en español mapea opciones y metadatos', async () => {
  const bot = createBot(fakeSock(), { vocabulario: (await import('../src/kit.js')).vocabularioEs, prefijo: '#' })
  let ran = false
  bot.command({ nombre: 'hola', ejecutar: () => { ran = true } })
  await bot.handle(message('#hola'))
  assert.equal(ran, true)
})

test('kit: loadPlugin carga, recarga sin duplicar comandos y descarga', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-plugins-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'saludo.mjs')
  await writeFile(file, "export default { commands: ['saludo'], run: (m) => m.reply('v1') }\n")
  const bot = createBot(fakeSock(), { prefix: '!' })
  assert.equal(await bot.loadPlugin(file), true)
  const m1 = message('!saludo')
  await bot.handle(m1)
  assert.deepEqual(m1.replies, ['v1'])

  await writeFile(file, "export default { commands: ['saludo'], run: (m) => m.reply('v2') }\n")
  assert.equal(await bot.loadPlugin(file), true)
  const m2 = message('!saludo')
  await bot.handle(m2)
  assert.deepEqual(m2.replies, ['v2'])
  assert.equal([...bot.commands.values()].filter((c) => c.id === 'saludo').length, 1)

  bot.unloadPlugin(file)
  const unknown = []
  bot.on('command.unknown', ({ name }) => unknown.push(name))
  await bot.handle(message('!saludo'))
  assert.deepEqual(unknown, ['saludo'])
})

test('kit: un plugin con error de sintaxis emite plugin.error y no registra nada', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-plugins-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'roto.mjs')
  await writeFile(file, 'export default { commands: [\n')
  const bot = createBot(fakeSock(), { prefix: '!' })
  const errors = []
  bot.on('plugin.error', ({ file: f }) => errors.push(path.basename(f)))
  assert.equal(await bot.loadPlugin(file), false)
  assert.deepEqual(errors, ['roto.mjs'])
  assert.equal(bot.commands.size, 0)
})

test('kit: watch en producción avisa que la recarga en caliente retiene memoria', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-plugins-'))
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  const warnings = []
  const onWarning = (w) => warnings.push(w)
  process.on('warning', onWarning)
  const bot = createBot(fakeSock(), { prefix: '!' })
  const events = []
  bot.on('plugin.warning', (e) => events.push(e))
  t.after(async () => {
    process.env.NODE_ENV = previous
    process.off('warning', onWarning)
    bot.stop()
    await rm(dir, { recursive: true, force: true })
  })
  bot.watch(dir)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(events.length, 1)
  assert.match(events[0].message, /development/)
  assert.ok(warnings.some((w) => w.code === 'PLUGIN_WATCH_IN_PRODUCTION'))
})
