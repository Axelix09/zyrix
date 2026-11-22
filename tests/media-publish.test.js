import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { publishNoOverwrite } from '../src/mediacrypto.js'

const noHardlink = (code) => async () => {
  const error = new Error(`link unsupported (${code})`)
  error.code = code
  throw error
}

const workdir = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zyrix-publish-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('publish: sin hardlinks (FAT/FUSE) copia con COPYFILE_EXCL y borra el temporal', async (t) => {
  const dir = await workdir(t)
  const temp = path.join(dir, 'media.tmp')
  const target = path.join(dir, 'media.jpg')
  await writeFile(temp, 'contenido descifrado')
  const calls = []

  await publishNoOverwrite(temp, target, {
    link: noHardlink('EPERM'),
    copyFile: async (from, to, mode) => {
      calls.push(mode)
      return fs.promises.copyFile(from, to, mode)
    }
  })

  assert.deepEqual(calls, [fs.constants.COPYFILE_EXCL])
  assert.equal(await readFile(target, 'utf8'), 'contenido descifrado')
  await assert.rejects(readFile(temp), { code: 'ENOENT' }, 'el temporal no queda atrás')
})

test('publish: el fallback no sobrescribe un archivo existente', async (t) => {
  const dir = await workdir(t)
  const temp = path.join(dir, 'media.tmp')
  const target = path.join(dir, 'media.jpg')
  await writeFile(temp, 'nuevo')
  await writeFile(target, 'del usuario')

  await assert.rejects(publishNoOverwrite(temp, target, { link: noHardlink('EACCES') }), { code: 'EEXIST' })
  assert.equal(await readFile(target, 'utf8'), 'del usuario')
  await assert.rejects(readFile(temp), { code: 'ENOENT' }, 'el temporal se limpia también al fallar')
})

test('publish: un error de link distinto de "no soportado" no dispara la copia', async (t) => {
  const dir = await workdir(t)
  const temp = path.join(dir, 'media.tmp')
  const target = path.join(dir, 'media.jpg')
  await writeFile(temp, 'x')
  let copied = false

  await assert.rejects(publishNoOverwrite(temp, target, {
    link: noHardlink('EIO'),
    copyFile: async () => { copied = true }
  }), { code: 'EIO' })
  assert.equal(copied, false)
  await assert.rejects(readFile(temp), { code: 'ENOENT' }, 'el temporal descifrado nunca queda atrás')
})
