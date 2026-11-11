/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Colour science for the theme generator (tools/theme.mjs) and the
 * styleguide's live preview: plain ES2022, no dependency and no Node API,
 * so the same file runs in Node and in a browser.
 *
 *   HCT       Cam16, ViewingConditions, HctSolver, Hct, TonalPalette,
 *             DislikeAnalyzer, TemperatureCache, Contrast, and the palettes
 *             of the scheme variants (schemePalettes: tonal-spot, vibrant,
 *             neutral, fidelity, monochrome)
 *   sRGB      argbFromHex(), hexFromArgb(), parseColor() (#hex, rgb(), oklch())
 *   OKLCH     oklchFromArgb(), argbFromOklch() with CSS Color 4 gamut mapping
 *   contrast  wcagContrast() (WCAG 2, the contract) and apcaContrast()
 *             (APCA-W3 0.0.98G-4g, advisory only)
 *
 * The HCT part is a port of Material Color Utilities (TypeScript, Apache
 * License 2.0, Copyright 2021-2023 Google LLC,
 * https://github.com/material-foundation/material-color-utilities): the
 * same constants, the same order of operations and the same rounding, so a
 * colour comes out bit for bit as MCU computes it (test/theme-generator.test.js
 * holds MCU's own reference values). The scheme palettes follow MCU's 2021
 * spec (DynamicSchemePalettesDelegateImpl2021). MCU's dynamic colours (the
 * Material roles and their contrast curves) are not ported: Z-Dash
 * has its own roles, and tools/theme.mjs maps them onto these palettes and
 * enforces the pairs of theme-rules.mjs. See LICENSE for the notice.
 */

// ── math_utils ─────────────────────────────────────────────────────────────

const signum = (num) => (num < 0 ? -1 : num === 0 ? 0 : 1);
const lerp = (start, stop, amount) => (1.0 - amount) * start + amount * stop;
const clampInt = (min, max, input) => (input < min ? min : input > max ? max : input);
const clampDouble = (min, max, input) => (input < min ? min : input > max ? max : input);

function sanitizeDegreesInt(degrees) {
  degrees %= 360;
  if (degrees < 0) degrees += 360;
  return degrees;
}

/** An angle in [0, 360). */
export function sanitizeDegreesDouble(degrees) {
  degrees %= 360.0;
  if (degrees < 0) degrees += 360.0;
  return degrees;
}

/** The shortest distance between two angles, in degrees. */
export function differenceDegrees(a, b) {
  return 180.0 - Math.abs(Math.abs(a - b) - 180.0);
}

function matrixMultiply(row, matrix) {
  const a = row[0] * matrix[0][0] + row[1] * matrix[0][1] + row[2] * matrix[0][2];
  const b = row[0] * matrix[1][0] + row[1] * matrix[1][1] + row[2] * matrix[1][2];
  const c = row[0] * matrix[2][0] + row[1] * matrix[2][1] + row[2] * matrix[2][2];
  return [a, b, c];
}

// ── color_utils ────────────────────────────────────────────────────────────

const SRGB_TO_XYZ = [
  [0.41233895, 0.35762064, 0.18051042],
  [0.2126, 0.7152, 0.0722],
  [0.01932141, 0.11916382, 0.95034478],
];

const XYZ_TO_SRGB = [
  [3.2413774792388685, -1.5376652402851851, -0.49885366846268053],
  [-0.9691452513005321, 1.8758853451067872, 0.04156585616912061],
  [0.05562093689691305, -0.20395524564742123, 1.0571799111220335],
];

const WHITE_POINT_D65 = [95.047, 100.0, 108.883];

/** An opaque ARGB integer from 0-255 channels. */
export function argbFromRgb(red, green, blue) {
  return ((255 << 24) | ((red & 255) << 16) | ((green & 255) << 8) | (blue & 255)) >>> 0;
}

export function argbFromLinrgb(linrgb) {
  return argbFromRgb(delinearized(linrgb[0]), delinearized(linrgb[1]), delinearized(linrgb[2]));
}

export const alphaFromArgb = (argb) => (argb >> 24) & 255;
export const redFromArgb = (argb) => (argb >> 16) & 255;
export const greenFromArgb = (argb) => (argb >> 8) & 255;
export const blueFromArgb = (argb) => argb & 255;

export function argbFromXyz(x, y, z) {
  const matrix = XYZ_TO_SRGB;
  const linearR = matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z;
  const linearG = matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z;
  const linearB = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z;
  return argbFromRgb(delinearized(linearR), delinearized(linearG), delinearized(linearB));
}

export function xyzFromArgb(argb) {
  const r = linearized(redFromArgb(argb));
  const g = linearized(greenFromArgb(argb));
  const b = linearized(blueFromArgb(argb));
  return matrixMultiply([r, g, b], SRGB_TO_XYZ);
}

export function argbFromLab(l, a, b) {
  const whitePoint = WHITE_POINT_D65;
  const fy = (l + 16.0) / 116.0;
  const fx = a / 500.0 + fy;
  const fz = fy - b / 200.0;
  return argbFromXyz(labInvf(fx) * whitePoint[0], labInvf(fy) * whitePoint[1], labInvf(fz) * whitePoint[2]);
}

export function labFromArgb(argb) {
  const linearR = linearized(redFromArgb(argb));
  const linearG = linearized(greenFromArgb(argb));
  const linearB = linearized(blueFromArgb(argb));
  const matrix = SRGB_TO_XYZ;
  const x = matrix[0][0] * linearR + matrix[0][1] * linearG + matrix[0][2] * linearB;
  const y = matrix[1][0] * linearR + matrix[1][1] * linearG + matrix[1][2] * linearB;
  const z = matrix[2][0] * linearR + matrix[2][1] * linearG + matrix[2][2] * linearB;
  const whitePoint = WHITE_POINT_D65;
  const fx = labF(x / whitePoint[0]);
  const fy = labF(y / whitePoint[1]);
  const fz = labF(z / whitePoint[2]);
  return [116.0 * fy - 16, 500.0 * (fx - fy), 200.0 * (fy - fz)];
}

export function argbFromLstar(lstar) {
  const component = delinearized(yFromLstar(lstar));
  return argbFromRgb(component, component, component);
}

/** L* (CIE lightness, HCT tone) of a colour. */
export function lstarFromArgb(argb) {
  const y = xyzFromArgb(argb)[1];
  return 116.0 * labF(y / 100.0) - 16.0;
}

/** Relative luminance Y (0-100) of a tone. */
export function yFromLstar(lstar) {
  return 100.0 * labInvf((lstar + 16.0) / 116.0);
}

export function lstarFromY(y) {
  return labF(y / 100.0) * 116.0 - 16.0;
}

/** An sRGB channel (0-255) to linear RGB (0-100). */
export function linearized(rgbComponent) {
  const normalized = rgbComponent / 255.0;
  if (normalized <= 0.040449936) return (normalized / 12.92) * 100.0;
  return Math.pow((normalized + 0.055) / 1.055, 2.4) * 100.0;
}

/** Linear RGB (0-100) to an sRGB channel (0-255, rounded and clamped). */
export function delinearized(rgbComponent) {
  const normalized = rgbComponent / 100.0;
  let value = 0.0;
  if (normalized <= 0.0031308) value = normalized * 12.92;
  else value = 1.055 * Math.pow(normalized, 1.0 / 2.4) - 0.055;
  return clampInt(0, 255, Math.round(value * 255.0));
}

export const whitePointD65 = () => WHITE_POINT_D65;

function labF(t) {
  const e = 216.0 / 24389.0;
  const kappa = 24389.0 / 27.0;
  return t > e ? Math.pow(t, 1.0 / 3.0) : (kappa * t + 16) / 116;
}

function labInvf(ft) {
  const e = 216.0 / 24389.0;
  const kappa = 24389.0 / 27.0;
  const ft3 = ft * ft * ft;
  return ft3 > e ? ft3 : (116 * ft - 16) / kappa;
}

// ── viewing_conditions ─────────────────────────────────────────────────────

/** The environment a colour is seen in (CAM16). DEFAULT is sRGB's: D65, 200 lux, L* 50 background, average surround. */
export class ViewingConditions {
  static make(
    whitePoint = whitePointD65(),
    adaptingLuminance = ((200.0 / Math.PI) * yFromLstar(50.0)) / 100.0,
    backgroundLstar = 50.0,
    surround = 2.0,
    discountingIlluminant = false,
  ) {
    const xyz = whitePoint;
    const rW = xyz[0] * 0.401288 + xyz[1] * 0.650173 + xyz[2] * -0.051461;
    const gW = xyz[0] * -0.250268 + xyz[1] * 1.204414 + xyz[2] * 0.045854;
    const bW = xyz[0] * -0.002079 + xyz[1] * 0.048952 + xyz[2] * 0.953127;
    const f = 0.8 + surround / 10.0;
    const c = f >= 0.9 ? lerp(0.59, 0.69, (f - 0.9) * 10.0) : lerp(0.525, 0.59, (f - 0.8) * 10.0);
    let d = discountingIlluminant ? 1.0 : f * (1.0 - (1.0 / 3.6) * Math.exp((-adaptingLuminance - 42.0) / 92.0));
    d = d > 1.0 ? 1.0 : d < 0.0 ? 0.0 : d;
    const nc = f;
    const rgbD = [d * (100.0 / rW) + 1.0 - d, d * (100.0 / gW) + 1.0 - d, d * (100.0 / bW) + 1.0 - d];
    const k = 1.0 / (5.0 * adaptingLuminance + 1.0);
    const k4 = k * k * k * k;
    const k4F = 1.0 - k4;
    const fl = k4 * adaptingLuminance + 0.1 * k4F * k4F * Math.cbrt(5.0 * adaptingLuminance);
    const n = yFromLstar(backgroundLstar) / whitePoint[1];
    const z = 1.48 + Math.sqrt(n);
    const nbb = 0.725 / Math.pow(n, 0.2);
    const ncb = nbb;
    const rgbAFactors = [
      Math.pow((fl * rgbD[0] * rW) / 100.0, 0.42),
      Math.pow((fl * rgbD[1] * gW) / 100.0, 0.42),
      Math.pow((fl * rgbD[2] * bW) / 100.0, 0.42),
    ];
    const rgbA = [
      (400.0 * rgbAFactors[0]) / (rgbAFactors[0] + 27.13),
      (400.0 * rgbAFactors[1]) / (rgbAFactors[1] + 27.13),
      (400.0 * rgbAFactors[2]) / (rgbAFactors[2] + 27.13),
    ];
    const aw = (2.0 * rgbA[0] + rgbA[1] + 0.05 * rgbA[2]) * nbb;
    return new ViewingConditions(n, aw, nbb, ncb, c, nc, rgbD, fl, Math.pow(fl, 0.25), z);
  }

  constructor(n, aw, nbb, ncb, c, nc, rgbD, fl, fLRoot, z) {
    Object.assign(this, { n, aw, nbb, ncb, c, nc, rgbD, fl, fLRoot, z });
  }
}
ViewingConditions.DEFAULT = ViewingConditions.make();

// ── cam16 ──────────────────────────────────────────────────────────────────

/** CAM16: a colour appearance model (hue, chroma, lightness J, brightness Q, colourfulness M, saturation s, and the UCS coordinates). */
export class Cam16 {
  constructor(hue, chroma, j, q, m, s, jstar, astar, bstar) {
    Object.assign(this, { hue, chroma, j, q, m, s, jstar, astar, bstar });
  }

  /** CAM16-UCS distance. */
  distance(other) {
    const dJ = this.jstar - other.jstar;
    const dA = this.astar - other.astar;
    const dB = this.bstar - other.bstar;
    return 1.41 * Math.pow(Math.sqrt(dJ * dJ + dA * dA + dB * dB), 0.63);
  }

  static fromInt(argb) {
    return Cam16.fromIntInViewingConditions(argb, ViewingConditions.DEFAULT);
  }

  static fromIntInViewingConditions(argb, viewingConditions) {
    const red = (argb & 0x00ff0000) >> 16;
    const green = (argb & 0x0000ff00) >> 8;
    const blue = argb & 0x000000ff;
    const redL = linearized(red);
    const greenL = linearized(green);
    const blueL = linearized(blue);
    const x = 0.41233895 * redL + 0.35762064 * greenL + 0.18051042 * blueL;
    const y = 0.2126 * redL + 0.7152 * greenL + 0.0722 * blueL;
    const z = 0.01932141 * redL + 0.11916382 * greenL + 0.95034478 * blueL;
    return Cam16.fromXyzInViewingConditions(x, y, z, viewingConditions, true);
  }

  static fromJch(j, c, h) {
    return Cam16.fromJchInViewingConditions(j, c, h, ViewingConditions.DEFAULT);
  }

  static fromJchInViewingConditions(j, c, h, viewingConditions) {
    const q = (4.0 / viewingConditions.c) * Math.sqrt(j / 100.0) * (viewingConditions.aw + 4.0) * viewingConditions.fLRoot;
    const m = c * viewingConditions.fLRoot;
    const alpha = c / Math.sqrt(j / 100.0);
    const s = 50.0 * Math.sqrt((alpha * viewingConditions.c) / (viewingConditions.aw + 4.0));
    const hueRadians = (h * Math.PI) / 180.0;
    const jstar = ((1.0 + 100.0 * 0.007) * j) / (1.0 + 0.007 * j);
    const mstar = (1.0 / 0.0228) * Math.log(1.0 + 0.0228 * m);
    return new Cam16(h, c, j, q, m, s, jstar, mstar * Math.cos(hueRadians), mstar * Math.sin(hueRadians));
  }

  static fromUcs(jstar, astar, bstar) {
    return Cam16.fromUcsInViewingConditions(jstar, astar, bstar, ViewingConditions.DEFAULT);
  }

  static fromUcsInViewingConditions(jstar, astar, bstar, viewingConditions) {
    const m = Math.sqrt(astar * astar + bstar * bstar);
    const M = (Math.exp(m * 0.0228) - 1.0) / 0.0228;
    const c = M / viewingConditions.fLRoot;
    let h = Math.atan2(bstar, astar) * (180.0 / Math.PI);
    if (h < 0.0) h += 360.0;
    const j = jstar / (1 - (jstar - 100) * 0.007);
    return Cam16.fromJchInViewingConditions(j, c, h, viewingConditions);
  }

  toInt() {
    return this.viewed(ViewingConditions.DEFAULT);
  }

  viewed(viewingConditions) {
    const [x, y, z] = this.xyzInViewingConditions(viewingConditions);
    return argbFromXyz(x, y, z);
  }

  /**
   * MCU has two copies of this conversion (fromIntInViewingConditions with
   * sanitizeDegreesDouble, fromXyzInViewingConditions with its own wrap);
   * `fromInt` picks the hue wrap of the first, so both stay exact.
   */
  static fromXyzInViewingConditions(x, y, z, viewingConditions, fromInt = false) {
    const rC = 0.401288 * x + 0.650173 * y - 0.051461 * z;
    const gC = -0.250268 * x + 1.204414 * y + 0.045854 * z;
    const bC = -0.002079 * x + 0.048952 * y + 0.953127 * z;
    const rD = viewingConditions.rgbD[0] * rC;
    const gD = viewingConditions.rgbD[1] * gC;
    const bD = viewingConditions.rgbD[2] * bC;
    const rAF = Math.pow((viewingConditions.fl * Math.abs(rD)) / 100.0, 0.42);
    const gAF = Math.pow((viewingConditions.fl * Math.abs(gD)) / 100.0, 0.42);
    const bAF = Math.pow((viewingConditions.fl * Math.abs(bD)) / 100.0, 0.42);
    const rA = (signum(rD) * 400.0 * rAF) / (rAF + 27.13);
    const gA = (signum(gD) * 400.0 * gAF) / (gAF + 27.13);
    const bA = (signum(bD) * 400.0 * bAF) / (bAF + 27.13);
    const a = (11.0 * rA + -12.0 * gA + bA) / 11.0;
    const b = (rA + gA - 2.0 * bA) / 9.0;
    const u = (20.0 * rA + 20.0 * gA + 21.0 * bA) / 20.0;
    const p2 = (40.0 * rA + 20.0 * gA + bA) / 20.0;
    const atanDegrees = (Math.atan2(b, a) * 180.0) / Math.PI;
    const hue = fromInt
      ? sanitizeDegreesDouble(atanDegrees)
      : atanDegrees < 0 ? atanDegrees + 360.0 : atanDegrees >= 360 ? atanDegrees - 360 : atanDegrees;
    const hueRadians = (hue * Math.PI) / 180.0;
    const ac = p2 * viewingConditions.nbb;
    const j = 100.0 * Math.pow(ac / viewingConditions.aw, viewingConditions.c * viewingConditions.z);
    const q = (4.0 / viewingConditions.c) * Math.sqrt(j / 100.0) * (viewingConditions.aw + 4.0) * viewingConditions.fLRoot;
    const huePrime = hue < 20.14 ? hue + 360 : hue;
    const eHue = 0.25 * (Math.cos((huePrime * Math.PI) / 180.0 + 2.0) + 3.8);
    const p1 = (50000.0 / 13.0) * eHue * viewingConditions.nc * viewingConditions.ncb;
    const t = (p1 * Math.sqrt(a * a + b * b)) / (u + 0.305);
    const alpha = Math.pow(t, 0.9) * Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73);
    const c = alpha * Math.sqrt(j / 100.0);
    const m = c * viewingConditions.fLRoot;
    const s = 50.0 * Math.sqrt((alpha * viewingConditions.c) / (viewingConditions.aw + 4.0));
    const jstar = ((1.0 + 100.0 * 0.007) * j) / (1.0 + 0.007 * j);
    const mstar = fromInt ? (1.0 / 0.0228) * Math.log(1.0 + 0.0228 * m) : Math.log(1.0 + 0.0228 * m) / 0.0228;
    return new Cam16(hue, c, j, q, m, s, jstar, mstar * Math.cos(hueRadians), mstar * Math.sin(hueRadians));
  }

  xyzInViewingConditions(viewingConditions) {
    const alpha = this.chroma === 0.0 || this.j === 0.0 ? 0.0 : this.chroma / Math.sqrt(this.j / 100.0);
    const t = Math.pow(alpha / Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73), 1.0 / 0.9);
    const hRad = (this.hue * Math.PI) / 180.0;
    const eHue = 0.25 * (Math.cos(hRad + 2.0) + 3.8);
    const ac = viewingConditions.aw * Math.pow(this.j / 100.0, 1.0 / viewingConditions.c / viewingConditions.z);
    const p1 = eHue * (50000.0 / 13.0) * viewingConditions.nc * viewingConditions.ncb;
    const p2 = ac / viewingConditions.nbb;
    const hSin = Math.sin(hRad);
    const hCos = Math.cos(hRad);
    const gamma = (23.0 * (p2 + 0.305) * t) / (23.0 * p1 + 11.0 * t * hCos + 108.0 * t * hSin);
    const a = gamma * hCos;
    const b = gamma * hSin;
    const rA = (460.0 * p2 + 451.0 * a + 288.0 * b) / 1403.0;
    const gA = (460.0 * p2 - 891.0 * a - 261.0 * b) / 1403.0;
    const bA = (460.0 * p2 - 220.0 * a - 6300.0 * b) / 1403.0;
    const rCBase = Math.max(0, (27.13 * Math.abs(rA)) / (400.0 - Math.abs(rA)));
    const rC = signum(rA) * (100.0 / viewingConditions.fl) * Math.pow(rCBase, 1.0 / 0.42);
    const gCBase = Math.max(0, (27.13 * Math.abs(gA)) / (400.0 - Math.abs(gA)));
    const gC = signum(gA) * (100.0 / viewingConditions.fl) * Math.pow(gCBase, 1.0 / 0.42);
    const bCBase = Math.max(0, (27.13 * Math.abs(bA)) / (400.0 - Math.abs(bA)));
    const bC = signum(bA) * (100.0 / viewingConditions.fl) * Math.pow(bCBase, 1.0 / 0.42);
    const rF = rC / viewingConditions.rgbD[0];
    const gF = gC / viewingConditions.rgbD[1];
    const bF = bC / viewingConditions.rgbD[2];
    const x = 1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF;
    const y = 0.38752654 * rF + 0.62144744 * gF - 0.00897398 * bF;
    const z = -0.0158415 * rF - 0.03412294 * gF + 1.04996444 * bF;
    return [x, y, z];
  }
}

