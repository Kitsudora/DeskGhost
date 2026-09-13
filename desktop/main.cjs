'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, globalShortcut, screen, dialog, powerMonitor } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { CircleGestureRecognizer, SpeedDismissRecognizer } = require('./gesture.cjs');

const projectRoot = path.resolve(__dirname, '..');
const dataIndex = process.argv.indexOf('--data-dir');
const baseFolder = dataIndex >= 0 && process.argv[dataIndex + 1]
  ? path.resolve(process.argv[dataIndex + 1])
  : path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'DeskGhost');
app.setPath('userData', path.join(baseFolder, 'web-runtime'));
const settingsPath = path.join(baseFolder, 'web-settings.json');
const webRoot = path.join(__dirname, 'web');
const rendererPath = path.join(webRoot, 'index.html');
const rendererUrl = pathToFileURL(rendererPath).href;
const defaults = { formatVersion: 1, dataFolder: path.join(baseFolder, 'Workspaces'), createHotkey: 'Ctrl+Alt+N', graphHotkey: 'Ctrl+Alt+G', gestureEnabled: true, effects: 'high', idleRoamSeconds: 180, dismissSpeed: 1.5, openFiles: [] };
let settings = { ...defaults }, settingsInvalid = false, settingsWarning = null;
let win, tray, bridge, startup, lastState = { documents: [], activeWorkspaceId: null, result: null };
let quitting = false, exitRequested = false, mode = 'graph', interactive = false, regions = [], dragUntil = 0;
let sampleTimer, rendererReady = false, suspended = false, lastCursor = null, warningList = [];
let cursorFailures = 0;
let activationId = 0, activationPending = false, activationTimer;
let readyEscapeRegistered = false;
let roaming = false, nextRoamCheck = 0;
let pendingOperations = 0, operationQueue = Promise.resolve();
const rescuedSnapshots = new Map();
const circles = new CircleGestureRecognizer(), speedDismiss = new SpeedDismissRecognizer();
const mutationMethods = new Set(['createTask', 'updateTask', 'setState', 'moveTask', 'transferTask', 'insertColumn', 'renameColumn', 'renameWorkspace', 'addCategory', 'addLink', 'connectTask', 'removeLink', 'rewireLink', 'deleteTask', 'restoreTask', 'archiveTask', 'unarchiveTask', 'undo', 'redo', 'saveWorkspace', 'closeWorkspace', 'activateWorkspace']);

