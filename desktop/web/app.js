import { TaskGraph, graphGeometry } from './graph.js';
import { Flock } from './flock.js';
import { StickerController } from './sticker.js';
import { mountCardLayers, createPaperTag, updatePaperTag, createNoteClip, fitCardText } from './paper.js';
import { TagPicker } from './tag-picker.js';
import { SceneMotion } from './scene.js';
import { CardCarry } from './card-carry.js';

const $ = id => document.getElementById(id);
const host = window.deskghost;
const stateNames = { NotStarted: 'To do', InProgress: 'In progress', Completed: 'Done', Stopped: 'Stopped' };
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
let composerSticker = null;
let cardEntrance = null;
let tagHoverTimer = 0;
let transferRequest = null;
let carry = null;
let returning = null;

function decorateKeys() {
  for (const button of document.querySelectorAll('button.key')) {
    const cap = document.createElement('span'); cap.className = 'cap'; cap.append(...button.childNodes);
    const plunger = document.createElement('span'); plunger.className = 'plunger'; plunger.append(cap);
    const well = document.createElement('span'); well.className = 'well'; well.append(plunger); button.append(well);
  }
}
function buttonLabel(id, text) { ($(id).querySelector('.cap') ?? $(id)).textContent = text; }
decorateKeys();
// The card can be held in front of a closed screen. It remains the same editor
// throughout writing, carrying and returning to its graph position.
document.body.append($('composer'), $('transfer-prompt'));
$('desk-scene').append($('task-trash'));

const flock = new Flock($('flock'));
const sceneMotion = new SceneMotion($('desk-scene'), $('scene-hook'), {
  onLayout: () => { queueRegions(); updateReturnTarget(); if (carry?.active?.moved && !carry.active.dropping) previewCarriedCard(carry.active); }
});
const graph = new TaskGraph($('graph-board'), {
  onSelect: ids => { selection = [...ids]; renderSelection(); },
  onEdit: (id, options) => openEditor(id, options),
  onToast: message => toast(message),
  onCreate: options => openCreator(options),
  isTrashPoint,
  onTrashHover: over => $('task-trash').classList.toggle('is-over', over),
  onTrash: async id => { await run('deleteTask', { taskId: id }); requireSaved(state.activeWorkspaceId); $('task-trash').classList.remove('is-over'); },
  onChange: async (command, payload) => {
    if (command === 'deleteTask' && draft?.kind === 'edit' && draft.taskId === payload.taskId) {
      await flushEdit(); closeComposer(false);
    }
    return run(command, payload);
  }
});

mountCardLayers($('detail-card'));
mountCardLayers($('detail-back'), { side: 'back' });
const editorTags = { front: {}, back: {} };
for (const side of ['front', 'back']) for (const kind of ['workspace', 'category']) {
  const button = createPaperTag({ kind, onClick: () => openTagPicker(kind, { focus: true, anchor: button }) });
  button.dataset.interactive = '';
  button.addEventListener('pointerenter', event => {
    if (event.pointerType !== 'mouse' || event.buttons) return;
    clearTimeout(tagHoverTimer); tagHoverTimer = setTimeout(() => openTagPicker(kind, { anchor: button }), 160);
  });
  button.addEventListener('pointerleave', () => clearTimeout(tagHoverTimer));
  editorTags[side][kind] = button; $(`${side}-tags`).append(button);
}
const noteClip = createNoteClip({ onClick: () => setCardFace('back', { focusNote: true }) });
noteClip.dataset.interactive = '';
noteClip.id = 'front-note-clip'; noteClip.hidden = true; $('front-note-clip').replaceWith(noteClip);
const tagPicker = new TagPicker($('tag-picker'), {
  items: kind => kind === 'workspace' ? state.documents.map(doc => ({ value: doc.id, label: doc.workspace.name })) :
    [...new Set(['', ...(composerWorkspace()?.categories ?? []), $('task-category').value])].map(value => ({ value, label: value || 'Uncategorized' })),
  value: kind => $(kind === 'workspace' ? 'task-workspace' : 'task-category').value,
  onChoose: choosePaperTag,
  onCreate: async (kind, name) => {
    const creating = draft, selectedWorkspaceId = $('task-workspace').value;
    if (kind === 'category') { await run('addCategory', { workspaceId: selectedWorkspaceId, category: name }); return name; }
    const result = await run('createWorkspace', { name });
    if (draft === creating) {
      populateComposerWorkspaces(selectedWorkspaceId);
      if (creating.kind === 'edit') await run('activateWorkspace', { workspaceId: creating.workspaceId });
    }
    return result.activeWorkspaceId;
  },
  onAdvance: () => { setCardFace('front'); $('task-description').focus({ preventScroll: true }); },
  onLayout: queueRegions
});

function activeDocument() { return state.documents.find(doc => doc.id === state.activeWorkspaceId) ?? state.documents[0]; }
function activeWorkspace() { return activeDocument()?.workspace; }
function option(value, text) { const result = document.createElement('option'); result.value = value; result.textContent = text; return result; }
function show(id, visible = true) {
  $(id).hidden = !visible;
  const trigger = { 'settings-panel': 'open-settings', 'search-panel': 'open-search', 'workspace-menu': 'workspace-toggle' }[id];
  if (trigger) $(trigger).setAttribute('aria-expanded', String(visible));
  queueRegions();
}
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
    ? `Not saved: ${doc.saveError || 'Retry saving or use Save as & continue.'}`
    : pending ? 'Editing / saving…' : `Saved locally${doc ? '\n' + doc.path : ''}`;
}

