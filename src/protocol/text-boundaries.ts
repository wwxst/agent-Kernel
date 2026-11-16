/**
 * Truncate by UTF-16 code units without splitting a surrogate pair.
 * The returned length is at most the requested number of code units.
 * Keep string indexing semantics (character budgets are already UTF-16 in callers).
 */
export function takeUtf16Prefix(text: string, units: number): string {
  const end = Math.max(0, Math.min(text.length, Math.floor(units)));
  if (end > 0 && end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) {
    return text.slice(0, end - 1);
  }
  return text.slice(0, end);
}

export function takeUtf16Suffix(text: string, units: number): string {
  const start = Math.max(0, text.length - Math.max(0, Math.floor(units)));
  if (start > 0 && start < text.length &&
      text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff &&
      text.charCodeAt(start - 1) >= 0xd800 && text.charCodeAt(start - 1) <= 0xdbff) {
    return text.slice(start + 1);
  }
  return text.slice(start);
}