class CoreBridge {
  constructor() {
    this.counter = 0; this.pending = new Map(); this.buffer = ''; this.failed = false;
    const published = path.join(process.resourcesPath, 'bridge', 'DeskGhost.Bridge.exe');
    const developmentPublished = path.join(projectRoot, 'artifacts', 'bridge', 'DeskGhost.Bridge.exe');
    const dll = path.join(projectRoot, 'src', 'DeskGhost.Bridge', 'bin', 'Release', 'net10.0', 'DeskGhost.Bridge.dll');
    const localDotnet = path.join(projectRoot, '.tools', 'dotnet', 'dotnet.exe');
    let command, args;
    if (app.isPackaged) { command = published; args = []; }
    else if (fs.existsSync(dll)) { command = fs.existsSync(localDotnet) ? localDotnet : 'dotnet'; args = [dll]; }
    else { command = developmentPublished; args = []; }
    this.process = spawn(command, args, { cwd: app.isPackaged ? path.dirname(published) : projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', chunk => this.receive(chunk));
    this.process.stderr.on('data', () => {});
    this.process.once('error', error => this.fail(new Error('Cannot start the data service: ' + error.message)));
    this.process.once('exit', () => { if (!quitting && !this.closed) this.fail(new Error('The data service stopped. Saved files are preserved; restart the app.')); });
    this.process.stdin.on('error', error => this.fail(error));
  }
  receive(chunk) {
    if (this.failed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > 20 * 1024 * 1024) { this.fail(new Error('The data service response exceeded its size limit and was safely stopped.')); return; }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { this.fail(new Error('The data service returned a malformed message.')); return; }
      const waiting = this.pending.get(reply.id);
      if (!waiting) { this.fail(new Error('The data service returned an unexpected response.')); return; }
      clearTimeout(waiting.timer); this.pending.delete(reply.id);
      if (reply.ok) waiting.resolve(reply.data); else waiting.reject(new Error(reply.error || 'The data operation failed.'));
    }
  }
  request(method, payload = {}) {
    if (this.failed) return Promise.reject(new Error('The data service is unavailable. Restart the app; saved files are preserved.'));
    if (this.pending.size >= 4) return Promise.reject(new Error('The data service is busy. Try again shortly.'));
    const id = String(++this.counter), line = JSON.stringify({ id, method, payload }) + '\n';
    if (Buffer.byteLength(line, 'utf8') > 256 * 1024) return Promise.reject(new Error('The operation exceeds the allowed size.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('The data service timed out. Editing is paused; valid files on disk are unchanged.')), 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(line, 'utf8', error => { if (error) this.fail(error); });
    });
  }
  fail(error) {
    if (this.failed || this.closed) return;
    this.failed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.process.kill();
    send({ type: 'error', message: error.message });
    if (win && !win.isDestroyed()) setInteractive(false);
  }
  close() { this.closed = true; this.process.stdin.end(); setTimeout(() => this.process.kill(), 1500).unref(); }
}

function send(event) { if (rendererReady && win && !win.isDestroyed()) win.webContents.send('deskghost:event', event); }
function stateEnvelope() { return { ...lastState, settings: { ...settings }, warnings: [...warningList, ...(settingsWarning ? [settingsWarning] : [])] }; }
function acceptState(state, emit = true) {
  lastState = state;
  const value = stateEnvelope();
  if (emit) send({ type: 'state', ...value });
  return value;
}
function checkSettings(value) {
  if (value && !Object.hasOwn(value, 'idleRoamSeconds')) value = { ...value, idleRoamSeconds: defaults.idleRoamSeconds };
  if (value && !Object.hasOwn(value, 'dismissSpeed')) value = { ...value, dismissSpeed: defaults.dismissSpeed };
  if (!value || value.formatVersion !== 1 || typeof value.dataFolder !== 'string' || !value.dataFolder.trim() || value.dataFolder.length > 1024 || !path.isAbsolute(value.dataFolder) ||
    !['high', 'low', 'off'].includes(value.effects) || typeof value.gestureEnabled !== 'boolean' || ![0, 180, 300, 600].includes(value.idleRoamSeconds) ||
    !Number.isFinite(value.dismissSpeed) || value.dismissSpeed < 0.5 || value.dismissSpeed > 4 ||
    !Array.isArray(value.openFiles) || value.openFiles.length > 12 || value.openFiles.some(p => typeof p !== 'string' || !path.isAbsolute(p) || p.length > 1024)) throw new Error('The settings file contains invalid data.');
  for (const key of ['createHotkey', 'graphHotkey']) if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 80) throw new Error('The global shortcut is invalid.');
  return value;
}
async function readJsonBounded(file) {
  const handle = await fsp.open(file, 'r');
  try {
    if ((await handle.stat()).size > 64 * 1024) throw new Error('The settings file is too large.');
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 64 * 1024) throw new Error('The settings file exceeded its size limit while being read.');
    return JSON.parse(buffer.subarray(0, length).toString('utf8').replace(/^\uFEFF/, ''));
  }
  finally { await handle.close(); }
}
async function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) settings = checkSettings(await readJsonBounded(settingsPath));
    else if (fs.existsSync(path.join(baseFolder, 'settings.json'))) {
      const old = await readJsonBounded(path.join(baseFolder, 'settings.json'));
      settings = checkSettings({ ...defaults, dataFolder: old.DataFolder, createHotkey: old.CreateHotkey, graphHotkey: old.GraphHotkey, gestureEnabled: old.GestureEnabled, openFiles: old.OpenFiles });
    }
  } catch (error) {
    settingsInvalid = fs.existsSync(settingsPath); settings = { ...defaults };
    warningList.push('Cannot read settings. Temporary defaults are in use; the original file is unchanged. ' + error.message);
  }
}
async function saveSettings(explicit = false, value = settings) {
  if (settingsInvalid && !explicit) return;
  await fsp.mkdir(baseFolder, { recursive: true });
  const temporary = settingsPath + '.' + process.pid + '.tmp';
  try {
    const file = await fsp.open(temporary, 'w');
    try { await file.writeFile(JSON.stringify(value, null, 2), 'utf8'); await file.sync(); } finally { await file.close(); }
    if (fs.existsSync(settingsPath)) {
      const preserved = settingsInvalid ? settingsPath + '.' + Date.now() + '.corrupt' : settingsPath + '.bak';
      await fsp.copyFile(settingsPath, preserved);
    }
    await fsp.rename(temporary, settingsPath);
    settingsInvalid = false; settingsWarning = null;
  } finally { await fsp.unlink(temporary).catch(() => {}); }
}
async function rememberOpenFiles() {
  settings.openFiles = lastState.documents.map(d => d.path);
  try { await saveSettings(); } catch (error) { settingsWarning = 'Settings could not be saved; workspace data is saved separately: ' + error.message; }
}
async function rescueSnapshot(document, destination, adopt) {
  const bytes = Buffer.from(JSON.stringify(document.workspace), 'utf8');
  if (bytes.length > 16 * 1024 * 1024) throw new Error('The recovery snapshot exceeds its size limit. Export was stopped.');
  const temporary = destination + '.' + require('node:crypto').randomUUID() + '.rescue.tmp';
  let helper;
  try {
    const file = await fsp.open(temporary, 'wx');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    helper = new CoreBridge();
    await helper.request('exportSnapshot', { sourcePath: temporary, path: destination });
    rescuedSnapshots.set(document.id, { workspace: document.workspace, path: destination });
    if (adopt) {
      document.path = destination; document.saveStatus = 'saved'; document.saveError = null;
      document.canUndo = false; document.canRedo = false;
      await rememberOpenFiles();
    }
    send({ type: 'error', message: 'The last acknowledged in-memory snapshot was exported safely. Restart the app to resume editing.' });
  } finally { helper?.close(); await fsp.unlink(temporary).catch(() => {}); }
}
const registered = new Map();
function isEscapeHotkey(key) { return /^(esc|escape)$/i.test(key.trim()); }
function setReadyEscape(active) {
  if (readyEscapeRegistered && !active) { globalShortcut.unregister('Escape'); readyEscapeRegistered = false; }
  if (!active || readyEscapeRegistered || [...registered.keys()].some(isEscapeHotkey)) return;
  try { readyEscapeRegistered = globalShortcut.register('Escape', () => { if (mode === 'ready') hideOverlay(true); }); }
  catch { readyEscapeRegistered = false; }
}
function configureHotkeys(candidate, initial = false) {
  const keys = [candidate.createHotkey, candidate.graphHotkey];
  const canonical = key => key.replace(/\s/g, '').toLowerCase().replace(/control/g, 'ctrl');
  if (canonical(keys[0]) === canonical(keys[1])) throw new Error('Task creation and the task graph must use different shortcuts.');
  if (readyEscapeRegistered && keys.some(isEscapeHotkey)) setReadyEscape(false);
  const added = [];
  try {
    for (const key of keys) {
      if (registered.has(key)) continue;
      const success = globalShortcut.register(key, () => {
        if (key === settings.createHotkey) summon('create');
        else if (key === settings.graphHotkey) summon('graph');
      });
      if (!success) throw new Error('Shortcut ' + key + ' is already in use. Choose a different combination.');
      registered.set(key, true); added.push(key);
    }
    for (const key of [...registered.keys()]) if (!keys.includes(key)) { globalShortcut.unregister(key); registered.delete(key); }
  } catch (error) {
    if (!initial) for (const key of added) { globalShortcut.unregister(key); registered.delete(key); }
    throw error;
  } finally { if (mode === 'ready') setReadyEscape(true); }
}
function setInteractive(value) {
  if (!win || win.isDestroyed() || interactive === value) return;
  interactive = value; win.setIgnoreMouseEvents(!value, { forward: true });
}
function setRegions(payload) {
  if (mode === 'ready' && !Object.hasOwn(payload ?? {}, 'readyActivation')) return false;
  if (payload && Object.hasOwn(payload, 'readyActivation') && (mode !== 'ready' || payload.readyActivation !== activationId)) return false;
  if (!payload || !Array.isArray(payload.regions) || payload.regions.length > 80) throw new Error('The interaction region is invalid.');
  regions = payload.regions.map(rect => {
    if (!rect || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k]) && Math.abs(rect[k]) <= 50000) || rect.width < 0 || rect.height < 0) throw new Error('The interaction region is invalid.');
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  dragUntil = payload.dragging === true ? Date.now() + 30000 : 0;
  refreshHitTest(screen.getCursorScreenPoint());
  return true;
}
function refreshHitTest(point) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds(), x = point.x - bounds.x, y = point.y - bounds.y;
  setInteractive(Date.now() < dragUntil || regions.some(r => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height));
}
function cancelActivation() {
  activationId++;
  activationPending = false;
  clearTimeout(activationTimer);
}
function activateWindow() {
  cancelActivation();
  const requestedId = activationId;
  activationPending = true;
  try {
    // A visible, non-focusable overlay does not necessarily re-enter native
    // activation when show() is called. Re-show that window after restoring its
    // focusability, then focus the Chromium child that receives keyboard input.
    // This transition belongs only to an explicit summon, never the idle loop.
    if (!win.isFocusable()) win.hide();
    win.setFocusable(true);
    win.setSkipTaskbar(true);
    setInteractive(true);
    win.show();
    win.focus();
    win.webContents.focus();
  } finally {
    // Temporary input acceptance must end in this same turn, including failure.
    try { refreshHitTest(screen.getCursorScreenPoint()); } catch { setInteractive(false); }
    activationTimer = setTimeout(() => {
      if (requestedId !== activationId || !rendererReady || !win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      // One bounded confirmation permits the native show/focus messages to
      // settle. Never retry bringing a background window to the foreground.
      if (win.isFocused()) win.webContents.focus();
      activationPending = false;
    }, 40);
    activationTimer.unref();
  }
  return requestedId;
}
function summon(nextMode = 'graph', internal = false) {
  if (!win || win.isDestroyed() || !rendererReady) return;
  if (!['ready', 'create', 'graph'].includes(nextMode)) throw new Error('The summon mode is invalid.');
  if (nextMode === 'ready' && mode !== 'idle' && mode !== 'ready') return;
  if (internal && win.isFocusable()) {
    // A real click already activated the renderer. Keep its native/DOM focus
    // and screen position while it reveals the task card.
    mode = nextMode; roaming = false; circles.reset(); speedDismiss.reset(Date.now());
    cancelActivation();
    setReadyEscape(mode === 'ready');
    return;
  }
  let point;
  try { point = screen.getCursorScreenPoint(); }
  catch {
    const bounds = win.getBounds();
    point = lastCursor || { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }
  const display = screen.getDisplayNearestPoint(point);
  const current = win.getBounds(), area = display.workArea;
  if (current.x !== area.x || current.y !== area.y || current.width !== area.width || current.height !== area.height) { regions = []; win.setBounds(area); }
  mode = nextMode; roaming = false; circles.reset(); speedDismiss.reset(Date.now());
  let requestedId;
  if (mode === 'ready') {
    cancelActivation(); requestedId = activationId;
    regions = []; dragUntil = 0; setInteractive(false);
    // A mouse-only summon stays decorative until the user clicks its landing
    // button. showInactive leaves the foreground application's keyboard alone.
    win.setFocusable(true); win.setSkipTaskbar(true); win.showInactive();
  } else requestedId = activateWindow();
  setReadyEscape(mode === 'ready');
  if (!internal) send({ type: 'summon', activationId: requestedId, mode, escapeAvailable: readyEscapeRegistered, point: { x: point.x - area.x, y: point.y - area.y } });
  refreshHitTest(point);
}
function hideOverlay(disperse = false) {
  cancelActivation();
  mode = 'idle'; roaming = false; dragUntil = 0; circles.reset(); speedDismiss.reset(); regions = [];
  setReadyEscape(false);
  setInteractive(false); send({ type: 'hide', disperse });
  if (win && !win.isDestroyed()) { win.setFocusable(false); win.blur(); }
}
function requestHide() {
  // Let the renderer commit an active editor before changing hit regions.
  send({ type: 'prepareHide' });
}
function setRoaming(active) {
  if (roaming === active) return;
  roaming = active;
  // Decorative activity never changes window focus or hit-test regions.
  send({ type: 'roaming', active });
}
function updateRoaming(now) {
  if (now < nextRoamCheck) return;
  nextRoamCheck = now + 1000;
  try {
    const seconds = powerMonitor.getSystemIdleTime();
    setRoaming(mode === 'idle' && settings.effects !== 'off' && settings.idleRoamSeconds > 0 &&
      Number.isFinite(seconds) && seconds >= settings.idleRoamSeconds && powerMonitor.getSystemIdleState(settings.idleRoamSeconds) !== 'locked');
  } catch { setRoaming(false); }
}
function sampleCursor() {
  if (suspended || !win || win.isDestroyed() || !rendererReady) return;
  const point = screen.getCursorScreenPoint(), now = Date.now();
  refreshHitTest(point);
  updateRoaming(now);
  // Speed needs every timestamp, including unchanged cursor positions. Keep it
  // ahead of the movement-only notification/gesture path below.
  if (mode === 'ready') {
    if (now < dragUntil) speedDismiss.reset(now);
    else {
      const display = screen.getDisplayNearestPoint(point);
      if (speedDismiss.addPoint(point.x, point.y, display.bounds.height, now, settings.dismissSpeed)) { lastCursor = point; hideOverlay(true); return; }
    }
  }
  if (lastCursor?.x === point.x && lastCursor?.y === point.y) return;
  lastCursor = point;
  setRoaming(false);
  nextRoamCheck = now + 1000;
  if (mode === 'ready') {
    const bounds = win.getBounds();
    send({ type: 'cursorPoint', point: { x: point.x - bounds.x, y: point.y - bounds.y } });
  } else if (settings.gestureEnabled && mode === 'idle' && now >= dragUntil) {
    const display = screen.getDisplayNearestPoint(point);
    if (circles.addPoint(point.x, point.y, display.bounds.height, now)) summon('ready');
  } else circles.reset();
}
function pollCursor() {
  clearTimeout(sampleTimer);
  if (quitting || suspended) return;
  let delay = 40;
  try { sampleCursor(); cursorFailures = 0; }
  catch {
    cursorFailures = Math.min(cursorFailures + 1, 3);
    delay = cursorFailures < 3 ? 1000 : 5000;
    circles.reset(); speedDismiss.reset(); lastCursor = null; dragUntil = 0;
    // A locked or unavailable desktop must not crash the host or leave the
    // transparent window intercepting another application's mouse input.
    try { setInteractive(false); } catch {}
    if (cursorFailures === 1) send({ type: 'error', message: 'The desktop pointer position is unavailable. Gesture detection will retry less often; editing and shortcuts remain available.' });
  }
  sampleTimer = setTimeout(pollCursor, delay); sampleTimer.unref();
}
function trayImage() {
  // Small generated bitmap keeps the tray asset independent of external files.
  const size = 32, pixels = Buffer.alloc(size * size * 4);
  const triangles = [[15, 3, 24, 17, 7, 15], [5, 18, 15, 18, 9, 28], [20, 19, 29, 25, 18, 29]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    for (const [ax, ay, bx, by, cx, cy] of triangles) {
      const cross = (x1, y1, x2, y2) => (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2);
      const d1 = cross(ax, ay, bx, by), d2 = cross(bx, by, cx, cy), d3 = cross(cx, cy, ax, ay);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) { const i = (y * size + x) * 4; pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; pixels[i + 3] = 255; }
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}
function requestExit() {
  if (quitting || exitRequested) return;
  exitRequested = true;
  setReadyEscape(false);
  // The renderer may decline because a draft is open. This guard only debounces
  // duplicate clicks and expires even when it never acknowledges prepareExit.
  setTimeout(() => { exitRequested = false; }, 2000).unref();
  if (!rendererReady) { void shutdown().catch(error => { exitRequested = false; send({ type: 'error', message: error.message }); }); return; }
  activateWindow(); send({ type: 'prepareExit' });
}
async function shutdown() {
  if (quitting) return;
  await startup;
  if (bridge?.failed) {
    if (lastState.documents.some(document => document.saveStatus !== 'saved' && rescuedSnapshots.get(document.id)?.workspace !== document.workspace)) throw new Error('The data service stopped with unsaved changes. Export each unsaved workspace before restarting.');
    settings.openFiles = lastState.documents.map(document => document.saveStatus !== 'saved' ? rescuedSnapshots.get(document.id).path : document.path);
    try { await saveSettings(); } catch (error) { settingsWarning = 'Recovery files were saved, but settings could not be saved: ' + error.message; }
    quitting = true; clearTimeout(sampleTimer); globalShortcut.unregisterAll(); tray?.destroy(); app.quit(); return;
  }
  const value = acceptState(await bridge.request('flush'));
  if (!value.result?.canExit) { exitRequested = false; summon('graph'); throw new Error('There are unsaved changes. Exit is paused; retry saving or save a copy to a writable location.'); }
  await rememberOpenFiles();
  quitting = true; clearTimeout(sampleTimer); globalShortcut.unregisterAll(); bridge.close(); tray?.destroy(); app.quit();
}
function validateSender(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== rendererUrl) throw new Error('An unauthorized page request was rejected.');
}
async function invoke(method, payload) {
  await startup;
  if (method === 'bootstrap') return stateEnvelope();
  if (method === 'hide') { hideOverlay(payload.disperse === true); return stateEnvelope(); }
  if (method === 'summon') { summon(payload.mode || 'graph', payload.internal === true); return stateEnvelope(); }
  if (method === 'setRegions') { const accepted = setRegions(payload); return Object.hasOwn(payload, 'readyActivation') ? accepted : stateEnvelope(); }
  if (method === 'quit') { await shutdown(); return stateEnvelope(); }
  let result;
  if (mutationMethods.has(method)) {
    result = await bridge.request(method, payload); acceptState(result, false);
    if (result.result?.error) { acceptState(result); throw new Error(result.result.error); }
    if (method === 'closeWorkspace') await rememberOpenFiles();
  } else if (method === 'createWorkspace') {
    result = await bridge.request(method, { name: payload.name, folder: settings.dataFolder }); acceptState(result, false); await rememberOpenFiles();
  } else if (method === 'openWorkspace' || method === 'recoverWorkspace') {
    const picked = await dialog.showOpenDialog(win, { title: method === 'recoverWorkspace' ? 'Select a workspace to recover from .bak (the original will be preserved)' : 'Open workspace', defaultPath: settings.dataFolder, filters: [{ name: 'DeskGhost workspace', extensions: ['json'] }], properties: ['openFile'] });
    if (picked.canceled) return stateEnvelope();
    result = await bridge.request(method, { path: picked.filePaths[0] }); acceptState(result, false); await rememberOpenFiles();
  } else if (method === 'saveAs' || method === 'exportWorkspace') {
    const document = lastState.documents.find(d => d.id === (payload.workspaceId || lastState.activeWorkspaceId));
    if (!document) throw new Error('Open a workspace first.');
    const safeName = document.workspace.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 90);
    const picked = await dialog.showSaveDialog(win, { title: method === 'saveAs' ? 'Save a copy and continue (choose a new file)' : 'Export workspace (choose a new file)', defaultPath: path.join(settings.dataFolder, safeName + '-' + Date.now() + '.deskghost.json'), filters: [{ name: 'DeskGhost workspace', extensions: ['json'] }] });
    if (picked.canceled || !picked.filePath) return stateEnvelope();
    if (bridge.failed) {
      await rescueSnapshot(document, picked.filePath, method === 'saveAs');
      lastState.result = { path: picked.filePath };
      return acceptState(lastState);
    }
    result = await bridge.request(method, { workspaceId: document.id, path: picked.filePath }); acceptState(result, false);
    if (method === 'saveAs') await rememberOpenFiles();
  } else if (method === 'updateSettings' || method === 'chooseDataFolder') {
    const previous = settings;
    const candidate = { ...settings };
    if (method === 'chooseDataFolder') {
      const picked = await dialog.showOpenDialog(win, { title: 'Choose the data folder for new workspaces', defaultPath: settings.dataFolder, properties: ['openDirectory', 'createDirectory'] });
      if (picked.canceled) return stateEnvelope();
      candidate.dataFolder = picked.filePaths[0];
    } else {
      for (const key of ['effects', 'gestureEnabled', 'idleRoamSeconds', 'dismissSpeed', 'createHotkey', 'graphHotkey']) if (Object.hasOwn(payload, key)) candidate[key] = payload[key];
    }
    checkSettings(candidate); configureHotkeys(candidate);
    try { await saveSettings(true, candidate); } catch (error) { configureHotkeys(previous); throw error; }
    settings = candidate;
    circles.reset(); speedDismiss.reset(Date.now());
    nextRoamCheck = 0;
    updateRoaming(Date.now());
  } else throw new Error('This desktop operation is not supported.');
  return acceptState(lastState);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => summon('graph'));
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); requestExit(); } });
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await loadSettings(); bridge = new CoreBridge();
    startup = (async () => {
      let files = settings.openFiles;
      if (!files.length) {
        try {
          files = [];
          const directory = await fsp.opendir(settings.dataFolder);
          let inspected = 0;
          for await (const entry of directory) {
            if (entry.isFile() && entry.name.endsWith('.deskghost.json')) files.push(path.join(settings.dataFolder, entry.name));
            if (files.length >= 12 || ++inspected >= 4096) break;
          }
        }
        catch (error) { if (error.code !== 'ENOENT') warningList.push('Cannot read the data folder: ' + error.message); }
      }
      for (const file of files) {
        try { acceptState(await bridge.request('openWorkspace', { path: file }), false); }
        catch (error) { warningList.push(path.basename(file) + '：' + error.message); }
      }
      if (!files.length) {
        try { acceptState(await bridge.request('createWorkspace', { name: 'My workspace', folder: settings.dataFolder }), false); }
        catch (error) { warningList.push(error.message); }
      }
      if (!lastState.documents.length && bridge.failed) warningList.push('The data service is unavailable. Task editing is paused.');
      await rememberOpenFiles();
    })();
    const area = screen.getPrimaryDisplay().workArea;
    win = new BrowserWindow({ ...area, frame: false, thickFrame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, title: 'DeskGhost', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: true, spellcheck: false, devTools: !app.isPackaged, partition: 'deskghost' } });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      let permitted = false;
      try { const file = fileURLToPath(details.url); const relative = path.relative(webRoot, file); permitted = !relative.startsWith('..') && !path.isAbsolute(relative); } catch { permitted = details.url.startsWith('data:'); }
      callback({ cancel: !permitted });
    });
    win.webContents.on('render-process-gone', () => { rendererReady = false; cancelActivation(); setReadyEscape(false); regions = []; dragUntil = 0; setInteractive(false); win.hide(); warningList.push('The interface process stopped. Saved data is preserved; click the tray icon to reload.'); });
    win.webContents.on('unresponsive', () => { regions = []; dragUntil = 0; setInteractive(false); });
    win.on('close', event => { if (!quitting) { event.preventDefault(); requestHide(); } });
    win.webContents.on('did-finish-load', () => { rendererReady = true; mode = 'graph'; const requestedId = activateWindow(); send({ type: 'summon', activationId: requestedId, mode, point: { x: area.width / 2, y: area.height / 2 } }); });
    ipcMain.handle('deskghost:invoke', (event, method, payload = {}) => {
      validateSender(event);
      if (typeof method !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload) || Buffer.byteLength(JSON.stringify(payload), 'utf8') > 256 * 1024) throw new Error('The request format is invalid or exceeds its size limit.');
      // Visual transitions and hit testing must never wait for disk writes or a
      // file picker. Only document/settings operations enter the serial queue.
      if (method === 'hide') { hideOverlay(payload.disperse === true); return stateEnvelope(); }
      if (method === 'summon') { summon(payload.mode || 'graph', payload.internal === true); return stateEnvelope(); }
      if (method === 'setRegions') { const accepted = setRegions(payload); return Object.hasOwn(payload, 'readyActivation') ? accepted : stateEnvelope(); }
      if (pendingOperations >= 32) throw new Error('Too many operations are pending. Try again shortly.');
      pendingOperations++;
      const operation = operationQueue.then(() => invoke(method, payload));
      operationQueue = operation.catch(() => {}).finally(() => { pendingOperations--; });
      return operation;
    });
    ipcMain.on('deskghost:interactive', (event, value) => { try { validateSender(event); if (typeof value === 'boolean') refreshHitTest(screen.getCursorScreenPoint()); } catch {} });
    ipcMain.on('deskghost:regions', (event, payload) => { try { validateSender(event); setRegions(payload); } catch {} });
    tray = new Tray(trayImage()); tray.setToolTip('DeskGhost - Desktop companion');
    const openGraph = () => { if (!rendererReady) void win.loadFile(rendererPath); else summon('graph'); };
    tray.on('click', openGraph);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Create task', click: () => summon('create') }, { label: 'Task graph', click: openGraph }, { type: 'separator' }, { label: 'Hide', click: requestHide }, { label: 'Quit DeskGhost', click: requestExit }]));
    try { configureHotkeys(settings, true); } catch (error) { warningList.push(error.message); }
    pollCursor();
    powerMonitor.on('suspend', () => { suspended = true; clearTimeout(sampleTimer); circles.reset(); setReadyEscape(false); setRoaming(false); });
    powerMonitor.on('resume', () => { suspended = false; lastCursor = null; cursorFailures = 0; setReadyEscape(mode === 'ready'); pollCursor(); });
    screen.on('display-removed', () => { if (win && !win.isDestroyed()) { regions = []; win.setBounds(screen.getPrimaryDisplay().workArea); if (mode === 'ready') summon('ready'); else send({ type: 'summon', activationId, mode, point: { x: 300, y: 200 } }); } });
    screen.on('display-metrics-changed', () => { if (win && !win.isDestroyed()) { const display = screen.getDisplayMatching(win.getBounds()); regions = []; win.setBounds(display.workArea); } });
    await win.loadFile(rendererPath);
  }).catch(error => {
    // Startup failures must never leave an invisible, input-blocking window.
    if (win && !win.isDestroyed()) { win.setIgnoreMouseEvents(true, { forward: true }); win.hide(); }
    process.stderr.write('DeskGhost startup failed: ' + error.message + '\n');
    quitting = true; bridge?.close(); app.exit(1);
  });
}