async function run(method, payload = {}, { quiet = false } = {}) {
  if (!host) throw new Error('Open this interface through the DeskGhost desktop application.');
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
  $('workspace-name').textContent = workspace?.name ?? 'Open workspace';
  $('undo').disabled = !activeDocument()?.canUndo;
  $('redo').disabled = !activeDocument()?.canRedo;
  $('new-task').disabled = !workspace;
  $('add-column').disabled = !workspace;
  $('close-workspace').disabled = !workspace;
  const category = $('search-category').value;
  $('search-category').replaceChildren(option('*', 'All categories'), option('', 'Uncategorized'), ...(workspace?.categories ?? []).map(value => option(value, value)));
  $('search-category').value = [...$('search-category').options].some(item => item.value === category) ? category : '*';
  renderWorkspaceList(); syncViewButtons(); renderGraph(); renderSelection(); refreshDetails(); updateSaveIndicator();
  const level = next.settings?.effects ?? 'high';
  if (level !== effects) {
    effects = level; document.documentElement.dataset.effects = level; flock.setEffects(level); sceneMotion.refreshEffects();
  }
  if (initialFocus && workspace) { initialFocus = false; requestAnimationFrame(() => graph.latest()); }
  if (previous !== state.activeWorkspaceId) requestAnimationFrame(() => graph.latest());
  queueRegions();
}

function renderWorkspaceList() {
  $('workspace-list').replaceChildren(...state.documents.map(doc => {
    const button = document.createElement('button'); button.className = 'workspace-item' + (doc.id === state.activeWorkspaceId ? ' active' : '');
    const dot = document.createElement('span'); dot.className = 'workspace-dot';
    const label = document.createElement('span'); label.textContent = doc.workspace.name;
    const count = document.createElement('small'); count.textContent = doc.workspace.tasks.filter(task => !task.deletedAt && !task.isArchived).length;
    button.append(dot, label, count); button.title = doc.path;
    button.addEventListener('click', async () => { try { await flushEdit(); closeComposer(false); await run('activateWorkspace', { workspaceId: doc.id }); closePopovers(); } catch { /* Error already surfaced. */ } });
    return button;
  }));
}

function currentFilters() { return { title: $('search-title').value.trim(), category: $('search-category').value === '*' ? null : $('search-category').value, state: $('search-state').value || null }; }
function visibleTasks() {
  const history = $('history-view').value;
  return (activeWorkspace()?.tasks ?? []).filter(task => history === 'trash' ? !!task.deletedAt : !task.deletedAt && (history === 'all' || (history === 'archived' ? task.isArchived : !task.isArchived)));
}
function renderGraph() {
  graph.setWorkspace(activeWorkspace() ?? null, { history: $('history-view').value, categoryView, filters: currentFilters(), workspaceName: activeWorkspace()?.name, workspaceId: state.activeWorkspaceId });
  const filter = currentFilters();
  const matches = visibleTasks().filter(task => (!filter.title || task.title.toLocaleLowerCase().includes(filter.title.toLocaleLowerCase())) && (filter.category === null || task.category === filter.category) && (!filter.state || task.state === filter.state));
  $('result-count').textContent = `${matches.length} results`;
  $('search-results').replaceChildren(...matches.map(task => {
    const button = document.createElement('button'); button.className = 'search-result'; button.setAttribute('role', 'listitem');
    const dot = document.createElement('span'); dot.className = 'result-marker';
    const label = document.createElement('span'); label.textContent = task.title;
    button.append(dot, label); button.title = `${task.category || 'Uncategorized'} · ${stateNames[task.state]}`;
    button.addEventListener('click', () => focusTask(task.id)); return button;
  }));
}

function renderSelection() {
  const selected = (activeWorkspace()?.tasks ?? []).filter(task => selection.includes(task.id));
  show('selection-tools', selected.length > 0 && mode === 'graph' && !draft);
  $('archive-selected').hidden = !selected.length || selected.some(task => !!task.deletedAt || task.isArchived || !['Completed', 'Stopped'].includes(task.state));
  $('restore-selected').hidden = !selected.length || selected.some(task => !task.deletedAt && !task.isArchived);
}

function setMode(next, { retreat = false } = {}) {
  if (next !== 'ready') { wand = null; $('wand-anchor').hidden = true; }
  mode = next; document.body.dataset.mode = next;
  sceneMotion.setOpen(next === 'graph');
  if (next === 'graph' || next === 'create' || next === 'idle') {
    flock.setMode(retreat ? 'disperse' : 'hidden');
  }
  renderSelection(); queueRegions();
}

async function hideManager() {
  if (draft?.kind === 'create') { toast('Finish this task or press Esc to cancel.'); $('task-title').focus(); return; }
  try { await flushEdit(); } catch { return; }
  closeComposer(false); closePopovers();
  await host?.invoke('hide');
  setMode('idle');
}

function updateComposerCategories() {
  const workspace = state.documents.find(doc => doc.id === $('task-workspace').value)?.workspace;
  $('category-suggestions').replaceChildren(...(workspace?.categories ?? []).map(category => option(category, category)));
  refreshDetails();
}

