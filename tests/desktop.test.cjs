const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { CircleGestureRecognizer, ShakeGestureRecognizer } = require('../desktop/gesture.cjs');
const root = path.resolve(__dirname, '..');

test('double circles tolerate direction and ellipses, reject ordinary movement', () => {
  for (const direction of [1, -1]) {
    const recognizer = new CircleGestureRecognizer();
    let found = 0;
    for (let i = 0; i <= 140; i++) {
      const angle = direction * i / 140 * Math.PI * 4;
      found += Number(recognizer.addPoint(600 + Math.cos(angle) * 140, 450 + Math.sin(angle) * 125, 1080, 1000 + i * 25));
    }
    assert.equal(found, 1, 'one summon with cooldown');
  }
  const line = new CircleGestureRecognizer();
  for (let i = 0; i < 200; i++) assert.equal(line.addPoint(i * 5, 200, 1080, i * 20), false);
  const one = new CircleGestureRecognizer();
  for (let i = 0; i < 90; i++) assert.equal(one.addPoint(300 + Math.cos(i / 90 * Math.PI * 2) * 135, 300 + Math.sin(i / 90 * Math.PI * 2) * 135, 1080, i * 30), false);
  const tiny = new CircleGestureRecognizer();
  for (let i = 0; i <= 140; i++) {
    const angle = i / 140 * Math.PI * 4;
    assert.equal(tiny.addPoint(300 + Math.cos(angle) * 15, 300 + Math.sin(angle) * 15, 1080, i * 25), false);
  }
  for (const sample of [[NaN, 0, 1080, 4000], [0, Infinity, 1080, 4040], [0, 0, 0, 4080]])
    assert.equal(tiny.addPoint(...sample), false, 'invalid samples are safely rejected');
});

test('shake recognition needs fast reversals rather than a one-way move', () => {
  const shake = new ShakeGestureRecognizer();
  let found = false;
  [0, 130, 0, 130, 0, 130].forEach((x, i) => { found ||= shake.addPoint(x, 50, i * 70); });
  assert.equal(found, true);
  shake.reset();
  for (let i = 0; i < 50; i++) assert.equal(shake.addPoint(i * 15, 50, i * 40), false);
});

