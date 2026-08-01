// Which model translates, where it lives, and how its request is shaped.
//
// This was four hardcoded defaults inside `cmdTranslateApi` and one request body
// in Anthropic's shape sent to whatever URL you pointed at — so aiming the
// engine at an OpenAI-compatible endpoint produced a body that endpoint does not
// accept, and the failure looked like a bad key.
//
// A provider is now a ROW, for the same reason a plural dialect is: the thing
// that varies between OpenAI, Anthropic, Ollama and a company gateway is a URL,
// a header, a field name and a place to read the answer from. None of that is
// logic, and none of it should cost a branch.
//
// Everything is overridable, and the precedence is the ordinary one:
//
//   --flag  >  ULTRAI18N_* env  >  .ultrai18n/config.json  >  the preset
//
// The default tier is deliberately SMALL. This engine hands a model eight short
// strings at a time with a contract that fits on a page; that is not work a
// frontier model does better, and paying frontier prices per batch is how a
// cheap operation becomes an expensive one.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Provider {
  id: string
  title: string
  docs: string
  endpoint: string
  /**
   * The small tier, because that is what this workload wants.
   *
   * A conservative, long-lived id rather than the newest: a default that stops
   * existing is worse than one that is merely not the latest, and `--model`
   * overrides it in one word.
   */
  model: string
  keyEnv: string
  headers?: Record<string, string>
  /** Which request/response shape this endpoint speaks. */
  wire: 'anthropic' | 'openai'
}

export const PROVIDERS: Provider[] = [
  {
    id: 'anthropic',
    title: 'Anthropic Messages API',
    docs: 'https://docs.anthropic.com/en/api/messages',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-haiku-4-5-20251001',
    keyEnv: 'ANTHROPIC_API_KEY',
    headers: { 'anthropic-version': '2023-06-01' },
    wire: 'anthropic',
  },
  {
    id: 'openai',
    title: 'OpenAI Chat Completions',
    docs: 'https://platform.openai.com/docs/api-reference/chat',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    keyEnv: 'OPENAI_API_KEY',
    wire: 'openai',
  },
  {
    id: 'openai-compatible',
    title: 'Anything speaking the OpenAI wire format',
    docs: 'https://platform.openai.com/docs/api-reference/chat',
    // Ollama's default. Point `--endpoint` anywhere: a gateway, vLLM, LM Studio,
    // a company proxy. The key env is optional for a local server, which is why
    // a missing key is only an error when the endpoint is not on localhost.
    endpoint: 'http://localhost:11434/v1/chat/completions',
    model: 'qwen2.5:3b',
    keyEnv: 'OPENAI_API_KEY',
    wire: 'openai',
  },
]

export const PROVIDERS_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]))

export interface ResolvedProvider {
  provider: string
  endpoint: string
  model: string
  keyEnv: string
  headers: Record<string, string>
  wire: 'anthropic' | 'openai'
  maxTokens: number
  /** Where each field came from, so `translate --backend api --json` can say. */
  from: Record<string, 'flag' | 'env' | 'config' | 'preset'>
}

export interface ProviderOverrides {
  provider?: string
  endpoint?: string
  model?: string
  keyEnv?: string
  maxTokens?: number
  headers?: Record<string, string>
}

interface FileConfig {
  translate?: ProviderOverrides
}

/**
 * Resolve one provider from flags, environment, config file and preset.
 *
 * Reading the config file here rather than in the CLI keeps the precedence in
 * one place: three call sites each merging their own defaults is how a `--model`
 * flag ends up being ignored on one path and honoured on another.
 */
export function resolveProvider(
  repo: string,
  flags: ProviderOverrides = {},
  configPath?: string,
): ResolvedProvider {
  const file = readConfig(configPath ?? join(repo, '.ultrai18n', 'config.json'))
  const env = readEnv()

  const id =
    flags.provider ?? env.provider ?? file.provider ?? 'anthropic'
  const preset = PROVIDERS_BY_ID.get(id)
  if (!preset) {
    throw new Error(
      `unknown provider ${JSON.stringify(id)} — known: ${PROVIDERS.map((p) => p.id).join(', ')}. ` +
        `Any other endpoint speaking the OpenAI wire format works with --provider openai-compatible --endpoint <url>.`,
    )
  }

  const from: ResolvedProvider['from'] = {}
  const pick = <K extends keyof ProviderOverrides>(key: K, fallback: NonNullable<ProviderOverrides[K]>) => {
    if (flags[key] !== undefined) {
      from[key as string] = 'flag'
      return flags[key] as NonNullable<ProviderOverrides[K]>
    }
    if (env[key] !== undefined) {
      from[key as string] = 'env'
      return env[key] as NonNullable<ProviderOverrides[K]>
    }
    if (file[key] !== undefined) {
      from[key as string] = 'config'
      return file[key] as NonNullable<ProviderOverrides[K]>
    }
    from[key as string] = 'preset'
    return fallback
  }

  from.provider = flags.provider ? 'flag' : env.provider ? 'env' : file.provider ? 'config' : 'preset'

  return {
    provider: preset.id,
    endpoint: pick('endpoint', preset.endpoint),
    model: pick('model', preset.model),
    keyEnv: pick('keyEnv', preset.keyEnv),
    maxTokens: pick('maxTokens', 4096),
    headers: { ...preset.headers, ...file.headers, ...flags.headers },
    wire: preset.wire,
    from,
  }
}

