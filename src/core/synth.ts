// 合成带浓度真值的航拍照片：
//  1) 先在“大图世界坐标系”渲染一个规范光照下的盐田（土埂、池水、藻华、盐花、泥）
//  2) 按飞行航线裁出数百张照片，叠加 GPS 抖动、天气、太阳角度、曝光/色温差异与水面反光
// 拼接器只能拿到照片和近似位姿，真值仅用于评测。
import { Rng } from './rng';
import { brineAppearanceRGB } from './brine';
import { WORLD_W, WORLD_H, RIDGE_WIDTH, buildField, type FieldLayout } from './field';
import { clamp } from './color';
import type {
  AlgaeKind,
  LightingKind,
  Photo,
  PhotoPose,
  RGB,
  WeatherKind,
} from './types';

export const PHOTO_W = 256;
export const PHOTO_H = 192;

export interface SynthOptions {
  count: number;
  weather: WeatherKind;
  algae: AlgaeKind;
  lighting?: LightingKind;
  mission?: 'morning' | 'evening';
  seed?: number;
  /** 是否同时生成傍晚第二架次（同航线、不同光照），数量与主架次相同 */
  withEvening?: boolean;
  /** 照片 id 前缀 */
  prefix?: string;
}

export interface GeneratedDataset {
  field: FieldLayout;
  photos: Photo[];
  world: { width: number; height: number; data: Uint8ClampedArray };
}