// ── hct_solver ─────────────────────────────────────────────────────────────

const SCALED_DISCOUNT_FROM_LINRGB = [
  [0.001200833568784504, 0.002389694492170889, 0.0002795742885861124],
  [0.0005891086651375999, 0.0029785502573438758, 0.0003270666104008398],
  [0.00010146692491640572, 0.0005364214359186694, 0.0032979401770712076],
];

const LINRGB_FROM_SCALED_DISCOUNT = [
  [1373.2198709594231, -1100.4251190754821, -7.278681089101213],
  [-271.815969077903, 559.6580465940733, -32.46047482791194],
  [1.9622899599665666, -57.173814538844006, 308.7233197812385],
];

const Y_FROM_LINRGB = [0.2126, 0.7152, 0.0722];

/**
 * MCU's table of the 255 linear values where an sRGB channel crosses a
 * half step: linearized((i + 0.5) / 255) for i = 0..254. Computed here with
 * the same formula; test/theme-generator.test.js compares samples with MCU's
 * literal table.
 */
export const CRITICAL_PLANES = Array.from({ length: 255 }, (_, i) => {
  const normalized = (i + 0.5) / 255;
  return normalized <= 0.040449936 ? (normalized / 12.92) * 100.0 : Math.pow((normalized + 0.055) / 1.055, 2.4) * 100.0;
});

