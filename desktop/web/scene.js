const translate = y => `translate3d(0, ${y}px, 0)`;
const hookTranslate = y => `translate3d(-50%, ${y}px, 0)`;

/** One rigid panel: a deliberate pull, a free ring above the hook, then its weight
 * settling onto the hook. Both hook faces descend together before the ring
 * arrives, and withdraw only after it clears. Every movement is translation. */
export class SceneMotion {
  constructor(scene, hook, { onLayout = () => {}, onSettled = () => {} } = {}) {
    this.scene = scene;
    this.hook = hook;
    this.onLayout = onLayout;
    this.onSettled = onSettled;
    this.open = false;
    this.animation = null;
    this.hookAnimations = [];
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
          const hookY = this.currentY(this.hook);
          this.cancelAnimation(false);
          this.start(y, hookY);
        } else { this.settle(false); this.onLayout(); }
      });
    };
    this.reduced.addEventListener('change', this.handleEffects);
    document.addEventListener('visibilitychange', this.handleVisibility);
    window.addEventListener('resize', this.handleResize);
    this.settle(false);
  }

  get hiddenY() { return window.innerHeight + 80; }
  get hiddenHookY() {
    const style = getComputedStyle(this.hook);
    return -(parseFloat(style.top) + this.hook.getBoundingClientRect().height + 12);
  }
  get instant() { return document.hidden || this.reduced.matches || document.documentElement.dataset.effects === 'off'; }

  currentY(element = this.scene) {
    const transform = getComputedStyle(element).transform;
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
    const hookFrom = this.currentY(this.hook);
    this.cancelAnimation();
    this.open = next;
    this.scene.dataset.open = String(next);
    this.scene.inert = !next;
    if (immediate || this.instant) { this.settle(); return Promise.resolve(true); }
    return this.start(from, hookFrom);
  }

  start(from, hookFrom) {
    const distance = Math.abs((this.open ? 0 : this.hiddenY) - from);
    const hookTarget = this.open ? 0 : this.hiddenHookY;
    if ((distance < .5 && Math.abs(hookTarget - hookFrom) < .5) || this.instant) {
      const resolve = this.resolve;
      this.resolve = this.pending = null;
      this.settle();
      resolve?.(true);
      return Promise.resolve(true);
    }
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
    this.hook.dataset.moving = this.frontHook.dataset.moving = 'true';
    if (!this.pending) this.pending = new Promise(resolve => { this.resolve = resolve; });
    const ring = this.scene.querySelector('#scene-ring');
    const hookBottom = parseFloat(getComputedStyle(this.hook).top) + this.hook.getBoundingClientRect().height;
    const clearY = ring ? hookBottom - (ring.getBoundingClientRect().top - from) + 10 : 80;
    // During a full close the panel lifts first. Keep the hook in place through
    // that lift and the first half of its descent, well beyond the ring's edge.
    // A reversal with the ring already below the hook can retract immediately.
    const hold = !this.open && from < clearY ? .62 : 0;
    const hookEnd = this.open ? .34 : 1;
    const hookFrames = [
      { transform: hookTranslate(hookFrom), offset: 0, easing: 'cubic-bezier(.42, 0, .3, 1)' },
      ...(hold ? [{ transform: hookTranslate(hookFrom), offset: hold, easing: 'cubic-bezier(.42, 0, .6, 1)' }] : []),
      { transform: hookTranslate(hookTarget), offset: hookEnd },
      ...(hookEnd < 1 ? [{ transform: hookTranslate(hookTarget), offset: 1 }] : [])
    ];
    this.hookAnimations = [this.hook, this.frontHook].map(element => {
      element.style.transform = hookTranslate(hookFrom);
      return element.animate(hookFrames, { duration, fill: 'both' });
    });
    const animation = this.scene.animate(frames, { duration, fill: 'both' });
    this.animation = animation;
    animation.onfinish = () => { if (this.animation === animation) this.finish(); };
    const update = () => {
      this.frame = 0;
      if (this.animation !== animation) return;
      this.onLayout();
      if (this.animation === animation) this.frame = requestAnimationFrame(update);
    };
    update();
    return this.pending;
  }

  cancelAnimation(resolvePending = true) {
    if (this.animation) {
      this.scene.style.transform = translate(this.currentY());
      this.animation.onfinish = null;
      this.animation.cancel();
      this.animation = null;
    }
    const hookY = this.currentY(this.hook);
    for (const element of [this.hook, this.frontHook]) element.style.transform = hookTranslate(hookY);
    for (const animation of this.hookAnimations) animation.cancel();
    this.hookAnimations = [];
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (resolvePending) {
      this.resolve?.(false);
      this.resolve = this.pending = null;
    }
  }

  settle(notify = true) {
    this.scene.style.transform = translate(this.open ? 0 : this.hiddenY);
    this.scene.dataset.open = String(this.open);
    this.scene.dataset.moving = 'false';
    this.scene.inert = !this.open;
    this.hook.dataset.visible = this.frontHook.dataset.visible = String(this.open);
    this.hook.dataset.moving = this.frontHook.dataset.moving = 'false';
    for (const element of [this.hook, this.frontHook]) {
      element.style.transform = hookTranslate(this.open ? 0 : this.hiddenHookY);
    }
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
    this.hook.dataset.visible = 'false';
    if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
    this.reduced.removeEventListener('change', this.handleEffects);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    window.removeEventListener('resize', this.handleResize);
    this.frontHook.remove();
  }
}