function composerWorkspace() { return state.documents.find(doc => doc.id === $('task-workspace').value)?.workspace; }
function populateComposerWorkspaces(selected) {
  $('task-workspace').replaceChildren(...state.documents.map(doc => option(doc.id, doc.workspace.name)));
  $('task-workspace').value = selected;
}
function openTagPicker(kind, { focus = false, anchor } = {}) {
  if (!draft || draft.busy || transferRequest) return;
  const side = $('card-rotor').dataset.face;
  tagPicker.open(kind, anchor ?? editorTags[side][kind], { focus });
}
async function choosePaperTag(kind, value) {
  if (!draft || draft.busy) return false;
  if (kind === 'workspace' && draft.kind === 'edit' && value !== draft.workspaceId) return requestWorkspaceTransfer(value);
  if (kind === 'workspace' && value !== state.activeWorkspaceId) {
    const choosing = draft;
    await run('activateWorkspace', { workspaceId: value });
    if (draft !== choosing) return false;
  }
  $(kind === 'workspace' ? 'task-workspace' : 'task-category').value = value;
  if (kind === 'workspace') updateComposerCategories();
  else { markEditDirty(); refreshDetails(); }
  return true;
}
function markEditDirty() {
  if (draft?.kind !== 'edit') return;
  draft.dirty = true; updateSaveIndicator(); clearTimeout(editTimer);
  editTimer = setTimeout(() => flushEdit().catch(() => {}), 650);
}
function setCardFace(side, { focusNote = false } = {}) {
  side = side === 'back' ? 'back' : 'front';
  const moveFocus = $('detail-card').contains(document.activeElement) || $('detail-back').contains(document.activeElement) || $('tag-picker').contains(document.activeElement);
  clearTimeout(tagHoverTimer); tagPicker.close(false); composerSticker?.cancelGesture();
  $('card-rotor').dataset.face = side;
  $('detail-card').inert = side !== 'front'; $('detail-card').setAttribute('aria-hidden', String(side !== 'front'));
  $('detail-back').inert = side !== 'back'; $('detail-back').setAttribute('aria-hidden', String(side !== 'back'));
  $('flip-card').setAttribute('aria-pressed', String(side === 'back'));
  $('flip-card').setAttribute('aria-label', side === 'back' ? 'Flip card to the front' : 'Flip card to the back');
  buttonLabel('flip-card', side === 'back' ? 'Front side' : 'Turn over');
  if (focusNote || moveFocus) (side === 'front' ? $('task-title') : draft?.noteAttached ? $('task-notes') : $('attach-note')).focus({ preventScroll: true });
  queueRegions();
}
function syncNote() {
  if (!draft) return;
  $('note-paper').classList.toggle('is-detached', !draft.noteAttached);
  $('task-notes').disabled = !draft.noteAttached || !!draft.busy;
  $('attach-note').hidden = !!draft.noteAttached;
  $('detach-note').hidden = !draft.noteAttached || !!$('task-notes').value.trim();
  noteClip.hidden = !draft.noteAttached;
}

async function requestWorkspaceTransfer(targetWorkspaceId) {
  if (draft?.kind !== 'edit' || transferRequest) return false;
  const editing = draft;
  await flushEdit();
  if (draft !== editing || transferRequest) return false;
  const target = state.documents.find(doc => doc.id === targetWorkspaceId);
  if (!target) throw new Error('This workspace is no longer open.');
  tagPicker.close(false);
  $('transfer-description').textContent = `Move this card to "${target.workspace.name}"? All its connections will be disconnected. Other cards will stay where they are.`;
  $('transfer-error').textContent = '';
  $('confirm-transfer').disabled = false; $('cancel-transfer').disabled = false;
  $('composer').inert = true;
  show('transfer-prompt'); $('cancel-transfer').focus({ preventScroll: true });
  return new Promise(resolve => { transferRequest = { editing, targetWorkspaceId, resolve }; });
}
function cancelWorkspaceTransfer() {
  if (!transferRequest || transferRequest.editing.busy) return;
  const request = transferRequest; transferRequest = null;
  show('transfer-prompt', false); $('composer').inert = false;
  request.resolve(false);
  if (draft === request.editing) editorTags[$('card-rotor').dataset.face].workspace.focus({ preventScroll: true });
}
async function confirmWorkspaceTransfer() {
  const request = transferRequest; if (!request || request.editing.busy) return;
  const editing = request.editing;
  $('confirm-transfer').disabled = true; $('cancel-transfer').disabled = true;
  editing.busy = true;
  try {
    editing.stateSaving = run('transferTask', { workspaceId: editing.workspaceId, targetWorkspaceId: request.targetWorkspaceId, taskId: editing.taskId }, { quiet: true });
    await editing.stateSaving;
    editing.workspaceId = request.targetWorkspaceId;
    populateComposerWorkspaces(editing.workspaceId);
    updateComposerCategories();
    transferRequest = null; show('transfer-prompt', false); $('composer').inert = false;
    request.resolve(true);
    editorTags[$('card-rotor').dataset.face].workspace.focus({ preventScroll: true });
    toast('Card moved. Its previous connections were removed.');
  } catch (error) { $('transfer-error').textContent = error.message; }
  finally {
    editing.busy = false; editing.stateSaving = null;
    $('confirm-transfer').disabled = false; $('cancel-transfer').disabled = false;
    if (draft === editing) refreshDetails();
  }
}

function refreshDetails() {
  if (!draft) return;
  const document = state.documents.find(doc => doc.id === (draft.kind === 'edit' ? draft.workspaceId : $('task-workspace').value));
  const workspace = document?.workspace;
  const task = draft.kind === 'edit' ? workspace?.tasks.find(item => item.id === draft.taskId) : null;
  $('detail-id').textContent = task?.id ?? 'Assigned on save';
  const created = task?.createdAt ? new Date(task.createdAt) : null;
  $('detail-created').textContent = created ? `${created.toISOString().slice(11, 16)} ${created.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${created.getUTCDate()}/${created.getUTCMonth() + 1}/${created.getUTCFullYear()}` : task ? 'Not recorded' : 'On save';
  $('detail-created').title = task?.createdAt ?? '';
  for (const tags of Object.values(editorTags)) {
    updatePaperTag(tags.workspace, { label: workspace?.name ?? 'Workspace', key: workspace?.id ?? '' });
    updatePaperTag(tags.category, { label: $('task-category').value || 'Uncategorized', key: $('task-category').value });
  }
  composerSticker?.update(task?.state ?? draft.state ?? 'NotStarted', { disabled: !!task?.isArchived || !!task?.deletedAt || !!draft.busy });
  fitEditorText();
  syncNote(); tagPicker.render();
}

function fitEditorText() {
  if (!draft || $('composer').hidden) return;
  fitCardText($('task-title'));
  const width = $('detail-back').clientWidth;
  fitCardText($('detail-id'), { maxSize: width * 18 / 621.3463 });
  fitCardText($('detail-created'), { maxSize: width * 30 / 621.3463 });
}

