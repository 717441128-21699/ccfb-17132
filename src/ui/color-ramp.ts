// 波美度 -> 浓度图配色：与卤水真实观感一致的青绿(低) -> 黄褐 -> 粉红/红(高) 渐变。
// 用于浓度图填色，区别于原始照片。

const STOPS: { b: number; rgb: [number, number, number] }[] = [
  { b: 3, rgb: [70, 150, 150] },
  { b: 8, rgb: [110, 155, 95] },
  { b: 13, rgb: [170, 160, 80] },
  { b: 18, rgb: [200, 130, 90] },
  { b: 22, rgb: [220, 110, 120] },
  { b: 27, rgb: [230, 70, 90] },
];

const B_MIN = STOPS[0].b;
const B_MAX = STOPS[STOPS.length - 1].b;

export function baumeToColor(baume: number): [number, number, number] {
  const x = Math.max(B_MIN, Math.min(B_MAX, baume));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const s0 = STOPS[i];
    const s1 = STOPS[i + 1];
    if (x >= s0.b && x <= s1.b) {
      const t = (x - s0.b) / (s1.b - s0.b);
      return [
        Math.round(s0.rgb[0] + (s1.rgb[0] - s0.rgb[0]) * t),
        Math.round(s0.rgb[1] + (s1.rgb[1] - s0.rgb[1]) * t),
        Math.round(s0.rgb[2] + (s1.rgb[2] - s0.rgb[2]) * t),
      ];
    }
  }
  return STOPS[STOPS.length - 1].rgb;
}

export function baumeToCss(baume: number): string {
  const [r, g, b] = baumeToColor(baume);
  return `rgb(${r},${g},${b})`;
}

export function baumeRange(): [number, number] {
  return [B_MIN, B_MAX];
}

/** 浓度图例的离散刻度 */
export function legendStops(): { b: number; css: string }[] {
  return STOPS.map((s) => ({ b: s.b, css: `rgb(${s.rgb.join(',')})` }));
}
