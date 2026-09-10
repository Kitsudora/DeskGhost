'use strict';

// Deliberate double-circle detection, sampled by Electron without a global mouse
// hook. The suffix search and rolling history have hard bounds.
const MIN_CIRCLE_POINTS = 12;
const MAX_CIRCLE_POINTS = 256;
const CIRCLE_WINDOW_MS = 10000;

class CircleGestureRecognizer {
  constructor() { this.reset(); }
  reset() { this.points = []; this.lastMovement = 0; this.lastSample = null; this.cooldownUntil = 0; this.checks = 0; this.screenHeight = 0; }
  addPoint(x, y, screenHeight, now) {
    if (![x, y, screenHeight, now].every(Number.isFinite) || now < 0 || screenHeight < 200 || screenHeight > 100000 || Math.abs(x) > 10000000 || Math.abs(y) > 10000000) { this.reset(); return false; }
    if (this.lastSample !== null) {
      if (now < this.lastSample) this.reset();
      else if (now === this.lastSample) return false;
    }
    this.lastSample = now;
    if (now < this.cooldownUntil) return false;
    if (this.points.length && (now < this.lastMovement || now - this.lastMovement > 900 || Math.abs(screenHeight - this.screenHeight) > 1)) this.reset();
    this.screenHeight = screenHeight;
    const previous = this.points.at(-1);
    if (previous) {
      const distance = Math.hypot(x - previous.x, y - previous.y);
      if (distance < 2) return false;
      if (distance > screenHeight * 0.5) this.points = [];
    }
    this.lastMovement = now;
    this.points = this.points.filter(point => now - point.time <= CIRCLE_WINDOW_MS);
    if (this.points.length === MAX_CIRCLE_POINTS) this.points.shift();
    this.points.push({ x, y, time: now });
    // At 25 Hz a quick 0.5–1 second double circle has only 13–26 samples.
    // Check those short traces every sample; longer histories at most every 80 ms.
    if (this.points.length < MIN_CIRCLE_POINTS || (this.points.length >= 32 && ++this.checks < 2)) return false;
    this.checks = 0;
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    // Consider every suffix: a long approach must not hide a short valid gesture
    // between sparsely sampled start indices. Incremental bounds keep ordinary
    // straight movement cheap; at most 256 points and 245 candidate fits exist.
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
    const points = this.points, count = points.length - start;
    if (count < MIN_CIRCLE_POINTS || points.at(-1).time - points[start].time < 400) return false;
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
    if (diameter < screenHeight * 0.12 || diameter > screenHeight * 0.5 || width < height * 0.3 || width > height * 3.3) return false;
    // Count the path's turns rather than fitting every point to one ellipse.
    // Short, mostly non-overlapping chords smooth hand jitter on slow traces
    // without losing the sparse samples of a fast gesture. Corners, drifting
    // centers and changing radii are allowed; signed area and travel distinguish
    // loops from retracing.
    const span = Math.min(5, Math.max(1, Math.floor(count / 24)));
    const first = points[start];
    let firstAngle = null, lastAngle = null, signed = 0, absolute = 0, travel = 0, area = 0;
    for (let i = start + 1; i < points.length; i++) {
      const point = points[i], previous = points[i - 1];
      travel += Math.hypot(point.x - previous.x, point.y - previous.y);
      area += (previous.x - first.x) * (point.y - first.y) - (point.x - first.x) * (previous.y - first.y);
      if (i - start < span || ((i - start) % span !== 0 && i !== points.length - 1)) continue;
      const dx = point.x - points[i - span].x, dy = point.y - points[i - span].y;
      if (dx * dx + dy * dy < 16) continue;
      const angle = Math.atan2(dy, dx);
      if (lastAngle !== null) {
        const delta = Math.atan2(Math.sin(angle - lastAngle), Math.cos(angle - lastAngle));
        // A literal turnaround must not add half a turn to a partial circle.
        if (Math.abs(delta) > 2.8) return false;
        signed += delta; absolute += Math.abs(delta);
      }
      if (firstAngle === null) firstAngle = angle;
      lastAngle = angle;
    }
    const last = points.at(-1), closure = Math.hypot(last.x - first.x, last.y - first.y);
    if (closure < diameter * 0.22 && firstAngle !== null) {
      // Include the final corner of a nearly closed polygonal loop.
      const delta = Math.atan2(Math.sin(firstAngle - lastAngle), Math.cos(firstAngle - lastAngle));
      if (Math.abs(delta) > 2.8) return false;
      signed += delta; absolute += Math.abs(delta);
    }
    const turns = Math.abs(signed) / (Math.PI * 2);
    return turns >= 1.7 && turns <= 2.5 && absolute > 0 && Math.abs(signed) / absolute >= 0.48 &&
      travel >= diameter * 4 && Math.abs(area) >= travel * diameter * 0.22 && closure <= diameter * 1.1;
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

module.exports = { CircleGestureRecognizer, SpeedDismissRecognizer };
