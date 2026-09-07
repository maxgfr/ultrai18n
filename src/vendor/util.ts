// Vendored from @maxgfr/codeindex v2.28.6 (MIT). See ./README.md.

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
