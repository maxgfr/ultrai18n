// Vendored from @maxgfr/codeindex v2.28.4 (MIT). See ./README.md.

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
