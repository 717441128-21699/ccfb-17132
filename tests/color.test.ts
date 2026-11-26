import { describe, expect, it } from 'vitest';
import { rgbToLab, labToRgb, baumeToColor } from '../src/core/color';
import { brineAppearanceRGB, pinkIndexOfLab, whiteIndexOfLab } from '../src/core/brine';
import { classifyPixel } from '../src/core/classify';

describe('color spaces', () => {
  it('sRGB -> Lab -> RGB round trip', () => {
    for (const c of [
      { r: 200, g: 60, b: 130 },
      { r: 30, g: 120, b: 140 },
      { r: 244, g: 242, b: 236 },
    ]) {
      const back = labToRgb(rgbToLab(c));
      expect(Math.abs(back.r - c.r)).toBeLessThan(3);
      expect(Math.abs(back.g - c.g)).toBeLessThan(3);
      expect(Math.abs(back.b - c.b)).toBeLessThan(3);
    }
  });

  it('concentration colormap traverses teal -> green -> pink -> near white', () => {
    const low = baumeToColor(3);
    const mid = baumeToColor(12);
    const pink = baumeToColor(24);
    const high = baumeToColor(29);
    // 低浓度偏蓝绿：G/B 较高
    expect(low.g).toBeGreaterThan(low.r);
    // 中浓度偏黄绿：R/G 高、B 低
    expect(mid.g).toBeGreaterThan(mid.b + 30);
    // 高浓度粉红：R 明显大于 G
    expect(pink.r).toBeGreaterThan(pink.g + 60);
    // 结晶端接近白
    expect(high.r).toBeGreaterThan(210);
  });
});

describe('pink algae vs white crystal separation', () => {
  it('pink brine has high pink index and ~0 white index', () => {
    const pinkRgb = brineAppearanceRGB(25, 'bloom');
    const lab = rgbToLab(pinkRgb);
    expect(pinkIndexOfLab(lab)).toBeGreaterThan(0.7);
    expect(whiteIndexOfLab(lab)).toBeLessThan(0.25);
    expect(classifyPixel(pinkRgb.r, pinkRgb.g, pinkRgb.b)).toBe('water');
  });

  it('white salt is classified salt and never as pink water', () => {
    const salt = { r: 244, g: 242, b: 236 };
    expect(classifyPixel(salt.r, salt.g, salt.b)).toBe('salt');
    const lab = rgbToLab(salt);
    expect(whiteIndexOfLab(lab)).toBeGreaterThan(0.6);
    expect(pinkIndexOfLab(lab)).toBeLessThan(0.25);
  });

  it('strong specular clip is glint and excluded', () => {
    expect(classifyPixel(252, 252, 250)).toBe('glint');
  });

  it('mud brown is classified mud, not green-yellow brine', () => {
    expect(classifyPixel(128, 100, 68)).toBe('mud');
  });
});
