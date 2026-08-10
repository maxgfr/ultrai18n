// Vendored from @maxgfr/codeindex v2.22.1 (MIT). See ./README.md.

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
