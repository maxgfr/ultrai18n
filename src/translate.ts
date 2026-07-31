// translate: hand groups out, fold results back.
//
// The model sees `{id, text}` and a typed envelope. Nothing else, ever. It does
// not receive the file, the line, the surrounding source, or the component
// name — a model translating "Yes, erase it all" gains nothing from knowing
// which file it lives in, and giving it the file both multiplies the cost and
// hands it the opportunity to rewrite code.
//
// `role` is the one context lever, and it carries its weight: one token in
// place of a paragraph of register instructions, with the instructions
// themselves living once, in the agent contract.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Group } from './plan'
import { validate, validatePlural, rejects, type Violation } from './validate'

export interface BatchItem {
  id: string
  text: string
  role: string
  /** Present only when the host constrains the length. */
  max?: number
  /** Gloss per placeholder, so a translator with no file access can reorder them. */
  holes?: Record<string, string>
  /** How many places this text appears — a hint to translate conservatively. */
  sites?: number
  /**
   * Present when the item is a plural family rather than a single string.
   *
   * The item then asks for `forms`, not `text`. Everything the answer needs is
   * here: which forms exist, which the target selects, and which placeholders
   * are real. The model is never shown the ICU skeleton or the key names — the
   * engine owns those, exactly as it owns the file.
   */
  plural?: {
    op: 'translate' | 'complete'
    forms: Record<string, string>
    targetCategories: string[]
    placeholders: string[]
  }
}

export interface Batch {
  schemaVersion: 1
  batchId: string
  /** Digest of the canonical batch bytes; a result computed against a stale batch is rejected. */
  batchDigest: string
  sourceLang: string
  targetLang: string
  project: { name: string; domain?: string; tone?: string }
  glossary: { src: string; tgt: string; pin: boolean }[]
  items: BatchItem[]
}

export interface BatchResult {
  batchId: string
  batchDigest?: string
  items: { id: string; text?: string; forms?: Record<string, string>; refuse?: string }[]
}

export const BATCH_SIZE = 8

export interface BuildBatchesOptions {
  sourceLang: string
  targetLang: string
  project: Batch['project']
  glossary?: Map<string, { text: string; pin: boolean }>
  batchSize?: number
}

export function buildBatches(groups: Group[], opts: BuildBatchesOptions): Batch[] {
  const pending = groups.filter((g) => g.status === 'pending')
  const size = opts.batchSize ?? BATCH_SIZE
  const batches: Batch[] = []

  for (let i = 0; i < pending.length; i += size) {
    const slice = pending.slice(i, i + size)
    const items: BatchItem[] = slice.map((g) => ({
      id: g.id,
      text: g.text,
      role: g.role,
      ...(g.max !== null ? { max: g.max } : {}),
      ...(Object.keys(g.holeGloss).length ? { holes: g.holeGloss } : {}),
      ...(g.sites.length + g.mirrors.length > 1 ? { sites: g.sites.length + g.mirrors.length } : {}),
      ...(g.plural
        ? {
            plural: {
              op: g.plural.op,
              forms: g.plural.forms,
              targetCategories: g.plural.targetCategories,
              placeholders: g.plural.placeholders,
            },
          }
        : {}),
    }))

    // Only the glossary entries this batch can actually use, so the envelope
    // stays proportional to the work rather than to the term store.
    const glossary = sliceGlossary(opts.glossary, items)

    const batch: Batch = {
      schemaVersion: 1,
      batchId: String(batches.length).padStart(3, '0'),
      batchDigest: '',
      sourceLang: opts.sourceLang,
      targetLang: opts.targetLang,
      project: opts.project,
      glossary,
      items,
    }
    batch.batchDigest = digestOf(batch)
    batches.push(batch)
  }
  return batches
}

function sliceGlossary(
  glossary: Map<string, { text: string; pin: boolean }> | undefined,
  items: BatchItem[],
): Batch['glossary'] {
  if (!glossary) return []
  const haystack = items.map((i) => i.text).join('\n')
  const out: Batch['glossary'] = []
  for (const [src, entry] of glossary) {
    const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const used = new RegExp(`(^|\\P{L})${escaped}(\\P{L}|$)`, 'iu').test(haystack)
    if (used || entry.pin) out.push({ src, tgt: entry.text, pin: entry.pin })
    if (out.length >= 25) break
  }
  return out.sort((a, b) => (a.src < b.src ? -1 : 1))
}

