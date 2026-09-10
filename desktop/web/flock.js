const TAU = Math.PI * 2;
const MAX_BOIDS = 128;
const MAX_CANVAS_PIXELS = 6_000_000;
const MAX_CANVAS_DIMENSION = 16_384;
const MODES = new Set(['hidden', 'idle', 'roaming', 'ring', 'card', 'disperse']);
const EFFECTS = new Set(['off', 'low', 'high']);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = value => value * value * (3 - 2 * value);
const random = (min, max) => min + Math.random() * (max - min);
const finite = value => typeof value === 'number' && Number.isFinite(value);

/**
 * A transparent Canvas2D flock, using CSS viewport coordinates. Shape providers
 * assign destinations; one arrival/separation/alignment/cohesion controller flies
 * every particle there. Input readiness never waits for the simulation.
 *
 * hidden parks particles outside the viewport and stops RAF. idle remains a
 * compatibility alias for hidden. The application decides when to start roaming.
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
    this._cursorTravel = 0;
    this._cursorSpeed = 0;
    this._tracking = 0;
    this._bounds = null;
    this._spawnPhase = random(0, TAU);
    this._disperseCenter = null;
    this._width = 1;
    this._height = 1;
    this._offset = { x: 0, y: 0 };
    this._tick = this._tick.bind(this);
    this._onResize = () => this.resize();
    this._onVisibility = () => {
      if (this._document.hidden) {
        this._stop();
        if (this._mode === 'disperse') this._finishDismiss();
      } else this._queue();
    };
    this._window.addEventListener('resize', this._onResize);
    this._document.addEventListener('visibilitychange', this._onVisibility);
    this.resize();
  }

  setMode(mode, { point, bounds } = {}) {
    if (this._destroyed) return this;
    if (!MODES.has(mode)) throw new RangeError('Unknown flock mode: ' + mode);
    if (mode === 'idle') mode = 'hidden';
    if (point) this.setTarget(point);
    if (bounds) this._setBounds(bounds);
    if (mode === this._mode) return this;
    const previous = this._mode;
    if (mode === 'disperse') {
      this._disperseCenter = finite(point?.x) && finite(point?.y)
        ? { ...this._target } : this._motionCenter(previous);
    }
    this._mode = mode;
    this._modeTime = 0;
    if (mode === 'hidden') {
      this._park();
      return this;
    }
    if (mode === 'disperse') {
      if (this._effects === 'off' || previous === 'hidden' || this._document.hidden || !this._boids.length) {
        this._finishDismiss();
        return this;
      }
      for (const boid of this._boids) this._exitDestination(boid);
    } else if (this._effects !== 'off') {
      if (previous === 'hidden' || previous === 'disperse') this._spawnPhase = random(0, TAU);
      this._ensureBoids();
      if (previous === 'hidden' || previous === 'disperse') {
        for (const boid of this._boids) this._spawn(boid);
      } else {
        for (const boid of this._boids) {
          boid.delay = 0; boid.departed = false;
          boid.arrivalWeight = mode === 'ring' || mode === 'card' ? 1 : 0;
          boid.arrivalAge = 0;
        }
      }
      if (mode === 'roaming') for (const boid of this._boids) this._roamingDestination(boid, true);
      if (mode === 'ring') for (const boid of this._boids) this._ringDestination(boid, true);
    }
    this._queue();
    if (mode === 'ring' || mode === 'card') this._onReady?.({ mode });
    return this;
  }

  setTarget(point) {
    if (this._destroyed || !finite(point?.x) || !finite(point?.y)) return this;
    this._hasTarget = true;
    const x = clamp(point.x - this._offset.x, -512, this._width + 512);
    const y = clamp(point.y - this._offset.y, -512, this._height + 512);
    this._cursorTravel = Math.min(2000, this._cursorTravel + Math.hypot(x - this._target.x, y - this._target.y));
    this._target.x = x;
    this._target.y = y;
    return this;
  }

  setEffects(effects) {
    if (this._destroyed) return this;
    if (!EFFECTS.has(effects)) throw new RangeError('Unknown flock effects: ' + effects);
    if (effects === this._effects) return this;
    const wasOff = this._effects === 'off';
    this._effects = effects;
    this._stop();
    if (effects === 'off') {
      this._park();
      if (this._mode === 'disperse') this._finishDismiss();
    } else if (this._mode !== 'hidden') {
      if (wasOff) this._spawnPhase = random(0, TAU);
      this._ensureBoids();
      if (wasOff) for (const boid of this._boids) this._spawn(boid);
      if (this._mode === 'roaming') for (const boid of this._boids) this._roamingDestination(boid, true);
      if (this._mode === 'ring') for (const boid of this._boids) this._ringDestination(boid, true);
      if (this._mode === 'disperse') for (const boid of this._boids) this._exitDestination(boid);
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
    const ratio = finite(this._window.devicePixelRatio) ? this._window.devicePixelRatio : 1;
    this._dpr = Math.min(clamp(ratio, 0.25, 2),
      Math.sqrt(MAX_CANVAS_PIXELS / (this._width * this._height)),
      MAX_CANVAS_DIMENSION / Math.max(this._width, this._height));
    this.canvas.width = Math.max(1, Math.floor(this._width * this._dpr));
    this.canvas.height = Math.max(1, Math.floor(this._height * this._dpr));
    if (!this._hasTarget) {
      this._target.x = this._width / 2;
      this._target.y = this._height / 2;
    }
    this._lastTime = null;
    if (this._mode === 'hidden' || this._effects === 'off') this._park();
    else {
      if (this._mode === 'roaming') for (const boid of this._boids) this._roamingDestination(boid);
      if (!this._document.hidden) this._draw();
    }
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
    this.canvas.width = this.canvas.height = 1;
  }

  _setBounds(bounds) {
    const x = bounds.x ?? bounds.left, y = bounds.y ?? bounds.top;
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
      const index = this._boids.length, size = random(9, 13.5);
      const boid = {
        index, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, tx: 0, ty: 0,
        angle: random(-Math.PI, Math.PI), phase: random(0, TAU),
        mass: random(0.82, 1.18), pace: random(0.88, 1.08), size,
        ringX: 0, ringY: 0, ringGoalX: 0, ringGoalY: 0,
        ringVX: 0, ringVY: 0, ringAt: 0, ringInitialized: false,
        arrivalWeight: 0, arrivalAge: 0,
        u: Math.random(), v: Math.random(), opacity: 0, delay: 0,
        whiteness: random(0.82, 1), interior: index % 6 === 0,
        wanderAngle: random(0, TAU), wanderTurn: random(-0.8, 0.8),
        roamAt: 0, departed: false, path: trianglePath(size)
      };
      this._spawn(boid);
      this._boids.push(boid);
    }
  }

  _motionCenter(mode = this._mode) {
    if (mode === 'ring') return { ...this._target };
    if (mode === 'card' && this._bounds)
      return { x: this._bounds.x + this._bounds.width / 2, y: this._bounds.y + this._bounds.height / 2 };
    if (mode === 'disperse' && this._disperseCenter) return { ...this._disperseCenter };
    return { x: this._width / 2, y: this._height / 2 };
  }

  _coverRadius(center) {
    return Math.hypot(Math.max(Math.abs(center.x), Math.abs(this._width - center.x)),
      Math.max(Math.abs(center.y), Math.abs(this._height - center.y)));
  }

  _placeOutside(boid) {
    const center = this._motionCenter();
    const count = Math.min(MAX_BOIDS, this._effects === 'low' ? 42 : 72);
    // Stratified angles avoid empty sectors; jitter and a new phase per summon
    // keep entry organic. The entire circle lies beyond all viewport corners.
    const angle = this._spawnPhase + (boid.index + random(0.08, 0.92)) / count * TAU;
    const radius = this._coverRadius(center) + random(45, 110);
    boid.x = center.x + Math.cos(angle) * radius;
    boid.y = center.y + Math.sin(angle) * radius;
  }

  _spawn(boid) {
    this._placeOutside(boid);
    boid.opacity = 0;
    boid.departed = false;
    boid.ringInitialized = false;
    boid.arrivalWeight = this._mode === 'ring' || this._mode === 'card' ? 1 : 0;
    boid.arrivalAge = 0;
    boid.delay = this._modeTime + (this._mode === 'roaming' ? random(0, 3.5) : random(0, 0.09));
    // Initial drift is individual and directionless. Destinations, rather than a
    // launch impulse or a shared path, are what bring the fragments onto screen.
    const angle = random(0, TAU), speed = random(3, 12);
    boid.vx = Math.cos(angle) * speed; boid.vy = Math.sin(angle) * speed;
    boid.ax = boid.ay = 0;
  }

  _park() {
    this._stop();
    this._cursorTravel = this._cursorSpeed = this._tracking = 0;
    for (const boid of this._boids) {
      this._placeOutside(boid);
      boid.tx = boid.x; boid.ty = boid.y;
      boid.vx = boid.vy = boid.ax = boid.ay = boid.opacity = 0;
      boid.departed = true;
    }
    this._clear();
  }

  _outside(boid) {
    const margin = boid.size + 8;
    return boid.x < -margin || boid.x > this._width + margin ||
      boid.y < -margin || boid.y > this._height + margin;
  }

  _exitDestination(boid) {
    boid.delay = 0;
    boid.departed = this._outside(boid);
    const center = this._motionCenter('disperse');
    const dx = boid.x - center.x, dy = boid.y - center.y, distance = Math.hypot(dx, dy);
    const angle = distance > 0.001 ? Math.atan2(dy, dx) : boid.phase;
    const radius = Math.max(this._coverRadius(center), distance) + random(85, 150);
    boid.tx = center.x + Math.cos(angle) * radius;
    boid.ty = center.y + Math.sin(angle) * radius;
  }

  _roamingDestination(boid, entering = false) {
    const inset = Math.min(60, this._width / 4, this._height / 4);
    if (entering) {
      const side = boid.index % 4;
      boid.tx = side === 0 ? random(inset, this._width * 0.35) :
        side === 1 ? random(this._width * 0.65, this._width - inset) : random(inset, this._width - inset);
      boid.ty = side === 2 ? random(inset, this._height * 0.35) :
        side === 3 ? random(this._height * 0.65, this._height - inset) : random(inset, this._height - inset);
    } else {
      const angle = boid.wanderAngle + random(-1.1, 1.1), distance = random(130, 360);
      boid.tx = clamp(boid.x + Math.cos(angle) * distance, inset, this._width - inset);
      boid.ty = clamp(boid.y + Math.sin(angle) * distance, inset, this._height - inset);
    }
    boid.roamAt = this._time + random(6, 13);
  }

  _ringDestination(boid, entering = false) {
    const dx = boid.x - this._target.x, dy = boid.y - this._target.y;
    // Each decision starts at the particle's actual location, never an assigned
    // angle or a shared clock. Short trips may go either way, with a small
    // clockwise bias and occasional crossings through the rest of the flock.
    const local = !entering && dx * dx + dy * dy < 260 * 260 && Math.random() > 0.12;
    const angle = entering ? Math.atan2(dy, dx) + random(-0.42, 0.42)
      : local ? Math.atan2(dy, dx) + random(-0.95, 1.45) : random(0, TAU);
    const radius = random(60, 180);
    boid.ringGoalX = Math.cos(angle) * radius;
    boid.ringGoalY = Math.sin(angle) * radius;
    if (!boid.ringInitialized) {
      boid.ringX = boid.ringGoalX; boid.ringY = boid.ringGoalY;
      boid.ringVX = boid.ringVY = 0;
      boid.ringInitialized = true;
    }
    boid.ringAt = this._time + random(0.6, 1.5);
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
    if (this._mode === 'disperse' && (this._boids.every(boid => boid.departed) || this._modeTime >= 3.2)) {
      this._finishDismiss();
      return;
    }
    this._draw();
    this._queue();
  }

  _updateDestinations(dt) {
    const time = this._time;
    const localResponse = 8, localDecay = Math.exp(-localResponse * dt);
    const bounds = this._bounds ?? {
      x: this._width / 2 - Math.min(500, this._width - 32) / 2,
      y: this._height / 2 - Math.min(340, this._height - 32) / 2,
      width: Math.max(1, Math.min(500, this._width - 32)),
      height: Math.max(1, Math.min(340, this._height - 32))
    };
    for (const boid of this._boids) {
      if (this._mode === 'ring') {
        if (time >= boid.ringAt && boid.arrivalWeight < 0.3) this._ringDestination(boid);
        // A critically damped local goal preserves its position and velocity
        // when a new trip is chosen. Only this independent offset is eased;
        // the cursor itself remains the current, unfiltered destination center.
        const offsetX = boid.ringX - boid.ringGoalX, offsetY = boid.ringY - boid.ringGoalY;
        const changeX = (boid.ringVX + localResponse * offsetX) * dt;
        const changeY = (boid.ringVY + localResponse * offsetY) * dt;
        boid.ringX = boid.ringGoalX + (offsetX + changeX) * localDecay;
        boid.ringY = boid.ringGoalY + (offsetY + changeY) * localDecay;
        boid.ringVX = (boid.ringVX - localResponse * changeX) * localDecay;
        boid.ringVY = (boid.ringVY - localResponse * changeY) * localDecay;
        // Local goals follow the current cursor directly; inertia remains in
        // the boids' steering, without a second delayed flock center.
        boid.tx = this._target.x + boid.ringX;
        boid.ty = this._target.y + boid.ringY;
      } else if (this._mode === 'card') {
        const slot = (boid.index + 0.5) / this._boids.length;
        if (boid.interior) {
          boid.tx = bounds.x + bounds.width * (0.12 + boid.u * 0.76);
          boid.ty = bounds.y + bounds.height * (0.12 + boid.v * 0.76);
        } else roundedPerimeter(bounds, slot, boid);
      } else if (this._mode === 'roaming' &&
        (time >= boid.roamAt || Math.hypot(boid.tx - boid.x, boid.ty - boid.y) < 35)) {
        this._roamingDestination(boid);
      }
    }
  }

  _step(dt) {
    this._time += dt;
    this._modeTime += dt;
    // Cursor activity changes a scalar steering weight continuously; it never
    // introduces a second moving center or a timer that abruptly switches gains.
    this._cursorSpeed = this._cursorSpeed * Math.exp(-10 * dt) + this._cursorTravel * 10;
    this._cursorTravel = 0;
    const activity = this._cursorSpeed / (this._cursorSpeed + 160);
    this._tracking += (activity - this._tracking) * (1 - Math.exp(-10 * dt));
    this._updateDestinations(dt);
    const roaming = this._mode === 'roaming', dispersing = this._mode === 'disperse', ring = this._mode === 'ring';
    const maximumSpeed = roaming ? 82 : dispersing ? 2600 : clamp(Math.hypot(this._width, this._height), 1850, 2600);
    const arrival = roaming ? 0.9 : 7.5;
    const response = roaming ? 2.2 : 10;
    const forceLimit = roaming ? 180 : ring ? 3200 : 11_000;
    const separation = this._mode === 'card' ? 18 : ring ? 28 : 22;
    const neighborRadiusSquared = 85 * 85;

    // Compute forces from one consistent generation, then integrate every boid.
    // There are at most 128² neighbor pairs and three substeps per rendered frame.
    for (const boid of this._boids) {
      if (this._modeTime < boid.delay || boid.departed) continue;
      const dx = boid.tx - boid.x, dy = boid.ty - boid.y;
      const distance = Math.hypot(dx, dy);
      const centerX = boid.x - this._target.x, centerY = boid.y - this._target.y;
      const centerDistance = ring ? Math.hypot(centerX, centerY) : 0;
      const speed = Math.hypot(boid.vx, boid.vy), speedLimit = maximumSpeed * boid.pace;
      if (ring || this._mode === 'card') {
        boid.arrivalAge += dt;
        if ((distance < 90 && speed < 220) || boid.arrivalAge > 3.2)
          boid.arrivalWeight *= Math.exp(-2.2 * dt);
      }
      const arriving = ring || this._mode === 'card' ? boid.arrivalWeight : 0;
      const distant = ring ? smoothstep(clamp((centerDistance - 140) / 260, 0, 1)) : 1;
      const catchUp = ring ? 1 - (1 - this._tracking) * (1 - distant) : 1;
      const braking = ring ? smoothstep(clamp((speed - 120) / 650, 0, 1)) : 0;
      // Nearby motion is governed mostly by neighbors and independent local
      // trips. A moving or distant cursor restores fast arrival; keep braking
      // strong until the incoming velocity has fallen to local flock speed.
      let goalArrival = ring ? 1.3 + (arrival - 1.3) * catchUp : arrival;
      let goalResponse = ring ? 2.6 + (response - 2.6) * Math.max(catchUp, braking) : response;
      // New arrivals use a damped controller and begin braking before they can
      // overshoot their local destination. It fades per particle on arrival,
      // leaving the established mouse-following flock free to wander again.
      goalArrival += (Math.min(goalArrival, 3.2) - goalArrival) * arriving;
      goalResponse += (Math.max(goalResponse, 16) - goalResponse) * arriving;
      const desired = speedLimit * Math.tanh(distance * goalArrival / speedLimit);
      const stoppingSpeed = Math.sqrt(2800 / boid.mass * Math.max(0, distance - speed * 0.14));
      const desiredSpeed = desired + (Math.min(desired, stoppingSpeed) - desired) * arriving;
      const seek = distance > 0.001 ? desiredSpeed / distance : 0;
      let ax = (dx * seek - boid.vx) * goalResponse;
      let ay = (dy * seek - boid.vy) * goalResponse;
      let separationX = 0, separationY = 0, alignX = 0, alignY = 0, cohesionX = 0, cohesionY = 0, neighbors = 0;
      for (const other of this._boids) {
        if (other === boid || this._modeTime < other.delay || other.departed) continue;
        const sx = boid.x - other.x, sy = boid.y - other.y, squared = sx * sx + sy * sy;
        if (squared >= neighborRadiusSquared) continue;
        neighbors++;
        alignX += other.vx; alignY += other.vy;
        cohesionX += other.x; cohesionY += other.y;
        if (squared < separation * separation) {
          if (squared < 0.01) {
            const sign = boid.index < other.index ? -1 : 1;
            separationX += sign; separationY += sign * 0.37;
          } else {
            const length = Math.sqrt(squared), pressure = (1 - length / separation) / length;
            separationX += sx * pressure; separationY += sy * pressure;
          }
        }
      }
      const avoidance = roaming ? 230 : ring ? 800 : 620;
      ax += separationX * avoidance; ay += separationY * avoidance;
      if (neighbors) {
        const alignment = ring ? 2.3 : 1.4, cohesion = ring ? 0.8 : 0.5;
        ax += (alignX / neighbors - boid.vx) * alignment + (cohesionX / neighbors - boid.x) * cohesion;
        ay += (alignY / neighbors - boid.vy) * alignment + (cohesionY / neighbors - boid.y) * cohesion;
      }
      if (ring && centerDistance < 55) {
        // Keep a loose clearing at the cursor without pinning particles to a
        // radius; inertia and a minority of crossing trips can pass through it.
        const angle = centerDistance > 0.001 ? Math.atan2(centerY, centerX) : boid.phase;
        const pressure = (55 - centerDistance) * 9;
        ax += Math.cos(angle) * pressure; ay += Math.sin(angle) * pressure;
      }
      // A bounded, independent wandering heading adds small autonomous decisions,
      // not a shared sinusoidal translation of the assembled shape.
      boid.wanderTurn = clamp((boid.wanderTurn + random(-2, 2) * dt) * Math.exp(-0.6 * dt), -1.4, 1.4);
      boid.wanderAngle += boid.wanderTurn * dt;
      const wander = roaming ? 35 : ring ? 80 : 50;
      ax += Math.cos(boid.wanderAngle) * wander; ay += Math.sin(boid.wanderAngle) * wander;
      // Approach the speed limit through a force, never by replacing the
      // integrated velocity vector. This also preserves inertia on mode changes.
      if (speed > 0.001) {
        const resistance = Math.max(0, speed - speedLimit * 0.9) * 8 / speed;
        ax -= boid.vx * resistance; ay -= boid.vy * resistance;
      }
      const acceleration = Math.hypot(ax, ay), scale = acceleration > forceLimit ? forceLimit / acceleration : 1;
      const nextAX = ax * scale / boid.mass, nextAY = ay * scale / boid.mass;
      if (ring) {
        const changeX = nextAX - boid.ax, changeY = nextAY - boid.ay;
        const change = Math.hypot(changeX, changeY), allowance = 18000 * dt / boid.mass;
        const blend = change > allowance ? allowance / change : 1;
        boid.ax += changeX * blend; boid.ay += changeY * blend;
      } else {
        boid.ax = nextAX; boid.ay = nextAY;
      }
    }
    for (const boid of this._boids) {
      if (this._modeTime < boid.delay || boid.departed) continue;
      const drag = Math.exp(-0.18 * dt);
      boid.vx = (boid.vx + boid.ax * dt) * drag; boid.vy = (boid.vy + boid.ay * dt) * drag;
      const speed = Math.hypot(boid.vx, boid.vy);
      boid.x += boid.vx * dt; boid.y += boid.vy * dt;
      if (dispersing && this._outside(boid)) {
        boid.departed = true; boid.opacity = 0; boid.vx = boid.vy = 0;
        continue;
      }
      if (speed > 1) {
        const direction = Math.atan2(boid.vy, boid.vx);
        const turn = Math.atan2(Math.sin(direction - boid.angle), Math.cos(direction - boid.angle));
        boid.angle += turn * (1 - Math.exp(-11 * dt));
      }
      const alpha = this._mode === 'card' && boid.interior ? 0.18 : 1;
      boid.opacity += (alpha - boid.opacity) * (1 - Math.exp(-(roaming ? 2 : 12) * dt));
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
      if (boid.opacity < 0.005 || this._outside(boid)) continue;
      context.save();
      context.translate(boid.x, boid.y);
      context.rotate(boid.angle);
      context.globalAlpha = boid.opacity * boid.whiteness;
      context.fill(boid.path);
      context.stroke(boid.path);
      context.restore();
    }
    context.globalAlpha = 1;
    context.shadowBlur = context.shadowOffsetY = 0;
  }

  _clear() {
    this._context.setTransform(1, 0, 0, 1, 0, 0);
    this._context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _finishDismiss() {
    if (this._mode !== 'disperse') return;
    this._mode = 'hidden';
    this._park();
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
