'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, globalShortcut, screen, dialog, powerMonitor } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { CircleGestureRecognizer, ShakeGestureRecognizer } = require('./gesture.cjs');

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
const defaults = { formatVersion: 1, dataFolder: path.join(baseFolder, 'Workspaces'), createHotkey: 'Ctrl+Alt+N', graphHotkey: 'Ctrl+Alt+G', gestureEnabled: true, effects: 'high', openFiles: [] };
let settings = { ...defaults }, settingsInvalid = false, settingsWarning = null;
let win, tray, bridge, startup, lastState = { documents: [], activeWorkspaceId: null, result: null };
let quitting = false, exitRequested = false, mode = 'graph', interactive = false, regions = [], dragUntil = 0;
let sampleTimer, rendererReady = false, suspended = false, lastCursor = null, warningList = [];
let cursorFailures = 0;
let pendingOperations = 0, operationQueue = Promise.resolve();
const rescuedSnapshots = new Map();
const circles = new CircleGestureRecognizer(), shake = new ShakeGestureRecognizer();
const mutationMethods = new Set(['createTask', 'updateTask', 'setState', 'moveTask', 'insertColumn', 'renameColumn', 'renameWorkspace', 'addCategory', 'addLink', 'removeLink', 'rewireLink', 'deleteTask', 'restoreTask', 'archiveTask', 'unarchiveTask', 'undo', 'redo', 'saveWorkspace', 'closeWorkspace', 'activateWorkspace']);

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
    this.process.once('error', error => this.fail(new Error('无法启动数据服务：' + error.message)));
    this.process.once('exit', () => { if (!quitting && !this.closed) this.fail(new Error('数据服务已停止。已有磁盘数据仍保留，请重新启动应用。')); });
    this.process.stdin.on('error', error => this.fail(error));
  }
  receive(chunk) {
    if (this.failed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > 20 * 1024 * 1024) { this.fail(new Error('数据服务响应超过上限，已安全停止。')); return; }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { this.fail(new Error('数据服务返回了损坏的消息。')); return; }
      const waiting = this.pending.get(reply.id);
      if (!waiting) { this.fail(new Error('数据服务请求顺序无效。')); return; }
      clearTimeout(waiting.timer); this.pending.delete(reply.id);
      if (reply.ok) waiting.resolve(reply.data); else waiting.reject(new Error(reply.error || '数据操作失败。'));
    }
  }
  request(method, payload = {}) {
    if (this.failed) return Promise.reject(new Error('数据服务不可用，请重新启动；已保存的文件仍保留。'));
    if (this.pending.size >= 4) return Promise.reject(new Error('数据服务繁忙，请稍后重试。'));
    const id = String(++this.counter), line = JSON.stringify({ id, method, payload }) + '\n';
    if (Buffer.byteLength(line, 'utf8') > 256 * 1024) return Promise.reject(new Error('操作内容超过允许大小。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('数据服务响应超时。已停止继续编辑，磁盘上的有效数据保持不变。')), 30000);
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
  if (!value || value.formatVersion !== 1 || typeof value.dataFolder !== 'string' || !value.dataFolder.trim() || value.dataFolder.length > 1024 || !path.isAbsolute(value.dataFolder) ||
    !['high', 'low', 'off'].includes(value.effects) || typeof value.gestureEnabled !== 'boolean' ||
    !Array.isArray(value.openFiles) || value.openFiles.length > 12 || value.openFiles.some(p => typeof p !== 'string' || !path.isAbsolute(p) || p.length > 1024)) throw new Error('设置文件包含无效数据。');
  for (const key of ['createHotkey', 'graphHotkey']) if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 80) throw new Error('全局快捷键无效。');
  return value;
}
async function readJsonBounded(file) {
  const handle = await fsp.open(file, 'r');
  try {
    if ((await handle.stat()).size > 64 * 1024) throw new Error('设置文件过大。');
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 64 * 1024) throw new Error('读取期间设置文件超过大小上限。');
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
    warningList.push('无法读取设置，使用临时默认值；原文件保持不变。' + error.message);
  }
}
async function saveSettings(explicit = false) {
  if (settingsInvalid && !explicit) return;
  await fsp.mkdir(baseFolder, { recursive: true });
  const temporary = settingsPath + '.' + process.pid + '.tmp';
  try {
    const file = await fsp.open(temporary, 'w');
    try { await file.writeFile(JSON.stringify(settings, null, 2), 'utf8'); await file.sync(); } finally { await file.close(); }
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
  try { await saveSettings(); } catch (error) { settingsWarning = '设置保存失败，工作区数据单独保存：' + error.message; }
}
async function rescueSnapshot(document, destination, adopt) {
  const bytes = Buffer.from(JSON.stringify(document.workspace), 'utf8');
  if (bytes.length > 16 * 1024 * 1024) throw new Error('恢复快照超过大小上限，已停止导出。');
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
    send({ type: 'error', message: '内存中最后确认的内容已安全导出。数据服务已停止，请重新启动后继续编辑。' });
  } finally { helper?.close(); await fsp.unlink(temporary).catch(() => {}); }
}
const registered = new Map();
function configureHotkeys(candidate, initial = false) {
  const keys = [candidate.createHotkey, candidate.graphHotkey];
  const canonical = key => key.replace(/\s/g, '').toLowerCase().replace(/control/g, 'ctrl');
  if (canonical(keys[0]) === canonical(keys[1])) throw new Error('创建任务和任务图必须使用不同快捷键。');
  const added = [];
  try {
    for (const key of keys) {
      if (registered.has(key)) continue;
      const success = globalShortcut.register(key, () => summon(key === settings.createHotkey ? 'create' : 'graph'));
      if (!success) throw new Error('快捷键 ' + key + ' 已被占用，请设置其他组合。');
      registered.set(key, true); added.push(key);
    }
    for (const key of [...registered.keys()]) if (!keys.includes(key)) { globalShortcut.unregister(key); registered.delete(key); }
  } catch (error) {
    if (!initial) for (const key of added) { globalShortcut.unregister(key); registered.delete(key); }
    throw error;
  }
}
function setInteractive(value) {
  if (!win || win.isDestroyed() || interactive === value) return;
  interactive = value; win.setIgnoreMouseEvents(!value, { forward: true });
}
function setRegions(payload) {
  if (!payload || !Array.isArray(payload.regions) || payload.regions.length > 80) throw new Error('交互区域无效。');
  regions = payload.regions.map(rect => {
    if (!rect || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k]) && Math.abs(rect[k]) <= 50000) || rect.width < 0 || rect.height < 0) throw new Error('交互区域无效。');
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  dragUntil = payload.dragging === true ? Date.now() + 30000 : 0;
  refreshHitTest(screen.getCursorScreenPoint());
}
function refreshHitTest(point) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds(), x = point.x - bounds.x, y = point.y - bounds.y;
  setInteractive(Date.now() < dragUntil || regions.some(r => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height));
}
function summon(nextMode = 'graph', internal = false) {
  if (!win || win.isDestroyed() || !rendererReady) return;
  if (!['ready', 'create', 'graph'].includes(nextMode)) throw new Error('呼出模式无效。');
  let point;
  try { point = screen.getCursorScreenPoint(); }
  catch {
    const bounds = win.getBounds();
    point = lastCursor || { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }
  const display = screen.getDisplayNearestPoint(point);
  const current = win.getBounds(), area = display.workArea;
  if (current.x !== area.x || current.y !== area.y || current.width !== area.width || current.height !== area.height) { regions = []; win.setBounds(area); }
  mode = nextMode; circles.reset(); shake.reset();
  win.show(); win.focus();
  if (!internal) send({ type: 'summon', mode, point: { x: point.x - area.x, y: point.y - area.y } });
  refreshHitTest(point);
}
function hideOverlay(disperse = false) {
  mode = 'idle'; dragUntil = 0; circles.reset(); shake.reset(); regions = [];
  setInteractive(false); send({ type: 'hide', disperse });
  if (win && !win.isDestroyed()) win.blur();
}
function requestHide() {
  // Let the renderer commit an active editor before changing hit regions.
  send({ type: 'prepareHide' });
}
function sampleCursor() {
  if (suspended || !win || win.isDestroyed() || !rendererReady) return;
  const point = screen.getCursorScreenPoint(), now = Date.now();
  refreshHitTest(point);
  if (lastCursor?.x === point.x && lastCursor?.y === point.y) return;
  lastCursor = point;
  if (mode === 'ready') {
    const bounds = win.getBounds();
    send({ type: 'cursorPoint', point: { x: point.x - bounds.x, y: point.y - bounds.y } });
    if (shake.addPoint(point.x, point.y, now)) hideOverlay(true);
  } else if (settings.gestureEnabled && mode === 'idle') {
    const display = screen.getDisplayNearestPoint(point);
    if (circles.addPoint(point.x, point.y, display.bounds.height, now)) summon('ready');
  }
}
function pollCursor() {
  clearTimeout(sampleTimer);
  if (quitting || suspended) return;
  let delay = 40;
  try { sampleCursor(); cursorFailures = 0; }
  catch {
    cursorFailures = Math.min(cursorFailures + 1, 3);
    delay = cursorFailures < 3 ? 1000 : 5000;
    circles.reset(); shake.reset(); lastCursor = null; dragUntil = 0;
    // A locked or unavailable desktop must not crash the host or leave the
    // transparent window intercepting another application's mouse input.
    try { setInteractive(false); } catch {}
    if (cursorFailures === 1) send({ type: 'error', message: '无法读取当前桌面的鼠标位置，手势已降为低频重试；任务编辑和快捷键仍可使用。' });
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
  // The renderer may decline because a draft is open. This guard only debounces
  // duplicate clicks and expires even when it never acknowledges prepareExit.
  setTimeout(() => { exitRequested = false; }, 2000).unref();
  if (!rendererReady) { void shutdown().catch(error => { exitRequested = false; send({ type: 'error', message: error.message }); }); return; }
  win.show(); win.focus(); send({ type: 'prepareExit' });
}
async function shutdown() {
  if (quitting) return;
  await startup;
  if (bridge?.failed) {
    if (lastState.documents.some(document => document.saveStatus !== 'saved' && rescuedSnapshots.get(document.id)?.workspace !== document.workspace)) throw new Error('数据服务已停止，界面中仍有未保存的数据。请逐一导出未保存的工作区后重新启动。');
    settings.openFiles = lastState.documents.map(document => document.saveStatus !== 'saved' ? rescuedSnapshots.get(document.id).path : document.path);
    try { await saveSettings(); } catch (error) { settingsWarning = '恢复文件已保存，但设置保存失败：' + error.message; }
    quitting = true; clearTimeout(sampleTimer); globalShortcut.unregisterAll(); tray?.destroy(); app.quit(); return;
  }
  const value = acceptState(await bridge.request('flush'));
  if (!value.result?.canExit) { exitRequested = false; summon('graph'); throw new Error('仍有未保存的更改。退出已暂停，请重试保存或另存到可写位置。'); }
  await rememberOpenFiles();
  quitting = true; clearTimeout(sampleTimer); globalShortcut.unregisterAll(); bridge.close(); tray?.destroy(); app.quit();
}
function validateSender(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== rendererUrl) throw new Error('拒绝未授权的页面请求。');
}
async function invoke(method, payload) {
  await startup;
  if (method === 'bootstrap') return stateEnvelope();
  if (method === 'hide') { hideOverlay(payload.disperse === true); return stateEnvelope(); }
  if (method === 'summon') { summon(payload.mode || 'graph', payload.internal === true); return stateEnvelope(); }
  if (method === 'setRegions') { setRegions(payload); return stateEnvelope(); }
  if (method === 'quit') { await shutdown(); return stateEnvelope(); }
  let result;
  if (mutationMethods.has(method)) {
    result = await bridge.request(method, payload); acceptState(result, false);
    if (method === 'closeWorkspace') await rememberOpenFiles();
  } else if (method === 'createWorkspace') {
    result = await bridge.request(method, { name: payload.name, folder: settings.dataFolder }); acceptState(result, false); await rememberOpenFiles();
  } else if (method === 'openWorkspace' || method === 'recoverWorkspace') {
    const picked = await dialog.showOpenDialog(win, { title: method === 'recoverWorkspace' ? '选择要从 .bak 恢复的工作区（原文件将保留）' : '打开工作区', defaultPath: settings.dataFolder, filters: [{ name: 'DeskGhost 工作区', extensions: ['json'] }], properties: ['openFile'] });
    if (picked.canceled) return stateEnvelope();
    result = await bridge.request(method, { path: picked.filePaths[0] }); acceptState(result, false); await rememberOpenFiles();
  } else if (method === 'saveAs' || method === 'exportWorkspace') {
    const document = lastState.documents.find(d => d.id === (payload.workspaceId || lastState.activeWorkspaceId));
    if (!document) throw new Error('请先打开工作区。');
    const safeName = document.workspace.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 90);
    const picked = await dialog.showSaveDialog(win, { title: method === 'saveAs' ? '另存并继续（请选择新文件）' : '导出工作区（请选择新文件）', defaultPath: path.join(settings.dataFolder, safeName + '-' + Date.now() + '.deskghost.json'), filters: [{ name: 'DeskGhost 工作区', extensions: ['json'] }] });
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
      const picked = await dialog.showOpenDialog(win, { title: '选择新工作区的数据文件夹', defaultPath: settings.dataFolder, properties: ['openDirectory', 'createDirectory'] });
      if (picked.canceled) return stateEnvelope();
      candidate.dataFolder = picked.filePaths[0];
    } else {
      for (const key of ['effects', 'gestureEnabled', 'createHotkey', 'graphHotkey']) if (Object.hasOwn(payload, key)) candidate[key] = payload[key];
    }
    checkSettings(candidate); configureHotkeys(candidate); settings = candidate;
    try { await saveSettings(true); } catch (error) { settings = previous; configureHotkeys(previous); throw error; }
    circles.reset();
  } else throw new Error('不支持的桌面操作。');
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
        catch (error) { if (error.code !== 'ENOENT') warningList.push('无法读取数据文件夹：' + error.message); }
      }
      for (const file of files) {
        try { acceptState(await bridge.request('openWorkspace', { path: file }), false); }
        catch (error) { warningList.push(path.basename(file) + '：' + error.message); }
      }
      if (!files.length) {
        try { acceptState(await bridge.request('createWorkspace', { name: '我的工作区', folder: settings.dataFolder }), false); }
        catch (error) { warningList.push(error.message); }
      }
      if (!lastState.documents.length && bridge.failed) warningList.push('数据服务不可用，任务编辑已停止。');
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
    win.webContents.on('render-process-gone', () => { rendererReady = false; regions = []; dragUntil = 0; setInteractive(false); win.hide(); warningList.push('界面进程已停止，已保存数据保留。点击托盘重新载入。'); });
    win.webContents.on('unresponsive', () => { regions = []; dragUntil = 0; setInteractive(false); });
    win.on('close', event => { if (!quitting) { event.preventDefault(); requestHide(); } });
    win.on('blur', () => { if (mode === 'ready') hideOverlay(true); });
    win.webContents.on('did-finish-load', () => { rendererReady = true; win.show(); win.focus(); send({ type: 'summon', mode: 'graph', point: { x: area.width / 2, y: area.height / 2 } }); });
    ipcMain.handle('deskghost:invoke', (event, method, payload = {}) => {
      validateSender(event);
      if (typeof method !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload) || Buffer.byteLength(JSON.stringify(payload), 'utf8') > 256 * 1024) throw new Error('请求格式无效或超过大小上限。');
      // Visual transitions and hit testing must never wait for disk writes or a
      // file picker. Only document/settings operations enter the serial queue.
      if (method === 'hide') { hideOverlay(payload.disperse === true); return stateEnvelope(); }
      if (method === 'summon') { summon(payload.mode || 'graph', payload.internal === true); return stateEnvelope(); }
      if (method === 'setRegions') { setRegions(payload); return stateEnvelope(); }
      if (pendingOperations >= 32) throw new Error('操作过于频繁，请稍后重试。');
      pendingOperations++;
      const operation = operationQueue.then(() => invoke(method, payload));
      operationQueue = operation.catch(() => {}).finally(() => { pendingOperations--; });
      return operation;
    });
    ipcMain.on('deskghost:interactive', (event, value) => { try { validateSender(event); if (typeof value === 'boolean') refreshHitTest(screen.getCursorScreenPoint()); } catch {} });
    ipcMain.on('deskghost:regions', (event, payload) => { try { validateSender(event); setRegions(payload); } catch {} });
    tray = new Tray(trayImage()); tray.setToolTip('DeskGhost · 三角碎片桌宠');
    const openGraph = () => { if (!rendererReady) void win.loadFile(rendererPath); else summon('graph'); };
    tray.on('click', openGraph);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '创建任务', click: () => summon('create') }, { label: '任务图', click: openGraph }, { type: 'separator' }, { label: '收起', click: requestHide }, { label: '退出 DeskGhost', click: requestExit }]));
    try { configureHotkeys(settings, true); } catch (error) { warningList.push(error.message); }
    pollCursor();
    powerMonitor.on('suspend', () => { suspended = true; clearTimeout(sampleTimer); circles.reset(); });
    powerMonitor.on('resume', () => { suspended = false; lastCursor = null; cursorFailures = 0; pollCursor(); });
    screen.on('display-removed', () => { if (win && !win.isDestroyed()) { regions = []; win.setBounds(screen.getPrimaryDisplay().workArea); send({ type: 'summon', mode, point: { x: 300, y: 200 } }); } });
    screen.on('display-metrics-changed', () => { if (win && !win.isDestroyed()) { const display = screen.getDisplayMatching(win.getBounds()); regions = []; win.setBounds(display.workArea); } });
    await win.loadFile(rendererPath);
  }).catch(error => {
    // Startup failures must never leave an invisible, input-blocking window.
    if (win && !win.isDestroyed()) { win.setIgnoreMouseEvents(true, { forward: true }); win.hide(); }
    process.stderr.write('DeskGhost startup failed: ' + error.message + '\n');
    quitting = true; bridge?.close(); app.exit(1);
  });
}
