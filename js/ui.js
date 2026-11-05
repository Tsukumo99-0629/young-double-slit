/*
 * ui.js - 画面遷移・操作パネル・観察/測定ロジックの結線
 *
 * ユーザー入力は textContent / value のみで画面に出す(innerHTML は使わない)。
 * 数値入力はすべて検証してから使う。データの保存・送信は一切しない。
 */
(function () {
  'use strict';

  var P = window.Physics;
  var $ = function (id) { return document.getElementById(id); };

  // ---------------- 状態 ----------------
  var state = {
    mode: 'observe',        // 'observe' | 'measure'
    view: null,             // 'ar' | 'viewer'
    lambdaNm: 650,          // 観察モードの波長
    dMm: 0.25,
    LM: 1.0,
    white: false, wave: false, calc: false,
    size: 1,
    placed: false,
    probeMm: null,
    trueLambda: null,       // 測定モードの未知波長(nm)。答え合わせまで画面に出さない
    trials: [],
    tracking: 'ok',
    grabbed: null
  };

  var apparatus = null;
  var viewer = null;
  var arCtx = null;          // {scene,camera,renderer}
  var raycaster = new THREE.Raycaster();
  var bannerKind = null;     // 'error' を優先表示

  // ---------------- 共通ヘルパ ----------------
  function show(el, on) { el.hidden = !on; }
  function round1(v) { return Math.round(v * 10) / 10; }
  function signed(v, digits) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(digits); }

  function currentCamera() {
    if (state.view === 'ar' && arCtx) return arCtx.camera;
    if (viewer) return viewer.camera;
    return null;
  }

  function pickMm(ndc) {
    var cam = currentCamera();
    if (!cam || !apparatus) return null;
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cam);
    return apparatus.pickScreenMm(raycaster);
  }

  // ---------------- 物理パラメータの反映 ----------------
  function effectiveLambda() {
    return state.mode === 'measure' && state.trueLambda !== null ? state.trueLambda : state.lambdaNm;
  }

  function applyToApparatus() {
    if (!apparatus) return;
    var measure = state.mode === 'measure';
    apparatus.setParams({
      lambdaNm: effectiveLambda(),
      dMm: state.dMm,
      LM: state.LM,
      white: measure ? false : state.white,
      wave: measure ? false : state.wave,
      showCalc: measure ? false : state.calc
    });
  }

  function updateReadouts() {
    $('o-lambda').textContent = state.lambdaNm + ' nm';
    $('o-d').textContent = state.dMm.toFixed(2) + ' mm';
    $('o-L').textContent = state.LM.toFixed(2) + ' m';
    $('o-size').textContent = state.size.toFixed(2).replace(/0$/, '') + ' 倍';

    var showCalc = state.mode === 'observe' && state.calc;
    show($('calc-readout'), showCalc);
    if (showCalc) {
      var dx = P.fringeSpacing(state.LM, state.lambdaNm * 1e-9, state.dMm * 1e-3) * 1000;
      $('calc-readout').textContent =
        'Δx = Lλ/d = ' + state.LM.toFixed(2) + ' m × ' + state.lambdaNm + ' nm ÷ ' + state.dMm.toFixed(2) +
        ' mm = ' + dx.toFixed(2) + ' mm(実寸。画面の黄色い目印が mΔx の位置)';
    }
    show($('wave-note'), state.mode === 'observe' && state.wave);
    updateProbe();
    updateMarkerReadout();
  }

  // ---------------- 観察: 点P ----------------
  function updateProbe() {
    var has = state.mode === 'observe' && state.probeMm !== null;
    show($('probe-out'), has);
    show($('btn-probe-clear'), has);
    if (!has) return;
    var lam = state.lambdaNm * 1e-9, d = state.dMm * 1e-3, L = state.LM;
    var y = state.probeMm * 1e-3;
    var s1 = Math.sqrt(L * L + (y - d / 2) * (y - d / 2)); // S1 は +d/2 側
    var s2 = Math.sqrt(L * L + (y + d / 2) * (y + d / 2));
    var delta = Math.abs(P.pathDifference(y, d, L));
    var ratio = delta / lam;
    var c = P.classifyFringe(ratio, 0.1);
    $('probe-pos').textContent = 'P の位置: y = ' + signed(state.probeMm, 1) + ' mm(中央から。定規の値)';
    $('probe-len').textContent = 'S₁P = ' + (s1 * 1000).toFixed(4) + ' mm,  S₂P = ' + (s2 * 1000).toFixed(4) + ' mm';
    $('probe-delta').textContent = 'Δ = |S₂P − S₁P| = ' + ratio.toFixed(2) + ' λ(' + (delta * 1e9).toFixed(0) + ' nm)';
    var kind = $('probe-kind');
    kind.className = 'kind ' + c.kind;
    if (c.kind === 'bright') kind.textContent = '明線 (m=' + c.m + ')  Δ = mλ';
    else if (c.kind === 'dark') kind.textContent = '暗線 (m=' + c.m + ')  Δ = (m+½)λ';
    else kind.textContent = '中間(明線でも暗線でもない)';
  }

  // ---------------- 測定 ----------------
  function updateMarkerReadout() {
    var a = apparatus ? apparatus.getMarker('A') : null;
    var b = apparatus ? apparatus.getMarker('B') : null;
    $('m-a').textContent = a === null ? '未設定' : signed(a, 1) + ' mm';
    $('m-b').textContent = b === null ? '未設定' : signed(b, 1) + ' mm';
    $('m-dist').textContent = (a !== null && b !== null) ? Math.abs(a - b).toFixed(1) + ' mm' : '---';
  }

  function newTask() {
    state.trueLambda = 450 + Math.floor(Math.random() * 231); // 450〜680 nm
    if (apparatus) { apparatus.setMarker('A', null); apparatus.setMarker('B', null); }
    ['i-n', 'i-dx', 'i-lam'].forEach(function (id) { $(id).value = ''; });
    show($('m-result'), false);
    show($('m-msg'), false);
    applyToApparatus();
    updateReadouts();
  }

  function parseStrict(text) {
    var s = String(text).normalize('NFKC').trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    return parseFloat(s);
  }

  function showMeasureMsg(text) {
    var el = $('m-msg');
    el.textContent = text;
    show(el, !!text);
  }

  function checkAnswer() {
    var n = parseStrict($('i-n').value);
    var dx = parseStrict($('i-dx').value);
    var lam = parseStrict($('i-lam').value);
    if (!(n >= 1 && n <= 100 && Math.floor(n) === n)) { showMeasureMsg('縞の数 n は 1〜100 の整数で入力してください。'); return; }
    if (!(dx > 0 && dx <= 100)) { showMeasureMsg('Δx は 0 より大きい数(mm、100以下)で入力してください。'); return; }
    if (!(lam >= 100 && lam <= 2000)) { showMeasureMsg('波長 λ は 100〜2000 の数(nm)で入力してください。'); return; }
    showMeasureMsg('');
    var err = P.percentError(lam, state.trueLambda);
    state.trials.push({ d: state.dMm, L: state.LM, dx: dx, lam: lam, err: err });
    var res = $('m-result');
    res.textContent = '真の波長: ' + state.trueLambda + ' nm / あなたの値: ' + lam + ' nm / 誤差: ' + err.toFixed(1) + ' %';
    show(res, true);
    renderTrials();
  }

  function renderTrials() {
    var tb = $('trials').querySelector('tbody');
    while (tb.firstChild) tb.removeChild(tb.firstChild);
    state.trials.forEach(function (t, i) {
      var tr = document.createElement('tr');
      [String(i + 1), t.d.toFixed(2), t.L.toFixed(2), t.dx.toString(), t.lam.toString(), t.err.toFixed(1) + ' %']
        .forEach(function (txt, k) {
          var td = document.createElement('td');
          td.textContent = txt;
          if (k === 5) td.className = t.err <= 5 ? 'ok' : 'ng';
          tr.appendChild(td);
        });
      tb.appendChild(tr);
    });
    show($('trials'), state.trials.length > 0);
  }

  function placeMarker(mm) {
    var a = apparatus.getMarker('A'), b = apparatus.getMarker('B');
    mm = round1(mm);
    if (a === null) apparatus.setMarker('A', mm);
    else if (b === null) apparatus.setMarker('B', mm);
    else apparatus.setMarker(Math.abs(mm - a) <= Math.abs(mm - b) ? 'A' : 'B', mm);
    updateMarkerReadout();
  }

  // ---------------- モード切替 ----------------
  function setMode(mode) {
    state.mode = mode;
    $('tab-observe').classList.toggle('active', mode === 'observe');
    $('tab-measure').classList.toggle('active', mode === 'measure');
    show($('observe-box'), mode === 'observe');
    show($('measure-box'), mode === 'measure');
    show($('row-lambda'), mode === 'observe'); // 測定モードでは λ を隠す
    if (mode === 'measure') {
      if (state.trueLambda === null) newTask(); else applyToApparatus();
    } else {
      applyToApparatus();
    }
    if (apparatus) { apparatus.setProbe(mode === 'observe' ? state.probeMm : null); }
    updateReadouts();
  }

  // ---------------- 操作(AR/3D共通) ----------------
  var interaction = {
    down: function (ndc) {
      if (state.view === 'ar' && !state.placed) return false;
      if (state.mode !== 'measure') return false;
      var mm = pickMm(ndc);
      if (mm === null) return false;
      var best = null, bestD = 1.5; // 1.5mm 以内のマーカーをつかむ
      ['A', 'B'].forEach(function (n) {
        var v = apparatus.getMarker(n);
        if (v !== null && Math.abs(v - mm) < bestD) { best = n; bestD = Math.abs(v - mm); }
      });
      state.grabbed = best;
      return best !== null;
    },
    move: function (ndc) {
      if (!state.grabbed) return;
      var mm = pickMm(ndc);
      if (mm === null) return;
      apparatus.setMarker(state.grabbed, round1(mm));
      updateMarkerReadout();
    },
    up: function (ndc, isTap) {
      if (state.grabbed) { state.grabbed = null; return; }
      if (!isTap) return;
      if (state.view === 'ar' && !state.placed) { placeAt(ndc); return; }
      var mm = pickMm(ndc);
      if (mm === null) return;
      if (state.mode === 'observe') {
        state.probeMm = round1(mm);
        apparatus.setProbe(state.probeMm);
        updateProbe();
      } else {
        placeMarker(mm);
      }
    }
  };

  function bindCanvasPointer(canvas, inter) {
    var st = null, captured = false;
    function ndcOf(e) {
      var r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) };
    }
    canvas.addEventListener('pointerdown', function (e) {
      if (!e.isPrimary) { st = null; return; }
      try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      st = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
      captured = inter.down(ndcOf(e));
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!st) return;
      if (Math.hypot(e.clientX - st.x, e.clientY - st.y) > 8) st.moved = true;
      if (captured) inter.move(ndcOf(e));
    });
    function end(e) {
      if (!st) return;
      var isTap = !st.moved && (Date.now() - st.t) < 600;
      st = null;
      inter.up(ndcOf(e), captured ? false : isTap);
      captured = false;
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', function () { st = null; captured = false; state.grabbed = null; });
    // iOS Safari: キャンバス上のスクロール・ピンチを止める
    canvas.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  }

  // ---------------- AR: 設置 ----------------
  var groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function placeAt(ndc) {
    var cam = currentCamera();
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cam);
    var pt = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, pt)) {
      flashHint('地面(机)に当たりませんでした。カメラを机の方へ向けてからタップしてください。');
      return;
    }
    // 装置の光軸(+x)がカメラから見て奥へ向くように回転し、タップ位置が装置の中央付近になるようにする
    var dx = cam.position.x - pt.x, dz = cam.position.z - pt.z;
    var theta = Math.atan2(dz, -dx);
    var back = 0.2 * state.size;
    apparatus.root.rotation.set(0, theta, 0);
    apparatus.root.position.set(pt.x - Math.cos(theta) * back, 0, pt.z + Math.sin(theta) * back);
    apparatus.root.visible = true;
    state.placed = true;
    show($('btn-replace'), true);
    refreshHint();
  }

  function replace() {
    state.placed = false;
    if (apparatus) apparatus.root.visible = false;
    refreshHint();
  }

  // ---------------- 案内バナー ----------------
  var flashTimer = 0;
  function setBanner(text, kind, actionVisible) {
    var b = $('banner');
    show(b, !!text);
    $('banner-text').textContent = text || '';
    b.classList.toggle('error', kind === 'error');
    show($('banner-action'), !!actionVisible);
  }
  function flashHint(text) {
    setBanner(text, 'hint', false);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(refreshHint, 3500);
  }
  function refreshHint() {
    if (bannerKind === 'error') return;
    if (state.view !== 'ar') { setBanner('', null, false); return; }
    if (state.tracking === 'initializing') setBanner('AR準備中:机の面をゆっくり映して、端末を少し動かしてください。', 'hint', false);
    else if (state.tracking === 'limited') setBanner('トラッキングが不安定です。明るい場所で、模様のある面をゆっくり映してください。', 'hint', false);
    else if (!state.placed) setBanner('机の上をタップして装置を置いてください。', 'hint', false);
    else setBanner('', null, false);
  }

  // ---------------- 画面遷移 ----------------
  function enterHud(view) {
    state.view = view;
    show($('start-screen'), false);
    show($('hud'), true);
    show($('row-size'), view === 'ar');
    show($('btn-replace'), view === 'ar' && state.placed);
    bannerKind = null;
    refreshHint();
  }

  function ensureApparatus() {
    if (!apparatus) {
      apparatus = Apparatus.create(THREE);
      apparatus.setScale(state.size);
    }
    applyToApparatus();
    apparatus.setProbe(state.mode === 'observe' ? state.probeMm : null);
  }

  function detachApparatus() {
    if (apparatus && apparatus.root.parent) apparatus.root.parent.remove(apparatus.root);
  }

  function setStartMessage(text, canFallback) {
    var m = $('start-msg');
    m.textContent = text || '';
    show(m, !!text);
    show($('btn-fallback'), !!canFallback);
    $('btn-ar').disabled = false;
    $('btn-noar').disabled = false;
  }

  function startViewer() {
    ensureApparatus();
    try {
      if (!viewer) {
        viewer = Viewer3D.create(THREE, {
          canvas: $('view-canvas'),
          interaction: interaction,
          onFrame: function (t) { apparatus.tick(t); }
        });
      }
    } catch (e) {
      setStartMessage('3D表示(WebGL)を開始できませんでした。ブラウザや端末の設定を確認してください。(' + (e && e.message ? e.message : e) + ')', false);
      return;
    }
    detachApparatus();
    show($('ar-canvas'), false);
    show($('view-canvas'), true);
    viewer.scene.add(apparatus.root);
    apparatus.root.position.set(0, 0, 0);
    apparatus.root.rotation.set(0, 0, 0);
    apparatus.root.visible = true;
    viewer.start();
    viewer.focus(apparatus.getBounds());
    enterHud('viewer');
  }

  function freshArCanvas() {
    var old = $('ar-canvas');
    var c = document.createElement('canvas');
    c.id = 'ar-canvas';
    c.className = 'stage';
    c.hidden = false;
    old.parentNode.replaceChild(c, old);
    bindCanvasPointer(c, interaction);
    return c;
  }

  function startAR() {
    // ★ iOSのモーション許可はタップ操作内で同期的に呼ぶ必要がある(awaitより前)
    var sensors = window.ARAdapter.requestSensors();
    $('btn-ar').disabled = true;
    $('btn-noar').disabled = true;
    setStartMessage('', false);
    $('btn-ar').disabled = true; $('btn-noar').disabled = true;
    var m = $('start-msg');
    m.textContent = 'ARを準備中です…(カメラ・モーションセンサーの許可を求められたら「許可」を選んでください)';
    show(m, true);

    sensors.then(function (res) {
      if (!res.ok) throw new Error(res.reason);
      ensureApparatus();
      show($('view-canvas'), false);
      if (viewer) viewer.stop();
      var canvas = freshArCanvas();
      state.placed = false; state.tracking = 'ok';
      // ARでは机の上で縞が読める大きさから始める(スライダーで変更可)
      state.size = 2;
      $('s-size').value = '2';
      $('o-size').textContent = '2.0 倍';
      return window.ARAdapter.start({
        canvas: canvas,
        onReady: function (ctx) {
          arCtx = ctx;
          detachApparatus();
          ctx.scene.add(apparatus.root);
          apparatus.root.visible = false;
          apparatus.setScale(state.size);
        },
        onFrame: function () { apparatus.tick(performance.now() / 1000); },
        onTracking: function (s) {
          if (s !== state.tracking) { state.tracking = s; refreshHint(); }
        },
        onError: function (msg) {
          bannerKind = 'error';
          setBanner('AR中にエラーが発生しました。' + msg, 'error', true);
        }
      });
    }).then(function () {
      enterHud('ar');
    }).catch(function (err) {
      window.ARAdapter.stop();
      detachApparatus();
      show($('ar-canvas'), false);
      setStartMessage('ARを開始できませんでした。' + (err && err.message ? err.message : ''), true);
    });
  }

  function switchToViewer() {
    window.ARAdapter.stop();
    detachApparatus();
    show($('ar-canvas'), false);
    state.placed = false;
    setStartMessage('', false);
    bannerKind = null;
    startViewer();
  }

  function goHome() {
    window.ARAdapter.stop();
    if (viewer) viewer.stop();
    detachApparatus();
    show($('ar-canvas'), false);
    show($('view-canvas'), false);
    show($('hud'), false);
    state.view = null; state.placed = false;
    bannerKind = null;
    setStartMessage('', false);
    show($('start-screen'), true);
  }

  // ---------------- 初期化 ----------------
  function bindSlider(id, key, parse) {
    $(id).addEventListener('input', function (e) {
      var v = parseFloat(e.target.value);
      if (!isFinite(v)) return;
      state[key] = parse ? parse(v) : v;
      if (key === 'size') { if (apparatus) apparatus.setScale(state.size); }
      else applyToApparatus();
      updateReadouts();
    });
  }

  function init() {
    bindSlider('s-lambda', 'lambdaNm', Math.round);
    bindSlider('s-d', 'dMm');
    bindSlider('s-L', 'LM');
    bindSlider('s-size', 'size');
    ['white', 'wave', 'calc'].forEach(function (k) {
      $('c-' + k).addEventListener('change', function (e) {
        state[k] = e.target.checked;
        applyToApparatus();
        updateReadouts();
      });
    });
    $('tab-observe').addEventListener('click', function () { setMode('observe'); });
    $('tab-measure').addEventListener('click', function () { setMode('measure'); });
    $('btn-probe-clear').addEventListener('click', function () {
      state.probeMm = null; if (apparatus) apparatus.setProbe(null); updateProbe();
    });
    $('btn-marker-clear').addEventListener('click', function () {
      if (apparatus) { apparatus.setMarker('A', null); apparatus.setMarker('B', null); }
      updateMarkerReadout();
    });
    $('btn-check').addEventListener('click', checkAnswer);
    $('btn-newtask').addEventListener('click', newTask);
    $('btn-replace').addEventListener('click', replace);
    $('btn-home').addEventListener('click', goHome);
    $('banner-action').addEventListener('click', switchToViewer);
    $('btn-ar').addEventListener('click', startAR);
    $('btn-noar').addEventListener('click', startViewer);
    $('btn-fallback').addEventListener('click', switchToViewer);
    function openCredits() { show($('credits'), true); }
    $('btn-credits').addEventListener('click', openCredits);
    $('btn-credits-start').addEventListener('click', openCredits);
    $('btn-credits-close').addEventListener('click', function () { show($('credits'), false); });
    $('panel-toggle').addEventListener('click', function () {
      var panel = $('panel');
      var collapsed = panel.classList.toggle('collapsed');
      $('panel-toggle').setAttribute('aria-expanded', String(!collapsed));
    });

    // ダブルタップ拡大・ピンチ拡大の抑止(iOS Safari)
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

    bindCanvasPointer($('ar-canvas'), interaction);
    // 初期表示の同期
    updateReadouts();
  }

  init();
})();
