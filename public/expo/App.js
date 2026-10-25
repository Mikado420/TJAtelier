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

const URL = 'https://mikado420.github.io/TJAtelier/';

export default function App() {
  const web = useRef(null);
  const seq = useRef(0);
  const [playing, setPlaying] = useState(false);
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    // Expo Go の右下に浮かぶ歯車（開発用のツールボタン）を隠す。使えない環境では何もしない
    try {
      require('expo-dev-menu').setToolsButtonVisible(false);
    } catch {
      // expo-dev-menu が無い
    }
  }, []);

  /** 分けて届くファイル（id ごと） */
  const files = useRef({});

  const onMessage = useCallback((e) => {
    try {
      const m = JSON.parse(e.nativeEvent.data);
      if (m.type === 'file') {
        if (!files.current[m.id]) web.current?.injectJavaScript(`window.__nativeFileAck&&window.__nativeFileAck(${JSON.stringify(m.id)});true;`);
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
        js += `window.__nativeHit&&window.__nativeHit(${(p.x / width).toFixed(4)},${(p.y / height).toFixed(4)},${isFinite(ts) && ts > 0 ? ts : 'undefined'},"${tag}",${seq.current});`;
      }
      if (js) web.current?.injectJavaScript(js + 'true;');
    },
    [width, height],
  );

  // react-native-gesture-handler で受け取った指
  const onDown = useCallback(
    (touches) => {
      const now = Date.now();
      send(touches.map((t) => ({ x: t.absoluteX, y: t.absoluteY, ts: now })), 'gh');
    },
    [send],
  );

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar hidden />
      <WebView
        ref={web}
        source={{ uri: URL }}
        style={styles.web}
        onMessage={onMessage}
        onLoadStart={() => setPlaying(false)}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        bounces={false}
        scrollEnabled={false}
        overScrollMode="never"
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        allowsBackForwardNavigationGestures={false}
        setSupportMultipleWindows={false}
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
