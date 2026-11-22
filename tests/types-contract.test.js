import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MODULES, buildSurface, checkRuntime, compareSurfaces, loadRuntimeExports } from '../scripts/api-surface.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('types: los .d.ts públicos coinciden con la superficie comprometida y con el runtime', async () => {
  const committed = JSON.parse(await readFile(path.join(root, 'types-surface.json'), 'utf8'))
  const actual = buildSurface(root)
  assert.deepEqual(compareSurfaces(committed, actual), [])
  assert.deepEqual(checkRuntime(actual, await loadRuntimeExports(root)), [])
})

test('types: una firma cambiada sin regenerar la superficie se detecta', () => {
  const surface = buildSurface(root)
  const target = surface['index.d.ts'].exports
  const name = Object.keys(target).find((key) => target[key].value)
  const committed = structuredClone(surface)
  committed['index.d.ts'].exports[name].signature = 'firma-deliberadamente-distinta'
  const differences = compareSurfaces(committed, surface)
  assert.equal(differences.length, 1)
  assert.match(differences[0], new RegExp(`${name} changed its public signature`))
})

test('types: un export nuevo o eliminado en los .d.ts también se detecta', () => {
  const surface = buildSurface(root)
  const committed = structuredClone(surface)
  committed['kit.d.ts'].exports.algoInventado = { value: true, kind: 'FunctionDeclaration', signature: 'x' }
  delete committed['index.d.ts'].exports.Socket
  const differences = compareSurfaces(committed, surface)
  assert.ok(differences.some((line) => line.includes('algoInventado') && line.includes('removed')))
  assert.ok(differences.some((line) => line.includes('Socket') && line.includes('added')))
})

test('types: un valor declarado que no existe en runtime falla la comprobación', () => {
  const surface = buildSurface(root)
  surface['kit.d.ts'].exports.noExisteEnRuntime = { value: true, kind: 'FunctionDeclaration', signature: 'x' }
  const runtime = { 'index.d.ts': [], 'client.d.ts': [], 'kit.d.ts': [] }
  const problems = checkRuntime(surface, runtime)
  assert.ok(problems.some((line) => line.includes('noExisteEnRuntime') && line.includes('not exported at runtime')))
  assert.ok(problems.some((line) => line.includes('Socket') && line.includes('declared as a value but is not exported at runtime')))
})

test('types: el mapa exports de package.json apunta a archivos reales y el subpath ./kit coincide', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    for (const key of ['types', 'import', 'default']) {
      const relative = entry[key]
      assert.equal(typeof relative, 'string', `${subpath}.${key} missing`)
      await assert.doesNotReject(readFile(path.join(root, relative)), `${subpath}.${key} -> ${relative}`)
    }
  }
  const kit = MODULES.find((module) => module.declarations === 'kit.d.ts')
  assert.equal(pkg.exports['./kit'].import, `./${kit.runtime}`)
  const runtime = await loadRuntimeExports(root)
  const declared = buildSurface(root)['kit.d.ts'].exports
  for (const name of runtime['kit.d.ts']) assert.ok(declared[name], `./kit runtime export ${name} is undeclared`)
})
