const TAU = Math.PI * 2;
const MAX_BOIDS = 128;
const MAX_CANVAS_PIXELS = 6_000_000;
const MAX_CANVAS_DIMENSION = 16_384;
const MODES = new Set(['hidden', 'idle', 'ring', 'card', 'disperse']);
const EFFECTS = new Set(['off', 'low', 'high']);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const random = (min, max) => min + Math.random() * (max - min);
const finite = value => typeof value === 'number' && Number.isFinite(value);

/**
 * A transparent Canvas2D flock. Points and card bounds use CSS viewport pixels.
 * Input belongs to the HTML application: onReady is synchronous when entering
 * ring/card, including with effects off. Only completed dispersal calls onDismiss.
 */
export class Flock {
  constructor(canvas, { onReady, onDismiss } = {}) {
    if (!canvas?.getContext) throw new TypeError('Flock requires a canvas.');
    this.canvas = canvas;
    this._context = canvas.getContext('2d', { alpha: true });
    if (!this._context) throw new Error('Canvas2D is unavailable.');
    this._window = canvas.ownerDocument?.defaultView ?? window;
    this._document = canvas.ownerDocument ?? document;
    this._onReady = typeof onReady === 'function' ? onReady : null;
    this._onDismiss = typeof onDismiss === 'function' ? onDismiss : null;
    this._mode = 'hidden';
    this._effects = 'high';
    this._boids = [];
    this._raf = null;
    this._lastTime = null;
    this._time = 0;
    this._modeTime = 0;
    this._destroyed = false;
    this._hasTarget = false;
    this._target = { x: 0, y: 0 };
    this._center = { x: 0, y: 0, vx: 0, vy: 0 };
    this._bounds = null;
    this._width = 1;
    this._height = 1;
    this._offset = { x: 0, y: 0 };
    this._tick = this._tick.bind(this);
    this._onResize = () => this.resize();
    this._onVisibility = () => {
      if (this._document.hidden) {
        this._stop();
        if (this._mode === 'disperse') this._finishDismiss();
      } else {
        this._queue();
      }
    };
    this._window.addEventListener('resize', this._onResize);
    this._document.addEventListener('visibilitychange', this._onVisibility);
    this.resize();
  }

  setMode(mode, { point, bounds } = {}) {
    if (this._destroyed) return this;
    if (!MODES.has(mode)) throw new RangeError(`Unknown flock mode: ${mode}`);
    if (point) this.setTarget(point);
    if (bounds) this._setBounds(bounds);
    if (mode === this._mode) return this;
    const previous = this._mode;
    this._mode = mode;
    this._modeTime = 0;
    if (mode === 'hidden') {
      this._stop();
      this._clear();
      return this;
    }
    if (mode === 'disperse') {
      if (this._effects === 'off' || previous === 'hidden' || this._document.hidden) {
        this._finishDismiss();
        return this;
      }
      for (const boid of this._boids) this._launchOutward(boid);
    } else if (this._effects !== 'off') {
      this._ensureBoids();
      if (previous === 'hidden' || previous === 'disperse') {
        this._center.x = this._target.x;
        this._center.y = this._target.y;
        this._center.vx = this._center.vy = 0;
        for (const boid of this._boids) this._spawn(boid);
      } else {
        for (const boid of this._boids) boid.delay = 0;
      }
    }
    this._queue();
    if (mode === 'ring' || mode === 'card') this._onReady?.({ mode });
    return this;
  }

  setTarget(point) {
    if (this._destroyed || !finite(point?.x) || !finite(point?.y)) return this;
    this._hasTarget = true;
    this._target.x = clamp(point.x - this._offset.x, -512, this._width + 512);
    this._target.y = clamp(point.y - this._offset.y, -512, this._height + 512);
    return this;
  }

  setEffects(effects) {
    if (this._destroyed) return this;
    if (!EFFECTS.has(effects)) throw new RangeError(`Unknown flock effects: ${effects}`);
    if (effects === this._effects) return this;
    this._effects = effects;
    this._stop();
    if (effects === 'off') {
      this._clear();
      if (this._mode === 'disperse') this._finishDismiss();
    } else if (this._mode !== 'hidden') {
      this._ensureBoids();
      this._queue();
    }
    return this;
  }