const sanitizeRadians = (angle) => (angle + Math.PI * 8) % (Math.PI * 2);

function trueDelinearized(rgbComponent) {
  const normalized = rgbComponent / 100.0;
  const value = normalized <= 0.0031308 ? normalized * 12.92 : 1.055 * Math.pow(normalized, 1.0 / 2.4) - 0.055;
  return value * 255.0;
}

function chromaticAdaptation(component) {
  const af = Math.pow(Math.abs(component), 0.42);
  return (signum(component) * 400.0 * af) / (af + 27.13);
}

function hueOf(linrgb) {
  const scaledDiscount = matrixMultiply(linrgb, SCALED_DISCOUNT_FROM_LINRGB);
  const rA = chromaticAdaptation(scaledDiscount[0]);
  const gA = chromaticAdaptation(scaledDiscount[1]);
  const bA = chromaticAdaptation(scaledDiscount[2]);
  const a = (11.0 * rA + -12.0 * gA + bA) / 11.0;
  const b = (rA + gA - 2.0 * bA) / 9.0;
  return Math.atan2(b, a);
}

function areInCyclicOrder(a, b, c) {
  return sanitizeRadians(b - a) < sanitizeRadians(c - a);
}

const intercept = (source, mid, target) => (mid - source) / (target - source);