function revealComposer(sourceRect = null) {
  returning = null; $('composer').classList.remove('is-returning');
  cardEntrance?.cancel();
  show('composer');
  document.body.dataset.detail = draft.kind;
  $('graph-board').inert = true;
  $('manager').inert = true;
  setCardFace('front');
  renderSelection();
  composerSticker?.destroy();
  const task = activeWorkspace()?.tasks.find(item => item.id === draft.taskId);
  composerSticker = new StickerController($('composer-sticker'), {
    state: task?.state ?? draft.state ?? 'NotStarted', disabled: !!task?.isArchived,
    onChange: changeDetailState, onError: error => { $('composer-error').textContent = error.message || String(error); }
  });
  refreshDetails();
  if (sourceRect && effects !== 'off' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const card = $('card-perspective'), target = card.getBoundingClientRect();
    cardEntrance = card.animate([
      { transform: `translate(${sourceRect.left - target.left}px,${sourceRect.top - target.top}px) scale(${sourceRect.width / target.width},${sourceRect.height / target.height})` },
      { transform: 'none' }
    ], { duration: 310, easing: 'cubic-bezier(.2,.8,.2,1)' });
    cardEntrance.finished.then(() => { tagPicker.position(); queueRegions(); }).catch(() => {});
  }
  queueRegions();
}

async function changeDetailState(next) {
  if (draft?.kind === 'create') { draft.state = next; refreshDetails(); return; }
  if (draft?.kind !== 'edit' || draft.stateBusy || draft.busy) return;
  const editing = draft;
  await flushEdit();
  if (draft !== editing) return;
  editing.stateBusy = true;
  editing.stateSaving = run('setState', { workspaceId: editing.workspaceId, taskId: editing.taskId, state: next });
  try { await editing.stateSaving; }
  finally { editing.stateBusy = false; editing.stateSaving = null; if (draft === editing) refreshDetails(); }
}

async function openCreator(options = {}) {
  if (transferRequest) { $('cancel-transfer').focus({ preventScroll: true }); return; }
  if (draft?.kind === 'create') { setCardFace('front'); $('task-title').focus(); return; }
  if (draft?.kind === 'edit') {
    const editing = draft;
    try { await flushEdit(); } catch { return; }
    if (transferRequest) { $('cancel-transfer').focus({ preventScroll: true }); return; }
    if (draft !== editing) return;
  }
  if (!activeWorkspace()) {
    setMode('graph'); show('name-prompt'); $('workspace-input').focus();
    host?.invoke('summon', { mode: 'graph', internal: true }).catch(error => toast(error.message, true));
    return;
  }
  graph.setLiftedTask(null); carry?.reset();
  draft = { kind: 'create', workspaceId: state.activeWorkspaceId, dirty: false, noteAttached: false, state: 'NotStarted', ready: false };
  closePopovers();
  $('composer').classList.remove('editing');
  delete $('composer').dataset.ready; show('submit-task'); buttonLabel('submit-task', 'Done');
  $('task-title').value = options.seed ?? ''; $('task-category').value = ''; $('task-description').value = ''; $('task-notes').value = ''; $('composer-error').textContent = '';
  $('task-workspace').disabled = false;
  $('task-workspace').replaceChildren(...state.documents.map(doc => option(doc.id, doc.workspace.name)));
  $('task-workspace').value = draft.workspaceId; updateComposerCategories();
  setMode('create'); revealComposer();
  $('task-title').focus({ preventScroll: true }); $('task-title').setSelectionRange($('task-title').value.length, $('task-title').value.length);
  host?.invoke('summon', { mode: 'create', internal: true }).catch(error => toast(error.message, true));
  queueRegions();
}

async function openEditor(id, options = {}) {
  if (draft?.busy) return;
  try { await flushEdit(); } catch { return; }
  if (draft?.kind === 'create') { toast('Finish or cancel the task you are creating first.'); return; }
  const task = activeWorkspace()?.tasks.find(task => task.id === id);
  if (!task || task.deletedAt) return;
  const sourceRect = graph.getCardRect(id);
  graph.setLiftedTask(id);
  draft = { kind: 'edit', workspaceId: state.activeWorkspaceId, taskId: id, dirty: false, noteAttached: !!task.notes?.trim() };
  $('composer').style.left = ''; $('composer').style.top = '';
  $('composer').classList.add('editing'); delete $('composer').dataset.ready; show('submit-task'); buttonLabel('submit-task', 'Done');
  $('task-title').value = task.title; $('task-category').value = task.category; $('task-description').value = task.description; $('task-notes').value = task.notes ?? ''; $('composer-error').textContent = '';
  populateComposerWorkspaces(draft.workspaceId); $('task-workspace').disabled = false;
  updateComposerCategories();
  setMode('graph'); revealComposer(sourceRect); $('task-title').focus({ preventScroll: true });
  if (options.notes) setCardFace('back', { focusNote: true });
  if (options.tag) openTagPicker(options.tag, { focus: true });
}

function taskFields() { return { title: $('task-title').value.trim(), category: $('task-category').value.trim(), description: $('task-description').value, notes: $('task-notes').value }; }

async function flushEdit() {
  clearTimeout(editTimer);
  const editing = draft;
  if (editing?.kind !== 'edit') { await editSaving.catch(() => {}); return; }
  // Every caller shares the whole drain, including edits entered during a save.
  // Waiting only for one save could let a second caller close the editor while
  // its newest fields are still pending (and might subsequently be rejected).
  if (!editing.draining) {
    editing.draining = Promise.resolve().then(async () => {
      if (editing.stateSaving) await editing.stateSaving;
      do {
        if (draft !== editing) return;
        const hadFieldChanges = editing.dirty;
        if (editing.dirty) {
          const fields = taskFields();
          if (!fields.title) { $('composer-error').textContent = 'A title is required.'; $('task-title').focus(); throw new Error('Enter a task title to continue.'); }
          editing.dirty = false;
          editSaving = editSaving.catch(() => {}).then(() => run('updateTask', { workspaceId: editing.workspaceId, taskId: editing.taskId, ...fields }, { quiet: true }));
        }
        try {
          await editSaving;
          if (state.documents.find(doc => doc.id === editing.workspaceId)?.saveStatus === 'error') {
            await run('saveWorkspace', { workspaceId: editing.workspaceId }, { quiet: true });
            requireSaved(editing.workspaceId);
          }
          if (draft === editing) $('composer-error').textContent = '';
        }
        catch (error) { if (draft === editing) { if (hadFieldChanges) editing.dirty = true; $('composer-error').textContent = error.message; } throw error; }
        finally { updateSaveIndicator(); }
      } while (draft === editing && editing.dirty);
    }).finally(() => { editing.draining = null; });
  }
  await editing.draining;
}

