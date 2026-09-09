const SVG = 'http://www.w3.org/2000/svg';
const CARD_WIDTH = 266;
const CARD_HEIGHT = 184;
const COLUMN_STEP = 350;
const ROW_STEP = 232;
const TOP = 88;
const STATE_LABELS = { NotStarted: '未开始', InProgress: '进行中', Completed: '已完成', Stopped: '已停止' };
const STATES = Object.keys(STATE_LABELS);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const edgeKey = (source, target) => `${source}:${target}`;
const pointFor = (task) => ({ x: task.column * COLUMN_STEP, y: TOP + task.row * ROW_STEP });

export const graphGeometry = Object.freeze({ cardWidth: CARD_WIDTH, cardHeight: CARD_HEIGHT, columnStep: COLUMN_STEP, rowStep: ROW_STEP, top: TOP });

/** Strictly increasing logical columns make cycles impossible without graph traversal. */
export function validateConnection(source, target, links = [], replacedLink = null) {
  if (!source || !target || source.deletedAt || target.deletedAt || source.id === target.id || source.column >= target.column) return false;
  return !links.some(link => link.sourceId === source.id && link.targetId === target.id &&
    !(replacedLink && link.sourceId === replacedLink.sourceId && link.targetId === replacedLink.targetId));
}

export function snapPosition(position, columnCount, tasks = [], excludedId) {
  const column = clamp(Math.round(position.x / COLUMN_STEP), 0, Math.max(0, columnCount - 1));
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
    this.tasks = new Map();
    this.positions = new Map();
    this.edges = new Map();
    this.incident = new Map();
    this.animations = new Map();
    this.cameras = new Map();
    this.camera = { x: 66, y: 24, scale: 1 };
    this.frame = 0;
    this.pendingPointer = null;
    this.interaction = null;
    this.abort = new AbortController();
    this.container.classList.add('dg-graph');
    this.container.tabIndex = 0;
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-label', '任务图。拖动卡片移动，拖动圆点连接任务；方向键移动，Alt 加方向键平移视图。');
    this.stage = element('div', 'dg-graph-stage');
    this.columnsLayer = element('div', 'dg-columns');
    this.edgeLayer = svgElement('svg', { class: 'dg-edges', 'aria-label': '任务关联' });
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
    this.ghost.append(element('span', '', '松开以吸附'));
    this.ghost.hidden = true;
    this.preview = svgElement('path', { class: 'dg-edge-preview', fill: 'none' });
    this.preview.style.display = 'none';
    this.edgeLayer.append(this.preview);
    this.stage.append(this.columnsLayer, this.edgeLayer, this.ghost, this.cardsLayer);
    this.empty = element('div', 'dg-graph-empty');
    this.empty.append(element('span', 'dg-empty-symbol', '◇'), element('h2', '', '把想法，放在这里。'), element('p', '', '创建第一个任务，让每一步自然延续。'));
    const create = button('dg-empty-create', '创建任务', '＋  新建任务');
    create.addEventListener('click', () => callbacks.onCreate?.({ sourceIds: [], column: 0, row: 0 }));
    this.empty.append(create);
    this.help = element('div', 'dg-graph-help');
    this.help.append(element('span', '', '拖动圆点连接'), element('i'), element('span', '', '拖动空白平移'), element('i'), element('span', '', 'Ctrl + 滚轮缩放'));
    this.zoomLabel = element('output', 'dg-zoom-label', '100%');
    this.container.replaceChildren(this.stage, this.empty, this.help, this.zoomLabel);
    const events = { signal: this.abort.signal };
    this.container.addEventListener('pointerdown', (event) => this.pointerDown(event), events);
    this.container.addEventListener('pointermove', (event) => this.pointerMove(event), events);
    this.container.addEventListener('pointerup', (event) => this.pointerUp(event), events);
    this.container.addEventListener('pointercancel', () => this.cancelInteraction(), events);
    this.container.addEventListener('lostpointercapture', () => { if (this.interaction) this.cancelInteraction(); }, events);
    this.container.addEventListener('wheel', (event) => this.wheel(event), { ...events, passive: false });
    this.container.addEventListener('keydown', (event) => this.keyDown(event), events);
    this.container.addEventListener('dblclick', (event) => this.doubleClick(event), events);
    this.resizeObserver = new ResizeObserver(() => this.applyCamera());
    this.resizeObserver.observe(container);
    this.applyCamera();
  }

  get selectedIds() { return [...this.selection]; }

  setWorkspace(workspace, options = {}) {
    const previousPositions = new Map(this.positions);
    const changedWorkspace = this.workspace?.id !== workspace?.id;
    const changedView = Boolean(this.options.categoryView) !== Boolean(options.categoryView);
    if (changedWorkspace) {
      if (this.workspace) this.cameras.set(this.workspace.id, { ...this.camera });
      this.camera = this.cameras.get(workspace?.id) || { x: 66, y: 24, scale: 1 };
      this.selection.clear();
    }
    this.cancelInteraction(false);
    this.animations.clear();
    this.workspace = workspace;
    this.options = options;
    this.tasks = new Map((workspace?.tasks || []).slice(0, 2000).map(task => [task.id, task]));
    this.visibleTasks = [...this.tasks.values()].filter(task => this.isVisible(task));
    const visibleIds = new Set(this.visibleTasks.map(task => task.id));
    const previousSelectionSize = this.selection.size;
    this.selection = new Set([...this.selection].filter(id => visibleIds.has(id)));
    this.container.classList.toggle('is-category-view', !!options.categoryView);
    this.render();
    if (!changedWorkspace && !changedView && !this.reducedMotion) {
      for (const [id, position] of this.positions) {
        const previous = previousPositions.get(id);
        if (previous && Math.hypot(position.x - previous.x, position.y - previous.y) > .5)
          this.animatePosition(id, previous, position);
      }
    }
    if (changedView) this.fit();
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
    this.cards.clear();
    this.positions.clear();
    this.edges.clear();
    this.incident.clear();
    this.selectedEdge = null;
    this.cardsLayer.replaceChildren();
    this.columnsLayer.replaceChildren();
    this.edgesGroup.replaceChildren();
    this.empty.hidden = this.visibleTasks.length !== 0 || !this.workspace;
    const history = this.options.history;
    if (this.empty.querySelector('h2')) {
      this.empty.querySelector('h2').textContent = history === 'trash' ? '回收站是空的。' : history === 'archived' ? '这里，收藏走过的路。' : '把想法，放在这里。';
      this.empty.querySelector('p').textContent = history === 'trash' ? '删除的任务可在这里找回。' : history === 'archived' ? '已完成或已停止的任务可以归档，关联历史会被保留。' : '创建第一个任务，让每一步自然延续。';
      this.empty.querySelector('button').hidden = !!history && history !== 'active' && history !== 'all';
    }
    if (!this.workspace) return;
    let lanes;
    if (this.options.categoryView) {
      const categories = [...new Set(this.visibleTasks.map(task => task.category))];
      lanes = categories.map(category => ({ label: category || '未分类', tasks: this.visibleTasks.filter(task => task.category === category).sort((a, b) => a.column - b.column || a.row - b.row) }));
      lanes.forEach((lane, index) => lane.tasks.forEach((task, row) => this.positions.set(task.id, { x: index * COLUMN_STEP, y: TOP + row * ROW_STEP })));
    } else {
      lanes = this.workspace.columns.map((label, index) => ({ label, tasks: this.visibleTasks.filter(task => task.column === index) }));
      for (const task of this.visibleTasks) this.positions.set(task.id, pointFor(task));
    }
    const maxRow = Math.max(1, ...this.visibleTasks.map(task => this.positions.get(task.id).y / ROW_STEP));
    this.worldHeight = Math.max(700, (maxRow + 1) * ROW_STEP + TOP);
    this.worldWidth = Math.max(1, lanes.length) * COLUMN_STEP;
    lanes.forEach((lane, index) => {
      const column = element('section', 'dg-column');
      column.style.transform = `translateX(${index * COLUMN_STEP}px)`;
      column.style.height = `${this.worldHeight}px`;
      const heading = element('div', 'dg-column-heading');
      heading.append(element('span', 'dg-column-index', String(index + 1).padStart(2, '0')), element('h3', '', lane.label), element('span', 'dg-column-count', String(lane.tasks.length)));
      if (!this.options.categoryView && this.workspace.columns.length < 256) {
        const add = button('dg-insert-column', '在此列后插入逻辑时间列', '+');
        add.addEventListener('click', () => this.commit('insertColumn', { index: index + 1 }));
        heading.append(add);
      }
      column.append(heading);
      this.columnsLayer.append(column);
    });
    for (const task of this.visibleTasks) this.renderCard(task);
    if (!this.options.categoryView) {
      for (const link of (this.workspace.links || []).slice(0, 8000)) {
        if (this.cards.has(link.sourceId) && this.cards.has(link.targetId)) this.renderEdge(link);
      }
    }
    this.help.hidden = this.options.categoryView;
    this.updateSelection();
  }

  renderCard(task) {
    const card = element('article', 'dg-task-card');
    card.dataset.taskId = task.id;
    card.dataset.state = task.state;
    card.tabIndex = 0;
    card.setAttribute('aria-label', `${task.title}，${STATE_LABELS[task.state] || task.state}，第 ${task.column + 1} 阶段`);
    card.classList.toggle('is-dimmed', !this.matches(task));
    card.classList.toggle('is-archived', !!task.isArchived);
    card.classList.toggle('is-deleted', !!task.deletedAt);
    const head = element('div', 'dg-card-top');
    const state = button('dg-task-state', task.isArchived ? '已归档，恢复后可修改状态' : '点击切换任务状态', '');
    state.dataset.state = task.state;
    state.append(element('i', 'dg-state-dot'), element('span', '', STATE_LABELS[task.state] || task.state));
    state.disabled = !!task.isArchived || !!task.deletedAt;
    state.addEventListener('click', () => this.commit('setState', { taskId: task.id, state: STATES[(STATES.indexOf(task.state) + 1) % STATES.length] }));
    const more = element('div', 'dg-card-actions');
    if (!task.deletedAt) {
      const follow = button('dg-card-action', '创建后续任务', '↗');
      follow.addEventListener('click', () => {
        const sourceIds = this.selection.has(task.id) ? [...this.selection].filter(id => !this.tasks.get(id)?.deletedAt) : [task.id];
        this.callbacks.onCreate?.({ sourceIds, column: Math.max(...sourceIds.map(id => this.tasks.get(id).column)) + 1 });
      });
      more.append(follow);
      if (task.isArchived || task.state === 'Completed' || task.state === 'Stopped') {
        const archive = button('dg-card-action', task.isArchived ? '恢复归档任务' : '归档任务', task.isArchived ? '↶' : '↓');
        archive.addEventListener('click', () => this.commit(task.isArchived ? 'unarchiveTask' : 'archiveTask', { taskId: task.id }));
        more.append(archive);
      }
      const remove = button('dg-card-action dg-delete-action', '移至回收站（可撤销）', '×');
      remove.addEventListener('click', () => this.commit('deleteTask', { taskId: task.id }));
      more.append(remove);
    } else {
      const restore = button('dg-card-action', '恢复任务', '↶');
      restore.addEventListener('click', () => this.commit('restoreTask', { taskId: task.id }));
      more.append(restore);
    }
    head.append(state, more);
    const title = element('h3', 'dg-card-title', task.title);
    const description = element('p', 'dg-card-description', task.description || '双击卡片，记录想法…');
    description.classList.toggle('is-placeholder', !task.description);
    const footer = element('div', 'dg-card-footer');
    footer.append(element('span', 'dg-category-pill', task.category || '未分类'));
    if (task.isArchived) footer.append(element('span', 'dg-card-meta', '已归档'));
    else footer.append(element('span', 'dg-card-grip', '⠿'));
    card.append(head, title, description, footer);
    if (!task.deletedAt && !this.options.categoryView) {
      for (const side of ['in', 'out']) {
        const port = button(`dg-port dg-port-${side}`, side === 'in' ? '拖动以连接来源任务' : '拖动以连接后续任务', '');
        port.dataset.port = side;
        port.dataset.taskId = task.id;
        port.addEventListener('click', event => { if (event.detail === 0) this.keyboardPort(task.id, side); });
        card.append(port);
      }
    }
    this.cardsLayer.append(card);
    this.cards.set(task.id, card);
    this.paintCard(task.id);
  }

  renderEdge(link) {
    const key = edgeKey(link.sourceId, link.targetId);
    const group = svgElement('g', { class: 'dg-edge', 'data-edge-key': key, tabindex: 0, role: 'button', 'aria-label': `${this.tasks.get(link.sourceId)?.title} → ${this.tasks.get(link.targetId)?.title}，按 Delete 断开` });
    const hit = svgElement('path', { class: 'dg-edge-hit', fill: 'none' });
    const line = svgElement('path', { class: 'dg-edge-line', fill: 'none', 'marker-end': `url(#${this.markerId})` });
    const sourceHandle = svgElement('circle', { class: 'dg-edge-handle', r: 6, 'data-endpoint': 'source', 'data-edge-key': key });
    const targetHandle = svgElement('circle', { class: 'dg-edge-handle', r: 6, 'data-endpoint': 'target', 'data-edge-key': key });
    const hint = svgElement('title');
    hint.textContent = '拖动连线端点以改接；拖到空白处断开';
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
    return position && { x: position.x + (side === 'out' ? CARD_WIDTH : 0), y: position.y + CARD_HEIGHT / 2 };
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
    for (const [key, edge] of this.edges) edge.group.classList.toggle('is-selected', this.selectedEdge === key);
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
    card.classList.remove('is-located');
    void card.offsetWidth;
    card.classList.add('is-located');
    card.focus({ preventScroll: true });
    return true;
  }

  worldPoint(event) {
    const rect = this.container.getBoundingClientRect();
    return { x: (event.clientX - rect.left - this.camera.x) / this.camera.scale, y: (event.clientY - rect.top - this.camera.y) / this.camera.scale };
  }

  capture(event) {
    this.container.setPointerCapture(event.pointerId);
    this.container.classList.add('is-interacting');
  }

  pointerDown(event) {
    if (!this.workspace || (event.button !== 0 && event.button !== 1) || this.interaction) return;
    const target = event.target;
    const point = this.worldPoint(event);
    const endpoint = target.closest('[data-endpoint]');
    const port = target.closest('[data-port]');
    const card = target.closest('.dg-task-card');
    const edgeNode = target.closest('.dg-edge');
    if (endpoint && !this.options.categoryView) {
      event.preventDefault();
      const edge = this.edges.get(endpoint.dataset.edgeKey);
      this.interaction = { type: 'link', pointerId: event.pointerId, edge, endpoint: endpoint.dataset.endpoint, start: point, moved: false };
      edge.group.classList.add('is-rewiring');
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
    if (card && event.button === 0 && !event.altKey) {
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
    this.interaction = { type: 'pan', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, origin: { ...this.camera }, moved: false, preserveSelection: event.altKey || event.button === 1 };
    this.capture(event);
  }

  pointerMove(event) {
    if (!this.interaction || event.pointerId !== this.interaction.pointerId) return;
    this.pendingPointer = { clientX: event.clientX, clientY: event.clientY };
    this.requestFrame();
  }

  processPointer(event) {
    const interaction = this.interaction;
    if (!interaction) return;
    if (interaction.type === 'pan') {
      const dx = event.clientX - interaction.startClient.x;
      const dy = event.clientY - interaction.startClient.y;
      interaction.moved ||= Math.hypot(dx, dy) > 3;
      this.camera.x = interaction.origin.x + dx;
      this.camera.y = interaction.origin.y + dy;
      this.container.classList.toggle('is-panning', interaction.moved);
      this.applyCamera();
      return;
    }
    const point = this.worldPoint(event);
    interaction.moved ||= Math.hypot(point.x - interaction.start.x, point.y - interaction.start.y) * this.camera.scale > 4;
    if (interaction.type === 'card' && interaction.moved) {
      const position = { x: interaction.origin.x + point.x - interaction.start.x, y: interaction.origin.y + point.y - interaction.start.y };
      this.positions.set(interaction.id, position);
      this.paintCard(interaction.id);
      for (const key of this.incident.get(interaction.id) || []) this.paintEdge(key);
      this.cards.get(interaction.id).classList.add('is-dragging');
      const { column, row } = snapPosition(position, this.workspace.columns.length, this.tasks.values(), interaction.id);
      const valid = this.validMove(interaction.id, column);
      interaction.drop = { column, row, valid };
      this.ghost.hidden = false;
      this.ghost.classList.toggle('is-invalid', !valid);
      this.ghost.style.transform = `translate3d(${column * COLUMN_STEP}px, ${TOP + row * ROW_STEP}px, 0)`;
      this.ghost.firstChild.textContent = valid ? `第 ${column + 1} 阶段 · 松开以吸附` : '后续任务必须位于来源右侧';
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
    if (interaction.type === 'pan') {
      if (!interaction.moved && !interaction.preserveSelection) this.select(null);
      return;
    }
    if (interaction.type === 'card' && interaction.moved) {
      const drop = interaction.drop;
      const target = drop?.valid ? { x: drop.column * COLUMN_STEP, y: TOP + drop.row * ROW_STEP } : pointFor(this.tasks.get(interaction.id));
      this.animatePosition(interaction.id, this.positions.get(interaction.id), target);
      if (!drop?.valid) this.toast('后续任务必须保持在全部来源的右侧。');
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
        } else this.commit('addLink', { sourceId, targetId: nextId });
      } else if (interaction.edge && !document.elementFromPoint(event.clientX, event.clientY)?.closest('.dg-task-card')) {
        this.commit('removeLink', { sourceId: interaction.edge.sourceId, targetId: interaction.edge.targetId });
        this.toast('已断开连线，可按 Ctrl + Z 撤销。');
      } else this.toast('把连线拖到右侧后续任务，或从左端连接来源。');
    }
  }

  finishInteractionUi() {
    this.ghost.hidden = true;
    this.preview.style.display = 'none';
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

  linkPair(interaction, targetId) {
    if (interaction.edge) return interaction.endpoint === 'source' ? { sourceId: targetId, targetId: interaction.edge.targetId } : { sourceId: interaction.edge.sourceId, targetId };
    return interaction.side === 'out' ? { sourceId: interaction.taskId, targetId } : { sourceId: targetId, targetId: interaction.taskId };
  }

  linkTarget(event, interaction) {
    const node = document.elementFromPoint(event.clientX, event.clientY)?.closest('.dg-task-card');
    if (!node || !this.container.contains(node)) return null;
    const candidate = node.dataset.taskId;
    const { sourceId, targetId } = this.linkPair(interaction, candidate);
    const source = this.tasks.get(sourceId);
    const target = this.tasks.get(targetId);
    if (!validateConnection(source, target, this.workspace.links, interaction.edge)) return null;
    return candidate;
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
    if (this.animations.size || this.pendingPointer) this.requestFrame();
  }

  applyCamera() {
    this.stage.style.transform = `translate3d(${this.camera.x}px, ${this.camera.y}px, 0) scale(${this.camera.scale})`;
    this.container.style.setProperty('--graph-scale', this.camera.scale);
    this.zoomLabel.value = `${Math.round(this.camera.scale * 100)}%`;
    this.zoomLabel.textContent = this.zoomLabel.value;
  }

  zoomBy(factor, point) {
    const rect = this.container.getBoundingClientRect();
    const anchor = point || { x: rect.width / 2, y: rect.height / 2 };
    const previous = this.camera.scale;
    const next = clamp(previous * factor, .35, 1.65);
    this.camera.x = anchor.x - (anchor.x - this.camera.x) * next / previous;
    this.camera.y = anchor.y - (anchor.y - this.camera.y) * next / previous;
    this.camera.scale = next;
    this.applyCamera();
  }

  fit() {
    if (!this.positions.size) {
      this.camera = { x: 66, y: 24, scale: 1 };
    } else {
      const positions = [...this.positions.values()];
      const minX = Math.min(...positions.map(p => p.x));
      const minY = Math.min(...positions.map(p => p.y)) - TOP;
      const maxX = Math.max(...positions.map(p => p.x)) + CARD_WIDTH;
      const maxY = Math.max(...positions.map(p => p.y)) + CARD_HEIGHT;
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      const scale = clamp(Math.min((width - 120) / (maxX - minX), (height - 100) / (maxY - minY)), .35, 1);
      this.camera = { x: (width - (maxX - minX) * scale) / 2 - minX * scale, y: Math.max(18, (height - (maxY - minY) * scale) / 2) - minY * scale, scale };
    }
    this.applyCamera();
  }

  wheel(event) {
    if (event.target.closest('input, textarea, select') || this.interaction) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = this.container.getBoundingClientRect();
      this.zoomBy(Math.exp(-clamp(event.deltaY, -200, 200) * .002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.container.clientHeight : 1;
      this.camera.x -= clamp((event.shiftKey ? event.deltaY : event.deltaX) * unit, -1200, 1200);
      this.camera.y -= event.shiftKey ? 0 : clamp(event.deltaY * unit, -1200, 1200);
      this.applyCamera();
    }
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
      const column = clamp(Math.round(point.x / COLUMN_STEP), 0, this.workspace.columns.length - 1);
      this.callbacks.onCreate?.({ sourceIds: [], column, row: this.freeRow(column, clamp(Math.round((point.y - TOP) / ROW_STEP), 0, 4095)) });
    }
  }

  keyDown(event) {
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
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
    if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoomBy(1.12); return; }
    if (event.key === '-') { event.preventDefault(); this.zoomBy(1 / 1.12); return; }
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction) return;
    if (event.altKey || this.selection.size !== 1) {
      event.preventDefault();
      this.camera.x -= direction[0] * 80;
      this.camera.y -= direction[1] * 80;
      this.applyCamera();
    } else if (!this.options.categoryView) {
      event.preventDefault();
      const task = this.tasks.get([...this.selection][0]);
      if (task.deletedAt) return;
      const column = clamp(task.column + direction[0], 0, this.workspace.columns.length - 1);
      const row = this.freeRow(column, clamp(task.row + direction[1], 0, 4095), task.id);
      if (this.validMove(task.id, column)) this.commit('moveTask', { taskId: task.id, column, row });
      else this.toast('此位置会违反任务的前后关系。');
    }
  }

  async commit(command, payload, onError) {
    try {
      const result = await this.callbacks.onChange?.(command, payload);
      if (result === false) { onError?.(); return false; }
      return true;
    } catch (error) {
      onError?.();
      this.toast(error?.message || '操作未完成，已有数据保持不变。');
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
      this.toast('用 Tab 移至另一张卡片的圆点并按 Enter 连接；Esc 取消。');
      return;
    }
    const pair = this.linkPair(this.keyboardLink, taskId);
    if (!validateConnection(this.tasks.get(pair.sourceId), this.tasks.get(pair.targetId), this.workspace.links)) {
      this.toast('请选择不同的任务，并保持后续任务在来源右侧。');
      return;
    }
    this.keyboardLink = null;
    this.container.classList.remove('is-linking');
    this.commit('addLink', pair);
  }

  destroy() {
    this.cancelInteraction(false);
    this.abort.abort();
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.animations.clear();
    this.container.replaceChildren();
  }
}

TaskGraph.nextId = 0;
