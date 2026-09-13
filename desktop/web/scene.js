const translate = y => `translate3d(0, ${y}px, 0)`;

/** One rigid panel: a deliberate pull, a free ring above the hook, then its weight
 * settling onto the hook. The ring travels with the panel; both hook faces stay
 * fixed. Only translation is animated, including interrupted movements. */
export class SceneMotion {
  constructor(scene, hook, { onLayout = () => {}, onSettled = () => {} } = {}) {
    this.scene = scene;
    this.hook = hook;
    this.onLayout = onLayout;
    this.onSettled = onSettled;
    this.open = false;
    this.animation = null;
    this.frame = 0;
    this.resizeFrame = 0;
    this.resolve = null;
    this.disposed = false;
    this.frontHook = document.createElement('div');
    this.frontHook.id = 'scene-hook-front';
    this.frontHook.setAttribute('aria-hidden', 'true');
    hook.after(this.frontHook);
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.handleEffects = () => this.refreshEffects();
    this.handleVisibility = () => { if (document.hidden) this.finish(); };
    this.handleResize = () => {
      if (this.resizeFrame) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = 0;
        if (this.animation) {
          const y = this.currentY();
          this.cancelAnimation();
          this.start(y);
        } else { this.settle(false); this.onLayout(); }
      });
    };
    this.reduced.addEventListener('change', this.handleEffects);
    document.addEventListener('visibilitychange', this.handleVisibility);
    window.addEventListener('resize', this.handleResize);
    this.settle(false);
  }

  get hiddenY() { return window.innerHeight + 80; }
  get instant() { return document.hidden || this.reduced.matches || document.documentElement.dataset.effects === 'off'; }

  currentY() {
    const transform = getComputedStyle(this.scene).transform;
    return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
  }

  setOpen(value, { immediate = false } = {}) {
    if (this.disposed) return Promise.resolve(false);
    const next = Boolean(value);
    if (next === this.open) {
      if (immediate || this.instant) this.finish();
      return this.pending ?? Promise.resolve(true);
    }
    const from = this.currentY();
    this.cancelAnimation();
    this.open = next;
    this.scene.dataset.open = String(next);
    this.scene.inert = !next;
    if (immediate || this.instant) { this.settle(); return Promise.resolve(true); }
    return this.start(from);
  }

  start(from) {
    const distance = Math.abs((this.open ? 0 : this.hiddenY) - from);
    if (distance < .5 || this.instant) { this.settle(); return Promise.resolve(true); }
    const fraction = Math.min(1, distance / this.hiddenY);
    const duration = (this.open ? 1500 : 1250) * Math.max(.28, Math.sqrt(fraction));
    const overshoot = 16;
    let frames;
    if (this.open && from > 18) {
      frames = [
        { transform: translate(from), offset: 0, easing: 'cubic-bezier(.58, 0, .24, 1)' },
        { transform: translate(-overshoot), offset: .82, easing: 'cubic-bezier(.42, 0, .74, 1)' },
        { transform: translate(0), offset: 1 }
      ];
    } else if (!this.open && from < 18) {
      frames = [
        { transform: translate(from), offset: 0, easing: 'cubic-bezier(.42, 0, .58, 1)' },
        { transform: translate(Math.min(from, 0) - overshoot), offset: .22, easing: 'cubic-bezier(.6, 0, .34, 1)' },
        { transform: translate(this.hiddenY), offset: 1 }
      ];
    } else {
      frames = [
        { transform: translate(from), easing: 'cubic-bezier(.42, 0, .3, 1)' },
        { transform: translate(this.open ? 0 : this.hiddenY) }
      ];
    }
    this.scene.style.transform = translate(from);
    this.scene.dataset.moving = 'true';
    this.hook.dataset.visible = this.frontHook.dataset.visible = 'true';
    this.pending = new Promise(resolve => { this.resolve = resolve; });
    const animation = this.scene.animate(frames, { duration, fill: 'both' });
    this.animation = animation;
    animation.onfinish = () => { if (this.animation === animation) this.finish(); };
    const update = () => {
      this.frame = 0;
      if (this.animation !== animation) return;
      this.onLayout();
      this.frame = requestAnimationFrame(update);
    };
    update();
    return this.pending;
  }

  cancelAnimation() {
    if (this.animation) {
      this.scene.style.transform = translate(this.currentY());
      this.animation.onfinish = null;
      this.animation.cancel();
      this.animation = null;
    }
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resolve?.(false);
    this.resolve = this.pending = null;
  }

  settle(notify = true) {
    this.scene.style.transform = translate(this.open ? 0 : this.hiddenY);
    this.scene.dataset.open = String(this.open);
    this.scene.dataset.moving = 'false';
    this.scene.inert = !this.open;
    this.hook.dataset.visible = this.frontHook.dataset.visible = String(this.open);
    if (notify) {
      this.onLayout();
      this.onSettled(this.open);
    }
  }

  finish() {
    if (!this.animation) return;
    const resolve = this.resolve;
    this.resolve = null;
    this.cancelAnimation();
    this.settle();
    resolve?.(true);
  }

  refreshEffects() { if (!this.disposed && this.instant) this.finish(); }

  dispose() {
    this.disposed = true;
    this.cancelAnimation();
    if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
    this.reduced.removeEventListener('change', this.handleEffects);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    window.removeEventListener('resize', this.handleResize);
    this.frontHook.remove();
  }
}
