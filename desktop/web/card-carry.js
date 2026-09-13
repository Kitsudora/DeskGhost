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
      if (!(event.buttons & 1)) { this.cancel(); return; }
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
        if (callbacks.onPick() === false) { this.cancel(); return; }
        drag.moved = true; drag.origin = card.getBoundingClientRect();
        document.body.classList.add('is-carrying');
      }
      drag.point = { x: event.clientX, y: event.clientY };
      this.refresh();
    });
    grip.addEventListener('pointerup', async event => {
      const drag = this.active;
      if (!drag || drag.pointerId !== event.pointerId || drag.dropping) return;
      if (drag.moved) {
        drag.point = { x: event.clientX, y: event.clientY };
        this.refresh();
      }
      drag.dropping = true;
      if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
      if (!drag.moved) { this.reset(); return; }
      try { await callbacks.onDrop(drag); }
      catch (error) { callbacks.onError(error); }
      finally { if (this.active === drag) { this.reset(); callbacks.onCancel(); } }
    });
    grip.addEventListener('pointercancel', () => this.cancel());
    grip.addEventListener('lostpointercapture', () => { if (this.active && !this.active.dropping) this.cancel(); });
    window.addEventListener('blur', () => this.cancel());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.cancel(); });
  }
  refresh() {
    const drag = this.active;
    if (!drag?.moved || drag.dropping || !drag.point) return;
    const width = this.callbacks.cardWidth();
    drag.scale = width / drag.origin.width;
    drag.left = drag.point.x - width * .92;
    drag.top = drag.point.y - drag.origin.height * drag.scale * .055;
    this.card.style.transform = `translate(${drag.left - drag.origin.left}px,${drag.top - drag.origin.top}px) scale(${drag.scale})`;
    this.callbacks.onMove(drag);
  }
  reset() {
    const drag = this.active; this.active = null;
    if (drag && this.grip.hasPointerCapture(drag.pointerId)) this.grip.releasePointerCapture(drag.pointerId);
    this.card.style.transform = ''; document.body.classList.remove('is-carrying');
  }
  cancel() {
    // Once released, the drop belongs to the save operation. Losing focus must
    // only cancel a held card, never reset an in-flight placement or deletion.
    if (this.active?.dropping) return;
    const moved = this.active?.moved; this.reset(); if (moved) this.callbacks.onCancel();
  }
}
