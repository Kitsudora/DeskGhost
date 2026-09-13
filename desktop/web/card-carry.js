/** Moves the editor's existing card; persistence and drop validation stay in app/graph. */
export class CardCarry {
  constructor(card, grip, callbacks) {
    this.card = card; this.grip = grip; this.callbacks = callbacks; this.active = null;
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.active) return;
      event.preventDefault();
      this.active = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
      grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener('pointermove', event => {
      const drag = this.active;
      if (!drag || drag.pointerId !== event.pointerId || drag.dropping) return;
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
        if (callbacks.onPick() === false) { this.cancel(); return; }
        drag.moved = true; drag.origin = card.getBoundingClientRect();
        drag.scale = callbacks.cardWidth / drag.origin.width;
        document.body.classList.add('is-carrying');
      }
      drag.point = { x: event.clientX, y: event.clientY };
      drag.left = event.clientX - callbacks.cardWidth * .92;
      drag.top = event.clientY - drag.origin.height * drag.scale * .055;
      card.style.transform = `translate(${drag.left - drag.origin.left}px,${drag.top - drag.origin.top}px) scale(${drag.scale})`;
      callbacks.onMove(drag);
    });
    grip.addEventListener('pointerup', async event => {
      const drag = this.active;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.dropping = true;
      if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
      if (!drag.moved) { this.reset(); return; }
      try { await callbacks.onDrop(drag); }
      catch (error) { callbacks.onError(error); }
      finally { if (this.active === drag) { this.reset(); callbacks.onCancel(); } }
    });
    grip.addEventListener('pointercancel', () => this.cancel());
    grip.addEventListener('lostpointercapture', () => { if (this.active && !this.active.dropping) this.cancel(); });
  }
  reset() {
    const drag = this.active; this.active = null;
    if (drag && this.grip.hasPointerCapture(drag.pointerId)) this.grip.releasePointerCapture(drag.pointerId);
    this.card.style.transform = ''; document.body.classList.remove('is-carrying');
  }
  cancel() { const moved = this.active?.moved; this.reset(); if (moved) this.callbacks.onCancel(); }
}
