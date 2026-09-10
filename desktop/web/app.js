import { TaskGraph } from './graph.js';
import { Flock } from './flock.js';

const $ = id => document.getElementById(id);
const host = window.deskghost;
const stateNames = { NotStarted: '未开始', InProgress: '进行中', Completed: '已完成', Stopped: '已停止' };
let state = { documents: [], settings: {}, activeWorkspaceId: null };
let mode = 'graph';
let categoryView = false;
let selection = [];
let draft = null;
let editTimer = 0;
let editSaving = Promise.resolve();
let toastTimer = 0;
let wand = null;
let effects = null;
let interactionHeld = false;
let regionFrame = 0;
let initialFocus = true;
let commandCount = 0;
let settingsFolder = null;

const flock = new Flock($('flock'));
const graph = new TaskGraph($('graph-board'), {
  onSelect: ids => { selection = [...ids]; renderSelection(); },
  onEdit: id => openEditor(id),
  onToast: message => toast(message),
  onCreate: options => openCreator(options),
  onChange: async (command, payload) => {
    if (command === 'deleteTask' && draft?.kind === 'edit' && draft.taskId === payload.taskId) {
      await flushEdit(); closeComposer(false);
    }
    return run(command, payload);
  }
});

function activeDocument() { return state.documents.find(doc => doc.id === state.activeWorkspaceId) ?? state.documents[0]; }
function activeWorkspace() { return activeDocument()?.workspace; }
function composerBounds() {
  const panel = $('composer');
  // Use its final layout, independent of the entrance animation's scale/offset.
  return { x: panel.offsetLeft - panel.offsetWidth / 2, y: panel.offsetTop - panel.offsetHeight / 2, width: panel.offsetWidth, height: panel.offsetHeight };
}
function option(value, text) { const result = document.createElement('option'); result.value = value; result.textContent = text; return result; }
function show(id, visible = true) { $(id).hidden = !visible; queueRegions(); }
function closePopovers() { for (const id of ['workspace-menu', 'search-panel', 'settings-panel', 'name-prompt']) show(id, false); $('workspace-toggle').setAttribute('aria-expanded', 'false'); }

function toast(message, error = false, persistent = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = String(message);
  $('toast').dataset.error = String(error);
  show('toast');
  if (!persistent) toastTimer = setTimeout(() => show('toast', false), error ? 6500 : 3400);
}

function updateSaveIndicator() {
  const doc = activeDocument();
  const pending = commandCount > 0 || draft?.dirty;
  $('save-indicator').dataset.state = doc?.saveStatus === 'error' ? 'error' : pending ? 'saving' : 'saved';
  $('save-indicator').title = doc?.saveStatus === 'error'
    ? `尚未保存：${doc.saveError || '请重试保存或另存并继续'}`
    : pending ? '正在编辑 / 保存…' : `已保存到本地${doc ? '\n' + doc.path : ''}`;
}

async function run(method, payload = {}, { quiet = false } = {}) {
  if (!host) throw new Error('请通过 DeskGhost 桌面程序打开此界面。');
  commandCount++; updateSaveIndicator();
  try {
    const response = await host.invoke(method, { workspaceId: state.activeWorkspaceId, ...payload });
    if (response?.documents) applyState(response);
    return response;
  } catch (error) {
    if (!quiet) toast(error.message || String(error), true);
    throw error;
  } finally { commandCount--; updateSaveIndicator(); }
}

function applyState(next) {
  const previous = state.activeWorkspaceId;
  state = next;
  state.activeWorkspaceId ||= state.documents[0]?.id ?? null;
  if (previous !== state.activeWorkspaceId) selection = [];
  const workspace = activeWorkspace();
  $('workspace-name').textContent = workspace?.name ?? '打开一片工作空间';
  $('undo').disabled = !activeDocument()?.canUndo;
  $('redo').disabled = !activeDocument()?.canRedo;
  $('new-task').disabled = !workspace;
  $('add-column').disabled = !workspace;
  $('close-workspace').disabled = !workspace;
  const tasks = workspace?.tasks.filter(task => !task.deletedAt && !task.isArchived) ?? [];
  $('board-stats').textContent = workspace ? `${tasks.length} 个当前任务  /  ${workspace.columns.length} 个逻辑阶段` : '打开或创建工作区，让想法留下来';
  const category = $('search-category').value;
  $('search-category').replaceChildren(option('*', '全部分类'), option('', '未分类'), ...(workspace?.categories ?? []).map(value => option(value, value)));
  $('search-category').value = [...$('search-category').options].some(item => item.value === category) ? category : '*';
  renderWorkspaceList(); renderGraph(); renderSelection(); updateSaveIndicator();
  const level = next.settings?.effects ?? 'high';
  if (level !== effects) {
    effects = level; document.documentElement.dataset.effects = level; flock.setEffects(level);
  }
  if (initialFocus && workspace) { initialFocus = false; requestAnimationFrame(() => graph.fit()); }
  if (previous !== state.activeWorkspaceId) requestAnimationFrame(() => graph.fit());
  queueRegions();
}