// ---------- 快速平滑值噪声 ----------
function makeNoise(seed: number) {
  const rng = new Rng(seed);
  const size = 256;
  const perm = new Uint8Array(size * 2);
  const p = Array.from({ length: size }, (_, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < size * 2; i++) perm[i] = p[i & (size - 1)];
  const fade = (t: number) => t * t * (3 - 2 * t);
  const grad = (h: number, x: number, y: number) => {
    switch (h & 3) {
      case 0:
        return x + y;
      case 1:
        return -x + y;
      case 2:
        return x - y;
      default:
        return -x - y;
    }
  };
  return (x: number, y: number): number => {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = fade(x);
    const v = fade(y);
    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];
    const x1 = lerp(grad(aa, x, y), grad(ba, x - 1, y), u);
    const x2 = lerp(grad(ab, x, y - 1), grad(bb, x - 1, y - 1), u);
    return (lerp(x1, x2, v) + 1.4142) / 2.8284; // 0..1
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------- 世界渲染 ----------
interface Blob {
  x: number;
  y: number;
  r: number;
  warm: number;
}

export function renderWorld(field: FieldLayout, algae: AlgaeKind, seed: number) {
  const W = field.width;
  const H = field.height;
  const data = new Uint8ClampedArray(W * H * 4);
  const rng = new Rng(seed + 7);
  const noise = makeNoise(seed);
  const noise2 = makeNoise(seed + 991);

  // 1) 基底：压实土埂/滩地
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const n = noise(x * 0.012, y * 0.012);
      const g = noise2(x * 0.09, y * 0.09);
      const gravel = g > 0.82 ? -28 * (g - 0.82) * 4 : 0;
      const base = 150 + n * 26 + gravel + rng.gauss() * 5;
      data[i] = clamp(base + 26, 0, 255); // R 偏暖
      data[i + 1] = clamp(base + 6, 0, 255);
      data[i + 2] = clamp(base - 26, 0, 255);
      data[i + 3] = 255;
    }
  }

  const setPx = (x: number, y: number, c: RGB, a = 1) => {
    x = x | 0;
    y = y | 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = data[i] * (1 - a) + c.r * a;
    data[i + 1] = data[i + 1] * (1 - a) + c.g * a;
    data[i + 2] = data[i + 2] * (1 - a) + c.b * a;
  };

  // 2) 土埂中线压暗 + 两侧干硬亮边，强化“直线埂”
  const half = RIDGE_WIDTH / 2;
  for (const gx of field.gridX) {
    for (let y = 0; y < H; y++) {
      for (let d = -2; d <= 2; d++) setPx(Math.round(gx) + d, y, { r: 120, g: 98, b: 70 }, 0.25);
      for (let d = -half; d <= -half + 2; d++) setPx(Math.round(gx + d), y, { r: 196, g: 172, b: 132 }, 0.5);
      for (let d = half - 2; d <= half; d++) setPx(Math.round(gx + d), y, { r: 196, g: 172, b: 132 }, 0.5);
    }
  }
  for (const gy of field.gridY) {
    for (let x = 0; x < W; x++) {
      for (let d = -2; d <= 2; d++) setPx(x, Math.round(gy) + d, { r: 120, g: 98, b: 70 }, 0.25);
      for (let d = -half; d <= -half + 2; d++) setPx(x, Math.round(gy + d), { r: 196, g: 172, b: 132 }, 0.5);
      for (let d = half - 2; d <= half; d++) setPx(x, Math.round(gy + d), { r: 196, g: 172, b: 132 }, 0.5);
    }
  }

  // 埂上杂物：深色枯枝/工具点（应被边界排除）
  for (let k = 0; k < 260; k++) {
    const onVertical = rng.chance(0.5);
    let x: number, y: number;
    if (onVertical) {
      x = rng.pick(field.gridX) + rng.range(-half + 2, half - 2);
      y = rng.range(0, H);
    } else {
      x = rng.range(0, W);
      y = rng.pick(field.gridY) + rng.range(-half + 2, half - 2);
    }
    const len = rng.range(3, 9);
    const ang = rng.range(0, Math.PI);
    for (let t = 0; t < len; t++) {
      setPx(x + Math.cos(ang) * t, y + Math.sin(ang) * t, { r: 70, g: 58, b: 40 }, 0.8);
    }
  }

  // 3) 池水
  const saltBlobs: Blob[] = [];
  const mudBlobs: Array<Blob & { rx: number; ry: number }> = [];

  for (const pan of field.pans) {
    const { minX, minY, maxX, maxY } = pan.bbox;
    const base = brineAppearanceRGB(pan.trueBaume ?? 10, algae);
    const high = (pan.trueBaume ?? 10) >= 23;
    const bloom = algae !== 'none' && (pan.trueBaume ?? 10) >= 15;

    for (let y = Math.floor(minX * 0 + minY); y < maxY; y++) {
      for (let x = Math.floor(minX); x < maxX; x++) {
        const i = (y * W + x) * 4;
        // 大尺度深浅 + 细波纹
        const mottle = noise(x * 0.02 + pan.col * 13.7, y * 0.02 + pan.row * 7.1);
        const ripple = Math.sin((x * 0.9 + y * 0.35) * 0.35 + noise(x * 0.05, y * 0.05) * 6) * 0.5 + 0.5;
        let shade = 0.9 + mottle * 0.16 + ripple * 0.05 + rng.gauss() * 0.025;

        let r = base.r * shade;
        let g = base.g * shade;
        let b = base.b * shade;

        // 嗜盐藻粉红斑块
        if (bloom) {
          const patch = noise2(x * 0.018 + 40, y * 0.018 - 17);
          const gate = clamp((patch - 0.52) / 0.22, 0, 1);
          const pink: RGB = { r: 226, g: 74, b: 132 };
          const am = gate * (algae === 'bloom' ? 0.6 : 0.4);
          r = lerp(r, pink.r * shade, am);
          g = lerp(g, pink.g * shade, am);
          b = lerp(b, pink.b * shade, am);
        }

        // 浅水透视：中心略深、靠埂略亮
        const dx = (x - minX) / (maxX - minX);
        const dy = (y - minY) / (maxY - minY);
        const edge = Math.min(dx, 1 - dx, dy, 1 - dy);
        if (edge < 0.08) {
          const e = (0.08 - edge) / 0.08;
          r = lerp(r, r + 26, e * 0.5);
          g = lerp(g, g + 22, e * 0.5);
          b = lerp(b, b + 14, e * 0.5);
        }

        data[i] = clamp(r, 0, 255);
        data[i + 1] = clamp(g, 0, 255);
        data[i + 2] = clamp(b, 0, 255);
        data[i + 3] = 255;
      }
    }

    // 泥：部分中低浓度池一角露出池底
    if ((pan.trueBaume ?? 10) < 19 && rng.chance(0.4)) {
      const corner = rng.int(0, 3);
      const cx = corner % 2 === 0 ? minX + rng.range(18, 46) : maxX - rng.range(18, 46);
      const cy = corner < 2 ? minY + rng.range(16, 40) : maxY - rng.range(16, 40);
      mudBlobs.push({
        x: cx,
        y: cy,
        r: rng.range(26, 52),
        rx: rng.range(34, 70),
        ry: rng.range(22, 44),
        warm: rng.range(-10, 12),
      });
    }

    // 盐花/结晶：高浓度池，边缘盐壳 + 漂浮白色盐花团
    if (high) {
      const clusters = rng.int(5, 11);
      for (let k = 0; k < clusters; k++) {
        const nearEdge = rng.chance(0.6);
        let cx: number, cy: number;
        if (nearEdge) {
          const side = rng.int(0, 3);
          if (side === 0) {
            cx = rng.range(minX + 8, maxX - 8);
            cy = minY + rng.range(4, 26);
          } else if (side === 1) {
            cx = rng.range(minX + 8, maxX - 8);
            cy = maxY - rng.range(4, 26);
          } else if (side === 2) {
            cx = minX + rng.range(4, 26);
            cy = rng.range(minY + 8, maxY - 8);
          } else {
            cx = maxX - rng.range(4, 26);
            cy = rng.range(minY + 8, maxY - 8);
          }
        } else {
          cx = rng.range(minX + 20, maxX - 20);
          cy = rng.range(minY + 20, maxY - 20);
        }
        saltBlobs.push({ x: cx, y: cy, r: rng.range(7, 20), warm: rng.range(-6, 8) });
      }
      // 结晶池边缘连续盐壳
      if ((pan.trueBaume ?? 0) >= 25.5) {
        for (let k = 0; k < 260; k++) {
          const side = rng.int(0, 3);
          let x = 0;
          let y = 0;
          if (side === 0) {
            x = rng.range(minX, maxX);
            y = minY + rng.range(0, 10);
          } else if (side === 1) {
            x = rng.range(minX, maxX);
            y = maxY - rng.range(0, 10);
          } else if (side === 2) {
            x = minX + rng.range(0, 10);
            y = rng.range(minY, maxY);
          } else {
            x = maxX - rng.range(0, 10);
            y = rng.range(minY, maxY);
          }
          saltBlobs.push({ x, y, r: rng.range(3, 8), warm: rng.range(-4, 10) });
        }
      }
    }
  }

  // 4) 泥斑光栅化
  for (const m of mudBlobs) {
    for (let y = m.y - m.ry; y <= m.y + m.ry; y++) {
      for (let x = m.x - m.rx; x <= m.x + m.rx; x++) {
        const dx = (x - m.x) / m.rx;
        const dy = (y - m.y) / m.ry;
        const d = dx * dx + dy * dy;
        const edgeNoise = noise(x * 0.2, y * 0.2) * 0.35;
        if (d < 1 - edgeNoise) {
          const a = clamp((1 - d) * 1.4, 0, 0.92);
          const tex = noise2(x * 0.3, y * 0.3) * 30;
          setPx(x, y, { r: 128 + m.warm + tex, g: 100 + m.warm * 0.5 + tex * 0.7, b: 68 + tex * 0.4 }, a);
        }
      }
    }
  }

  // 5) 盐花光栅化（暖白、哑光、成团）
  for (const s of saltBlobs) {
    const r = Math.ceil(s.r);
    for (let y = s.y - r; y <= s.y + r; y++) {
      for (let x = s.x - r; x <= s.x + r; x++) {
        const d = Math.hypot(x - s.x, y - s.y) / s.r;
        if (d < 1) {
          const a = clamp((1 - d) * 1.6, 0, 0.97);
          const tex = noise(x * 0.5, y * 0.5) * 18 - 6;
          setPx(x, y, { r: 244 + s.warm + tex, g: 242 + s.warm + tex, b: 236 + tex }, a);
        }
      }
    }
  }

  return { width: W, height: H, data };
}

