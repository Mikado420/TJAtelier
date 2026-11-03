/**
 * TJAtelier を Expo Go の中で動かすためのアプリ（Expo Snack 用の 1 ファイル）
 *
 * iPhone の Safari（WebKit）は、両手交互で速く叩いて「指が 1 本も触れていない瞬間」に
 * 次の指が触れると、そのタッチをページに届けないことがある。
 * そこでテストプレイ中だけ、Web 版の上に透明な層を重ね、アプリ（React Native）の仕組みで指を受け取って
 * Web 版の window.__nativeHit(x, y, 時刻, 方式, 通し番号) に渡す。エディタを使うときは層を外す。
 *
 * 指は react-native-gesture-handler の手動のジェスチャー（onTouchesDown）で受け取る
 * （React Native の onTouchStart では Safari と同じように取りこぼした）。
 * Expo の版によって gesture-handler が 2 系（Gesture.Manual()）か 3 系（useManualGesture()）なので、どちらでも動くようにする。
 * 叩いた時刻はこちらで受け取った瞬間に Date.now() で測って渡す。Web 版まで届くのに時間がかかっても
 * 判定が遅れない（Web 版は「届くまでの遅れがいちばん少なかったとき」を基準に時刻を直す）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, View, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as GH from 'react-native-gesture-handler';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';

const { GestureDetector, GestureHandlerRootView } = GH;

/**
 * 打音はアプリで鳴らす（指に触れた瞬間に。Web 版へ指を渡す時間を待たない）。
 * 音は Web 版が鳴らすのと同じもの（頭の無音を削り、大きさを揃え、打音の音量を掛けた WAV）を Web 版から受け取る。
 * expo-audio が使えないときは、これまでどおり Web 版が鳴らす
 */
let EA = null;
try {
  EA = require('expo-audio');
} catch {
  EA = null;
}
/** 同じ音を重ねて鳴らせるように、1 つの音につき何個の再生器を順に使うか */
const HIT_VOICES = 6;
/** gesture-handler 3 系の書き方（useManualGesture）が使えるか。なければ 2 系の Gesture.Manual() */
const HAS_V3 = typeof GH.useManualGesture === 'function';
const HAS_V2 = !!(GH.Gesture && typeof GH.Gesture.Manual === 'function');

/** 2 系: Gesture.Manual() */
function ManualV2({ onDown, children }) {
  const gesture = useMemo(
    () => GH.Gesture.Manual().runOnJS(true).onTouchesDown((e) => onDown(e.changedTouches || [])),
    [onDown],
  );
  return <GestureDetector gesture={gesture}>{children}</GestureDetector>;
}

/** 3 系: useManualGesture()（コールバックは JS 側で動かす） */
function ManualV3({ onDown, children }) {
  const gesture = GH.useManualGesture({
    runOnJS: true,
    onTouchesDown: (e) => onDown(e.changedTouches || []),
  });
  return <GestureDetector gesture={gesture}>{children}</GestureDetector>;
}

/** どちらも無いとき（念のため）: React Native の onTouchStart */
function ManualRN({ onDown, children }) {
  return (
    <View style={StyleSheet.absoluteFill} onStartShouldSetResponder={() => true}
      onTouchStart={(e) => onDown((e.nativeEvent.changedTouches || []).map((t) => ({ absoluteX: t.pageX, absoluteY: t.pageY })))}>
      {children}
    </View>
  );
}

const Manual = HAS_V2 ? ManualV2 : HAS_V3 ? ManualV3 : ManualRN;

/** base64 → バイト列 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = new Uint8Array(128);
for (let i = 0; i < B64.length; i++) B64I[B64.charCodeAt(i)] = i;
function fromBase64(s) {
  const len = s.length;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((len / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const n = (B64I[s.charCodeAt(i)] << 18) | (B64I[s.charCodeAt(i + 1)] << 12) | (B64I[s.charCodeAt(i + 2)] << 6) | B64I[s.charCodeAt(i + 3)];
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Web 版から届いたファイルを保存して、共有シート（「ファイルに保存」など）を開く */
async function saveAndShare(name, mime, b64) {
  const safe = String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_');
  const file = new File(Paths.cache, safe);
  try {
    if (file.exists) file.delete();
  } catch {
    // 消せなくても上書きを試す
  }
  file.create();
  file.write(fromBase64(b64));
  await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: safe });
}

