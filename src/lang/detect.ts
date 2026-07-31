// Zero-dependency language detection, sized for the job it actually has.
//
// The job is not "identify the language of this document" — it is "decide
// whether this UI string is still in the source language". Those differ in a
// way that matters: the input is usually four words, sometimes one, and a
// detector that answers confidently on one word is worse than useless here,
// because a wrong confident answer silently translates an identifier or
// silently leaves French in an English build.
//
// So the design leans on precision over coverage: a script gate, discriminative
// stopwords, and orthographic markers — all high-precision signals — and it
// REFUSES below a length threshold rather than guessing. Cohort inheritance
// (see inherit.ts) is what makes that refusal cheap instead of a wall of
// unanswered sites.
import type { LanguageGuess } from '../types'

export const SUPPORTED = [
  'en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'sv', 'da', 'pl', 'ro', 'tr', 'ru', 'ja',
] as const
export type Lang = (typeof SUPPORTED)[number]

/**
 * Words frequent in one language and rare in the others shipped here.
 *
 * Built by taking common function words and then DROPPING every one that is
 * also common elsewhere: `a`, `de`, `la`, `no`, `in`, `on`, `so`, `e`, `o`, `y`
 * are all absent on purpose. A stopword that appears in four of these lists
 * contributes noise to all four scores and discrimination to none.
 */