function renderWorkspaceList() {
  $('workspace-list').replaceChildren(...state.documents.map(doc => {
    const button = document.createElement('button'); button.className = 'workspace-item' + (doc.id === state.activeWorkspaceId ? ' active' : '');
    const dot = document.createElement('span'); dot.className = 'workspace-dot';
    const label = document.createElement('span'); label.textContent = doc.workspace.name;
    const count = document.createElement('small'); count.textContent = doc.workspace.tasks.filter(task => !task.deletedAt && !task.isArchived).length;
    button.append(dot, label, count); button.title = doc.path;
    button.addEventListener('click', async () => { try { await flushEdit(); await run('activateWorkspace', { workspaceId: doc.id }); closePopovers(); } catch { /* Error already surfaced. */ } });
    return button;
  }));
}

function currentFilters() { return { title: $('search-title').value.trim(), category: $('search-category').value === '*' ? null : $('search-category').value, state: $('search-state').value || null }; }
function visibleTasks() {
  const history = $('history-view').value;
  return (activeWorkspace()?.tasks ?? []).filter(task => history === 'trash' ? !!task.deletedAt : !task.deletedAt && (history === 'all' || (history === 'archived' ? task.isArchived : !task.isArchived)));
}
function renderGraph() {
  graph.setWorkspace(activeWorkspace() ?? null, { history: $('history-view').value, categoryView, filters: currentFilters() });
  const filter = currentFilters();
  const matches = visibleTasks().filter(task => (!filter.title || task.title.toLocaleLowerCase().includes(filter.title.toLocaleLowerCase())) && (filter.category === null || task.category === filter.category) && (!filter.state || task.state === filter.state));
  $('result-count').textContent = `${matches.length} 个结果`;
  $('search-results').replaceChildren(...matches.map(task => {
    const button = document.createElement('button'); button.className = 'search-result'; button.setAttribute('role', 'listitem');
    const dot = document.createElement('span'); dot.className = 'result-marker';
    const label = document.createElement('span'); label.textContent = task.title;
    button.append(dot, label); button.title = `${task.category || '未分类'} · ${stateNames[task.state]}`;
    button.addEventListener('click', () => focusTask(task.id)); return button;
  }));
}

function renderSelection() {
  const selected = (activeWorkspace()?.tasks ?? []).filter(task => selection.includes(task.id));
  $('selection-count').textContent = `${selected.length} 项已选`;
  show('selection-tools', selected.length > 0 && mode === 'graph');
  $('edit-selected').hidden = selected.length !== 1 || !!selected[0]?.deletedAt;
  $('continue-selected').hidden = selected.some(task => !!task.deletedAt);
  $('delete-selected').hidden = selected.some(task => !!task.deletedAt);
  $('archive-selected').hidden = !selected.length || selected.some(task => !!task.deletedAt || task.isArchived || !['Completed', 'Stopped'].includes(task.state));
  $('restore-selected').hidden = !selected.length || selected.some(task => !task.deletedAt && !task.isArchived);
}

function setMode(next, { retreat = false } = {}) {
  if (next !== 'ready') { wand = null; $('wand-anchor').hidden = true; }
  mode = next; document.body.dataset.mode = next;
  if (next === 'graph' || next === 'idle') {
    flock.setMode(retreat ? 'disperse' : 'hidden');
  }
  renderSelection(); queueRegions();
}

async function hideManager() {
  if (draft?.kind === 'create') { toast('先完成当前任务，或按 Esc 取消创建'); $('task-title').focus(); return; }
  try { await flushEdit(); } catch { return; }
  closeComposer(false); closePopovers();
  await host?.invoke('hide');
  setMode('idle');
}

