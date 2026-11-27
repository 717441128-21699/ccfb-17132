// 共享类型定义 —— 核心算法层不依赖 DOM，可同时在浏览器 Worker 与 Node 中运行。

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 每通道 0..255 */
  data: Uint8ClampedArray;
}

export type Weather = 'sunny' | 'cloudy';
export type FlightTime = 'morning' | 'noon' | 'evening';

export interface GeoRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PhotoMeta {
  id: number;
  name: string;
  /** 照片 footprint 在虚拟世界坐标系中的范围（1 世界单位 = 1 像素） */
  footprint: GeoRect;
  sunAzimuth: number;
  sunElevation: number;
  weather: Weather;
  flightTime: FlightTime;
  /** 单张曝光系数（不同照片亮度不一致的来源） */
  exposure: number;
  seed: number;
}

export type PondZone = 'reservoir' | 'evaporator' | 'crystallizer';

export interface Blob {
  x: number;
  y: number;
  rx: number;
  ry: number;
  angle: number;
}

export interface PondDef {
  id: number;
  name: string;
  /** 世界坐标多边形（顺时针/逆时针均可），矩形池，四角带轻微抖动 */
  polygon: [number, number][];
  /** 真值波美度 °Bé */
  baume: number;
  zone: PondZone;
  /** 嗜盐藻强度 0..1，决定粉红到红色的偏移 */
  algaeStrength: number;
  /** 盐花覆盖比例（结晶池白色盐花，须从池水颜色中剔除） */
  saltFraction: number;
  /** 池底露出泥斑比例（须剔除） */
  mudFraction: number;
  saltBlobs: Blob[];
  mudBlobs: Blob[];
}

/** 可序列化的数据集描述（Worker 间传输用） */
export interface DatasetSpec {
  id: string;
  weather: Weather;
  flightTime: FlightTime;
  worldWidth: number;
  worldHeight: number;
  photoWidth: number;
  photoHeight: number;
  photos: PhotoMeta[];
  ponds: PondDef[];
  /** 标准灰板（已知中性参考物，用于光照/色温校正） */
  references: ReferencePanel[];
  /** 全局光照参数 */
  illuminant: {
    /** 白平衡乘子（傍晚偏暖等） */
    rgb: [number, number, number];
    /** 环境光 0..1 */
    ambient: number;
    /** 直射光强度 */
    intensity: number;
  };
  seed: number;
}

export interface ReferencePanel {
  id: number;
  /** 世界坐标矩形（中心位置的方形灰板，铺在埂上） */
  x: number;
  y: number;
  size: number;
  /** 真值：D65 下中性灰 Lab（L≈53, a=0, b=0） */
  targetLab: [number, number, number];
}

export interface Pose {
  id: number;
  /** 照片原点在大图坐标系中的平移 */
  dx: number;
  dy: number;
}

export interface PhotoGain {
  id: number;
  rgb: [number, number, number];
}

export interface MosaicResult {
  width: number;
  height: number;
  canvas: Raster;
  poses: Pose[];
  /** 世界坐标 -> 大图坐标的平移 */
  originX: number;
  originY: number;
  gains: PhotoGain[];
  pairCount: number;
  rejectedPairs: number;
  /** 光照归一化（色温校正）是否已应用 */
  illuminantNormalized: boolean;
}

export type AnomalyCode =
  | 'sudden-drop'
  | 'neighbor-deviation'
  | 'low-valid-fraction'
  | 'high-glint';

export interface AnomalyFlag {
  code: AnomalyCode;
  message: string;
}

export interface PondResult {
  pondId: number;
  name: string;
  zone: PondZone;
  /** 大图坐标系下的池子多边形 */
  polygon: [number, number][];
  meanRGB: [number, number, number];
  meanLab: [number, number, number];
  baumeEst: number;
  baumeTrue: number | null;
  validFraction: number;
  saltFraction: number;
  glintFraction: number;
  mudFraction: number;
  ridgeFraction: number;
  sampleCount: number;
  status: 'normal' | 'warning' | 'alert';
  anomalies: AnomalyFlag[];
}

export interface CalibSample {
  id: string;
  pondName: string;
  baume: number;
  lab: [number, number, number];
  weather: Weather;
  flightTime: FlightTime;
  createdAt: number;
}

export interface CalibAnchor {
  /** 卤水颜色路径弧长坐标 0..1 */
  s: number;
  baume: number;
  lab: [number, number, number];
}

export interface CalibrationModel {
  kind: 'synthetic-default' | 'field';
  anchors: CalibAnchor[];
  fitRmse: number;
  sampleCount: number;
  createdAt: number;
}

export interface PipelineOptions {
  thumbSize?: number;
  tileSize?: number;
  workerCount?: number;
  /** 进度回调，stage 名称 + 0..1 */
  onProgress?: (stage: string, fraction: number, detail?: string) => void;
}

export interface PipelineResult {
  mosaic: MosaicResult;
  ponds: PondResult[];
  elapsedMs: number;
}
