// 迭代 radix-2 FFT 与相位相关，用于航拍照片间的平移配准。
// 全部使用 TypedArray，零堆对象热点；可在 Worker 与 Node 中运行。

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** 一维迭代 FFT（原地），inverse=true 时做逆变换 */
export function fft1d(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if (!isPowerOfTwo(n)) throw new Error(`FFT 长度须为 2 的幂，得到 ${n}`);

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? -1 : 1);
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const uR = re[i + k];
        const uI = im[i + k];
        const vR = re[i + k + half] * curR - im[i + k + half] * curI;
        const vI = re[i + k + half] * curI + im[i + k + half] * curR;
        re[i + k] = uR + vR;
        im[i + k] = uI + vI;
        re[i + k + half] = uR - vR;
        im[i + k + half] = uI - vI;
        const nr = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nr;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** 对 N×N 实数灰度图做二维 FFT（输出频谱数组由调用方提供） */
export function fft2dReal(
  gray: Float64Array,
  n: number,
  outRe: Float64Array,
  outIm: Float64Array,
): void {
  const rowRe = new Float64Array(n);
  const rowIm = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    const off = y * n;
    for (let x = 0; x < n; x++) rowRe[x] = gray[off + x];
    rowIm.fill(0);
    fft1d(rowRe, rowIm, false);
    for (let x = 0; x < n; x++) {
      outRe[off + x] = rowRe[x];
      outIm[off + x] = rowIm[x];
    }
  }
  const colRe = new Float64Array(n);
  const colIm = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      colRe[y] = outRe[y * n + x];
      colIm[y] = outIm[y * n + x];
    }
    fft1d(colRe, colIm, false);
    for (let y = 0; y < n; y++) {
      outRe[y * n + x] = colRe[y];
      outIm[y * n + x] = colIm[y];
    }
  }
}

export interface PhaseShift {
  dx: number;
  dy: number;
  /** 主峰能量 / 平均能量，配准置信度 */
  peak: number;
}

/**
 * 相位相关：求 B 相对 A 的整数平移 (dx, dy)，使 B(x,y) ≈ A(x-dx, y-dy)。
 * 输入为等大 N×N（2 的幂）灰度数组，建议先加 Hann 窗。
 */
export function phaseCorrelation(
  grayA: Float64Array,
  grayB: Float64Array,
  n: number,
): PhaseShift {
  const reA = new Float64Array(n * n);
  const imA = new Float64Array(n * n);
  const reB = new Float64Array(n * n);
  const imB = new Float64Array(n * n);
  fft2dReal(grayA, n, reA, imA);
  fft2dReal(grayB, n, reB, imB);

  // R = A * conj(B) / |A * conj(B)|
  const rRe = new Float64Array(n * n);
  const rIm = new Float64Array(n * n);
  const EPS = 1e-9;
  for (let i = 0; i < n * n; i++) {
    const rr = reA[i] * reB[i] + imA[i] * imB[i];
    const ri = imA[i] * reB[i] - reA[i] * imB[i];
    const mag = Math.hypot(rr, ri) + EPS;
    rRe[i] = rr / mag;
    rIm[i] = ri / mag;
  }

  // IFFT 2D
  const rowRe = new Float64Array(n);
  const rowIm = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    const off = y * n;
    rowRe.set(rRe.subarray(off, off + n));
    rowIm.set(rIm.subarray(off, off + n));
    fft1d(rowRe, rowIm, true);
    for (let x = 0; x < n; x++) {
      rRe[off + x] = rowRe[x];
      rIm[off + x] = rowIm[x];
    }
  }
  const colRe = new Float64Array(n);
  const colIm = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      colRe[y] = rRe[y * n + x];
      colIm[y] = rIm[y * n + x];
    }
    fft1d(colRe, colIm, true);
    for (let y = 0; y < n; y++) rRe[y * n + x] = colRe[y];
  }

  let peakIdx = 0;
  let peakVal = -1;
  let sum = 0;
  for (let i = 0; i < n * n; i++) {
    const v = rRe[i];
    sum += v;
    if (v > peakVal) {
      peakVal = v;
      peakIdx = i;
    }
  }
  const mean = sum / (n * n);
  let dx = peakIdx % n;
  let dy = (peakIdx / n) | 0;
  // 环绕位移换算为有符号平移
  if (dx > n / 2) dx -= n;
  if (dy > n / 2) dy -= n;
  return { dx, dy, peak: mean > 1e-12 ? peakVal / mean : peakVal };
}

/** Hann 窗，抑制 FFT 边缘泄漏 */
export function applyHann(gray: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const wx = 0.5 * (1 - Math.cos((2 * Math.PI * x) / (n - 1)));
      const wy = 0.5 * (1 - Math.cos((2 * Math.PI * y) / (n - 1)));
      out[y * n + x] = gray[y * n + x] * wx * wy;
    }
  }
  return out;
}
