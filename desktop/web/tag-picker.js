import { createPaperTag } from './paper.js';

const PAGE_SIZE = 6;

/** A bounded paper tray. Native inputs handle text and IME composition. */
export class TagPicker {
  constructor(element, options) {
    this.element = element;
    this.options = options;
    this.query = element.querySelector('#tag-query');
    this.list = element.querySelector('#tag-options');
    this.error = element.querySelector('#tag-error');
    this.page = 0;
    this.busy = false;
    this.generation = 0;
    this.element.querySelector('#tag-previous').addEventListener('click', () => { this.page--; this.render(); });
    this.element.querySelector('#tag-next').addEventListener('click', () => { this.page++; this.render(); });
    this.element.querySelector('#create-paper-tag').addEventListener('click', () => this.create());
    this.query.addEventListener('input', () => { this.page = 0; this.render(); });
    this.element.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && event.repeat) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
      if (event.key === 'Enter') {
        if (event.target === this.query) {
          event.preventDefault(); event.stopPropagation();
          const exact = this.filtered.find(item => item.label.toLocaleLowerCase() === this.query.value.trim().toLocaleLowerCase());
          if (exact || this.filtered.length) this.choose((exact ?? this.filtered[0]).value, event.ctrlKey);
          else this.create(event.ctrlKey);
        } else if (event.target.dataset.value !== undefined) {
          event.preventDefault(); event.stopPropagation(); this.choose(event.target.dataset.value, event.ctrlKey);
        }
      }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        const buttons = [...this.list.querySelectorAll('button')];
        if (!buttons.length) return;
        event.preventDefault(); event.stopPropagation();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const current = buttons.indexOf(document.activeElement);
        buttons[current < 0 ? (step > 0 ? 0 : buttons.length - 1) : (current + step + buttons.length) % buttons.length].focus();
      }
    });
    document.addEventListener('pointerdown', event => {
      if (!this.element.hidden && !this.element.contains(event.target) && !event.target.closest('.dg-paper-tag')) this.close(false);
    });
  }

  open(kind, anchor, { focus = false } = {}) {
    if (this.busy) return;
    if (this.anchor !== anchor) this.releaseAnchor();
    this.anchor = anchor;
    this.anchor.classList.add('is-raised');
    this.anchor.setAttribute('aria-expanded', 'true');
    this.anchor.setAttribute('aria-controls', this.element.id);
    if (this.kind !== kind || this.element.hidden) {
      this.generation++;
      this.kind = kind; this.page = 0; this.query.value = ''; this.error.textContent = '';
      this.element.querySelector('#tag-picker-kind').textContent = kind === 'workspace' ? 'Workspace tags' : 'Category tags';
      this.query.maxLength = kind === 'workspace' ? 120 : 80;
      this.element.hidden = false;
      this.render();
    }
    this.position();
    if (focus) this.query.focus({ preventScroll: true });
    this.options.onLayout?.();
  }

  position() {
    if (this.element.hidden || !this.anchor) return;
    const parent = this.element.offsetParent?.getBoundingClientRect();
    if (!parent) return;
    const anchor = this.anchor.getBoundingClientRect();
    const width = this.element.offsetWidth, height = this.element.offsetHeight;
    const right = anchor.right + 12;
    const left = right + width <= innerWidth - 16 ? right : anchor.left - width - 12;
    this.element.style.left = `${Math.max(16, Math.min(innerWidth - width - 16, left)) - parent.left}px`;
    this.element.style.top = `${Math.max(16, Math.min(innerHeight - height - 16, anchor.top)) - parent.top}px`;
  }

  render() {
    if (this.element.hidden || this.busy) return;
    const query = this.query.value.trim().toLocaleLowerCase();
    this.filtered = this.options.items(this.kind).filter(item => item.label.toLocaleLowerCase().includes(query));
    const pages = Math.max(1, Math.ceil(this.filtered.length / PAGE_SIZE));
    this.page = Math.max(0, Math.min(pages - 1, this.page));
    const items = this.filtered.slice(this.page * PAGE_SIZE, this.page * PAGE_SIZE + PAGE_SIZE);
    this.list.replaceChildren(...items.map(item => {
      const button = createPaperTag({ kind: this.kind, label: item.label, key: item.value, onClick: () => this.choose(item.value) });
      button.dataset.value = item.value;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(this.options.value(this.kind) === item.value));
      return button;
    }));
    this.element.querySelector('#tag-previous').disabled = this.page === 0;
    this.element.querySelector('#tag-next').disabled = this.page === pages - 1;
    this.element.querySelector('#tag-page').textContent = this.filtered.length ? `${this.page + 1} / ${pages}` : 'No matching tags';
    const create = this.element.querySelector('#create-paper-tag');
    create.textContent = query ? `+ Make "${this.query.value.trim()}"` : `+ New ${this.kind}`;
    create.disabled = !query || this.filtered.some(item => item.label.toLocaleLowerCase() === query);
    this.position();
  }

  async commit(action, advance) {
    if (this.busy) return;
    const generation = this.generation;
    this.busy = true; this.error.textContent = '';
    for (const control of this.element.querySelectorAll('input,button')) control.disabled = true;
    try {
      const accepted = await action();
      if (generation === this.generation && accepted !== false) {
        this.close(false);
        if (advance) this.options.onAdvance?.();
        else this.focusAnchor();
      }
    } catch (error) { this.error.textContent = error.message || String(error); }
    finally {
      this.busy = false;
      for (const control of this.element.querySelectorAll('input,button')) control.disabled = false;
      this.render(); this.options.onLayout?.();
    }
  }

  choose(value, advance = false) { const kind = this.kind; return this.commit(() => this.options.onChoose(kind, value), advance); }
  create(advance = false) {
    const name = this.query.value.trim();
    if (!name) { this.query.focus(); return; }
    const kind = this.kind, generation = this.generation;
    return this.commit(async () => {
      const value = await this.options.onCreate(kind, name);
      if (generation !== this.generation) return false;
      return this.options.onChoose(kind, value);
    }, advance);
  }

  close(restoreFocus = true) {
    this.generation++;
    const hadFocus = this.element.contains(document.activeElement);
    this.element.hidden = true;
    this.releaseAnchor();
    if (restoreFocus && hadFocus) this.focusAnchor();
    this.options.onLayout?.();
  }

  releaseAnchor() {
    this.anchor?.classList.remove('is-raised');
    this.anchor?.setAttribute('aria-expanded', 'false');
  }

  focusAnchor() {
    if (this.anchor?.isConnected && !this.anchor.disabled && !this.anchor.closest('[inert],[hidden]')) this.anchor.focus({ preventScroll: true });
  }
}