function readEnv(): ProviderOverrides {
  const out: ProviderOverrides = {}
  const e = process.env
  if (e.ULTRAI18N_PROVIDER) out.provider = e.ULTRAI18N_PROVIDER
  if (e.ULTRAI18N_ENDPOINT) out.endpoint = e.ULTRAI18N_ENDPOINT
  if (e.ULTRAI18N_MODEL) out.model = e.ULTRAI18N_MODEL
  if (e.ULTRAI18N_KEY_ENV) out.keyEnv = e.ULTRAI18N_KEY_ENV
  if (e.ULTRAI18N_MAX_TOKENS) out.maxTokens = Number(e.ULTRAI18N_MAX_TOKENS)
  return out
}

function readConfig(path: string): ProviderOverrides {
  if (!existsSync(path)) return {}
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as FileConfig).translate ?? {}
  } catch (err) {
    throw new Error(`${path} is not readable JSON: ${(err as Error).message}`)
  }
}

/**
 * The request body, in the shape this endpoint actually accepts.
 *
 * The two wire formats differ in exactly three places: where the system prompt
 * goes, what the token cap is called, and where the answer sits. Sending
 * Anthropic's shape to an OpenAI endpoint — which is what this did — produces a
 * 400 that reads like an auth problem.
 */
export function requestBody(p: ResolvedProvider, contract: string, payload: string): unknown {
  if (p.wire === 'anthropic') {
    return {
      model: p.model,
      max_tokens: p.maxTokens,
      system: contract,
      messages: [{ role: 'user', content: payload }],
    }
  }
  return {
    model: p.model,
    max_completion_tokens: p.maxTokens,
    messages: [
      { role: 'system', content: contract },
      { role: 'user', content: payload },
    ],
    // Both wire formats accept it and both ignore it when unsupported; a model
    // that honours it stops wrapping the answer in prose.
    response_format: { type: 'json_object' },
  }
}

export function requestHeaders(p: ResolvedProvider, key: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...p.headers }
  if (!key) return headers
  // One auth header per wire format rather than both on every request: sending
  // an `x-api-key` to OpenAI is harmless but sending a bearer token to a gateway
  // that logs headers is not.
  if (p.wire === 'anthropic') headers['x-api-key'] = key
  else headers.authorization = `Bearer ${key}`
  return headers
}

/** Read the text out of whichever envelope came back. */
export function readAnswer(p: ResolvedProvider, body: unknown): string {
  const b = body as {
    content?: { text?: string }[]
    choices?: { message?: { content?: string } }[]
  }
  return (p.wire === 'anthropic' ? b.content?.[0]?.text : b.choices?.[0]?.message?.content) ?? ''
}

/** A local endpoint may legitimately have no key. A remote one may not. */
export function keyRequired(endpoint: string): boolean {
  return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/)/.test(endpoint)
}

export function formatProviders(resolved: ResolvedProvider): string {
  const lines = [`ultrai18n translate — provider ${resolved.provider}`, '']
  for (const [key, value] of [
    ['endpoint', resolved.endpoint],
    ['model', resolved.model],
    ['key env', resolved.keyEnv],
    ['max tokens', String(resolved.maxTokens)],
  ] as const) {
    const source = resolved.from[key === 'key env' ? 'keyEnv' : key === 'max tokens' ? 'maxTokens' : key]
    lines.push(`  ${key.padEnd(12)}${String(value).padEnd(46)}${source ? `(${source})` : ''}`)
  }
  lines.push('')
  lines.push('  Known providers: ' + PROVIDERS.map((p) => `${p.id} → ${p.model}`).join(', '))
  return lines.join('\n')
}
