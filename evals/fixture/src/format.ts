export type TaskStatus = 'active' | 'done' | 'archived'

export const WEEKDAY = ['L', 'M', 'M', 'J', 'V', 'S', 'D']

export const DURATION_PRESETS = [{ id: 'classic', label: '25 / 5' }]

export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'done'
  if (ms < 60000) return 'moins d’une minute'
  return `environ ${Math.round(ms / 60000)} minutes`
}
