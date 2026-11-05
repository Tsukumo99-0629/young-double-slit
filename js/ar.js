/*
 * ar.js - 8th Wall エンジン(XR8)のアダプタ
 *
 * このアプリで XR8 に触るのは「このファイルだけ」。
 * 将来エンジンを別のもの(WebXR、AR.js など)に替えるときは、
 * 下の公開インターフェース(window.ARAdapter)を満たす別ファイルを作って差し替える。
 *
 * 公開インターフェース:
 *   ARAdapter.isEngineLoaded()              エンジンのスクリプトが読み込み済みか
 *   ARAdapter.requestSensors()              iOSモーションセンサー許可(ボタンのタップ内で「同期的に」呼ぶこと)
 *   ARAdapter.start(opts) -> Promise        カメラ起動。opts は下記
 *   ARAdapter.stop()                        停止
 *
 *   opts = {
 *     canvas,                       描画先 <canvas>
 *     onReady({scene,camera,renderer}),  three.js のシーンが使えるようになった時
 *     onFrame(),                    毎フレーム(three.js の描画前)
 *     onTracking(state, message),   state: 'ok' | 'initializing' | 'limited'
 *     onError(message)              開始後に起きたエラー(日本語メッセージ)
 *   }
 *
 * XR8 が無い環境(読み込み失敗・校内フィルタ等)でも、このファイルは例外を投げずに
 * 「AR非対応」を返すだけで、AR無しモードには影響しない。
 */
