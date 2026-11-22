import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCoverage, renderStats, applyStats, START, END } from '../scripts/readme-stats.mjs'

const output = `
ℹ tests 258
ℹ pass 258
ℹ all files          |  95.00 |    85.06 |   90.74 |
`

test('readme-stats: parsea tests y cobertura de la salida real del runner', () => {
  assert.deepEqual(parseCoverage(output), { tests: 258, lines: 95 })
  assert.throws(() => parseCoverage('sin cifras'), /test count/)
  assert.throws(() => parseCoverage('ℹ tests 3\nℹ all files | nope |'), /line coverage/)
})

test('readme-stats: renderiza inglés y español con dos decimales', () => {
  assert.equal(renderStats({ tests: 258, lines: 95 }, 'en'), '258 tests and 95.00% line coverage across `src/` (CI fails below 90%)')
  assert.equal(renderStats({ tests: 258, lines: 92.87 }, 'es'), '258 tests y 92,87% de líneas cubiertas en `src/` (CI falla por debajo de 90%)')
})

test('readme-stats: reemplaza solo el bloque marcado y exige los marcadores', () => {
  const doc = `# T\n\n${START}1 test${END}\n\nresto`
  assert.equal(applyStats(doc, { tests: 2, lines: 99 }), `# T\n\n${START}2 tests and 99.00% line coverage across \`src/\` (CI fails below 90%)${END}\n\nresto`)
  assert.throws(() => applyStats('# sin marcadores', { tests: 2, lines: 99 }), /markers/)
})
