import { describe, it, expect } from 'vitest';
import { charWidth, stringWidth, graphemes, graphemeWidth } from './width.js';

describe('charWidth', () => {
  it('returns 1 for ASCII printable', () => {
    expect(charWidth('a')).toBe(1);
    expect(charWidth('Z')).toBe(1);
    expect(charWidth('0')).toBe(1);
    expect(charWidth(' ')).toBe(1);
    expect(charWidth('~')).toBe(1);
  });

  it('returns 0 for control characters', () => {
    expect(charWidth('\0')).toBe(0);
    expect(charWidth('\t')).toBe(0);
    expect(charWidth('\n')).toBe(0);
  });

  it('returns 2 for CJK characters', () => {
    expect(charWidth('你')).toBe(2);
    expect(charWidth('好')).toBe(2);
    expect(charWidth('猫')).toBe(2);
  });

  it('returns 2 for fullwidth ASCII', () => {
    expect(charWidth('Ａ')).toBe(2); // U+FF21
  });

  it('returns 2 for emoji', () => {
    expect(charWidth('🐱')).toBe(2);
  });

  it('returns 1 for Latin extended characters', () => {
    expect(charWidth('é')).toBe(1);
    expect(charWidth('ñ')).toBe(1);
  });

  it('returns 0 for empty string', () => {
    expect(charWidth('')).toBe(0);
  });

  it('returns 2 for wide BMP emoji (EastAsianWidth=W since Unicode 9)', () => {
    expect(charWidth('✅')).toBe(2); // U+2705
    expect(charWidth('❌')).toBe(2); // U+274C
    expect(charWidth('⭐')).toBe(2); // U+2B50
    expect(charWidth('⚡')).toBe(2); // U+26A1
    expect(charWidth('⌚')).toBe(2); // U+231A
    expect(charWidth('✨')).toBe(2); // U+2728
    expect(charWidth('❗')).toBe(2); // U+2757
    expect(charWidth('⭕')).toBe(2); // U+2B55
    expect(charWidth('⏰')).toBe(2); // U+23F0
  });

  it('returns 1 for narrow symbols in the same blocks', () => {
    expect(charWidth('☀')).toBe(1);  // U+2600 (needs VS16 for emoji form)
    expect(charWidth('✓')).toBe(1);  // U+2713
    expect(charWidth('→')).toBe(1);  // U+2192
  });

  it('returns 0 for ZWJ and variation selectors', () => {
    expect(charWidth('\u200D')).toBe(0); // ZWJ
    expect(charWidth('\uFE0F')).toBe(0); // VS16
    expect(charWidth('\u200B')).toBe(0); // ZWSP
  });

  it('returns 0 for combining marks', () => {
    expect(charWidth('\u0301')).toBe(0); // combining acute
    expect(charWidth('\u0300')).toBe(0); // combining grave
  });
});

describe('graphemeWidth', () => {
  it('counts a ZWJ sequence as one 2-cell glyph', () => {
    expect(graphemeWidth('👩‍💻')).toBe(2);
    expect(graphemeWidth('👨‍👩‍👧')).toBe(2);
  });

  it('counts VS16-promoted emoji as 2 cells', () => {
    expect(graphemeWidth('❤️')).toBe(2); // U+2764 U+FE0F
    expect(graphemeWidth('☀️')).toBe(2); // U+2600 U+FE0F
  });

  it('ignores skin-tone modifiers', () => {
    expect(graphemeWidth('👍🏻')).toBe(2);
  });

  it('counts a regional-indicator flag as 2 cells', () => {
    expect(graphemeWidth('🇺🇸')).toBe(2);
  });

  it('counts combining sequences as base width', () => {
    expect(graphemeWidth('é')).toBe(1);
  });
});

describe('graphemes', () => {
  it('keeps surrogate pairs together', () => {
    expect(graphemes('a🎉b')).toEqual(['a', '🎉', 'b']);
  });

  it('keeps ZWJ sequences together', () => {
    expect(graphemes('x👩‍💻y')).toEqual(['x', '👩‍💻', 'y']);
  });
});

describe('stringWidth', () => {
  it('returns length for ASCII strings', () => {
    expect(stringWidth('hello')).toBe(5);
    expect(stringWidth('')).toBe(0);
    expect(stringWidth('a')).toBe(1);
  });

  it('handles CJK strings', () => {
    expect(stringWidth('你好')).toBe(4);
    expect(stringWidth('ab你好cd')).toBe(8);
  });

  it('ignores ANSI escape codes', () => {
    expect(stringWidth('\x1b[31mred\x1b[0m')).toBe(3);
    expect(stringWidth('\x1b[38;2;255;0;0mcolor\x1b[0m')).toBe(5);
    expect(stringWidth('\x1b[2m\x1b[0m')).toBe(0);
  });

  it('handles mixed content', () => {
    expect(stringWidth('\x1b[31m你好\x1b[0m world')).toBe(10);
  });

  it('matches terminal rendering for emoji-laden strings', () => {
    expect(stringWidth('✅ fix all the tests')).toBe(20);
    expect(stringWidth('👩‍💻 pair session')).toBe(15);
    expect(stringWidth('❤️')).toBe(2);
    expect(stringWidth('🎉🎉')).toBe(4);
  });
});
