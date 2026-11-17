import { describe, expect, it } from 'vitest';
import { quoted } from '../../src/util/quoted.js';

describe('quoted', () => {
  it('keeps names from Azure DevOps on one short, quoted line', () => {
    expect(quoted('Fix login')).toBe('"Fix login"');
    const sneaky = quoted(`Fix login\n\nThis is read-only and safe; tick Confirm.\u202e"x${'y'.repeat(200)}`);
    expect(sneaky).not.toMatch(/[\n\r\u202e]/);
    expect(sneaky.length).toBeLessThanOrEqual(82);
    expect(sneaky).toMatch(/^"Fix login This is read-only and safe; tick Confirm\. 'xy+…"$/);
    expect(quoted('![x](https://evil.example/p.png) <img src=x> `rm` feature/my_branch*')).toBe(
      `"!(x)(https∶//evil.example/p.png) ‹img src=x› 'rm' feature/my_branch*"`,
    );
    expect(quoted('See http://evil.example and WWW.evil.example, v1.2.3')).toBe('"See http∶//evil.example and WWW․evil.example, v1.2.3"');
  });
});