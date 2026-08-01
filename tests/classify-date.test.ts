// Date/time patterns, which are locale-dependent and look symbolic.
//
// The case that motivated this: `'EEEE d MMMM yyyy \'à\' HH:mm'` reached the
// language detector, read as French because of the quoted word inside it, and
// came back `translate` — where a model renders the field letters into another
// language and every date on the site breaks. Its two short siblings in the same
// object were refused, so the file gave three different answers to one question.
import { describe, it, expect } from 'vitest'
import { isDatePattern } from '../src/classify'

describe('isDatePattern', () => {
  it('recognises patterns that separate their fields', () => {
    for (const p of ['dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'dd.MM.yyyy', 'HH:mm:ss', 'hh:mm a', 'd MMM yyyy']) {
      expect(isDatePattern(p), p).toBe(true)
    }
  })

  it('recognises patterns that pack their fields as runs', () => {
    expect(isDatePattern('yyyyMMdd')).toBe(true)
    expect(isDatePattern('MMMyy')).toBe(true)
  })

  it('sees through a quoted literal, which is where the human word hides', () => {
    expect(isDatePattern("EEEE d MMMM yyyy 'à' HH:mm")).toBe(true)
    expect(isDatePattern("d MMMM 'de' yyyy")).toBe(true)
  })

  it('leaves prose alone', () => {
    for (const s of [
      'Enregistrement en cours',
      'Toutes les modifications sont enregistrées',
      'Publier',
      'déjà vu',
      'Aucun projet pour le moment',
    ]) {
      expect(isDatePattern(s), s).toBe(false)
    }
  })

  it('leaves alone the French words spelled entirely from field letters', () => {
    // Every one of these is made only of date field letters and contains a
    // doubled pair. Requiring a separator OR full run coverage is what keeps
    // them out, and dropping that condition brings all three back.
    for (const s of ['masse', 'assez', 'Sammy', 'sale', 'assemblee']) {
      expect(isDatePattern(s), s).toBe(false)
    }
  })

  it('needs two distinct fields, so a repeated letter is not a pattern', () => {
    expect(isDatePattern('aaa')).toBe(false)
    expect(isDatePattern('yyyy')).toBe(false)
  })

  it('refuses anything too short to be a pattern', () => {
    expect(isDatePattern('as')).toBe(false)
    expect(isDatePattern('')).toBe(false)
  })
})