  resize() {
    if (this._destroyed) return this;
    const rect = this.canvas.getBoundingClientRect();
    const width = finite(rect.width) && rect.width > 0 ? rect.width : this._window.innerWidth;
    const height = finite(rect.height) && rect.height > 0 ? rect.height : this._window.innerHeight;
    this._width = clamp(finite(width) ? width : 1, 1, 32_768);
    this._height = clamp(finite(height) ? height : 1, 1, 32_768);
    this._offset.x = finite(rect.left) ? rect.left : 0;
    this._offset.y = finite(rect.top) ? rect.top : 0;
    const deviceRatio = finite(this._window.devicePixelRatio) ? this._window.devicePixelRatio : 1;
    this._dpr = Math.min(clamp(deviceRatio, 0.25, 2),
      Math.sqrt(MAX_CANVAS_PIXELS / (this._width * this._height)),
      MAX_CANVAS_DIMENSION / Math.max(this._width, this._height));
    this.canvas.width = Math.max(1, Math.floor(this._width * this._dpr));
    this.canvas.height = Math.max(1, Math.floor(this._height * this._dpr));
    if (!this._hasTarget) {
      this._target.x = this._center.x = this._width / 2;
      this._target.y = this._center.y = this._height / 2;
    }
    this._lastTime = null;
    if (this._mode !== 'hidden' && this._effects !== 'off' && !this._document.hidden) this._draw();
    return this;
  }

  destroy() {
    if (this._destroyed) return;
    this._stop();
    this._window.removeEventListener('resize', this._onResize);
    this._document.removeEventListener('visibilitychange', this._onVisibility);
    this._clear();
    this._boids.length = 0;
    this._onReady = this._onDismiss = null;
    this._destroyed = true;
    // Release the backing bitmap as well as the simulation and its callbacks.
    this.canvas.width = this.canvas.height = 1;
  }

  _setBounds(bounds) {
    const x = bounds.x ?? bounds.left;
    const y = bounds.y ?? bounds.top;
    if (![x, y, bounds.width, bounds.height].every(finite) || bounds.width <= 0 || bounds.height <= 0) return;
    this._bounds = {
      x: clamp(x - this._offset.x, -32_768, 32_768),
      y: clamp(y - this._offset.y, -32_768, 32_768),
      width: clamp(bounds.width, 1, 32_768),
      height: clamp(bounds.height, 1, 32_768)
    };
  }

  _ensureBoids() {
    const count = Math.min(MAX_BOIDS, this._effects === 'low' ? 42 : 72);
    if (this._boids.length > count) this._boids.length = count;
    while (this._boids.length < count) {
      const index = this._boids.length;
      const size = random(9, 13.5);
      const boid = {
        index, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0,
        tx: 0, ty: 0, flowX: 0, flowY: 0, angle: random(-Math.PI, Math.PI),
        mass: random(0.78, 1.3), size, phase: random(0, TAU),
        orbitRate: random(0.94, 1.06), lane: random(-1, 1),
        u: Math.random(), v: Math.random(), opacity: 0, delay: 0,
        whiteness: random(0.82, 1), interior: index % 6 === 0,
        path: trianglePath(size)
      };
      this._spawn(boid);
      this._boids.push(boid);
    }
  }

  _spawn(boid) {
    boid.opacity = 0;
    boid.delay = random(0, 0.32);
    if (this._mode === 'idle') {
      boid.x = this._target.x + random(-80, 80);
      boid.y = this._target.y + random(-35, 35);
    } else {
      const side = Math.floor(Math.random() * 4);
      const margin = random(35, 130);
      boid.x = side === 0 ? -margin : side === 1 ? this._width + margin : random(0, this._width);
      boid.y = side === 2 ? -margin : side === 3 ? this._height + margin : random(0, this._height);
    }
    const angle = Math.atan2(this._target.y - boid.y, this._target.x - boid.x) + random(-0.3, 0.3);
    const speed = this._mode === 'idle' ? random(5, 25) : random(140, 280);
    boid.vx = Math.cos(angle) * speed;
    boid.vy = Math.sin(angle) * speed;
  }

