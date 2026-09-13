'use strict';

// Deliberate double-circle detection, sampled by Electron without a global mouse
// hook. The suffix search and rolling history have hard bounds.
const MIN_CIRCLE_POINTS = 15;
// At 25 Hz the easiest 3.8 second window holds at most 96 ordinary samples.
// A little timer headroom stays bounded even if a caller samples faster.
const MAX_CIRCLE_POINTS = 104;
const DEFAULT_GESTURE_DIFFICULTY = 40;

function circleRules(difficulty) {
  const mix = (easy, strict) => easy + (strict - easy) * difficulty / 100;
  // Reserve the close ellipse fit for the strict end of the slider. A linear
  // interpolation still rejected ordinary tilted/unequal loops around Normal.
  const shapeMix = (easy, strict) => easy + (strict - easy) * (difficulty / 100) ** 2;
  return {
    window: mix(3800, 2200), pause: mix(620, 320),
    minDiameter: mix(.105, .2), maxDiameter: mix(.54, .34), aspect: shapeMix(.28, .72),
    minRadius: shapeMix(.2, .72), maxRadius: shapeMix(1.5, 1.18), heading: shapeMix(2.7, 1.3), angularStep: shapeMix(1.55, 1.1),
    minMeanRadius: shapeMix(.55, .9), maxMeanRadius: shapeMix(1.18, 1.06), error: shapeMix(.16, .011025),
    minTurns: mix(1.8, 1.9), direction: mix(.8, .94),
    minTravel: mix(4, 5.3), maxTravel: mix(9, 7.2), closure: mix(.62, .3)
  };
}

class CircleGestureRecognizer {
  constructor() { this.reset(); }
  reset() { this.points = []; this.lastMovement = 0; this.lastSample = null; this.cooldownUntil = 0; this.screenHeight = 0; this.difficulty = null; this.rules = null; }
  addPoint(x, y, screenHeight, now, difficulty = DEFAULT_GESTURE_DIFFICULTY) {
    if (![x, y, screenHeight, now].every(Number.isFinite) || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 100 || now < 0 || screenHeight < 200 || screenHeight > 100000 || Math.abs(x) > 10000000 || Math.abs(y) > 10000000) { this.reset(); return false; }
    if (this.difficulty !== difficulty) {
      // Never combine a partial trace measured under different rules. Preserve
      // the cooldown so moving a slider cannot retrigger the summon tail.
      const cooldownUntil = this.cooldownUntil;
      this.reset(); this.cooldownUntil = cooldownUntil;
      this.difficulty = difficulty; this.rules = circleRules(difficulty);
    }
    const rules = this.rules;
    if (this.lastSample !== null) {
      if (now < this.lastSample) this.reset();
      else if (now === this.lastSample) return false;
    }
    this.lastSample = now;
    if (now < this.cooldownUntil) return false;
    if (this.points.length && (now < this.lastMovement || now - this.lastMovement > rules.pause || Math.abs(screenHeight - this.screenHeight) > 1)) this.reset();
    this.difficulty = difficulty; this.rules = rules; this.lastSample = now;
    this.screenHeight = screenHeight;
    const previous = this.points.at(-1);
    if (previous) {
      const distance = Math.hypot(x - previous.x, y - previous.y);
      if (distance < 2) return false;
      if (distance > screenHeight * 0.5) this.points = [];
    }
    this.lastMovement = now;
    this.points = this.points.filter(point => now - point.time <= rules.window);
    if (this.points.length === MAX_CIRCLE_POINTS) this.points.shift();
    this.points.push({ x, y, time: now });
    // The production 25 Hz sampler supplies 15–96 points in the allowed window.
    // A few spare slots tolerate timer jitter; every moving sample is checked so
    // stopping at the end of the second circle does not miss the gesture.
    if (this.points.length < MIN_CIRCLE_POINTS) return false;
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    // Consider every suffix: a long approach must not hide a short valid gesture
    // between sparsely sampled start indices. Incremental bounds keep ordinary
    // straight movement cheap; at most 104 points and 90 candidate fits exist.
    for (let start = this.points.length - 1; start >= 0; start--) {
      const point = this.points[start];
      bounds.minX = Math.min(bounds.minX, point.x); bounds.maxX = Math.max(bounds.maxX, point.x);
      bounds.minY = Math.min(bounds.minY, point.y); bounds.maxY = Math.max(bounds.maxY, point.y);
      if (this.points.length - start < MIN_CIRCLE_POINTS) continue;
      if (this.isDoubleCircle(start, screenHeight, bounds)) {
        this.reset(); this.lastSample = now; this.cooldownUntil = now + 2000; return true;
      }
    }
    return false;
  }
  isDoubleCircle(start, screenHeight, bounds) {
    const points = this.points, count = points.length - start, rules = this.rules;
    const duration = points.at(-1).time - points[start].time;
    if (count < MIN_CIRCLE_POINTS || duration < 560 || duration > rules.window) return false;
    if (!bounds) {
      bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (let i = start; i < points.length; i++) {
        const p = points[i];
        bounds.minX = Math.min(bounds.minX, p.x); bounds.maxX = Math.max(bounds.maxX, p.x);
        bounds.minY = Math.min(bounds.minY, p.y); bounds.maxY = Math.max(bounds.maxY, p.y);
      }
    }
    const { minX, minY, maxX, maxY } = bounds;
    const width = maxX - minX, height = maxY - minY, diameter = (width + height) / 2;
    if (diameter < screenHeight * rules.minDiameter || diameter > screenHeight * rules.maxDiameter || width < height * rules.aspect || height < width * rules.aspect) return false;
    // Measure winding around the trace's bounds. Easy/Normal deliberately allow
    // tilted ovals, corners, modest drift and unequal turns: fitting every point
    // to the same ellipse made those natural gestures fail before winding was
    // considered. Strict retains the close ellipse fit. All settings still need
    // two predominantly same-direction turns, screen-relative size and closure.
    const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
    const first = points[start];
    let lastAngle = null, lastHeading = null, signed = 0, absolute = 0, travel = 0, radiusSum = 0, squaredError = 0;
    for (let i = start; i < points.length; i++) {
      const point = points[i], nx = (point.x - centerX) * 2 / width, ny = (point.y - centerY) * 2 / height;
      const radius = Math.hypot(nx, ny);
      if (radius < rules.minRadius || radius > rules.maxRadius) return false;
      radiusSum += radius; squaredError += (radius - 1) ** 2;
      const angle = Math.atan2(ny, nx);
      if (lastAngle !== null) {
        const delta = Math.atan2(Math.sin(angle - lastAngle), Math.cos(angle - lastAngle));
        if (Math.abs(delta) > rules.angularStep) return false;
        signed += delta; absolute += Math.abs(delta);
        const previous = points[i - 1], dx = point.x - previous.x, dy = point.y - previous.y;
        travel += Math.hypot(dx, dy);
        const heading = Math.atan2(dy / height, dx / width);
        if (lastHeading !== null && Math.abs(Math.atan2(Math.sin(heading - lastHeading), Math.cos(heading - lastHeading))) > rules.heading) return false;
        lastHeading = heading;
      }
      lastAngle = angle;
    }
    const last = points.at(-1), closure = Math.hypot(last.x - first.x, last.y - first.y);
    const turns = Math.abs(signed) / (Math.PI * 2);
    return turns >= rules.minTurns && turns <= 2.1 && absolute > 0 && Math.abs(signed) / absolute >= rules.direction &&
      radiusSum / count >= rules.minMeanRadius && radiusSum / count <= rules.maxMeanRadius && squaredError / count <= rules.error &&
      travel >= diameter * rules.minTravel && travel <= diameter * rules.maxTravel && closure <= diameter * rules.closure;
  }
}

