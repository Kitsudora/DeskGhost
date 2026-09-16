import { StickerController } from './sticker.js';
import { mountCardLayers, createPaperTag, updatePaperTag, createNoteClip, fitCardText } from './paper.js';

const SVG = 'http://www.w3.org/2000/svg';
const CARD_WIDTH = 310;
const CARD_HEIGHT = CARD_WIDTH * 457.9779 / 621.3463;
const COLUMN_STEP = 470;
const ROW_STEP = 294;
const TOP = 96;
const PORT_OFFSET = 42;
const CAMERA_LEFT = 66;
const CAMERA_TOP = 24;
const CONTENT_BOTTOM = 40;
const FIVE_ROWS_HEIGHT = TOP + ROW_STEP * 4 + CARD_HEIGHT + CONTENT_BOTTOM;
const ARCHIVE_LINK_REASON = 'Restore the archived chain before connecting it to active tasks.';
const STATE_LABELS = { NotStarted: 'TODO', InProgress: 'IN PROGRESS', Completed: 'DONE', Stopped: 'STOPPED' };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const edgeKey = (source, target) => `${source}:${target}`;
const pointFor = (task) => ({ x: task.column * COLUMN_STEP, y: TOP + task.row * ROW_STEP });

export const graphGeometry = Object.freeze({ cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT, columnStep: COLUMN_STEP, rowStep: ROW_STEP, top: TOP });

/** Strictly increasing logical columns make cycles impossible without graph traversal. */
export function validateConnection(source, target, links = [], replacedLink = null) {
  if (!source || !target || source.deletedAt || target.deletedAt || source.id === target.id || source.column >= target.column) return false;
  const unchanged = replacedLink?.sourceId === source.id && replacedLink?.targetId === target.id;
  if (!unchanged && !!source.isArchived !== !!target.isArchived) return false;
  return !links.some(link => link.sourceId === source.id && link.targetId === target.id &&
    !(replacedLink && link.sourceId === replacedLink.sourceId && link.targetId === replacedLink.targetId));
}

/** Plan a new relationship, shifting its target and descendants only when needed. */
export function planConnection(tasks, links, sourceId, targetId) {
  const byId = tasks instanceof Map ? tasks : new Map(tasks.map(task => [task.id, task]));
  const source = byId.get(sourceId), target = byId.get(targetId);
  const reject = reason => ({ valid: false, reason });
  if (!source || !target || source.deletedAt || target.deletedAt) return reject('Connect tasks that have not been deleted.');
  if (sourceId === targetId) return reject('A task cannot connect to itself.');
  if (links.some(link => link.sourceId === sourceId && link.targetId === targetId)) return reject('These tasks are already connected.');
  if (!!source.isArchived !== !!target.isArchived) return reject(ARCHIVE_LINK_REASON);
  if (links.length >= 8000) return reject('The connection limit has been reached.');
  if (source.column < target.column) return { valid: true, column: target.column, row: target.row, movedCount: 0 };
  const outgoing = new Map();
  for (const link of links) {
    if (!outgoing.has(link.sourceId)) outgoing.set(link.sourceId, []);
    outgoing.get(link.sourceId).push(link.targetId);
  }
  const descendants = new Set();
  const pending = [targetId];
  while (pending.length) {
    const id = pending.pop();
    if (id === sourceId) return reject('This connection would create a cycle.');
    if (descendants.has(id)) continue;
    descendants.add(id);
    for (const next of outgoing.get(id) || []) pending.push(next);
  }
  // Existing columns are already a topological order. Propagating in that
  // order preserves every other parent constraint without repeated traversal.
  const order = [...descendants].map(id => byId.get(id)).filter(Boolean).sort((a, b) => a.column - b.column);
  const columns = new Map([[targetId, source.column + 1]]);
  let movedCount = 0;
  for (const task of order) {
    const column = columns.get(task.id) ?? task.column;
    if (column > 255) return reject('This connection would exceed the 256-column limit.');
    if (column !== task.column) movedCount++;
    for (const next of outgoing.get(task.id) || []) {
      const original = byId.get(next);
      if (original) columns.set(next, Math.max(columns.get(next) ?? original.column, column + 1));
    }
  }
  const occupied = new Map();
  const mark = (column, row, change) => {
    if (!occupied.has(column)) occupied.set(column, new Map());
    const rows = occupied.get(column);
    rows.set(row, (rows.get(row) || 0) + change);
  };
  for (const task of byId.values()) if (!task.deletedAt) mark(task.column, task.row, 1);
  let targetRow = target.row;
  // Match the host's stable document order when shifted cards need a free row.
  for (const task of byId.values()) {
    const column = columns.get(task.id) ?? task.column;
    if (column === task.column) continue;
    let row = task.row;
    if (occupied.get(column)?.get(row)) {
      row = 0;
      while (occupied.get(column)?.get(row)) row++;
    }
    mark(task.column, task.row, -1);
    mark(column, row, 1);
    if (task.id === targetId) targetRow = row;
  }
  return { valid: true, column: columns.get(targetId), row: targetRow, movedCount };
}

export function snapPosition(position, columnCount, tasks = [], excludedId) {
  const column = clamp(Math.round(position.x / COLUMN_STEP), 0, Math.min(255, Math.max(0, columnCount)));
  const desired = clamp(Math.round((position.y - TOP) / ROW_STEP), 0, 4095);
  const occupied = new Set([...tasks].filter(task => !task.deletedAt && task.id !== excludedId && task.column === column).map(task => task.row));
  for (let distance = 0; distance <= 4095; distance++) {
    if (desired + distance <= 4095 && !occupied.has(desired + distance)) return { column, row: desired + distance };
    if (desired - distance >= 0 && !occupied.has(desired - distance)) return { column, row: desired - distance };
  }
  return { column, row: desired };
}

export function validateMove(tasks, links, taskId, column) {
  const byId = tasks instanceof Map ? tasks : new Map(tasks.map(task => [task.id, task]));
  return byId.has(taskId) && links.every(link =>
    (link.targetId !== taskId || byId.get(link.sourceId)?.column < column) &&
    (link.sourceId !== taskId || column < byId.get(link.targetId)?.column));
}

function element(tag, className, label) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
}

function svgElement(tag, attributes) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, value);
  return node;
}

function button(className, label, glyph) {
  const node = element('button', className, glyph);
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  return node;
}