  _launchOutward(boid) {
    let angle = Math.atan2(boid.y - this._center.y, boid.x - this._center.x);
    angle += random(-0.55, 0.55);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const distance = Math.hypot(this._width, this._height) + 150;
    boid.tx = boid.x + dx * distance;
    boid.ty = boid.y + dy * distance;
    boid.vx += dx * random(180, 320);
    boid.vy += dy * random(180, 320);
    boid.delay = 0;
  }

  _queue() {
    if (!this._destroyed && this._raf === null && this._mode !== 'hidden' && this._effects !== 'off' && !this._document.hidden)
      this._raf = this._window.requestAnimationFrame(this._tick);
  }

  _stop() {
    if (this._raf !== null) this._window.cancelAnimationFrame(this._raf);
    this._raf = null;
    this._lastTime = null;
  }

  _tick(now) {
    this._raf = null;
    if (this._destroyed || this._mode === 'hidden' || this._effects === 'off' || this._document.hidden) return;
    const interval = 1 / (this._effects === 'low' ? 30 : 60);
    if (this._lastTime === null) this._lastTime = now - interval * 1000;
    const elapsed = (now - this._lastTime) / 1000;
    if (elapsed < interval - 0.001) { this._queue(); return; }
    this._lastTime = now;
    const dt = clamp(elapsed, 1 / 120, 0.05);
    const steps = Math.min(3, Math.ceil(dt * 60));
    for (let step = 0; step < steps; step++) this._step(dt / steps);
    if (this._mode === 'disperse' && this._modeTime >= 0.95) {
      this._finishDismiss();
      return;
    }
    this._draw();
    this._queue();
  }

  _step(dt) {
    this._time += dt;
    this._modeTime += dt;
    const center = this._center;
    const centerDrag = Math.exp(-8 * dt);
    center.vx = (center.vx + (this._target.x - center.x) * 65 * dt) * centerDrag;
    center.vy = (center.vy + (this._target.y - center.y) * 65 * dt) * centerDrag;
    center.x += center.vx * dt;
    center.y += center.vy * dt;
    const dispersing = this._mode === 'disperse';
    const maximumSpeed = dispersing ? 1_050 : this._modeTime < 1.6 ? 780 : 440;
    const neighborRadiusSquared = 82 * 82;

    // Read one consistent generation of positions and velocities before integrating.
    // At most 128² pairs, three bounded substeps, and no per-pair allocation.
    for (const boid of this._boids) {
      if (this._modeTime < boid.delay) continue;
      if (!dispersing) this._shapeTarget(boid);
      const dx = boid.tx - boid.x;
      const dy = boid.ty - boid.y;
      const distance = Math.hypot(dx, dy) || 1;
      const desiredSpeed = Math.min(maximumSpeed, distance * (dispersing ? 3 : 3.7));
      let ax = (dx / distance * desiredSpeed + (dispersing ? 0 : boid.flowX) - boid.vx) * 3.5;
      let ay = (dy / distance * desiredSpeed + (dispersing ? 0 : boid.flowY) - boid.vy) * 3.5;
      let separationX = 0, separationY = 0, alignX = 0, alignY = 0, cohesionX = 0, cohesionY = 0, neighbors = 0;
      const separation = this._mode === 'card' ? 18 : 22;
      for (const other of this._boids) {
        if (other === boid || this._modeTime < other.delay) continue;
        const sx = boid.x - other.x;
        const sy = boid.y - other.y;
        const squared = sx * sx + sy * sy;
        if (squared >= neighborRadiusSquared) continue;
        neighbors++;
        alignX += other.vx; alignY += other.vy;
        cohesionX += other.x; cohesionY += other.y;
        if (squared < separation * separation) {
          if (squared < 0.01) {
            // Deterministic opposite impulses also resolve coincident particles.
            const sign = boid.index < other.index ? -1 : 1;
            separationX += sign;
            separationY += sign * 0.37;
          } else {
            const length = Math.sqrt(squared);
            const pressure = (1 - length / separation) / length;
            separationX += sx * pressure;
            separationY += sy * pressure;
          }
        }
      }
      ax += separationX * 255;
      ay += separationY * 255;
      if (neighbors && !dispersing) {
        ax += (alignX / neighbors - boid.vx) * 0.85 + (cohesionX / neighbors - boid.x) * 0.17;
        ay += (alignY / neighbors - boid.vy) * 0.85 + (cohesionY / neighbors - boid.y) * 0.17;
      }
      const flutter = this._mode === 'idle' ? 10 : 5;
      ax += Math.cos(this._time * 1.6 + boid.phase) * flutter;
      ay += Math.sin(this._time * 1.9 + boid.phase) * flutter;
      const acceleration = Math.hypot(ax, ay);
      const forceLimit = dispersing ? 2_200 : 1_550;
      const scale = acceleration > forceLimit ? forceLimit / acceleration : 1;
      boid.ax = ax * scale / boid.mass;
      boid.ay = ay * scale / boid.mass;
    }

    for (const boid of this._boids) {
      if (this._modeTime < boid.delay) continue;
      const drag = Math.exp(-(dispersing ? 0.15 : 0.62) * dt);
      boid.vx = (boid.vx + boid.ax * dt) * drag;
      boid.vy = (boid.vy + boid.ay * dt) * drag;
      const speed = Math.hypot(boid.vx, boid.vy);
      if (speed > maximumSpeed) { boid.vx *= maximumSpeed / speed; boid.vy *= maximumSpeed / speed; }
      boid.x += boid.vx * dt;
      boid.y += boid.vy * dt;
      const direction = speed > 3 ? Math.atan2(boid.vy, boid.vx) : boid.phase + this._time * 0.15;
      const turn = Math.atan2(Math.sin(direction - boid.angle), Math.cos(direction - boid.angle));
      boid.angle += turn * (1 - Math.exp(-7 * dt));
      const alpha = dispersing ? Math.max(0, 1 - this._modeTime / 0.85) : this._mode === 'card' && boid.interior ? 0.18 : 1;
      boid.opacity += (alpha - boid.opacity) * (1 - Math.exp(-8 * dt));
    }
  }

