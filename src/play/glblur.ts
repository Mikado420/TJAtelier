/**
 * 動画を GPU（WebGL）でぼかして描く。動画のコマをそのまま GPU に渡し、横・縦の 2 回に分けてガウスぼかしをかける。
 * 画面の処理（CPU）をほとんど使わず、iPhone でもなめらかにぼける（canvas の filter が無くてもよい）
 */

const VS = `
attribute vec2 p;
varying vec2 uv;
void main() {
  uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/** dir = 1 回に進む量（元の絵の uv）。map = 出す所の uv から元の絵の uv へ（倍率と位置）。k = 明るさ */
const FS = `
precision mediump float;
varying vec2 uv;
uniform sampler2D tex;
uniform vec2 dir;
uniform vec4 map;
uniform float sigma;
uniform float k;
void main() {
  vec2 c = uv * map.xy + map.zw;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i);
    float w = exp(-x * x / (2.0 * sigma * sigma));
    sum += texture2D(tex, c + dir * x) * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum.rgb / wsum * k, 1.0);
}`;

export class GlBlur {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private vtex: WebGLTexture;
  private mtex: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private loc: { dir: WebGLUniformLocation | null; map: WebGLUniformLocation | null; sigma: WebGLUniformLocation | null; k: WebGLUniformLocation | null };
  private size = { w: 0, h: 0 };
  lost = false;

  /** 作れなければ null（WebGL が使えない端末） */
  static create(): GlBlur | null {
    try {
      const cv = document.createElement('canvas');
      // 録画で、画面に出したあとの絵も写せるように残しておく
      const gl = cv.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
      if (!gl) return null;
      return new GlBlur(cv, gl);
    } catch {
      return null;
    }
  }

  private constructor(cv: HTMLCanvasElement, gl: WebGLRenderingContext) {
    this.canvas = cv;
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    this.loc = { dir: gl.getUniformLocation(prog, 'dir'), map: gl.getUniformLocation(prog, 'map'), sigma: gl.getUniformLocation(prog, 'sigma'), k: gl.getUniformLocation(prog, 'k') };
    gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0);
    const mk = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      // 端は端の色を伸ばす（端がぼけて暗くならないように）
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    };
    this.vtex = mk();
    this.mtex = mk();
    this.fbo = gl.createFramebuffer()!;
    cv.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  /**
   * 動画の今のコマを、w×h に覆うように置いてぼかして描く。sigma = ぼけ方（この canvas の px）、bright = 明るさ（0〜1）。
   * 描けなければ false
   */
  draw(v: HTMLVideoElement, w: number, h: number, sigma: number, bright: number): boolean {
    const gl = this.gl;
    if (this.lost || gl.isContextLost() || !v.videoWidth || !v.videoHeight) return false;
    if (this.size.w !== w || this.size.h !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      gl.bindTexture(gl.TEXTURE_2D, this.mtex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mtex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.size = { w, h };
    }
    // 動画のコマを GPU へ（上下はそのまま）
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.vtex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    } catch {
      return false;
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // 覆うように置く: 出す所の uv（0〜1）から、動画の uv へ
    const k = Math.max(w / v.videoWidth, h / v.videoHeight);
    const sx = w / (v.videoWidth * k);
    const sy = h / (v.videoHeight * k);
    gl.useProgram(this.prog);
    gl.uniform1f(this.loc.sigma, Math.max(0.5, sigma));
    // 1 回目: 横にぼかして、間の絵へ（動画の uv で 1 px ずつ）
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.uniform4f(this.loc.map, sx, sy, (1 - sx) / 2, (1 - sy) / 2);
    gl.uniform2f(this.loc.dir, sx / w, 0);
    gl.uniform1f(this.loc.k, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // 2 回目: 縦にぼかして、明るさを掛けて画面へ
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.mtex);
    gl.viewport(0, 0, w, h);
    gl.uniform4f(this.loc.map, 1, 1, 0, 0);
    gl.uniform2f(this.loc.dir, 0, 1 / h);
    gl.uniform1f(this.loc.k, bright);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  dispose() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
    this.canvas.width = this.canvas.height = 0;
  }
}
