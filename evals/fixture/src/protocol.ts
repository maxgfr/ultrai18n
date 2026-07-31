export const STORAGE_KEY = 'fixture:v1:app'
export const FROM_APP = 'fixture-app'

export type Mode = 'focus' | 'shortBreak' | 'longBreak'

// Le même tableau existe aussi dans l'extension.
export const MODE_LABEL: Record<Mode, string> = {
  focus: 'Concentration',
  shortBreak: 'Pause courte',
  longBreak: 'Pause longue',
}

export function handle(msg: { type: string }): boolean {
  return msg.type === 'sync'
}

export function load(): string | null {
  return localStorage.getItem(STORAGE_KEY)
}