class SpeedDismissRecognizer {
  constructor() { this.reset(); }
  reset(now = null) {
    this.previous = null; this.fastSamples = 0;
    this.armedAt = Number.isFinite(now) && now >= 0 ? now + 400 : null;
  }
  addPoint(x, y, screenHeight, now, threshold = 1.5) {
    if (![x, y, screenHeight, now, threshold].every(Number.isFinite) || threshold < 0.5 || threshold > 4 || now < 0 || screenHeight < 200 || screenHeight > 100000 || Math.abs(x) > 10000000 || Math.abs(y) > 10000000) { this.reset(); return false; }
    if (this.previous && now < this.previous.time) this.reset(now);
    if (this.previous && this.previous.threshold !== threshold) {
      // A changed setting starts a new pair of measured intervals. Keep the
      // existing arming time, but never reuse a fast sample from the old rule.
      this.previous = null; this.fastSamples = 0;
    }
    if (this.previous && now === this.previous.time) return false;
    if (this.armedAt === null) this.armedAt = now + 400;
    const previous = this.previous;
    // Consume stationary samples too, so pausing breaks a run of fast motion.
    this.previous = { x, y, screenHeight, time: now, threshold };
    const elapsed = previous ? now - previous.time : 0;
    if (!previous || previous.time < this.armedAt || elapsed < 16 || elapsed > 120 || Math.abs(screenHeight - previous.screenHeight) > 1) {
      this.fastSamples = 0; return false;
    }
    // Electron reports both cursor coordinates and display bounds in DIP.
    // Heights per second therefore gives the same rule at every position and
    // display scale: the default 1.5 heights/s is 1620 DIP/s on a 1080-DIP-tall display.
    const speed = Math.hypot(x - previous.x, y - previous.y) * 1000 / (elapsed * screenHeight);
    this.fastSamples = speed >= threshold ? this.fastSamples + 1 : 0;
    // Two consecutive fast samples reject isolated pointer warps. At the host's
    // 25 Hz this takes 80 ms; the 400 ms arming delay ignores the summon tail.
    if (this.fastSamples < 2) return false;
    this.reset(now);
    return true;
  }
}

module.exports = { CircleGestureRecognizer, SpeedDismissRecognizer, DEFAULT_GESTURE_DIFFICULTY };
