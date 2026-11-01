import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mutationModules } from '../stryker.recording.config.js'

const args = process.argv.slice(2)
const names = args.filter(arg => arg !== '--force')
for (const name of names) {
  if (!mutationModules.some(([module]) => module === name)) {
    console.error(`Unknown module: ${name}. Choose from: ${mutationModules.map(([module]) => module).join(', ')}`)
    process.exit(1)
  }
}
const selected = names.length ? mutationModules.filter(([name]) => names.includes(name)) : mutationModules
const stryker = fileURLToPath(new URL('../node_modules/@stryker-mutator/core/bin/stryker.js', import.meta.url))

function summarize() {
  const summary = []
  for (const [name] of mutationModules) {
    const reportPath = `reports/mutation/recording/${name}/mutation.json`
    if (!existsSync(reportPath)) continue
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    const counts = {}
    for (const file of Object.values(report.files)) {
      for (const mutant of file.mutants) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1
    }
    summary.push({ name, counts })
  }
  writeFileSync('reports/mutation/recording/summary.json', JSON.stringify(summary, null, 2) + '\n')
}

for (const [name] of selected) {
  console.log(`\nMutation testing: ${name}`)
  const result = spawnSync(process.execPath, [stryker, 'run', 'stryker.recording.config.js',
    ...(args.includes('--force') ? ['--force'] : [])], {
    stdio: 'inherit', env: { ...process.env, MUTATION_MODULE: name }
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  summarize()
}