function digestOf(batch: Batch): string {
  const canonical = JSON.stringify({
    sourceLang: batch.sourceLang,
    targetLang: batch.targetLang,
    items: batch.items,
    glossary: batch.glossary,
  })
  // A stable digest over the INPUT lets `translate --apply` reject a result
  // that was computed against a batch which has since changed — the same
  // re-read-before-trusting reflex the verification gate uses, applied to the
  // input side.
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Folding results
// ---------------------------------------------------------------------------

export interface FoldOptions {
  groups: Group[]
  glossary?: Map<string, { text: string; pin: boolean }>
  /** Reject a result whose digest does not match the batch it claims to answer. */
  batches?: Batch[]
}

export interface FoldedTranslation {
  groupId: string
  text: string
  /** Set when the group is a plural family: the target's forms, by category. */
  forms?: Record<string, string>
  violations: Violation[]
}

export interface FoldReport {
  accepted: FoldedTranslation[]
  /** Rejected items, with why — these go into a repair batch, not the bin. */
  rejected: { groupId: string; text: string; violations: Violation[] }[]
  /** The model declined, which is a legitimate answer for a structural case. */
  refused: { groupId: string; why: string }[]
  /** Ids in the result that no batch asked for: the model invented them. */
  unknown: string[]
  /** Ids the batch asked for and the result omitted. */
  missing: string[]
}

export function foldResults(results: BatchResult[], opts: FoldOptions): FoldReport {
  const byId = new Map(opts.groups.map((g) => [g.id, g]))
  const report: FoldReport = { accepted: [], rejected: [], refused: [], unknown: [], missing: [] }

  const answered = new Set<string>()
  for (const result of results) {
    const batch = opts.batches?.find((b) => b.batchId === result.batchId)
    if (batch && result.batchDigest && result.batchDigest !== batch.batchDigest) {
      throw new Error(
        `batch ${result.batchId}: the result was computed against a different batch (digest ${result.batchDigest} ≠ ${batch.batchDigest}) — re-run translate`,
      )
    }

    for (const item of result.items) {
      const group = byId.get(item.id)
      if (!group) {
        report.unknown.push(item.id)
        continue
      }
      answered.add(item.id)
      if (item.refuse) {
        report.refused.push({ groupId: item.id, why: item.refuse })
        continue
      }
      // A plural family answers with `forms`, never with `text`: there is no
      // single string to return when the target decides how many there are.
      if (group.plural) {
        const forms = item.forms
        if (!forms) {
          report.rejected.push({
            groupId: item.id,
            text: '',
            violations: [
              {
                validator: 'V9',
                severity: 'reject',
                message: `this is a plural family — answer with forms for ${group.plural.targetCategories.join(', ')}, not a single text`,
              },
            ],
          })
          continue
        }
        const violations = validatePlural(
          forms,
          group.plural.targetCategories,
          group.plural.placeholders,
        )
        const entry = { groupId: item.id, text: forms.other ?? Object.values(forms)[0] ?? '', forms, violations }
        if (rejects(violations)) report.rejected.push(entry)
        else report.accepted.push(entry)
        continue
      }

      if (item.text === undefined) {
        report.rejected.push({
          groupId: item.id,
          text: '',
          violations: [{ validator: 'V6', severity: 'reject', message: 'no text and no refusal' }],
        })
        continue
      }
      const violations = validate(group, item.text, { glossary: opts.glossary })
      if (rejects(violations)) report.rejected.push({ groupId: item.id, text: item.text, violations })
      else report.accepted.push({ groupId: item.id, text: item.text, violations })
    }
  }

  if (opts.batches) {
    for (const batch of opts.batches) {
      for (const item of batch.items) {
        if (!answered.has(item.id)) report.missing.push(item.id)
      }
    }
  }
  return report
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

export type BackendKind = 'subagent' | 'cli' | 'api' | 'manual'

export interface CliBackendOptions {
  command: string
  cwd: string
  timeoutMs?: number
  retries?: number
  sourceLang: string
  targetLang: string
}

/**
 * The generic escape hatch: batch JSON on stdin, result JSON on stdout.
 *
 * Tolerances are narrow and enumerated on purpose. Trimming whitespace and
 * stripping one fenced block covers how real CLIs actually behave; "find the
 * JSON somewhere in the prose" would make a malformed answer look like a good
 * one, which is the failure this whole design is built to avoid.
 */
export function runCliBackend(batch: Batch, opts: CliBackendOptions): BatchResult {
  const retries = opts.retries ?? 2
  let lastError = ''

  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = spawnSync('sh', ['-c', opts.command], {
      cwd: opts.cwd,
      input: JSON.stringify(batch, null, 2),
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 1 << 26,
      env: {
        ...process.env,
        ULTRAI18N_SOURCE_LANG: opts.sourceLang,
        ULTRAI18N_TARGET_LANG: opts.targetLang,
        ULTRAI18N_BATCH_ID: batch.batchId,
        ULTRAI18N_ROLE: 'translate',
      },
    })

    if (r.error) {
      lastError = r.error.message
    } else if (r.status !== 0) {
      lastError = `exit ${r.status}: ${(r.stderr?.toString() ?? '').slice(0, 200)}`
    } else {
      const parsed = parseResult(r.stdout?.toString() ?? '', batch.batchId)
      if (parsed) return parsed
      lastError = 'stdout was not the expected JSON'
    }
    if (attempt < retries) {
      // Fixed backoff, not jittered: a reproducible run is worth more here than
      // a marginally kinder retry curve.
      spawnSync('sh', ['-c', `sleep ${attempt === 0 ? 1 : 4}`])
    }
  }
  throw new Error(`translator failed for batch ${batch.batchId} after ${retries + 1} attempt(s): ${lastError}`)
}

export function parseResult(stdout: string, batchId: string): BatchResult | null {
  let body = stdout.trim()
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(body)
  if (fence) body = fence[1]!.trim()
  try {
    const parsed: unknown = JSON.parse(body)
    if (Array.isArray(parsed)) return { batchId, items: parsed as BatchResult['items'] }
    const obj = parsed as BatchResult
    if (Array.isArray(obj.items)) return { ...obj, batchId: obj.batchId ?? batchId }
    return null
  } catch {
    return null
  }
}

export interface ApiBackendOptions {
  endpoint: string
  model: string
  keyEnv: string
  headers?: Record<string, string>
  sourceLang: string
  targetLang: string
  contract: string
  timeoutMs?: number
}

/**
 * Direct HTTP, using the same contract text the subagent path uses.
 *
 * One source of truth for the register rules matters more than it looks: a
 * second copy drifts, and then the same repository translated through two
 * backends comes out in two voices.
 */
export async function runApiBackend(batch: Batch, opts: ApiBackendOptions): Promise<BatchResult> {
  const key = process.env[opts.keyEnv]
  if (!key) {
    throw new Error(
      `$${opts.keyEnv} is not set — set it, or use --translator '<command>', or --backend manual`,
    )
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000)
  try {
    const response = await fetch(opts.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        authorization: `Bearer ${key}`,
        ...opts.headers,
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 4096,
        system: opts.contract,
        messages: [{ role: 'user', content: JSON.stringify(batch, null, 2) }],
      }),
    })
    if (!response.ok) {
      throw new Error(`${opts.endpoint} returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }
    const body = (await response.json()) as {
      content?: { text?: string }[]
      choices?: { message?: { content?: string } }[]
    }
    const text = body.content?.[0]?.text ?? body.choices?.[0]?.message?.content ?? ''
    const parsed = parseResult(text, batch.batchId)
    if (!parsed) throw new Error(`batch ${batch.batchId}: the response was not the expected JSON`)
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

/** The contract handed to a translating agent. The register rules live here, once. */
export const TRANSLATOR_CONTRACT = `# Contract: translator

You translate short user-interface strings. Handle ONLY the batch files named in
your prompt.

For each batch, read its JSON and return one \`{id, text}\` per item — the same
ids, nothing else.

- Keep every \`{0}\`-style placeholder: the same set, in any order. Never drop,
  duplicate or invent one.
- Never emit \`\${\`, a backtick, or \`{{\`.
- Respect \`max\` as a hard character limit when it is present.
- Use each glossary entry's \`tgt\` verbatim.
- \`role\` sets the register:
  - \`button\`, \`tab\`, \`menu-item\`, \`label\` — imperative and terse, no final period
  - \`paragraph\`, \`list-item\`, \`doc-prose\` — full sentences
  - \`aria-label\`, \`alt\` — descriptive; never begin with "button" or "image"
  - \`error\`, \`status\` — plain, no blame
  - \`heading\`, \`doc-heading\` — noun phrase, no final period
- If a string cannot be translated without restructuring the surrounding code,
  return \`{id, refuse: "<one line why>"}\` rather than guessing.

## Items with a \`plural\` field

These are plural FAMILIES. Answer with \`{id, forms: {...}}\` — never \`text\`.

- \`plural.forms\` is what the source has, keyed by CLDR category.
- \`plural.targetCategories\` is exactly the set of keys your answer must have.
  Not a subset, not a superset. It is often a different SIZE from the source:
  English has two forms and Russian needs four, Japanese needs one. Write each
  form so it is correct for the numbers that category actually covers — Russian
  \`few\` covers 2–4, \`many\` covers 0 and 5–20. Do not copy one form into the
  others to fill the shape.
- \`plural.op\` is \`translate\` when you are moving the family into another
  language, and \`complete\` when the family is already in the target language and
  is missing forms that language needs. For \`complete\`, keep the existing forms
  as they are written and supply only what is absent, in the same voice.
- \`plural.placeholders\` lists every placeholder the source uses. You may use
  any of them and you may leave one out — "One item" is better English than
  "1 item" — but never invent one that is not in that list. \`#\` is the number
  itself and is a placeholder like any other.
- Return no ICU syntax, no braces of your own, and no key names. You are writing
  the text of each form; the engine writes the syntax around it.

**Do not open any repository file. Do not write, edit or delete anything.** The
batch is the whole context you need and the whole context you get: the
orchestrator folds your results and the engine writes the files by byte offset.
`
