'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/physics.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ` expected ${b}, got ${a}`);

// Δ(y) = target となる y を二分法で求める (Δ は y>0 で単調増加)
function solveY(target, d, L) {
  let lo = 0, hi = 5 * L;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (P.pathDifference(mid, d, L) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

test('fringeSpacing: Δx = Lλ/d', () => {
  near(P.fringeSpacing(1.0, 650e-9, 0.25e-3), 2.6e-3, 1e-12);
  near(P.fringeSpacing(2.0, 500e-9, 0.5e-3), 2.0e-3, 1e-12);
});

test('明線 Δ=mλ で cos^2=1 (I は包絡線に一致)', () => {
  const lambda = 650e-9, d = 0.25e-3, L = 1.0, a = P.SLIT_WIDTH;
  for (const m of [0, 1, 2, 3, 5]) {
    const y = solveY(m * lambda, d, L);
    const I = P.intensity(y, lambda, d, L, a);
    const s = P.sinc((Math.PI * a * y) / (lambda * Math.sqrt(L * L + y * y)));
    near(I, s * s, 1e-9, `m=${m}`);
  }
  near(P.intensity(0, lambda, d, L, a), 1, 1e-12, 'center');
});

test('暗線 Δ=(m+1/2)λ で I≈0', () => {
  const lambda = 550e-9, d = 0.3e-3, L = 1.5, a = P.SLIT_WIDTH;
  for (const m of [0, 1, 2, 4]) {
    const y = solveY((m + 0.5) * lambda, d, L);
    assert.ok(P.intensity(y, lambda, d, L, a) < 1e-12, `m=${m}`);
  }
});

test('明線位置が Lλ/d の整数倍に(小角で)一致する', () => {
  const lambda = 650e-9, d = 0.25e-3, L = 1.0;
  const dx = P.fringeSpacing(L, lambda, d);
  for (const m of [1, 2, 3]) {
    const y = solveY(m * lambda, d, L);
    near(y / (m * dx), 1, 1e-4, `m=${m}`);
  }
});

test('小角で厳密式と近似式 d*y/L が一致', () => {
  const d = 0.25e-3, L = 1.0;
  for (const y of [1e-3, 5e-3, 10e-3, 20e-3]) {
    const exact = P.pathDifference(y, d, L);
    const approx = P.pathDifferenceApprox(y, d, L);
    near(exact / approx, 1, 1e-3, `y=${y}`);
  }
});

test('経路差は y に対して奇関数、y=0 で 0', () => {
  near(P.pathDifference(0, 0.25e-3, 1), 0, 1e-15);
  near(P.pathDifference(3e-3, 0.25e-3, 1), -P.pathDifference(-3e-3, 0.25e-3, 1), 1e-15);
});

test('wavelengthToRGB: 端点と代表値', () => {
  const r380 = P.wavelengthToRGB(380); // 暗い紫
  assert.equal(r380[1], 0); // 緑なし(暗い紫: R=B)
  near(r380[0], Math.pow(0.3, 0.8), 1e-9);
  near(r380[2], Math.pow(0.3, 0.8), 1e-9);
  const r440 = P.wavelengthToRGB(440);
  assert.deepEqual(r440.map(v => Math.round(v * 1000) / 1000), [0, 0, 1]);
  const r510 = P.wavelengthToRGB(510);
  assert.deepEqual(r510.map(v => Math.round(v * 1000) / 1000), [0, 1, 0]);
  const r580 = P.wavelengthToRGB(580);
  assert.deepEqual(r580.map(v => Math.round(v * 1000) / 1000), [1, 1, 0]);
  const r650 = P.wavelengthToRGB(650);
  assert.deepEqual(r650, [1, 0, 0]);
  const r750 = P.wavelengthToRGB(750); // 暗い赤
  near(r750[0], Math.pow(0.3, 0.8), 1e-9);
  assert.equal(r750[1], 0); assert.equal(r750[2], 0);
  // 範囲外は端に丸める
  assert.deepEqual(P.wavelengthToRGB(300), P.wavelengthToRGB(380));
  assert.deepEqual(P.wavelengthToRGB(900), P.wavelengthToRGB(750));
});

test('whiteSamples: 合計がチャンネルごとに 1(中央が白)', () => {
  const s = P.whiteSamples(24);
  assert.equal(s.length, 24);
  for (let k = 0; k < 3; k++) near(s.reduce((acc, x) => acc + x.rgb[k], 0), 1, 1e-12);
  assert.ok(s[0].nm > 380 && s[23].nm < 750);
});

test('classifyFringe: 明線・暗線・中間', () => {
  assert.deepEqual(P.classifyFringe(0), { kind: 'bright', m: 0 });
  assert.deepEqual(P.classifyFringe(2.04), { kind: 'bright', m: 2 });
  assert.deepEqual(P.classifyFringe(-3), { kind: 'bright', m: 3 });
  assert.deepEqual(P.classifyFringe(1.5), { kind: 'dark', m: 1 });
  assert.deepEqual(P.classifyFringe(0.48), { kind: 'dark', m: 0 });
  assert.deepEqual(P.classifyFringe(0.25), { kind: 'mid', m: null });
  assert.deepEqual(P.classifyFringe(1.25), { kind: 'mid', m: null });
});

test('percentError', () => {
  near(P.percentError(660, 600), 10, 1e-12);
  near(P.percentError(540, 600), 10, 1e-12);
  assert.equal(P.percentError(600, 600), 0);
});
