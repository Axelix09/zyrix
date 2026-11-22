import ts from 'typescript'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Single source of truth for the public API surface: the committed types-surface.json.
// It is built from the public .d.ts files and verified twice:
//   1. the .d.ts files must still hash to the committed surface (drift detection);
//   2. every value export declared in a .d.ts must exist at runtime, and every runtime
//      export of the matching module must be declared in its .d.ts.
// Changing a public signature therefore requires `npm run types:surface`, which makes the
// diff explicit in review instead of letting CI pass on a stale declaration set.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SURFACE_PATH = path.join(projectRoot, 'types-surface.json')

export const MODULES = [
  { declarations: 'index.d.ts', runtime: 'src/index.js' },
  { declarations: 'client.d.ts', runtime: 'src/client.js' },
  { declarations: 'kit.d.ts', runtime: 'src/kit.js' }
]

const normalize = (text) => text.replace(/\s+/g, ' ').trim()
const fingerprint = (text) => createHash('sha256').update(normalize(text)).digest('hex')

const isTypeOnly = (declaration) => ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)

export function buildSurface(root = projectRoot) {
  const files = MODULES.map(({ declarations }) => path.join(root, declarations))
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true
  })
  const checker = program.getTypeChecker()
  const surface = {}
  for (const { declarations } of MODULES) {
    const source = program.getSourceFile(path.join(root, declarations))
    if (!source) throw new Error(`cannot load ${declarations}`)
    const moduleSymbol = checker.getSymbolAtLocation(source)
    const exportsMap = {}
    // Re-exported symbols are resolved through export * as well, so index.d.ts and
    // client.d.ts legitimately list the same helper.
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const declaration = symbol.declarations?.[0]
      if (!declaration) continue
      exportsMap[symbol.getName()] = {
        value: !isTypeOnly(declaration),
        kind: ts.SyntaxKind[declaration.kind],
        signature: fingerprint(declaration.getText())
      }
    }
    surface[declarations] = { exports: exportsMap }
  }
  return surface
}

export async function loadRuntimeExports(root = projectRoot) {
  const runtime = {}
  for (const { declarations, runtime: modulePath } of MODULES) {
    // Sin query de cache-busting: una segunda URL crea una instancia distinta del
    // módulo y Node la reporta como no cubierta, falseando --experimental-test-coverage.
    // Los módulos no tienen estado de nivel superior que requiera recarga.
    const url = pathToFileURL(path.join(root, modulePath)).href
    const loaded = await import(url)
    runtime[declarations] = Object.keys(loaded).sort()
  }
  return runtime
}

export function compareSurfaces(expected, actual) {
  const differences = []
  for (const { declarations } of MODULES) {
    const before = expected[declarations]?.exports ?? {}
    const after = actual[declarations]?.exports ?? {}
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!before[name]) differences.push(`${declarations}: ${name} was added; run npm run types:surface`)
      else if (!after[name]) differences.push(`${declarations}: ${name} was removed; run npm run types:surface`)
      else if (before[name].signature !== after[name].signature) differences.push(`${declarations}: ${name} changed its public signature; run npm run types:surface`)
    }
  }
  return differences
}

export function checkRuntime(surface, runtime) {
  const problems = []
  for (const { declarations } of MODULES) {
    const declared = surface[declarations]?.exports ?? {}
    const names = new Set(runtime[declarations] ?? [])
    for (const [name, info] of Object.entries(declared)) {
      if (info.value && !names.has(name)) problems.push(`${declarations}: ${name} is declared as a value but is not exported at runtime`)
    }
    for (const name of names) {
      if (!declared[name]) problems.push(`${declarations}: runtime export ${name} is missing from ${declarations}`)
    }
  }
  return problems
}

const run = async () => {
  if (process.argv.includes('--write')) {
    const surface = buildSurface()
    await writeFile(SURFACE_PATH, `${JSON.stringify(surface, null, 2)}\n`, 'utf8')
    console.log(`Wrote ${path.relative(projectRoot, SURFACE_PATH)} (${Object.keys(surface).length} declaration files).`)
    return
  }
  const surface = buildSurface()
  const committed = JSON.parse(await readFile(SURFACE_PATH, 'utf8'))
  const differences = compareSurfaces(committed, surface)
  const problems = checkRuntime(surface, await loadRuntimeExports())
  const failures = [...differences, ...problems]
  if (failures.length) {
    console.error('Public type contract failed:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('Public types match the committed surface and the runtime exports.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run()
}