/** アプリ本体の版（Web 版が「古いアプリか」を見分ける。変えたら 1 つ上げる） */
const APP_VERSION = 7;
const INJECT_BEFORE = `window.__nativeApp=${APP_VERSION};true;`;

const URL = 'https://mikado420.github.io/TJAtelier/';

export default function App() {
  const web = useRef(null);
  const seq = useRef(0);
  const [playing, setPlaying] = useState(false);
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    // 曲（Web 版の音）と打音（アプリの音）を一緒に鳴らす。消音スイッチがオンでも鳴らす
    try {
      EA?.setAudioModeAsync?.({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' })?.catch?.(() => {});
    } catch {
      // 設定できない
    }
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    // Expo Go の右下に浮かぶ歯車（開発用のツールボタン）を隠す。使えない環境では何もしない
    try {
      require('expo-dev-menu').setToolsButtonVisible(false);
    } catch {
      // expo-dev-menu が無い
    }
  }, []);

  /** 打音を鳴らす場所（Web 版の太鼓の位置。画面に対する割合）と、今鳴らしてよいか */
  const hitGeo = useRef({ on: false });
  /** 打音の再生器（音ごとに HIT_VOICES 個）と、次に使う番号 */
  const hitPool = useRef({ don: [], ka: [] });
  const hitIdx = useRef({ don: 0, ka: 0 });
  const hitGen = useRef(0);

  /** Web 版から届いた打音（base64 の WAV）を、ファイルにして再生器を作り直す */
  const loadHits = useCallback((m) => {
    if (!EA || typeof EA.createAudioPlayer !== 'function') return;
    const gen = ++hitGen.current;
    for (const kind of ['don', 'ka']) {
      if (!m[kind]) continue;
      try {
        const f = new File(Paths.cache, `hit-${kind}-${gen}.wav`);
        try { if (f.exists) f.delete(); } catch { /* 上書き */ }
        f.create();
        f.write(fromBase64(m[kind]));
        const old = hitPool.current[kind];
        const pool = [];
        for (let i = 0; i < HIT_VOICES; i++) {
          const p = EA.createAudioPlayer({ uri: f.uri });
          // 鳴り終わったら頭に戻しておく（次に使うとき、すぐ鳴らせるように）
          try { p.addListener?.('playbackStatusUpdate', (st) => { if (st && st.didJustFinish) p.seekTo(0).catch?.(() => {}); }); } catch { /* 知らせが無い */ }
          pool.push(p);
        }
        hitPool.current[kind] = pool;
        hitIdx.current[kind] = 0;
        for (const p of old) { try { p.remove(); } catch { /* 外せない */ } }
      } catch {
        hitPool.current[kind] = [];
      }
    }
  }, []);

  /** その位置（画面に対する割合）を叩いたときの音（ドン・カッ）。鳴らさない所なら null */
  const kindAt = useCallback((nx, ny) => {
    const g = hitGeo.current;
    if (!g || !g.on) return null;
    for (const b of g.btn || []) if (nx >= b[0] && nx <= b[2] && ny >= b[1] && ny <= b[3]) return null;
    if (g.pause && ny < g.pause.bottom && Math.abs(nx - g.x) < g.pause.half) return null;
    if (g.rest && ny < g.rest) return null;
    const ring = Math.hypot((nx - g.x) / Math.max(1e-4, g.half), (ny - g.y) / Math.max(1e-4, g.ry));
    return ring <= 1 ? 'don' : 'ka';
  }, []);

  /** 打音を鳴らす（鳴らせたら true） */
  const playHit = useCallback((kind) => {
    const pool = hitPool.current[kind];
    if (!pool || !pool.length) return false;
    const i = hitIdx.current[kind];
    hitIdx.current[kind] = (i + 1) % pool.length;
    const p = pool[i];
    try {
      if (p.playing || p.currentTime > 0.001) p.seekTo(0);
      p.play();
      return true;
    } catch {
      return false;
    }
  }, []);

  /** 分けて届くファイル（id ごと） */
  const files = useRef({});

  const onMessage = useCallback((e) => {
    try {
      const m = JSON.parse(e.nativeEvent.data);
      if (m.type === 'file') {
        if (!files.current[m.id]) {
          const ack = JSON.stringify(m.id);
          web.current?.injectJavaScript(`window.__nativeFileAck&&window.__nativeFileAck(${ack});true;`);
          // 念のためもう一つの道でも知らせる
          web.current?.postMessage(JSON.stringify({ type: 'fileAck', id: m.id }));
        }
        const f = (files.current[m.id] ||= { parts: [], got: 0 });
        if (f.parts[m.part] === undefined) f.got += 1;
        f.parts[m.part] = m.data;
        if (f.got >= m.total) {
          delete files.current[m.id];
          saveAndShare(m.name, m.mime, f.parts.join('')).catch((err) => {
            Alert.alert('保存できませんでした', String((err && err.message) || err));
            web.current?.injectJavaScript(`window.__nativeSaveError&&window.__nativeSaveError(${JSON.stringify(String(err && err.message || err))});true;`);
          });
        }
        return;
      }
      if (m.type === 'orient') {
        // TJA の画面は縦、ほかは横。固定できなかったら、縦のときは固定を外して（端末を回せば縦になる）、結果を Web 版へ知らせる
        const O = ScreenOrientation.OrientationLock;
        (async () => {
          try {
            await ScreenOrientation.lockAsync(m.portrait ? O.PORTRAIT_UP : O.LANDSCAPE);
            return 'ok';
          } catch (err) {
            if (m.portrait) {
              try { await ScreenOrientation.unlockAsync(); } catch { /* 外せない */ }
            }
            return String((err && err.message) || err);
          }
        })().then((r) => {
          web.current?.injectJavaScript(`window.__orientResult&&window.__orientResult(${JSON.stringify(r)},${m.portrait ? 1 : 0});true;`);
        });
        return;
      }
      if (m.type === 'hitsound') {
        loadHits(m);
        return;
      }
      if (m.type === 'hitgeo') {
        hitGeo.current = m;
        return;
      }
      if (m.type === 'play') {
        setPlaying(!!m.active);
        if (m.active) seq.current = 0;
      }
    } catch {
      // 関係ないメッセージ
    }
  }, []);

  /** 指（画面上の位置 px）を Web 版へ渡す */
  const send = useCallback(
    (points, tag) => {
      let js = '';
      for (const p of points) {
        seq.current += 1;
        const ts = Number(p.ts);
        js += `window.__nativeHit&&window.__nativeHit(${(p.x / width).toFixed(4)},${(p.y / height).toFixed(4)},${isFinite(ts) && ts > 0 ? ts : 'undefined'},"${tag}",${seq.current},${p.played ? 1 : 0});`;
      }
      if (js) web.current?.injectJavaScript(js + 'true;');
    },
    [width, height],
  );

  // react-native-gesture-handler で受け取った指
  const onDown = useCallback(
    (touches) => {
      const now = Date.now();
      // 先に打音を鳴らしてから、Web 版へ渡す
      const pts = touches.map((t) => {
        const k = kindAt(t.absoluteX / width, t.absoluteY / height);
        return { x: t.absoluteX, y: t.absoluteY, ts: now, played: k ? playHit(k) : false };
      });
      send(pts, 'gh');
    },
    [send, kindAt, playHit, width, height],
  );

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar hidden />
      <WebView
        ref={web}
        source={{ uri: URL }}
        style={styles.web}
        onMessage={onMessage}
        injectedJavaScriptBeforeContentLoaded={INJECT_BEFORE}
        injectedJavaScript={INJECT_BEFORE}
        onLoadStart={() => setPlaying(false)}
        // 読み込みのたびに、アプリの版をもう一度知らせる（読み直した後に知らせが届いていないことがあるため）
        onLoadEnd={() => web.current?.injectJavaScript(INJECT_BEFORE)}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        bounces={false}
        scrollEnabled={false}
        overScrollMode="never"
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        allowsBackForwardNavigationGestures={false}
        setSupportMultipleWindows={false}
        // 中身の処理が落ちた（メモリ不足など）ときは、白や色だけの画面のままにせず読み込み直す
        onContentProcessDidTerminate={() => { setPlaying(false); web.current?.reload(); }}
        onRenderProcessGone={() => { setPlaying(false); web.current?.reload(); return true; }}
      />
      {playing && (
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          <Manual onDown={onDown}>
            <View style={StyleSheet.absoluteFill} collapsable={false} />
          </Manual>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
});
