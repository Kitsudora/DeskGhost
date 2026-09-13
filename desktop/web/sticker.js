const ART = Object.freeze({ NotStarted: 'todo', InProgress: 'inprog', Completed: 'done', Stopped: 'stopped' });
const LABELS = Object.freeze({ NotStarted: 'TODO', InProgress: 'IN PROGRESS', Completed: 'DONE', Stopped: 'STOPPED' });
const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => { const t = clamp(value); return t * t * t * (t * (6 * t - 15) + 10); };
const artwork = state => new URL(`./assets/stickers/${ART[state] || ART.NotStarted}.svg`, import.meta.url).href;
let active = null;
let renderer = null;
let graphicsUnavailable = false;
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) active?.cancelGesture(); });
if (typeof window !== 'undefined') window.addEventListener('blur', () => active?.cancelGesture());

/** Direction describes the hand movement, rather than cycling through all states. */
export function nextStickerState(state, direction) {
  if (direction === 'advance') return { NotStarted: 'InProgress', InProgress: 'Completed', Stopped: 'InProgress' }[state] || null;
  if (direction === 'reverse') return { InProgress: 'NotStarted', Completed: 'InProgress', Stopped: 'NotStarted' }[state] || null;
  if (direction === 'stop') return Object.hasOwn(ART, state) && state !== 'Stopped' ? 'Stopped' : null;
  return null;
}

/** Lock the first deliberate pull; small diagonal hand tremors stay horizontal. */
export function stickerGestureDirection(dx, dy, lockedDirection = null) {
  if (lockedDirection) return lockedDirection;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 10) return null;
  if (-dy >= Math.max(8, Math.abs(dx) * .65)) return 'stop';
  if (Math.abs(dx) >= 10 && Math.abs(dx) >= Math.abs(dy) * .55) return dx < 0 ? 'advance' : 'reverse';
  return null;
}

/** Material length is preserved around a cylindrical fold and its free tail. */
export function peelSurface(u, halfLength, progress, direction = 1) {
  const lift = ease(progress / .22), peel = ease((progress - .12) / .66), release = ease((progress - .78) / .22);
  const length = halfLength * (.3 * lift + 1.7 * peel);
  const crease = halfLength - length;
  const radius = halfLength * (.13 + .035 * peel + .36 * release);
  const bend = (2.25 * lift + .35 * peel) * (1 - .34 * release);
  const distance = Math.max(0, direction * u - crease);
  const curl = Math.min(distance / Math.max(.001, radius), bend);
  const tail = Math.max(0, distance - radius * bend);
  return {
    x: distance ? direction * (crease + radius * Math.sin(curl) + tail * Math.cos(bend)) : u,
    z: distance ? radius * (1 - Math.cos(curl)) + tail * Math.sin(bend) : 0,
    curl, release, crease, lift
  };
}

