import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const roots = ['test', 'tests']
const found = []
async function walk(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(file)
    else if (/\.test\.(?:js|mjs|cjs)$/.test(entry.name)) found.push(file)
  }
}
for (const dir of roots) await walk(path.join(root, dir))
if (found.length === 0) {
  console.error('No se encontraron pruebas *.test.js en test/ o tests/; npm test se detiene para evitar un falso verde.')
  process.exit(1)
}
console.log(`Descubrimiento correcto: ${found.length} archivo(s) de prueba.`)