function updateComposerCategories() {
  const workspace = state.documents.find(doc => doc.id === $('task-workspace').value)?.workspace;
  $('category-suggestions').replaceChildren(...(workspace?.categories ?? []).map(category => option(category, category)));
  const changed = draft && $('task-workspace').value !== draft.workspaceId;
  $('source-summary').textContent = changed ? '切换工作区后，将创建独立任务' : draft?.sourceIds?.length ? `从 ${draft.sourceIds.length} 个来源延续，自动吸附到下一逻辑列` : '';
  show('source-summary', !!$('source-summary').textContent);
}

async function openCreator(options = {}) {
  if (draft?.kind === 'create') { $('task-title').focus(); return; }
  if (draft?.kind === 'edit') { try { await flushEdit(); } catch { return; } }
  if (!activeWorkspace()) {
    setMode('graph'); show('name-prompt'); $('workspace-input').focus();
    host?.invoke('summon', { mode: 'graph', internal: true }).catch(error => toast(error.message, true));
    return;
  }
  draft = { kind: 'create', point: options.point, workspaceId: state.activeWorkspaceId, sourceIds: options.sourceIds ?? [], column: options.column, row: options.row, dirty: false };
  closePopovers();
  $('composer').classList.remove('editing');
  $('composer-eyebrow').textContent = '未开始'; $('composer-hint').innerHTML = '<kbd>Ctrl</kbd> + <kbd>Enter</kbd> 下一栏';
  $('submit-task').textContent = '创建任务 ↗'; $('task-title').value = options.seed ?? ''; $('task-category').value = ''; $('task-description').value = ''; $('composer-error').textContent = '';
  $('task-workspace').disabled = false;
  $('task-workspace').replaceChildren(...state.documents.map(doc => option(doc.id, doc.workspace.name)));
  $('task-workspace').value = draft.workspaceId; updateComposerCategories();
  show('edit-status-field', false); show('composer'); setMode('create'); positionComposer();
  $('task-title').focus({ preventScroll: true }); $('task-title').setSelectionRange($('task-title').value.length, $('task-title').value.length);
  flock.setMode('card', { bounds: composerBounds() });
  host?.invoke('summon', { mode: 'create', internal: true }).catch(error => toast(error.message, true));
  queueRegions();
}

async function openEditor(id) {
  if (draft?.busy) return;
  try { await flushEdit(); } catch { return; }
  if (draft?.kind === 'create') { toast('先完成或取消正在创建的任务'); return; }
  const task = activeWorkspace()?.tasks.find(task => task.id === id);
  if (!task || task.deletedAt) return;
  draft = { kind: 'edit', workspaceId: state.activeWorkspaceId, taskId: id, dirty: false };
  $('composer').style.left = ''; $('composer').style.top = '';
  $('composer').classList.add('editing'); $('composer-eyebrow').textContent = task.isArchived ? '已归档' : stateNames[task.state];
  $('composer-hint').textContent = '修改会自动保存'; $('submit-task').textContent = '完成编辑';
  $('task-title').value = task.title; $('task-category').value = task.category; $('task-description').value = task.description; $('task-state').value = task.state; $('composer-error').textContent = '';
  $('task-workspace').replaceChildren(option(draft.workspaceId, activeWorkspace().name)); $('task-workspace').value = draft.workspaceId; $('task-workspace').disabled = true;
  updateComposerCategories(); show('source-summary', false); show('edit-status-field'); show('composer');
  setMode('graph'); requestAnimationFrame(() => $('task-title').focus());
}

function taskFields() { return { title: $('task-title').value.trim(), category: $('task-category').value.trim(), description: $('task-description').value }; }

async function flushEdit() {
  clearTimeout(editTimer);
  const editing = draft;
  if (editing?.kind !== 'edit') { await editSaving.catch(() => {}); return; }
  // Drain edits made while a prior save was in flight before any caller closes
  // the editor, changes workspace, or acknowledges an application exit.
  do {
    if (editing.dirty) {
      const fields = taskFields();
      if (!fields.title) { $('composer-error').textContent = '标题还没有填写。'; $('task-title').focus(); throw new Error('请填写任务标题后继续'); }
      editing.dirty = false;
      editSaving = editSaving.catch(() => {}).then(() => run('updateTask', { workspaceId: editing.workspaceId, taskId: editing.taskId, ...fields }, { quiet: true }));
    }
    try { await editSaving; if (draft === editing) $('composer-error').textContent = ''; }
    catch (error) { if (draft === editing) { editing.dirty = true; $('composer-error').textContent = error.message; } throw error; }
    finally { updateSaveIndicator(); }
  } while (draft === editing && editing.dirty);
}

