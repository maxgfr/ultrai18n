#!/usr/bin/env node
// A translator that does not translate.
//
// It exists to exercise the PLUMBING end to end — batching, folding,
// validation, byte-offset writing, insertion — without a network call or a key.
// It answers every item in the shape the contract demands and nothing more, so
// a failure in a pipeline run driven by this is a failure in the pipeline.
//
// For a plural family it echoes a source form into every category the target
// asks for. That is a terrible translation and a perfectly good test: the
// interesting question is whether four Russian forms come back out of a
// two-form source and land in the file, not whether `many` reads well.
import { readFileSync } from 'node:fs'

const batch = JSON.parse(readFileSync(0, 'utf8'))

const items = batch.items.map((item) => {
  if (!item.plural) return { id: item.id, text: item.text }

  const source = item.plural.forms
  const fallback = source.other ?? Object.values(source)[0] ?? ''
  const forms = {}
  for (const category of item.plural.targetCategories) {
    forms[category] = source[category] ?? fallback
  }
  return { id: item.id, forms }
})

process.stdout.write(JSON.stringify({ batchId: batch.batchId, batchDigest: batch.batchDigest, items }))