function closeComposer(disperse = true, notifyHost = true) {
  if (draft?.busy) throw new Error('This task is being saved. Please wait.');
  cancelWorkspaceTransfer(); clearTimeout(tagHoverTimer); tagPicker.close(false);
  const creating = draft?.kind === 'create';
  clearTimeout(editTimer); draft = null; show('composer', false); $('composer-error').textContent = '';
  composerSticker?.destroy(); composerSticker = null; cardEntrance?.cancel(); cardEntrance = null;
  returning = null;
  carry?.reset(); graph.endPlacement(); graph.setLiftedTask(null); $('composer').classList.remove('is-returning'); $('task-trash').classList.remove('is-over');
  delete document.body.dataset.detail; $('graph-board').inert = false; $('manager').inert = false;
  if (mode === 'create' || mode === 'ready') setMode('idle', { retreat: disperse });
  if (creating && disperse && notifyHost) host?.invoke('hide', { disperse: true }).catch(error => toast(error.message, true));
  if (disperse) flock.setMode('disperse');
  renderSelection(); updateSaveIndicator();
}

async function submitTask(event) {
  event?.preventDefault();
  if (!draft || $('submit-task').disabled) return;
  if (draft.kind === 'edit') { try { await returnCard(); } catch (error) { $('composer-error').textContent = error.message; } return; }
  if (!readyToCarry()) return;
  $('card-grip').focus({ preventScroll: true });
}

function readyToCarry() {
  if (!draft || draft.busy || transferRequest) return false;
  if (!taskFields().title) { $('composer-error').textContent = 'Give this task a title.'; $('task-title').focus(); return false; }
  if (draft.kind === 'create') { draft.ready = true; $('composer').dataset.ready = 'true'; show('submit-task', false); }
  $('composer-error').textContent = '';
  return true;
}

async function placeCard(position = null) {
  if (!readyToCarry()) return;
  const submitting = draft;
  if (submitting.kind === 'edit') {
    try { await flushEdit(); } catch (error) { $('composer-error').textContent = error.message; return; }
  }
  if (draft !== submitting) return;
  const workspaceId = submitting.kind === 'edit' ? submitting.workspaceId : $('task-workspace').value;
  submitting.busy = true;
  for (const control of $('task-form').querySelectorAll('input,textarea,select,button')) control.disabled = true;
  try {
    if (submitting.kind === 'create') {
      const response = await run('createTask', { workspaceId, ...taskFields(), state: submitting.state, sourceIds: [], ...(position ? { column: position.column, row: position.row } : {}) }, { quiet: true });
      submitting.kind = 'edit'; submitting.taskId = response.result.taskId; submitting.workspaceId = workspaceId; submitting.dirty = false;
      graph.setLiftedTask(submitting.taskId);
    } else if (position) await run('moveTask', { workspaceId, taskId: submitting.taskId, column: position.column, row: position.row }, { quiet: true });
    requireSaved(workspaceId);
    if (workspaceId !== state.activeWorkspaceId) await run('activateWorkspace', { workspaceId });
    submitting.busy = false;
    setMode('graph');
    host?.invoke('summon', { mode: 'graph', internal: true }).catch(error => toast(error.message, true));
    if (!position) { preparePlacementView(submitting); graph.latest(); }
    await returnCard();
  } catch (error) { $('composer-error').textContent = error.message; }
  finally { submitting.busy = false; for (const control of $('task-form').querySelectorAll('input,textarea,select,button')) control.disabled = false; if (draft === submitting) refreshDetails(); }
}

function requireSaved(workspaceId) {
  const document = state.documents.find(doc => doc.id === workspaceId);
  if (document?.saveStatus === 'error') throw new Error(document.saveError || 'This card is not saved. Try placing it again.');
}

function preparePlacementView(editing) {
  categoryView = false;
  const task = editing?.kind === 'edit' ? state.documents.find(doc => doc.id === editing.workspaceId)?.workspace.tasks.find(task => task.id === editing.taskId) : null;
  $('history-view').value = task?.isArchived ? 'archived' : 'active';
  $('search-title').value = ''; $('search-category').value = '*'; $('search-state').value = '';
  syncViewButtons(); renderGraph();
}

async function returnCard() {
  const editing = draft;
  if (!editing || editing.busy || returning?.taskId === editing.taskId) return;
  await flushEdit();
  if (draft !== editing) return;
  tagPicker.close(false); cardEntrance?.cancel();
  if (mode !== 'graph') {
    preparePlacementView(editing); setMode('graph'); graph.latest();
    host?.invoke('summon', { mode: 'graph', internal: true }).catch(error => toast(error.message, true));
  }
  const card = $('card-perspective'), from = card.getBoundingClientRect();
  const target = graph.getCardRect(editing.taskId);
  setCardFace('front');
  delete document.body.dataset.detail;
  $('composer').classList.add('is-returning');
  if (target && effects !== 'off' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    card.style.transform = '';
    const base = card.getBoundingClientRect();
    const transform = rect => `translate(${rect.left - base.left}px,${rect.top - base.top}px) scale(${rect.width / base.width})`;
    cardEntrance = card.animate([{ transform: transform(from) }, { transform: transform(target) }], { duration: 420, easing: 'cubic-bezier(.22,.72,.2,1)', fill: 'forwards' });
    returning = { taskId: editing.taskId, from, transform, draft: editing };
    try { await cardEntrance.finished; } catch { /* A new user action may interrupt the return. */ }
  }
  if (returning?.draft === editing) returning = null;
  if (draft === editing) {
    closeComposer(false); graph.select(editing.taskId);
    (graph.cards.get(editing.taskId) ?? $('graph-board')).focus({ preventScroll: true });
  }
}

