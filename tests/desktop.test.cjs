const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { CircleGestureRecognizer, SpeedDismissRecognizer } = require('../desktop/gesture.cjs');
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
  // Replay the production 25 Hz sampling cadence, including ordinary movement
  // immediately before a quick wand gesture and a slower, flattened ellipse.
  for (const duration of [640, 800, 1200, 2400, 8000]) {
    const wand = new CircleGestureRecognizer();
    for (let time = 0; time < 4000; time += 40) wand.addPoint(100 + time / 8, 200, 1080, time);
    let found = 0;
    for (let time = 0; time <= duration; time += 40) {
      const angle = time / duration * Math.PI * 4;
      found += Number(wand.addPoint(600 + Math.cos(angle) * 170, 450 + Math.sin(angle) * 90, 1080, 4000 + time));
    }
    assert.equal(found, 1, `a ${duration} ms double circle at 25 Hz must summon once`);
  }
  for (const duration of [800, 2400, 8000]) {
    for (const shape of ['uneven', 'drifting', 'growing', 'polygon']) {
      for (const direction of [-1, 1]) {
        const wand = new CircleGestureRecognizer();
        let found = 0;
        for (let time = 0; time <= duration; time += 40) {
          const progress = time / duration, angle = direction * progress * Math.PI * 4;
          const radius = shape === 'growing' ? 85 + 70 * progress : 135 * (shape === 'uneven' ? 1 + .35 * Math.sin(angle * 3) : 1);
          let x = Math.cos(angle) * radius + (shape === 'drifting' ? 220 * progress : 0);
          let y = Math.sin(angle) * radius + (shape === 'drifting' ? 60 * progress : 0);
          if (shape === 'polygon') {
            const vertices = [[145, 10], [85, 120], [-10, 50], [-140, 70], [-110, -95], [30, -120]];
            const q = (direction === 1 ? progress : 1 - progress) * 12, index = Math.floor(q) % 6, fraction = q - Math.floor(q);
            [x, y] = vertices[index].map((value, axis) => value + (vertices[(index + 1) % 6][axis] - value) * fraction);
          }
          found += Number(wand.addPoint(600 + x, 450 + y, 1080, 1000 + time));
        }
        assert.equal(found, 1, `${shape} hand-drawn circles in ${duration} ms, direction ${direction}`);
      }
    }
    for (const shape of ['one-loop', 'retraced', 'figure-eight', 'zigzag']) {
      const wand = new CircleGestureRecognizer();
      for (let time = 0; time <= duration; time += 40) {
        const progress = time / duration;
        const angle = shape === 'retraced' ? Math.min(progress, 1 - progress) * Math.PI * 4 : progress * Math.PI * (shape === 'one-loop' ? 2 : 4);
        const x = shape === 'zigzag' ? 350 + progress * 450 : 600 + Math.cos(angle) * 135;
        const y = 450 + Math.sin(angle * (shape === 'figure-eight' ? 2 : shape === 'zigzag' ? 3 : 1)) * 135;
        assert.equal(wand.addPoint(x, y, 1080, 1000 + time), false, `${shape} is not a double circle`);
      }
    }
  }
  const wandering = new CircleGestureRecognizer();
  let seed = 2864727779, x = 600, y = 450;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 3000; i++) {
    x = Math.max(400, Math.min(800, x + (random() - .5) * 65));
    y = Math.max(250, Math.min(650, y + (random() - .5) * 65));
    assert.equal(wandering.addPoint(x, y, 1080, 1000 + i * 40), false, 'ordinary wandering must not summon');
  }
});

