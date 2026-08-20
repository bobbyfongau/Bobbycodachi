/**
 * Terminal display width calculation.
 * East Asian Wide/Fullwidth characters and emoji occupy 2 cells; most others
 * occupy 1; zero-width characters (ZWJ, variation selectors, combining marks)
 * occupy 0. Strings are measured grapheme-by-grapheme so ZWJ sequences like
 * 👩‍💻 count as a single 2-cell glyph, matching terminal rendering.
 */

// Unicode 9+ East_Asian_Width=Wide BMP emoji (rendered 2 cells by modern
// terminals): ⌚⏰✅✨❌⭐⚡⭕ and friends. Sorted, inclusive ranges.
const WIDE_BMP_EMOJI: ReadonlyArray<readonly [number, number]> = [
  [0x231A, 0x231B], [0x23E9, 0x23EC], [0x23F0, 0x23F0], [0x23F3, 0x23F3],
  [0x25FD, 0x25FE], [0x2614, 0x2615], [0x2648, 0x2653], [0x267F, 0x267F],
  [0x2693, 0x2693], [0x26A1, 0x26A1], [0x26AA, 0x26AB], [0x26BD, 0x26BE],
  [0x26C4, 0x26C5], [0x26CE, 0x26CE], [0x26D4, 0x26D4], [0x26EA, 0x26EA],
  [0x26F2, 0x26F3], [0x26F5, 0x26F5], [0x26FA, 0x26FA], [0x26FD, 0x26FD],
  [0x2705, 0x2705], [0x270A, 0x270B], [0x2728, 0x2728], [0x274C, 0x274C],
  [0x274E, 0x274E], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27B0, 0x27B0], [0x27BF, 0x27BF], [0x2B1B, 0x2B1C], [0x2B50, 0x2B50],
  [0x2B55, 0x2B55],
];

// Combining marks (Mn/Mc/Me) render at zero width. Compiled once.
const COMBINING_MARK = /^\p{M}$/u;

/**
 * Returns the terminal display width of a single character (code point).
 */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;

  // Fast path: ASCII is always 1 wide
  if (cp < 0x7F) return cp < 0x20 ? 0 : 1;

  // Zero-width: ZWJ, zero-width space/joiners, variation selectors, BOM.
  if (
    cp === 0x200D ||                    // Zero Width Joiner
    (cp >= 0x200B && cp <= 0x200F) ||   // ZWSP, ZWNJ, marks
    cp === 0x2060 ||                    // Word Joiner
    (cp >= 0xFE00 && cp <= 0xFE0F) ||   // Variation Selectors (incl. VS16)
    cp === 0xFEFF                       // BOM / ZWNBSP
  ) {
    return 0;
  }

  // Combining marks (e.g. U+0301 acute) render at zero width.
  if (COMBINING_MARK.test(ch)) return 0;

  // East Asian Wide / Fullwidth ranges that are 2 cells wide in terminals
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x303E) ||   // CJK Radicals, Kangxi, Symbols
    (cp >= 0x3040 && cp <= 0x33BF) ||   // Hiragana, Katakana, CJK compat (づ, つ here)
    (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Ext A
    (cp >= 0x4E00 && cp <= 0xA4CF) ||   // CJK Unified + Yi
    (cp >= 0xAC00 && cp <= 0xD7A3) ||   // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compat Ideographs
    (cp >= 0xFE10 && cp <= 0xFE6F) ||   // CJK Forms
    (cp >= 0xFF01 && cp <= 0xFF60) ||   // Fullwidth ASCII
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth signs
    (cp >= 0x1F300 && cp <= 0x1FAFF) || // Emoji
    (cp >= 0x20000 && cp <= 0x3FFFD)    // CJK Ext B+
  ) {
    return 2;
  }

  // Wide BMP emoji singletons/short ranges (✅ ⭐ ⚡ ❌ ⌚ …).
  if (cp >= 0x231A && cp <= 0x2B55) {
    for (const [lo, hi] of WIDE_BMP_EMOJI) {
      if (cp < lo) break;
      if (cp <= hi) return 2;
    }
  }

  return 1;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Split a string into grapheme clusters (👩‍💻 stays one unit). */
export function graphemes(str: string): string[] {
  const out: string[] = [];
  for (const { segment } of GRAPHEME_SEGMENTER.segment(str)) out.push(segment);
  return out;
}

/** Terminal display width of a single grapheme cluster. */
export function graphemeWidth(g: string): number {
  // ZWJ sequences (👩‍💻, 👨‍👩‍👧) render as a single 2-cell emoji.
  if (g.includes('\u200D')) return 2;
  const cp = g.codePointAt(0);
  if (cp === undefined) return 0;
  // Regional-indicator pair = one flag = 2 cells.
  if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return 2;
  const base = String.fromCodePoint(cp);
  let w = charWidth(base);
  // VS16 promotes a narrow character to emoji presentation (❤️, ☀️).
  if (w === 1 && g.length > base.length && g.includes('\uFE0F')) w = 2;
  return w;
}

/** Calculate the visual terminal width of a string (ignoring ANSI escapes). */
export function stringWidth(str: string): number {
  // Strip ANSI
  const clean = str.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(clean)) {
    w += graphemeWidth(segment);
  }
  return w;
}
