/*
 * viewer3d.js - AR無しの3D表示(カメラが使えない端末・教室のPC用)
 *
 * 1本指ドラッグ: 回転 / 2本指ピンチ: ズーム。
 * ただし「down() が true を返した位置」(マーカーのドラッグなど)では回転せず、
 * 操作を interaction に渡す。
 *
 * interaction = {
 *   down(ndc) -> boolean   ドラッグを奪うなら true
 *   move(ndc)              down が true の間のドラッグ
 *   up(ndc, isTap)         指を離した。移動が小さければ isTap=true
 * }
 */
(function (root) {
  'use strict';

  function create(THREE, opts) {
    var canvas = opts.canvas;
    var interaction = opts.interaction || {};
    var onFrame = opts.onFrame || function () {};

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe9edf2);
    var camera = new THREE.PerspectiveCamera(50, 1, 0.02, 50);

    // 机
    var desk = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ color: 0xcfc8b8, roughness: 1 }));
    desk.rotation.x = -Math.PI / 2;
    desk.position.y = -0.0005;
    scene.add(desk);

    var target = new THREE.Vector3(0.25, 0.12, 0);
    var yaw = 0.7, pitch = 0.45, dist = 1.5;
    function applyCamera() {
      pitch = Math.max(0.05, Math.min(1.45, pitch));
      dist = Math.max(0.35, Math.min(5, dist));
      camera.position.set(
        target.x - dist * Math.cos(pitch) * Math.cos(yaw),
        target.y + dist * Math.sin(pitch),
        target.z + dist * Math.cos(pitch) * Math.sin(yaw));
      camera.lookAt(target);
    }

    function resize() {
      var w = canvas.clientWidth || root.innerWidth, h = canvas.clientHeight || root.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // 横長画面では右側の操作パネル(380px)に隠れないよう、描画を左へずらす
      if (w >= 820 && w > h) camera.setViewOffset(w, h, 190, 0, w, h);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
    }

    // ---- ポインタ操作 ----
    var pointers = new Map();
    var mode = 'none';       // 'orbit' | 'interact' | 'pinch'
    var startInfo = null;
    var pinchStart = 0, pinchDist0 = 1;

    function ndcOf(e) {
      var r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) };
    }
    function pinchDistance() {
      var pts = Array.from(pointers.values());
      var dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function onDown(e) {
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        startInfo = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
        mode = (interaction.down && interaction.down(ndcOf(e))) ? 'interact' : 'orbit';
      } else if (pointers.size === 2) {
        if (mode === 'interact' && interaction.up) interaction.up(ndcOf(e), false);
        mode = 'pinch';
        pinchDist0 = pinchDistance();
        pinchStart = dist;
        if (startInfo) startInfo.moved = true;
      }
    }
    function onMove(e) {
      var p = pointers.get(e.pointerId);
      if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (startInfo && Math.hypot(e.clientX - startInfo.x, e.clientY - startInfo.y) > 8) startInfo.moved = true;
      if (mode === 'orbit') {
        yaw -= dx * 0.008;
        pitch += dy * 0.008;
        applyCamera();
      } else if (mode === 'interact') {
        if (interaction.move) interaction.move(ndcOf(e));
      } else if (mode === 'pinch' && pointers.size >= 2) {
        dist = pinchStart * (pinchDist0 / Math.max(pinchDistance(), 1));
        applyCamera();
      }
    }
    function onUp(e) {
      if (!pointers.has(e.pointerId)) return;
      var wasSingle = pointers.size === 1;
      pointers.delete(e.pointerId);
      if (wasSingle) {
        var isTap = startInfo && !startInfo.moved && (Date.now() - startInfo.t) < 600;
        if (mode === 'interact') { if (interaction.up) interaction.up(ndcOf(e), isTap); }
        else if (mode === 'orbit' && isTap) { if (interaction.up) interaction.up(ndcOf(e), true); }
        mode = 'none';
        startInfo = null;
      } else if (pointers.size === 1) {
        mode = 'none'; // ピンチ後は一度離すまで回転しない
      }
    }
    function onWheel(e) {
      e.preventDefault();
      dist *= Math.exp(e.deltaY * 0.001);
      applyCamera();
    }

    var running = false, raf = 0, t0 = 0;
    function loop(now) {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      onFrame((now - t0) / 1000);
      renderer.render(scene, camera);
    }

    return {
      scene: scene, camera: camera, renderer: renderer,
      /** 装置の大きさに合わせて視点を調整 */
      focus: function (b) {
        target.set(b.cx, b.cy, b.cz);
        dist = Math.max(1.2, b.radius * 2.4);
        applyCamera();
      },
      start: function () {
        if (running) return;
        running = true;
        t0 = performance.now();
        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        root.addEventListener('resize', resize);
        resize(); applyCamera();
        raf = requestAnimationFrame(loop);
      },
      stop: function () {
        running = false;
        cancelAnimationFrame(raf);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('wheel', onWheel);
        root.removeEventListener('resize', resize);
        pointers.clear(); mode = 'none';
      },
      resize: resize
    };
  }

  root.Viewer3D = { create: create };
})(window);
