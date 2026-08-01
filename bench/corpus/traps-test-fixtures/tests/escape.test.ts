// Ces chaînes existent pour exercer l'échappement. Les traduire laisse le test
// vert en ne testant plus rien, ce qui est pire que de le casser.
import { describe, it, expect } from 'vitest'
import { escapeJson } from '../src/escape'

describe('escapeJson', () => {
  it('échappe les guillemets', () => {
    expect(escapeJson('a"b')).toBe('a\\"b')
  })

  it('échappe les antislashs', () => {
    expect(escapeJson('c\\d')).toBe('c\\\\d')
  })

  it('laisse les accents intacts', () => {
    expect(escapeJson('déjà vu')).toBe('déjà vu')
  })
})