// Only the active sticker uses a canvas. Idle cards share the browser's SVG image
// cache; one renderer/context and at most four textures are retained for reuse.
class PeelRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dg-sticker-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    const gl = this.canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) throw new Error('Sticker graphics are unavailable.');
    this.gl = gl;
    this.textures = new Map();
    this.cols = 88; this.rows = 24;
    this.vertices = new Float32Array((this.cols + 1) * (this.rows + 1) * 8);
    const indices = new Uint16Array(this.cols * this.rows * 6);
    for (let y = 0, offset = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) {
      const a = y * (this.cols + 1) + x, b = a + 1, c = a + this.cols + 1, d = c + 1;
      indices.set([a, b, d, a, d, c], offset); offset += 6;
    }
    const vertex = `attribute vec3 a_position; attribute vec2 a_uv; attribute vec3 a_normal;
      uniform vec2 u_size; varying vec2 v_uv; varying vec3 v_normal;
      void main() {
        vec2 point = a_position.xy - vec2(0.0, a_position.z * .64);
        gl_Position = vec4(point / u_size * vec2(2.0,-2.0) + vec2(-1.0,1.0), -a_position.z / 2000.0, 1.0);
        v_uv = a_uv; v_normal = a_normal;
      }`;
    const fragment = `precision mediump float; uniform sampler2D u_art; uniform float u_opacity;
      varying vec2 v_uv; varying vec3 v_normal;
      void main() {
        if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) discard;
        vec4 art = texture2D(u_art,v_uv); if (art.a < .01) discard;
        vec3 normal = normalize(v_normal);
        float light = max(0.0,dot(gl_FrontFacing ? normal : -normal,normalize(vec3(-.35,-.5,1.0))));
        float grain = fract(sin(dot(v_uv * 200.0,vec2(12.9898,78.233))) * 43758.5453) - .5;
        vec3 colour = gl_FrontFacing ? art.rgb : vec3(1.0,.941,.837) + grain * .018;
        gl_FragColor = vec4(colour * (.70 + .34 * light),art.a * u_opacity);
      }`;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); throw new Error('Sticker shader could not be compiled.'); }
      return shader;
    };
    const program = gl.createProgram();
    const shaders = [compile(gl.VERTEX_SHADER, vertex), compile(gl.FRAGMENT_SHADER, fragment)];
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Sticker shader could not be linked.');
    gl.useProgram(program);
    this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
    for (const [name, size, offset] of [['a_position', 3, 0], ['a_uv', 2, 3], ['a_normal', 3, 5]]) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset * 4);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.indexCount = indices.length;
    this.sizeUniform = gl.getUniformLocation(program, 'u_size');
    this.opacityUniform = gl.getUniformLocation(program, 'u_opacity');
    gl.frontFace(gl.CW); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault(); graphicsUnavailable = true; active?.stopVisual(); this.hide();
    });
  }

  async load(state) {
    if (this.textures.has(state)) return this.textures.get(state);
    const pending = new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        if (graphicsUnavailable) { resolve(null); return; }
        try {
          const gl = this.gl, texture = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
          resolve({ texture, width: image.naturalWidth, height: image.naturalHeight });
        } catch { resolve(null); }
      };
      image.onerror = () => resolve(null);
      image.src = artwork(state);
    });
    this.textures.set(state, pending);
    return pending;
  }

  draw(slot, art, progress, direction, applying = false, peelAngle = null) {
    if (graphicsUnavailable || !art) return false;
    const rect = slot.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const fit = Math.min(rect.width / art.width, rect.height / art.height);
    const w = art.width * fit, h = art.height * fit;
    const width = rect.width * 4, height = rect.height * 4;
    const pixels = Math.min(window.devicePixelRatio || 1, 2, 1800 / Math.max(width, height));
    const canvas = this.canvas, gl = this.gl;
    const pixelWidth = Math.max(1, Math.round(width * pixels)), pixelHeight = Math.max(1, Math.round(height * pixels));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth; canvas.height = pixelHeight; gl.viewport(0, 0, pixelWidth, pixelHeight);
    }
    Object.assign(canvas.style, { left: `${rect.left - rect.width * 1.5}px`, top: `${rect.top - rect.height * 1.5}px`, width: `${width}px`, height: `${height}px` });
    if (!canvas.isConnected) document.body.append(canvas);
    const stopping = direction === 'stop';
    const angle = stopping ? (peelAngle ?? Math.PI / 2) : -.3634, ca = Math.cos(angle), sa = Math.sin(angle);
    const halfLength = (w * Math.abs(ca) + h * Math.abs(sa)) / 2;
    const halfWidth = (w * Math.abs(sa) + h * Math.abs(ca)) / 2;
    const sign = direction === 'reverse' ? -1 : 1;
    for (let row = 0; row <= this.rows; row++) for (let col = 0; col <= this.cols; col++) {
      const u = -halfLength + col / this.cols * halfLength * 2;
      const v = -halfWidth + row / this.rows * halfWidth * 2;
      const point = peelSurface(u, halfLength, progress, sign);
      const release = applying ? 0 : point.release;
      const rotation = release * (stopping ? -.08 : -.25 * sign), cr = Math.cos(rotation), sr = Math.sin(rotation);
      const x = point.x * cr - v * sr, y = point.x * sr + v * cr;
      const index = (row * (this.cols + 1) + col) * 8;
      this.vertices[index] = width / 2 + ca * x - sa * y - release * (stopping ? ca * halfLength * 2 : w * sign);
      this.vertices[index + 1] = height / 2 + sa * x + ca * y - release * (stopping ? sa * halfLength * 2 : h * .18);
      this.vertices[index + 2] = point.z + release * w * .55;
      this.vertices[index + 3] = .5 + (ca * u - sa * v) / w;
      this.vertices[index + 4] = .5 + (sa * u + ca * v) / h;
      this.vertices[index + 5] = -sign * Math.sin(point.curl) * Math.cos(angle + rotation);
      this.vertices[index + 6] = -sign * Math.sin(point.curl) * Math.sin(angle + rotation);
      this.vertices[index + 7] = Math.cos(point.curl);
    }
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, art.texture);
    gl.uniform2f(this.sizeUniform, width, height);
    gl.uniform1f(this.opacityUniform, applying ? 1 - ease((progress - .53) / .23) : 1 - ease((progress - .87) / .13));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertices);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    return true;
  }

  hide() { this.canvas.remove(); }
}