const STOPWORDS: Record<Lang, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'that', 'with', 'this', 'for', 'from', 'have', 'are',
    'was', 'will', 'would', 'should', 'which', 'their', 'there', 'been', 'were', 'what',
    'when', 'your', 'you', 'not', 'but', 'all', 'can', 'has', 'more', 'than', 'then',
    'them', 'these', 'they', 'into', 'only', 'other', 'some', 'such', 'use', 'used',
    'using', 'does', 'after', 'before', 'between', 'during', 'without', 'while', 'where',
    'about', 'again', 'each', 'both', 'must', 'may', 'its', 'it', 'be'],
  fr: ['les', 'des', 'une', 'dans', 'pour', 'avec', 'sans', 'mais', 'donc', 'être', 'cette',
    'qui', 'que', 'dont', 'où', 'aussi', 'ainsi', 'alors', 'après', 'avant', 'chaque',
    'comme', 'encore', 'entre', 'leur', 'même', 'notre', 'nous', 'plus', 'quand', 'sont',
    'sous', 'tout', 'toute', 'toutes', 'tous', 'très', 'vous', 'votre', 'elle', 'depuis',
    'déjà', 'peut', 'peuvent', 'selon', 'lorsque', 'ceux', 'celle', 'celui', 'jamais',
    'toujours', 'était', 'sera', 'faire', 'fait', 'doit', 'doivent', 'ne', 'pas', 'du',
    'au', 'aux', 'est', 'ou', 'si', 'par', 'sur', 'un', 'le'],
  es: ['los', 'las', 'una', 'del', 'para', 'con', 'pero', 'porque', 'cuando', 'más', 'muy',
    'este', 'esta', 'estos', 'sobre', 'hasta', 'desde', 'también', 'así', 'según',
    'después', 'hacer', 'tiene', 'puede', 'está', 'están', 'ser', 'son', 'todo', 'todos',
    'otro', 'otra', 'aunque', 'mientras', 'entre', 'sin', 'que', 'el', 'un', 'se', 'lo'],
  de: ['der', 'die', 'das', 'den', 'dem', 'eine', 'einen', 'einem', 'und', 'nicht', 'mit',
    'für', 'von', 'auf', 'aus', 'bei', 'nach', 'über', 'unter', 'durch', 'ohne', 'wird',
    'werden', 'wurde', 'sind', 'ist', 'war', 'haben', 'hat', 'kann', 'können', 'muss',
    'müssen', 'soll', 'auch', 'aber', 'wenn', 'dann', 'noch', 'nur', 'schon', 'sehr',
    'mehr', 'alle', 'diese', 'dieser', 'dieses', 'welche', 'zum', 'zur', 'ein'],
  it: ['il', 'gli', 'della', 'delle', 'dei', 'per', 'con', 'perché', 'quando', 'più',
    'molto', 'questo', 'questa', 'sono', 'essere', 'anche', 'ancora', 'dopo', 'nella',
    'nel', 'sulla', 'sul', 'senza', 'come', 'tutto', 'tutti', 'può', 'deve', 'fare',
    'prima', 'tra', 'una', 'che', 'non', 'del'],
  pt: ['os', 'das', 'dos', 'para', 'com', 'mas', 'porque', 'quando', 'mais', 'muito',
    'este', 'esta', 'são', 'ter', 'fazer', 'pode', 'também', 'ainda', 'depois', 'não',
    'já', 'só', 'você', 'sem', 'sobre', 'até', 'desde', 'onde', 'como', 'todos', 'uma',
    'ser', 'que', 'nao'],
  nl: ['het', 'een', 'van', 'met', 'voor', 'aan', 'door', 'naar', 'uit', 'bij', 'niet',
    'maar', 'ook', 'als', 'wel', 'kunnen', 'moeten', 'wordt', 'worden', 'zijn', 'hebben',
    'heeft', 'deze', 'dit', 'dat', 'die', 'alle', 'meer', 'zeer', 'over', 'onder', 'kan',
    'moet', 'zich', 'nog'],
  sv: ['och', 'att', 'det', 'som', 'en', 'på', 'är', 'för', 'med', 'den', 'har', 'de',
    'inte', 'om', 'ett', 'men', 'var', 'kan', 'från', 'eller', 'när', 'också', 'efter',
    'utan', 'över', 'mycket', 'alla', 'andra', 'sedan', 'vara'],
  da: ['og', 'det', 'som', 'på', 'er', 'for', 'med', 'den', 'har', 'de', 'ikke', 'om',
    'et', 'men', 'var', 'kan', 'fra', 'eller', 'når', 'også', 'efter', 'uden', 'over',
    'meget', 'alle', 'andre', 'siden', 'være', 'til', 'af'],
  pl: ['nie', 'jest', 'się', 'że', 'na', 'do', 'to', 'jak', 'ale', 'lub', 'oraz', 'przez',
    'dla', 'przy', 'pod', 'nad', 'bez', 'być', 'może', 'także', 'jeszcze', 'tylko',
    'bardzo', 'wszystkie', 'który', 'która', 'które', 'gdy', 'już', 'tego'],
  ro: ['este', 'sunt', 'care', 'pentru', 'din', 'cu', 'nu', 'dar', 'sau', 'când', 'unde',
    'cum', 'mai', 'foarte', 'toate', 'acest', 'această', 'poate', 'trebuie', 'după',
    'înainte', 'între', 'fără', 'despre', 'până', 'deja', 'încă'],
  tr: ['bir', 'için', 'ile', 'bu', 'da', 'de', 've', 'veya', 'ama', 'çok', 'daha', 'gibi',
    'kadar', 'sonra', 'önce', 'olarak', 'olan', 'var', 'yok', 'değil', 'her', 'bütün',
    'hangi', 'nasıl', 'neden', 'zaman'],
  ru: ['и', 'в', 'не', 'на', 'что', 'с', 'по', 'это', 'для', 'как', 'все', 'или', 'но',
    'если', 'может', 'быть', 'уже', 'при', 'так', 'его', 'нет', 'вы', 'из'],
  ja: [],
}

/**
 * Orthographic markers, weighted by how EXCLUSIVE they are.
 *
 * The trap here is treating a shared diacritic as decisive. `à` is French and
 * Italian and Portuguese and Catalan: scoring it as a strong French signal
 * makes "attività e statistiche" French, which it plainly is not. So the strong
 * weights go only to characters and endings that one language essentially owns,
 * and the shared accents contribute a nudge that lets stopwords decide.
 */