// ---------- 航线与照片 ----------
function chooseGrid(n: number, W: number, H: number) {
  const rows = Math.max(1, Math.round(Math.sqrt((n * H) / W)));
  const perStrip = Math.ceil(n / rows);
  return { rows, perStrip };
}

function lightingGains(kind: LightingKind, rng: Rng) {
  const j = () => rng.range(-0.03, 0.03);
  switch (kind) {
    case 'morning':
      return { r: 1.05 + j(), g: 1.0 + j(), b: 0.9 + j(), exposure: 1.03 + rng.range(-0.05, 0.05) };
    case 'evening':
      return { r: 1.13 + j(), g: 0.96 + j(), b: 0.78 + j(), exposure: 0.94 + rng.range(-0.06, 0.04) };
    default:
      return { r: 1 + j(), g: 1 + j(), b: 1 + j(), exposure: 1.05 + rng.range(-0.05, 0.05) };
  }
}

function weatherParams(w: WeatherKind) {
  switch (w) {
    case 'cloudy':
      return { contrast: 0.97, sat: 0.99, glint: 0.4, cool: 0.0 };
    case 'overcast':
      return { contrast: 0.9, sat: 0.88, glint: 0.08, cool: 0.05 };
    default:
      return { contrast: 1.1, sat: 1.06, glint: 1.0, cool: 0.0 };
  }
}