function lerpPoint(source, t, target) {
  return [source[0] + (target[0] - source[0]) * t, source[1] + (target[1] - source[1]) * t, source[2] + (target[2] - source[2]) * t];
}

function setCoordinate(source, coordinate, target, axis) {
  return lerpPoint(source, intercept(source[axis], coordinate, target[axis]), target);
}

const isBounded = (x) => x >= 0.0 && x <= 100.0;

function nthVertex(y, n) {
  const [kR, kG, kB] = Y_FROM_LINRGB;
  const coordA = n % 4 <= 1 ? 0.0 : 100.0;
  const coordB = n % 2 === 0 ? 0.0 : 100.0;
  if (n < 4) {
    const g = coordA;
    const b = coordB;
    const r = (y - g * kG - b * kB) / kR;
    return isBounded(r) ? [r, g, b] : [-1.0, -1.0, -1.0];
  }
  if (n < 8) {
    const b = coordA;
    const r = coordB;
    const g = (y - r * kR - b * kB) / kG;
    return isBounded(g) ? [r, g, b] : [-1.0, -1.0, -1.0];
  }
  const r = coordA;
  const g = coordB;
  const b = (y - r * kR - g * kG) / kB;
  return isBounded(b) ? [r, g, b] : [-1.0, -1.0, -1.0];
}

function bisectToSegment(y, targetHue) {
  let left = [-1.0, -1.0, -1.0];
  let right = left;
  let leftHue = 0.0;
  let rightHue = 0.0;
  let initialized = false;
  let uncut = true;
  for (let n = 0; n < 12; n++) {
    const mid = nthVertex(y, n);
    if (mid[0] < 0) continue;
    const midHue = hueOf(mid);
    if (!initialized) {
      left = mid;
      right = mid;
      leftHue = midHue;
      rightHue = midHue;
      initialized = true;
      continue;
    }
    if (uncut || areInCyclicOrder(leftHue, midHue, rightHue)) {
      uncut = false;
      if (areInCyclicOrder(leftHue, targetHue, midHue)) {
        right = mid;
        rightHue = midHue;
      } else {
        left = mid;
        leftHue = midHue;
      }
    }
  }
  return [left, right];
}

const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const criticalPlaneBelow = (x) => Math.floor(x - 0.5);
const criticalPlaneAbove = (x) => Math.ceil(x - 0.5);

function bisectToLimit(y, targetHue) {
  const segment = bisectToSegment(y, targetHue);
  let left = segment[0];
  let leftHue = hueOf(left);
  let right = segment[1];
  for (let axis = 0; axis < 3; axis++) {
    if (left[axis] !== right[axis]) {
      let lPlane = -1;
      let rPlane = 255;
      if (left[axis] < right[axis]) {
        lPlane = criticalPlaneBelow(trueDelinearized(left[axis]));
        rPlane = criticalPlaneAbove(trueDelinearized(right[axis]));
      } else {
        lPlane = criticalPlaneAbove(trueDelinearized(left[axis]));
        rPlane = criticalPlaneBelow(trueDelinearized(right[axis]));
      }
      for (let i = 0; i < 8; i++) {
        if (Math.abs(rPlane - lPlane) <= 1) break;
        const mPlane = Math.floor((lPlane + rPlane) / 2.0);
        const mid = setCoordinate(left, CRITICAL_PLANES[mPlane], right, axis);
        const midHue = hueOf(mid);
        if (areInCyclicOrder(leftHue, targetHue, midHue)) {
          right = mid;
          rPlane = mPlane;
        } else {
          left = mid;
          leftHue = midHue;
          lPlane = mPlane;
        }
      }
    }
  }
  return midpoint(left, right);
}

function inverseChromaticAdaptation(adapted) {
  const adaptedAbs = Math.abs(adapted);
  const base = Math.max(0, (27.13 * adaptedAbs) / (400.0 - adaptedAbs));
  return signum(adapted) * Math.pow(base, 1.0 / 0.42);
}