test('transparent Electron UI: direct manipulation, keyboard capture and durable saves', { skip: !process.argv.includes('--ui'), timeout: 110000 }, async () => {
  const { _electron } = require('playwright');
  const output = path.join(root, '.local', 'web-smoke', String(Date.now()));
  await fs.mkdir(output, { recursive: true });
  const errors = [];
  const electronEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.DESKGHOST_EXE;
  const app = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [root]), '--data-dir', output], cwd: root, timeout: 30000, env: electronEnv });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.getElementById('boot-screen')?.hidden, null, { timeout: 25000 });
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)');
    const native = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { background: window.getBackgroundColor(), resizable: window.isResizable(), sandbox: window.webContents.getLastWebPreferences().sandbox, node: window.webContents.getLastWebPreferences().nodeIntegration, isolated: window.webContents.getLastWebPreferences().contextIsolation };
    });
    assert.ok(['#000000', '#00000000'].includes(native.background)); assert.equal(native.resizable, false);
    assert.equal(native.sandbox, true); assert.equal(native.node, false); assert.equal(native.isolated, true);
    const transparentCapture = await page.screenshot({ omitBackground: true });
    const cornerAlpha = await app.evaluate(({ nativeImage }, bytes) => nativeImage.createFromBuffer(Buffer.from(bytes)).toBitmap()[3], [...transparentCapture]);
    assert.equal(cornerAlpha, 0, 'pixels outside floating tools retain real alpha transparency');
    assert.equal(await page.locator('#flock').evaluate(canvas => Math.round(canvas.getBoundingClientRect().width) === innerWidth), true);
    const fixture = await page.evaluate(async () => {
      const call = (method, payload = {}) => window.deskghost.invoke(method, payload);
      let envelope = await call('bootstrap'); const workspaceId = envelope.activeWorkspaceId;
      const create = async (title, category, column, row) => (await call('createTask', { workspaceId, title, category, description: '可以拖动卡片、连接端点，让下一步自然发生。', column, row })).result.taskId;
      const origin = await create('定义产品方向', '项目规划', 0, 0);
      const pcb = await create('PCB 原理图设计', 'PCB 设计', 1, 0);
      const algorithm = await create('算法方案研究', '算法研究', 1, 1);
      const merge = await create('软硬件联合验证', '系统集成', 2, 0);
      await call('addLink', { workspaceId, sourceId: origin, targetId: algorithm });
      await call('addLink', { workspaceId, sourceId: algorithm, targetId: merge });
      await call('setState', { workspaceId, taskId: origin, state: 'Completed' });
      await call('setState', { workspaceId, taskId: algorithm, state: 'InProgress' });
      return { workspaceId, origin, pcb, algorithm, merge };
    });
    await page.locator('#fit-graph').click();
    await page.waitForTimeout(500);
    const card = id => page.locator(`.dg-task-card[data-task-id="${id}"]`);
    await card(fixture.pcb).waitFor();
    const drag = async (from, to) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 22 }); await page.mouse.up(); await page.waitForTimeout(420); };
    const center = async locator => { const b = await locator.boundingBox(); assert.ok(b); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const snapshot = () => page.evaluate(() => window.deskghost.invoke('bootstrap'));
    const workspace = async () => (await snapshot()).documents.find(doc => doc.id === fixture.workspaceId).workspace;
    await drag(await center(card(fixture.origin).locator('[data-port="out"]')), await center(card(fixture.pcb).locator('[data-port="in"]')));
    assert.ok((await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.pcb), 'drag connects cards');
    const start = await card(fixture.pcb).boundingBox();
    const next = await card(fixture.algorithm).boundingBox();
    await drag({ x: start.x + start.width / 2, y: start.y + 60 }, { x: start.x + start.width / 2 + 7, y: next.y + next.height + 53 });
    assert.equal((await workspace()).tasks.find(task => task.id === fixture.pcb).row, 2, 'card snaps to a free row');
    await page.locator('#fit-graph').click(); await page.waitForTimeout(300);
    const edge = page.locator(`.dg-edge-handle[data-edge-key="${fixture.origin}:${fixture.pcb}"][data-endpoint="target"]`);
    const edgePoint = await center(edge);
    await page.mouse.move(edgePoint.x, edgePoint.y); await page.waitForTimeout(100);
    const board = await page.locator('#graph-board').boundingBox();
    await drag(edgePoint, { x: board.x + board.width - 40, y: board.y + board.height - 60 });
    assert.ok(!(await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.pcb), 'dragging an endpoint into empty space disconnects');
    await page.locator('#undo').click();
    assert.ok((await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.pcb), 'undo restores disconnected edge');
    await drag(await center(edge), await center(card(fixture.merge).locator('[data-port="in"]')));
    assert.ok((await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.merge), 'dragging an endpoint onto a new card rewires');
    assert.ok(!(await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.pcb));
    await page.locator('#undo').click();
    assert.ok((await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.pcb), 'one undo restores the entire rewire');
    await page.locator('#new-task').click();
    await page.locator('#task-title').fill('键盘捕捉灵感'); await page.keyboard.press('Control+Enter');
    assert.equal(await page.locator('#task-category').evaluate(el => el === document.activeElement), true);
    await page.keyboard.type('交互设计'); await page.keyboard.press('Control+Enter');
    assert.equal(await page.locator('#task-description').evaluate(el => el === document.activeElement), true);
    await page.keyboard.type('无边框、透明、丝滑吸附');
    await page.waitForTimeout(6000);
    const flockAtCard = await page.locator('#flock').evaluate(canvas => {
      const box = document.getElementById('composer').getBoundingClientRect();
      const scale = canvas.width / innerWidth;
      const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let total = 0, near = 0;
      for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
        const alpha = data[(y * width + x) * 4 + 3];
        total += alpha;
        if (x / scale > box.left - 80 && x / scale < box.right + 80 && y / scale > box.top - 80 && y / scale < box.bottom + 80) near += alpha;
      }
      return total > 0 && near / total > .8;
    });
    assert.equal(flockAtCard, true, 'white fragments converge around the input card while it remains usable');
    await page.screenshot({ path: path.join(output, 'composer-transparent.png'), omitBackground: true });
    await page.keyboard.press('Control+Enter'); await page.waitForFunction(() => document.getElementById('composer').hidden);
    assert.ok((await workspace()).tasks.some(task => task.title === '键盘捕捉灵感' && task.category === '交互设计'));
    await page.locator('#open-search').click(); await page.locator('#search-title').fill('算法');
    assert.equal(await page.locator('.search-result').count(), 1);
    await page.locator('.search-result').click();
    await page.locator('#clear-search').click();
    await page.keyboard.press('Escape');
    await page.locator('#category-mode').click(); await page.waitForTimeout(250);
    await page.locator('#graph-mode').click(); await page.locator('#fit-graph').click();
    await page.waitForTimeout(3500);
    await page.screenshot({ path: path.join(output, 'graph-transparent.png'), omitBackground: true });
    // A test-only desktop backdrop makes translucent white fragments and cards
    // easy to inspect; production keeps the genuine desktop visible instead.
    await page.evaluate(() => {
      const desktop = document.createElement('div'); desktop.id = 'test-desktop';
      Object.assign(desktop.style, { position: 'fixed', inset: '0', zIndex: '-1', background: 'radial-gradient(ellipse at 24% 24%,#aaa69a,transparent 60%),linear-gradient(135deg,#7a837f,#465c62 62%,#273d48)' });
      document.body.prepend(desktop);
    });
    await page.screenshot({ path: path.join(output, 'graph-desktop-preview.png') });
    await page.evaluate(() => document.getElementById('test-desktop').remove());
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'ready' }));
    await page.waitForFunction(() => document.body.dataset.mode === 'ready');
    await page.keyboard.type('first letters arrive immediately', { delay: 1 });
    assert.equal(await page.locator('#task-title').inputValue(), 'first letters arrive immediately', 'first and subsequent characters survive the ready-to-card transition');
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'graph' }));
    assert.equal(await page.locator('#task-title').inputValue(), 'first letters arrive immediately', 'a graph hotkey preserves the open creation draft');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.body.dataset.mode === 'idle');
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'graph' }));
    await card(fixture.algorithm).dblclick();
    await page.locator('#task-description').fill('立即收起时也要保存的编辑');
    await page.locator('#hide-manager').click();
    await page.waitForFunction(() => document.body.dataset.mode === 'idle');
    assert.equal((await workspace()).tasks.find(task => task.id === fixture.algorithm).description, '立即收起时也要保存的编辑', 'hiding drains pending edits');
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'graph' }));
    await card(fixture.algorithm).dblclick();
    await page.locator('#task-description').fill('删除前最后一次编辑');
    await card(fixture.algorithm).locator('.dg-delete-action').click();
    await page.waitForFunction(() => document.getElementById('composer').hidden);
    assert.ok((await workspace()).tasks.find(task => task.id === fixture.algorithm).deletedAt);
    await page.locator('#undo').click();
    assert.equal((await workspace()).tasks.find(task => task.id === fixture.algorithm).description, '删除前最后一次编辑', 'direct deletion commits and closes an editor; undo preserves the last edit');
    assert.deepEqual(errors, []);
    const final = await snapshot();
    const file = final.documents.find(doc => doc.id === fixture.workspaceId).path;
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(stored.tasks.length, 5);
    console.log('Desktop screenshots and workspace:', output);
    await page.evaluate(() => window.deskghost.invoke('quit')).catch(() => {});
  } finally { await app.close().catch(() => {}); }
});