  _shapeTarget(boid) {
    const slot = (boid.index + 0.5) / this._boids.length;
    const time = this._time;
    const phase = boid.phase;
    boid.flowX = boid.flowY = 0;
    if (this._mode === 'ring') {
      const radius = clamp(Math.min(this._width, this._height) * 0.1, 62, 105);
      const angle = slot * TAU + time * 0.23 * boid.orbitRate + Math.sin(time * 0.33 + phase) * 0.065;
      const orbit = radius + boid.lane * 13 + Math.sin(time * 0.9 + phase) * 3.5;
      boid.tx = this._center.x + Math.cos(angle) * orbit;
      boid.ty = this._center.y + Math.sin(angle) * orbit;
      boid.flowX = -Math.sin(angle) * orbit * 0.23;
      boid.flowY = Math.cos(angle) * orbit * 0.23;
    } else if (this._mode === 'card') {
      const bounds = this._bounds ?? {
        x: this._width / 2 - Math.min(500, this._width - 32) / 2,
        y: this._height / 2 - Math.min(340, this._height - 32) / 2,
        width: Math.max(1, Math.min(500, this._width - 32)),
        height: Math.max(1, Math.min(340, this._height - 32))
      };
      if (boid.interior) {
        boid.tx = bounds.x + bounds.width * (0.12 + boid.u * 0.76) + Math.sin(time * 0.3 + phase) * 3;
        boid.ty = bounds.y + bounds.height * (0.12 + boid.v * 0.76) + Math.cos(time * 0.3 + phase) * 3;
      } else {
        roundedPerimeter(bounds, slot + time * 0.006, boid);
        boid.tx += Math.cos(phase + time * 0.6) * 2.5;
        boid.ty += Math.sin(phase + time * 0.6) * 2.5;
      }
    } else {
      let x, y;
      if (slot < 0.68) {
        const side = slot < 0.34 ? -1 : 1;
        const u = (slot % 0.34) / 0.34;
        const flap = Math.sin(time * 1.1) * 6 + Math.sin(time * 0.43) * 3;
        x = side * (12 + u * 74);
        y = -8 - Math.sin(u * Math.PI) * 20 + u * 16 + flap * u;
      } else if (slot < 0.89) {
        const u = (slot - 0.68) / 0.21;
        x = boid.lane * 9;
        y = -22 + u * 47;
      } else {
        const u = (slot - 0.89) / 0.11;
        x = (u < 0.5 ? -1 : 1) * (7 + u * 14);
        y = 20 + u * 21;
      }
      boid.tx = this._center.x + x + Math.sin(time * 1.3 + phase) * 3;
      boid.ty = this._center.y + y + Math.cos(time * 1.7 + phase) * 3;
    }
  }

