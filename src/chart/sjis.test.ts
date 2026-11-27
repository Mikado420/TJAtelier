import { describe, expect, it } from 'vitest';
import { encodeSJIS } from './sjis';

describe('シフトJIS で書き出す', () => {
  it('日本語・半角カナ・記号をシフトJIS にして、読み戻すと同じ文字になる', () => {
    const s = 'TITLE:蠱惑 瀟洒な 極めて遺憾 妥当性\r\nSUBTITLE:--ｶﾀｶﾅ ①♪～\r\n#START';
    const b = encodeSJIS(s);
    expect(new TextDecoder('shift_jis').decode(b)).toBe(s);
    expect(Array.from(encodeSJIS('あ'))).toEqual([0x82, 0xa0]);
  });
  it('Mac・iPhone の 〜 − — ‖ ¢ £ ¬ は Windows（CP932）の同じ見た目の字にする', () => {
    expect(new TextDecoder('shift_jis').decode(encodeSJIS('〜−—‖¢£¬'))).toBe('～－―∥￠￡￢');
    expect(Array.from(encodeSJIS('〜'))).toEqual([0x81, 0x60]);
  });
  it('飾りの付いた字は飾りを外す（é → e）', () => {
    expect(new TextDecoder('shift_jis').decode(encodeSJIS('Pokémon Ñ'))).toBe('Pokemon N');
  });
  it('シフトJIS に無い文字は ? にする', () => {
    expect(new TextDecoder('shift_jis').decode(encodeSJIS('a😀b简'))).toBe('a?b?');
  });
});