function findResultByJ(hueRadians, chroma, y) {
  let j = Math.sqrt(y) * 11.0;
  const viewingConditions = ViewingConditions.DEFAULT;
  const tInnerCoeff = 1 / Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73);
  const eHue = 0.25 * (Math.cos(hueRadians + 2.0) + 3.8);
  const p1 = eHue * (50000.0 / 13.0) * viewingConditions.nc * viewingConditions.ncb;
  const hSin = Math.sin(hueRadians);
  const hCos = Math.cos(hueRadians);
  for (let iterationRound = 0; iterationRound < 5; iterationRound++) {
    const jNormalized = j / 100.0;
    const alpha = chroma === 0.0 || j === 0.0 ? 0.0 : chroma / Math.sqrt(jNormalized);
    const t = Math.pow(alpha * tInnerCoeff, 1.0 / 0.9);
    const ac = viewingConditions.aw * Math.pow(jNormalized, 1.0 / viewingConditions.c / viewingConditions.z);
    const p2 = ac / viewingConditions.nbb;
    const gamma = (23.0 * (p2 + 0.305) * t) / (23.0 * p1 + 11 * t * hCos + 108.0 * t * hSin);
    const a = gamma * hCos;
    const b = gamma * hSin;
    const rA = (460.0 * p2 + 451.0 * a + 288.0 * b) / 1403.0;
    const gA = (460.0 * p2 - 891.0 * a - 261.0 * b) / 1403.0;
    const bA = (460.0 * p2 - 220.0 * a - 6300.0 * b) / 1403.0;
    const linrgb = matrixMultiply(
      [inverseChromaticAdaptation(rA), inverseChromaticAdaptation(gA), inverseChromaticAdaptation(bA)],
      LINRGB_FROM_SCALED_DISCOUNT,
    );
    if (linrgb[0] < 0 || linrgb[1] < 0 || linrgb[2] < 0) return 0;
    const [kR, kG, kB] = Y_FROM_LINRGB;
    const fnj = kR * linrgb[0] + kG * linrgb[1] + kB * linrgb[2];
    if (fnj <= 0) return 0;
    if (iterationRound === 4 || Math.abs(fnj - y) < 0.002) {
      if (linrgb[0] > 100.01 || linrgb[1] > 100.01 || linrgb[2] > 100.01) return 0;
      return argbFromLinrgb(linrgb);
    }
    // Newton's method on J.
    j -= ((fnj - y) * j) / (2 * fnj);
  }
  return 0;
}

/** HCT to sRGB: the colour of that hue and tone with the chroma asked for, or the most chroma sRGB holds there. */
export const HctSolver = {
  solveToInt(hueDegrees, chroma, lstar) {
    if (chroma < 0.0001 || lstar < 0.0001 || lstar > 99.9999) return argbFromLstar(lstar);
    hueDegrees = sanitizeDegreesDouble(hueDegrees);
    const hueRadians = (hueDegrees / 180) * Math.PI;
    const y = yFromLstar(lstar);
    const exactAnswer = findResultByJ(hueRadians, chroma, y);
    if (exactAnswer !== 0) return exactAnswer;
    return argbFromLinrgb(bisectToLimit(y, hueRadians));
  },
  solveToCam(hueDegrees, chroma, lstar) {
    return Cam16.fromInt(HctSolver.solveToInt(hueDegrees, chroma, lstar));
  },
};

// ── hct ────────────────────────────────────────────────────────────────────

/** Hue and chroma of CAM16, tone of L*: always an sRGB colour. */
export class Hct {
  static from(hue, chroma, tone) {
    return new Hct(HctSolver.solveToInt(hue, chroma, tone));
  }

  static fromInt(argb) {
    return new Hct(argb);
  }

  constructor(argb) {
    this.setInternalState(argb);
  }

  toInt() {
    return this.argb;
  }

  get hue() {
    return this.internalHue;
  }

  set hue(newHue) {
    this.setInternalState(HctSolver.solveToInt(newHue, this.internalChroma, this.internalTone));
  }

  get chroma() {
    return this.internalChroma;
  }

  set chroma(newChroma) {
    this.setInternalState(HctSolver.solveToInt(this.internalHue, newChroma, this.internalTone));
  }

  get tone() {
    return this.internalTone;
  }

  set tone(newTone) {
    this.setInternalState(HctSolver.solveToInt(this.internalHue, this.internalChroma, newTone));
  }

  toString() {
    return `HCT(${this.hue.toFixed(0)}, ${this.chroma.toFixed(0)}, ${this.tone.toFixed(0)})`;
  }

  static isBlue(hue) {
    return hue >= 250 && hue < 270;
  }

  static isYellow(hue) {
    return hue >= 105 && hue < 125;
  }

  static isCyan(hue) {
    return hue >= 170 && hue < 207;
  }

  setInternalState(argb) {
    const cam = Cam16.fromInt(argb);
    this.internalHue = cam.hue;
    this.internalChroma = cam.chroma;
    this.internalTone = lstarFromArgb(argb);
    this.argb = argb;
  }

  /** This colour as seen in other viewing conditions, expressed in the default ones. */
  inViewingConditions(vc) {
    const viewedInVc = Cam16.fromInt(this.toInt()).xyzInViewingConditions(vc);
    const recastInVc = Cam16.fromXyzInViewingConditions(viewedInVc[0], viewedInVc[1], viewedInVc[2], ViewingConditions.make());
    return Hct.from(recastInVc.hue, recastInVc.chroma, lstarFromY(viewedInVc[1]));
  }
}

// ── tonal_palette ──────────────────────────────────────────────────────────

/** The tone of a colour whose chroma comes closest to the one asked for, nearest to tone 50 (MCU's KeyColor). */
class KeyColor {
  constructor(hue, requestedChroma) {
    this.hue = hue;
    this.requestedChroma = requestedChroma;
    this.chromaCache = new Map();
    this.maxChromaValue = 200.0;
  }

  create() {
    const pivotTone = 50;
    const toneStepSize = 1;
    const epsilon = 0.01;
    let lowerTone = 0;
    let upperTone = 100;
    while (lowerTone < upperTone) {
      const midTone = Math.floor((lowerTone + upperTone) / 2);
      const isAscending = this.maxChroma(midTone) < this.maxChroma(midTone + toneStepSize);
      const sufficientChroma = this.maxChroma(midTone) >= this.requestedChroma - epsilon;
      if (sufficientChroma) {
        if (Math.abs(lowerTone - pivotTone) < Math.abs(upperTone - pivotTone)) {
          upperTone = midTone;
        } else {
          if (lowerTone === midTone) return Hct.from(this.hue, this.requestedChroma, lowerTone);
          lowerTone = midTone;
        }
      } else if (isAscending) {
        lowerTone = midTone + toneStepSize;
      } else {
        upperTone = midTone;
      }
    }
    return Hct.from(this.hue, this.requestedChroma, lowerTone);
  }

  maxChroma(tone) {
    if (this.chromaCache.has(tone)) return this.chromaCache.get(tone);
    const chroma = Hct.from(this.hue, this.maxChromaValue, tone).chroma;
    this.chromaCache.set(tone, chroma);
    return chroma;
  }
}

/** One hue and chroma at every tone (0 black ... 100 white). */
export class TonalPalette {
  static fromInt(argb) {
    return TonalPalette.fromHct(Hct.fromInt(argb));
  }

  static fromHct(hct) {
    return new TonalPalette(hct.hue, hct.chroma, hct);
  }

  static fromHueAndChroma(hue, chroma) {
    return new TonalPalette(hue, chroma, new KeyColor(hue, chroma).create());
  }

  constructor(hue, chroma, keyColor) {
    this.hue = hue;
    this.chroma = chroma;
    this.keyColor = keyColor;
    this.cache = new Map();
  }

  tone(tone) {
    let argb = this.cache.get(tone);
    if (argb === undefined) {
      if (tone === 99 && Hct.isYellow(this.hue)) argb = this.averageArgb(this.tone(98), this.tone(100));
      else argb = Hct.from(this.hue, this.chroma, tone).toInt();
      this.cache.set(tone, argb);
    }
    return argb;
  }

