/*
 * apparatus.js - 装置の3Dシーン(three.js)
 *
 * 光源(レーザー) → 二重スリット板 → スクリーン を1つの Group(root)にまとめる。
 * AR/非ARのどちらでも、この root を scene に add するだけで使える。
 * three.js は window.THREE(r159 グローバル版)を使用。
 *
 * 【縮尺について(重要)】
 *   物理量は常に「シミュレーション上の実寸」で扱い、3D表示は次のように拡大・誇張している。
 *   - スクリーン上の位置: 実寸 1 mm = モデル 10 mm (10倍拡大)。定規は実寸 mm で目盛る。
 *   - 距離 L: 実寸 1 m = モデル 0.5 m。
 *   - スリット間隔 d: 3D模型・波面では誇張して描く(実際は 0.1〜1 mm で見えないため)。
 *   AR の SLAM スケールは実寸ではないので、数値の読み取りは必ず定規(mm)経由で行う。
 */
(function (root) {
  'use strict';

  var MM_TO_MODEL = 0.01;     // スクリーン上 実寸1mm → モデル0.01
  var HALF_MM = 20;           // スクリーン表示範囲 ±20 mm
  var BOARD_W = 2 * HALF_MM * MM_TO_MODEL; // 0.40
  var PATTERN_H = 0.20;
  var L_TO_MODEL = 0.5;       // 実寸1m → モデル0.5
  var BEAM_Y = 0.16;          // 光軸の高さ
  var D_DISP_PER_MM = 0.16;   // 表示用 d: 実寸 d[mm] × 0.16 (誇張)。0.25mm → 0.04
  var LAMBDA_DISP_REF = 0.02; // 波面表示の波長: 650nm のとき 0.02(模式図用。λに比例)
  var N_SAMPLES = 24;

  var VERT = [
    'varying vec2 vUv;',
    'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
  ].join('\n');

  // GLSL: three.js r159 の ShaderMaterial は WebGL2 で GLSL ES 3.00 に自動変換される
  // (varying/gl_FragColor/texture2D を three が #define で読み替える)。そのため ES 1.00 風に書く。
  var PATTERN_FRAG = [
    '#define MY_PI 3.14159265358979',
    'uniform float uLambda;  // nm',
    'uniform float uD;       // mm',
    'uniform float uLmm;     // mm',
    'uniform float uA;       // mm',
    'uniform float uHalf;    // mm (画面の半幅)',
    'uniform float uWhite;',
    'uniform vec3 uTint;',
    'uniform vec3 uSamples[' + N_SAMPLES + '];',
    'uniform float uSampleNm[' + N_SAMPLES + '];',
    'uniform float uDx;      // mm (<=0 で目印を出さない)',
    'varying vec2 vUv;',
    '',
    '// y: スクリーン上の位置[mm], lamNm: 波長[nm] → 強度 0..1',
    '// 経路差は厳密式 Δ = sqrt(L²+(y+d/2)²) - sqrt(L²+(y-d/2)²) と等価な',
    '// Δ = 2 y d / (s1 + s2) を使う(float32 の桁落ち防止)。',
    'float fringe(float y, float lamNm){',
    '  float lam = lamNm * 1.0e-6;',
    '  float s1 = sqrt(uLmm*uLmm + (y+uD*0.5)*(y+uD*0.5));',
    '  float s2 = sqrt(uLmm*uLmm + (y-uD*0.5)*(y-uD*0.5));',
    '  float p = (2.0*y*uD/(s1+s2)) / lam;      // Δ/λ',
    '  float c = cos(MY_PI*p);',
    '  float arg = MY_PI*uA*y/(lam*sqrt(uLmm*uLmm+y*y));',
    '  float sc = abs(arg) < 1.0e-4 ? 1.0 : sin(arg)/arg;',
    '  float env = sc*sc;',
    '  float fw = fwidth(p);                     // 1ピクセルあたりの位相変化',
    '  float fade = 1.0 - smoothstep(0.2, 0.5, fw); // 縞が細かすぎる所は平均値へ(エイリアス防止)',
    '  return mix(0.5*env, c*c*env, fade);',
    '}',
    '',
    'void main(){',
    '  float y = (vUv.x - 0.5) * 2.0 * uHalf;',
    '  vec3 lin = vec3(0.0);',
    '  if (uWhite > 0.5) {',
    '    for (int i = 0; i < ' + N_SAMPLES + '; i++) lin += uSamples[i] * fringe(y, uSampleNm[i]);',
    '  } else {',
    '    lin = uTint * fringe(y, uLambda);',
    '  }',
    '  lin = clamp(lin, 0.0, 1.0);',
    '  vec3 col = pow(lin, vec3(1.0/2.2));',
    '  float px = fwidth(y);',
    '  if (uDx > 0.0 && uDx > 4.0*px && vUv.y > 0.92) {',
    '    float dist = abs(fract(y/uDx + 0.5) - 0.5) * uDx;',
    '    if (dist < px*1.5) col = vec3(1.0, 0.9, 0.1);',
    '  }',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var WAVE_FRAG = [
    '#define MY_PI 3.14159265358979',
    'uniform float uK;      // 表示上の波数 2π/λ_disp',
    'uniform float uPhase;  // ω t',
    'uniform float uHalfD;  // 表示上の d/2',
    'uniform float uLen;    // スリット〜スクリーン距離(モデル)',
    'uniform float uW;      // 幅(モデル)',
    'varying vec2 vUv;',
    'void main(){',
    '  float x = vUv.x * uLen;',
    '  float z = (0.5 - vUv.y) * uW;',
    '  float r1 = length(vec2(x, z - uHalfD));',
    '  float r2 = length(vec2(x, z + uHalfD));',
    '  float a1 = cos(uK*r1 - uPhase) / sqrt(r1 + 0.03);',
    '  float a2 = cos(uK*r2 - uPhase) / sqrt(r2 + 0.03);',
    '  float s = clamp((a1 + a2) * 0.55, -1.0, 1.0);',
    '  vec3 warm = vec3(1.0, 0.62, 0.15);',
    '  vec3 cool = vec3(0.2, 0.55, 1.0);',
    '  vec3 col = s > 0.0 ? warm : cool;',
    '  float edge = smoothstep(0.0, 0.02, x);',
    '  gl_FragColor = vec4(col, pow(abs(s), 1.2) * 0.85 * edge);',
    '}'
  ].join('\n');

  function createApparatus(THREE) {
    var root = new THREE.Group();
    root.name = 'young-apparatus';

    var state = {
      lambdaNm: 650, dMm: 0.25, LM: 1.0,
      white: false, wave: false, showCalc: false,
      probe: null, markers: { A: null, B: null }
    };

    function srgbColor(r, g, b) {
      var c = new THREE.Color();
      c.setRGB(r, g, b, THREE.SRGBColorSpace); // 表示用sRGB値として扱う(r152以降)
      return c;
    }
    function basic(hex, opts) {
      var m = new THREE.MeshBasicMaterial(Object.assign({ color: hex }, opts || {}));
      return m;
    }
    function lambert(hex) {
      return new THREE.MeshStandardMaterial({ color: hex, roughness: 0.7, metalness: 0.1 });
    }
    function box(w, h, d, mat, x, y, z) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      return m;
    }

    // ---- 照明(AR側のシーンにライトが無いので自前で持つ) ----
    root.add(new THREE.HemisphereLight(0xffffff, 0x666677, 1.0));
    var dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(-0.5, 1.5, 0.8);
    root.add(dir);

    // ---- 机上の薄い台(装置の足元の目印。影は使わない) ----
    var deskMark = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12 }));
    deskMark.rotation.x = -Math.PI / 2;
    deskMark.position.y = 0.001;
    root.add(deskMark);

    // ---- 光源(レーザー) ----
    var laser = new THREE.Group();
    laser.position.set(-0.30, 0, 0);
    laser.add(box(0.16, 0.05, 0.05, lambert(0x2b3a55), 0, BEAM_Y, 0));
    laser.add(box(0.04, BEAM_Y - 0.025, 0.04, lambert(0x555555), 0, (BEAM_Y - 0.025) / 2, 0));
    laser.add(box(0.12, 0.01, 0.10, lambert(0x444444), 0, 0.005, 0));
    var laserTip = box(0.012, 0.03, 0.03, basic(0xff0000), 0.086, BEAM_Y, 0);
    laser.add(laserTip);
    root.add(laser);
    var LASER_TIP_X = -0.30 + 0.092;

    // ---- 二重スリット板 ----
    var plate = new THREE.Group();
    plate.add(box(0.01, 0.26, 0.34, lambert(0x303030), 0, BEAM_Y - 0.02, 0));
    plate.add(box(0.06, 0.01, 0.12, lambert(0x444444), 0, 0.005, 0));
    plate.add(box(0.012, BEAM_Y - 0.15, 0.03, lambert(0x444444), 0, (BEAM_Y - 0.15) / 2, 0));
    var slitMat = basic(0xfff3b0);
    var slit1 = box(0.014, 0.20, 0.004, slitMat, 0, BEAM_Y - 0.02, 0);
    var slit2 = box(0.014, 0.20, 0.004, slitMat, 0, BEAM_Y - 0.02, 0);
    plate.add(slit1); plate.add(slit2);
    root.add(plate);

    // ---- スクリーン ----
    // pivot はスリット側(-x)を向く。ローカル x = 世界 z(水平)、ローカル y = 高さ。
    var pivot = new THREE.Group();
    pivot.rotation.y = -Math.PI / 2;
    root.add(pivot);
    pivot.add(box(0.42, 0.28, 0.01, lambert(0x222222), 0, 0.135, -0.006));
    pivot.add(box(0.30, 0.012, 0.14, lambert(0x444444), 0, 0.006, -0.06));

    var patternUniforms = {
      uLambda: { value: 650 }, uD: { value: 0.25 }, uLmm: { value: 1000 }, uA: { value: 0.04 },
      uHalf: { value: HALF_MM }, uWhite: { value: 0 }, uTint: { value: new THREE.Vector3(1, 0, 0) },
      uSamples: { value: [] }, uSampleNm: { value: [] }, uDx: { value: -1 }
    };
    var P = (typeof window !== 'undefined' && window.Physics) || null;
    if (P) {
      var ws = P.whiteSamples(N_SAMPLES);
      for (var i = 0; i < N_SAMPLES; i++) {
        patternUniforms.uSamples.value.push(new THREE.Vector3(ws[i].rgb[0], ws[i].rgb[1], ws[i].rgb[2]));
        patternUniforms.uSampleNm.value.push(ws[i].nm);
      }
    }
    var patternMat = new THREE.ShaderMaterial({
      uniforms: patternUniforms, vertexShader: VERT, fragmentShader: PATTERN_FRAG,
      extensions: { derivatives: true }
    });
    var pattern = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W, PATTERN_H), patternMat);
    pattern.position.set(0, BEAM_Y, 0);
    pivot.add(pattern);

    // 定規(実寸 mm)。キャンバスに描いてテクスチャにする。
    var ruler = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W, 0.05), buildRulerMaterial());
    ruler.position.set(0, 0.035, 0);
    pivot.add(ruler);

    function buildRulerMaterial() {
      var W = 2048, H = 256;
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var g = cv.getContext('2d');
      g.fillStyle = '#f5f1e3';
      g.fillRect(0, 0, W, H);
      g.strokeStyle = '#111'; g.fillStyle = '#111';
      g.textAlign = 'center';
      g.font = 'bold 44px -apple-system, "Hiragino Sans", sans-serif';
      for (var mm = -HALF_MM; mm <= HALF_MM; mm++) {
        var x = ((mm + HALF_MM) / (2 * HALF_MM)) * W;
        var len = mm % 10 === 0 ? 120 : (mm % 5 === 0 ? 85 : 50);
        g.lineWidth = mm === 0 ? 8 : (mm % 5 === 0 ? 5 : 3);
        g.strokeStyle = mm === 0 ? '#d00' : '#111';
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, len); g.stroke();
        if (mm % 5 === 0) {
          var tx = Math.min(Math.max(x, 40), W - 40);
          g.fillText(String(mm), tx, 175);
        }
      }
      g.font = 'bold 34px -apple-system, "Hiragino Sans", sans-serif';
      g.textAlign = 'left';
      g.fillText('mm (実寸)', 14, 236);
      var tex = new THREE.CanvasTexture(cv);
      if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      return new THREE.MeshBasicMaterial({ map: tex });
    }

    function makeLabel(text, color) {
      var cv = document.createElement('canvas'); cv.width = 128; cv.height = 128;
      var g = cv.getContext('2d');
      g.fillStyle = color; g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#000'; g.font = 'bold 72px -apple-system, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, 64, 68);
      var tex = new THREE.CanvasTexture(cv);
      if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      s.scale.set(0.05, 0.05, 1);
      s.renderOrder = 10;
      return s;
    }

    // マーカー/プローブ(スクリーン上の縦線 + 上に文字)
    function makeMark(hex, label) {
      var g = new THREE.Group();
      var line = new THREE.Mesh(new THREE.PlaneGeometry(0.004, 0.27),
        new THREE.MeshBasicMaterial({ color: hex, depthTest: false, transparent: true, opacity: 0.95 }));
      line.position.set(0, 0.135, 0.004);
      line.renderOrder = 9;
      var lab = makeLabel(label, '#' + ('000000' + hex.toString(16)).slice(-6));
      lab.position.set(0, 0.31, 0.004);
      g.add(line); g.add(lab);
      g.visible = false;
      pivot.add(g);
      return g;
    }
    var markP = makeMark(0xffe600, 'P');
    var markA = makeMark(0x00e5ff, 'A');
    var markB = makeMark(0xff4fd8, 'B');

    // ---- 光線(細い円柱) ----
    var tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
    tubeGeo.translate(0, 0.5, 0);
    var Y_AXIS = new THREE.Vector3(0, 1, 0);
    function makeTube(radius, opacity) {
      var m = new THREE.Mesh(tubeGeo, new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: opacity }));
      m.userData.radius = radius;
      root.add(m);
      return m;
    }
    var _d = new THREE.Vector3();
    function setTube(mesh, a, b) {
      _d.subVectors(b, a);
      var len = _d.length();
      mesh.position.copy(a);
      mesh.scale.set(mesh.userData.radius, len, mesh.userData.radius);
      mesh.quaternion.setFromUnitVectors(Y_AXIS, _d.normalize());
    }
    var beamIn = makeTube(0.004, 0.9);
    var beamS1 = makeTube(0.0025, 0.5);
    var beamS2 = makeTube(0.0025, 0.5);
    var rayP1 = makeTube(0.004, 0.95);
    var rayP2 = makeTube(0.004, 0.95);
    rayP1.material.color.setHex(0xffa000);
    rayP2.material.color.setHex(0x30e060);

    // ---- 波面(スリット〜スクリーン間の水平面。模式図) ----
    var waveUniforms = {
      uK: { value: 1 }, uPhase: { value: 0 }, uHalfD: { value: 0.02 }, uLen: { value: 0.5 }, uW: { value: BOARD_W }
    };
    var waveGeo = new THREE.PlaneGeometry(1, 1);
    waveGeo.rotateX(-Math.PI / 2);
    waveGeo.translate(0.5, 0, 0); // x: 0..1 (スリット側が原点)
    var waveMesh = new THREE.Mesh(waveGeo, new THREE.ShaderMaterial({
      uniforms: waveUniforms, vertexShader: VERT, fragmentShader: WAVE_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    }));
    waveMesh.position.set(0.006, BEAM_Y, 0);
    waveMesh.visible = false;
    waveMesh.renderOrder = 2;
    root.add(waveMesh);

    // ---- 更新 ----
    var v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
    function slitPos(sign, target) {
      var dDisp = state.dMm * D_DISP_PER_MM;
      return target.set(0.006, BEAM_Y - 0.02 + 0.0, sign * dDisp / 2);
    }
    function mmToLocalX(mm) { return mm * MM_TO_MODEL; }
    function screenPointWorldLocal(mm, target) {
      // root 座標でのスクリーン上の点(高さは光軸)
      return target.set(state.LM * L_TO_MODEL, BEAM_Y, mm * MM_TO_MODEL);
    }

    function refresh() {
      var Lm = state.LM * L_TO_MODEL;
      var dDisp = state.dMm * D_DISP_PER_MM;
      var rgb = P ? P.wavelengthToRGB(state.lambdaNm) : [1, 0, 0];
      var mx = Math.max(rgb[0], rgb[1], rgb[2], 1e-6);
      var beamColor = state.white ? srgbColor(1, 1, 1) : srgbColor(rgb[0] / mx, rgb[1] / mx, rgb[2] / mx);

      // スクリーン位置
      pivot.position.set(Lm, 0, 0);

      // 机の目印
      deskMark.scale.set(Lm + 0.6, 0.5, 1);   // x: -0.40 〜 Lm+0.20
      deskMark.position.x = (Lm - 0.2) / 2;

      // スリット(間隔は誇張表示)
      slit1.position.z = dDisp / 2;
      slit2.position.z = -dDisp / 2;

      // シェーダ
      patternUniforms.uLambda.value = state.lambdaNm;
      patternUniforms.uD.value = state.dMm;
      patternUniforms.uLmm.value = state.LM * 1000;
      patternUniforms.uWhite.value = state.white ? 1 : 0;
      patternUniforms.uTint.value.set(
        Math.pow(rgb[0] / mx, 2.2), Math.pow(rgb[1] / mx, 2.2), Math.pow(rgb[2] / mx, 2.2));
      patternUniforms.uDx.value = state.showCalc ? (state.LM * state.lambdaNm * 1e-9 / (state.dMm * 1e-3)) * 1000 : -1;

      // 光線
      laserTip.material.color.copy(beamColor);
      [beamIn, beamS1, beamS2].forEach(function (t) { t.material.color.copy(beamColor); });
      setTube(beamIn, v1.set(LASER_TIP_X, BEAM_Y, 0), v2.set(-0.006, BEAM_Y, 0));
      var s1 = slitPos(1, v1); s1.y = BEAM_Y; var s2 = slitPos(-1, v2); s2.y = BEAM_Y;
      var c0 = screenPointWorldLocal(0, v3);
      setTube(beamS1, s1, c0);
      setTube(beamS2, s2, c0);

      // 波面: 表示波長・表示d は λ, d に比例
      var lamDisp = LAMBDA_DISP_REF * state.lambdaNm / 650;
      waveUniforms.uK.value = 2 * Math.PI / lamDisp;
      waveUniforms.uHalfD.value = dDisp / 2;
      waveUniforms.uLen.value = Lm - 0.006;
      waveMesh.scale.set(Lm - 0.006, 1, BOARD_W);
      waveMesh.visible = state.wave;
      beamS1.visible = beamS2.visible = !state.wave;

      // プローブ
      if (state.probe === null) {
        markP.visible = false; rayP1.visible = rayP2.visible = false;
      } else {
        markP.visible = true; markP.position.x = mmToLocalX(state.probe);
        var p = screenPointWorldLocal(state.probe, v3);
        var a1 = slitPos(1, v1); a1.y = BEAM_Y;
        var a2 = slitPos(-1, v2); a2.y = BEAM_Y;
        setTube(rayP1, a1, p);
        setTube(rayP2, a2, p);
        rayP1.visible = rayP2.visible = true;
      }
      // マーカー
      [['A', markA], ['B', markB]].forEach(function (e) {
        var mm = state.markers[e[0]];
        e[1].visible = mm !== null;
        if (mm !== null) e[1].position.x = mmToLocalX(mm);
      });
    }

    var api = {
      root: root,
      HALF_MM: HALF_MM,
      /** params: {lambdaNm, dMm, LM, white, wave, showCalc} の一部 */
      setParams: function (p) {
        for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k) && k in state) state[k] = p[k];
        refresh();
      },
      setScale: function (s) { root.scale.setScalar(s); },
      setProbe: function (mm) { state.probe = mm; refresh(); },
      setMarker: function (name, mm) { state.markers[name] = mm; refresh(); },
      getMarker: function (name) { return state.markers[name]; },
      /** 時間更新(波面アニメ)。tSec: 経過秒 */
      tick: function (tSec) {
        if (!state.wave) return;
        var lamDisp = LAMBDA_DISP_REF * state.lambdaNm / 650;
        var k = 2 * Math.PI / lamDisp;
        var c = 0.03; // 表示上の波の速さ(モデル/秒)。波長に依らず一定 → 波長が長いほどゆっくり振動
        waveUniforms.uPhase.value = (k * c * tSec) % (2 * Math.PI);
      },
      /**
       * レイキャスト用。スクリーン(模様+定規)に当たればスクリーン上の位置[mm]を返す(±20mmに丸める)。
       * 当たらなければ null。
       */
      pickScreenMm: function (raycaster) {
        root.updateMatrixWorld(true);
        var hits = raycaster.intersectObjects([pattern, ruler], false);
        if (!hits.length) return null;
        var local = pivot.worldToLocal(hits[0].point.clone());
        var mm = local.x / MM_TO_MODEL;
        return Math.max(-HALF_MM, Math.min(HALF_MM, mm));
      },
      /** 現在 mm 位置を [-20,20] に丸める */
      clampMm: function (mm) { return Math.max(-HALF_MM, Math.min(HALF_MM, mm)); },
      /** 視点調整用: 装置全体の概ねの中心と大きさ(モデル単位) */
      getBounds: function () {
        var Lm = state.LM * L_TO_MODEL;
        return { cx: (Lm - 0.3) / 2, cy: 0.12, cz: 0, radius: (Lm + 0.7) / 2 };
      }
    };
    refresh();
    return api;
  }

  root.Apparatus = { create: createApparatus, constants: { MM_TO_MODEL: MM_TO_MODEL, HALF_MM: HALF_MM, L_TO_MODEL: L_TO_MODEL } };
})(typeof self !== 'undefined' ? self : this);