test('speed dismissal is independent of direction, position and display scale', () => {
  for (const scale of [.75, 1, 2]) for (const origin of [[0, 0], [900, 500], [-1800, 960]]) for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
    const dismiss = new SpeedDismissRecognizer(); dismiss.reset(0);
    const results = [0, 80, 160].map((distance, i) => dismiss.addPoint((origin[0] + Math.cos(angle) * distance) * scale, (origin[1] + Math.sin(angle) * distance) * scale, 1000 * scale, 400 + i * 40));
    assert.deepEqual(results, [false, false, true], 'two fast samples dismiss anywhere in any direction');
  }
  const replay = (points, threshold = 1.5) => {
    const dismiss = new SpeedDismissRecognizer(); dismiss.reset(0);
    return points.map(([x, time, height = 1000]) => dismiss.addPoint(x, 500, height, time, threshold));
  };
  for (const [threshold, step] of [[.5, 20], [4, 160]]) {
    assert.deepEqual(replay([[0, 400], [step, 440], [step * 2, 480]], threshold), [false, false, true], 'configured threshold is inclusive');
    assert.deepEqual(replay([[0, 400], [step - 1, 440], [(step - 1) * 2, 480]], threshold), [false, false, false]);
  }
  const changed = new SpeedDismissRecognizer(); changed.reset(0);
  assert.deepEqual([[0, 400, .5], [100, 440, .5], [200, 480, 2], [300, 520, 2], [400, 560, 2]].map(([x, time, threshold]) => changed.addPoint(x, 500, 1000, time, threshold)), [false, false, false, false, true], 'threshold changes require fresh consecutive samples');
  for (const invalid of [NaN, Infinity, .49, 4.01, null, '1.5']) assert.ok(replay([[0, 400], [100, 440], [200, 480]], invalid).every(found => !found), 'invalid thresholds are rejected');
  assert.deepEqual(replay([[0, 400], [50, 440], [100, 480], [150, 520]]), [false, false, false, false], 'normal following remains active');
  assert.deepEqual(replay([[0, 0], [100, 40], [200, 80], [300, 120]]), [false, false, false, false], 'summon tail is inside the arming grace period');
  assert.deepEqual(replay([[0, 400], [5000, 440], [5000, 480]]), [false, false, false], 'an isolated pointer warp cannot dismiss');
  assert.deepEqual(replay([[0, 400], [80, 440], [80, 480], [160, 520], [240, 560]]), [false, false, false, false, true], 'a stationary sample breaks consecutive fast motion');
  for (const points of [
    [[0, 400], [80, 440], [400, 640], [480, 680]],
    [[0, 400], [80, 440], [160, 450], [240, 490]],
    [[0, 400], [80, 440], [160, 430], [240, 470]],
    [[0, 400], [80, 440], [160, 480, 1200], [240, 520, 1200]],
    [[0, 400], [80, 440], [NaN, 480], [240, 520]]
  ]) assert.ok(replay(points).every(found => !found), 'time gaps, invalid samples and display changes reset the run');
});