function updateReturnTarget() {
  if (!returning || cardEntrance?.playState !== 'running') return;
  const target = graph.getCardRect(returning.taskId);
  if (target) cardEntrance.effect.setKeyframes([{ transform: returning.transform(returning.from) }, { transform: returning.transform(target) }]);
}

function isTrashPoint(x, y) {
  const rect = $('task-trash').getBoundingClientRect();
  return x >= rect.left - 12 && x <= rect.right + 12 && y >= rect.top - 12 && y <= rect.bottom + 12;
}
function previewCarriedCard(drag) {
  if (!draft || !drag.point) return;
  const overTrash = isTrashPoint(drag.point.x, drag.point.y);
  $('task-trash').classList.toggle('is-over', overTrash);
  if (overTrash) { graph.endPlacement(); drag.placement = null; }
  else drag.placement = graph.previewPlacement(drag.left, drag.top, draft.kind === 'edit' ? draft.taskId : null);
}
carry = new CardCarry($('card-perspective'), $('card-grip'), {
  cardWidth: graphGeometry.cardWidth,
  onPick: () => {
    if (!readyToCarry()) return false;
    cardEntrance?.cancel(); cardEntrance = null; setCardFace('front');
    delete document.body.dataset.detail; $('manager').inert = false; $('graph-board').inert = false;
    preparePlacementView(draft); setMode('graph'); graph.latest();
    host?.invoke('summon', { mode: 'graph', internal: true }).catch(error => toast(error.message, true));
    return true;
  },
  onMove: previewCarriedCard,
  onDrop: async drag => {
    if (isTrashPoint(drag.point.x, drag.point.y)) {
      const editing = draft;
      if (editing.kind === 'edit') {
        await flushEdit(); editing.busy = true;
        try {
          const task = state.documents.find(doc => doc.id === editing.workspaceId)?.workspace.tasks.find(task => task.id === editing.taskId);
          await run(task?.deletedAt ? 'saveWorkspace' : 'deleteTask', { workspaceId: editing.workspaceId, taskId: editing.taskId }, { quiet: true });
          requireSaved(editing.workspaceId);
        }
        finally { editing.busy = false; }
      }
      closeComposer(false); setMode('graph');
    } else {
      previewCarriedCard(drag);
      if (drag.placement?.valid) await placeCard(drag.placement);
    }
  },
  onCancel: () => {
    graph.endPlacement(); $('task-trash').classList.remove('is-over');
    if (draft) { document.body.dataset.detail = draft.kind; $('manager').inert = true; $('graph-board').inert = true; fitEditorText(); $('card-grip').focus({ preventScroll: true }); }
  },
  onError: error => { $('composer-error').textContent = error.message || String(error); }
});

function focusTask(id) {
  const task = activeWorkspace()?.tasks.find(task => task.id === id); if (!task) return;
  if (task.deletedAt) $('history-view').value = 'trash';
  else if (task.isArchived) $('history-view').value = 'archived';
  else if (['trash', 'archived'].includes($('history-view').value)) $('history-view').value = 'active';
  if ($('search-state').value && $('search-state').value !== task.state) $('search-state').value = '';
  if ($('search-category').value !== '*' && $('search-category').value !== task.category) $('search-category').value = '*';
  if (!task.title.toLocaleLowerCase().includes($('search-title').value.trim().toLocaleLowerCase())) $('search-title').value = '';
  categoryView = false; syncViewButtons(); renderGraph(); graph.selectTask(id);
}

