/*
 * physics.js - ヤングの実験の物理計算(純粋関数)
 *
 * 単位は特に断りがなければ SI(m)。UI向けの mm / nm 変換は呼び出し側で行う。
 * ブラウザでは window.Physics、Node では require() で使える(UMD)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Physics = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SLIT_WIDTH = 0.04e-3; // スリット幅 a = 0.04 mm (固定)
  var LAMBDA_MIN = 380e-9;
  var LAMBDA_MAX = 750e-9;

  /** 近似式による明線間隔 Δx = L λ / d */
  function fringeSpacing(L, lambda, d) {
    return (L * lambda) / d;
  }

  /** 厳密な経路差 Δ(y) = sqrt(L^2+(y+d/2)^2) - sqrt(L^2+(y-d/2)^2) */
  function pathDifference(y, d, L) {
    return Math.sqrt(L * L + (y + d / 2) * (y + d / 2)) -
           Math.sqrt(L * L + (y - d / 2) * (y - d / 2));
  }

  /** 小角近似の経路差 Δ ≈ d y / L */
  function pathDifferenceApprox(y, d, L) {
    return (d * y) / L;
  }

  /** sinc(x) = sin(x)/x (x=0 で 1) */
  function sinc(x) {
    if (Math.abs(x) < 1e-8) return 1;
    return Math.sin(x) / x;
  }

  /**
   * 強度 I(y) = cos^2(π Δ / λ) * sinc^2(π a y / (λ sqrt(L^2+y^2)))
   * 最大値は 1。
   */
  function intensity(y, lambda, d, L, a) {
    if (a === undefined) a = SLIT_WIDTH;
    var delta = pathDifference(y, d, L);
    var c = Math.cos((Math.PI * delta) / lambda);
    var s = sinc((Math.PI * a * y) / (lambda * Math.sqrt(L * L + y * y)));
    return c * c * s * s;
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /**
   * 波長[nm] → RGB (Bruton法)。各成分 0..1。ガンマ 0.8 を適用済みの「表示用」値。
   * 380nm 未満・750nm 超は範囲端の値に丸める。
   */
  function wavelengthToRGB(nm) {
    var w = Math.min(Math.max(nm, 380), 750);
    var r = 0, g = 0, b = 0;
    if (w < 440) { r = -(w - 440) / (440 - 380); g = 0; b = 1; }
    else if (w < 490) { r = 0; g = (w - 440) / (490 - 440); b = 1; }
    else if (w < 510) { r = 0; g = 1; b = -(w - 510) / (510 - 490); }
    else if (w < 580) { r = (w - 510) / (580 - 510); g = 1; b = 0; }
    else if (w < 645) { r = 1; g = -(w - 645) / (645 - 580); b = 0; }
    else { r = 1; g = 0; b = 0; }

    var f;
    if (w < 420) f = 0.3 + 0.7 * (w - 380) / (420 - 380);
    else if (w <= 700) f = 1;
    else f = 0.3 + 0.7 * (750 - w) / (750 - 700);

    var gamma = 0.8;
    return [
      clamp01(Math.pow(r * f, gamma)),
      clamp01(Math.pow(g * f, gamma)),
      clamp01(Math.pow(b * f, gamma))
    ];
  }

  function srgbToLinear(c) { return Math.pow(c, 2.2); }

  /**
   * 白色光シミュレーション用のサンプル表。
   * 380〜750nm を n 点で等間隔サンプルし、各点のリニアRGBを
   * 「全サンプルの合計が (1,1,1) になる」ようにチャンネル別に正規化して返す。
   * → 中央(全波長が強め合う所)がちょうど白になる。
   * 戻り値: [{ nm, rgb:[r,g,b](リニア) }, ...]
   */
  function whiteSamples(n) {
    var out = [];
    var sum = [0, 0, 0];
    var i, k;
    for (i = 0; i < n; i++) {
      var nm = 380 + ((750 - 380) * (i + 0.5)) / n;
      var c = wavelengthToRGB(nm);
      var lin = [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
      for (k = 0; k < 3; k++) sum[k] += lin[k];
      out.push({ nm: nm, rgb: lin });
    }
    for (i = 0; i < n; i++) {
      for (k = 0; k < 3; k++) out[i].rgb[k] = out[i].rgb[k] / sum[k];
    }
    return out;
  }

  /**
   * 明線/暗線/中間の判定。ratio = |Δ|/λ。
   * tol: 整数または半整数からのずれの許容(λ単位)。
   * 戻り値: { kind:'bright'|'dark'|'mid', m }
   *   bright: Δ = mλ  / dark: Δ = (m+1/2)λ (m>=0)
   */
  function classifyFringe(ratio, tol) {
    if (tol === undefined) tol = 0.1;
    var r = Math.abs(ratio);
    var nearest = Math.round(r);
    if (Math.abs(r - nearest) <= tol) return { kind: 'bright', m: nearest };
    var m = Math.floor(r);
    if (Math.abs(r - (m + 0.5)) <= tol) return { kind: 'dark', m: m };
    return { kind: 'mid', m: null };
  }

  /** 誤差% = |測定値 - 真値| / 真値 × 100 */
  function percentError(measured, truth) {
    return (Math.abs(measured - truth) / truth) * 100;
  }

  return {
    SLIT_WIDTH: SLIT_WIDTH,
    LAMBDA_MIN: LAMBDA_MIN,
    LAMBDA_MAX: LAMBDA_MAX,
    fringeSpacing: fringeSpacing,
    pathDifference: pathDifference,
    pathDifferenceApprox: pathDifferenceApprox,
    sinc: sinc,
    intensity: intensity,
    wavelengthToRGB: wavelengthToRGB,
    whiteSamples: whiteSamples,
    classifyFringe: classifyFringe,
    percentError: percentError
  };
});