  getHct(tone) {
    return Hct.fromInt(this.tone(tone));
  }

  averageArgb(argb1, argb2) {
    const red = Math.round((((argb1 >>> 16) & 0xff) + ((argb2 >>> 16) & 0xff)) / 2);
    const green = Math.round((((argb1 >>> 8) & 0xff) + ((argb2 >>> 8) & 0xff)) / 2);
    const blue = Math.round(((argb1 & 0xff) + (argb2 & 0xff)) / 2);
    return ((255 << 24) | ((red & 255) << 16) | ((green & 255) << 8) | (blue & 255)) >>> 0;
  }
}

// ── dislike_analyzer ───────────────────────────────────────────────────────

/** Dark yellow-greens ("bile") that people widely dislike, and their fix: the same hue and chroma at tone 70. */
export const DislikeAnalyzer = {
  isDisliked(hct) {
    const huePasses = Math.round(hct.hue) >= 90.0 && Math.round(hct.hue) <= 111.0;
    const chromaPasses = Math.round(hct.chroma) > 16.0;
    const tonePasses = Math.round(hct.tone) < 65.0;
    return huePasses && chromaPasses && tonePasses;
  },
  fixIfDisliked(hct) {
    return DislikeAnalyzer.isDisliked(hct) ? Hct.from(hct.hue, hct.chroma, 70.0) : hct;
  },
};

// ── temperature_cache ──────────────────────────────────────────────────────

/** Warm and cool colours relative to an input (complement, analogous colours). */
export class TemperatureCache {
  constructor(input) {
    this.input = input;
    this.hctsByTempCache = [];
    this.hctsByHueCache = [];
    this.tempsByHctCache = new Map();
    this.inputRelativeTemperatureCache = -1.0;
    this.complementCache = null;
  }

  get hctsByTemp() {
    if (this.hctsByTempCache.length > 0) return this.hctsByTempCache;
    const hcts = this.hctsByHue.concat([this.input]);
    const temperaturesByHct = this.tempsByHct;
    hcts.sort((a, b) => temperaturesByHct.get(a) - temperaturesByHct.get(b));
    this.hctsByTempCache = hcts;
    return hcts;
  }

  get warmest() {
    return this.hctsByTemp[this.hctsByTemp.length - 1];
  }

  get coldest() {
    return this.hctsByTemp[0];
  }

  analogous(count = 5, divisions = 12) {
    const startHue = Math.round(this.input.hue);
    const startHct = this.hctsByHue[startHue];
    let lastTemp = this.relativeTemperature(startHct);
    const allColors = [startHct];
    let absoluteTotalTempDelta = 0.0;
    for (let i = 0; i < 360; i++) {
      const hue = sanitizeDegreesInt(startHue + i);
      const temp = this.relativeTemperature(this.hctsByHue[hue]);
      absoluteTotalTempDelta += Math.abs(temp - lastTemp);
      lastTemp = temp;
    }
    let hueAddend = 1;
    const tempStep = absoluteTotalTempDelta / divisions;
    let totalTempDelta = 0.0;
    lastTemp = this.relativeTemperature(startHct);
    while (allColors.length < divisions) {
      const hue = sanitizeDegreesInt(startHue + hueAddend);
      const hct = this.hctsByHue[hue];
      const temp = this.relativeTemperature(hct);
      totalTempDelta += Math.abs(temp - lastTemp);
      let indexSatisfied = totalTempDelta >= allColors.length * tempStep;
      let indexAddend = 1;
      while (indexSatisfied && allColors.length < divisions) {
        allColors.push(hct);
        indexSatisfied = totalTempDelta >= (allColors.length + indexAddend) * tempStep;
        indexAddend++;
      }
      lastTemp = temp;
      hueAddend++;
      if (hueAddend > 360) {
        while (allColors.length < divisions) allColors.push(hct);
        break;
      }
    }
    const answers = [this.input];
    const increaseHueCount = Math.floor((count - 1) / 2.0);
    for (let i = 1; i < increaseHueCount + 1; i++) {
      let index = 0 - i;
      while (index < 0) index = allColors.length + index;
      if (index >= allColors.length) index %= allColors.length;
      answers.splice(0, 0, allColors[index]);
    }
    const decreaseHueCount = count - increaseHueCount - 1;
    for (let i = 1; i < decreaseHueCount + 1; i++) {
      let index = i;
      while (index < 0) index = allColors.length + index;
      if (index >= allColors.length) index %= allColors.length;
      answers.push(allColors[index]);
    }
    return answers;
  }

  get complement() {
    if (this.complementCache != null) return this.complementCache;
    const coldestHue = this.coldest.hue;
    const coldestTemp = this.tempsByHct.get(this.coldest);
    const warmestHue = this.warmest.hue;
    const warmestTemp = this.tempsByHct.get(this.warmest);
    const range = warmestTemp - coldestTemp;
    const startHueIsColdestToWarmest = TemperatureCache.isBetween(this.input.hue, coldestHue, warmestHue);
    const startHue = startHueIsColdestToWarmest ? warmestHue : coldestHue;
    const endHue = startHueIsColdestToWarmest ? coldestHue : warmestHue;
    const directionOfRotation = 1.0;
    let smallestError = 1000.0;
    let answer = this.hctsByHue[Math.round(this.input.hue)];
    const complementRelativeTemp = 1.0 - this.inputRelativeTemperature;
    for (let hueAddend = 0.0; hueAddend <= 360.0; hueAddend += 1.0) {
      const hue = sanitizeDegreesDouble(startHue + directionOfRotation * hueAddend);
      if (!TemperatureCache.isBetween(hue, startHue, endHue)) continue;
      const possibleAnswer = this.hctsByHue[Math.round(hue)];
      const relativeTemp = (this.tempsByHct.get(possibleAnswer) - coldestTemp) / range;
      const error = Math.abs(complementRelativeTemp - relativeTemp);
      if (error < smallestError) {
        smallestError = error;
        answer = possibleAnswer;
      }
    }
    this.complementCache = answer;
    return this.complementCache;
  }

  relativeTemperature(hct) {
    const range = this.tempsByHct.get(this.warmest) - this.tempsByHct.get(this.coldest);
    const differenceFromColdest = this.tempsByHct.get(hct) - this.tempsByHct.get(this.coldest);
    if (range === 0.0) return 0.5;
    return differenceFromColdest / range;
  }

  get inputRelativeTemperature() {
    if (this.inputRelativeTemperatureCache >= 0.0) return this.inputRelativeTemperatureCache;
    this.inputRelativeTemperatureCache = this.relativeTemperature(this.input);
    return this.inputRelativeTemperatureCache;
  }

  get tempsByHct() {
    if (this.tempsByHctCache.size > 0) return this.tempsByHctCache;
    const temperaturesByHct = new Map();
    for (const e of this.hctsByHue.concat([this.input])) temperaturesByHct.set(e, TemperatureCache.rawTemperature(e));
    this.tempsByHctCache = temperaturesByHct;
    return temperaturesByHct;
  }