function positionComposer() {
  // The card and metadata share the same responsive layout for both summons.
  queueRegions();
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

function syncViewButtons() {
  const history = $('history-view').value;
  const active = ['archived', 'trash'].includes(history) ? 'archive-mode' : categoryView ? 'category-mode' : 'graph-mode';
  for (const id of ['graph-mode', 'category-mode', 'archive-mode']) {
    $(id).classList.toggle('active', id === active); $(id).setAttribute('aria-selected', String(id === active)); $(id).tabIndex = id === active ? 0 : -1;
  }
  for (const button of document.querySelectorAll('[data-state-filter]')) button.setAttribute('aria-pressed', String(button.dataset.stateFilter === $('search-state').value));
}
function bind(id, action) { $(id).addEventListener('click', () => Promise.resolve().then(action).catch(error => { if (error?.message) toast(error.message, true); })); }

bind('workspace-toggle', () => { const open = $('workspace-menu').hidden; closePopovers(); show('workspace-menu', open); $('workspace-toggle').setAttribute('aria-expanded', String(open)); });
bind('new-workspace', () => { closePopovers(); show('name-prompt'); $('workspace-input').value = ''; $('workspace-input').focus(); });
bind('open-workspace', async () => { await flushEdit(); closeComposer(false); await run('openWorkspace'); closePopovers(); });
bind('recover-workspace', async () => { await flushEdit(); closeComposer(false); await run('recoverWorkspace'); closePopovers(); });
bind('close-workspace', async () => { if (draft?.kind === 'create') throw new Error('Finish or cancel the current task first.'); await flushEdit(); closeComposer(false); await run('closeWorkspace'); closePopovers(); });
bind('open-trash', () => { $('history-view').value = 'trash'; categoryView = false; closePopovers(); syncViewButtons(); renderGraph(); graph.fit(); });
bind('export-workspace', async () => { await flushEdit(); await run('exportWorkspace'); closePopovers(); });
bind('save-as', async () => { await flushEdit(); await run('saveAs'); closePopovers(); });
bind('save-indicator', () => run('saveWorkspace'));
bind('new-task', () => openCreator());
bind('open-search', () => { const visible = $('search-panel').hidden; closePopovers(); show('search-panel', visible); if (visible) $('search-title').focus(); });
bind('clear-search', () => { $('search-title').value = ''; $('search-state').value = ''; $('search-category').value = '*'; syncViewButtons(); renderGraph(); });
for (const id of ['search-title', 'search-state', 'search-category', 'history-view']) $(id).addEventListener(id === 'search-title' ? 'input' : 'change', () => { syncViewButtons(); renderGraph(); renderSelection(); });
bind('graph-mode', () => { categoryView = false; $('history-view').value = 'active'; syncViewButtons(); renderGraph(); });
bind('category-mode', () => { categoryView = true; $('history-view').value = 'active'; syncViewButtons(); renderGraph(); graph.fit(); });
bind('archive-mode', () => { categoryView = false; $('history-view').value = 'archived'; syncViewButtons(); renderGraph(); graph.fit(); });
for (const button of document.querySelectorAll('[data-state-filter]')) button.addEventListener('click', () => {
  $('search-state').value = button.dataset.stateFilter; syncViewButtons(); renderGraph(); renderSelection();
});
bind('undo', async () => { await flushEdit(); if (draft?.kind === 'edit') closeComposer(false); await run('undo'); });
bind('redo', async () => { await flushEdit(); if (draft?.kind === 'edit') closeComposer(false); await run('redo'); });
bind('add-column', () => run('insertColumn', { index: activeWorkspace()?.columns.length ?? 0 }));
bind('fit-graph', () => graph.latest());
bind('archive-selected', async () => { await flushEdit(); for (const taskId of [...selection]) await run('archiveTask', { taskId }); });
bind('restore-selected', async () => { for (const taskId of [...selection]) { const task = activeWorkspace()?.tasks.find(task => task.id === taskId); await run(task?.deletedAt ? 'restoreTask' : 'unarchiveTask', { taskId }); } });
bind('hide-manager', hideManager);
bind('scene-ring', hideManager);
bind('flip-card', () => setCardFace($('card-rotor').dataset.face === 'back' ? 'front' : 'back'));
bind('attach-note', () => { if (!draft) return; draft.noteAttached = true; syncNote(); $('task-notes').focus({ preventScroll: true }); });
bind('detach-note', () => { if (!draft || $('task-notes').value.trim()) return; draft.noteAttached = false; $('task-notes').value = ''; syncNote(); markEditDirty(); });
bind('cancel-transfer', cancelWorkspaceTransfer);
bind('confirm-transfer', confirmWorkspaceTransfer);
$('task-form').addEventListener('submit', submitTask);
$('card-grip').addEventListener('keydown', async event => {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  if (draft?.kind === 'create' && !draft.ready) { await submitTask(); return; }
  await placeCard();
});
bind('task-trash', () => { if (!draft && mode === 'graph') { $('history-view').value = 'trash'; categoryView = false; syncViewButtons(); renderGraph(); graph.latest(); } });
$('task-workspace').addEventListener('change', updateComposerCategories);
for (const id of ['task-title', 'task-category', 'task-description', 'task-notes']) $(id).addEventListener('input', () => {
  if (id === 'task-title' && /[\r\n]/.test($('task-title').value)) {
    const input = $('task-title'), start = input.selectionStart, end = input.selectionEnd;
    const singleLine = value => value.replace(/[\r\n]+/g, ' ');
    const nextStart = singleLine(input.value.slice(0, start)).length, nextEnd = singleLine(input.value.slice(0, end)).length;
    input.value = singleLine(input.value); input.setSelectionRange(nextStart, nextEnd);
  }
  if (id === 'task-notes' && draft) { if ($('task-notes').value.trim()) draft.noteAttached = true; syncNote(); }
  if (id === 'task-category') refreshDetails();
  if (id === 'task-title') fitEditorText();
  markEditDirty();
});
$('task-title').addEventListener('beforeinput', event => { if (['insertLineBreak', 'insertParagraph'].includes(event.inputType)) event.preventDefault(); });
$('task-title').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.ctrlKey && !event.isComposing) event.preventDefault(); });
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
function syncEffectKeys() { for (const button of document.querySelectorAll('button[data-effects]')) button.setAttribute('aria-pressed', String(button.dataset.effects === $('setting-effects').value)); }
$('setting-effects').addEventListener('change', syncEffectKeys);
for (const button of document.querySelectorAll('button[data-effects]')) button.addEventListener('click', () => { $('setting-effects').value = button.dataset.effects; syncEffectKeys(); });
for (const button of document.querySelectorAll('[data-settings-tab]')) button.addEventListener('click', () => {
  for (const tab of document.querySelectorAll('[data-settings-tab]')) {
    const selected = tab === button; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; $('settings-' + tab.dataset.settingsTab).hidden = !selected;
  }
  queueRegions();
});