function sampleBilinear(
  world: Uint8ClampedArray,
  W: number,
  H: number,
  x: number,
  y: number,
): RGB {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const at = (xx: number, yy: number): RGB => {
    const cx = clamp(xx, 0, W - 1) | 0;
    const cy = clamp(yy, 0, H - 1) | 0;
    const i = (cy * W + cx) * 4;
    return { r: world[i], g: world[i + 1], b: world[i + 2] };
  };
  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  return {
    r: lerp(lerp(a.r, b.r, tx), lerp(c.r, d.r, tx), ty),
    g: lerp(lerp(a.g, b.g, tx), lerp(c.g, d.g, tx), ty),
    b: lerp(lerp(a.b, b.b, tx), lerp(c.b, d.b, tx), ty),
  };
}

function buildCameraPoses(field: FieldLayout, n: number, seed: number): PhotoPose[] {
  const rng = new Rng(seed + 31337);
  const { rows, perStrip } = chooseGrid(n, field.width, field.height);
  const sx = field.width / perStrip;
  const sy = field.height / rows;
  // 60% 重叠 -> 足迹 = 间距 / 0.4
  const footprintW = sx / 0.42;
  const footprintH = sy / 0.42;
  const scale = Math.max(footprintW / PHOTO_W, footprintH / PHOTO_H);

  const poses: PhotoPose[] = [];
  let emitted = 0;
  for (let r = 0; r < rows && emitted < n; r++) {
    const y = (r + 0.5) * sy;
    const leftToRight = r % 2 === 0;
    for (let k = 0; k < perStrip && emitted < n; k++) {
      const kk = leftToRight ? k : perStrip - 1 - k;
      const x = (kk + 0.5) * sx;
      poses.push({
        cx: x + rng.range(-sx * 0.08, sx * 0.08),
        cy: y + rng.range(-sy * 0.08, sy * 0.08),
        scale,
        rotation: rng.range(-0.01, 0.01),
      });
      emitted++;
    }
  }
  return poses;
}