function curve(start, end) {
  if (end.x - start.x > COLUMN_STEP && Math.abs(end.y - start.y) < ROW_STEP / 2) {
    // Route long links above intervening cards instead of hiding their path behind them.
    const laneY = Math.min(start.y, end.y) - CARD_HEIGHT / 2 - 28;
    return `M ${start.x} ${start.y} C ${start.x + 42} ${start.y}, ${start.x + 42} ${laneY}, ${start.x + 84} ${laneY} L ${end.x - 84} ${laneY} C ${end.x - 42} ${laneY}, ${end.x - 42} ${end.y}, ${end.x} ${end.y}`;
  }
  const bend = Math.max(46, Math.abs(end.x - start.x) * .46);
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`;
}

/** Direct manipulation graph. Persisted edits are delegated to the workspace host. */
export class TaskGraph {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.workspace = null;
    this.options = {};
    this.selection = new Set();
    this.cards = new Map();
    this.stickers = new Map();
    this.tasks = new Map();
    this.contextIds = new Set();
    this.positions = new Map();
    this.edges = new Map();
    this.incident = new Map();
    this.animations = new Map();
    this.camera = { x: CAMERA_LEFT, y: CAMERA_TOP, scale: 1 };
    this.frame = 0;
    this.pendingPointer = null;
    this.interaction = null;
    this.abort = new AbortController();
    this.container.classList.add('dg-graph');
    this.container.tabIndex = 0;
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-label', 'Task graph. Select a card to reveal its connection points. Drag cards to move them or to the bin. Hold the middle mouse button and drag to pan. Ctrl and wheel zoom between full size and five rows. Shift and wheel scroll time slices; wheel scrolls overflowing rows.');
    this.stage = element('div', 'dg-graph-stage');
    this.columnsLayer = element('div', 'dg-columns');
    this.edgeLayer = svgElement('svg', { class: 'dg-edges', 'aria-label': 'Task connections' });
    const defs = svgElement('defs');
    const markerId = `dg-arrow-${TaskGraph.nextId++}`;
    const marker = svgElement('marker', { id: markerId, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto', markerUnits: 'userSpaceOnUse' });
    marker.append(svgElement('path', { d: 'M 1 1 L 5.5 3.5 L 1 6', fill: 'none', stroke: 'context-stroke', 'stroke-width': 1.15, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    defs.append(marker);
    this.edgeLayer.append(defs);
    this.markerId = markerId;
    this.edgesGroup = svgElement('g');
    this.edgeLayer.append(this.edgesGroup);
    this.cardsLayer = element('div', 'dg-cards');
    this.ghost = element('div', 'dg-snap-ghost');
    this.ghost.append(element('span', '', 'Release to snap'));
    this.ghost.hidden = true;
    this.preview = svgElement('path', { class: 'dg-edge-preview', fill: 'none' });
    this.preview.style.display = 'none';
    this.edgeLayer.append(this.preview);
    this.stage.append(this.columnsLayer, this.edgeLayer, this.ghost, this.cardsLayer);
    this.linkHint = element('div', 'dg-link-hint');
    this.linkHint.setAttribute('role', 'status');
    this.linkHint.hidden = true;
    this.empty = element('div', 'dg-graph-empty');
    this.empty.append(element('h2', '', 'No tasks yet'));
    const create = button('dg-empty-create', 'Create task', '＋ NEW TASK');
    create.addEventListener('click', () => callbacks.onCreate?.({ sourceIds: [] }));
    this.empty.append(create);
    this.container.replaceChildren(this.stage, this.empty, this.linkHint);
    const events = { signal: this.abort.signal };
    this.container.addEventListener('pointerdown', (event) => this.pointerDown(event), events);
    this.container.addEventListener('pointermove', (event) => this.pointerMove(event), events);
    this.container.addEventListener('pointerup', (event) => this.pointerUp(event), events);
    this.container.addEventListener('pointercancel', () => this.cancelInteraction(), events);
    this.container.addEventListener('lostpointercapture', () => { if (this.interaction) this.cancelInteraction(); }, events);
    this.container.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); }, events);
    this.container.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); }, events);
    window.addEventListener('blur', () => this.cancelInteraction(), events);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.cancelInteraction(); }, events);
    this.container.addEventListener('wheel', (event) => this.wheel(event), { ...events, passive: false });
    this.container.addEventListener('keydown', (event) => this.keyDown(event), events);
    this.container.addEventListener('dblclick', (event) => this.doubleClick(event), events);
    this.resizeObserver = new ResizeObserver(() => {
      this.applyCamera();
      this.fitTitles();
    });
    this.resizeObserver.observe(container);
    document.fonts?.ready.then(() => { if (!this.abort.signal.aborted) this.fitTitles(); });
    this.applyCamera();
  }

  get selectedIds() { return [...this.selection]; }

  get minScale() {
    return Math.min(1, Math.max(1, this.container.clientHeight - CAMERA_TOP) / FIVE_ROWS_HEIGHT);
  }

  get displayCardWidth() { return CARD_WIDTH * this.camera.scale; }

  fitTitles() {
    for (const card of this.cards.values()) fitCardText(card.querySelector('.dg-card-title'));
  }

  getCardRect(id) {
    const card = this.cards.get(id);
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  setLiftedTask(id = null) {
    this.liftedTaskId = id;
    for (const [taskId, card] of this.cards) {
      card.classList.toggle('is-lifted', taskId === id);
      card.inert = taskId === id;
    }
  }

  /** Client coordinates describe the proposed top-left at the current graph scale. */
  previewPlacement(clientX, clientY, taskId = null) {
    if (!this.workspace || this.options.categoryView || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return { valid: false };
    const bounds = this.container.getBoundingClientRect();
    const position = this.worldPoint({ clientX, clientY });
    const { column, row } = snapPosition(position, this.workspace.columns.length, this.tasks.values(), taskId);
    const scale = this.camera.scale;
    const inside = clientX + CARD_WIDTH * scale / 2 >= bounds.left && clientX + CARD_WIDTH * scale / 2 <= bounds.right &&
      clientY + CARD_HEIGHT * scale / 2 >= bounds.top && clientY + CARD_HEIGHT * scale / 2 <= bounds.bottom;
    const valid = inside && (taskId === null || this.validMove(taskId, column));
    const append = column === this.workspace.columns.length;
    this.showPlacement({ column, row, valid, append });
    return { column, row, valid, append, rect: {
      left: bounds.left + this.camera.x + column * COLUMN_STEP * scale,
      top: bounds.top + this.camera.y + (TOP + row * ROW_STEP) * scale,
      width: CARD_WIDTH * scale, height: CARD_HEIGHT * scale
    } };
  }

  showPlacement({ column, row, valid, append }) {
    this.appendZone?.classList.toggle('is-active', append && valid);
    this.ghost.hidden = false;
    this.ghost.classList.toggle('is-invalid', !valid);
    this.ghost.style.transform = `translate3d(${column * COLUMN_STEP}px, ${TOP + row * ROW_STEP}px, 0)`;
    this.ghost.firstChild.textContent = valid ? String(column + 1).padStart(2, '0') : '×';
  }

  endPlacement() {
    this.ghost.hidden = true;
    this.appendZone?.classList.remove('is-active');
  }

  setWorkspace(workspace, options = {}) {
    const previousPositions = new Map(this.positions);
    const changedWorkspace = this.workspace?.id !== workspace?.id;
    const changedView = Boolean(this.options.categoryView) !== Boolean(options.categoryView);
    if (changedWorkspace) {
      this.camera = { x: CAMERA_LEFT, y: CAMERA_TOP, scale: this.camera.scale };
      this.selection.clear();
      for (const sticker of this.stickers.values()) sticker.destroy();
      this.stickers.clear();
      this.cards.clear();
      this.cardsLayer.replaceChildren();
    }
    this.cancelInteraction(false);
    this.animations.clear();
    this.workspace = workspace;
    this.options = options;
    this.tasks = new Map((workspace?.tasks || []).slice(0, 2000).map(task => [task.id, task]));
    this.visibleTasks = this.collectVisibleTasks();
    const visibleIds = new Set(this.visibleTasks.map(task => task.id));
    const previousSelectionSize = this.selection.size;
    this.selection = new Set([...this.selection].filter(id => visibleIds.has(id)));
    this.container.classList.toggle('is-category-view', !!options.categoryView);
    this.render();
    if (!changedWorkspace && !changedView && !this.reducedMotion) {
      for (const [id, position] of this.positions) {
        if (id === this.liftedTaskId) continue;
        const previous = previousPositions.get(id);
        if (previous && Math.hypot(position.x - previous.x, position.y - previous.y) > .5)
          this.animatePosition(id, previous, position);
      }
    }
    if (changedView || changedWorkspace) this.latest();
    this.applyCamera();
    if (previousSelectionSize !== this.selection.size || changedWorkspace) this.callbacks.onSelect?.([...this.selection]);
  }

  get reducedMotion() {
    return this.options.reducedMotion || document.documentElement.dataset.effects === 'off' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  isVisible(task) {
    const history = this.options.history;
    if (history === 'trash' || history === 'deleted') return !!task.deletedAt;
    if (task.deletedAt) return false;
    if (history === 'archived' || history === 'archive') return task.isArchived;
    return history === 'all' || history === true || !task.isArchived;
  }

  collectVisibleTasks() {
    const primary = [...this.tasks.values()].filter(task => this.isVisible(task));
    const visibleIds = new Set(primary.map(task => task.id));
    this.contextIds.clear();
    if (['trash', 'deleted', 'all', true].includes(this.options.history)) return primary;
    // Older workspaces can have partially archived chains. Keep the whole
    // connected component on screen so every ordering constraint has a line.
    const neighbors = new Map();
    for (const { sourceId, targetId } of (this.workspace?.links || []).slice(0, 8000)) {
      const source = this.tasks.get(sourceId), target = this.tasks.get(targetId);
      if (!source || !target || source.deletedAt || target.deletedAt) continue;
      if (!neighbors.has(sourceId)) neighbors.set(sourceId, []);
      if (!neighbors.has(targetId)) neighbors.set(targetId, []);
      neighbors.get(sourceId).push(targetId);
      neighbors.get(targetId).push(sourceId);
    }
    const pending = [...visibleIds];
    while (pending.length) {
      for (const id of neighbors.get(pending.pop()) || []) {
        if (visibleIds.has(id)) continue;
        visibleIds.add(id);
        this.contextIds.add(id);
        pending.push(id);
      }
    }
    return [...this.tasks.values()].filter(task => visibleIds.has(task.id));
  }

  matches(task) {
    const filters = this.options.filters || {};
    const title = (filters.title || filters.query || '').trim().toLocaleLowerCase();
    const state = filters.state || filters.status;
    return (!title || task.title.toLocaleLowerCase().includes(title)) &&
      (filters.category == null || filters.category === '*' || task.category === filters.category) &&
      (!state || state === 'all' || task.state === state) &&
      (!filters.states?.length || filters.states.includes(task.state));
  }

  render() {
    const visibleIds = new Set(this.visibleTasks.map(task => task.id));
    for (const [id, card] of this.cards) if (!visibleIds.has(id)) {
      this.stickers.get(id)?.destroy();
      this.stickers.delete(id);
      card.remove();
      this.cards.delete(id);
    }
    this.positions.clear();
    this.edges.clear();
    this.incident.clear();
    this.selectedEdge = null;
    this.columnsLayer.replaceChildren();
    this.appendZone = null;
    this.edgesGroup.replaceChildren();
    this.empty.hidden = this.visibleTasks.length !== 0 || !this.workspace;
    const history = this.options.history;
    if (this.empty.querySelector('h2')) {
      this.empty.querySelector('h2').textContent = history === 'trash' ? 'Recycle bin is empty' : history === 'archived' ? 'No archived tasks' : 'No tasks yet';
      this.empty.querySelector('button').hidden = !!history && history !== 'active' && history !== 'all';
    }
    if (!this.workspace) return;
    let lanes;
    if (this.options.categoryView) {
      const categories = [...new Set(this.visibleTasks.map(task => task.category))];
      lanes = categories.map(category => ({ label: category || 'Uncategorized', tasks: this.visibleTasks.filter(task => task.category === category).sort((a, b) => a.column - b.column || a.row - b.row) }));
      lanes.forEach((lane, index) => lane.tasks.forEach((task, row) => this.positions.set(task.id, { x: index * COLUMN_STEP, y: TOP + row * ROW_STEP })));
    } else {
      lanes = this.workspace.columns.map((label, index) => ({ label, tasks: this.visibleTasks.filter(task => task.column === index) }));
      for (const task of this.visibleTasks) this.positions.set(task.id, pointFor(task));
    }
    this.contentHeight = Math.max(TOP + CARD_HEIGHT, ...[...this.positions.values()].map(position => position.y + CARD_HEIGHT)) + CONTENT_BOTTOM;
    this.worldHeight = Math.max(this.container.clientHeight / this.camera.scale, this.contentHeight);
    this.worldWidth = (Math.max(1, lanes.length) - 1 + (!this.options.categoryView && lanes.length < 256 ? 1 : 0)) * COLUMN_STEP + CARD_WIDTH;
    lanes.forEach((lane, index) => {
      const column = element('section', 'dg-column');
      column.style.transform = `translateX(${index * COLUMN_STEP}px)`;
      column.style.height = `${this.worldHeight}px`;
      const heading = element('div', 'dg-column-heading');
      if (this.options.categoryView) heading.append(element('h3', '', lane.label));
      else heading.append(element('span', 'dg-column-index', String(index + 1).padStart(2, '0')));
      if (!this.options.categoryView && this.workspace.columns.length < 256) {
        const add = button('dg-insert-column', 'Insert a logical column after this one', '+');
        add.addEventListener('click', () => this.commit('insertColumn', { index: index + 1 }));
        heading.append(add);
      }
      column.append(heading);
      this.columnsLayer.append(column);
    });
    if (!this.options.categoryView && this.workspace.columns.length < 256) {
      const nextColumn = this.workspace.columns.length;
      this.appendZone = element('section', 'dg-new-column');
      this.appendZone.dataset.column = String(nextColumn);
      this.appendZone.style.transform = `translateX(${nextColumn * COLUMN_STEP}px)`;
      this.appendZone.style.height = `${this.worldHeight}px`;
      const add = button('dg-new-column-button', 'Add a time slice, or drag a card here', '＋ ' + String(nextColumn + 1).padStart(2, '0'));
      add.addEventListener('click', () => this.commit('insertColumn', { index: nextColumn }));
      const label = element('div', 'dg-new-column-label');
      label.append(element('strong', '', String(nextColumn + 1).padStart(2, '0')));
      this.appendZone.append(add, label);
      this.columnsLayer.append(this.appendZone);
    }
    for (const task of this.visibleTasks) this.renderCard(task);
    if (!this.options.categoryView) {
      for (const link of (this.workspace.links || []).slice(0, 8000)) {
        if (this.cards.has(link.sourceId) && this.cards.has(link.targetId)) this.renderEdge(link);
      }
    }
    this.updateSelection();
  }

  renderCard(task) {
    let card = this.cards.get(task.id);
    if (!card) {
      card = element('article', 'dg-task-card');
      card.dataset.taskId = task.id;
      card.tabIndex = 0;
      const surface = element('div', 'dg-card-surface');
      mountCardLayers(surface);
      const stickerSlot = element('div', 'dg-sticker-slot');
      stickerSlot.addEventListener('pointerdown', event => { if (event.button === 0) this.select(task.id); }, { capture: true });
      stickerSlot.addEventListener('focusin', () => { if (this.selection.size !== 1 || !this.selection.has(task.id)) this.select(task.id); });
      const ribbon = element('div', 'dg-title-ribbon');
      ribbon.append(element('h3', 'dg-card-title'));
      const tags = element('div', 'dg-card-tags');
      for (const kind of ['workspace', 'category']) tags.append(createPaperTag({
        kind, onClick: () => this.callbacks.onEdit?.(task.id, { tag: kind })
      }));
      const noteClip = createNoteClip({ onClick: () => this.callbacks.onEdit?.(task.id, { notes: true }) });
      surface.append(tags, stickerSlot, ribbon, element('p', 'dg-card-description'), noteClip);
      card.append(surface, element('div', 'dg-card-actions'), element('span', 'dg-history-context'));
      this.cardsLayer.append(card);
      this.cards.set(task.id, card);
      this.stickers.set(task.id, new StickerController(stickerSlot, {
        state: task.state,
        disabled: !!task.isArchived || !!task.deletedAt,
        onChange: state => this.commit('setState', { taskId: task.id, state })
      }));
    }
    card.dataset.state = task.state;
    const context = this.contextIds.has(task.id);
    card.setAttribute('aria-label', `${task.title}, ${STATE_LABELS[task.state] || task.state}, column ${task.column + 1}${context ? `, ${task.isArchived ? 'archived' : 'active'} task shown to preserve connection context` : ''}`);
    card.classList.toggle('is-dimmed', !this.matches(task));
    card.classList.toggle('is-archived', !!task.isArchived);
    card.classList.toggle('is-history-context', context);
    const contextLabel = card.querySelector('.dg-history-context');
    contextLabel.hidden = !context;
    contextLabel.textContent = task.isArchived ? 'ARCHIVED · LINKED' : 'ACTIVE · LINKED';
    contextLabel.title = 'This card stays visible because it is connected to this view.';
    card.classList.toggle('is-deleted', !!task.deletedAt);
    card.classList.toggle('is-lifted', task.id === this.liftedTaskId);
    card.inert = task.id === this.liftedTaskId;
    this.stickers.get(task.id).update(task.state, { disabled: !!task.isArchived || !!task.deletedAt });
    const more = card.querySelector('.dg-card-actions');
    more.replaceChildren();
    if (!task.deletedAt) {
      if (task.isArchived || task.state === 'Completed' || task.state === 'Stopped') {
        const archive = button('dg-card-action', task.isArchived ? 'Restore archived task' : 'Archive task', task.isArchived ? '↶' : '↓');
        archive.addEventListener('click', () => this.commit(task.isArchived ? 'unarchiveTask' : 'archiveTask', { taskId: task.id }));
        more.append(archive);
      }
    } else {
      const restore = button('dg-card-action', 'Restore task', '↶');
      restore.addEventListener('click', () => this.commit('restoreTask', { taskId: task.id }));
      more.append(restore);
    }
    const title = card.querySelector('.dg-card-title');
    title.textContent = task.title;
    title.title = task.title;
    fitCardText(title);
    const description = card.querySelector('.dg-card-description');
    description.textContent = task.description || '';
    description.classList.toggle('is-placeholder', !task.description);
    updatePaperTag(card.querySelector('[data-tag="workspace"]'), {
      label: this.options.workspaceName ?? this.workspace.name,
      key: this.options.workspaceId ?? this.workspace.id
    });
    updatePaperTag(card.querySelector('[data-tag="category"]'), { label: task.category || 'Uncategorized', key: task.category || '' });
    card.querySelector('.dg-note-clip').hidden = !task.notes?.trim();
    for (const port of card.querySelectorAll('.dg-port')) port.remove();
    if (!task.deletedAt && !this.options.categoryView) {
      for (const side of ['in', 'out']) {
        const port = button(`dg-port dg-port-${side}`, side === 'in' ? 'Drag to connect an incoming task' : 'Drag to connect an outgoing task', '');
        port.dataset.port = side;
        port.dataset.taskId = task.id;
        port.addEventListener('click', event => { if (event.detail === 0) this.keyboardPort(task.id, side); });
        card.append(port);
      }
    }
    this.paintCard(task.id);
  }

  renderEdge(link) {
    const key = edgeKey(link.sourceId, link.targetId);
    const group = svgElement('g', { class: 'dg-edge', 'data-edge-key': key, tabindex: 0, role: 'button', 'aria-label': `${this.tasks.get(link.sourceId)?.title} → ${this.tasks.get(link.targetId)?.title}. Press Delete to disconnect.` });
    const hit = svgElement('path', { class: 'dg-edge-hit', fill: 'none' });
    const line = svgElement('path', { class: 'dg-edge-line', fill: 'none', 'marker-end': `url(#${this.markerId})` });
    const sourceHandle = svgElement('circle', { class: 'dg-edge-handle', r: 6, 'data-endpoint': 'source', 'data-edge-key': key });
    const targetHandle = svgElement('circle', { class: 'dg-edge-handle', r: 6, 'data-endpoint': 'target', 'data-edge-key': key });
    const hint = svgElement('title');
    hint.textContent = 'Drag an endpoint to reconnect; drop on empty space to disconnect.';
    group.append(hint, hit, line, sourceHandle, targetHandle);
    this.edgesGroup.append(group);
    this.edges.set(key, { ...link, group, hit, line, sourceHandle, targetHandle });
    for (const id of [link.sourceId, link.targetId]) {
      if (!this.incident.has(id)) this.incident.set(id, new Set());
      this.incident.get(id).add(key);
    }
    this.paintEdge(key);
  }

  paintCard(id) {
    const position = this.positions.get(id);
    const card = this.cards.get(id);
    if (position && card) card.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
  }

  portPosition(id, side) {
    const position = this.positions.get(id);
    return position && { x: position.x + (side === 'out' ? CARD_WIDTH + PORT_OFFSET : -PORT_OFFSET), y: position.y + CARD_HEIGHT / 2 };
  }

  paintEdge(key) {
    const edge = this.edges.get(key);
    if (!edge) return;
    const start = this.portPosition(edge.sourceId, 'out');
    const end = this.portPosition(edge.targetId, 'in');
    if (!start || !end) return;
    const path = curve(start, end);
    edge.line.setAttribute('d', path);
    edge.hit.setAttribute('d', path);
    // Handles sit just beyond the card ports so either target can be grabbed.
    edge.sourceHandle.setAttribute('cx', start.x + 18);
    edge.sourceHandle.setAttribute('cy', start.y);
    edge.targetHandle.setAttribute('cx', end.x - 18);
    edge.targetHandle.setAttribute('cy', end.y);
  }

  updateSelection() {
    for (const [id, card] of this.cards) {
      card.classList.toggle('is-selected', this.selection.has(id));
      card.setAttribute('aria-selected', String(this.selection.has(id)));
    }
    for (const [key, edge] of this.edges) {
      edge.group.classList.toggle('is-selected', this.selectedEdge === key);
      edge.group.classList.toggle('has-selected-task', this.selection.has(edge.sourceId) || this.selection.has(edge.targetId));
    }
  }

  select(id, additive = false) {
    this.selectedEdge = null;
    if (!additive) this.selection.clear();
    if (id) {
      if (additive && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.updateSelection();
    this.callbacks.onSelect?.([...this.selection]);
  }

  selectTask(id) {
    if (!this.cards.has(id)) return false;
    this.select(id);
    const position = this.positions.get(id);
    this.camera.x = this.container.clientWidth / 2 - (position.x + CARD_WIDTH / 2) * this.camera.scale;
    this.camera.y = this.container.clientHeight / 2 - (position.y + CARD_HEIGHT / 2) * this.camera.scale;
    this.applyCamera();
    const card = this.cards.get(id);
    card.classList.add('is-located');
    card.focus({ preventScroll: true });
    return true;
  }

  worldPoint(event) {
    const rect = this.container.getBoundingClientRect();
    return { x: (event.clientX - rect.left - this.camera.x) / this.camera.scale, y: (event.clientY - rect.top - this.camera.y) / this.camera.scale };
  }

  capture(event) {
    this.interaction.lastPanTime = performance.now();
    this.container.setPointerCapture(event.pointerId);
    this.container.classList.add('is-interacting');
  }

  pointerDown(event) {
    if (event.button === 1) event.preventDefault();
    if (!this.workspace || this.interaction) return;
    if (event.button === 1) {
      this.interaction = { type: 'pan', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, lastPointer: { clientX: event.clientX, clientY: event.clientY }, moved: false };
      this.container.focus({ preventScroll: true });
      this.container.classList.add('is-panning');
      this.capture(event);
      return;
    }
    if (event.button !== 0) return;
    const target = event.target;
    const point = this.worldPoint(event);
    const port = target.closest('[data-port]');
    // A port's enlarged hit area can cover a nearby edge handle when zoomed
    // out. Preserve the handle under that padding as the rewire target.
    const endpoint = target.closest('[data-endpoint]') || (port && document.elementsFromPoint(event.clientX, event.clientY)
      .find(node => node.matches('.dg-edge-handle') && this.edgeLayer.contains(node)));
    const card = target.closest('.dg-task-card');
    const edgeNode = target.closest('.dg-edge');
    if (endpoint && !this.options.categoryView) {
      event.preventDefault();
      const edge = this.edges.get(endpoint.dataset.edgeKey);
      this.interaction = { type: 'link', pointerId: event.pointerId, edge, endpoint: endpoint.dataset.endpoint, start: point, moved: false };
      edge.group.classList.add('is-rewiring');
      this.container.classList.add('is-linking');
      this.capture(event);
      this.paintLinkPreview(point);
      return;
    }
    if (port) {
      event.preventDefault();
      this.interaction = { type: 'link', pointerId: event.pointerId, taskId: port.dataset.taskId, side: port.dataset.port, start: point, moved: false };
      this.capture(event);
      this.container.classList.add('is-linking');
      this.paintLinkPreview(point);
      return;
    }
    if (target.closest('button, input, textarea, select, [contenteditable="true"]')) return;
    if (edgeNode && event.button === 0 && !event.altKey) {
      event.preventDefault();
      this.selectedEdge = edgeNode.dataset.edgeKey;
      this.selection.clear();
      this.updateSelection();
      this.callbacks.onSelect?.([]);
      edgeNode.focus({ preventScroll: true });
      return;
    }
    if (card && !card.inert && event.button === 0 && !event.altKey) {
      event.preventDefault();
      const id = card.dataset.taskId;
      if (event.ctrlKey || event.metaKey) this.select(id, true);
      else if (!this.selection.has(id)) this.select(id);
      card.focus({ preventScroll: true });
      if (this.options.categoryView || this.tasks.get(id).deletedAt) return;
      this.animations.delete(id);
      this.interaction = { type: 'card', pointerId: event.pointerId, id, start: point, origin: { ...this.positions.get(id) }, moved: false };
      this.capture(event);
      return;
    }
    event.preventDefault();
    this.container.focus({ preventScroll: true });
    this.select(null);
  }

  pointerMove(event) {
    if (!this.interaction || event.pointerId !== this.interaction.pointerId) return;
    const heldButton = this.interaction.type === 'pan' ? 4 : 1;
    if (!(event.buttons & heldButton)) { this.cancelInteraction(); return; }
    this.pendingPointer = { clientX: event.clientX, clientY: event.clientY };
    this.requestFrame();
  }

  processPointer(event) {
    const interaction = this.interaction;
    if (!interaction) return;
    if (interaction.type === 'pan') {
      const previous = interaction.lastPointer;
      interaction.lastPointer = { clientX: event.clientX, clientY: event.clientY };
      interaction.moved ||= Math.hypot(event.clientX - interaction.startClient.x, event.clientY - interaction.startClient.y) > 4;
      this.camera.x += event.clientX - previous.clientX;
      if (this.verticalOverflow) this.camera.y += event.clientY - previous.clientY;
      this.applyCamera();
      return;
    }
    interaction.lastPointer = { clientX: event.clientX, clientY: event.clientY };
    const point = this.worldPoint(event);
    interaction.moved ||= Math.hypot(point.x - interaction.start.x, point.y - interaction.start.y) * this.camera.scale > 4;
    if (interaction.type === 'card' && interaction.moved) {
      const position = { x: interaction.origin.x + point.x - interaction.start.x, y: interaction.origin.y + point.y - interaction.start.y };
      this.positions.set(interaction.id, position);
      this.paintCard(interaction.id);
      for (const key of this.incident.get(interaction.id) || []) this.paintEdge(key);
      this.cards.get(interaction.id).classList.add('is-dragging');
      interaction.trash = !!this.callbacks.isTrashPoint?.(event.clientX, event.clientY);
      this.callbacks.onTrashHover?.(interaction.trash);
      const { column, row } = snapPosition(position, this.workspace.columns.length, this.tasks.values(), interaction.id);
      const valid = this.validMove(interaction.id, column);
      const appending = column === this.workspace.columns.length;
      interaction.drop = { column, row, valid };
      if (interaction.trash) this.endPlacement();
      else this.showPlacement({ column, row, valid, append: appending });
    } else if (interaction.type === 'link') {
      interaction.targetId = this.linkTarget(event, interaction);
      for (const [id, node] of this.cards) node.classList.toggle('is-link-target', id === interaction.targetId);
      this.paintLinkPreview(point);
    }
  }

  pointerUp(event) {
    if (!this.interaction || event.pointerId !== this.interaction.pointerId) return;
    this.processPointer(event);
    const interaction = this.interaction;
    this.interaction = null;
    this.pendingPointer = null;
    this.finishInteractionUi();
    if (this.container.hasPointerCapture(event.pointerId)) this.container.releasePointerCapture(event.pointerId);
    if (interaction.type === 'card' && interaction.moved) {
      if (interaction.trash) {
        this.dropToTrash(interaction.id);
        return;
      }
      const drop = interaction.drop;
      const target = drop?.valid ? { x: drop.column * COLUMN_STEP, y: TOP + drop.row * ROW_STEP } : pointFor(this.tasks.get(interaction.id));
      this.animatePosition(interaction.id, this.positions.get(interaction.id), target);
      if (!drop?.valid) this.toast('Connections must run from left to right. Disconnect the blocking link to move this card here.');
      else {
        const task = this.tasks.get(interaction.id);
        if (drop.column !== task.column || drop.row !== task.row) this.commit('moveTask', { taskId: interaction.id, column: drop.column, row: drop.row }, () => this.animatePosition(interaction.id, this.positions.get(interaction.id), pointFor(task)));
      }
    } else if (interaction.type === 'link' && interaction.moved) {
      const targetId = interaction.targetId;
      if (targetId) {
        const { sourceId, targetId: nextId } = this.linkPair(interaction, targetId);
        if (interaction.edge) {
          if (sourceId !== interaction.edge.sourceId || nextId !== interaction.edge.targetId) this.commit('rewireLink', { sourceId: interaction.edge.sourceId, targetId: interaction.edge.targetId, newSourceId: sourceId, newTargetId: nextId });
        } else this.commit('connectTask', { sourceId, targetId: nextId });
      } else if (interaction.edge && !document.elementFromPoint(event.clientX, event.clientY)?.closest('.dg-task-card')) {
        this.commit('removeLink', { sourceId: interaction.edge.sourceId, targetId: interaction.edge.targetId });
        this.toast('Connection removed. Press Ctrl + Z to undo.');
      } else this.toast(interaction.targetPlan?.reason || 'Drag to another card. Connecting can move linked cards to keep each arrow pointing right.');
    }
  }

  finishInteractionUi() {
    this.callbacks.onTrashHover?.(false);
    this.ghost.hidden = true;
    this.preview.style.display = 'none';
    this.linkHint.hidden = true;
    this.appendZone?.classList.remove('is-active');
    this.container.classList.remove('is-interacting', 'is-panning', 'is-linking');
    this.keyboardLink = null;
    for (const card of this.cards.values()) card.classList.remove('is-dragging', 'is-link-target');
    for (const edge of this.edges.values()) edge.group.classList.remove('is-rewiring');
  }

  cancelInteraction(restore = true) {
    const interaction = this.interaction;
    this.interaction = null;
    this.pendingPointer = null;
    this.finishInteractionUi();
    if (interaction?.type === 'card' && restore && this.tasks.has(interaction.id)) this.animatePosition(interaction.id, this.positions.get(interaction.id), pointFor(this.tasks.get(interaction.id)));
    if (interaction && this.container.hasPointerCapture(interaction.pointerId)) this.container.releasePointerCapture(interaction.pointerId);
  }

  async dropToTrash(id) {
    const card = this.cards.get(id), task = this.tasks.get(id);
    card?.classList.add('is-discarding');
    try {
      const saved = this.callbacks.onTrash ? await this.callbacks.onTrash(id) : await this.commit('deleteTask', { taskId: id });
      if (saved === false && task) this.animatePosition(id, this.positions.get(id), pointFor(task));
    } catch (error) {
      if (task) this.animatePosition(id, this.positions.get(id), pointFor(task));
      this.toast(error?.message || 'The task could not be moved to the bin.');
    } finally {
      card?.classList.remove('is-discarding');
    }
  }

  linkPair(interaction, targetId) {
    if (interaction.edge) return interaction.endpoint === 'source' ? { sourceId: targetId, targetId: interaction.edge.targetId } : { sourceId: interaction.edge.sourceId, targetId };
    return interaction.side === 'out' ? { sourceId: interaction.taskId, targetId } : { sourceId: targetId, targetId: interaction.taskId };
  }

  linkTarget(event, interaction) {
    const node = document.elementFromPoint(event.clientX, event.clientY)?.closest('.dg-task-card');
    if (!node || !this.container.contains(node)) {
      interaction.hoveredId = null;
      interaction.targetPlan = null;
      return null;
    }
    const candidate = node.dataset.taskId;
    if (interaction.hoveredId === candidate) return interaction.targetPlan?.valid ? candidate : null;
    interaction.hoveredId = candidate;
    const { sourceId, targetId } = this.linkPair(interaction, candidate);
    const source = this.tasks.get(sourceId);
    const target = this.tasks.get(targetId);
    interaction.targetPlan = interaction.edge
      ? { valid: validateConnection(source, target, this.workspace.links, interaction.edge), reason: !!source?.isArchived !== !!target?.isArchived ? ARCHIVE_LINK_REASON : 'Reconnecting must keep the arrow pointing from left to right.', column: target?.column, row: target?.row, movedCount: 0 }
      : planConnection(this.tasks, this.workspace.links, sourceId, targetId);
    return interaction.targetPlan.valid ? candidate : null;
  }

  paintLinkPreview(point) {
    const interaction = this.interaction;
    if (!interaction || interaction.type !== 'link') return;
    let start, end;
    if (interaction.edge) {
      start = interaction.endpoint === 'source' ? point : this.portPosition(interaction.edge.sourceId, 'out');
      end = interaction.endpoint === 'target' ? point : this.portPosition(interaction.edge.targetId, 'in');
    } else {
      start = interaction.side === 'out' ? this.portPosition(interaction.taskId, 'out') : point;
      end = interaction.side === 'in' ? this.portPosition(interaction.taskId, 'in') : point;
    }
    if (interaction.targetId) {
      const pair = this.linkPair(interaction, interaction.targetId);
      start = this.portPosition(pair.sourceId, 'out');
      end = this.portPosition(pair.targetId, 'in');
      const plan = interaction.targetPlan;
      if (plan?.movedCount) {
        const position = { x: plan.column * COLUMN_STEP, y: TOP + plan.row * ROW_STEP };
        end = { x: position.x - PORT_OFFSET, y: position.y + CARD_HEIGHT / 2 };
        this.ghost.hidden = false;
        this.ghost.classList.remove('is-invalid');
        this.ghost.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
        this.ghost.firstChild.textContent = 'Position after connecting';
      } else this.ghost.hidden = true;
    } else this.ghost.hidden = true;
    const plan = interaction.targetPlan;
    this.linkHint.hidden = !plan;
    if (plan) {
      this.linkHint.classList.toggle('is-invalid', !plan.valid);
      this.linkHint.textContent = !plan.valid ? plan.reason : plan.movedCount
        ? `Connect and move to column ${plan.column + 1}${plan.movedCount > 1 ? ` · ${plan.movedCount - 1} linked cards also move` : ''}`
        : interaction.edge ? 'Release to reconnect' : 'Release to connect';
      this.linkHint.style.left = `${clamp(point.x * this.camera.scale + this.camera.x + 20, 12, Math.max(12, this.container.clientWidth - 320))}px`;
      this.linkHint.style.top = `${clamp(point.y * this.camera.scale + this.camera.y + 24, 12, Math.max(12, this.container.clientHeight - 70))}px`;
    }
    this.preview.style.display = '';
    this.preview.classList.toggle('is-valid', !!interaction.targetId);
    this.preview.setAttribute('d', curve(start, end));
  }

  validMove(id, column) {
    return validateMove(this.tasks, this.workspace.links, id, column);
  }

  freeRow(column, desired, id) {
    return snapPosition({ x: column * COLUMN_STEP, y: TOP + desired * ROW_STEP }, this.workspace.columns.length, this.tasks.values(), id).row;
  }

  animatePosition(id, from, to) {
    if (!from || !to || !this.cards.has(id)) return;
    if (this.reducedMotion) {
      this.positions.set(id, { ...to });
      this.paintCard(id);
      for (const key of this.incident.get(id) || []) this.paintEdge(key);
      return;
    }
    this.positions.set(id, { ...from });
    this.paintCard(id);
    this.animations.set(id, { from: { ...from }, to: { ...to }, start: performance.now() });
    this.requestFrame();
  }

  requestFrame() {
    if (!this.frame) this.frame = requestAnimationFrame(time => this.tick(time));
  }

  panAtEdge(time) {
    const interaction = this.interaction;
    if (!interaction?.moved || interaction.type === 'pan' || interaction.trash || !interaction.lastPointer) return false;
    const rect = this.container.getBoundingClientRect();
    const pointer = interaction.lastPointer;
    const elapsed = clamp((time - interaction.lastPanTime) / 1000, 0, .04);
    interaction.lastPanTime = time;
    const speed = (position, size) => {
      const margin = Math.min(64, size / 4);
      if (position < margin) return -700 * Math.pow(clamp((margin - position) / margin, 0, 1), 2);
      if (position > size - margin) return 700 * Math.pow(clamp((position - size + margin) / margin, 0, 1), 2);
      return 0;
    };
    const vx = speed(pointer.clientX - rect.left, rect.width);
    const vy = this.verticalOverflow ? speed(pointer.clientY - rect.top, rect.height) : 0;
    if (!vx && !vy) return false;
    const { minX, minY } = this.cameraBounds();
    const x = clamp(this.camera.x - vx * elapsed, minX, CAMERA_LEFT);
    const y = clamp(this.camera.y - vy * elapsed, minY, CAMERA_TOP);
    if (Math.abs(x - this.camera.x) + Math.abs(y - this.camera.y) < .01) return false;
    this.camera.x = x;
    this.camera.y = y;
    this.applyCamera();
    this.processPointer(pointer);
    return true;
  }

  tick(time) {
    this.frame = 0;
    if (document.hidden || getComputedStyle(this.container).visibility === 'hidden') {
      this.pendingPointer = null;
      const dirtyEdges = new Set();
      for (const [id, animation] of this.animations) {
        this.positions.set(id, animation.to);
        this.paintCard(id);
        for (const key of this.incident.get(id) || []) dirtyEdges.add(key);
      }
      for (const key of dirtyEdges) this.paintEdge(key);
      this.animations.clear();
      return;
    }
    if (this.pendingPointer) {
      const event = this.pendingPointer;
      this.pendingPointer = null;
      this.processPointer(event);
    }
    const panning = this.panAtEdge(time);
    const dirtyEdges = new Set();
    for (const [id, animation] of this.animations) {
      const progress = clamp((time - animation.start) / 360, 0, 1);
      const t = 1 - Math.pow(1 - progress, 4);
      this.positions.set(id, { x: animation.from.x + (animation.to.x - animation.from.x) * t, y: animation.from.y + (animation.to.y - animation.from.y) * t });
      this.paintCard(id);
      for (const key of this.incident.get(id) || []) dirtyEdges.add(key);
      if (progress === 1) this.animations.delete(id);
    }
    for (const key of dirtyEdges) this.paintEdge(key);
    if (this.animations.size || this.pendingPointer || panning) this.requestFrame();
  }

  applyCamera() {
    this.camera.scale = clamp(this.camera.scale, this.minScale, 1);
    const { minX, minY } = this.cameraBounds();
    this.camera.x = clamp(this.camera.x, minX, CAMERA_LEFT);
    this.camera.y = clamp(this.camera.y, minY, CAMERA_TOP);
    this.stage.style.transform = `translate3d(${this.camera.x}px, ${this.camera.y}px, 0) scale(${this.camera.scale})`;
    this.container.style.setProperty('--graph-scale', this.camera.scale);
    const worldHeight = Math.max(this.container.clientHeight / this.camera.scale, this.contentHeight || 0);
    if (Math.abs(worldHeight - this.worldHeight) > .5) {
      this.worldHeight = worldHeight;
      for (const column of this.columnsLayer.children) column.style.height = `${worldHeight}px`;
    }
  }

  get verticalOverflow() {
    return (this.contentHeight || 0) * this.camera.scale + CAMERA_TOP > this.container.clientHeight + .5;
  }

  cameraBounds() {
    return {
      minX: Math.min(CAMERA_LEFT, this.container.clientWidth - (this.worldWidth || CARD_WIDTH) * this.camera.scale - CAMERA_LEFT),
      minY: this.verticalOverflow ? this.container.clientHeight - this.contentHeight * this.camera.scale : CAMERA_TOP
    };
  }

  latest() {
    const lastColumn = this.options.categoryView
      ? Math.max(0, ...[...this.positions.values()].map(position => position.x / COLUMN_STEP))
      : Math.max(0, (this.workspace?.columns.length || 1) - 1);
    const scale = clamp(this.camera.scale, this.minScale, 1);
    this.camera = { x: this.container.clientWidth / 2 - (lastColumn * COLUMN_STEP + CARD_WIDTH / 2) * scale, y: CAMERA_TOP, scale };
    this.applyCamera();
  }

  // The toolbar returns to the latest time slice without changing the chosen size.
  fit() { this.latest(); }

  zoom(scale, clientX, clientY) {
    if (!Number.isFinite(scale)) return;
    const bounds = this.container.getBoundingClientRect();
    const x = Number.isFinite(clientX) ? clientX - bounds.left : bounds.width / 2;
    const y = Number.isFinite(clientY) ? clientY - bounds.top : bounds.height / 2;
    const worldX = (x - this.camera.x) / this.camera.scale;
    const worldY = (y - this.camera.y) / this.camera.scale;
    this.camera.scale = clamp(scale, this.minScale, 1);
    this.camera.x = x - worldX * this.camera.scale;
    this.camera.y = y - worldY * this.camera.scale;
    this.applyCamera();
    if (this.interaction?.lastPointer) this.processPointer(this.interaction.lastPointer);
  }

  wheel(event) {
    if (event.target.closest('input, textarea, select')) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.container.clientHeight : 1;
    if (event.ctrlKey || event.metaKey) {
      this.zoom(this.camera.scale * Math.exp(-clamp(event.deltaY * unit, -1200, 1200) * .0015), event.clientX, event.clientY);
      return;
    }
    if (event.shiftKey) this.camera.x -= clamp((event.deltaY || event.deltaX) * unit, -1200, 1200);
    else if (this.verticalOverflow) this.camera.y -= clamp(event.deltaY * unit, -1200, 1200);
    this.applyCamera();
    if (this.interaction?.lastPointer) this.processPointer(this.interaction.lastPointer);
  }

  doubleClick(event) {
    // Pointer capture retargets click events; resolve the actual surface under the pointer.
    const target = document.elementFromPoint(event.clientX, event.clientY) || event.target;
    if (!this.container.contains(target) || target.closest('button, .dg-edge')) return;
    const card = target.closest('.dg-task-card');
    if (card) {
      this.callbacks.onEdit?.(card.dataset.taskId);
    } else if (this.workspace && !this.options.categoryView) {
      const point = this.worldPoint(event);
      const column = clamp(Math.round(point.x / COLUMN_STEP), 0, Math.min(255, this.workspace.columns.length));
      this.callbacks.onCreate?.({ sourceIds: [], column, row: this.freeRow(column, clamp(Math.round((point.y - TOP) / ROW_STEP), 0, 4095)) });
    }
  }

  keyDown(event) {
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.repeat && ['Enter', 'F2'].includes(event.key)) { event.preventDefault(); return; }
    if (event.key === 'Escape' && (this.interaction || this.keyboardLink)) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelInteraction();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const focusedEdge = event.target.closest('.dg-edge')?.dataset.edgeKey || this.selectedEdge;
      if (focusedEdge) {
        event.preventDefault();
        const edge = this.edges.get(focusedEdge);
        if (edge) this.commit('removeLink', { sourceId: edge.sourceId, targetId: edge.targetId });
      } else if (this.selection.size) {
        event.preventDefault();
        const ids = [...this.selection].filter(id => !this.tasks.get(id)?.deletedAt);
        this.commitSequence(ids.map(taskId => ['deleteTask', { taskId }]));
      }
      return;
    }
    if ((event.key === 'Enter' || event.key === 'F2') && this.selection.size === 1 && !event.target.closest('button')) {
      event.preventDefault();
      this.callbacks.onEdit?.([...this.selection][0]);
      return;
    }
    if (event.key === '0' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); this.fit(); return; }
    if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault();
      this.zoom(this.camera.scale * (event.key === '-' ? 1 / 1.15 : 1.15));
      return;
    }
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction) return;
    if (event.altKey || this.selection.size !== 1) {
      event.preventDefault();
      this.camera.x -= direction[0] * 80;
      if (this.verticalOverflow) this.camera.y -= direction[1] * 80;
      this.applyCamera();
    } else if (!this.options.categoryView) {
      event.preventDefault();
      const task = this.tasks.get([...this.selection][0]);
      if (task.deletedAt) return;
      const column = clamp(task.column + direction[0], 0, Math.min(255, this.workspace.columns.length));
      const row = this.freeRow(column, clamp(task.row + direction[1], 0, 4095), task.id);
      if (this.validMove(task.id, column)) this.commit('moveTask', { taskId: task.id, column, row });
      else this.toast('Connections must run from left to right. Disconnect the blocking link to move this card here.');
    }
  }

  async commit(command, payload, onError) {
    try {
      const result = await this.callbacks.onChange?.(command, payload);
      if (result === false) { onError?.(); return false; }
      return true;
    } catch (error) {
      onError?.();
      this.toast(error?.message || 'The operation could not be completed. Existing data is unchanged.');
      return false;
    }
  }

  async commitSequence(commands) {
    for (const [command, payload] of commands) if (!await this.commit(command, payload)) break;
  }

  toast(message) { this.callbacks.onToast?.(message); }

  keyboardPort(taskId, side) {
    if (!this.keyboardLink) {
      this.keyboardLink = { taskId, side };
      this.container.classList.add('is-linking');
      this.toast('Drag between two ports to connect. Tab and Enter also work. Esc cancels.');
      return;
    }
    const pair = this.linkPair(this.keyboardLink, taskId);
    const plan = planConnection(this.tasks, this.workspace.links, pair.sourceId, pair.targetId);
    if (!plan.valid) {
      this.toast(plan.reason);
      return;
    }
    this.keyboardLink = null;
    this.container.classList.remove('is-linking');
    if (plan.movedCount) this.toast(`Connecting moves this task to column ${plan.column + 1}${plan.movedCount > 1 ? ' and shifts the cards linked after it' : ''}.`);
    this.commit('connectTask', pair);
  }

  destroy() {
    this.cancelInteraction(false);
    this.abort.abort();
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.animations.clear();
    for (const sticker of this.stickers.values()) sticker.destroy();
    this.stickers.clear();
    this.cards.clear();
    this.container.replaceChildren();
  }
}

TaskGraph.nextId = 0;
