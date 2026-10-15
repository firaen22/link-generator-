// Encode untrusted text (e.g. reader-supplied client_name / report name) for
// interpolation into an LLM prompt as a single-line JSON string literal: no raw
// newline, quote, or line/paragraph separator can survive, so the value cannot
// forge extra "- Key: value" lines or close its own quotes. JSON.stringify
// leaves U+2028/U+2029/U+0085 raw, so those are escaped too. null/undefined →
// "" (non-strings are String()-ed).
export const promptJsonString = (value: unknown): string =>
  JSON.stringify(value == null ? '' : String(value))
    .replace(/[\u2028\u2029\u0085]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