bind('open-settings', () => {
  closePopovers(); settingsFolder = null;
  $('setting-effects').value = state.settings.effects ?? 'high'; $('setting-gesture').checked = state.settings.gestureEnabled !== false;
  $('setting-roam').value = String(state.settings.idleRoamSeconds ?? 180);
  $('setting-dismiss-speed').value = String(state.settings.dismissSpeed ?? 1.5); $('dismiss-speed-value').value = Number($('setting-dismiss-speed').value).toFixed(1);
  $('setting-create-key').value = state.settings.createHotkey ?? 'Control+Alt+N'; $('setting-graph-key').value = state.settings.graphHotkey ?? 'Control+Alt+G';
  $('data-folder').textContent = state.settings.dataFolder ?? ''; $('settings-error').textContent = ''; syncEffectKeys(); show('settings-panel');
});
bind('choose-folder', async () => { const response = await run('chooseDataFolder'); settingsFolder = response?.result?.dataFolder ?? state.settings.dataFolder; $('data-folder').textContent = settingsFolder ?? ''; });
bind('apply-settings', async () => {
  try {
    await run('updateSettings', { effects: $('setting-effects').value, gestureEnabled: $('setting-gesture').checked, idleRoamSeconds: Number($('setting-roam').value), dismissSpeed: Number($('setting-dismiss-speed').value), createHotkey: $('setting-create-key').value, graphHotkey: $('setting-graph-key').value, ...(settingsFolder ? { dataFolder: settingsFolder } : {}) }, { quiet: true });
    show('settings-panel', false); toast('Settings saved.');
  } catch (error) { $('settings-error').textContent = error.message; }
});
async function quit() {
  if (draft?.kind === 'create') { toast('Finish this task or press Esc to cancel.', true); $('task-title').focus(); return; }
  try { await flushEdit(); await host.invoke('quit'); } catch (error) { toast(error.message, true, true); }
}
bind('quit-app', quit);
$('workspace-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('workspace-form').querySelector('button[type="submit"]');
  const name = $('workspace-input').value.trim(); if (!name || button.disabled) return;
  button.disabled = true;
  try {
    await flushEdit(); closeComposer(false); await run('createWorkspace', { name }); show('name-prompt', false); setMode('graph');
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
    if (carry.active?.moved) carry.cancel();
    else if (transferRequest) cancelWorkspaceTransfer();
    else if (!$('tag-picker').hidden) tagPicker.close();
    else if (['settings-panel', 'search-panel', 'workspace-menu', 'name-prompt'].some(id => !$(id).hidden)) closePopovers();
    else if (draft) { try { if (draft.kind === 'edit') await returnCard(); else closeComposer(); } catch { /* Retain invalid draft. */ } }
    else if (mode === 'ready') await host?.invoke('hide', { disperse: true });
    else await hideManager();
    return;
  }
  if (mode === 'ready') return;
  if (transferRequest) {
    if (event.key === 'Tab') { event.preventDefault(); ($(document.activeElement === $('cancel-transfer') ? 'confirm-transfer' : 'cancel-transfer')).focus(); }
    return;
  }
  const key = event.target.closest('button.key');
  if (key && !key.disabled && [' ', 'Enter'].includes(event.key)) key.classList.add('held');
  const tab = event.target.closest('[role="tab"]');
  if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); tabs[next].focus(); tabs[next].click(); return;
  }
  if (draft && event.ctrlKey && event.key === 'Enter') {
    event.preventDefault();
    if (event.target === $('task-title')) openTagPicker('category', { focus: true });
    else await submitTask();
  } else if (draft && event.altKey && event.key.toLowerCase() === 'w') { event.preventDefault(); openTagPicker('workspace', { focus: true }); }
  else if (draft && event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setCardFace($('card-rotor').dataset.face === 'back' ? 'front' : 'back'); }
  else if (event.ctrlKey && event.key.toLowerCase() === 'f' && mode === 'graph') { event.preventDefault(); show('search-panel'); $('search-title').focus(); }
  else if (!editing && event.ctrlKey && ['z', 'y'].includes(event.key.toLowerCase())) {
    event.preventDefault(); try { await flushEdit(); if (draft?.kind === 'edit') closeComposer(false); await run(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo'); } catch { /* Error surfaced. */ }
  } else if (!editing && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); openCreator(); }
});
function releaseKeys() { for (const key of document.querySelectorAll('.key.held')) key.classList.remove('held'); }
document.addEventListener('keyup', releaseKeys);
window.addEventListener('blur', releaseKeys);

function queueRegions() {
  if (regionFrame) return;
  regionFrame = requestAnimationFrame(() => {
    regionFrame = 0;
    if (mode === 'ready') return; // The preparation click surface uses the acknowledged path above.
    if (mode === 'idle') { host?.setRegions([], false); return; }
    const regions = [...document.querySelectorAll('[data-interactive]')].filter(element => {
      const style = getComputedStyle(element); return !element.closest('[inert]') && style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length;
    }).map(element => { const rect = element.getBoundingClientRect(); const x = Math.max(0, rect.x), y = Math.max(0, rect.y); return { x, y, width: Math.min(innerWidth, rect.right) - x, height: Math.min(innerHeight, rect.bottom) - y }; }).filter(rect => rect.width > 0 && rect.height > 0);
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
  if (draft?.kind === 'create') positionComposer();
  if (wand) { wand.revision++; updateWandRegion(wand); }
  tagPicker.position();
  fitEditorText();
  queueRegions();
});
new ResizeObserver(queueRegions).observe(document.body);
new ResizeObserver(() => {
  const dock = document.querySelector('.work-dock');
  if (dock.offsetHeight) document.documentElement.style.setProperty('--board-top', `${dock.offsetTop + dock.offsetHeight + 18}px`);
  queueRegions();
}).observe(document.querySelector('.work-dock'));
$('desk-scene').addEventListener('transitionend', event => {
  if (event.target !== $('desk-scene') || event.propertyName !== 'transform') return;
  tagPicker.position(); queueRegions();
});
new ResizeObserver(() => { if (draft?.kind === 'create') positionComposer(); fitEditorText(); tagPicker.position(); queueRegions(); }).observe($('card-perspective'));
document.fonts.ready.then(fitEditorText);

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
    if (transferRequest) {
      $('cancel-transfer').focus({ preventScroll: true });
      if (event.mode !== 'graph') await host.invoke('summon', { mode: 'graph', internal: true });
      return;
    }
    if (draft?.kind === 'create') {
      setCardFace('front');
      $('task-title').focus();
      if (event.mode !== 'create') await host.invoke('summon', { mode: 'create', internal: true });
    } else if (event.mode === 'create') await openCreator();
    else if (event.mode === 'ready') {
      if (draft) { await host.invoke('summon', { mode: 'graph', internal: true }); $('task-title').focus(); }
      else await showWand(event);
    } else if (draft) { $('card-grip').focus({ preventScroll: true }); }
    else { setMode('graph'); graph.latest(); $('graph-board').focus({ preventScroll: true }); }
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