/** Shared by the graph and enlarged editor; update never replaces an active image. */
export class StickerController {
  constructor(slot, options = {}) {
    this.slot = slot; this.options = options; this.state = options.state || 'NotStarted';
    this.disabled = !!options.disabled; this.busy = false; this.disposed = false; this.frame = 0;
    this.button = document.createElement('button'); this.button.type = 'button'; this.button.className = 'dg-sticker-button';
    this.image = document.createElement('img'); this.image.className = 'dg-sticker-image'; this.image.draggable = false; this.image.alt = '';
    this.button.append(this.image); this.slot.replaceChildren(this.button);
    this.abort = new AbortController(); const events = { signal: this.abort.signal };
    this.button.addEventListener('pointerdown', event => this.pointerDown(event), events);
    this.button.addEventListener('pointermove', event => this.pointerMove(event), events);
    this.button.addEventListener('pointerup', event => this.pointerUp(event), events);
    this.button.addEventListener('pointercancel', () => this.cancelGesture(), events);
    this.button.addEventListener('lostpointercapture', () => { if (this.gesture) this.cancelGesture(); }, events);
    this.button.addEventListener('click', event => { event.stopPropagation(); if (event.detail === 0) this.change('advance'); }, events);
    this.button.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'Enter' && event.shiftKey) {
        event.preventDefault(); event.stopPropagation();
        this.change(event.key === 'ArrowUp' ? 'stop' : event.key === 'ArrowLeft' ? 'advance' : 'reverse');
      } else if (event.key === 'Escape' && this.gesture) { event.preventDefault(); event.stopPropagation(); this.cancelGesture(); }
    }, events);
    this.update(this.state, { disabled: this.disabled });
  }

  get reducedMotion() { return document.documentElement.dataset.effects === 'off' || window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  update(state, { disabled = this.disabled } = {}) {
    this.revision = (this.revision || 0) + 1;
    this.state = Object.hasOwn(ART, state) ? state : 'NotStarted'; this.disabled = disabled;
    this.button.disabled = !!disabled;
    this.button.setAttribute('aria-label', `${LABELS[this.state]}. Peel left to advance, right to go back, or up to stop. Arrow keys also work.`);
    this.button.title = disabled ? `${LABELS[this.state]} — read only` : 'Peel left to advance · Peel right to go back · Peel up to stop';
    this.button.dataset.state = this.state;
    if (!this.busy) this.image.src = artwork(this.state);
  }

  async prepare() {
    if (this.reducedMotion || graphicsUnavailable) return null;
    try { renderer ||= new PeelRenderer(); return await renderer.load(this.state); }
    catch { graphicsUnavailable = true; return null; }
  }

  pointerDown(event) {
    if (event.button !== 0 || this.disabled || this.busy || this.saving || this.gesture || active && active !== this) return;
    event.stopPropagation();
    active = this;
    const rect = this.slot.getBoundingClientRect();
    this.peelAngle = null;
    this.gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, progress: 0, direction: null };
    this.button.setPointerCapture(event.pointerId);
  }

  pointerMove(event) {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.type === 'pointermove' && !(event.buttons & 1)) { this.cancelGesture(); return; }
    event.stopPropagation();
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    const direction = stickerGestureDirection(dx, dy, gesture.direction);
    if (!direction) return;
    if (!gesture.direction && direction === 'stop') {
      const length = Math.hypot(dx, dy);
      gesture.pullX = dx / length; gesture.pullY = dy / length;
      this.peelAngle = Math.atan2(-dy, -dx);
    }
    if (!nextStickerState(this.state, direction)) {
      gesture.direction = direction; gesture.progress = 0;
      if (this.busy) this.paint(0, direction);
      return;
    }
    gesture.direction = direction;
    const distance = direction === 'stop' ? dx * gesture.pullX + dy * gesture.pullY : dx * (direction === 'advance' ? -1 : 1);
    const extent = direction === 'stop' ? gesture.height : gesture.width;
    gesture.progress = Math.min(.65, Math.max(0, distance) / Math.max(40, extent) * .7);
    if (!this.busy) {
      if (active && active !== this) return;
      active = this; this.busy = true; this.button.classList.add('is-peeling');
      this.prepare().then(art => { if (this.gesture === gesture && active === this) { this.art = art; this.paint(gesture.progress, gesture.direction); } });
    }
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; if (this.gesture === gesture) this.paint(gesture.progress, gesture.direction); });
  }

  pointerUp(event) {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.pointerMove(event); this.gesture = null;
    if (this.button.hasPointerCapture(event.pointerId)) this.button.releasePointerCapture(event.pointerId);
    const enough = gesture.progress >= .12;
    if (enough && gesture.direction) this.change(gesture.direction, gesture.progress);
    else this.settle(gesture.progress, gesture.direction);
  }

  paint(progress, direction, applying = false) {
    if (active === this && !this.disposed && this.art && !this.reducedMotion && renderer?.draw(this.slot, this.art, progress, direction, applying, this.peelAngle)) this.image.style.opacity = '0';
  }

  animate(from, to, direction, duration, applying = false) {
    cancelAnimationFrame(this.frame); this.frame = 0;
    return new Promise(resolve => {
      this.finishAnimation = resolve;
      const start = performance.now();
      const tick = now => {
        this.frame = 0;
        if (this.disposed || document.hidden || !this.slot.isConnected || !this.slot.getClientRects().length || this.reducedMotion || !this.art || active !== this || getComputedStyle(this.slot).visibility === 'hidden') {
          if (active === this) renderer?.hide();
          this.finishAnimation = null; resolve(); return;
        }
        const t = clamp((now - start) / duration);
        this.paint(from + (to - from) * ease(t), direction, applying);
        if (t < 1) this.frame = requestAnimationFrame(tick);
        else { this.finishAnimation = null; resolve(); }
      };
      this.frame = requestAnimationFrame(tick);
    });
  }

  async change(direction, progress = 0) {
    const next = nextStickerState(this.state, direction);
    if (this.saving || active && active !== this) return false;
    if (!next || this.disabled || this.disposed) { this.stopVisual(); return false; }
    active = this; this.busy = true; this.saving = true;
    this.button.classList.add('is-peeling'); this.button.setAttribute('aria-busy', 'true');
    const revision = this.revision;
    try {
      // Start persistence independently of image decoding and rendering. Attach
      // both handlers immediately so a fast rejection cannot go unhandled.
      const completion = Promise.resolve().then(() => this.options.onChange?.(next))
        .then(result => ({ result }), error => ({ error, failed: true }));
      this.art ||= await this.prepare();
      // Keep the old sticker attached until the host accepts the change. Saving
      // itself does not wait for the animation, and a rejection rolls back visually.
      this.paint(Math.max(.12, progress), direction);
      const outcome = await completion;
      if (outcome.failed) throw outcome.error;
      const result = outcome.result;
      if (result === false) { await this.animate(progress, 0, direction, 180); return false; }
      if (this.disposed) return true;
      // A synchronous host render can already have called update(next). Preserve
      // a later, different host state instead of overwriting it after the animation.
      if (this.revision === revision) this.state = next;
      await this.animate(Math.max(.12, progress), 1, direction, 660);
      if (!this.disposed && active === this && !this.reducedMotion) {
        this.art = await renderer?.load(this.state);
        await this.animate(.76, 0, direction, 430, true);
      }
      return true;
    } catch (error) {
      await this.animate(progress, 0, direction, 180);
      try { this.options.onError?.(error); } catch { /* A presentation callback must not reject the input handler. */ }
      return false;
    } finally {
      this.saving = false; this.stopVisual();
      if (!this.disposed) this.update(this.state, { disabled: this.disabled });
    }
  }

  async settle(progress, direction) {
    if (this.busy && !this.saving) await this.animate(progress, 0, direction, 180);
    if (!this.saving) this.stopVisual();
  }

  cancelGesture() {
    const gesture = this.gesture; this.gesture = null;
    if (gesture && this.button.hasPointerCapture(gesture.pointerId)) this.button.releasePointerCapture(gesture.pointerId);
    this.stopVisual();
  }

  stopVisual() {
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.finishAnimation?.(); this.finishAnimation = null;
    if (active === this) { renderer?.hide(); active = null; }
    this.busy = false; this.art = null; this.peelAngle = null;
    this.image.style.opacity = ''; this.image.src = artwork(this.state);
    this.button.classList.remove('is-peeling'); this.button.removeAttribute('aria-busy');
  }

  destroy() { this.disposed = true; this.abort.abort(); this.cancelGesture(); this.stopVisual(); this.slot.replaceChildren(); }
}