  _draw() {
    this._clear();
    const context = this._context;
    context.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    context.fillStyle = '#ffffff';
    context.strokeStyle = 'rgba(24, 29, 38, 0.18)';
    context.lineWidth = 0.45;
    context.shadowColor = 'rgba(12, 17, 26, 0.28)';
    context.shadowBlur = this._effects === 'high' ? 3 : 1.5;
    context.shadowOffsetY = 1;
    for (const boid of this._boids) {
      if (boid.opacity < 0.005 || boid.x < -40 || boid.x > this._width + 40 || boid.y < -40 || boid.y > this._height + 40) continue;
      context.save();
      context.translate(boid.x, boid.y);
      context.rotate(boid.angle + Math.sin(this._time * 2 + boid.phase) * 0.12);
      context.globalAlpha = boid.opacity * boid.whiteness;
      context.fill(boid.path);
      context.stroke(boid.path);
      context.restore();
    }
    context.globalAlpha = 1;
    context.shadowBlur = context.shadowOffsetY = 0;
  }

  _clear() {
    const context = this._context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _finishDismiss() {
    if (this._mode !== 'disperse') return;
    this._mode = 'hidden';
    this._stop();
    this._clear();
    this._onDismiss?.();
  }
}

function trianglePath(size) {
  const vertices = [
    { x: size * random(0.62, 0.76), y: size * random(-0.08, 0.04) },
    { x: size * random(-0.47, -0.35), y: size * random(-0.47, -0.35) },
    { x: size * random(-0.36, -0.22), y: size * random(0.44, 0.58) }
  ];
  const path = new Path2D();
  const rounding = 0.17;
  for (let index = 0; index < 3; index++) {
    const previous = vertices[(index + 2) % 3];
    const current = vertices[index];
    const next = vertices[(index + 1) % 3];
    const enterX = current.x + (previous.x - current.x) * rounding;
    const enterY = current.y + (previous.y - current.y) * rounding;
    const exitX = current.x + (next.x - current.x) * rounding;
    const exitY = current.y + (next.y - current.y) * rounding;
    if (index === 0) path.moveTo(enterX, enterY); else path.lineTo(enterX, enterY);
    path.quadraticCurveTo(current.x, current.y, exitX, exitY);
  }
  path.closePath();
  return path;
}

function roundedPerimeter(bounds, progress, target) {
  const radius = Math.min(24, bounds.width / 2, bounds.height / 2);
  const horizontal = Math.max(0, bounds.width - radius * 2);
  const vertical = Math.max(0, bounds.height - radius * 2);
  const arc = Math.PI * radius / 2;
  const perimeter = (horizontal + vertical) * 2 + arc * 4;
  let distance = ((progress % 1) + 1) % 1 * perimeter;
  const x = bounds.x, y = bounds.y, right = x + bounds.width, bottom = y + bounds.height;
  for (let edge = 0; edge < 4; edge++) {
    const straight = edge % 2 === 0 ? horizontal : vertical;
    if (distance <= straight) {
      if (edge === 0) { target.tx = x + radius + distance; target.ty = y; }
      else if (edge === 1) { target.tx = right; target.ty = y + radius + distance; }
      else if (edge === 2) { target.tx = right - radius - distance; target.ty = bottom; }
      else { target.tx = x; target.ty = bottom - radius - distance; }
      return;
    }
    distance -= straight;
    if (distance <= arc) {
      const angle = -Math.PI / 2 + edge * Math.PI / 2 + distance / radius;
      const centerX = edge < 2 ? right - radius : x + radius;
      const centerY = edge === 0 || edge === 3 ? y + radius : bottom - radius;
      target.tx = centerX + Math.cos(angle) * radius;
      target.ty = centerY + Math.sin(angle) * radius;
      return;
    }
    distance -= arc;
  }
  target.tx = x + radius;
  target.ty = y;
}