function renderPhoto(
  world: { width: number; height: number; data: Uint8ClampedArray },
  truePose: PhotoPose,
  opts: Required<Pick<SynthOptions, 'weather' | 'algae'>> & { lighting: LightingKind; mission: 'morning' | 'evening' },
  index: number,
  seed: number,
): Photo {
  const rng = new Rng(seed + index * 7919);
  const { weather, algae, lighting, mission } = opts;
  const wp = weatherParams(weather);
  const lg = lightingGains(lighting, rng);
  const data = new Uint8ClampedArray(PHOTO_W * PHOTO_H * 4);

  const cos = Math.cos(truePose.rotation);
  const sin = Math.sin(truePose.rotation);
  const halfW = PHOTO_W / 2;
  const halfH = PHOTO_H / 2;

  // 太阳角度造成的方向性亮度梯度方向
  const gradAngle = lighting === 'evening' ? -0.6 : lighting === 'morning' ? 0.5 : 1.2;
  const gx = Math.cos(gradAngle);
  const gy = Math.sin(gradAngle);
  const gradAmp = lighting === 'noon' ? 0.03 : 0.09;

  for (let py = 0; py < PHOTO_H; py++) {
    for (let px = 0; px < PHOTO_W; px++) {
      const lx = (px - halfW) * truePose.scale;
      const ly = (py - halfH) * truePose.scale;
      const wx = truePose.cx + (lx * cos - ly * sin);
      const wy = truePose.cy + (lx * sin + ly * cos);
      const c = sampleBilinear(world.data, world.width, world.height, wx, wy);

      // 方向光梯度 + 暗角
      const dir = ((px / PHOTO_W - 0.5) * gx + (py / PHOTO_H - 0.5) * gy) * 2;
      const dxn = px / halfW - 1;
      const dyn = py / halfH - 1;
      const vign = 1 - 0.16 * (dxn * dxn + dyn * dyn) * 0.5;
      const light = (1 + dir * gradAmp) * vign * lg.exposure;

      // 先做只与天气有关的饱和度/对比度影调（各架次一致）
      let r = c.r;
      let g = c.g;
      let b = c.b;
      const lum0 = 0.299 * r + 0.587 * g + 0.114 * b;
      r = lum0 + (r - lum0) * wp.sat;
      g = lum0 + (g - lum0) * wp.sat;
      b = lum0 + (b - lum0) * wp.sat;
      r = (r - 128) * wp.contrast + 128;
      g = (g - 128) * wp.contrast + 128;
      b = (b - 128) * wp.contrast + 128;

      // 末级再乘太阳角度/曝光/色温增益：纯乘法，拼接时可用土埂本色锚定精确抵消，
      // 从而把早晨与傍晚校正到同一光照帧。
      r *= lg.r * light * (1 - wp.cool * 0.4);
      g *= lg.g * light;
      b *= lg.b * light * (1 + wp.cool);

      // 传感器噪声
      const nz = rng.gauss() * 6;
      const i = (py * PHOTO_W + px) * 4;
      data[i] = clamp(r + nz, 0, 255);
      data[i + 1] = clamp(g + nz, 0, 255);
      data[i + 2] = clamp(b + nz, 0, 255);
      data[i + 3] = 255;
    }
  }

  // 水面反光/太阳耀斑：视角相关，同一块池在不同照片里位置/强度不同
  const glints = Math.round((2 + rng.next() * 4) * wp.glint + (wp.glint > 0.5 ? 2 : 0));
  for (let k = 0; k < glints; k++) {
    const cx = rng.range(0, PHOTO_W);
    const cy = rng.range(0, PHOTO_H);
    const rx = rng.range(10, 46) * (lighting === 'noon' ? 0.7 : 1.3);
    const ry = rng.range(3, 10);
    const ang = rng.range(-0.4, 0.4) + gradAngle;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const intensity = rng.range(0.35, 0.85) * wp.glint;
    for (let y = Math.max(0, cy - ry * 2); y < Math.min(PHOTO_H, cy + ry * 2); y++) {
      for (let x = Math.max(0, cx - rx); x < Math.min(PHOTO_W, cx + rx); x++) {
        const ddx = x - cx;
        const ddy = y - cy;
        const u = (ddx * ca + ddy * sa) / rx;
        const v = (-ddx * sa + ddy * ca) / ry;
        const d = u * u + v * v;
        if (d < 1) {
          const a = Math.pow(1 - d, 2) * intensity;
          const i = (y * PHOTO_W + x) * 4;
          data[i] = clamp(data[i] + (255 - data[i]) * a, 0, 255);
          data[i + 1] = clamp(data[i + 1] + (255 - data[i + 1]) * a, 0, 255);
          data[i + 2] = clamp(data[i + 2] + (255 - data[i + 2]) * a * 0.96, 0, 255);
        }
      }
    }
  }

  // 近似位姿（机载 GPS）：在真实位姿上加抖动，旋转未知按 0 给
  const gpsJitter = 7;
  const pose: PhotoPose = {
    cx: truePose.cx + rng.range(-gpsJitter, gpsJitter),
    cy: truePose.cy + rng.range(-gpsJitter, gpsJitter),
    scale: truePose.scale * rng.range(0.985, 1.015),
    rotation: 0,
  };

  return {
    id: `${opts.mission === 'evening' ? 'E' : 'M'}-${String(index + 1).padStart(4, '0')}`,
    name: `${opts.mission === 'evening' ? '傍晚' : '早晨'}_${String(index + 1).padStart(4, '0')}.jpg`,
    width: PHOTO_W,
    height: PHOTO_H,
    data,
    lighting,
    weather,
    algae,
    pose,
    truePose,
    mission,
  };
}

/** 生成完整合成数据集（世界 + 主架次照片，可选傍晚架次） */
export function generateDataset(opts: SynthOptions): GeneratedDataset {
  const seed = opts.seed ?? 20240517;
  const field = buildField(seed, true);
  const world = renderWorld(field, opts.algae, seed);

  const lighting: LightingKind = opts.lighting ?? (opts.mission === 'evening' ? 'evening' : 'morning');
  const poses = buildCameraPoses(field, opts.count, seed);
  const photos: Photo[] = poses.map((p, i) =>
    renderPhoto(world, p, { weather: opts.weather, algae: opts.algae, lighting, mission: opts.mission ?? 'morning' }, i, seed + 101),
  );

  if (opts.withEvening) {
    // 傍晚第二架次：同航线，光照完全不同、反光重新分布
    const evePoses = buildCameraPoses(field, opts.count, seed + 555);
    evePoses.forEach((p, i) => {
      photos.push(
        renderPhoto(
          world,
          p,
          { weather: opts.weather, algae: opts.algae, lighting: 'evening', mission: 'evening' },
          i,
          seed + 7777,
        ),
      );
    });
  }

  return { field, photos, world };
}