  get hctsByHue() {
    if (this.hctsByHueCache.length > 0) return this.hctsByHueCache;
    const hcts = [];
    for (let hue = 0.0; hue <= 360.0; hue += 1.0) hcts.push(Hct.from(hue, this.input.chroma, this.input.tone));
    this.hctsByHueCache = hcts;
    return this.hctsByHueCache;
  }

  static isBetween(angle, a, b) {
    if (a < b) return a <= angle && angle <= b;
    return a <= angle || angle <= b;
  }

  static rawTemperature(color) {
    const lab = labFromArgb(color.toInt());
    const hue = sanitizeDegreesDouble((Math.atan2(lab[2], lab[1]) * 180.0) / Math.PI);
    const chroma = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);
    return -0.5 + 0.02 * Math.pow(chroma, 1.07) * Math.cos((sanitizeDegreesDouble(hue - 50.0) * Math.PI) / 180.0);
  }
}

// ── contrast (MCU's tone arithmetic) ───────────────────────────────────────

/** WCAG 2 contrast between tones, and the lighter or darker tone that reaches a ratio. */
export const Contrast = {
  ratioOfTones(toneA, toneB) {
    return Contrast.ratioOfYs(yFromLstar(clampDouble(0.0, 100.0, toneA)), yFromLstar(clampDouble(0.0, 100.0, toneB)));
  },
  ratioOfYs(y1, y2) {
    const lighter = y1 > y2 ? y1 : y2;
    const darker = lighter === y2 ? y1 : y2;
    return (lighter + 5.0) / (darker + 5.0);
  },
  /** A tone at least `ratio` lighter than `tone`, or -1 when none exists. */
  lighter(tone, ratio) {
    if (tone < 0.0 || tone > 100.0) return -1.0;
    const darkY = yFromLstar(tone);
    const lightY = ratio * (darkY + 5.0) - 5.0;
    const realContrast = Contrast.ratioOfYs(lightY, darkY);
    const delta = Math.abs(realContrast - ratio);
    if (realContrast < ratio && delta > 0.04) return -1;
    const returnValue = lstarFromY(lightY) + 0.4;
    if (returnValue < 0 || returnValue > 100) return -1;
    return returnValue;
  },
  /** A tone at least `ratio` darker than `tone`, or -1 when none exists. */
  darker(tone, ratio) {
    if (tone < 0.0 || tone > 100.0) return -1.0;
    const lightY = yFromLstar(tone);
    const darkY = (lightY + 5.0) / ratio - 5.0;
    const realContrast = Contrast.ratioOfYs(lightY, darkY);
    const delta = Math.abs(realContrast - ratio);
    if (realContrast < ratio && delta > 0.04) return -1;
    const returnValue = lstarFromY(darkY) - 0.4;
    if (returnValue < 0 || returnValue > 100) return -1;
    return returnValue;
  },
  lighterUnsafe(tone, ratio) {
    const lighterSafe = Contrast.lighter(tone, ratio);
    return lighterSafe < 0.0 ? 100.0 : lighterSafe;
  },
  darkerUnsafe(tone, ratio) {
    const darkerSafe = Contrast.darker(tone, ratio);
    return darkerSafe < 0.0 ? 0.0 : darkerSafe;
  },
};

// ── scheme variants (MCU DynamicScheme, 2021 spec palettes) ────────────────

/** MCU's DynamicScheme.getPiecewiseHue. */
export function getPiecewiseHue(sourceColorHct, hueBreakpoints, hues) {
  const size = Math.min(hueBreakpoints.length - 1, hues.length);
  const sourceHue = sourceColorHct.hue;
  for (let i = 0; i < size; i++) {
    if (sourceHue >= hueBreakpoints[i] && sourceHue < hueBreakpoints[i + 1]) return sanitizeDegreesDouble(hues[i]);
  }
  return sourceHue;
}

/** MCU's DynamicScheme.getRotatedHue. */
export function getRotatedHue(sourceColorHct, hueBreakpoints, rotations) {
  let rotation = getPiecewiseHue(sourceColorHct, hueBreakpoints, rotations);
  if (Math.min(hueBreakpoints.length - 1, rotations.length) <= 0) rotation = 0;
  return sanitizeDegreesDouble(sourceColorHct.hue + rotation);
}

/** The scheme variants this port covers, by MCU name. */
export const VARIANTS = ['tonal-spot', 'vibrant', 'neutral', 'fidelity', 'monochrome'];

/**
 * The six palettes of a scheme variant for a source colour (an Hct), as
 * MCU's DynamicSchemePalettesDelegateImpl2021 builds them:
 * { primary, secondary, tertiary, neutral, neutralVariant, error }.
 */
export function schemePalettes(variant, sourceColorHct) {
  const hue = sourceColorHct.hue;
  const chroma = sourceColorHct.chroma;
  const of = TonalPalette.fromHueAndChroma;
  const error = of(25.0, 84.0);
  switch (variant) {
    case 'tonal-spot':
      return {
        primary: of(hue, 36.0),
        secondary: of(hue, 16.0),
        tertiary: of(sanitizeDegreesDouble(hue + 60.0), 24.0),
        neutral: of(hue, 6.0),
        neutralVariant: of(hue, 8.0),
        error,
      };
    case 'vibrant':
      return {
        primary: of(hue, 200.0),
        secondary: of(getRotatedHue(sourceColorHct, [0, 41, 61, 101, 131, 181, 251, 301, 360], [18, 15, 10, 12, 15, 18, 15, 12, 12]), 24.0),
        tertiary: of(getRotatedHue(sourceColorHct, [0, 41, 61, 101, 131, 181, 251, 301, 360], [35, 30, 20, 25, 30, 35, 30, 25, 25]), 32.0),
        neutral: of(hue, 10),
        neutralVariant: of(hue, 12),
        error,
      };
    case 'neutral':
      return {
        primary: of(hue, 12.0),
        secondary: of(hue, 8.0),
        tertiary: of(hue, 16.0),
        neutral: of(hue, 2.0),
        neutralVariant: of(hue, 2.0),
        error,
      };
    case 'fidelity':
      return {
        primary: of(hue, chroma),
        secondary: of(hue, Math.max(chroma - 32.0, chroma * 0.5)),
        tertiary: TonalPalette.fromHct(DislikeAnalyzer.fixIfDisliked(new TemperatureCache(sourceColorHct).complement)),
        neutral: of(hue, chroma / 8.0),
        neutralVariant: of(hue, chroma / 8.0 + 4.0),
        error,
      };
    case 'monochrome':
      return {
        primary: of(hue, 0.0),
        secondary: of(hue, 0.0),
        tertiary: of(hue, 0.0),
        neutral: of(hue, 0.0),
        neutralVariant: of(hue, 0.0),
        error,
      };
    default:
      throw new Error(`Unsupported variant: ${variant} (one of ${VARIANTS.join(', ')})`);
  }
}

// ── sRGB, hex and parsing ──────────────────────────────────────────────────

