// Exercise the shipped executable through the documented sequence. Run build
// before this suite when changing source: the artifact is part of the contract.
import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { VerifyTodo, VerifyResult } from '../src/verify'

const engine = resolve('skills/ultrai18n/scripts/ultrai18n.mjs')

it('scan → plan → translate → apply → verify → adjudicate → check --semantic needs no manual rescan', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ultrai18n-cli-journey-'))
  const out = join(repo, '.ultrai18n')
  const source = 'Affiche des informations sur notre projet et sur son état courant.'
  const target = 'Display information about our project.'
  const table = {
    [source]: target,
    'Ouvrir le tiroir des réglages': 'Open the drawer',
    'Fermer le tiroir des réglages': 'Close the drawer of settings and options',
  }
  const run = (args: string[], expected = 0) => {
    const result = spawnSync(process.execPath, [engine, ...args, '--repo', repo, '--json'], {
      cwd: repo, encoding: 'utf8', timeout: 60_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(expected)
    return result
  }
  try {
    mkdirSync(out)
    writeFileSync(join(repo, '.gitignore'), '.ultrai18n/\n')
    writeFileSync(join(repo, 'task.sh'), `#!/bin/sh\n# ${source}\nprintf 'ok\\n'\n`)
    writeFileSync(join(repo, 'labels.ts'), "export const open = 'Ouvrir le tiroir des réglages', close = 'Fermer le tiroir des réglages'\n")
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture']]) {
      expect(spawnSync('git', args, { cwd: repo }).status).toBe(0)
    }
    writeFileSync(join(out, 'translator.mjs'), `import {readFileSync} from 'node:fs';
const table = ${JSON.stringify(table)};
const batch = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify({...batch, items: batch.items.map(({id,text}) => ({id,text:table[text] ?? text}))}));\n`)
    run(['scan', '--from', 'fr', '--to', 'en'])
    const originalInventory = readFileSync(join(out, 'inventory.json'), 'utf8')
    run(['plan', '--mode', 'swap'])
    const originalPlan = readFileSync(join(out, 'PLAN.json'), 'utf8')
    run(['translate', '--backend', 'cli', '--translator', 'node .ultrai18n/translator.mjs'])
    run(['translate', '--apply', '.ultrai18n/results/*.result.json'])
    const applied = JSON.parse(run(['apply', '--write', '--backup']).stdout)
    expect(applied.sites.applied).toBe(3)
    const todo = JSON.parse(run(['verify', '--sample-rate', '1']).stdout) as VerifyTodo
    expect(todo.pairs).toHaveLength(3)
    for (const pair of todo.pairs) expect(pair.tgt).toBe(table[pair.src as keyof typeof table])
    expect(new Set(todo.pairs.map((pair) => pair.siteId)).size).toBe(3)
    writeFileSync(join(out, 'verdicts.json'), JSON.stringify(todo.pairs.map((pair) => ({ ...pair, verdict: 'supported' }))))
    run(['verify', '--apply', join(out, 'verdicts.json')])
    expect(JSON.parse(run(['check', '--semantic']).stdout).ok).toBe(true)
    expect(readFileSync(join(out, 'inventory.json'), 'utf8')).toBe(originalInventory)
    expect(readFileSync(join(out, 'PLAN.json'), 'utf8')).toBe(originalPlan)

    const resultPath = join(out, 'VERIFY.json')
    const good = readFileSync(resultPath, 'utf8')
    const forged = JSON.parse(good) as VerifyResult
    forged.verdicts = []
    writeFileSync(resultPath, JSON.stringify(forged))
    expect(run(['check', '--semantic'], 1).stdout).toContain('never adjudicated')
    const todoPath = join(out, 'VERIFY.todo.json')
    const goodTodo = readFileSync(todoPath, 'utf8')
    writeFileSync(todoPath, JSON.stringify({ ...todo, pairs: [] }))
    expect(run(['check', '--semantic'], 1).stdout).toContain('worklist no longer matches')
    writeFileSync(todoPath, goodTodo)
    writeFileSync(resultPath, good)
    writeFileSync(join(repo, 'task.sh'), `#!/bin/sh\n# Different words after review.\nprintf 'ok\\n'\n`)
    expect(run(['check', '--semantic'], 1).stdout).toContain('no longer matches')
    rmSync(join(repo, 'labels.ts'))
    expect(run(['verify'], 1).stderr).toContain('no longer in the repository')
    expect(run(['check', '--semantic'], 1).stderr).toContain('no longer in the repository')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}, 120_000)
