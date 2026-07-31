import { describe, it, expect } from 'vitest'
import { detect, normalizeForDetection, isCognate, bucketOf } from '../src/lang/detect'

const lang = (s: string) => detect(s).detected

describe('real strings from the motivating repo', () => {
  it('identifies French prose', () => {
    expect(lang('Un minuteur de focus local-first, avec tâches et alertes.')).toBe('fr')
    expect(lang('Quelque chose ne marche pas comme prévu.')).toBe('fr')
    expect(lang("Pendant les focus uniquement. Consomme de la batterie.")).toBe('fr')
    expect(lang('Les messages de commit et les commentaires sont en français.')).toBe('fr')
  })

  it('identifies English prose', () => {
    expect(lang('A local-first focus timer with tasks, alerts and real statistics.')).toBe('en')
    expect(lang('The timer stops dead at zero. The original technique.')).toBe('en')
    expect(lang("Logging an interruption doesn't stop the timer.")).toBe('en')
  })

  it('separates the other shipped languages', () => {
    expect(lang('Un temporizador de enfoque con tareas y estadísticas.')).toBe('es')
    expect(lang('Ein Fokus-Timer mit Aufgaben und echten Statistiken.')).toBe('de')
    expect(lang('Un timer per la concentrazione con attività e statistiche.')).toBe('it')
    expect(lang('Um temporizador de foco com tarefas e estatísticas.')).toBe('pt')
  })

  it('uses the script gate for non-Latin text', () => {
    expect(detect('Таймер фокусировки').detected).toBe('ru')
    expect(detect('フォーカスタイマー').detected).toBe('ja')
  })
})

describe('refusing to answer is the correct answer', () => {
  it('declines on strings below the length threshold', () => {
    // "OK" is a word in eight of the shipped languages. A confident answer here
    // is a coin flip wearing a number.
    for (const s of ['OK', 'Menu', 'Focus', 'Stats', 'Timer']) {
      const g = detect(s)
      expect(g.detected).toBeNull()
      expect(g.bucket).toBe('short')
    }
  })

  it('declines on cross-language cognates whatever their length', () => {
    // "Notifications" IS the French for "Notifications". Flagging it as an
    // untranslated string is how a validator teaches users to ignore it.
    for (const s of ['Notifications', 'Configuration', 'Documentation', 'Installation']) {
      expect(detect(s).detected).toBeNull()
      expect(isCognate(s)).toBe(true)
    }
  })

  it('declines when a medium-length string has no clear winner', () => {
    const g = detect('Total normal')
    expect(g.detected).toBeNull()
  })

  it('says why it declined, and offers what it was weighing', () => {
    // 'Focus' rather than 'Menu': Menu is in the cognate set, so it declines
    // for a different and equally correct reason.
    const g = detect('Focus')
    expect(g.signals[0]).toMatch(/length threshold/)
    expect(g.method).toBe('none')
  })

  it('declines on a string with no letters', () => {
    expect(detect('25 / 5').detected).toBeNull()
    expect(detect('—').detected).toBeNull()
  })
})

describe('normalization', () => {
  it('strips placeholders, so a hole cannot vote', () => {
    expect(normalizeForDetection('Move {0} up')).toBe('Move up')
    expect(normalizeForDetection('{0} of {1} sessions')).toBe('of sessions')
  })

  it('strips identifiers, so a variable name cannot look like English', () => {
    expect(normalizeForDetection('task.title taskTitle TASK_TITLE task-title')).toBe('')
  })

  it('strips URLs and code spans', () => {
    expect(normalizeForDetection('Ouvrez https://example.com/x puis `npm run build`')).toBe(
      'Ouvrez puis',
    )
  })

  it('keeps accented words intact', () => {
    expect(normalizeForDetection('Données effacées.')).toBe('Données effacées.')
  })
})

describe('signals', () => {
  it('uses orthography as a high-precision signal', () => {
    const g = detect('Réglages généraux du système')
    expect(g.detected).toBe('fr')
    expect(g.signals.some((s) => s.startsWith('ortho:fr'))).toBe(true)
  })

  it('distinguishes Portuguese from Spanish by orthography', () => {
    expect(lang('Configurações e informações da aplicação')).toBe('pt')
    expect(lang('Configuración e información de la aplicación')).toBe('es')
  })

  it('reports alternatives it considered', () => {
    const g = detect('Un minuteur de focus local-first, avec tâches et alertes.')
    expect(g.alternatives.length).toBeGreaterThan(0)
    expect(g.confidence).toBeGreaterThan(0.5)
  })

  it('can be narrowed to a candidate set, which raises precision', () => {
    const g = detect('Sessions de travail terminées', { candidates: ['en', 'fr'] })
    expect(g.detected).toBe('fr')
  })
})

describe('buckets', () => {
  it('classifies by letter count after normalization', () => {
    expect(bucketOf(0)).toBe('none')
    expect(bucketOf(7)).toBe('short')
    expect(bucketOf(19)).toBe('medium')
    expect(bucketOf(59)).toBe('long')
    expect(bucketOf(60)).toBe('very-long')
  })

  it('counts letters, not characters', () => {
    expect(detect('Move {0} up to the top of the list now').letters).toBe(26)
  })
})