const ORTHOGRAPHY: { lang: Lang; re: RegExp; weight: number }[] = [
  // Exclusive, or near enough to be decisive on their own.
  { lang: 'es', re: /[ñ¿¡]/, weight: 1 },
  { lang: 'pt', re: /[ãõ]/i, weight: 1 },
  { lang: 'de', re: /[äöüß]/i, weight: 0.85 },
  { lang: 'pl', re: /[ąćęłńśźż]/i, weight: 1 },
  { lang: 'ro', re: /[ășț]/i, weight: 0.95 },
  { lang: 'tr', re: /[ğışİ]/i, weight: 0.95 },
  { lang: 'da', re: /[æø]/i, weight: 0.8 },
  { lang: 'fr', re: /[œ]/i, weight: 0.9 },
  // Elision is the strongest French signal that is not a character class.
  { lang: 'fr', re: /(^|[\s(«"'])(qu|d|l|n|s|j|c|m|t)['’](?=\p{L})/iu, weight: 0.8 },
  { lang: 'it', re: /(^|\s)(dell|nell|all|un|dall|sull)['’]/i, weight: 0.8 },
  // Endings: strong within their family, weak across it.
  { lang: 'es', re: /(ción|ciones|miento|dad)\b/i, weight: 0.9 },
  { lang: 'pt', re: /(ção|ções|agem)\b/i, weight: 0.9 },
  { lang: 'it', re: /(zione|zioni|ità|mente)\b/i, weight: 0.75 },
  { lang: 'de', re: /(ung|keit|heit|schaft)\b/i, weight: 0.7 },
  { lang: 'fr', re: /(ement|tion|eux|ité)\b/i, weight: 0.3 },
  { lang: 'en', re: /(tion|ing|ness|ment)\b/i, weight: 0.35 },
  // Shared diacritics: a nudge, never a verdict.
  { lang: 'fr', re: /[éèêëàâçîïôùûü]/i, weight: 0.3 },
  { lang: 'it', re: /[àèéìòù]/i, weight: 0.2 },
  { lang: 'pt', re: /[áéíóúâêôç]/i, weight: 0.2 },
  { lang: 'es', re: /[áéíóúü]/i, weight: 0.2 },
  { lang: 'sv', re: /[åä]/i, weight: 0.5 },
]

/**
 * Words spelled identically across several of these languages.
 *
 * These are the reason V4 must not treat "translation identical to source" as
 * a defect: "Notifications" IS the French for "Notifications". A validator that
 * flags every cognate is one a user learns to ignore, which costs more than it
 * saves. Detection returns null for these rather than picking a side.
 */
const COGNATES = new Set([
  'notifications', 'notification', 'format', 'options', 'option', 'configuration',
  'instructions', 'instruction', 'sessions', 'session', 'import', 'export', 'interface',
  'version', 'menu', 'application', 'applications', 'documentation', 'installation',
  'navigation', 'information', 'action', 'actions', 'section', 'sections', 'description',
  'position', 'direction', 'transition', 'animation', 'expression', 'extension',
  'extensions', 'test', 'tests', 'sport', 'transport', 'client', 'auto', 'radio',
  'audio', 'video', 'photo', 'zone', 'zones', 'total', 'normal', 'local', 'global',
  'social', 'central', 'digital', 'orange', 'simple', 'double', 'triple', 'stable',
  'principal', 'important', 'different', 'permanent', 'moment', 'instant', 'accent',
])

const SCRIPTS: { lang: Lang; re: RegExp }[] = [
  { lang: 'ru', re: /\p{Script=Cyrillic}/u },
  { lang: 'ja', re: /[\p{Script=Hiragana}\p{Script=Katakana}]/u },
]

export interface DetectOptions {
  /** Languages to consider. Narrowing raises precision on short strings. */
  candidates?: readonly Lang[]
}

/**
 * Text that is not prose and would poison every measurement.
 *
 * Detection runs on what a human reads, so identifiers, URLs, placeholders and
 * markup come out first. Leaving `task.title` in the input makes an English
 * signal out of a variable name.
 */
export function normalizeForDetection(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\{\d+\}/g, ' ')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/%[sd@]|%\d+\$[sd@]/g, ' ')
    .replace(/https?:\/\/\S+|\b[\w.-]+\/[\w./-]+/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b[a-z]+[A-Z]\w*/g, ' ')
    .replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, ' ')
    .replace(/\b\w+[_-]\w+\b/g, ' ')
    // Dotted member paths — `task.title` is two ordinary lowercase words to any
    // pattern that only looks for camelCase, and it votes English if left in.
    .replace(/\b\w+(?:\.\w+)+\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function letterCount(normalized: string): number {
  return (normalized.match(/\p{L}/gu) ?? []).length
}

export function bucketOf(letters: number): LanguageGuess['bucket'] {
  if (letters === 0) return 'none'
  if (letters < 8) return 'short'
  if (letters < 20) return 'medium'
  if (letters < 60) return 'long'
  return 'very-long'
}

export function detect(raw: string, opts: DetectOptions = {}): LanguageGuess {
  const candidates = opts.candidates ?? SUPPORTED
  const normalized = normalizeForDetection(raw)
  const letters = letterCount(normalized)
  const bucket = bucketOf(letters)
  const signals: string[] = []

  const none = (reason: string): LanguageGuess => ({
    detected: null,
    confidence: 0,
    method: 'none',
    signals: [reason],
    alternatives: [],
    letters,
    bucket,
    mixed: false,
    inheritedFrom: null,
  })

  if (letters === 0) return none('no letters')

  // A cognate is a genuine ambiguity, not a low-information string. Answering
  // it would be answering a question that has two correct answers.
  const singleWord = normalized.trim().toLowerCase()
  if (COGNATES.has(singleWord)) return none('cross-language cognate')

  // Non-Latin scripts settle it from two characters.
  for (const { lang, re } of SCRIPTS) {
    if (re.test(normalized) && candidates.includes(lang)) {
      return {
        detected: lang,
        confidence: 0.97,
        method: 'script',
        signals: [`script:${lang}`],
        alternatives: [],
        letters,
        bucket,
        mixed: false,
        inheritedFrom: null,
      }
    }
  }

  const tokens = normalized
    .toLowerCase()
    .split(/[^\p{L}'’]+/u)
    .filter(Boolean)
  if (tokens.length === 0) return none('no word tokens')

  const scores = new Map<Lang, number>()
  for (const lang of candidates) {
    const set = new Set(STOPWORDS[lang])
    if (set.size === 0) continue
    const hits = tokens.filter((t) => set.has(t)).length
    if (hits > 0) {
      scores.set(lang, (hits / tokens.length) * 1.6)
      signals.push(`stopword:${lang}=${(hits / tokens.length).toFixed(2)}`)
    }
  }

  for (const { lang, re, weight } of ORTHOGRAPHY) {
    if (!candidates.includes(lang)) continue
    if (re.test(normalized)) {
      scores.set(lang, (scores.get(lang) ?? 0) + weight)
      signals.push(`ortho:${lang}+${weight}`)
    }
  }

  if (scores.size === 0) {
    // For a short string the length IS the reason, and it is the actionable
    // one: "too short to decide" tells an adjudicator to look at its siblings,
    // whereas "no discriminative signal" invites them to go hunting for one.
    return none(
      bucket === 'short'
        ? 'below the length threshold — too short to decide'
        : 'no discriminative signal',
    )
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const [topLang, topScore] = ranked[0]!
  const secondScore = ranked[1]?.[1] ?? 0
  const margin = topScore === 0 ? 0 : (topScore - secondScore) / topScore

  // Length gates the ANSWER, not just its confidence. "OK" is a word in eight
  // of these languages; "Menu" is identical in English and French; "Format" in
  // four. Below the threshold the honest output is a refusal, and the site is
  // routed to a human or to cohort inheritance.
  if (bucket === 'short') {
    return {
      ...none('below the length threshold — too short to decide'),
      alternatives: ranked.slice(0, 3).map(([l, s]) => [l, round(s)] as [string, number]),
    }
  }
  if (bucket === 'medium' && margin < 0.25) {
    return {
      ...none('ambiguous: no clear winner on a short string'),
      alternatives: ranked.slice(0, 3).map(([l, s]) => [l, round(s)] as [string, number]),
    }
  }

  const lengthPrior = bucket === 'medium' ? 0.75 : bucket === 'long' ? 0.9 : 1
  return {
    detected: topLang,
    confidence: round(Math.min(1, (0.5 + margin * 0.5) * lengthPrior)),
    method: signals.some((s) => s.startsWith('ortho')) && signals.some((s) => s.startsWith('stopword'))
      ? 'combined'
      : signals[0]?.startsWith('ortho')
        ? 'trigram'
        : 'stopword',
    signals,
    alternatives: ranked.slice(1, 4).map(([l, s]) => [l, round(s)] as [string, number]),
    letters,
    bucket,
    mixed: false,
    inheritedFrom: null,
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Words that turn up in FILE NAMES, per language.
 *
 * A filename is the one place where general detection is structurally useless:
 * `reglages` carries no accent, `clair` is five letters, and both are exactly
 * the inputs the detector refuses on. But the vocabulary of filenames is small
 * and repetitive — colours, sizes, states, screens — so a short list does what
 * statistics cannot at this length.
 *
 * A hit is a hint, never a verdict: the path surface reports for judgment and
 * never renames.
 */
const PATH_WORDS: Record<string, string[]> = {
  fr: ['reglages', 'réglages', 'parametres', 'paramètres', 'accueil', 'connexion', 'deconnexion',
    'inscription', 'recherche', 'resultats', 'résultats', 'clair', 'sombre', 'gris', 'rouge',
    'vert', 'bleu', 'jaune', 'noir', 'blanc', 'grand', 'petit', 'moyen', 'nouveau', 'nouvelle',
    'ancien', 'page', 'pages', 'image', 'images', 'capture', 'captures', 'ecran', 'écran',
    'exemple', 'exemples', 'modele', 'modèle', 'brouillon', 'apercu', 'aperçu', 'utilisateur',
    'utilisateurs', 'compte', 'comptes', 'profil', 'tableau', 'graphique', 'statistiques',
    'minuteur', 'tache', 'tâche', 'taches', 'tâches', 'alerte', 'alertes', 'sonnerie',
    'demarrage', 'démarrage', 'arret', 'arrêt', 'pause', 'aide', 'guide', 'accessibilite',
    'accessibilité', 'securite', 'sécurité', 'donnees', 'données', 'fichier', 'dossier'],
  es: ['ajustes', 'configuracion', 'configuración', 'inicio', 'busqueda', 'búsqueda', 'claro',
    'oscuro', 'rojo', 'verde', 'azul', 'negro', 'blanco', 'grande', 'pequeno', 'pequeño',
    'nuevo', 'nueva', 'pagina', 'página', 'imagen', 'imagenes', 'imágenes', 'pantalla',
    'ejemplo', 'usuario', 'usuarios', 'cuenta', 'perfil', 'datos', 'archivo', 'carpeta',
    'tarea', 'tareas', 'ayuda', 'guia', 'guía', 'seguridad'],
  de: ['einstellungen', 'anmeldung', 'abmeldung', 'suche', 'hell', 'dunkel', 'rot', 'gruen',
    'grün', 'blau', 'schwarz', 'weiss', 'weiß', 'gross', 'groß', 'klein', 'neu', 'seite',
    'seiten', 'bild', 'bilder', 'bildschirm', 'beispiel', 'benutzer', 'konto', 'profil',
    'daten', 'datei', 'ordner', 'aufgabe', 'aufgaben', 'hilfe', 'sicherheit'],
  it: ['impostazioni', 'accesso', 'ricerca', 'chiaro', 'scuro', 'rosso', 'verde', 'blu', 'nero',
    'bianco', 'grande', 'piccolo', 'nuovo', 'nuova', 'pagina', 'immagine', 'immagini',
    'schermo', 'esempio', 'utente', 'account', 'profilo', 'dati', 'file', 'cartella',
    'attivita', 'attività', 'aiuto', 'sicurezza'],
  pt: ['configuracoes', 'configurações', 'ajustes', 'inicio', 'início', 'busca', 'claro',
    'escuro', 'vermelho', 'verde', 'azul', 'preto', 'branco', 'grande', 'pequeno', 'novo',
    'nova', 'pagina', 'página', 'imagem', 'imagens', 'tela', 'exemplo', 'usuario', 'usuário',
    'conta', 'perfil', 'dados', 'arquivo', 'pasta', 'tarefa', 'tarefas', 'ajuda', 'seguranca',
    'segurança'],
}

const PATH_INDEX = new Map<string, string>()
for (const [lang, words] of Object.entries(PATH_WORDS)) {
  for (const word of words) PATH_INDEX.set(word, lang)
}

/** Which shipped language a filename word belongs to, if any. */
export function pathWordLanguage(word: string): string | null {
  return PATH_INDEX.get(word.normalize('NFC').toLowerCase()) ?? null
}

export function isCognate(value: string): boolean {
  return COGNATES.has(value.normalize('NFC').trim().toLowerCase())
}