function closeComposer(disperse = true, notifyHost = true) {
  if (draft?.busy) throw new Error('任务正在保存，请稍候');
  const creating = draft?.kind === 'create';
  clearTimeout(editTimer); draft = null; show('composer', false); $('composer-error').textContent = '';
  if (mode === 'create' || mode === 'ready') setMode('idle', { retreat: disperse });
  if (creating && disperse && notifyHost) host?.invoke('hide', { disperse: true }).catch(error => toast(error.message, true));
  if (disperse) flock.setMode('disperse');
  updateSaveIndicator();
}

async function submitTask(event) {
  event?.preventDefault();
  if (!draft || $('submit-task').disabled) return;
  if (draft.kind === 'edit') { try { await flushEdit(); closeComposer(false); } catch { /* Keep draft visible. */ } return; }
  const fields = taskFields();
  if (!fields.title) { $('composer-error').textContent = '给这个想法起一个标题。'; $('task-title').focus(); return; }
  const submitting = draft;
  const workspaceId = $('task-workspace').value;
  submitting.busy = true;
  for (const control of $('task-form').querySelectorAll('input,textarea,select,button')) control.disabled = true;
  try {
    const sameWorkspace = workspaceId === submitting.workspaceId;
    const response = await run('createTask', { workspaceId, ...fields, sourceIds: sameWorkspace ? submitting.sourceIds : [], column: sameWorkspace ? submitting.column : undefined, row: sameWorkspace ? submitting.row : undefined }, { quiet: true });
    submitting.busy = false;
    closeComposer(false);
    if (workspaceId !== state.activeWorkspaceId) await run('activateWorkspace', { workspaceId });
    setMode('graph');
    host?.invoke('summon', { mode: 'graph', internal: true }).catch(error => toast(error.message, true));
    const id = response?.result?.taskId;
    if (id) requestAnimationFrame(() => focusTask(id));
    toast('已留下新的起点');
  } catch (error) { $('composer-error').textContent = error.message; }
  finally { submitting.busy = false; for (const control of $('task-form').querySelectorAll('input,textarea,select,button')) control.disabled = false; }
}

function focusTask(id) {
  const task = activeWorkspace()?.tasks.find(task => task.id === id); if (!task) return;
  if (task.deletedAt) $('history-view').value = 'trash';
  else if (task.isArchived) $('history-view').value = 'all';
  else if (['trash', 'archived'].includes($('history-view').value)) $('history-view').value = 'active';
  categoryView = false; syncViewButtons(); renderGraph(); graph.selectTask(id);
}

function positionComposer() {
  const panel = $('composer'), point = draft?.point;
  panel.style.left = point ? Math.max(panel.offsetWidth / 2 + 16, Math.min(innerWidth - panel.offsetWidth / 2 - 16, point.x)) + 'px' : '';
  panel.style.top = point ? Math.max(panel.offsetHeight / 2 + 16, Math.min(innerHeight - panel.offsetHeight / 2 - 16, point.y)) + 'px' : '';
}

async function showWand(event) {
  closePopovers(); setMode('ready');
  const anchor = $('wand-anchor');
  const current = wand = { activationId: event.activationId, point: event.point, revision: 0, pending: false, held: false };
  anchor.classList.add('is-pending'); anchor.hidden = false;
  flock.setMode('ring', { point: event.point });
  await updateWandRegion(current);
}

function wandRegion() { return { x: 0, y: 0, width: innerWidth, height: innerHeight }; }

async function updateWandRegion(current) {
  if (wand !== current || current.pending) return;
  const revision = current.revision;
  current.pending = true;
  try {
    // Only the summoned preparation state accepts a desktop click. Register
    // its native hit region before enabling the transparent click surface.
    const accepted = await host.invoke('setRegions', { readyActivation: current.activationId, regions: [wandRegion()], dragging: current.held });
    if (wand === current && accepted) $('wand-anchor').classList.remove('is-pending');
  } catch (error) {
    if (wand === current) { setMode('idle', { retreat: true }); await host.invoke('hide', { disperse: true }).catch(() => {}); toast(error.message, true); }
  } finally {
    current.pending = false;
    if (wand === current && current.revision !== revision) updateWandRegion(current);
  }
}

function followWand(point) {
  if (!wand) return;
  wand.point = point;
  if (!wand.held) flock.setTarget(point);
}

