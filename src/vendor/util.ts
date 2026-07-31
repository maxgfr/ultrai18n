// Vendored from @maxgfr/codeindex v2.22.0 (MIT). See ./README.md.

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
