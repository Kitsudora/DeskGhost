const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { CircleGestureRecognizer, SpeedDismissRecognizer, DEFAULT_GESTURE_DIFFICULTY } = require('../desktop/gesture.cjs');
const root = path.resolve(__dirname, '..');

test('portable package includes only runtime sources and release documentation', () => {
  const { ignorePackagePath } = require('../scripts/build-desktop.cjs');
  for (const file of ['', '/desktop', '/desktop/main.cjs', '/desktop/web/assets/fonts/Bungee-Regular.ttf', '/package.json', '/README.md']) {
    assert.equal(ignorePackagePath(file), false, file || 'package root');
    assert.equal(ignorePackagePath(file.replaceAll('/', '\\')), false, 'Windows path: ' + file);
  }
  for (const file of ['/assets/card.ai', '/temp', '/temp/private.txt', '/.local/data', '/node_modules', '/desktop-other', '/README.md.bak', '/package-lock.json']) {
    assert.equal(ignorePackagePath(file), true, file);
    assert.equal(ignorePackagePath(file.replaceAll('/', '\\')), true, 'Windows path: ' + file);
  }
});

test('wand requires a prompt, deliberate double circle of screen-relative size', () => {
  // Match the host's 25 Hz cursor polling, including movement immediately before
  // the circle: suffix selection must find the gesture without accepting that
  // approach as part of a drifting loop.
  const replay = ({ duration = 1200, direction = 1, height = 1080, diameter = .25, shape = 'circle', difficulty = 100, rotation = 0, jitter = 0 } = {}) => {
    const wand = new CircleGestureRecognizer();
    let noise = 483902;
    const random = () => { noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0; return noise / 2 ** 32; };
    for (let time = 0; time < 4000; time += 40) wand.addPoint(-height + time / 8, height * .4, height, time, difficulty);
    let found = 0;
    for (let time = 0; time <= duration; time += 40) {
      const progress = time / duration;
      let angle = progress * Math.PI * (shape === 'one-loop' ? 2 : 4) * direction;
      if (shape === 'retraced') angle = Math.min(progress, 1 - progress) * Math.PI * 4 * direction;
      if (shape === 'hand-drawn') angle += .18 * Math.sin(angle);
      const radius = height * diameter / 2 * (shape === 'growing' ? .6 + .8 * progress : shape === 'hand-drawn' ? 1 + .055 * Math.sin(angle * 3) + .018 * Math.sin(angle * 7) : 1);
      let x = Math.cos(angle) * radius, y = Math.sin(angle * (shape === 'figure-eight' ? 2 : 1)) * radius;
      if (shape === 'ellipse' || shape === 'flattened') { x *= shape === 'ellipse' ? 1.1 : 1.4; y *= shape === 'ellipse' ? .9 : .6; }
      if (shape === 'loose-ellipse') { x *= 1.22; y *= .78; }
      if (shape === 'uneven') { const wobble = 1 + .12 * Math.sin(angle * 3); x *= wobble; y *= wobble; }
      if (shape === 'rough-loops') {
        const wobble = .84 + .28 * progress + .18 * Math.sin(angle * 3) + .035 * Math.sin(angle * 7);
        x = Math.cos(angle + .14 * Math.sin(angle * 2)) * radius * wobble;
        y = Math.sin(angle + .14 * Math.sin(angle * 2)) * radius * wobble * .82;
        x += height * .025 * progress; y += height * .014 * progress;
      }
      if (shape === 'tilted-oval') {
        const rotation = .65, wide = x * 1.28, narrow = y * .68;
        x = wide * Math.cos(rotation) - narrow * Math.sin(rotation);
        y = wide * Math.sin(rotation) + narrow * Math.cos(rotation);
      }
      if (shape === 'drifting') { x += height * .2 * progress; y += height * .06 * progress; }
      if (shape === 'hand-drawn') { x += height * .009 * progress; y += height * .005 * progress; }
      if (shape === 'zigzag') { x = height * .45 * progress; y = Math.sin(angle * 3) * radius; }
      if (shape === 'square' || shape === 'polygon') {
        const vertices = shape === 'square' ? [[1, 1], [-1, 1], [-1, -1], [1, -1]] : [[1.07, .07], [.63, .89], [-.07, .37], [-1.04, .52], [-.81, -.7], [.22, -.89]];
        const q = (direction === 1 ? progress : 1 - progress) * vertices.length * 2, index = Math.floor(q) % vertices.length, fraction = q - Math.floor(q);
        [x, y] = vertices[index].map((value, axis) => (value + (vertices[(index + 1) % vertices.length][axis] - value) * fraction) * radius);
      }
      const rotatedX = x * Math.cos(rotation) - y * Math.sin(rotation), rotatedY = x * Math.sin(rotation) + y * Math.cos(rotation);
      found += Number(wand.addPoint(-height * .4 + rotatedX + (random() - .5) * jitter, height * .5 + rotatedY + (random() - .5) * jitter, height, 4000 + time, difficulty));
      assert.ok(wand.points.length <= 104, 'input history stays bounded');
      if (wand.points.length) assert.ok(wand.points.at(-1).time - wand.points[0].time <= 3800 - difficulty * 16, 'slow traces expire at the configured difficulty');
    }
    return found;
  };
  for (const duration of [640, 800, 1200, 2000, 2200]) for (const direction of [-1, 1]) {
    for (const shape of ['circle', 'ellipse', 'hand-drawn'])
      assert.equal(replay({ duration, direction, shape }), 1, `${shape}, ${duration} ms, direction ${direction}: summon once`);
  }
  for (const height of [540, 1080, 2160]) for (const diameter of [.205, .25, .335])
    assert.equal(replay({ height, diameter }), 1, `diameter ${diameter} of ${height} DIP screen height is deliberate`);
  for (const diameter of [.03, .12, .195, .345, .5])
    assert.equal(replay({ diameter }), 0, `diameter ${diameter} is outside the required size`);
  for (const duration of [400, 480, 2400, 4000, 8000])
    assert.equal(replay({ duration }), 0, `${duration} ms does not fit the deliberate gesture window`);
  for (const shape of ['one-loop', 'retraced', 'figure-eight', 'zigzag', 'flattened', 'drifting', 'growing', 'square', 'polygon'])
    for (const duration of [800, 2000, 8000]) for (const direction of [-1, 1])
      assert.equal(replay({ shape, duration, direction }), 0, `${shape}, ${duration} ms, direction ${direction} is not a deliberate double circle`);
  assert.equal(DEFAULT_GESTURE_DIFFICULTY, 40);
  for (const difficulty of [0, 40]) for (const options of [{ duration: 2800 }, { diameter: .18 }, { diameter: .38 }, { shape: 'loose-ellipse' }, { shape: 'uneven' }, { shape: 'rough-loops' }, { shape: 'tilted-oval' }]) {
    for (const direction of [-1, 1]) {
      assert.equal(replay({ ...options, direction, difficulty }), 1, `${JSON.stringify(options)} is easier at difficulty ${difficulty}`);
      assert.equal(replay({ ...options, direction, difficulty: 100 }), 0, 'Strict retains the previous limits');
    }
  }
  for (const difficulty of [0, 40, 100]) {
    assert.equal(replay({ difficulty }), 1, `difficulty boundary ${difficulty} accepts deliberate circles`);
    for (const diameter of [.03, .09, .6]) assert.equal(replay({ diameter, difficulty }), 0, 'even Easy requires a screen-relative loop');
    for (const duration of [400, 480, 4400, 8000]) assert.equal(replay({ duration, difficulty }), 0, 'too fast or stale circles do not summon');
    for (const shape of ['one-loop', 'retraced', 'figure-eight', 'zigzag']) for (const direction of [-1, 1])
      assert.equal(replay({ shape, direction, difficulty }), 0, `${shape} is rejected at difficulty ${difficulty}`);
  }
  for (const shape of ['square', 'polygon', 'flattened']) for (const direction of [-1, 1]) {
    assert.equal(replay({ shape, direction, difficulty: 0 }), 1, 'Easy recognizes deliberate loops even with corners or a narrow oval');
    assert.equal(replay({ shape, direction, difficulty: 100 }), 0, 'Strict still requires a rounder shape');
  }
  for (const shape of ['rough-loops', 'tilted-oval']) for (const duration of [800, 1200, 2000]) for (const rotation of [0, .7, 1.4]) for (const direction of [-1, 1]) {
    assert.equal(replay({ shape, duration, rotation, direction, jitter: 8, difficulty: 40 }), 1, `${shape} remains natural at ${duration} ms and rotation ${rotation}, direction ${direction}, with pointer noise`);
  }
  for (const diameter of [.12, .5]) {
    assert.equal(replay({ diameter, difficulty: 0 }), 1, 'Easy expands both size limits');
    assert.equal(replay({ diameter, difficulty: 40 }), 0, 'Normal retains a more deliberate size');
    assert.equal(replay({ diameter, difficulty: 100 }), 0, 'Strict retains the original size');
  }
  for (const difficulty of [NaN, Infinity, -.01, 100.01, 40.5, null, '40']) assert.equal(replay({ difficulty }), 0, 'invalid difficulties are rejected');
  const changed = new CircleGestureRecognizer();
  for (let time = 0; time <= 1200; time += 40) {
    const angle = time / 1200 * Math.PI * 4;
    assert.equal(changed.addPoint(600 + Math.cos(angle) * 135, 450 + Math.sin(angle) * 135, 1080, time, time < 600 ? 100 : 0), false, 'changing difficulty discards a partial gesture');
  }
  let changedSummons = 0;
  for (let time = 1240; time <= 2440; time += 40) {
    const angle = (time - 1200) / 1200 * Math.PI * 4;
    changedSummons += Number(changed.addPoint(600 + Math.cos(angle) * 135, 450 + Math.sin(angle) * 135, 1080, time, 0));
  }
  assert.equal(changedSummons, 1, 'fresh complete motion works after a configuration change');
  const defaultWand = new CircleGestureRecognizer();
  let defaultSummons = 0;
  for (let time = 0; time <= 2800; time += 40) {
    const angle = time / 2800 * Math.PI * 4;
    defaultSummons += Number(defaultWand.addPoint(600 + Math.cos(angle) * 97.2, 450 + Math.sin(angle) * 97.2, 1080, time));
  }
  assert.equal(defaultSummons, 1, 'callers without a difficulty use the more forgiving default');
  const oversampled = new CircleGestureRecognizer();
  for (let time = 0; time <= 5000; time += 4) {
    oversampled.addPoint(time * 2, 200, 1080, time, 0);
    assert.ok(oversampled.points.length <= 104, 'unexpected high-frequency input cannot grow the bounded history');
  }
  assert.equal(oversampled.points.length, 104, 'the test reaches the history cap');
  const line = new CircleGestureRecognizer();
  for (let i = 0; i < 200; i++) assert.equal(line.addPoint(i * 5, 200, 1080, i * 20), false);
  for (const sample of [[NaN, 0, 1080, 8000], [0, Infinity, 1080, 8040], [0, 0, 0, 8080], [0, 0, 1080, -1]])
    assert.equal(line.addPoint(...sample), false, 'invalid samples are safely rejected');
  const cooldown = new CircleGestureRecognizer();
  let summons = 0;
  for (let time = 0; time <= 2400; time += 40) {
    const angle = time / 800 * Math.PI * 4;
    summons += Number(cooldown.addPoint(600 + Math.cos(angle) * 135, 450 + Math.sin(angle) * 135, 1080, time));
  }
  assert.equal(summons, 1, 'the summon tail and continuing circles stay inside the 2 second cooldown');
  const wandering = new CircleGestureRecognizer();
  let seed = 2864727779, x = 600, y = 450;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 3000; i++) {
    x = Math.max(400, Math.min(800, x + (random() - .5) * 65));
    y = Math.max(250, Math.min(650, y + (random() - .5) * 65));
    assert.equal(wandering.addPoint(x, y, 1080, 1000 + i * 40, 0), false, 'ordinary wandering must not summon even on Easy');
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

test('card geometry, connection previews and sticker swipes preserve task rules', async () => {
  const { nextStickerState, stickerGestureDirection, peelSurface } = await import('../desktop/web/sticker.js');
  const { graphGeometry, validateConnection, planConnection } = await import('../desktop/web/graph.js');
  assert.equal(graphGeometry.cardWidth / graphGeometry.cardHeight, 621.3463 / 457.9779);
  assert.ok(graphGeometry.columnStep > graphGeometry.cardWidth && graphGeometry.rowStep > graphGeometry.cardHeight);
  const archived = { id: 'archived', column: 0, row: 0, isArchived: true }, active = { id: 'active', column: 1, row: 0, isArchived: false };
  assert.equal(validateConnection(archived, active), false, 'new connections cannot split an archived chain');
  assert.deepEqual(planConnection([archived, active], [], archived.id, active.id), { valid: false, reason: 'Restore the archived chain before connecting it to active tasks.' });
  const oldLink = { sourceId: archived.id, targetId: active.id };
  assert.equal(validateConnection(archived, active, [oldLink], oldLink), true, 'an unchanged historical mixed-archive connection remains valid');
  for (const [state, advance, reverse] of [
    ['NotStarted', 'InProgress', null], ['InProgress', 'Completed', 'NotStarted'],
    ['Completed', null, 'InProgress'], ['Stopped', 'InProgress', 'NotStarted']
  ]) {
    assert.equal(nextStickerState(state, 'advance'), advance);
    assert.equal(nextStickerState(state, 'reverse'), reverse);
    assert.equal(nextStickerState(state, 'stop'), state === 'Stopped' ? null : 'Stopped');
  }
  for (const [dx, dy, expected] of [[0, -50, 'stop'], [-30, -30, 'stop'], [30, -30, 'stop'], [-30, -3, 'advance'], [30, -3, 'reverse'], [0, 50, null], [3, -3, null]])
    assert.equal(stickerGestureDirection(dx, dy), expected, 'upward intent is distinct from horizontal hand tremors');
  assert.equal(stickerGestureDirection(-50, -60, 'advance'), 'advance', 'a deliberate pull keeps its initial direction');
  assert.equal(stickerGestureDirection(30, -3, 'stop'), 'stop');
  assert.equal(stickerGestureDirection(NaN, -30), null);
  for (const progress of [0, .12, .35, .66, .85, 1]) {
    let previous = null;
    for (let u = -90; u <= 90; u += .5) {
      const point = peelSurface(u, 90, progress, 1);
      const reverse = peelSurface(-u, 90, progress, -1);
      assert.ok(Object.values(point).every(Number.isFinite));
      assert.ok(point.z >= 0, 'the material lifts away from the card');
      assert.ok(Math.abs(point.x + reverse.x) < 1e-9 && Math.abs(point.z - reverse.z) < 1e-9, 'reverse swipes mirror the same fold');
      if (previous) assert.ok(Math.hypot(point.x - previous.x, point.z - previous.z) <= .500001, 'neighboring material points cannot stretch or jump apart');
      previous = point;
    }
  }
});

test('leather workspace: direct manipulation, keyboard capture and durable saves', { skip: !process.argv.includes('--ui'), timeout: 180000 }, async context => {
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
  if (executablePath) {
    const resources = path.join(path.dirname(executablePath), 'resources');
    const { listPackage } = await import('@electron/asar');
    const topLevel = [...new Set(listPackage(path.join(resources, 'app.asar')).map(file => file.replaceAll('\\', '/').split('/').filter(Boolean)[0]))].sort();
    assert.deepEqual(topLevel, ['README.md', 'desktop', 'package.json'], 'the release does not ship authoring assets, local data or temporary folders');
    for (const file of ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT']) assert.ok((await fs.readFile(path.join(resources, 'bridge', file), 'utf8')).trim().length > 0, '.NET runtime notice: ' + file);
  }
  const app = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [root]), '--data-dir', output], cwd: root, timeout: 30000, env: electronEnv });
  try {
    const page = await app.firstWindow();
    const waitScene = async open => {
      await page.waitForFunction(open => {
        const scene = document.getElementById('desk-scene');
        return scene.dataset.open === String(open) && scene.dataset.moving !== 'true';
      }, open);
      assert.equal(await page.evaluate(open => ['scene-hook', 'scene-hook-front'].every(id => {
        const hook = document.getElementById(id), style = getComputedStyle(hook);
        return hook.dataset.moving === 'false' && !hook.getAnimations().length &&
          (open ? style.visibility === 'visible' && Math.abs(new DOMMatrixReadOnly(style.transform).m42) < .01
            : style.visibility === 'hidden' && hook.getBoundingClientRect().bottom <= 0);
      }), open), true, 'both hook layers settle on screen when open and fully retract when closed');
    };
    // CDP typing does not reset Windows idle time. Keep the unrelated checks
    // active, then explicitly advance idle time only in the roaming scenario.
    await app.evaluate(({ powerMonitor }) => {
      globalThis.testActualIdleTime = powerMonitor.getSystemIdleTime;
      powerMonitor.getSystemIdleTime = () => 0;
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.getElementById('boot-screen')?.hidden, null, { timeout: 25000 });
    await waitScene(true);
    // A late startup response must not reopen a board dismissed with Escape.
    // Hold only this test instance's bootstrap reply; other IPC stays live.
    await app.evaluate(({ ipcMain }) => {
      const original = globalThis.testBootstrapHandler = ipcMain._invokeHandlers.get('deskghost:invoke');
      globalThis.testBootstrapHeld = new Promise(resolve => { globalThis.testBootstrapNotify = resolve; });
      ipcMain._invokeHandlers.set('deskghost:invoke', async (event, method, payload) => {
        const result = await original(event, method, payload);
        if (method === 'bootstrap') {
          await new Promise(resolve => { globalThis.testBootstrapRelease = resolve; globalThis.testBootstrapNotify(); });
        }
        return result;
      });
    });
    try {
      await page.reload();
      await app.evaluate(() => globalThis.testBootstrapHeld);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.body.dataset.mode === 'idle');
      await app.evaluate(() => globalThis.testBootstrapRelease());
      await page.waitForFunction(() => document.getElementById('boot-screen').hidden);
      assert.equal(await page.locator('body').getAttribute('data-mode'), 'idle', 'loading cannot reopen the board after the first Escape');
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocusable()), false, 'the renderer stays in sync with the dismissed native window');
    } finally {
      await app.evaluate(({ ipcMain }) => {
        globalThis.testBootstrapRelease?.();
        ipcMain._invokeHandlers.set('deskghost:invoke', globalThis.testBootstrapHandler);
        for (const key of ['testBootstrapHandler', 'testBootstrapHeld', 'testBootstrapNotify', 'testBootstrapRelease']) delete globalThis[key];
      });
    }
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'graph' }));
    await waitScene(true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)');
    const native = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { background: window.getBackgroundColor(), resizable: window.isResizable(), sandbox: window.webContents.getLastWebPreferences().sandbox, node: window.webContents.getLastWebPreferences().nodeIntegration, isolated: window.webContents.getLastWebPreferences().contextIsolation };
    });
    assert.ok(['#000000', '#00000000'].includes(native.background)); assert.equal(native.resizable, false);
    assert.equal(native.sandbox, true); assert.equal(native.node, false); assert.equal(native.isolated, true);
    const dispersion = await page.evaluate(async () => {
      const { Flock } = await import('./flock.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px;pointer-events:none';
      document.body.append(canvas);
      const flock = new Flock(canvas);
      try {
        return [{ x: 640, y: 360 }, { x: 1160, y: 90 }].map(point => {
          flock.setMode('ring', { point }); flock._stop();
          // Reproduce a whole flock trailing a fast mouse on the same side.
          flock._boids.forEach((boid, index) => Object.assign(boid, {
            x: point.x - 260 + index % 9 * 6, y: point.y + 30 + Math.floor(index / 9) * 7,
            vx: 1500, vy: 180, departed: false, opacity: 1
          }));
          const before = flock._boids.map(boid => [boid.x, boid.y, boid.vx, boid.vy]);
          flock.setMode('disperse'); flock._stop();
          const continuous = flock._boids.every((boid, index) => [boid.x, boid.y, boid.vx, boid.vy].every((value, axis) => value === before[index][axis]));
          const sectors = new Set(flock._boids.map(boid => Math.floor(((Math.atan2(boid.ty - point.y, boid.tx - point.x) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4))));
          const outside = flock._boids.every(boid => boid.tx < 0 || boid.tx > 1280 || boid.ty < 0 || boid.ty > 720);
          for (let frame = 0; frame < 220 && flock._mode !== 'hidden'; frame++) {
            flock._tick(frame * 1000 / 60);
            if (flock._raf !== null) { cancelAnimationFrame(flock._raf); flock._raf = null; }
          }
          return { continuous, sectors: sectors.size, outside, stopped: flock._mode === 'hidden' && flock._raf === null };
        });
      } finally { flock.destroy(); canvas.remove(); }
    });
    for (const result of dispersion) assert.deepEqual(result, { continuous: true, sectors: 8, outside: true, stopped: true }, 'center and edge sweeps spread a trailing flock around the whole circle without a velocity jump');
    const transparentCapture = await page.screenshot({ omitBackground: true });
    const scene = await page.locator('#desk-scene').evaluate(element => {
      const box = element.getBoundingClientRect();
      return { x: (box.left + 18) / innerWidth, y: (box.top + box.height / 2) / innerHeight,
        ownsPanels: ['manager', 'settings-panel', 'name-prompt', 'toast', 'boot-screen'].every(id => element.contains(document.getElementById(id))),
        leather: getComputedStyle(element.querySelector('.scene-leather')).backgroundColor };
    });
    const captureAlpha = await app.evaluate(({ nativeImage }, { bytes, x, y }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(bytes)), { width, height } = image.getSize(), pixels = image.toBitmap();
      return { outside: pixels[3], inside: pixels[(Math.floor(y * height) * width + Math.floor(x * width)) * 4 + 3] };
    }, { bytes: [...transparentCapture], x: scene.x, y: scene.y });
    assert.equal(captureAlpha.outside, 0, 'the desktop outside the leather scene retains real alpha transparency');
    assert.equal(captureAlpha.inside, 255, 'the leather workspace has a solid background');
    assert.equal(scene.ownsPanels, true, 'workspace controls and overlays move with one scene');
    assert.equal(await page.evaluate(() => {
      const graph = document.getElementById('graph-board').getBoundingClientRect();
      const tools = document.querySelector('.graph-controls').getBoundingClientRect();
      return !!document.elementFromPoint(graph.left + graph.width / 2, tools.top + 5)?.closest('#graph-board');
    }), true, 'the graph continues into the bottom tool row instead of ending at an empty leather strip');
    assert.equal(await page.locator('#composer').evaluate(element => element.parentElement === document.body), true, 'the physical card can be carried independently of the board');
    assert.notEqual(scene.leather, 'rgba(0, 0, 0, 0)');
    const hardwareStack = await page.evaluate(() => {
      const ring = document.getElementById('scene-ring'), bar = document.querySelector('.workspace-bar');
      const ringBox = ring.getBoundingClientRect(), barBox = bar.getBoundingClientRect(), x = ringBox.left + ringBox.width / 2;
      const overlapTop = Math.max(ringBox.top, barBox.top), overlapBottom = Math.min(ringBox.bottom, barBox.bottom);
      return { overlaps: overlapBottom > overlapTop,
        covered: document.elementFromPoint(x, (overlapTop + overlapBottom) / 2)?.closest('.workspace-bar') === bar,
        exposed: document.elementFromPoint(x, ringBox.top + ringBox.height * .3) === ring };
    });
    assert.equal(hardwareStack.overlaps && hardwareStack.covered, true, 'the upper bar covers the overlapping brown ring connector');
    assert.equal(hardwareStack.exposed, true, 'the exposed gold ring remains clickable through the otherwise empty manager layer');
    await page.evaluate(() => {
      const scene = document.getElementById('desk-scene');
      window.testSceneFrames = [];
      let frame = 0;
      const capture = () => {
        frame = 0;
        if (scene.dataset.moving !== 'true') return;
        const style = getComputedStyle(scene), matrix = new DOMMatrixReadOnly(style.transform);
        const hook = document.getElementById('scene-hook'), front = document.getElementById('scene-hook-front');
        if (window.testSceneFrames.length < 400) window.testSceneFrames.push({
          x: matrix.m41, y: matrix.m42, scaleX: matrix.m11, scaleY: matrix.m22, opacity: Number(style.opacity), opening: scene.dataset.open === 'true',
          hookY: new DOMMatrixReadOnly(getComputedStyle(hook).transform).m42, frontY: new DOMMatrixReadOnly(getComputedStyle(front).transform).m42,
          hookBottom: hook.getBoundingClientRect().bottom, ringTop: document.getElementById('scene-ring').getBoundingClientRect().top
        });
        frame = requestAnimationFrame(capture);
      };
      const observer = new MutationObserver(() => { if (scene.dataset.moving === 'true' && !frame) frame = requestAnimationFrame(capture); });
      observer.observe(scene, { attributes: true, attributeFilter: ['data-moving'] });
      window.stopSceneProbe = () => { observer.disconnect(); cancelAnimationFrame(frame); };
    });
    assert.equal(await page.locator('#flock').evaluate(canvas => Math.round(canvas.getBoundingClientRect().width) === innerWidth), true);
    assert.equal(await page.evaluate(async () => {
      const fonts = await Promise.all([document.fonts.load('400 16px Bungee'), document.fonts.load('400 23px Teko'), document.fonts.load('400 30px "Smiley Sans"'), document.fonts.load('400 18px Orbitron')]);
      return fonts.every(family => family.length > 0 && family.every(face => face.status === 'loaded'));
    }), true, 'the bundled heading and body fonts load without a network connection');
    assert.equal((await page.evaluate(() => window.deskghost.invoke('bootstrap'))).settings.dismissSpeed, 1.5, 'older settings receive the default dismissal speed');
    assert.equal((await page.evaluate(() => window.deskghost.invoke('bootstrap'))).settings.gestureDifficulty, 40, 'older settings receive the more forgiving wand default');
    await page.locator('#open-settings').click();
    await page.locator('[data-settings-tab="visual"]').click();
    for (const effects of ['low', 'off', 'high']) {
      await page.locator(`button[data-effects="${effects}"]`).click();
      assert.equal(await page.locator('#setting-effects').inputValue(), effects);
      assert.equal(await page.locator(`button[data-effects="${effects}"]`).getAttribute('aria-pressed'), 'true');
    }
    await page.locator('[data-settings-tab="wand"]').click();
    assert.equal(await page.locator('#settings-wand').isVisible(), true);
    assert.equal(await page.locator('#settings-visual').isVisible(), false);
    await page.waitForFunction(() => {
      const cap = document.querySelector('[data-settings-tab="wand"] .plunger');
      return cap && new DOMMatrixReadOnly(getComputedStyle(cap).transform).m42 >= 5.9;
    });
    await page.locator('#setting-dismiss-speed').fill('2.4');
    assert.equal(await page.locator('#dismiss-speed-value').textContent(), '2.4');
    await page.locator('#setting-gesture-difficulty').fill('18');
    assert.equal(await page.locator('#gesture-difficulty-value').textContent(), '18 · Easy');
    assert.equal(await page.locator('#setting-gesture-difficulty').getAttribute('aria-valuetext'), '18 of 100, Easy');
    await page.screenshot({ path: path.join(output, 'dismiss-settings.png'), omitBackground: true });
    await page.locator('#apply-settings').click();
    await page.waitForFunction(() => document.getElementById('settings-panel').hidden);
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'web-settings.json'), 'utf8')).dismissSpeed, 2.4, 'the configured threshold is durably saved');
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'web-settings.json'), 'utf8')).gestureDifficulty, 18, 'the wand difficulty is durably saved');
    for (const invalid of [-1, 101, 40.5, '40', null]) await assert.rejects(page.evaluate(gestureDifficulty => window.deskghost.invoke('updateSettings', { gestureDifficulty }), invalid));
    assert.equal((await page.evaluate(() => window.deskghost.invoke('bootstrap'))).settings.gestureDifficulty, 18, 'invalid difficulty preserves the saved rule');
    await page.locator('#open-settings').click();
    assert.equal(await page.locator('#setting-gesture-difficulty').inputValue(), '18');
    await page.locator('#setting-gesture-difficulty').focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-panel').isVisible(), false);
    assert.equal(await page.locator('#open-settings').evaluate(element => element === document.activeElement), true, 'closing settings restores its keyboard trigger');
    await page.locator('#open-settings').evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true })));
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'graph', 'held Escape does not continue closing the scene after the settings panel');
    for (const invalid of [.49, 4.01, '1.5', null]) await assert.rejects(page.evaluate(dismissSpeed => window.deskghost.invoke('updateSettings', { dismissSpeed }), invalid));
    assert.equal((await page.evaluate(() => window.deskghost.invoke('bootstrap'))).settings.dismissSpeed, 2.4, 'invalid settings preserve the last valid value');
    const flipCard = async face => {
      if (await page.locator('#card-rotor').getAttribute('data-face') !== face) await page.locator('#flip-card').click();
      await page.waitForFunction(face => {
        const rotor = document.getElementById('card-rotor');
        return rotor.dataset.face === face && !rotor.getAnimations().some(animation => animation.playState === 'running');
      }, face);
      assert.equal(await page.locator('#detail-card').evaluate(element => element.inert), face === 'back');
      assert.equal(await page.locator('#detail-back').evaluate(element => element.inert), face === 'front');
    };
    const writeNote = async text => {
      await flipCard('back');
      if (await page.locator('#attach-note').isVisible()) await page.locator('#attach-note').click();
      assert.equal(await page.locator('#task-notes').isEnabled(), true);
      await page.locator('#task-notes').fill(text);
    };
    const finishEditor = async () => {
      await page.locator('#submit-task').click();
      await page.waitForFunction(() => document.getElementById('composer').hidden);
    };
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
        assert.equal(await page.locator('#desk-scene').getAttribute('data-open'), 'false', 'wand capture leaves the board rolled away until placement');
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
        // Give the real poller a stationary starting point before movement.
        // The circle still takes exactly duration ms; otherwise the first
        // 40 ms poll phase can omit the beginning of a fast two-turn replay.
        const started = Date.now() + 100;
        screen.getCursorScreenPoint = () => {
          const angle = Math.max(0, Math.min(1, (Date.now() - started) / duration)) * Math.PI * 4 * direction;
          return { x: Math.round(area.x + area.width / 2 + Math.cos(angle) * area.height * .1375), y: Math.round(area.y + area.height / 2 + Math.sin(angle) * area.height * .1125) };
        };
        try { await new Promise(resolve => setTimeout(resolve, duration + 260)); }
        finally { screen.getCursorScreenPoint = original; }
      }, { duration, direction });
    };
    await replayWand(2000);
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'graph', 'the task graph does not recognize the wand gesture');
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'ready' }));
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'graph', 'the graph also refuses explicit ready summons');
    await page.evaluate(() => window.deskghost.invoke('hide'));
    await page.evaluate(() => window.deskghost.invoke('updateSettings', { gestureDifficulty: 100 }));
    await replayWand(3200);
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'idle', 'strict difficulty rejects a slower double circle');
    await page.evaluate(() => window.deskghost.invoke('updateSettings', { gestureDifficulty: 18 }));
    await replayWand(3200);
    await page.waitForFunction(() => document.body.dataset.mode === 'ready');
    await tapWand();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.body.dataset.mode === 'idle');
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
      assert.equal(await page.locator('#composer').evaluate(element => element.classList.contains('is-assembling')), effects !== 'off', 'wand click starts card assembly unless effects are disabled');
      await page.keyboard.type('wand first letters', { delay: 1 });
      assert.equal(await page.locator('#task-title').inputValue(), 'wand first letters');
      assert.equal(await page.locator('body').getAttribute('data-mode'), 'create');
      if (duration === 2000) {
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#flock').evaluate(canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0)), true, 'assembly renders particles while the title already accepts input');
        await page.screenshot({ path: path.join(output, 'wand-card-assembly.png'), omitBackground: true });
        await page.waitForFunction(() => !document.getElementById('composer').classList.contains('is-assembling'), null, { timeout: 4000 });
        assert.equal(await page.locator('#flock').evaluate(canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0)), false, 'assembled particles are absorbed and clear the canvas');
        assert.equal(await page.locator('#task-title').evaluate(input => input === document.activeElement && input.value === 'wand first letters'), true, 'assembly completion does not change input or focus');
      }
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.body.dataset.mode === 'idle');
      assert.equal(await page.locator('#flock').evaluate(canvas => canvas.classList.contains('is-assembling')), false, 'cancel immediately clears the assembly overlay');
      if (effects !== 'off') {
        await page.waitForFunction(() => {
          const canvas = document.getElementById('flock');
          return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
        }, null, { timeout: 700 });
        assert.equal(await page.locator('#composer').evaluate(element => element.hidden), true, 'cancel releases paper particles without keeping the editor interactive');
        if (duration === 2000) await page.screenshot({ path: path.join(output, 'cancel-card-dispersion.png'), omitBackground: true });
        await page.waitForFunction(() => {
          const canvas = document.getElementById('flock');
          return !canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
        }, null, { timeout: 4200 });
      } else assert.equal(await page.locator('#flock').evaluate(canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0)), false, 'effects-off cancellation never starts a particle animation');
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
    await waitScene(true);
    const fixture = await page.evaluate(async () => {
      const call = (method, payload = {}) => window.deskghost.invoke(method, payload);
      let envelope = await call('bootstrap'); const workspaceId = envelope.activeWorkspaceId;
      const create = async (title, category, column, row) => (await call('createTask', { workspaceId, title, category, description: 'Connect the dots. Explore the next step, one idea at a time.', column, row })).result.taskId;
      const origin = await create('Find the focus', 'Planning', 0, 0);
      const pcb = await create('PCB design', 'Hardware', 1, 0);
      const algorithm = await create('Algorithm study', 'Research', 1, 1);
      const merge = await create('Bring it together', 'Integration', 2, 0);
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
    const revealCards = async (...ids) => {
      await waitScene(true);
      // Pan through the public wheel interaction; the later pointer checks use
      // full-size cards after the bounded zoom checks restore that size.
      for (let attempt = 0; attempt < 4; attempt++) {
        const shift = await page.locator('#graph-board').evaluate((board, ids) => {
          const bounds = board.getBoundingClientRect();
          const cards = ids.map(id => board.querySelector(`.dg-task-card[data-task-id="${id}"]`).getBoundingClientRect());
          const left = Math.min(...cards.map(box => box.left)) - 38, right = Math.max(...cards.map(box => box.right)) + 38;
          const top = Math.min(...cards.map(box => box.top)) - 38, bottom = Math.max(...cards.map(box => box.bottom)) + 28;
          return { x: left < bounds.left ? left - bounds.left : right > bounds.right ? right - bounds.right : 0,
            y: top < bounds.top ? top - bounds.top : bottom > bounds.bottom ? bottom - bounds.bottom : 0 };
        }, ids);
        if (Math.abs(shift.x) > 1) await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: shift.x, shiftKey: true });
        if (Math.abs(shift.y) > 1) await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: shift.y });
        if (Math.abs(shift.x) <= 1 && Math.abs(shift.y) <= 1) break;
      }
    };
    await revealCards(fixture.pcb);
    const drag = async (from, to, during, onPress, beforeRelease) => {
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await onPress?.();
      // Inspect the lifted material away from the board edge, where a held
      // pointer intentionally auto-pans the graph and changes the drop row.
      if (during) { await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 11 }); await during(); }
      await page.mouse.move(to.x, to.y, { steps: during ? 11 : 22 });
      await beforeRelease?.();
      await page.mouse.up(); await page.waitForTimeout(420);
    };
    const center = async locator => { const b = await locator.boundingBox(); assert.ok(b); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const clickTagHead = async locator => {
      const box = await locator.boundingBox(); assert.ok(box);
      // The front hides the label and its shaft behind the card. Only the
      // coloured arrowhead to the left is a pointer target.
      const point = { x: box.x + 6, y: box.y + box.height / 2 };
      assert.equal(await locator.evaluate((tag, point) => document.elementFromPoint(point.x, point.y)?.closest('.dg-paper-tag') === tag, point), true, 'the exposed colour head remains clickable without a connection point intercepting it');
      await page.mouse.click(point.x, point.y);
    };
    const dragToTrash = async () => {
      const target = await center(page.locator('#task-trash'));
      await page.mouse.move(target.x, target.y, { steps: 22 }); await page.mouse.up(); await page.waitForTimeout(420);
    };
    const snapshot = () => page.evaluate(() => window.deskghost.invoke('bootstrap'));
    const workspace = async () => (await snapshot()).documents.find(doc => doc.id === fixture.workspaceId).workspace;
    const connect = async (sourceId, targetId) => {
      await revealCards(sourceId, targetId);
      await card(sourceId).locator('.dg-card-description').click();
      assert.equal(await card(sourceId).locator('.dg-connect-action').count(), 0, 'selection itself exposes the connection points');
      assert.equal(await card(sourceId).locator('[data-port="out"]').evaluate(element => getComputedStyle(element).pointerEvents), 'auto');
      await drag(await center(card(sourceId).locator('[data-port="out"]')), await center(card(targetId).locator('[data-port="in"]')));
    };
    const cardLift = async id => card(id).locator('.dg-card-surface').evaluate(surface => {
      const shadow = getComputedStyle(surface.querySelector('.dg-card-shadow')), face = getComputedStyle(surface.querySelector('.dg-card-faceart'));
      return { shadow: shadow.translate.split(' ').map(Number.parseFloat), face: face.translate.split(' ').map(Number.parseFloat), filter: getComputedStyle(surface).filter, boxShadow: getComputedStyle(surface).boxShadow };
    });
    const graphGeometry = await page.evaluate(async () => (await import('./graph.js')).graphGeometry);
    const camera = () => page.locator('.dg-graph-stage').evaluate(element => { const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform); return { x: matrix.m41, y: matrix.m42, scale: matrix.m11 }; });
    const beforeWheel = await camera();
    const horizontalOverflow = await page.locator('#graph-board').evaluate(board => {
      const last = board.querySelector('.dg-new-column') || board.querySelector('.dg-column:last-child');
      return last.getBoundingClientRect().right + 66 > board.getBoundingClientRect().right;
    });
    await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: -1200, ctrlKey: true });
    assert.deepEqual(await camera(), beforeWheel, 'zoom cannot enlarge the cards beyond the original full size');
    await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: 100, shiftKey: true });
    assert.equal((await camera()).scale, 1);
    if (horizontalOverflow) assert.ok((await camera()).x < beforeWheel.x, 'Shift+wheel scrolls overflowing time slices');
    else assert.equal((await camera()).x, beforeWheel.x, 'a board that already fits does not expose empty off-board space');
    assert.equal((await camera()).y, beforeWheel.y, 'Shift+wheel never moves task rows');
    await page.evaluate(({ workspaceId, taskId }) => window.deskghost.invoke('moveTask', { workspaceId, taskId, column: 1, row: 4 }), { workspaceId: fixture.workspaceId, taskId: fixture.algorithm });
    for (let i = 0; i < 4; i++) await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: 1200, ctrlKey: true });
    await page.locator('#fit-graph').click();
    await page.waitForFunction(({ id, y }) => {
      const card = document.querySelector(`.dg-task-card[data-task-id="${id}"]`);
      return Math.abs(new DOMMatrixReadOnly(getComputedStyle(card).transform).m42 - y) < .1;
    }, { id: fixture.algorithm, y: graphGeometry.top + graphGeometry.rowStep * 4 });
    const smallest = await camera();
    const fiveRows = await page.locator('#graph-board').evaluate((board, ids) => {
      const bounds = board.getBoundingClientRect();
      const first = board.querySelector(`.dg-task-card[data-task-id="${ids.first}"]`).getBoundingClientRect();
      const fifth = board.querySelector(`.dg-task-card[data-task-id="${ids.fifth}"]`).getBoundingClientRect();
      return { top: first.top - bounds.top, bottom: bounds.bottom - fifth.bottom, height: bounds.height };
    }, { first: fixture.origin, fifth: fixture.algorithm });
    assert.ok(smallest.scale > 0 && smallest.scale <= 1);
    assert.ok(fiveRows.top >= 0 && fiveRows.bottom >= 0, 'the minimum size fits the complete first through fifth card rows');
    assert.ok(smallest.scale === 1 || fiveRows.bottom < graphGeometry.rowStep * smallest.scale, 'the minimum stops at five rows rather than shrinking without a limit');
    await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: 1200, ctrlKey: true });
    assert.ok(Math.abs((await camera()).scale - smallest.scale) < .00001, 'further zoom-out remains at the five-row bound');
    await page.locator('#undo').click();
    for (let i = 0; i < 4; i++) await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: -1200, ctrlKey: true });
    assert.equal((await camera()).scale, 1, 'zooming back in restores the original maximum size');
    await page.locator('#fit-graph').click();
    await revealCards(fixture.pcb);
    const beforeRows = await camera();
    const allRowsFit = await page.locator('#graph-board').evaluate(board => Math.max(...[...board.querySelectorAll('.dg-task-card')].map(card => card.getBoundingClientRect().bottom)) <= board.getBoundingClientRect().bottom);
    await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: 120 });
    if (allRowsFit) assert.equal((await camera()).y, beforeRows.y, 'ordinary wheel leaves a board with no overflowing rows still');
    await card(fixture.pcb).locator('.dg-card-description').click();
    await page.evaluate(({ workspaceId, taskId }) => window.deskghost.invoke('moveTask', { workspaceId, taskId, column: 1, row: 40 }), { workspaceId: fixture.workspaceId, taskId: fixture.algorithm });
    const beforeMiddleData = await workspace();
    const selectedBeforeMiddle = await page.locator('.dg-task-card.is-selected').evaluateAll(cards => cards.map(card => card.dataset.taskId));
    const middleStart = await center(card(fixture.pcb).locator('.dg-card-description')), beforeMiddle = await camera();
    const middleEnd = { x: middleStart.x + (beforeMiddle.x < 0 ? 60 : -60), y: middleStart.y - 70 };
    await page.mouse.move(middleStart.x, middleStart.y); await page.mouse.down({ button: 'middle' });
    assert.equal(await page.locator('#graph-board').evaluate(board => board.classList.contains('is-panning') && board.classList.contains('is-interacting')), true);
    await page.mouse.move(middleEnd.x, middleEnd.y, { steps: 8 });
    await page.mouse.up({ button: 'middle' });
    const afterMiddle = await camera();
    assert.ok(Math.abs(afterMiddle.y - (beforeMiddle.y - 70)) < 1, 'middle-dragging a card pans overflowing rows with the pointer');
    assert.equal(afterMiddle.scale, beforeMiddle.scale);
    assert.equal(await page.locator('#graph-board').evaluate(board => !board.classList.contains('is-panning') && !board.classList.contains('is-interacting')), true, 'pointer release ends middle-button panning');
    await page.mouse.move(middleEnd.x + 15, middleEnd.y + 15);
    assert.deepEqual(await camera(), afterMiddle, 'an unpressed mouse no longer moves the camera');
    await revealCards(fixture.origin);
    const middleEdge = await center(page.locator(`.dg-edge-handle[data-edge-key="${fixture.origin}:${fixture.algorithm}"][data-endpoint="source"]`));
    assert.equal(await page.evaluate(point => !!document.elementFromPoint(point.x, point.y)?.closest('.dg-edge'), middleEdge), true, 'the next middle drag begins on a real connection');
    await page.mouse.move(middleEdge.x, middleEdge.y); await page.mouse.down({ button: 'middle' });
    await page.mouse.move(middleEdge.x + 35, middleEdge.y - 35, { steps: 8 });
    await page.keyboard.press('Escape');
    const cancelledMiddle = await camera();
    assert.equal(await page.locator('#graph-board').evaluate(board => !board.classList.contains('is-panning') && !board.classList.contains('is-interacting') && !board.classList.contains('is-linking')), true, 'Escape cancels panning without starting a rewire');
    await page.mouse.move(middleEdge.x + 55, middleEdge.y - 55); await page.mouse.up({ button: 'middle' });
    assert.deepEqual(await camera(), cancelledMiddle);
    assert.equal(await page.locator('body').getAttribute('data-mode'), 'graph', 'pan cancellation does not close the board');
    assert.deepEqual(await page.locator('.dg-task-card.is-selected').evaluateAll(cards => cards.map(card => card.dataset.taskId)), selectedBeforeMiddle, 'middle drags preserve the original card selection');
    assert.deepEqual(await workspace(), beforeMiddleData, 'middle drags never move task records or rewrite connections');
    const beforeOverflow = await camera();
    await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: 320 });
    assert.ok((await camera()).y < beforeOverflow.y, 'overflowing task stacks allow vertical movement');
    await page.locator('#undo').click();
    await page.locator('#fit-graph').click(); await revealCards(fixture.pcb);
    const graphSurface = await card(fixture.pcb).locator('.dg-card-surface').evaluate(element => {
      const box = element.getBoundingClientRect();
      return { width: element.offsetWidth, ratio: box.width / box.height, text: element.innerText, titleSize: parseFloat(getComputedStyle(element.querySelector('.dg-card-title')).fontSize) };
    });
    assert.equal(graphSurface.width, graphGeometry.cardWidth);
    assert.ok(graphSurface.titleSize > 0 && graphSurface.titleSize / graphSurface.width <= 95 / 621.3463 + .001, 'graph titles fit the complete line below the original maximum size');
    assert.ok(Math.abs(graphSurface.ratio - 621.3463 / 457.9779) < .001, 'graph card body preserves the supplied artwork aspect ratio');
    assert.ok(!graphSurface.text.includes(fixture.pcb));
    assert.doesNotMatch(graphSurface.text, /\b(?:TODO|IN PROGRESS|DONE|STOPPED)\b/, 'the card surface expresses status only through its sticker');
    assert.equal(await card(fixture.pcb).locator('.dg-task-state, .dg-card-meta').count(), 0);
    const peel = async (direction, state, artwork) => {
      const button = card(fixture.pcb).locator('.dg-sticker-slot .dg-sticker-button');
      const box = await button.boundingBox(); assert.ok(box);
      assert.equal(await button.evaluate(element => getComputedStyle(element).cursor), 'grab', 'an available sticker shows a grab hand');
      const checkPressedCursor = async () => assert.equal(await button.evaluate(element => getComputedStyle(element).cursor), 'grabbing', 'pressing the sticker closes the grab hand before movement');
      const start = direction === 'advance' ? .78 : .22;
      if (direction === 'stop') await drag({ x: box.x + box.width * .55, y: box.y + box.height * .72 }, { x: box.x + box.width * .28, y: box.y + box.height * .1 }, undefined, checkPressedCursor);
      else await drag({ x: box.x + box.width * start, y: box.y + box.height / 2 }, { x: box.x + box.width * (1 - start), y: box.y + box.height / 2 }, undefined, checkPressedCursor);
      await page.waitForFunction(({ id, state, artwork }) => {
        const button = document.querySelector(`.dg-task-card[data-task-id="${id}"] .dg-sticker-button`);
        const image = button?.querySelector('img');
        return button?.dataset.state === state && !button.hasAttribute('aria-busy') && !button.classList.contains('is-peeling') && image?.complete && image.naturalWidth > 0 && image.src.endsWith(`/${artwork}.svg`);
      }, { id: fixture.pcb, state, artwork }, { timeout: 5000 });
      assert.equal((await workspace()).tasks.find(task => task.id === fixture.pcb).state, state);
    };
    const beforePeel = (await workspace()).tasks.find(task => task.id === fixture.pcb);
    await peel('advance', 'InProgress', 'inprog');
    await peel('reverse', 'NotStarted', 'todo');
    await peel('stop', 'Stopped', 'stopped');
    await peel('reverse', 'NotStarted', 'todo');
    assert.deepEqual(await page.locator('.dg-task-card.is-selected').evaluateAll(cards => cards.map(card => card.dataset.taskId)), [fixture.pcb], 'using a sticker selects the card whose status changes');
    const selectedLift = await cardLift(fixture.pcb);
    assert.ok(selectedLift.shadow[0] > 0 && selectedLift.shadow[1] > 0 && selectedLift.face[1] < 0, 'selection lifts the face opposite its offset shadow');
    assert.equal(selectedLift.filter, 'none'); assert.equal(selectedLift.boxShadow, 'none', 'selection uses the original silhouette without a glow');
    const afterPeel = (await workspace()).tasks.find(task => task.id === fixture.pcb);
    assert.deepEqual([afterPeel.column, afterPeel.row], [beforePeel.column, beforePeel.row], 'peeling does not drag the task card');
    await page.evaluate(({ workspaceId, taskId }) => window.deskghost.invoke('setState', { workspaceId, taskId, state: 'Stopped' }), { workspaceId: fixture.workspaceId, taskId: fixture.pcb });
    for (const state of ['NotStarted', 'InProgress', 'Completed', 'Stopped', '']) {
      await page.locator(`[data-state-filter="${state}"]`).click();
      assert.equal(await page.locator(`[data-state-filter="${state}"]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-state-filter][aria-pressed="true"]').count(), 1);
      const actual = await page.locator('.dg-task-card:not(.is-dimmed)').evaluateAll(cards => cards.map(card => card.dataset.taskId).sort());
      const expected = (await workspace()).tasks.filter(task => !state || task.state === state).map(task => task.id).sort();
      assert.deepEqual(actual, expected, `the ${state || 'All'} stage key highlights exactly its tasks`);
    }
    await page.evaluate(({ workspaceId, taskId }) => window.deskghost.invoke('setState', { workspaceId, taskId, state: 'NotStarted' }), { workspaceId: fixture.workspaceId, taskId: fixture.pcb });
    const beforeRejectedArchive = await workspace();
    await revealCards(fixture.origin);
    await card(fixture.origin).locator('.dg-card-description').click();
    assert.match(await page.locator('#archive-selected').textContent(), /Archive chain/);
    await page.locator('#archive-selected').click();
    await page.waitForFunction(() => /Every task in this connected chain/.test(document.getElementById('toast').textContent));
    assert.deepEqual(await workspace(), beforeRejectedArchive, 'one unfinished neighbor rejects the entire chain archive without changing any member');
    for (const [taskId, state] of [[fixture.algorithm, 'Completed'], [fixture.merge, 'Stopped']])
      await page.evaluate(payload => window.deskghost.invoke('setState', payload), { workspaceId: fixture.workspaceId, taskId, state });
    const beforeArchive = await workspace(), chainIds = [fixture.origin, fixture.algorithm, fixture.merge].sort();
    await page.locator('#archive-selected').click();
    await page.waitForFunction(id => !document.querySelector(`.dg-task-card[data-task-id="${id}"]`), fixture.origin);
    const archivedChain = await workspace();
    assert.deepEqual(archivedChain.tasks.filter(task => task.isArchived).map(task => task.id).sort(), chainIds, 'archiving one card archives the complete connected chain');
    assert.deepEqual(archivedChain.links, beforeArchive.links, 'archiving keeps every visible relationship in history');
    assert.deepEqual(await page.locator('.dg-task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId)), [fixture.pcb], 'the active graph removes the whole archived chain together');
    await page.locator('#archive-mode').click();
    assert.equal(await page.locator('#archive-mode').getAttribute('aria-selected'), 'true');
    assert.deepEqual(await page.locator('.dg-task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId).sort()), chainIds);
    assert.equal(await page.locator('.dg-edge').count(), beforeArchive.links.length, 'the archived graph renders the entire chain and its lines');
    await revealCards(fixture.algorithm);
    await card(fixture.algorithm).locator('.dg-card-description').click();
    assert.match(await page.locator('#restore-selected').textContent(), /Restore chain/);
    await page.locator('#restore-selected').click();
    await page.waitForFunction(() => !document.querySelector('.dg-task-card'));
    assert.ok((await workspace()).tasks.every(task => !task.isArchived), 'restoring any member restores the complete chain');
    await page.locator('#graph-mode').click();
    assert.equal(await page.locator('.dg-task-card').count(), 4);
    assert.equal(await page.locator('.dg-edge').count(), beforeArchive.links.length);
    const legacyContext = await page.evaluate(async ({ saved, archivedId }) => {
      const { TaskGraph } = await import('./graph.js');
      const container = document.createElement('div'), graph = new TaskGraph(container);
      const legacy = structuredClone(saved);
      legacy.tasks.find(task => task.id === archivedId).isArchived = true;
      const inspect = history => {
        graph.setWorkspace(legacy, { history, reducedMotion: true });
        return { cards: [...graph.cards.keys()].sort(), lines: [...container.querySelectorAll('.dg-edge')].map(edge => edge.dataset.edgeKey).sort(), context: [...graph.contextIds].sort() };
      };
      try { return { active: inspect('active'), archived: inspect('archived') }; }
      finally { graph.destroy(); }
    }, { saved: beforeArchive, archivedId: fixture.merge });
    assert.deepEqual(legacyContext.active.cards, beforeArchive.tasks.map(task => task.id).sort(), 'legacy mixed archives retain linked archived cards as visible context');
    assert.deepEqual(legacyContext.active.context, [fixture.merge]);
    assert.deepEqual(legacyContext.archived.cards, chainIds, 'legacy archive view follows the visible lines back through active neighbors');
    assert.deepEqual(legacyContext.archived.context, [fixture.origin, fixture.algorithm].sort());
    assert.equal(legacyContext.active.lines.length, beforeArchive.links.length);
    assert.deepEqual(legacyContext.archived.lines, legacyContext.active.lines, 'both history views retain every actual line in a mixed archive chain');
    for (const [taskId, state] of [[fixture.algorithm, 'InProgress'], [fixture.merge, 'NotStarted']])
      await page.evaluate(payload => window.deskghost.invoke('setState', payload), { workspaceId: fixture.workspaceId, taskId, state });
    await page.locator('#fit-graph').click(); await page.waitForTimeout(300);
    await connect(fixture.origin, fixture.pcb);
    assert.ok((await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.pcb), 'drag connects cards');
    // Keep the third-row drop inside small CI desktops. At full size it can
    // land beyond the board and start edge panning while we inspect the ghost.
    for (let i = 0; i < 4; i++) await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: 1200, ctrlKey: true });
    await page.locator('#fit-graph').click();
    await revealCards(fixture.pcb, fixture.algorithm);
    const start = await card(fixture.pcb).boundingBox();
    const next = await card(fixture.algorithm).boundingBox();
    await drag({ x: start.x + start.width / 2, y: start.y + start.height * .4 }, { x: start.x + start.width / 2 + 7, y: start.y + start.height * .4 + (next.y - start.y) * 2 }, async () => {
      await page.waitForTimeout(250);
      const lifted = await cardLift(fixture.pcb);
      assert.ok(lifted.shadow[0] > selectedLift.shadow[0] && lifted.shadow[1] > selectedLift.shadow[1] && lifted.face[1] < selectedLift.face[1], 'dragging increases physical separation between card and shadow');
    }, undefined, async () => {
      await page.waitForFunction(({ id, geometry }) => {
        const ghost = document.querySelector('.dg-snap-ghost'), card = document.querySelector(`.dg-task-card[data-task-id="${id}"]`);
        const position = new DOMMatrixReadOnly(getComputedStyle(ghost).transform);
        return card.classList.contains('is-dragging') && !ghost.hidden && !ghost.classList.contains('is-invalid') &&
          Math.round(position.m41 / geometry.columnStep) === 1 && Math.round((position.m42 - geometry.top) / geometry.rowStep) === 2;
      }, { id: fixture.pcb, geometry: graphGeometry }, { timeout: 2500 });
    });
    await page.waitForFunction(async ({ workspaceId, taskId }) => {
      const state = await window.deskghost.invoke('bootstrap');
      return state.documents.find(doc => doc.id === workspaceId).workspace.tasks.find(task => task.id === taskId).row === 2;
    }, { workspaceId: fixture.workspaceId, taskId: fixture.pcb }, { polling: 100, timeout: 5000 });
    assert.equal((await workspace()).tasks.find(task => task.id === fixture.pcb).row, 2, 'card snaps to a free row');
    for (let i = 0; i < 4; i++) await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: -1200, ctrlKey: true });
    await page.locator('#fit-graph').click(); await page.waitForTimeout(300);
    await revealCards(fixture.origin, fixture.pcb);
    const edge = page.locator(`.dg-edge-handle[data-edge-key="${fixture.origin}:${fixture.pcb}"][data-endpoint="target"]`);
    const edgePoint = await center(edge);
    await page.mouse.move(edgePoint.x, edgePoint.y); await page.waitForTimeout(100);
    const board = await page.locator('#graph-board').boundingBox();
    await drag(edgePoint, { x: board.x + board.width - 40, y: board.y + board.height - 60 });
    assert.ok(!(await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.pcb), 'dragging an endpoint into empty space disconnects');
    await page.locator('#undo').click();
    assert.ok((await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.pcb), 'undo restores disconnected edge');
    await revealCards(fixture.origin, fixture.merge);
    await drag(await center(edge), await center(card(fixture.merge).locator('[data-port="in"]')));
    assert.ok((await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.merge), 'dragging an endpoint onto a new card rewires');
    assert.ok(!(await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.pcb));
    await page.locator('#undo').click();
    assert.ok((await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.pcb), 'one undo restores the entire rewire');
    await page.locator('#fit-graph').click(); await page.waitForTimeout(350);
    await revealCards(fixture.pcb, fixture.merge);
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
    const captureStarted = Date.now();
    await page.evaluate(() => window.deskghost.invoke('hide'));
    await waitScene(false);
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'create' }));
    assert.equal(await page.locator('#composer').evaluate(element => element.classList.contains('is-assembling')), true, 'direct shortcut creation also assembles particles into the card');
    const enlarged = await page.locator('#detail-card').evaluate(element => {
      const box = element.getBoundingClientRect();
      return { width: element.offsetWidth, ratio: box.width / box.height, centered: Math.abs(box.left + box.width / 2 - innerWidth / 2) < 2,
        titleOnCard: element.contains(document.getElementById('task-title')), descriptionOnCard: element.contains(document.getElementById('task-description')),
        detailsOnBack: ['task-notes', 'detail-id', 'detail-created'].every(id => document.getElementById('detail-back').contains(document.getElementById(id))),
        managerInert: document.getElementById('manager').inert };
    });
    assert.ok(enlarged.width > graphGeometry.cardWidth, 'the editor enlarges the graph card');
    assert.ok(Math.abs(enlarged.ratio - 621.3463 / 457.9779) < .001, 'the enlarged card preserves the artwork body aspect ratio');
    assert.equal(enlarged.centered, true, 'the carried card is centered in front of the desktop');
    assert.equal(enlarged.titleOnCard && enlarged.descriptionOnCard && enlarged.detailsOnBack, true);
    assert.equal(enlarged.managerInert, true, 'the hidden graph cannot intercept editor input');
    assert.equal(await page.locator('#desk-scene').getAttribute('data-open'), 'false', 'shortcut capture keeps the board rolled away');
    assert.equal(await page.locator('#detail-panel').count(), 0, 'details belong to the card back');
    assert.equal(await page.locator('#task-state, #detail-column, #composer-eyebrow, #close-composer, #detail-actions, #detail-save-status, #composer-hint').count(), 0, 'the card has no redundant state selector, stage label or editor notices');
    assert.equal(await page.locator('#card-grip').isVisible(), false, 'new cards have no drag grip or six-dot hint');
    assert.equal(await page.locator('#task-workspace').inputValue(), fixture.workspaceId, 'the card starts in the current workspace');
    assert.equal(await page.locator('#task-category').inputValue(), 'Integration', 'the card starts with the most recently created task category in this workspace');
    const frontHeads = await page.locator('#front-tags .dg-paper-tag').evaluateAll(tags => tags.map(tag => {
      const surface = tag.closest('.dg-card-surface').getBoundingClientRect(), box = tag.getBoundingClientRect();
      return { protrusion: (surface.left - box.left) / surface.width, labelHidden: getComputedStyle(tag.querySelector('.dg-paper-tag-label')).visibility === 'hidden' };
    }));
    assert.ok(frontHeads.every(tag => tag.labelHidden && Math.abs(tag.protrusion - .075) < .002), 'both front tags expose only the same fixed colour head on the left');
    await page.locator('#front-tags .dg-paper-tag[data-tag="category"]').dispatchEvent('pointerenter', { pointerType: 'mouse', buttons: 0 });
    await page.waitForTimeout(180);
    await page.locator('#front-tags .dg-paper-tag[data-tag="category"]').dispatchEvent('click');
    await page.keyboard.press('Alt+w');
    assert.equal(await page.locator('#tag-picker').isVisible(), false, 'front tag hover, click and workspace shortcut do not open the back-side editors');
    assert.equal(await page.locator('#card-rotor').getAttribute('data-face'), 'front');
    await flipCard('front');
    assert.equal(await page.locator('#task-title').evaluate(element => element.tagName), 'INPUT');
    await page.locator('#task-title').fill('First line\nsecond line');
    const pastedTitle = await page.locator('#task-title').inputValue();
    assert.doesNotMatch(pastedTitle, /[\r\n]/, 'pasted title lines stay saveable');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#task-title').inputValue(), pastedTitle, 'Enter does not insert unsupported title controls');
    assert.equal(await page.locator('#task-description').evaluate(element => element === document.activeElement), true, 'ordinary Enter advances directly from title to description');
    assert.equal(await page.locator('#tag-picker').isVisible(), false, 'front keyboard entry skips tags');
    const protectedEnter = await page.locator('#task-description').evaluate(input => {
      for (const detail of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }])
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...detail }));
      return document.activeElement === input && !document.getElementById('composer').hidden;
    });
    assert.equal(protectedEnter, true, 'held Enter and IME confirmation keep the current input without submitting');
    assert.equal((await workspace()).tasks.length, 4, 'protected Enter events never create a task');
    await page.locator('#task-title').fill('A longer title that must remain entirely readable within the brown ribbon without scrolling');
    const longTitle = await page.locator('#task-title').evaluate(input => ({ size: parseFloat(getComputedStyle(input).fontSize), width: input.clientWidth, scrollWidth: input.scrollWidth, height: input.clientHeight, scrollHeight: input.scrollHeight, overflowY: getComputedStyle(input).overflowY }));
    assert.ok(longTitle.scrollWidth <= longTitle.width + 1 && longTitle.scrollHeight <= longTitle.height + 1, 'the complete title fits without either scrollbar');
    assert.ok(['hidden', 'clip'].includes(longTitle.overflowY), 'title overflow never exposes a vertical scrollbar');
    await page.locator('#task-title').fill('Idea');
    assert.ok(await page.locator('#task-title').evaluate(input => parseFloat(getComputedStyle(input).fontSize)) > longTitle.size, 'shortening the title restores the larger lettering');
    await page.locator('#task-title').fill('键盘捕捉灵感'); await page.keyboard.press('Control+Enter');
    assert.equal(await page.locator('#task-description').evaluate(el => el === document.activeElement), true, 'Ctrl+Enter follows the same front-side field order');
    await page.keyboard.press('Alt+f');
    await flipCard('back');
    assert.equal(await page.locator('#attach-note').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#attach-note').evaluate(element => getComputedStyle(element).outlineStyle), 'none', 'keyboard flipping does not draw a blue rectangular outline around Add clip');
    await page.locator('#attach-note').evaluate(element => {
      for (const detail of [{ key: 'f', altKey: true }, { key: 'Escape' }]) element.dispatchEvent(new KeyboardEvent('keydown', { ...detail, repeat: true, bubbles: true, cancelable: true }));
    });
    assert.equal(await page.locator('#card-rotor').getAttribute('data-face'), 'back', 'held flip shortcuts do not rotate repeatedly');
    assert.equal(await page.locator('#composer').isVisible(), true, 'held Escape preserves the current card');
    assert.equal(await page.locator('#close-tag-picker').count(), 0, 'the tag picker has no invisible close button in the keyboard order');
    await page.locator('#back-tags .dg-paper-tag[data-tag="category"]').hover();
    await page.waitForTimeout(220);
    assert.equal(await page.locator('#tag-picker').isVisible(), false, 'hovering over an editable tag no longer opens its choices');
    await page.locator('#back-tags .dg-paper-tag[data-tag="category"]').click();
    assert.equal(await page.locator('#tag-query').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#back-tags .dg-paper-tag[data-tag="category"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#back-tags .dg-paper-tag[data-tag="category"]').evaluate(element => element.classList.contains('is-raised')), true);
    const choices = await page.locator('#tag-picker').evaluate(element => {
      const style = getComputedStyle(element), tags = [...element.querySelectorAll('#tag-options .dg-paper-tag')].map(tag => tag.getBoundingClientRect());
      return { background: style.backgroundColor, shadow: style.boxShadow, stacked: tags.every((box, index) => index === 0 || box.top >= tags[index - 1].bottom - 1), aligned: tags.every(box => Math.abs(box.left - tags[0].left) < 2) };
    });
    assert.equal(choices.background, 'rgb(242, 229, 208)'); assert.notEqual(choices.shadow, 'none', 'tag choices have a solid paper backing and shadow');
    assert.equal(choices.stacked && choices.aligned, true, 'tag choices form a vertical stack');
    await page.keyboard.type('交互设计'); await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.getElementById('tag-picker').hidden);
    assert.equal(await page.locator('#task-category').inputValue(), '交互设计', 'a keyboard tag query creates the category');
    assert.equal(await page.locator('#back-tags .dg-paper-tag[data-tag="category"]').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#back-tags .dg-paper-tag[data-tag="category"]').evaluate(element => element.classList.contains('is-raised')), false, 'committing a tag lowers the paper again');
    assert.equal(await page.locator('#task-description').evaluate(el => el === document.activeElement), true);
    await page.keyboard.type('无边框、透明、丝滑吸附');
    await page.locator('#composer-sticker .dg-sticker-button').focus();
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => { const sticker = document.querySelector('#composer-sticker .dg-sticker-button'); return sticker.dataset.state === 'Stopped' && !sticker.hasAttribute('aria-busy'); });
    const quickNotes = '初次记录的备注\n保留完整详情。';
    await writeNote(quickNotes);
    const backTagWidths = await page.locator('#back-tags .dg-paper-tag').evaluateAll(tags => tags.map(tag => tag.getBoundingClientRect().width));
    assert.notEqual(Math.round(backTagWidths[0]), Math.round(backTagWidths[1]), 'back tag lengths follow their different label contents');
    await page.screenshot({ path: path.join(output, 'composer-back-note.png'), omitBackground: true });
    await flipCard('front');
    await page.locator('#task-description').focus();
    assert.equal(await hasFragments(), false, 'desktop keycaps stop rendering while the leather card editor is open');
    await page.screenshot({ path: path.join(output, 'composer-front.png'), omitBackground: true });
    const tasksBeforePlacement = (await workspace()).tasks.length;
    await page.keyboard.press('Control+Enter');
    await page.evaluate(() => {
      for (let index = 0; index < 8; index++) document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.getElementById('composer').hidden);
    await waitScene(true);
    assert.equal((await workspace()).tasks.length, tasksBeforePlacement + 1, 'confirmation creates exactly one task and returns it automatically without another click or drag');
    assert.ok((await workspace()).tasks.some(task => task.title === '键盘捕捉灵感' && task.category === '交互设计'));
    const quickTask = (await workspace()).tasks.find(task => task.title === '键盘捕捉灵感');
    assert.equal(quickTask.notes, quickNotes, 'creation saves the separate notes field');
    assert.equal(quickTask.state, 'Stopped', 'the initial sticker state is saved with the placed card');
    assert.ok(Date.parse(quickTask.createdAt) >= captureStarted - 1000 && Date.parse(quickTask.createdAt) <= Date.now() + 1000, 'new cards receive an actual creation timestamp');
    assert.equal(quickTask.column, (await workspace()).columns.length - 1, 'independent quick capture goes into the latest logical column');
    // Consecutive Enter confirms a front-only card with its inherited tags.
    // Existing cards still support carrying and zooming after being reopened.
    await page.locator('#new-task').click();
    assert.equal(await page.locator('#task-category').inputValue(), '交互设计', 'the next card inherits the last committed category');
    await page.locator('#task-title').fill('Place by hand');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#task-description').evaluate(element => element === document.activeElement), true);
    await page.keyboard.type('First line'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Second line');
    assert.equal(await page.locator('#task-description').inputValue(), 'First line\nSecond line', 'Shift+Enter keeps multiline description editing available');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('composer').hidden);
    await waitScene(true);
    const placedByHand = (await workspace()).tasks.find(task => task.title === 'Place by hand');
    assert.ok(placedByHand);
    assert.equal(placedByHand.category, '交互设计');
    assert.equal(placedByHand.notes, '', 'front-only confirmation never attaches or creates a note');
    assert.equal(placedByHand.column, (await workspace()).columns.length - 1);
    await revealCards(placedByHand.id);
    await card(placedByHand.id).dblclick();
    await page.waitForFunction(() => !document.getElementById('card-perspective').getAnimations().some(animation => animation.playState === 'running'));
    const grip = await center(page.locator('#card-grip'));
    await page.mouse.move(grip.x, grip.y); await page.mouse.down();
    await page.mouse.move(grip.x + 18, grip.y + 24, { steps: 4 });
    await waitScene(true);
    const placementBoard = await page.locator('#graph-board').boundingBox();
    const placementPoint = { x: placementBoard.x + placementBoard.width / 2, y: placementBoard.y + placementBoard.height * .48 };
    await page.mouse.move(placementPoint.x, placementPoint.y, { steps: 22 });
    await page.locator('#card-grip').dispatchEvent('wheel', { deltaY: 260, ctrlKey: true, clientX: placementPoint.x, clientY: placementPoint.y });
    const carryingCamera = await camera();
    assert.ok(carryingCamera.scale < 1, 'Ctrl+wheel remains available while the grip captures the pointer');
    assert.ok(Math.abs((await page.locator('#card-perspective').boundingBox()).width - graphGeometry.cardWidth * carryingCamera.scale) < .1, 'a held card immediately adopts the new destination scale without another mouse move');
    await page.locator('#card-grip').dispatchEvent('wheel', { deltaY: 140, shiftKey: true, clientX: placementPoint.x, clientY: placementPoint.y });
    assert.equal((await camera()).scale, carryingCamera.scale);
    assert.equal((await camera()).y, carryingCamera.y, 'Shift+wheel carrying moves only through time slices');
    await page.mouse.move(placementPoint.x, placementPoint.y + graphGeometry.rowStep * carryingCamera.scale, { steps: 8 });
    const placementPreview = await page.locator('.dg-snap-ghost').evaluate((element, geometry) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { valid: !element.hidden && !element.classList.contains('is-invalid'), column: Math.round(matrix.m41 / geometry.columnStep), row: Math.round((matrix.m42 - geometry.top) / geometry.rowStep) };
    }, graphGeometry);
    assert.equal(placementPreview.valid, true, 'carrying a card opens a valid snap preview on the board');
    assert.notDeepEqual([placementPreview.column, placementPreview.row], [placedByHand.column, placedByHand.row], 'the carry regression moves to a different slot');
    assert.equal((await workspace()).tasks.length, tasksBeforePlacement + 2, 'moving an existing card never creates another task');
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById('composer').hidden);
    const movedByHand = (await workspace()).tasks.find(task => task.id === placedByHand.id);
    assert.deepEqual([movedByHand.column, movedByHand.row], [placementPreview.column, placementPreview.row], 'release commits exactly the previewed slice and row');
    for (let i = 0; i < 4; i++) await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: -1200, ctrlKey: true });
    assert.equal((await camera()).scale, 1);
    await revealCards(placedByHand.id);
    await drag(await center(card(placedByHand.id).locator('.dg-card-description')), await center(page.locator('#task-trash')));
    assert.ok((await workspace()).tasks.find(task => task.id === placedByHand.id).deletedAt, 'graph cards can be dragged directly to the recycling bin');
    await page.locator('#undo').click();
    assert.ok(!(await workspace()).tasks.find(task => task.id === placedByHand.id).deletedAt, 'recycling remains recoverable');
    await page.locator('#undo').click();
    const restoredPlacement = (await workspace()).tasks.find(task => task.id === placedByHand.id);
    assert.deepEqual([restoredPlacement.column, restoredPlacement.row], [placedByHand.column, placedByHand.row], 'undo restores the position before carrying');
    await page.locator('#undo').click();
    assert.equal((await workspace()).tasks.length, tasksBeforePlacement + 1, 'undo creation removes only the temporary card');
    await page.locator('#fit-graph').click(); await page.waitForTimeout(350);
    await connect(fixture.merge, quickTask.id);
    assert.ok((await workspace()).links.some(link => link.sourceId === fixture.merge && link.targetId === quickTask.id), 'quick-created card can be attached after an existing task');
    assert.equal((await workspace()).tasks.find(task => task.id === quickTask.id).column, 3, 'connection moves the earlier card after its source');
    await page.locator('#undo').click();
    assert.equal((await workspace()).tasks.find(task => task.id === quickTask.id).column, quickTask.column);
    assert.ok(!(await workspace()).links.some(link => link.targetId === quickTask.id), 'one undo restores the card position and links');
    await page.locator('#redo').click();
    assert.equal((await workspace()).tasks.find(task => task.id === quickTask.id).column, 3);
    const categoryColor = await card(quickTask.id).locator('.dg-paper-tag[data-tag="category"]').evaluate(element => element.style.getPropertyValue('--tag-color'));
    await card(quickTask.id).locator('.dg-note-clip').click();
    await flipCard('back');
    assert.equal(await page.locator('#task-notes').inputValue(), quickNotes, 'the graph clip opens the existing note on the card back');
    assert.equal(await page.locator('#back-tags .dg-paper-tag[data-tag="category"]').evaluate(element => element.style.getPropertyValue('--tag-color')), categoryColor, 'tag color stays consistent between graph and editor');
    await finishEditor();
    await clickTagHead(card(quickTask.id).locator('.dg-paper-tag[data-tag="category"]'));
    await page.waitForFunction(() => !document.getElementById('tag-picker').hidden);
    await page.locator('#tag-query').fill('交互');
    assert.equal(await page.locator('#tag-options .dg-paper-tag').count(), 1);
    const categoryPickerAnchor = await page.locator('.dg-paper-tag.is-raised[aria-controls="tag-picker"]').elementHandle();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('tag-picker').hidden);
    assert.equal(await categoryPickerAnchor.evaluate(element => element === document.activeElement), true, 'ordinary Enter returns keyboard focus to the tag that opened the list');
    await categoryPickerAnchor.dispose();
    await page.keyboard.press('Control+f');
    assert.equal(await page.locator('#search-panel').isVisible(), false, 'editing a card cannot open an inert search panel behind it');
    assert.equal(await page.locator('#task-category').inputValue(), '交互设计', 'the graph tag opens a searchable category picker');
    await finishEditor();
    await page.locator('#open-search').click(); await page.locator('#search-title').fill('Algorithm');
    assert.equal(await page.locator('.search-result').count(), 1);
    await page.locator('.search-result').click();
    await page.locator('#clear-search').click();
    await page.keyboard.press('Escape');
    await page.locator('#category-mode').click(); await page.waitForTimeout(250);
    await page.locator('#graph-mode').click(); await page.locator('#fit-graph').click();
    await page.waitForTimeout(3500);
    await page.screenshot({ path: path.join(output, 'graph-leather-scene.png'), omitBackground: true });
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
    await revealCards(fixture.algorithm);
    const originalCreatedAt = (await workspace()).tasks.find(task => task.id === fixture.algorithm).createdAt;
    assert.ok(Number.isFinite(Date.parse(originalCreatedAt)));
    await card(fixture.algorithm).evaluate(element => { window.testOriginalCard = element; });
    const restingCard = await card(fixture.algorithm).boundingBox();
    await card(fixture.algorithm).dblclick();
    assert.equal(await page.locator('#detail-card').isVisible(), true, 'double-click opens the card editor');
    assert.equal(await card(fixture.algorithm).evaluate(element => element.classList.contains('is-lifted') && element.inert && getComputedStyle(element).visibility === 'hidden'), true, 'the original graph card is lifted out while it is in front of the camera');
    assert.equal(await page.locator('#manager').evaluate(element => element.inert), true);
    assert.equal(await page.locator('#card-grip > span').count(), 0, 'existing-card details omit the six-dot hint');
    await page.evaluate(id => {
      const original = document.querySelector(`.dg-task-card[data-task-id="${id}"]`), editor = document.getElementById('card-perspective');
      window.testReturnFrames = [];
      let frame = 0;
      const sample = () => {
        const composer = document.getElementById('composer'), graphRect = original.getBoundingClientRect(), editorRect = editor.getBoundingClientRect();
        const material = (surface, width) => {
          const factor = width / surface.offsetWidth;
          const face = getComputedStyle(surface.querySelector('.dg-card-faceart')).translate.split(' ').map(Number.parseFloat);
          const shadow = getComputedStyle(surface.querySelector('.dg-card-shadow')).translate.split(' ').map(Number.parseFloat);
          return [face[1] * factor, shadow[0] * factor, shadow[1] * factor];
        };
        if (window.testReturnFrames.length < 100) window.testReturnFrames.push({
          returning: composer.classList.contains('is-returning'), hidden: composer.hidden,
          formInert: document.getElementById('task-form').inert, editorFocused: composer.contains(document.activeElement),
          selected: original.classList.contains('is-selected'), visible: getComputedStyle(original).visibility === 'visible',
          progress: editor.getAnimations()[0]?.effect.getComputedTiming().progress ?? null,
          distance: Math.hypot(editorRect.left - graphRect.left, editorRect.top - graphRect.top),
          editor: material(document.getElementById('detail-card'), editorRect.width), graph: material(original.querySelector('.dg-card-surface'), graphRect.width)
        });
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      window.stopReturnProbe = () => { cancelAnimationFrame(frame); return window.testReturnFrames; };
    }, fixture.algorithm);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('composer').hidden);
    await page.waitForTimeout(260);
    const returnFrames = await page.evaluate(() => { const frames = window.stopReturnProbe(); delete window.stopReturnProbe; delete window.testReturnFrames; return frames; });
    const travelling = returnFrames.filter(frame => frame.returning && !frame.hidden), landed = returnFrames.filter(frame => frame.hidden && frame.visible);
    assert.ok(travelling.length > 2 && landed.length > 2, 'the physical return and the frames after handover were observed');
    assert.ok(travelling.every(frame => frame.selected && !frame.visible), 'selection settles while the original card is still hidden behind its returning face');
    assert.ok(travelling.every(frame => frame.formInert && !frame.editorFocused), 'the confirmed card stops accepting text throughout its return animation');
    assert.ok(landed.every(frame => frame.selected && frame.graph.every((value, index) => Math.abs(value - [-7, 7, 9][index]) < .05)), 'the revealed graph card is already raised and never lifts a second time');
    const lastTravel = travelling.at(-1);
    assert.ok(lastTravel.progress > .94 && lastTravel.distance < 3 && lastTravel.editor.every((value, index) => Math.abs(value - lastTravel.graph[index]) < .35), 'the returning face and shadow meet the selected graph pose continuously');
    assert.equal(await card(fixture.algorithm).evaluate(element => element === window.testOriginalCard && !element.inert && getComputedStyle(element).visibility === 'visible'), true, 'Esc returns the original graph node instead of inserting a duplicate card');
    const returnedCard = await card(fixture.algorithm).boundingBox();
    assert.ok(Math.abs(returnedCard.x - restingCard.x) < 1 && Math.abs(returnedCard.y - restingCard.y) < 1 && returnedCard.width === restingCard.width, 'the returned card lands back in its original place at the original scale');
    await page.evaluate(() => { delete window.testOriginalCard; });
    await card(fixture.algorithm).dblclick();
    await flipCard('back');
    assert.equal(await page.locator('#task-form').evaluate(element => element.inert), false, 'reopening the card restores its editor controls');
    assert.equal((await page.locator('#detail-id').textContent()).trim(), fixture.algorithm);
    assert.equal(await page.locator('#detail-column').count(), 0);
    assert.equal(await page.locator('#detail-id').evaluate(element => getComputedStyle(element).textOverflow !== 'ellipsis' && element.scrollWidth <= element.clientWidth + 1), true, 'immutable ID remains complete instead of being replaced by an ellipsis');
    assert.equal(await page.locator('#detail-created').getAttribute('title'), originalCreatedAt, 'details show the actual saved creation time');
    const editedNotes = '收起前的独立备注\n备注与卡片描述分别保存。';
    await writeNote(editedNotes);
    await flipCard('front');
    await page.locator('#task-description').fill('立即收起时也要保存的编辑');
    await page.locator('#scene-ring').click();
    await page.waitForFunction(() => document.body.dataset.mode === 'idle');
    assert.equal((await workspace()).tasks.find(task => task.id === fixture.algorithm).description, '立即收起时也要保存的编辑', 'hiding drains pending edits');
    assert.equal((await workspace()).tasks.find(task => task.id === fixture.algorithm).notes, editedNotes, 'hiding drains pending notes too');
    assert.equal((await workspace()).tasks.find(task => task.id === fixture.algorithm).createdAt, originalCreatedAt, 'editing keeps the original creation time');
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'graph' }));
    await revealCards(fixture.algorithm);
    await card(fixture.algorithm).dblclick();
    await flipCard('back');
    assert.equal(await page.locator('#task-notes').inputValue(), editedNotes, 'reopening restores the separate notes field');
    await flipCard('front');
    await page.locator('#task-description').fill('删除前最后一次编辑');
    const editGrip = await center(page.locator('#card-grip'));
    assert.equal(await page.locator('#card-grip > span').count(), 0);
    await page.mouse.move(editGrip.x, editGrip.y); await page.mouse.down();
    await page.mouse.move(editGrip.x + 18, editGrip.y + 24, { steps: 4 });
    assert.equal(await page.locator('body').evaluate(body => body.classList.contains('is-carrying')), true, 'the invisible details grip still picks up the existing card');
    await dragToTrash();
    await page.waitForFunction(() => document.getElementById('composer').hidden);
    assert.ok((await workspace()).tasks.find(task => task.id === fixture.algorithm).deletedAt);
    await page.locator('#undo').click();
    assert.equal((await workspace()).tasks.find(task => task.id === fixture.algorithm).description, '删除前最后一次编辑', 'recycling an enlarged card commits its last edit before removal, and undo preserves it');
    const migration = await page.evaluate(async workspaceId => {
      const response = await window.deskghost.invoke('createWorkspace', { name: 'Transfer target' });
      const id = response.activeWorkspaceId;
      await window.deskghost.invoke('activateWorkspace', { workspaceId });
      return { id };
    }, fixture.workspaceId);
    await page.evaluate(async workspaceId => {
      await window.deskghost.invoke('activateWorkspace', { workspaceId });
      await window.deskghost.invoke('addCategory', { workspaceId, category: 'Other category' });
    }, migration.id);
    await page.locator('#new-task').click();
    assert.equal(await page.locator('#task-workspace').inputValue(), migration.id);
    assert.equal(await page.locator('#task-category').inputValue(), '', 'an empty workspace does not inherit another workspace category or select the first catalog entry');
    await page.locator('#task-title').fill('Uncategorized confirmation');
    await page.locator('#submit-task').click();
    await page.waitForFunction(() => document.getElementById('composer').hidden);
    await waitScene(true);
    const defaultsWorkspace = (await snapshot()).documents.find(doc => doc.id === migration.id).workspace;
    assert.equal(defaultsWorkspace.tasks.length, 1, 'one Done click creates and places the card without a separate confirmation');
    assert.equal(defaultsWorkspace.tasks[0].category, '');
    await page.locator('#new-task').click();
    assert.equal(await page.locator('#task-category').inputValue(), '', 'a deliberately uncategorized latest task remains the default');
    await flipCard('back');
    await page.locator('#back-tags .dg-paper-tag[data-tag="category"]').click();
    await page.locator('#tag-query').fill('Other category'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('tag-picker').hidden);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('composer').hidden);
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'create' }));
    assert.equal(await page.locator('#task-category').inputValue(), '', 'cancelled tag changes do not replace the last committed default');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'graph' }));
    await waitScene(true);
    await page.locator('#undo').click();
    assert.equal((await snapshot()).documents.find(doc => doc.id === migration.id).workspace.tasks.length, 0, 'the confirmation probe is removed through the normal undo history');
    await page.evaluate(workspaceId => window.deskghost.invoke('activateWorkspace', { workspaceId }), fixture.workspaceId);
    await page.locator('#fit-graph').click(); await page.waitForTimeout(350);
    const beforeTransfer = await snapshot();
    const originalWorkspace = beforeTransfer.documents.find(doc => doc.id === fixture.workspaceId).workspace;
    const targetWorkspace = beforeTransfer.documents.find(doc => doc.id === migration.id).workspace;
    const requestTransfer = async () => {
      if (await page.locator('#composer').evaluate(element => element.hidden)) { await revealCards(quickTask.id); await clickTagHead(card(quickTask.id).locator('.dg-paper-tag[data-tag="workspace"]')); }
      else await clickTagHead(page.locator('#front-tags .dg-paper-tag[data-tag="workspace"]'));
      await page.waitForFunction(() => !document.getElementById('tag-picker').hidden);
      await page.locator('#tag-query').fill('Transfer target');
      assert.equal(await page.locator('#tag-options .dg-paper-tag').count(), 1);
      await page.keyboard.press('Enter');
      await page.locator('#transfer-prompt').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#composer').evaluate(element => element.inert), true, 'confirmation isolates the pending card');
    };
    await requestTransfer();
    assert.equal(await page.locator('#cancel-transfer').evaluate(element => element === document.activeElement), true, 'migration defaults to the cancel key');
    assert.equal(await page.locator('#confirm-transfer .well .plunger .cap, #cancel-transfer .well .plunger .cap').count(), 2, 'confirmation uses the same physical keys');
    await page.locator('#cancel-transfer').click();
    await page.waitForFunction(() => document.getElementById('transfer-prompt').hidden);
    const cancelledTransfer = await snapshot();
    assert.deepEqual(cancelledTransfer.documents.find(doc => doc.id === fixture.workspaceId).workspace, originalWorkspace, 'cancel keeps the original card and links unchanged');
    assert.deepEqual(cancelledTransfer.documents.find(doc => doc.id === migration.id).workspace, targetWorkspace, 'cancel does not write into the destination');
    assert.equal(cancelledTransfer.activeWorkspaceId, fixture.workspaceId);
    await requestTransfer();
    await page.locator('#confirm-transfer').click();
    await page.waitForFunction(() => document.getElementById('transfer-prompt').hidden);
    const transferred = await snapshot();
    const sourceAfterTransfer = transferred.documents.find(doc => doc.id === fixture.workspaceId).workspace;
    const targetAfterTransfer = transferred.documents.find(doc => doc.id === migration.id).workspace;
    const moved = targetAfterTransfer.tasks.find(task => task.id === quickTask.id);
    assert.equal(transferred.activeWorkspaceId, migration.id);
    assert.ok(moved, 'the selected card appears in the destination workspace');
    const { column: oldColumn, row: oldRow, ...originalContents } = originalWorkspace.tasks.find(task => task.id === quickTask.id);
    const { column: newColumn, row: newRow, ...movedContents } = moved;
    assert.deepEqual(movedContents, originalContents, 'migration preserves ID, creation date, notes, state and archive history');
    assert.equal(newColumn, targetAfterTransfer.columns.length - 1);
    assert.deepEqual(sourceAfterTransfer.tasks, originalWorkspace.tasks.filter(task => task.id !== quickTask.id), 'migration moves only the selected card');
    assert.deepEqual(sourceAfterTransfer.links, originalWorkspace.links.filter(link => link.sourceId !== quickTask.id && link.targetId !== quickTask.id), 'migration removes only the selected card\'s incident links');
    assert.deepEqual(targetAfterTransfer.links, targetWorkspace.links, 'migration does not recreate source links in another workspace');
    assert.ok(targetAfterTransfer.categories.includes(quickTask.category));
    await finishEditor();
    await page.locator('#undo').click();
    assert.deepEqual((await workspace()).tasks, originalWorkspace.tasks);
    assert.deepEqual((await workspace()).links, originalWorkspace.links, 'one migration undo restores the original path');
    assert.deepEqual((await snapshot()).documents.find(doc => doc.id === migration.id).workspace.tasks, targetWorkspace.tasks);
    await page.locator('#redo').click();
    assert.ok(!(await workspace()).tasks.some(task => task.id === quickTask.id));
    assert.equal((await snapshot()).documents.find(doc => doc.id === migration.id).workspace.tasks.find(task => task.id === quickTask.id).notes, quickNotes);
    await page.evaluate(workspaceId => window.deskghost.invoke('activateWorkspace', { workspaceId }), fixture.workspaceId);
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
    assert.equal(await page.locator('#task-description').evaluate(input => input === document.activeElement), true, 'old focus notifications do not interrupt front-side description entry');
    assert.equal(await page.locator('#tag-picker').isVisible(), false);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.stopActivationProbe(); delete window.stopActivationProbe; delete window.testActivations; });
    await context.test('Windows input, focus switching and modal ownership with focus emulation disabled', async nativeTest => {
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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
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
  public static bool OwnsInput(IntPtr window,uint pid) {
    if (GetForegroundWindow()!=window) return false;
    uint actual; uint thread=GetWindowThreadProcessId(window,out actual);
    GUI info=new GUI { size=Marshal.SizeOf(typeof(GUI)) };
    return actual==pid && GetGUIThreadInfo(thread,ref info) && GetAncestor(info.focus,2)==window;
  }
  static INPUT Key(ushort code,uint flags) { return new INPUT { type=1, data=new DATA { key=new KEY { code=code,flags=flags } } }; }
  public static bool Shortcut(long handle,uint pid,ushort key) {
    if ((key!=0x86 && key!=0x87) || !OwnsInput(new IntPtr(handle),pid)) return false;
    INPUT[] chord={Key(0x11,0),Key(0x12,0),Key(0x10,0),Key(key,0),Key(key,2),Key(0x10,2),Key(0x12,2),Key(0x11,2)};
    if (SendInput((uint)chord.Length,chord,Marshal.SizeOf(typeof(INPUT)))!=chord.Length) throw new InvalidOperationException("Windows rejected the test shortcut.");
    return true;
  }
  public static bool Escape(long handle,uint pid) {
    if (!OwnsInput(new IntPtr(handle),pid)) return false;
    INPUT[] keys={Key(0x1b,0),Key(0x1b,2)};
    if (SendInput((uint)keys.Length,keys,Marshal.SizeOf(typeof(INPUT)))!=keys.Length) throw new InvalidOperationException("Windows rejected test Escape.");
    return true;
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
[pscustomobject]@{clicked=$clicked;typed=$typed;foreground=[DeskGhostKeyboardCheck]::GetForegroundWindow().ToInt64();ownsInput=[DeskGhostKeyboardCheck]::OwnsInput([IntPtr]::new(${target.handle}), ${target.pid})} | ConvertTo-Json -Compress`;
        const { promisify } = require('node:util');
        const { execFile } = require('node:child_process');
        const runNative = async commands => {
          const body = commands ? script.slice(0, script.indexOf('$clicked =')) + commands : script;
          const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { windowsHide: true, timeout: 12000 });
          return JSON.parse(result.stdout.trim());
        };
        const report = await runNative();
        if (!report.clicked) {
          nativeTest.skip('The preparation surface is not the native desktop hit recipient; no click or keystrokes were sent.');
          return;
        }
        assert.equal(report.typed, true, 'a native preparation click must activate keyboard input');
        await page.waitForFunction(() => document.getElementById('task-title').value === 'native first', null, { timeout: 1500 }).catch(async error => {
          console.log('Native input delivery:', report, await page.evaluate(() => ({ title: document.getElementById('task-title').value, focus: document.activeElement?.id, focused: document.hasFocus(), mode: document.body.dataset.mode, composing: document.getElementById('task-title').dataset, error: document.getElementById('composer-error').textContent })));
          await page.screenshot({ path: path.join(output, 'native-input-failure.png'), omitBackground: true });
          throw error;
        });
        await writeNote('keep note');
        await page.locator('#task-notes').evaluate(input => { input.focus(); input.setSelectionRange(3, 3); });
        // A second window owned by this test exercises real Windows activation
        // without ever directing Alt+Tab or text into the user's applications.
        const helperTarget = await app.evaluate(async ({ BrowserWindow }) => {
          globalThis.testFocusMain = BrowserWindow.getAllWindows()[0];
          const bounds = globalThis.testFocusMain.getBounds();
          const helper = globalThis.testFocusHelper = new BrowserWindow({ x: bounds.x + 48, y: bounds.y + 48, width: 420, height: 220, show: false, skipTaskbar: true, title: 'DeskGhost focus regression', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
          await helper.loadURL('data:text/html,<title>DeskGhost focus regression</title><body>Owned test window</body>');
          return { handle: helper.getNativeWindowHandle().readBigUInt64LE().toString(), pid: process.pid };
        });
        const focusHelper = async (idle = false) => {
          const focus = await app.evaluate(async (_electron, idle) => {
            const helper = globalThis.testFocusHelper;
            helper.show(); helper.focus(); helper.webContents.focus();
            const read = () => ({ helperFocused: helper.isFocused(), mainFocused: globalThis.testFocusMain.isFocused(), mainOnTop: globalThis.testFocusMain.isAlwaysOnTop() });
            for (let attempt = 0; attempt < 60; attempt++) {
              const current = read();
              if (current.helperFocused && !current.mainFocused && (idle || !current.mainOnTop)) return current;
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            return read();
          }, idle);
          assert.equal(focus.helperFocused && !focus.mainFocused && (idle || !focus.mainOnTop), true, 'native focus switches to the owned helper: ' + JSON.stringify(focus));
          // A non-focusable idle overlay may retain Chromium's last document
          // focus flag. Native window/keyboard ownership above is authoritative.
          if (!idle) await page.waitForFunction(() => !document.hasFocus(), null, { timeout: 2000 });
        };
        await focusHelper();
        const helperReport = await runNative(`[pscustomobject]@{clicked=[DeskGhostKeyboardCheck]::Click(${helperTarget.handle}, ${helperTarget.pid}, 0.5, 0.5);ownsInput=[DeskGhostKeyboardCheck]::OwnsInput([IntPtr]::new(${helperTarget.handle}), ${helperTarget.pid})} | ConvertTo-Json -Compress`);
        assert.equal(helperReport.clicked && helperReport.ownsInput, true, 'the foreground helper receives its own guarded click instead of being covered by the leather window');
        assert.equal(await page.locator('#card-rotor').getAttribute('data-face'), 'back');
        assert.equal(await page.locator('#task-notes').inputValue(), 'keep note');
        await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'create' }));
        await page.waitForFunction(() => document.hasFocus() && document.activeElement === document.getElementById('task-notes'));
        assert.equal(await app.evaluate(() => globalThis.testFocusMain.isAlwaysOnTop()), true, 'explicit recall restores the main window layer');
        assert.equal(await page.locator('#card-rotor').getAttribute('data-face'), 'back', 'recalling a draft preserves the side being edited');
        assert.deepEqual(await page.locator('#task-notes').evaluate(input => [input.selectionStart, input.selectionEnd]), [3, 3], 'native focus switching preserves the note caret');
        const resumedTyping = await runNative(`[pscustomobject]@{typed=[DeskGhostKeyboardCheck]::Type(${target.handle}, ${target.pid}, '!')} | ConvertTo-Json -Compress`);
        assert.equal(resumedTyping.typed, true, 'the recalled field accepts a native first character');
        await page.waitForFunction(() => document.getElementById('task-notes').value === 'kee!p note');
        assert.equal(await page.locator('#task-title').inputValue(), 'native first', 'resumed native input is routed to the note rather than the title');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.getElementById('composer').hidden);
        await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'graph' }));
        await waitScene(true);
        const panStart = await center(page.locator('#graph-board'));
        const beforePan = await workspace();
        await page.mouse.move(panStart.x, panStart.y); await page.mouse.down({ button: 'middle' });
        try {
          await page.mouse.move(panStart.x + 60, panStart.y + 15, { steps: 6 });
          assert.equal(await page.locator('#graph-board').evaluate(element => element.classList.contains('is-panning')), true);
          await focusHelper();
          await page.waitForFunction(() => !document.getElementById('graph-board').classList.contains('is-interacting') && !document.getElementById('graph-board').classList.contains('is-panning'));
          assert.deepEqual((await workspace()).tasks, beforePan.tasks, 'losing focus while panning never edits task positions');
        } finally { await page.mouse.up({ button: 'middle' }); }
        // Hold a native file picker open without external filesystem/UI input.
        // Its promise models the same lifetime as the real owned Windows dialog.
        await app.evaluate(({ dialog }) => {
          globalThis.testOriginalOpenDialog = dialog.showOpenDialog;
          globalThis.testDialogOpened = new Promise(resolve => { globalThis.testNotifyDialog = resolve; });
          dialog.showOpenDialog = () => new Promise(resolve => { globalThis.testCloseDialog = resolve; globalThis.testNotifyDialog(); });
        });
        await page.evaluate(() => { window.testDialogCall = window.deskghost.invoke('openWorkspace'); });
        await app.evaluate(() => globalThis.testDialogOpened);
        await page.evaluate(async () => { await window.deskghost.invoke('summon', { mode: 'create' }); await window.deskghost.invoke('hide'); });
        assert.equal(await page.locator('body').getAttribute('data-mode'), 'graph', 'a pending native picker prevents parent mode changes');
        assert.equal(await page.locator('#composer').isVisible(), false);
        assert.equal(await app.evaluate(() => globalThis.testFocusHelper.isFocused() && !globalThis.testFocusMain.isAlwaysOnTop()), true, 'summoning during a native picker does not steal foreground ownership');
        await app.evaluate(() => globalThis.testCloseDialog({ canceled: true, filePaths: [] }));
        await page.evaluate(async () => { await window.testDialogCall; delete window.testDialogCall; });
        assert.equal(await page.locator('body').getAttribute('data-mode'), 'graph', 'canceling a native picker preserves the scene');
        assert.equal(await app.evaluate(() => globalThis.testFocusHelper.isFocused() && !globalThis.testFocusMain.isAlwaysOnTop()), true, 'picker cancellation never activates an app left in the background');
        await page.evaluate(() => window.deskghost.invoke('summon', { mode: 'graph' }));
        await page.waitForFunction(() => document.hasFocus());
        for (const nextMode of ['create', 'graph']) {
          if (nextMode === 'graph') {
            await app.evaluate(async ({ BrowserWindow }) => {
              const bounds = globalThis.testFocusMain.getBounds();
              const other = globalThis.testFocusOther = new BrowserWindow({ x: bounds.x + 540, y: bounds.y + 110, width: 480, height: 260, show: false, skipTaskbar: true, title: 'DeskGhost second focus window', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
              await other.loadURL('data:text/html,<title>DeskGhost second focus window</title><body>Owned background test window</body>');
              other.showInactive();
            });
          }
          await focusHelper(nextMode === 'graph');
          await page.evaluate(() => window.deskghost.invoke('hide'));
          await page.waitForFunction(() => document.body.dataset.mode === 'idle');
          assert.equal(await app.evaluate(() => globalThis.testFocusMain.isFocusable()), false, 'the first shortcut starts from the non-focusable desktop overlay');
          const foreground = await runNative(`[pscustomobject]@{clicked=[DeskGhostKeyboardCheck]::Click(${helperTarget.handle}, ${helperTarget.pid}, 0.5, 0.5);ownsInput=[DeskGhostKeyboardCheck]::OwnsInput([IntPtr]::new(${helperTarget.handle}), ${helperTarget.pid})} | ConvertTo-Json -Compress`);
          assert.equal(foreground.clicked && foreground.ownsInput, true, 'the owned helper has actual Windows keyboard focus before testing the first shortcut');
          const shortcut = await runNative(`[pscustomobject]@{sent=[DeskGhostKeyboardCheck]::Shortcut(${helperTarget.handle}, ${helperTarget.pid}, ${nextMode === 'create' ? 0x86 : 0x87})} | ConvertTo-Json -Compress`);
          assert.equal(shortcut.sent, true, 'one real registered shortcut is sent only while the owned helper has keyboard focus');
          await page.waitForFunction(nextMode => document.body.dataset.mode === nextMode && document.hasFocus(), nextMode, { timeout: 2000 });
          assert.equal(await app.evaluate(() => globalThis.testFocusMain.isFocused() && globalThis.testFocusMain.isAlwaysOnTop()), true, 'the first shortcut raises and focuses ' + nextMode + ' over the other windows');
          if (nextMode === 'create') {
            const firstKey = await runNative(`[pscustomobject]@{typed=[DeskGhostKeyboardCheck]::Type(${target.handle}, ${target.pid}, 'shortcut first')} | ConvertTo-Json -Compress`);
            assert.equal(firstKey.typed, true);
            await page.waitForFunction(() => document.getElementById('task-title').value === 'shortcut first', null, { timeout: 1500 });
          } else assert.equal(await page.locator('#composer').evaluate(element => element.hidden), true, 'the graph shortcut opens management directly');
          const escaped = await runNative(`[pscustomobject]@{sent=[DeskGhostKeyboardCheck]::Escape(${target.handle}, ${target.pid})} | ConvertTo-Json -Compress`);
          assert.equal(escaped.sent, true, 'Escape reaches the freshly summoned window without first clicking it');
          await page.waitForFunction(() => document.body.dataset.mode === 'idle', null, { timeout: 2000 });
        }
      } finally {
        await page.mouse.up({ button: 'middle' }).catch(() => {});
        await app.evaluate(({ dialog }) => {
          globalThis.testCloseDialog?.({ canceled: true, filePaths: [] });
          if (globalThis.testOriginalOpenDialog) dialog.showOpenDialog = globalThis.testOriginalOpenDialog;
          if (globalThis.testFocusHelper && !globalThis.testFocusHelper.isDestroyed()) globalThis.testFocusHelper.destroy();
          if (globalThis.testFocusOther && !globalThis.testFocusOther.isDestroyed()) globalThis.testFocusOther.destroy();
          for (const key of ['testOriginalOpenDialog', 'testDialogOpened', 'testNotifyDialog', 'testCloseDialog', 'testFocusHelper', 'testFocusOther', 'testFocusMain']) delete globalThis[key];
        });
        await page.evaluate(async () => { if (window.testDialogCall) await window.testDialogCall; delete window.testDialogCall; });
        await app.evaluate(({ screen }) => { if (globalThis.testNativeCursor) { screen.getCursorScreenPoint = globalThis.testNativeCursor; delete globalThis.testNativeCursor; } });
        await page.evaluate(() => { if (!document.getElementById('composer').hidden) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        await page.evaluate(() => window.deskghost.invoke('hide'));
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await cdp.detach();
      }
    });
    assert.deepEqual(errors, []);
    const sceneFrames = await page.evaluate(() => { window.stopSceneProbe(); const frames = window.testSceneFrames; delete window.stopSceneProbe; delete window.testSceneFrames; return frames; });
    assert.ok(sceneFrames.length > 10, 'the board motion was sampled during real opening and closing');
    assert.ok(sceneFrames.every(frame => Math.abs(frame.scaleX - 1) < .001 && Math.abs(frame.scaleY - 1) < .001 && frame.opacity === 1 && Math.abs(frame.x) < .1), 'the rigid leather board only translates, without scaling or fading');
    assert.ok(sceneFrames.some(frame => frame.y < -5), 'the ring lifts above the hook before settling or unhooking');
    assert.ok(sceneFrames.every(frame => Math.abs(frame.hookY - frame.frontY) < .02), 'front and back artwork remain aligned throughout hook motion');
    assert.ok(sceneFrames.some(frame => frame.opening && frame.hookY < -2 && frame.hookBottom > 0), 'the hook enters progressively through the top screen edge');
    assert.ok(sceneFrames.some(frame => !frame.opening && frame.hookY < -2 && frame.hookBottom > 0), 'the hook progressively retracts after unhooking');
    assert.ok(sceneFrames.filter(frame => !frame.opening && frame.hookY < -2).every(frame => frame.ringTop > frame.hookBottom), 'the ring has cleared before the hook withdraws');
    const final = await snapshot();
    const file = final.documents.find(doc => doc.id === fixture.workspaceId).path;
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    const migratedFile = final.documents.find(doc => doc.id === migration.id).path;
    const migratedStored = JSON.parse(await fs.readFile(migratedFile, 'utf8'));
    assert.equal(stored.tasks.length, 4);
    assert.equal(migratedStored.tasks.length, 1);
    assert.equal(migratedStored.tasks.find(task => task.id === quickTask.id).notes, quickNotes);
    assert.equal(migratedStored.tasks.find(task => task.id === quickTask.id).createdAt, quickTask.createdAt);
    assert.equal(stored.tasks.find(task => task.id === fixture.algorithm).notes, editedNotes);
    assert.equal(stored.tasks.find(task => task.id === fixture.algorithm).createdAt, originalCreatedAt);
    console.log('Desktop screenshots and workspace:', output);
    await page.evaluate(() => window.deskghost.invoke('quit')).catch(() => {});
  } catch (error) {
    console.log('Desktop failure artifacts:', output, 'Renderer errors:', errors, 'Failure:', error.message);
    const page = await app.firstWindow().catch(() => null);
    if (page) {
      await page.screenshot({ path: path.join(output, 'failure.png'), omitBackground: true }).catch(() => {});
      console.log('Desktop failure state:', await page.evaluate(() => ({ mode: document.body.dataset.mode, focus: document.activeElement?.id, composerHidden: document.getElementById('composer').hidden, scene: document.getElementById('desk-scene').dataset, error: document.getElementById('composer-error').textContent, toast: document.getElementById('toast').textContent })).catch(() => null));
    }
    // An unfinished test draft intentionally vetoes an ordinary app quit. This
    // process owns only the fresh output directory, so finish its failed run
    // directly instead of leaving a test window waiting for user interaction.
    await app.evaluate(({ app }) => app.exit()).catch(() => {});
    throw error;
  } finally {
    await app.evaluate(({ powerMonitor }) => { if (globalThis.testActualIdleTime) powerMonitor.getSystemIdleTime = globalThis.testActualIdleTime; }).catch(() => {});
    await app.close().catch(() => {});
  }
});
