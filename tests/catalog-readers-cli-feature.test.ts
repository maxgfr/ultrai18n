import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

it('shipped CLI translates both catalogs through semantic verification', () => {
  const repo = mkdtempSync(join(tmpdir(), 'catalog-cli-'))
  const engine = resolve('skills/ultrai18n/scripts/ultrai18n.mjs'), out = join(repo, '.ultrai18n')
  const run = (expected: number, ...args: string[]) => {
    const r = spawnSync(process.execPath, [engine, ...args, '--repo', repo, '--json'], { encoding: 'utf8', timeout: 60000 })
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(expected)
    return r
  }
  try {
    mkdirSync(out)
    writeFileSync(join(repo, '.gitignore'), '.ultrai18n/\n')
    writeFileSync(join(repo, 'Localizable.strings'), '/* Preserve note. */\n"label"="Bonjour le monde %@";\n')
    writeFileSync(join(repo, 'messages.properties'), 'hint=Fermer les réglages du serveur {0}\n')
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture']]) {
      expect(spawnSync('git', args, { cwd: repo }).status).toBe(0)
    }
    writeFileSync(join(out, 'translator.mjs'), `import {readFileSync} from 'node:fs';const b=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({...b,items:b.items.map(x=>({id:x.id,text:x.text.includes('%@')?'Hello world %@':'Close the server settings {0}'}))}));`)
    run(0, 'scan', '--from', 'fr', '--to', 'en')
    const original = readFileSync(join(out, 'inventory.json'), 'utf8')
    run(0, 'plan', '--mode', 'swap')
    run(0, 'translate', '--backend', 'cli', '--translator', 'node .ultrai18n/translator.mjs')
    run(0, 'translate', '--apply', '.ultrai18n/results/*.result.json')
    run(0, 'apply', '--write', '--backup')
    const todo = JSON.parse(run(0, 'verify', '--sample-rate', '1').stdout)
    expect(todo.pairs).toHaveLength(2)
    writeFileSync(join(out, 'accepted.json'), JSON.stringify(todo.pairs.map((p: object) => ({ ...p, verdict: 'supported' }))))
    run(0, 'verify', '--apply', join(out, 'accepted.json'))
    expect(JSON.parse(run(0, 'check', '--semantic').stdout).ok).toBe(true)
    expect(readFileSync(join(out, 'inventory.json'), 'utf8')).toBe(original)
    expect(readFileSync(join(repo, 'Localizable.strings'), 'utf8')).toContain('Hello world %@')
    writeFileSync(join(repo, 'messages.properties'), 'hint=Different words {0}\n')
    expect(run(1, 'check', '--semantic').stdout).toContain('no longer matches')
  } finally { rmSync(repo, { recursive: true, force: true }) }
}, 120000)