function syncViewButtons() { $('graph-mode').classList.toggle('active', !categoryView); $('category-mode').classList.toggle('active', categoryView); }
function bind(id, action) { $(id).addEventListener('click', () => Promise.resolve().then(action).catch(error => { if (error?.message) toast(error.message, true); })); }

bind('workspace-toggle', () => { const open = $('workspace-menu').hidden; closePopovers(); show('workspace-menu', open); $('workspace-toggle').setAttribute('aria-expanded', String(open)); });
bind('new-workspace', () => { closePopovers(); show('name-prompt'); $('workspace-input').value = ''; $('workspace-input').focus(); });
bind('open-workspace', async () => { await flushEdit(); await run('openWorkspace'); closePopovers(); });
bind('recover-workspace', async () => { await flushEdit(); await run('recoverWorkspace'); closePopovers(); });
bind('close-workspace', async () => { if (draft?.kind === 'create') throw new Error('先完成或取消当前任务创建'); await flushEdit(); closeComposer(false); await run('closeWorkspace'); closePopovers(); });
bind('export-workspace', async () => { await flushEdit(); await run('exportWorkspace'); closePopovers(); });
bind('save-as', async () => { await flushEdit(); await run('saveAs'); closePopovers(); });
bind('save-indicator', () => run('saveWorkspace'));
bind('new-task', () => openCreator());
bind('open-search', () => { const visible = $('search-panel').hidden; closePopovers(); show('search-panel', visible); if (visible) $('search-title').focus(); });
bind('clear-search', () => { $('search-title').value = ''; $('search-state').value = ''; $('search-category').value = '*'; renderGraph(); });
for (const id of ['search-title', 'search-state', 'search-category', 'history-view']) $(id).addEventListener(id === 'search-title' ? 'input' : 'change', () => { renderGraph(); renderSelection(); });
bind('graph-mode', () => { categoryView = false; syncViewButtons(); renderGraph(); });
bind('category-mode', () => { categoryView = true; syncViewButtons(); renderGraph(); graph.fit(); });
bind('undo', async () => { await flushEdit(); if (draft?.kind === 'edit') closeComposer(false); await run('undo'); });
bind('redo', async () => { await flushEdit(); if (draft?.kind === 'edit') closeComposer(false); await run('redo'); });
bind('add-column', () => run('insertColumn', { index: activeWorkspace()?.columns.length ?? 0 }));
bind('zoom-in', () => graph.zoomBy(1.15)); bind('zoom-out', () => graph.zoomBy(1 / 1.15)); bind('fit-graph', () => graph.fit());
bind('edit-selected', () => openEditor(selection[0]));
bind('continue-selected', () => openCreator({ sourceIds: [...selection] }));
bind('archive-selected', async () => { await flushEdit(); for (const taskId of [...selection]) await run('archiveTask', { taskId }); });
bind('restore-selected', async () => { for (const taskId of [...selection]) { const task = activeWorkspace()?.tasks.find(task => task.id === taskId); await run(task?.deletedAt ? 'restoreTask' : 'unarchiveTask', { taskId }); } });
bind('delete-selected', async () => { await flushEdit(); closeComposer(false); for (const taskId of [...selection]) await run('deleteTask', { taskId }); });
bind('hide-manager', hideManager);
$('task-form').addEventListener('submit', submitTask);
bind('close-composer', async () => { if (draft?.kind === 'edit') await flushEdit(); closeComposer(); });
$('task-workspace').addEventListener('change', updateComposerCategories);
for (const id of ['task-title', 'task-category', 'task-description']) $(id).addEventListener('input', () => {
  if (draft?.kind !== 'edit') return;
  draft.dirty = true; updateSaveIndicator(); clearTimeout(editTimer);
  editTimer = setTimeout(() => flushEdit().catch(() => {}), 650);
});
$('task-state').addEventListener('change', async () => {
  if (draft?.kind !== 'edit') return;
  const next = $('task-state').value; const id = draft.taskId; const workspaceId = draft.workspaceId;
  try { await flushEdit(); await run('setState', { workspaceId, taskId: id, state: next }); }
  catch { $('task-state').value = activeWorkspace()?.tasks.find(task => task.id === id)?.state ?? 'NotStarted'; }
});
$('task-form').addEventListener('focusin', event => {
  if (draft?.kind === 'edit') return;
  $('composer-hint').innerHTML = event.target === $('task-description') ? '<kbd>Ctrl</kbd> + <kbd>Enter</kbd> 创建任务' : '<kbd>Ctrl</kbd> + <kbd>Enter</kbd> 下一栏';
});
$('wand-anchor').addEventListener('pointerdown', event => {
  if (!wand || event.button !== 0) return;
  wand.held = true; wand.revision++;
  $('wand-anchor').setPointerCapture(event.pointerId);
  updateWandRegion(wand);
});
$('wand-anchor').addEventListener('lostpointercapture', () => {
  if (!wand) return;
  const current = wand;
  current.held = false; current.revision++;
  requestAnimationFrame(() => {
    if (wand !== current) return; // A completed click has already opened its card.
    updateWandRegion(current); followWand(current.point);
  });
});
$('wand-anchor').addEventListener('click', event => {
  if (!wand || event.button !== 0 || $('wand-anchor').classList.contains('is-pending')) return;
  // A real click anywhere in this viewport activates the native window. Open
  // and focus the existing title synchronously, using this click's position.
  openCreator({ point: { x: event.clientX, y: event.clientY } }).catch(error => toast(error.message, true));
});
$('setting-dismiss-speed').addEventListener('input', () => { $('dismiss-speed-value').value = Number($('setting-dismiss-speed').value).toFixed(1); });