test('transparent Electron UI: direct manipulation, keyboard capture and durable saves', { skip: !process.argv.includes('--ui'), timeout: 110000 }, async context => {
  const { _electron } = require('playwright');
  const output = path.join(root, '.local', 'web-smoke', String(Date.now()));
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'web-settings.json'), JSON.stringify({
    formatVersion: 1, dataFolder: path.join(output, 'Workspaces'), openFiles: [],
    createHotkey: 'Ctrl+Alt+Shift+F23', graphHotkey: 'Ctrl+Alt+Shift+F24', gestureEnabled: true, effects: 'high'
  }));
  const errors = [];
  const electronEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.DESKGHOST_EXE;
  const app = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [root]), '--data-dir', output], cwd: root, timeout: 30000, env: electronEnv });
  try {
    const page = await app.firstWindow();
    // CDP typing does not reset Windows idle time. Keep the unrelated checks
    // active, then explicitly advance idle time only in the roaming scenario.
    await app.evaluate(({ powerMonitor }) => {
      globalThis.testActualIdleTime = powerMonitor.getSystemIdleTime;
      powerMonitor.getSystemIdleTime = () => 0;
    });
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
    assert.equal((await page.evaluate(() => window.deskghost.invoke('bootstrap'))).settings.dismissSpeed, 1.5, 'older settings receive the default dismissal speed');
    await page.locator('#open-settings').click();
    await page.locator('#setting-dismiss-speed').fill('2.4');
    assert.equal(await page.locator('#dismiss-speed-value').textContent(), '2.4');
    await page.screenshot({ path: path.join(output, 'dismiss-settings.png'), omitBackground: true });
    await page.locator('#apply-settings').click();
    await page.waitForFunction(() => document.getElementById('settings-panel').hidden);
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'web-settings.json'), 'utf8')).dismissSpeed, 2.4, 'the configured threshold is durably saved');
    for (const invalid of [.49, 4.01, '1.5', null]) await assert.rejects(page.evaluate(dismissSpeed => window.deskghost.invoke('updateSettings', { dismissSpeed }), invalid));
    assert.equal((await page.evaluate(() => window.deskghost.invoke('bootstrap'))).settings.dismissSpeed, 2.4, 'invalid settings preserve the last valid value');
    const tapWand = async (hold = false) => {
      await page.waitForFunction(() => {
        const anchor = document.getElementById('wand-anchor');
        return !anchor.hidden && !anchor.classList.contains('is-pending');
      });
      const box = await page.locator('#wand-anchor').boundingBox();
      const point = { x: box.x + box.width * .2, y: box.y + box.height * .3 };
      assert.equal(await page.locator('#wand-anchor').evaluate(element => { const style = getComputedStyle(element); return style.backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(element, '::before').content === 'none' && getComputedStyle(element, '::after').content === 'none' && !element.textContent.trim(); }), true, 'the full-window click surface has no visible dot or label');
      await app.evaluate(({ screen, BrowserWindow }, point) => {
        globalThis.testClickCursor = screen.getCursorScreenPoint;
        const bounds = BrowserWindow.getAllWindows()[0].getBounds();
        screen.getCursorScreenPoint = () => ({ x: bounds.x + point.x, y: bounds.y + point.y });
      }, point);
      try {
        await page.mouse.move(point.x, point.y);
        if (hold) await page.screenshot({ path: path.join(output, 'wand-landing.png'), omitBackground: true });
        await page.mouse.down();
        if (hold) {
          await app.evaluate(({ screen }) => { const point = screen.getCursorScreenPoint(); screen.getCursorScreenPoint = () => ({ x: point.x + 100, y: point.y + 60 }); });
          await page.waitForTimeout(100);
          assert.deepEqual(await page.locator('#wand-anchor').boundingBox(), box, 'the invisible click surface stays in place during a press');
        }
        await page.mouse.up();
        await page.waitForFunction(() => document.body.dataset.mode === 'create');
        assert.equal(await page.locator('#task-title').evaluate(input => input === document.activeElement), true, 'one click places focus in the title before typing');
        assert.equal(await page.locator('#wand-anchor').isVisible(), false);
      } finally {
        await app.evaluate(({ screen }) => { screen.getCursorScreenPoint = globalThis.testClickCursor; delete globalThis.testClickCursor; });
      }
    };
    const replayWand = async (duration, direction = 1) => {
      // Substitute only the OS cursor reading. The actual host timer, recognizer,
      // summon IPC and renderer input transition all run normally.
      await app.evaluate(async ({ screen }, { duration, direction }) => {
        const original = screen.getCursorScreenPoint;
        const area = screen.getPrimaryDisplay().bounds;
        const started = Date.now();
        screen.getCursorScreenPoint = () => {
          const angle = Math.min(1, (Date.now() - started) / duration) * Math.PI * 4 * direction;
          return { x: Math.round(area.x + area.width / 2 + Math.cos(angle) * area.height * .15), y: Math.round(area.y + area.height / 2 + Math.sin(angle) * area.height * .1) };
        };
        try { await new Promise(resolve => setTimeout(resolve, duration + 160)); }
        finally { screen.getCursorScreenPoint = original; }
      }, { duration, direction });
    };
    await replayWand(2000);
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'graph', 'the task graph does not recognize the wand gesture');
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'ready' }));
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'graph', 'the graph also refuses explicit ready summons');
    await page.evaluate(() => window.deskghost.invoke('hide'));
    for (const [initialMode, duration, effects] of [['idle', 2000, 'high'], ['idle', 800, 'high'], ['idle', 1200, 'off']]) {
      await page.evaluate(effects => window.deskghost.invoke('updateSettings', { effects }), effects);
      assert.equal(await page.locator('body').getAttribute('data-mode'), initialMode);
      await replayWand(duration, effects === 'off' ? -1 : 1);
      await page.waitForFunction(() => document.body.dataset.mode === 'ready', null, { timeout: 1200 });
      assert.equal(await page.locator('#ready-prompt, #ready-input').count(), 0, 'wand has no separate floating input');
      assert.equal(await page.locator('#composer').evaluate(element => element.hidden), true, 'no hidden capture input is primed before the click');
      assert.equal(await page.locator('#task-title').evaluate(input => input === document.activeElement), false);
      if (duration === 2000) await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await tapWand(duration === 2000);
      await page.keyboard.type('wand first letters', { delay: 1 });
      assert.equal(await page.locator('#task-title').inputValue(), 'wand first letters');
      assert.equal(await page.locator('body').getAttribute('data-mode'), 'create');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.body.dataset.mode === 'idle');
    }
    await page.evaluate(() => window.deskghost.invoke('updateSettings', { gestureEnabled: false }));
    await replayWand(1200);
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'idle', 'disabled wand does not summon');
    await page.evaluate(() => window.deskghost.invoke('updateSettings', { gestureEnabled: true, effects: 'high' }));
    await replayWand(1200);
    await page.waitForFunction(() => document.body.dataset.mode === 'ready');
    const sweep = () => app.evaluate(async ({ screen }) => {
      const original = screen.getCursorScreenPoint, area = screen.getPrimaryDisplay().bounds;
      const point = { x: area.x + area.width / 2 - area.height * .25, y: area.y + area.height / 2 };
      screen.getCursorScreenPoint = () => point;
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        const started = Date.now();
        screen.getCursorScreenPoint = () => ({ x: point.x + Math.min(180, Date.now() - started) * area.height * .002, y: point.y });
        await new Promise(resolve => setTimeout(resolve, 240));
      } finally { screen.getCursorScreenPoint = original; }
    });
    await sweep();
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'ready', 'a 2-height/s sweep remains below the saved 2.4 threshold');
    await page.evaluate(() => window.deskghost.invoke('updateSettings', { dismissSpeed: 1.5 }));
    await sweep();
    await page.waitForFunction(() => document.body.dataset.mode === 'idle', null, { timeout: 1500 });
    const hasFragments = () => page.locator('#flock').evaluate(canvas => {
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
      return false;
    });
    await page.waitForTimeout(1500);
    assert.equal(await hasFragments(), false, 'a fast sweep sends every fragment offscreen');
    assert.equal(await page.locator('#pet-launcher').count(), 0, 'ordinary idle leaves no bottom-right obstruction');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocusable()), false, 'idle cannot capture keyboard focus');
    await page.evaluate(() => {
      window.testRoaming = [];
      window.stopRoamingProbe = window.deskghost.onEvent(event => { if (event.type === 'roaming') window.testRoaming.push(event.active); });
    });
    const focusedBeforeRoaming = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused());
    await app.evaluate(({ powerMonitor, screen }) => {
      const cursor = screen.getCursorScreenPoint();
      globalThis.testIdleOriginal = { idle: powerMonitor.getSystemIdleTime, state: powerMonitor.getSystemIdleState, cursor: screen.getCursorScreenPoint, reads: 0 };
      screen.getCursorScreenPoint = () => cursor;
      powerMonitor.getSystemIdleTime = () => { globalThis.testIdleOriginal.reads++; return 181; };
      powerMonitor.getSystemIdleState = () => 'idle';
    });
    try {
      await page.waitForFunction(() => window.testRoaming.at(-1) === true, null, { timeout: 6000 }).catch(async error => {
        console.log('Idle probe:', await page.evaluate(() => ({ mode: document.body.dataset.mode, roaming: window.testRoaming, toast: document.getElementById('toast').textContent })),
          await app.evaluate(() => ({ reads: globalThis.testIdleOriginal.reads })));
        throw error;
      });
      await page.waitForTimeout(3500);
      assert.equal(await hasFragments(), true, 'long system inactivity starts slow roaming from the edges');
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), focusedBeforeRoaming, 'roaming does not change focus');
      await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
      await page.waitForFunction(() => window.testRoaming.at(-1) === false, null, { timeout: 2500 });
      await page.waitForTimeout(1500);
      assert.equal(await hasFragments(), false, 'renewed system activity clears roaming');
    } finally {
      await app.evaluate(({ powerMonitor, screen }) => {
        powerMonitor.getSystemIdleTime = globalThis.testIdleOriginal.idle;
        powerMonitor.getSystemIdleState = globalThis.testIdleOriginal.state;
        screen.getCursorScreenPoint = globalThis.testIdleOriginal.cursor;
        delete globalThis.testIdleOriginal;
      });
      await page.evaluate(() => { window.stopRoamingProbe(); delete window.stopRoamingProbe; delete window.testRoaming; });
    }
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'graph' }));
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
    await page.locator('#fit-graph').click(); await page.waitForTimeout(350);
    const columnsBeforeAppend = (await workspace()).columns.length;
    const appendStart = await card(fixture.pcb).boundingBox();
    const appendTarget = await page.locator('.dg-new-column').boundingBox();
    const appendGrip = { x: appendStart.x + appendStart.width / 2, y: appendStart.y + appendStart.height * .4 };
    await page.mouse.move(appendGrip.x, appendGrip.y); await page.mouse.down();
    await page.mouse.move(appendTarget.x + appendTarget.width / 2, appendGrip.y, { steps: 22 });
    await page.mouse.up(); await page.waitForTimeout(420);
    if ((await workspace()).columns.length !== columnsBeforeAppend + 1) {
      console.log('Append probe:', { appendStart, appendTarget }, await page.evaluate(() => ({ toast: document.getElementById('toast').textContent, mode: document.body.dataset.mode })));
      await page.screenshot({ path: path.join(output, 'append-failure.png') });
    }
    assert.equal((await workspace()).columns.length, columnsBeforeAppend + 1, 'dropping beyond the last column creates one new time slice');
    assert.equal((await workspace()).tasks.find(task => task.id === fixture.pcb).column, columnsBeforeAppend);
    await page.locator('#undo').click();
    assert.equal((await workspace()).columns.length, columnsBeforeAppend, 'one undo restores the move and appended time slice');
    assert.equal((await workspace()).tasks.find(task => task.id === fixture.pcb).column, 1);
    await page.locator('#new-task').click();
    const compact = await page.locator('#composer').evaluate(element => {
      const graphCard = document.querySelector('.dg-task-card'), style = getComputedStyle(element), graphStyle = getComputedStyle(graphCard);
      return { width: element.offsetWidth, height: element.offsetHeight, sharedWidth: style.width === graphStyle.width, sharedSurface: style.backgroundImage === graphStyle.backgroundImage && style.borderRadius === graphStyle.borderRadius };
    });
    assert.equal(compact.width, 266); assert.ok(compact.height < 350);
    assert.equal(compact.sharedWidth, true); assert.equal(compact.sharedSurface, true);
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
    const quickTask = (await workspace()).tasks.find(task => task.title === '键盘捕捉灵感');
    assert.equal(quickTask.column, (await workspace()).columns.length - 1, 'independent quick capture goes into the latest logical column');
    await page.locator('#fit-graph').click(); await page.waitForTimeout(350);
    await drag(await center(card(fixture.merge).locator('[data-port="out"]')), await center(card(quickTask.id).locator('[data-port="in"]')));
    assert.ok((await workspace()).links.some(link => link.sourceId === fixture.merge && link.targetId === quickTask.id), 'quick-created card can be attached after an existing task');
    assert.equal((await workspace()).tasks.find(task => task.id === quickTask.id).column, 3, 'connection moves the earlier card after its source');
    await page.locator('#undo').click();
    assert.equal((await workspace()).tasks.find(task => task.id === quickTask.id).column, quickTask.column);
    assert.ok(!(await workspace()).links.some(link => link.targetId === quickTask.id), 'one undo restores the card position and links');
    await page.locator('#redo').click();
    assert.equal((await workspace()).tasks.find(task => task.id === quickTask.id).column, 3);
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
    await page.evaluate(() => window.deskghost.invoke('hide'));
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'ready' }));
    await page.waitForFunction(() => document.body.dataset.mode === 'ready');
    await tapWand();
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
    await page.evaluate(() => {
      window.testActivations = [];
      window.stopActivationProbe = window.deskghost.onEvent(event => { if (event.type === 'summon') window.testActivations.push(event.activationId); });
    });
    await page.evaluate(() => window.deskghost.invoke('hide'));
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      globalThis.testFocusCalls = 0;
      globalThis.testWindowFocus = window.focus; globalThis.testWebFocus = window.webContents.focus;
      window.focus = () => { globalThis.testFocusCalls++; };
      window.webContents.focus = () => { globalThis.testFocusCalls++; };
    });
    try {
      await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'ready' }));
      await page.waitForFunction(() => !document.getElementById('wand-anchor').classList.contains('is-pending') && document.body.dataset.mode === 'ready');
      await page.waitForTimeout(80);
      assert.equal(await app.evaluate(() => globalThis.testFocusCalls), 0, 'circle summon does not attempt native or Chromium activation');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('blur'));
      assert.equal(await page.locator('body').getAttribute('data-mode'), 'ready', 'an inactive preparation surface survives native blur');
      assert.equal(await page.locator('#composer').evaluate(element => element.hidden), true);
      const previousActivation = await page.evaluate(() => window.testActivations.at(-1));
      await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'ready' }));
      await page.waitForFunction(previous => window.testActivations.at(-1) !== previous && !document.getElementById('wand-anchor').classList.contains('is-pending'), previousActivation);
      assert.equal(await page.evaluate(readyActivation => window.deskghost.invoke('setRegions', { readyActivation, regions: [] }), previousActivation), false, 'late hit-region acknowledgments cannot replace a new preparation surface');
      await app.evaluate(({ BrowserWindow }, activationId) => BrowserWindow.getAllWindows()[0].webContents.send('deskghost:event', { type: 'inputFocus', mode: 'ready', activationId, active: false }), previousActivation);
      assert.equal(await page.locator('#composer').evaluate(element => element.hidden), true, 'old activation failures do not open a card');
      await tapWand();
      assert.equal(await app.evaluate(() => globalThis.testFocusCalls), 0, 'clicking opens the title without a second native focus request');
      assert.equal(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Escape')), false, 'temporary Escape is released when creation starts');
    } finally {
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.focus = globalThis.testWindowFocus; window.webContents.focus = globalThis.testWebFocus;
        delete globalThis.testWindowFocus; delete globalThis.testWebFocus; delete globalThis.testFocusCalls;
      });
    }
    // Composition remains in the title that received the click. This verifies
    // the DOM lifecycle; the Windows routing subtest below uses native input.
    const composition = await page.locator('#task-title').evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      input.value = '灵感'; input.setSelectionRange(2, 2);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true, data: '灵感' }));
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '灵感' }));
      return input === document.getElementById('task-title') && input === document.activeElement && input.value === '灵感' && input.selectionStart === 2;
    });
    assert.equal(composition, true, 'composition uses the same focused title');
    await page.keyboard.press('Control+Enter');
    await app.evaluate(({ BrowserWindow }, activationId) => BrowserWindow.getAllWindows()[0].webContents.send('deskghost:event', { type: 'inputFocus', mode: 'ready', activationId, active: true }), await page.evaluate(() => window.testActivations.at(-1)));
    assert.equal(await page.locator('#task-category').evaluate(input => input === document.activeElement), true, 'old focus notifications do not interrupt the next field');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.stopActivationProbe(); delete window.stopActivationProbe; delete window.testActivations; });
    await context.test('Windows click and keyboard delivery with focus emulation disabled', async nativeTest => {
      const cdp = await page.context().newCDPSession(page);
      await page.evaluate(() => window.deskghost.invoke('hide'));
      await page.evaluate(() => window.deskghost.invoke('updateSettings', { effects: 'off' }));
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      try {
        await replayWand(1200);
        await page.waitForFunction(() => !document.getElementById('wand-anchor').hidden && !document.getElementById('wand-anchor').classList.contains('is-pending'));
        const landing = await page.locator('#wand-anchor').evaluate(element => {
          const box = element.getBoundingClientRect();
          return { x: box.x + box.width * .2, y: box.y + box.height * .3, width: innerWidth, height: innerHeight };
        });
        await app.evaluate(({ screen, BrowserWindow }, point) => {
          globalThis.testNativeCursor = screen.getCursorScreenPoint;
          const bounds = BrowserWindow.getAllWindows()[0].getBounds();
          screen.getCursorScreenPoint = () => ({ x: bounds.x + point.x, y: bounds.y + point.y });
        }, landing);
        const target = await app.evaluate(({ BrowserWindow }) => ({ handle: BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString(), pid: process.pid }));
        assert.match(target.handle, /^\d+$/); assert.ok(Number.isInteger(target.pid));
        // SendInput is global: validate foreground, child focus and owner PID
        // before EVERY character. Never send test input into another application.
        const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeskGhostKeyboardCheck {
  [StructLayout(LayoutKind.Sequential)] struct GUI { public int size; public uint flags; public IntPtr active,focus,capture,menu,move,caret; public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort code,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Explicit, Size=32)] struct DATA { [FieldOffset(0)] public KEY key; [FieldOffset(0)] public MOUSE mouse; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public DATA data; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GUI info);
  [DllImport("user32.dll")] static extern uint SendInput(uint count,INPUT[] inputs,int size);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref POINT point);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  public static bool Click(long handle,uint pid,double x,double y) {
    IntPtr window=new IntPtr(handle), dpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      RECT rect; POINT point=new POINT(); uint actual;
      if (x<0 || x>1 || y<0 || y>1 || !GetClientRect(window,out rect) || !ClientToScreen(window,ref point)) return false;
      point.x+=(int)Math.Round(x*(rect.right-rect.left)); point.y+=(int)Math.Round(y*(rect.bottom-rect.top));
      GetWindowThreadProcessId(window,out actual);
      // Check the real desktop hit recipient BEFORE moving or clicking. A test
      // session may render screenshots without exposing its window to input.
      if (actual!=pid || GetAncestor(WindowFromPoint(point),2)!=window) return false;
      if (!SetCursorPos(point.x,point.y)) return false;
      POINT current;
      if (!GetCursorPos(out current) || current.x!=point.x || current.y!=point.y || GetAncestor(WindowFromPoint(current),2)!=window) return false;
      INPUT down=new INPUT { type=0, data=new DATA { mouse=new MOUSE { flags=2 } } };
      INPUT up=new INPUT { type=0, data=new DATA { mouse=new MOUSE { flags=4 } } };
      if (SendInput(2,new INPUT[] { down,up },Marshal.SizeOf(typeof(INPUT)))!=2) throw new InvalidOperationException("Windows rejected the test click.");
      System.Threading.Thread.Sleep(120);
      return true;
    } finally { if (dpi!=IntPtr.Zero) SetThreadDpiAwarenessContext(dpi); }
  }
  static bool OwnsInput(IntPtr window,uint pid) {
    if (GetForegroundWindow()!=window) return false;
    uint actual; uint thread=GetWindowThreadProcessId(window,out actual);
    GUI info=new GUI { size=Marshal.SizeOf(typeof(GUI)) };
    return actual==pid && GetGUIThreadInfo(thread,ref info) && GetAncestor(info.focus,2)==window;
  }
  public static bool Type(long handle,uint pid,string text) {
    IntPtr window=new IntPtr(handle);
    if (!OwnsInput(window,pid)) return false;
    foreach(char character in text) {
      if (!OwnsInput(window,pid)) throw new InvalidOperationException("Native input target changed; input stopped.");
      INPUT down=new INPUT { type=1, data=new DATA { key=new KEY { scan=character,flags=4 } } };
      INPUT up=new INPUT { type=1, data=new DATA { key=new KEY { scan=character,flags=6 } } };
      if (SendInput(2,new INPUT[] { down,up },Marshal.SizeOf(typeof(INPUT)))!=2) throw new InvalidOperationException("Windows rejected test input.");
      System.Threading.Thread.Sleep(8);
    }
    return true;
  }
}
'@
$clicked = [DeskGhostKeyboardCheck]::Click(${target.handle}, ${target.pid}, ${landing.x / landing.width}, ${landing.y / landing.height})
$typed = $false
if ($clicked) { $typed = [DeskGhostKeyboardCheck]::Type(${target.handle}, ${target.pid}, 'native first') }
[pscustomobject]@{clicked=$clicked;typed=$typed} | ConvertTo-Json -Compress`;
        const { promisify } = require('node:util');
        const { execFile } = require('node:child_process');
        const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 12000 });
        const report = JSON.parse(result.stdout.trim());
        if (!report.clicked) {
          nativeTest.skip('The preparation surface is not the native desktop hit recipient; no click or keystrokes were sent.');
          return;
        }
        assert.equal(report.typed, true, 'a native preparation click must activate keyboard input');
        await page.waitForFunction(() => document.getElementById('task-title').value === 'native first', null, { timeout: 1500 });
      } finally {
        await app.evaluate(({ screen }) => { if (globalThis.testNativeCursor) { screen.getCursorScreenPoint = globalThis.testNativeCursor; delete globalThis.testNativeCursor; } });
        await page.evaluate(() => { if (!document.getElementById('composer').hidden) document.getElementById('close-composer').click(); });
        await page.evaluate(() => window.deskghost.invoke('hide'));
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await cdp.detach();
      }
    });
    assert.deepEqual(errors, []);
    const final = await snapshot();
    const file = final.documents.find(doc => doc.id === fixture.workspaceId).path;
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(stored.tasks.length, 5);
    console.log('Desktop screenshots and workspace:', output);
    await page.evaluate(() => window.deskghost.invoke('quit')).catch(() => {});
  } finally {
    await app.evaluate(({ powerMonitor }) => { if (globalThis.testActualIdleTime) powerMonitor.getSystemIdleTime = globalThis.testActualIdleTime; }).catch(() => {});
    await app.close().catch(() => {});
  }
});