/** #rgb or #rrggbb to an opaque ARGB integer (null when it is not one). */
export function argbFromHex(hex) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join('') : match[1];
  const value = parseInt(digits, 16);
  return argbFromRgb((value >> 16) & 255, (value >> 8) & 255, value & 255);
}

/** An ARGB integer as #rrggbb (lower case; alpha ignored). */
export function hexFromArgb(argb) {
  return `#${[redFromArgb(argb), greenFromArgb(argb), blueFromArgb(argb)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const number = (text, percentOf = 1) => {
  const value = String(text).trim();
  if (value === 'none') return 0;
  return value.endsWith('%') ? (Number(value.slice(0, -1)) / 100) * percentOf : Number(value);
};

/**
 * A seed colour from text: #rgb, #rrggbb, rgb(r g b) / rgb(r, g, b), or
 * oklch(L C h) (L as 0-1 or a percentage; out-of-gamut values are gamut
 * mapped). Returns an opaque ARGB integer, or null for anything else.
 */
export function parseColor(text) {
  const value = String(text ?? '').trim().toLowerCase();
  const hex = argbFromHex(value);
  if (hex !== null) return hex;
  const rgb = /^rgba?\(([^()]*)\)$/.exec(value);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length !== 3) return null;
    const channels = parts.map((part) => number(part, 255));
    if (!channels.every(Number.isFinite)) return null;
    return argbFromRgb(...channels.map((c) => clampInt(0, 255, Math.round(c))));
  }
  const oklch = /^oklch\(([^()]*)\)$/.exec(value);
  if (oklch) {
    const parts = oklch[1].split(/[\s/]+/).filter(Boolean).slice(0, 3);
    if (parts.length !== 3) return null;
    const l = number(parts[0], 1);
    const c = number(parts[1], 0.4);
    const h = Number(parts[2].replace(/deg$/, '')) || 0;
    if (![l, c, h].every(Number.isFinite)) return null;
    return argbFromOklch(l, c, h);
  }
  return null;
}

// ── OKLab / OKLCH ──────────────────────────────────────────────────────────

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Linear sRGB (0-1) to OKLab (Björn Ottosson's matrices, as CSS Color 4 uses them). */
function oklabFromLinear([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function linearFromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** An ARGB colour as OKLCH: [L 0-1, C, h in degrees]. */
export function oklchFromArgb(argb) {
  const [L, a, b] = oklabFromLinear([redFromArgb(argb), greenFromArgb(argb), blueFromArgb(argb)].map((c) => srgbToLinear(c / 255)));
  const C = Math.sqrt(a * a + b * b);
  const h = C < 1e-7 ? 0 : sanitizeDegreesDouble((Math.atan2(b, a) * 180) / Math.PI);
  return [L, C, h];
}

/** OKLCH as linear sRGB, unclipped. */
function linearFromOklch(L, C, h) {
  const rad = (h * Math.PI) / 180;
  return linearFromOklab([L, C * Math.cos(rad), C * Math.sin(rad)]);
}

const inGamut = (linear) => linear.every((c) => c >= -1e-6 && c <= 1 + 1e-6);
const clip = (linear) => linear.map((c) => clampDouble(0, 1, c));
const deltaEOK = (x, y) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);

/**
 * OKLCH to sRGB with the gamut mapping of CSS Color 4 (section 13.2): keep
 * lightness and hue, lower the chroma by bisection until clipping moves the
 * colour by less than a just-noticeable difference (deltaEOK 0.02).
 */
export function gamutMapOklch(L, C, h) {
  if (L >= 1) return [1, 1, 1];
  if (L <= 0) return [0, 0, 0];
  let current = linearFromOklch(L, C, h);
  if (inGamut(current)) return current;
  const JND = 0.02;
  const EPSILON = 0.0001;
  let clipped = clip(current);
  if (deltaEOK(oklabFromLinear(clipped), oklabFromLinear(current)) < JND) return clipped;
  let min = 0;
  let max = C;
  let minInGamut = true;
  while (max - min > EPSILON) {
    const chroma = (min + max) / 2;
    current = linearFromOklch(L, chroma, h);
    if (minInGamut && inGamut(current)) {
      min = chroma;
      continue;
    }
    clipped = clip(current);
    const E = deltaEOK(oklabFromLinear(clipped), oklabFromLinear(current));
    if (E < JND) {
      if (JND - E < EPSILON) return clipped;
      minInGamut = false;
      min = chroma;
    } else {
      max = chroma;
    }
  }
  return clip(current);
}

/** OKLCH (L 0-1, C, h degrees) to an opaque ARGB colour, gamut mapped into sRGB. */
export function argbFromOklch(L, C, h) {
  const linear = gamutMapOklch(L, C, h);
  return argbFromRgb(...linear.map((c) => clampInt(0, 255, Math.round(linearToSrgb(clampDouble(0, 1, c)) * 255))));
}

/** Whether OKLCH (L, C, h) lies inside sRGB. */
export function oklchInSrgb(L, C, h) {
  return inGamut(linearFromOklch(L, C, h));
}

/** An ARGB colour as CSS `oklch(L% C h)`, rounded for a stylesheet. */
export function cssOklch(argb) {
  const [L, C, h] = oklchFromArgb(argb);
  const round = (value, digits) => Number(value.toFixed(digits));
  return `oklch(${round(L * 100, 2)}% ${round(C, 4)} ${round(h, 2)})`;
}

// ── contrast ───────────────────────────────────────────────────────────────

/** WCAG 2 relative luminance (0-1) of an ARGB colour. */
export function relativeLuminance(argb) {
  const [r, g, b] = [redFromArgb(argb), greenFromArgb(argb), blueFromArgb(argb)].map((c) => srgbToLinear(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2 contrast ratio of two opaque ARGB colours (1 to 21). */
export function wcagContrast(a, b) {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/**
 * APCA lightness contrast Lc of text on a background (APCA-W3 0.0.98G-4g,
 * the constants of the published reference): positive for dark text on a
 * light ground, negative for light text on a dark one, 0 under the clip.
 * Advisory only: WCAG 2 is what the generator guarantees.
 */
export function apcaContrast(text, background) {
  const Y = (argb) => {
    const [r, g, b] = [redFromArgb(argb), greenFromArgb(argb), blueFromArgb(argb)].map((c) => Math.pow(c / 255, 2.4));
    return 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  };
  const blkThrs = 0.022;
  const blkClmp = 1.414;
  const clampBlack = (y) => (y > blkThrs ? y : y + Math.pow(blkThrs - y, blkClmp));
  const txtY = clampBlack(Y(text));
  const bgY = clampBlack(Y(background));
  if (Math.abs(bgY - txtY) < 0.0005) return 0;
  let output;
  if (bgY > txtY) {
    const sapc = (Math.pow(bgY, 0.56) - Math.pow(txtY, 0.57)) * 1.14;
    output = sapc < 0.1 ? 0 : sapc - 0.027;
  } else {
    const sapc = (Math.pow(bgY, 0.65) - Math.pow(txtY, 0.62)) * 1.14;
    output = sapc > -0.1 ? 0 : sapc + 0.027;
  }
  return output * 100;
}
