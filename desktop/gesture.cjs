'use strict';

// Deliberate double-circle detection, sampled by Electron without a global mouse
// hook. The suffix search and rolling history have hard bounds.
class CircleGestureRecognizer {
  constructor() { this.reset(); }
  reset() { this.points = []; this.lastMovement = 0; this.cooldownUntil = 0; this.checks = 0; this.screenHeight = 0; }
  addPoint(x, y, screenHeight, now) {
    if (![x, y, screenHeight, now].every(Number.isFinite) || screenHeight < 200) { this.reset(); return false; }
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
    this.points = this.points.filter(point => now - point.time <= 6000);
    if (this.points.length === 224) this.points.shift();
    this.points.push({ x, y, time: now });
    if (this.points.length < 32 || ++this.checks < 3) return false;
    this.checks = 0;
    for (let candidate = 0; candidate < 12; candidate++) {
      if (this.isDoubleCircle(Math.floor(candidate * this.points.length / 16), screenHeight)) {
        this.reset(); this.cooldownUntil = now + 2000; return true;
      }
    }
    return false;
  }
  isDoubleCircle(start, screenHeight) {
    const points = this.points.slice(start);
    if (points.length < 32 || points.at(-1).time - points[0].time < 500) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const width = maxX - minX, height = maxY - minY, diameter = (width + height) / 2;
    if (diameter < screenHeight * 0.14 || diameter > screenHeight * 0.42 || width < height * 0.6 || width > height * 1.67) return false;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, radius = diameter / 2;
    let lastAngle = null, signed = 0, absolute = 0, radialError = 0;
    for (const point of points) {
      const radial = Math.hypot(point.x - cx, point.y - cy);
      if (radial < radius * 0.48 || radial > radius * 1.55) return false;
      radialError += (radial / radius - 1) ** 2;
      const angle = Math.atan2(point.y - cy, point.x - cx);
      if (lastAngle !== null) {
        const delta = Math.atan2(Math.sin(angle - lastAngle), Math.cos(angle - lastAngle));
        if (Math.abs(delta) > 0.85) return false;
        signed += delta; absolute += Math.abs(delta);
      }
      lastAngle = angle;
    }
    const turns = Math.abs(signed) / (Math.PI * 2);
    return turns >= 1.85 && turns <= 2.4 && absolute > 0 && Math.abs(signed) / absolute >= 0.88 && radialError / points.length < 0.075;
  }
}

class ShakeGestureRecognizer {
  constructor() { this.points = []; }
  reset() { this.points = []; }
  addPoint(x, y, now) {
    this.points = this.points.filter(p => now - p.time < 650);
    if (this.points.length === 24) this.points.shift();
    this.points.push({ x, y, time: now });
    if (this.points.length < 5) return false;
    let direction = 0, reversals = 0, travel = 0;
    for (let i = 1; i < this.points.length; i++) {
      const dx = this.points[i].x - this.points[i - 1].x;
      if (Math.abs(dx) < 9) continue;
      const sign = Math.sign(dx);
      if (direction && sign !== direction) reversals++;
      direction = sign; travel += Math.abs(dx);
    }
    const ys = this.points.map(p => p.y);
    return reversals >= 3 && travel > 350 && Math.max(...ys) - Math.min(...ys) < 130;
  }
}

module.exports = { CircleGestureRecognizer, ShakeGestureRecognizer };
