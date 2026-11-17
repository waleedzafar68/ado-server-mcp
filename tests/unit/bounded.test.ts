import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { htmlToText, isProbablyBinary, limitList, truncate, windowText } from '../../src/ado/bounded.js';

const fiveLines = ['one', 'two', 'three', 'four', 'five'].join('\n');

describe('windowText', () => {
  it('returns a line range', () => {
    expect(windowText(fiveLines, { startLine: 2, endLine: 3 })).toEqual({
      text: 'two\nthree', startLine: 2, endLine: 3, totalLines: 5, totalChars: fiveLines.length, truncated: false,
    });
  });
  it('returns the tail', () => {
    expect(windowText(fiveLines, { tailLines: 2 })).toMatchObject({ text: 'four\nfive', startLine: 4, endLine: 5 });
  });
  it('stops at maxChars on a line boundary and reports truncation', () => {
    expect(windowText('aaaa\nbbbb\ncccc', { maxChars: 9 })).toMatchObject({ text: 'aaaa\nbbbb', endLine: 2, truncated: true });
  });
  it('cuts a single oversized line', () => {
    expect(windowText('abcdef', { maxChars: 3 })).toMatchObject({ text: 'abc', endLine: 1, truncated: true });
  });
  it('handles empty text', () => {
    expect(windowText('')).toMatchObject({ text: '', totalLines: 0, truncated: false });
  });
  it('ignores a trailing newline when counting lines', () => {
    expect(windowText('a\nb\n', { tailLines: 1 })).toMatchObject({
      text: 'b', startLine: 2, endLine: 2, totalLines: 2, truncated: false,
    });
  });
  it('keeps the newest lines when a tail window is cut by maxChars', () => {
    expect(windowText('one\ntwo\nthree\nfour', { tailLines: 3, maxChars: 10 })).toMatchObject({
      text: 'three\nfour', startLine: 3, endLine: 4, totalLines: 4, truncated: true,
    });
  });
  it('returns the tail of an oversized single-line tail window', () => {
    expect(windowText('abcdef', { tailLines: 1, maxChars: 3 })).toMatchObject({
      text: 'def', startLine: 1, endLine: 1, truncated: true,
    });
  });
});

describe('content helpers', () => {
  it('detects binary content', () => {
    expect(isProbablyBinary('PK\u0003\u0004\u0000\u0000')).toBe(true);
    expect(isProbablyBinary('\uFFFD'.repeat(5) + 'abc')).toBe(true);
    expect(isProbablyBinary('# README\nhello')).toBe(false);
  });
  it('converts work item HTML to text', () => {
    expect(htmlToText('<div>Hello&nbsp;<b>world</b></div><ul><li>a</li><li>b</li></ul>&lt;tag&gt; &#39;q&#39;'))
      .toBe("Hello world\n- a\n- b\n<tag> 'q'");
  });
  it('leaves invalid numeric entities unchanged', () => {
    expect(htmlToText('a&#x110000;b&#99999999999;c&#65;')).toBe('a&#x110000;b&#99999999999;cA');
  });
  it('preserves normal line breaks, list items and entity decoding', () => {
    expect(htmlToText('<p>A<br />B</p><div>C</div><ul><li class="x">D</li></ul><h2>E</h2>&amp; &#x1f600; &unknown;'))
      .toBe('A\nB\nC\n- D\nE\n& 😀 &unknown;');
    expect(htmlToText('before <unfinished')).toBe('before <unfinished');
  });
  it.each(['angles', 'list-items', 'whitespace'])('bounds adversarial %s conversion outside the runner thread', async (kind) => {
    const worker = new Worker(new URL('../fixtures/html-worker.mjs', import.meta.url), { workerData: kind });
    try {
      const result = await new Promise<{ length: number; ok: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`HTML conversion exceeded 3000 ms (${kind})`)), 3000);
        worker.once('message', (value) => { clearTimeout(timer); resolve(value); });
        worker.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      expect(result.ok).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    } finally { await worker.terminate(); }
  });
  it('truncates with a marker', () => {
    expect(truncate('abcdef', 3)).toBe('abc… [truncated 3 chars]');
    expect(truncate('abc', 3)).toBe('abc');
  });
  it('limits lists and reports truncation', () => {
    expect(limitList([1, 2, 3], 2)).toEqual({ items: [1, 2], count: 2, truncated: true });
    expect(limitList([1], 2)).toEqual({ items: [1], count: 1, truncated: false });
  });
});