bind('open-settings', () => {
  closePopovers(); settingsFolder = null;
  $('setting-effects').value = state.settings.effects ?? 'high'; $('setting-gesture').checked = state.settings.gestureEnabled !== false;
  $('setting-roam').value = String(state.settings.idleRoamSeconds ?? 180);
  $('setting-dismiss-speed').value = String(state.settings.dismissSpeed ?? 1.5); $('dismiss-speed-value').value = Number($('setting-dismiss-speed').value).toFixed(1);
  $('setting-create-key').value = state.settings.createHotkey ?? 'Control+Alt+N'; $('setting-graph-key').value = state.settings.graphHotkey ?? 'Control+Alt+G';
  $('data-folder').textContent = state.settings.dataFolder ?? ''; $('settings-error').textContent = ''; show('settings-panel');
});
bind('choose-folder', async () => { const response = await run('chooseDataFolder'); settingsFolder = response?.result?.dataFolder ?? state.settings.dataFolder; $('data-folder').textContent = settingsFolder ?? ''; });
bind('apply-settings', async () => {
  try {
    await run('updateSettings', { effects: $('setting-effects').value, gestureEnabled: $('setting-gesture').checked, idleRoamSeconds: Number($('setting-roam').value), dismissSpeed: Number($('setting-dismiss-speed').value), createHotkey: $('setting-create-key').value, graphHotkey: $('setting-graph-key').value, ...(settingsFolder ? { dataFolder: settingsFolder } : {}) }, { quiet: true });
    show('settings-panel', false); toast('已按你的方式调整');
  } catch (error) { $('settings-error').textContent = error.message; }
});
async function quit() {
  if (draft?.kind === 'create') { toast('请先完成当前任务，或按 Esc 取消创建', true); $('task-title').focus(); return; }
  try { await flushEdit(); await host.invoke('quit'); } catch (error) { toast(error.message, true, true); }
}
bind('quit-app', quit);
$('workspace-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('workspace-form').querySelector('button[type="submit"]');
  const name = $('workspace-input').value.trim(); if (!name || button.disabled) return;
  button.disabled = true;
  try {
    await flushEdit(); await run('createWorkspace', { name }); show('name-prompt', false); setMode('graph');
    await host.invoke('summon', { mode: 'graph', internal: true });
  } catch { /* Error surfaced by run. */ }
  finally { button.disabled = false; }
});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => show(button.dataset.close, false));

