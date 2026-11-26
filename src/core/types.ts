// 共享领域类型：航拍照片、盐田、池子、标定与分析结果

export interface RGB {
  r: number; // 0-255
  g: number;
  b: number;
}

export interface Lab {
  L: number; // 0-100
  a: number;
  b: number;
}

/** 一张合成（或导入）的航拍照片 */
export interface Photo {
  id: string;
  name: string;
  /** 照片像素宽 */
  width: number;
  height: number;
  /** RGBA 像素；结构化克隆可直接进 Worker */
  data: Uint8ClampedArray;
  /** 拍摄时的光照档位，用于早晚校正与评测 */
  lighting: LightingKind;
  /** 天气档位 */
  weather: WeatherKind;
  /** 藻类档位 */
  algae: AlgaeKind;
  /** 相机在盐田大图坐标系中的位置（像素）与尺度（大图px / 照片px） */
  pose: PhotoPose;
  /** 合成数据的真实位姿（含 GPS 抖动），仅评测对齐精度用；真实导入照片没有 */
  truePose?: PhotoPose;
  /** 飞行架次：morning / evening */
  mission: 'morning' | 'evening';
  /** 合成真值：该照片覆盖到的池子及在照片中的多边形（评测用，真实导入照片没有） */
  truth?: PhotoTruth;
}

export interface PhotoPose {
  /** 照片中心在大图坐标中的 x/y */
  cx: number;
  cy: number;
  /** 大图坐标每照片像素的缩放 */
  scale: number;
  /** 旋转（弧度），合成数据用接近 0 的小角 */
  rotation: number;
}

export interface PhotoTruth {
  /** 覆盖到的池子 id 列表 */
  panIds: string[];
}

export type WeatherKind = 'sunny' | 'cloudy' | 'overcast';
export type AlgaeKind = 'none' | 'medium' | 'bloom';
export type LightingKind = 'morning' | 'noon' | 'evening';

/** 池子在大图上的四边形（大图坐标），顺序：左上、右上、右下、左下 */
export type Quad = [Point, Point, Point, Point];

export interface Point {
  x: number;
  y: number;
}

export interface Pan {
  id: string;
  row: number;
  col: number;
  /** 池子内沿四边形（对齐土埂内沿后） */
  quad: Quad;
  /** 拼接/分割得到的轴对齐外接框，用于快速取像素 */
  bbox: BBox;
  /** 合成真值波美度（评测用） */
  trueBaume?: number;
  /** 当天舀样实测波美度（盐场波美计数据） */
  measuredBaume?: number;
  /** 实测时间/备注 */
  measuredAt?: string;
  note?: string;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 标定样本：实测波美度 <-> 测得的池水颜色特征 */
export interface CalibSample {
  id: string;
  baume: number;
  /** 标定色块的平均 RGB（sRGB 0-255） */
  rgb: RGB;
  /** 来源：波美计实测录入 / 当天舀样 */
  source: string;
  date: string;
}

/** 单块池子的颜色成分统计，盐花 / 泥 / 反光 / 藻色分开计数 */
export interface PanColorStats {
  panId: string;
  /** 参与池水颜色计算的有效像素数 */
  waterPixels: number;
  saltPixels: number;
  mudPixels: number;
  glintPixels: number;
  ridgePixels: number;
  /** 各成分占比 0-1（相对池子外接框内像素） */
  fractions: {
    water: number;
    salt: number;
    mud: number;
    glint: number;
    ridge: number;
  };
  /** 拉匀光照后的池水稳健平均色 */
  meanRGB: RGB;
  medianRGB: RGB;
  meanLab: Lab;
  /** 粉红藻色指数与发白结晶指数，互不干扰 */
  pinkIndex: number;
  whiteIndex: number;
  /** 推出的波美度 */
  baume: number;
  /** 与当天实测的误差（有实测时） */
  errorVsMeasured?: number;
  /** 是否异常（突然变淡等） */
  anomaly: boolean;
  anomalyReasons: string[];
  /** 置信度 0-1 */
  confidence: number;
}

export interface StitchResult {
  width: number;
  height: number;
  /** RGBA 大图 */
  data: Uint8ClampedArray;
  /** 每张照片校正后的整体增益，用于报告 */
  gains: { id: string; r: number; g: number; b: number }[];
  /** 对齐残差（大图 px） */
  alignRmse: number;
  /** 拼接后精修的位姿 */
  poses?: PhotoPose[];
  /** 耗时 ms */
  elapsedMs: number;
}

export interface AnalysisResult {
  pans: Pan[];
  stats: PanColorStats[];
  /** 浓度图离屏 RGBA（与大图同尺寸的标注层） */
  overlay: Uint8ClampedArray;
  width: number;
  height: number;
  elapsedMs: number;
  /** 评测汇总（仅有真值/实测时） */
  evaluation?: EvalSummary;
}

export interface EvalSummary {
  total: number;
  withMeasurement: number;
  withinTolerance: number;
  tolerance: number;
  maxAbsError: number;
  meanAbsError: number;
  rmse: number;
  /** 合成真值口径 */
  trueWithinTolerance?: number;
  trueMaxAbsError?: number;
  trueMeanAbsError?: number;
  /** 边界贴合误差（大图 px，相对合成真值内沿） */
  boundaryMeanPx?: number;
  boundaryMaxPx?: number;
}

export interface DatasetManifest {
  id: string;
  createdAt: string;
  weather: WeatherKind;
  algae: AlgaeKind;
  photoCount: number;
  panCount: number;
  missions: number;
  /** 大图世界尺寸 */
  worldWidth: number;
  worldHeight: number;
  seed: number;
}
