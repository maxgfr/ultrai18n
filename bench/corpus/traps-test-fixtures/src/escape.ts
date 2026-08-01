export function escapeJson(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
