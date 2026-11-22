import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Las cifras de los README se generan desde una única ejecución real de la suite.
// `--check` falla si quedaron viejas, así que CI las mantiene sincronizadas.
export const START = '<!-- zyrix-stats:start -->'
export const END = '<!-- zyrix-stats:end -->'
const READMES = ['README.md', 'README.es.md']
const MIN_LINES = 90

export function parseCoverage(output) {
  const tests = Number(output.match(/^ℹ tests\s+(\d+)/m)?.[1])
  const lines = Number(output.match(/^ℹ all files\s+\|\s+([\d.]+)/m)?.[1])
  if (!Number.isSafeInteger(tests) || tests < 1) throw new Error('cannot find the test count in the runner output')
  if (!Number.isFinite(lines) || lines < 0 || lines > 100) throw new Error('cannot find the line coverage in the runner output')
  return { tests, lines }
}

export function renderStats({ tests, lines }, language) {
  const coverage = language === 'es' ? lines.toFixed(2).replace('.', ',') : lines.toFixed(2)
  const gate = `CI ${language === 'es' ? 'falla por debajo de' : 'fails below'} ${MIN_LINES}%`
  return language === 'es'
    ? `${tests} tests y ${coverage}% de líneas cubiertas en \`src/\` (${gate})`
    : `${tests} tests and ${coverage}% line coverage across \`src/\` (${gate})`
}

export function applyStats(markdown, stats, language = 'en') {
  if (!markdown.includes(START) || !markdown.includes(END)) throw new Error('README is missing the zyrix-stats markers')
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}`)
  return markdown.replace(pattern, `${START}${renderStats(stats, language)}${END}`)
}

const runSuite = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', '--experimental-test-coverage'], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  child.on('error', reject)
  child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`the test suite failed with exit ${code}`)))
})

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const main = async () => {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const check = args.includes('--check')
  if (!write && !check) throw new Error('use --write to update the READMEs or --check to verify them')
  const fromIndex = args.indexOf('--from')
  const stats = parseCoverage(fromIndex >= 0 ? await readFile(args[fromIndex + 1], 'utf8') : await runSuite())
  if (stats.lines < MIN_LINES) {
    console.error(`Line coverage ${stats.lines.toFixed(2)}% is below the ${MIN_LINES}% gate.`)
    process.exitCode = 1
    return
  }

  const stale = []
  for (const name of READMES) {
    const file = path.join(projectRoot, name)
    const before = await readFile(file, 'utf8')
    const after = applyStats(before, stats, name === 'README.es.md' ? 'es' : 'en')
    if (before !== after) stale.push(name)
    if (write && before !== after) await writeFile(file, after, 'utf8')
  }

  const summary = `${stats.tests} tests, ${stats.lines.toFixed(2)}% of lines`
  if (check && stale.length) {
    console.error(`README stats are stale (${stale.join(', ')}). Run npm run readme:stats.`)
    process.exitCode = 1
    return
  }
  console.log(write ? `Updated README stats: ${summary}.` : `README stats are current: ${summary}.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
