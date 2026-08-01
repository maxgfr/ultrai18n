// Which model translates, where it lives, and how its request is shaped.
//
// Two things are under test and only one is obvious. The obvious one is
// precedence: a `--model` flag has to beat an env var has to beat a config file
// has to beat the preset, on every path, or the flag is honoured somewhere and
// ignored somewhere else.
//
// The other is the WIRE FORMAT. The engine used to send Anthropic's request
// shape — `system` beside `messages`, `max_tokens` — to whatever URL you pointed
// at, so aiming it at an OpenAI-compatible endpoint produced a 400 that read
// like an authentication problem.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROVIDERS,
  keyRequired,
  readAnswer,
  requestBody,
  requestHeaders,
  resolveProvider,
} from '../src/provider'

const dirs: string[] = []
function repoWith(config?: unknown): string {
  const repo = mkdtempSync(join(tmpdir(), 'ultrai18n-provider-'))
  dirs.push(repo)
  if (config !== undefined) {
    mkdirSync(join(repo, '.ultrai18n'), { recursive: true })
    writeFileSync(join(repo, '.ultrai18n', 'config.json'), JSON.stringify(config))
  }
  return repo
}

const ENV_KEYS = ['ULTRAI18N_PROVIDER', 'ULTRAI18N_MODEL', 'ULTRAI18N_ENDPOINT', 'ULTRAI18N_KEY_ENV', 'ULTRAI18N_MAX_TOKENS']

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('presets', () => {
  it('default to a SMALL model, which is what this workload wants', () => {
    // Eight short strings and a one-page contract per batch is not work a
    // frontier model does better, and paying frontier prices per batch is how a
    // cheap operation becomes an expensive one.
    const openai = PROVIDERS.find((p) => p.id === 'openai')!
    expect(openai.model).toMatch(/mini/)
    expect(PROVIDERS.find((p) => p.id === 'anthropic')!.model).toMatch(/haiku/)
  })

  it('cite documentation, like every other catalog in this engine', () => {
    for (const p of PROVIDERS) expect(p.docs, p.id).toMatch(/^https:\/\//)
  })

  it('refuse an unknown id with the list and the escape hatch', () => {
    expect(() => resolveProvider(repoWith(), { provider: 'gemini' })).toThrow(/known: anthropic, openai/)
    expect(() => resolveProvider(repoWith(), { provider: 'gemini' })).toThrow(/openai-compatible/)
  })
})

describe('precedence', () => {
  it('falls back to the preset when nothing overrides it', () => {
    const r = resolveProvider(repoWith())
    expect(r.provider).toBe('anthropic')
    expect(r.from.model).toBe('preset')
  })

  it('reads a config file', () => {
    const r = resolveProvider(repoWith({ translate: { provider: 'openai', model: 'gpt-4.1-mini' } }))
    expect(r.provider).toBe('openai')
    expect(r.model).toBe('gpt-4.1-mini')
    expect(r.from.model).toBe('config')
  })

  it('lets an env var beat the config file', () => {
    process.env.ULTRAI18N_MODEL = 'from-env'
    const r = resolveProvider(repoWith({ translate: { model: 'from-config' } }))
    expect(r.model).toBe('from-env')
    expect(r.from.model).toBe('env')
  })

  it('lets a flag beat everything', () => {
    process.env.ULTRAI18N_MODEL = 'from-env'
    const r = resolveProvider(repoWith({ translate: { model: 'from-config' } }), { model: 'from-flag' })
    expect(r.model).toBe('from-flag')
    expect(r.from.model).toBe('flag')
  })

  it('merges headers rather than replacing them', () => {
    const r = resolveProvider(repoWith({ translate: { headers: { 'x-team': 'docs' } } }), {
      headers: { 'x-run': '7' },
    })
    // The preset's own header survives both.
    expect(r.headers).toMatchObject({ 'anthropic-version': '2023-06-01', 'x-team': 'docs', 'x-run': '7' })
  })

  it('refuses a config file it cannot read, rather than silently using defaults', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ultrai18n-provider-'))
    dirs.push(repo)
    mkdirSync(join(repo, '.ultrai18n'), { recursive: true })
    writeFileSync(join(repo, '.ultrai18n', 'config.json'), '{ not json')
    expect(() => resolveProvider(repo)).toThrow(/not readable JSON/)
  })
})

describe('the wire format', () => {
  it('puts the contract where each endpoint expects it', () => {
    const anthropic = resolveProvider(repoWith(), { provider: 'anthropic' })
    const openai = resolveProvider(repoWith(), { provider: 'openai' })

    const a = requestBody(anthropic, 'CONTRACT', '{}') as Record<string, unknown>
    expect(a.system).toBe('CONTRACT')
    expect(a.max_tokens).toBe(4096)
    expect((a.messages as unknown[]).length).toBe(1)

    const o = requestBody(openai, 'CONTRACT', '{}') as Record<string, unknown>
    expect(o.system).toBeUndefined()
    expect(o.max_completion_tokens).toBe(4096)
    expect((o.messages as { role: string }[])[0]!.role).toBe('system')
  })

  it('sends one auth header, not both', () => {
    // Sending an `x-api-key` to OpenAI is harmless; sending a bearer token to a
    // gateway that logs headers is not.
    const anthropic = resolveProvider(repoWith(), { provider: 'anthropic' })
    const openai = resolveProvider(repoWith(), { provider: 'openai' })
    expect(requestHeaders(anthropic, 'sk-x')).toMatchObject({ 'x-api-key': 'sk-x' })
    expect(requestHeaders(anthropic, 'sk-x').authorization).toBeUndefined()
    expect(requestHeaders(openai, 'sk-x')).toMatchObject({ authorization: 'Bearer sk-x' })
    expect(requestHeaders(openai, 'sk-x')['x-api-key']).toBeUndefined()
  })

  it('reads the answer out of whichever envelope came back', () => {
    const anthropic = resolveProvider(repoWith(), { provider: 'anthropic' })
    const openai = resolveProvider(repoWith(), { provider: 'openai' })
    expect(readAnswer(anthropic, { content: [{ text: 'a' }] })).toBe('a')
    expect(readAnswer(openai, { choices: [{ message: { content: 'b' } }] })).toBe('b')
    expect(readAnswer(openai, {})).toBe('')
  })
})

describe('keys', () => {
  it('are required for a remote endpoint and optional for a local one', () => {
    expect(keyRequired('https://api.openai.com/v1/chat/completions')).toBe(true)
    expect(keyRequired('http://localhost:11434/v1/chat/completions')).toBe(false)
    expect(keyRequired('http://127.0.0.1:8000/v1/chat/completions')).toBe(false)
  })

  it('let a local model run with no account at all', () => {
    const r = resolveProvider(repoWith(), { provider: 'openai-compatible' })
    expect(keyRequired(r.endpoint)).toBe(false)
    expect(r.wire).toBe('openai')
  })
})
