import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createBot } from '../src/kit.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (check, timeout = 5000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(25)
  }
  return false
}
const fakeSock = () => {
  const sock = new EventEmitter()
  sock.getJidAliases = (jid) => [jid]
  sock.logger = { error() {} }
  return sock
}

test('kit: unloadPlugin espera un teardown async', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-teardown-'))
  const bot = createBot(fakeSock(), { prefix: '!' })
  t.after(async () => { await bot.stop(); await rm(dir, { recursive: true, force: true }) })
  const file = path.join(dir, 'slow.mjs')
  await writeFile(file, "export default { commands: ['slow'], run() {}, teardown: async () => { await new Promise((r) => setTimeout(r, 30)); globalThis.__zyrixSlowTeardown = true } }\n")
  globalThis.__zyrixSlowTeardown = false
  assert.equal(await bot.loadPlugin(file), true)
  assert.equal(await bot.unloadPlugin(file), 1)
  assert.equal(globalThis.__zyrixSlowTeardown, true, 'unloadPlugin resolvió después del teardown')
  delete globalThis.__zyrixSlowTeardown
})

test('kit: un teardown que falla se reporta como plugin.error y no rechaza unloadPlugin', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-teardown-err-'))
  const bot = createBot(fakeSock(), { prefix: '!' })
  t.after(async () => { await bot.stop(); await rm(dir, { recursive: true, force: true }) })
  const file = path.join(dir, 'broken.mjs')
  await writeFile(file, "export default { commands: ['broken'], run() {}, teardown: async () => { throw new Error('teardown roto') } }\n")
  const errors = []
  bot.on('plugin.error', ({ error }) => errors.push(error.message))
  assert.equal(await bot.loadPlugin(file), true)
  assert.equal(await bot.unloadPlugin(file), 1)
  assert.deepEqual(errors, ['teardown roto'])
})

test('kit: watch recursive detecta subdirectorios nuevos, renombrados y eliminados', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-watch-'))
  const bot = createBot(fakeSock(), { prefix: '!' })
  t.after(async () => { await bot.stop(); await rm(dir, { recursive: true, force: true }) })

  bot.watch(dir, { recursive: true })
  bot.watch(dir, { recursive: true })
  assert.equal(bot.watchers.size, 1, 'no se duplican watchers para el mismo directorio')
  await sleep(100)

  const nested = path.join(dir, 'nested')
  await mkdir(nested)
  await sleep(200)
  await writeFile(path.join(nested, 'one.mjs'), "export default { commands: ['nestedcmd'], run() {} }\n")
  assert.ok(await waitFor(() => bot.names.has('nestedcmd')), 'el plugin del subdirectorio nuevo se carga')

  const renamed = path.join(dir, 'renamed')
  await rename(nested, renamed)
  await sleep(250)
  await writeFile(path.join(renamed, 'two.mjs'), "export default { commands: ['renamedcmd'], run() {} }\n")
  assert.ok(await waitFor(() => bot.names.has('renamedcmd')), 'el subdirectorio renombrado sigue vigilado')

  await rm(path.join(renamed, 'two.mjs'))
  assert.ok(await waitFor(() => !bot.names.has('renamedcmd')), 'eliminar el archivo lo descarga')
})
