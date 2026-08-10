// Vendored from @maxgfr/codeindex v2.27.1 (MIT). See ./README.md.

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