(function (root) {
  'use strict';

  var running = false;
  var failed = false;

  function engineLoaded() { return !!(root.XR8 && root.XR8.run); }

  function waitForEngine(timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (engineLoaded()) { resolve(root.XR8); return; }
      var timer = setTimeout(function () {
        root.removeEventListener('xrloaded', onLoaded);
        reject(new Error('ENGINE_TIMEOUT'));
      }, timeoutMs);
      function onLoaded() { clearTimeout(timer); resolve(root.XR8); }
      root.addEventListener('xrloaded', onLoaded, { once: true });
    });
  }

  /**
   * iOS 13+ ではモーションセンサー(傾き)の利用にユーザー操作内での許可が必要。
   * 必ずボタンの click ハンドラ内で、await より前に同期的に呼ぶこと。
   * 戻り値: Promise<{ok:boolean, reason?:string}>
   */
  function requestSensors() {
    var tasks = [];
    try {
      if (root.DeviceMotionEvent && typeof root.DeviceMotionEvent.requestPermission === 'function') {
        tasks.push(root.DeviceMotionEvent.requestPermission());
      }
      if (root.DeviceOrientationEvent && typeof root.DeviceOrientationEvent.requestPermission === 'function') {
        tasks.push(root.DeviceOrientationEvent.requestPermission());
      }
    } catch (e) {
      return Promise.resolve({ ok: false, reason: 'モーションセンサーの許可を要求できませんでした(' + (e && e.message ? e.message : e) + ')。' });
    }
    if (!tasks.length) return Promise.resolve({ ok: true }); // 許可不要の環境(Android・PCなど)
    return Promise.all(tasks).then(function (results) {
      var allGranted = results.every(function (r) { return r === 'granted'; });
      return allGranted ? { ok: true } : {
        ok: false,
        reason: 'モーションセンサー(傾き)の使用が許可されませんでした。' +
                'Safariの「aA」→「Webサイトの設定」で「モーションと画面の向きへのアクセス」を許可し、ページを再読み込みしてください。'
      };
    }).catch(function (e) {
      return { ok: false, reason: 'モーションセンサーの許可に失敗しました(' + (e && e.message ? e.message : e) + ')。' };
    });
  }

  function describeError(err) {
    var text = '';
    try { text = String((err && (err.message || err.name)) || err || ''); } catch (e) { /* ignore */ }
    if (/NotAllowed|Permission|denied/i.test(text)) {
      return 'カメラの使用が許可されていません。Safariの「aA」→「Webサイトの設定」でカメラを許可して再読み込みしてください。';
    }
    if (/NotFound|DevicesNotFound/i.test(text)) return 'カメラが見つかりませんでした。';
    if (/NotReadable|TrackStart|in use/i.test(text)) return 'カメラが他のアプリで使用中の可能性があります。他のアプリを閉じてください。';
    return 'ARの実行中にエラーが発生しました(' + (text || '詳細不明') + ')。';
  }

  /**
   * キャンバスを画面全体に広げるモジュール(これが無いと 300x150px のままになる)。
   * 8th Wall XRExtras の FullWindowCanvas(MIT License, Copyright 2019 8th Wall, Inc.)の
   * サイズ計算を簡略化して移植したもの。
   */
  function fullWindowModule() {
    var canvas = null;
    var vw = 0, vh = 0;

    function fill() {
      if (!canvas) return;
      var dpr = root.devicePixelRatio || 1;
      var ww = root.innerWidth * dpr, wh = root.innerHeight * dpr;
      var ph = Math.max(ww, wh), pw = Math.min(ww, wh);  // 窓(縦向き換算)
      var cw = pw, ch = ph;
      if (vw && vh) {
        var pa = ph / pw;
        var pvh = Math.max(vw, vh), pvw = Math.min(vw, vh);  // 映像(縦向き換算)
        ch = pvh;
        cw = Math.round(pvh / pa);
        if (cw > pvw) { cw = pvw; ch = Math.round(pvw * pa); }
        if (cw > pw || ch > ph) { cw = pw; ch = ph; }  // 画面より高解像度にはしない
      }
      var landscape = ww > wh;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.width = landscape ? ch : cw;
      canvas.height = landscape ? cw : ch;
    }

    function setVideo(v) {
      if (v && v.videoWidth && v.videoHeight) { vw = v.videoWidth; vh = v.videoHeight; }
    }

    return {
      name: 'young-double-slit-fullwindow',
      onAttach: function (ev) {
        canvas = ev.canvas;
        setVideo(ev);
        root.addEventListener('resize', fill);
        fill();
      },
      onDetach: function () {
        root.removeEventListener('resize', fill);
        canvas = null; vw = 0; vh = 0;
      },
      onCameraStatusChange: function (ev) {
        if (ev && ev.status === 'hasVideo') setVideo(ev.video);
      },
      onVideoSizeChange: function (ev) { setVideo(ev); fill(); },
      onDeviceOrientationChange: fill,
      onCanvasSizeChange: fill,
      onUpdate: function () {
        if (canvas && (canvas.style.width !== '100%' || canvas.style.height !== '100%')) fill();
      }
    };
  }

  function start(opts) {
    failed = false;
    if (!root.isSecureContext) {
      return Promise.reject(new Error('HTTPS(安全な接続)でないためカメラを使えません。公開URLは https:// で開いてください。'));
    }
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      return Promise.reject(new Error('この端末/ブラウザはカメラ(getUserMedia)に対応していません。'));
    }
    return waitForEngine(15000).catch(function () {
      throw new Error('ARエンジン(vendor/xr/xr.js)を読み込めませんでした。ネットワークや学校のフィルタで遮断されている可能性があります。');
    }).then(function (XR8) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function fail(msg) {
          failed = true;
          if (!settled) { settled = true; try { XR8.stop(); } catch (e) { /* ignore */ } running = false; reject(new Error(msg)); }
          else if (opts.onError) opts.onError(msg);
        }

        var arModule = {
          name: 'young-double-slit-ar',
          onCameraStatusChange: function (ev) {
            if (ev && ev.status === 'failed') {
              fail('カメラを起動できませんでした。Safariの「aA」→「Webサイトの設定」でカメラが許可されているか確認してください。');
            }
          },
          onStart: function () {
            // XR8.Threejs.xrScene() は XR8.Threejs.pipelineModule() の onStart 後に使える
            // (このモジュールはそれより後に追加しているので、ここで取得できる)
            var x = XR8.Threejs.xrScene();
            // 公式サンプルと同じく、カメラの初期位置をSLAMへ登録する。
            // 地面(y=0)より上にカメラを置くことで、タップ位置を地面に投影できる。
            x.camera.position.set(0, 2, 0);
            XR8.XrController.updateCameraProjectionMatrix({
              origin: x.camera.position,
              facing: x.camera.quaternion
            });
            if (opts.onReady) opts.onReady({ scene: x.scene, camera: x.camera, renderer: x.renderer });
            if (!settled) { settled = true; running = true; resolve(); }
          },
          onUpdate: function (ev) {
            if (opts.onFrame) opts.onFrame();
            // ワールドトラッキングの状態(推測を含む: processCpu.reality.trackingStatus / trackingReason)
            var r = ev && ev.processCpu && ev.processCpu.reality;
            if (r && opts.onTracking) {
              if (r.trackingStatus === 'NORMAL') opts.onTracking('ok');
              else if (r.trackingReason === 'INITIALIZING') opts.onTracking('initializing');
              else if (r.trackingStatus === 'LIMITED') opts.onTracking('limited');
            }
          },
          onException: function (err) { fail(describeError(err)); }
        };

        try {
          if (typeof XR8.clearCameraPipelineModules === 'function') XR8.clearCameraPipelineModules();
          XR8.addCameraPipelineModules([
            XR8.GlTextureRenderer.pipelineModule(),   // カメラ映像を描画
            XR8.Threejs.pipelineModule(),             // three.js (window.THREE が必要)
            XR8.XrController.pipelineModule(),        // SLAM(ワールドトラッキング)
            fullWindowModule(),                       // キャンバスを全画面に
            arModule
          ]);
          // iPad は「モバイル」と判定されない場合があるため ANY を指定する
          XR8.run({ canvas: opts.canvas, allowedDevices: XR8.XrConfig.device().ANY });
        } catch (e) {
          fail(describeError(e));
          return;
        }

        // カメラ許可ダイアログで放置された場合などの保険(許可待ちは長めに)
        setTimeout(function () {
          if (!settled) fail('ARの起動がタイムアウトしました。カメラの許可ダイアログが出ていないか確認してください。');
        }, 60000);
      });
    });
  }

  function stop() {
    try { if (root.XR8 && running) root.XR8.stop(); } catch (e) { /* ignore */ }
    running = false;
  }

  root.ARAdapter = {
    isEngineLoaded: engineLoaded,
    requestSensors: requestSensors,
    start: start,
    stop: stop
  };
})(window);