document.addEventListener('keydown', async event => {
  if (event.isComposing) return;
  const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || event.target.isContentEditable;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (draft) { try { if (draft.kind === 'edit') await flushEdit(); closeComposer(); } catch { /* Retain invalid draft. */ } }
    else if (['settings-panel', 'search-panel', 'workspace-menu', 'name-prompt'].some(id => !$(id).hidden)) closePopovers();
    else if (mode === 'ready') await host?.invoke('hide', { disperse: true });
    else await hideManager();
    return;
  }
  if (mode === 'ready') return;
  if (draft && event.ctrlKey && event.key === 'Enter') {
    event.preventDefault();
    if (event.target === $('task-title')) $('task-category').focus();
    else if (event.target === $('task-category')) $('task-description').focus();
    else await submitTask();
  } else if (draft && event.altKey && event.key.toLowerCase() === 'w') { event.preventDefault(); $('task-workspace').focus(); }
  else if (event.ctrlKey && event.key.toLowerCase() === 'f' && mode === 'graph') { event.preventDefault(); show('search-panel'); $('search-title').focus(); }
  else if (!editing && event.ctrlKey && ['z', 'y'].includes(event.key.toLowerCase())) {
    event.preventDefault(); try { await flushEdit(); if (draft?.kind === 'edit') closeComposer(false); await run(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo'); } catch { /* Error surfaced. */ }
  } else if (!editing && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); openCreator(); }
});

function queueRegions() {
  if (regionFrame) return;
  regionFrame = requestAnimationFrame(() => {
    regionFrame = 0;
    if (mode === 'ready') return; // The preparation click surface uses the acknowledged path above.
    const regions = [...document.querySelectorAll('[data-interactive]')].filter(element => {
      const style = getComputedStyle(element); return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length;
    }).map(element => { const rect = element.getBoundingClientRect(); return { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(innerWidth - Math.max(0, rect.x), rect.width), height: Math.min(innerHeight - Math.max(0, rect.y), rect.height) }; }).filter(rect => rect.width > 0 && rect.height > 0);
    host?.setRegions(regions, interactionHeld);
  });
}
document.addEventListener('pointerdown', event => {
  if (event.target.closest('[data-interactive]')) { interactionHeld = true; host?.setInteractive(true); queueRegions(); }
});
document.addEventListener('pointerup', () => { interactionHeld = false; queueRegions(); });
document.addEventListener('pointercancel', () => { interactionHeld = false; queueRegions(); });
// Native window activation owns dismissal. A Chromium focus transition can
// precede activation; a second asynchronous hide here would cancel a new summon.
window.addEventListener('blur', () => { interactionHeld = false; queueRegions(); });
document.addEventListener('pointermove', event => {
  if (mode !== 'ready' && !interactionHeld) host?.setInteractive(!!event.target.closest('[data-interactive]'));
}, { passive: true });
window.addEventListener('resize', () => {
  flock.resize();
  if (draft?.kind === 'create') { positionComposer(); flock.setMode('card', { bounds: composerBounds() }); }
  if (wand) { wand.revision++; updateWandRegion(wand); }
  queueRegions();
});
new ResizeObserver(queueRegions).observe(document.body);
new ResizeObserver(() => { if (draft?.kind === 'create') { positionComposer(); flock.setMode('card', { bounds: composerBounds() }); } queueRegions(); }).observe($('composer'));

host?.onEvent(async event => {
  if (event.type === 'state') applyState(event);
  else if (event.type === 'error') toast(event.message, true, true);
  else if (event.type === 'prepareExit') await quit();
  else if (event.type === 'prepareHide') await hideManager();
  else if (event.type === 'hide') {
    if (draft?.kind === 'create') return;
    try {
      await flushEdit(); closeComposer(event.disperse === true, false); closePopovers(); setMode('idle', { retreat: event.disperse === true });
    } catch { /* Retain editor. */ }
  } else if (event.type === 'summon') {
    if (draft?.kind === 'create') {
      $('task-title').focus();
      if (event.mode !== 'create') await host.invoke('summon', { mode: 'create', internal: true });
    } else if (event.mode === 'create') await openCreator();
    else if (event.mode === 'ready') {
      if (draft) { await host.invoke('summon', { mode: 'graph', internal: true }); $('task-title').focus(); }
      else await showWand(event);
    } else { setMode('graph'); $('graph-board').focus({ preventScroll: true }); }
  } else if (event.type === 'cursorPoint' && mode === 'ready') followWand(event.point);
  else if (event.type === 'roaming' && mode === 'idle') flock.setMode(event.active ? 'roaming' : 'disperse');
  else if (event.type === 'disperse' && mode === 'ready') closeComposer(true, false);
});

async function bootstrap() {
  show('retry-boot', false);
  try {
    await run('bootstrap', {}, { quiet: true });
    show('boot-screen', false); setMode('graph');
    if (state.warnings?.length) toast(state.warnings.join('\n'), true, true);
  } catch (error) { $('boot-message').textContent = error.message; show('retry-boot'); }
}
bind('retry-boot', bootstrap);
bootstrap();
