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

test('sticker swipes respect task stages and keep the peel surface continuous', async () => {
  const { nextStickerState, stickerGestureDirection, peelSurface } = await import('../desktop/web/sticker.js');
  const { graphGeometry } = await import('../desktop/web/graph.js');
  assert.equal(graphGeometry.cardWidth / graphGeometry.cardHeight, 621.3463 / 457.9779);
  assert.ok(graphGeometry.columnStep > graphGeometry.cardWidth && graphGeometry.rowStep > graphGeometry.cardHeight);
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
  const app = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [root]), '--data-dir', output], cwd: root, timeout: 30000, env: electronEnv });
  try {
    const page = await app.firstWindow();
    const waitScene = async open => page.waitForFunction(open => {
      const scene = document.getElementById('desk-scene');
      return scene.dataset.open === String(open) && scene.dataset.moving !== 'true';
    }, open);
    // CDP typing does not reset Windows idle time. Keep the unrelated checks
    // active, then explicitly advance idle time only in the roaming scenario.
    await app.evaluate(({ powerMonitor }) => {
      globalThis.testActualIdleTime = powerMonitor.getSystemIdleTime;
      powerMonitor.getSystemIdleTime = () => 0;
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.getElementById('boot-screen')?.hidden, null, { timeout: 25000 });
    await waitScene(true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)');
    const native = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { background: window.getBackgroundColor(), resizable: window.isResizable(), sandbox: window.webContents.getLastWebPreferences().sandbox, node: window.webContents.getLastWebPreferences().nodeIntegration, isolated: window.webContents.getLastWebPreferences().contextIsolation };
    });
    assert.ok(['#000000', '#00000000'].includes(native.background)); assert.equal(native.resizable, false);
    assert.equal(native.sandbox, true); assert.equal(native.node, false); assert.equal(native.isolated, true);
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
    assert.equal(await page.locator('#composer').evaluate(element => element.parentElement === document.body), true, 'the physical card can be carried independently of the board');
    assert.notEqual(scene.leather, 'rgba(0, 0, 0, 0)');
    await page.evaluate(() => {
      const scene = document.getElementById('desk-scene');
      window.testSceneFrames = [];
      let frame = 0;
      const capture = () => {
        frame = 0;
        if (scene.dataset.moving !== 'true') return;
        const style = getComputedStyle(scene), matrix = new DOMMatrixReadOnly(style.transform);
        if (window.testSceneFrames.length < 400) window.testSceneFrames.push({ x: matrix.m41, y: matrix.m42, scaleX: matrix.m11, scaleY: matrix.m22, opacity: Number(style.opacity) });
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
    await page.screenshot({ path: path.join(output, 'dismiss-settings.png'), omitBackground: true });
    await page.locator('#apply-settings').click();
    await page.waitForFunction(() => document.getElementById('settings-panel').hidden);
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'web-settings.json'), 'utf8')).dismissSpeed, 2.4, 'the configured threshold is durably saved');
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
      // Pan the physical board through its public wheel interaction; tests must
      // not shrink cards to fit the old all-columns camera.
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
    const drag = async (from, to, during) => {
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      // Inspect the lifted material away from the board edge, where a held
      // pointer intentionally auto-pans the graph and changes the drop row.
      if (during) { await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 11 }); await during(); }
      await page.mouse.move(to.x, to.y, { steps: during ? 11 : 22 }); await page.mouse.up(); await page.waitForTimeout(420);
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
    await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: -200, ctrlKey: true });
    assert.deepEqual(await camera(), beforeWheel, 'Ctrl+wheel cannot zoom or pan physical cards');
    await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: 100, shiftKey: true });
    assert.equal((await camera()).scale, 1);
    if (horizontalOverflow) assert.ok((await camera()).x < beforeWheel.x, 'Shift+wheel scrolls overflowing time slices');
    else assert.equal((await camera()).x, beforeWheel.x, 'a board that already fits does not expose empty off-board space');
    assert.equal((await camera()).y, beforeWheel.y, 'Shift+wheel never moves task rows');
    await page.locator('#fit-graph').click();
    await revealCards(fixture.pcb);
    const beforeRows = await camera();
    const allRowsFit = await page.locator('#graph-board').evaluate(board => Math.max(...[...board.querySelectorAll('.dg-task-card')].map(card => card.getBoundingClientRect().bottom)) <= board.getBoundingClientRect().bottom);
    await page.locator('#graph-board').dispatchEvent('wheel', { deltaY: 120 });
    if (allRowsFit) assert.equal((await camera()).y, beforeRows.y, 'ordinary wheel leaves a board with no overflowing rows still');
    await page.evaluate(({ workspaceId, taskId }) => window.deskghost.invoke('moveTask', { workspaceId, taskId, column: 1, row: 40 }), { workspaceId: fixture.workspaceId, taskId: fixture.algorithm });
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
      const start = direction === 'advance' ? .78 : .22;
      if (direction === 'stop') await drag({ x: box.x + box.width * .55, y: box.y + box.height * .72 }, { x: box.x + box.width * .28, y: box.y + box.height * .1 });
      else await drag({ x: box.x + box.width * start, y: box.y + box.height / 2 }, { x: box.x + box.width * (1 - start), y: box.y + box.height / 2 });
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
    await page.evaluate(({ workspaceId, taskId }) => window.deskghost.invoke('archiveTask', { workspaceId, taskId }), { workspaceId: fixture.workspaceId, taskId: fixture.origin });
    await page.locator('#archive-mode').click();
    assert.equal(await page.locator('#archive-mode').getAttribute('aria-selected'), 'true');
    assert.deepEqual(await page.locator('.dg-task-card').evaluateAll(cards => cards.map(card => card.dataset.taskId)), [fixture.origin]);
    await page.locator('#graph-mode').click();
    await page.evaluate(({ workspaceId, taskId }) => window.deskghost.invoke('unarchiveTask', { workspaceId, taskId }), { workspaceId: fixture.workspaceId, taskId: fixture.origin });
    await page.locator('#fit-graph').click(); await page.waitForTimeout(300);
    await connect(fixture.origin, fixture.pcb);
    assert.ok((await workspace()).links.some(link => link.sourceId === fixture.origin && link.targetId === fixture.pcb), 'drag connects cards');
    await revealCards(fixture.pcb, fixture.algorithm);
    const start = await card(fixture.pcb).boundingBox();
    const next = await card(fixture.algorithm).boundingBox();
    await drag({ x: start.x + start.width / 2, y: start.y + start.height * .4 }, { x: start.x + start.width / 2 + 7, y: start.y + start.height * .4 + (next.y - start.y) * 2 }, async () => {
      await page.waitForTimeout(250);
      const lifted = await cardLift(fixture.pcb);
      assert.ok(lifted.shadow[0] > selectedLift.shadow[0] && lifted.shadow[1] > selectedLift.shadow[1] && lifted.face[1] < selectedLift.face[1], 'dragging increases physical separation between card and shadow');
    });
    assert.equal((await workspace()).tasks.find(task => task.id === fixture.pcb).row, 2, 'card snaps to a free row');
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
    assert.equal(await page.locator('#card-grip > span').count(), 6, 'the six-dot grip marks the card as a physical object');
    const frontHeads = await page.locator('#front-tags .dg-paper-tag').evaluateAll(tags => tags.map(tag => {
      const surface = tag.closest('.dg-card-surface').getBoundingClientRect(), box = tag.getBoundingClientRect();
      return { protrusion: (surface.left - box.left) / surface.width, labelHidden: getComputedStyle(tag.querySelector('.dg-paper-tag-label')).visibility === 'hidden' };
    }));
    assert.ok(frontHeads.every(tag => tag.labelHidden && Math.abs(tag.protrusion - .075) < .002), 'both front tags expose only the same fixed colour head on the left');
    await flipCard('front');
    assert.equal(await page.locator('#task-title').evaluate(element => element.tagName), 'INPUT');
    await page.locator('#task-title').fill('First line\nsecond line');
    const pastedTitle = await page.locator('#task-title').inputValue();
    assert.doesNotMatch(pastedTitle, /[\r\n]/, 'pasted title lines stay saveable');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#task-title').inputValue(), pastedTitle, 'Enter does not insert unsupported title controls');
    assert.equal(await page.locator('#submit-task').isVisible(), true, 'ordinary Enter does not finish the card before Ctrl+Enter field navigation');
    await page.locator('#task-title').fill('A longer title that must remain entirely readable within the brown ribbon without scrolling');
    const longTitle = await page.locator('#task-title').evaluate(input => ({ size: parseFloat(getComputedStyle(input).fontSize), width: input.clientWidth, scrollWidth: input.scrollWidth, height: input.clientHeight, scrollHeight: input.scrollHeight, overflowY: getComputedStyle(input).overflowY }));
    assert.ok(longTitle.scrollWidth <= longTitle.width + 1 && longTitle.scrollHeight <= longTitle.height + 1, 'the complete title fits without either scrollbar');
    assert.ok(['hidden', 'clip'].includes(longTitle.overflowY), 'title overflow never exposes a vertical scrollbar');
    await page.locator('#task-title').fill('Idea');
    assert.ok(await page.locator('#task-title').evaluate(input => parseFloat(getComputedStyle(input).fontSize)) > longTitle.size, 'shortening the title restores the larger lettering');
    await page.locator('#task-title').fill('键盘捕捉灵感'); await page.keyboard.press('Control+Enter');
    assert.equal(await page.locator('#tag-query').evaluate(el => el === document.activeElement), true);
    const choices = await page.locator('#tag-picker').evaluate(element => {
      const style = getComputedStyle(element), tags = [...element.querySelectorAll('#tag-options .dg-paper-tag')].map(tag => tag.getBoundingClientRect());
      return { background: style.backgroundColor, shadow: style.boxShadow, stacked: tags.every((box, index) => index === 0 || box.top >= tags[index - 1].bottom - 1), aligned: tags.every(box => Math.abs(box.left - tags[0].left) < 2) };
    });
    assert.equal(choices.background, 'rgba(0, 0, 0, 0)'); assert.equal(choices.shadow, 'none', 'tag choices have no separate backing board');
    assert.equal(choices.stacked && choices.aligned, true, 'loose tag choices form a vertical stack');
    await page.keyboard.type('交互设计'); await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.getElementById('tag-picker').hidden);
    assert.equal(await page.locator('#task-category').inputValue(), '交互设计', 'a keyboard tag query creates the category');
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
    assert.equal(await page.locator('#card-grip').evaluate(element => element === document.activeElement), true, 'Done hands the finished card to its grip');
    assert.equal(await page.locator('#composer').isVisible(), true);
    assert.equal((await workspace()).tasks.length, tasksBeforePlacement, 'Done leaves the physical card unplaced and does not create a task yet');
    assert.equal(await page.locator('#desk-scene').getAttribute('data-open'), 'false');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('composer').hidden);
    await waitScene(true);
    assert.ok((await workspace()).tasks.some(task => task.title === '键盘捕捉灵感' && task.category === '交互设计'));
    const quickTask = (await workspace()).tasks.find(task => task.title === '键盘捕捉灵感');
    assert.equal(quickTask.notes, quickNotes, 'creation saves the separate notes field');
    assert.equal(quickTask.state, 'Stopped', 'the initial sticker state is saved with the placed card');
    assert.ok(Date.parse(quickTask.createdAt) >= captureStarted - 1000 && Date.parse(quickTask.createdAt) <= Date.now() + 1000, 'new cards receive an actual creation timestamp');
    assert.equal(quickTask.column, (await workspace()).columns.length - 1, 'independent quick capture goes into the latest logical column');
    // A second card follows the pointer path, then is recycled and undone so
    // this interaction does not add fixture data to the later history checks.
    await page.locator('#new-task').click();
    await page.locator('#task-title').fill('Place by hand');
    await page.locator('#submit-task').click();
    const grip = await center(page.locator('#card-grip'));
    await page.mouse.move(grip.x, grip.y); await page.mouse.down();
    await page.mouse.move(grip.x + 18, grip.y + 24, { steps: 4 });
    await waitScene(true);
    const placementBoard = await page.locator('#graph-board').boundingBox();
    await page.mouse.move(placementBoard.x + placementBoard.width / 2, placementBoard.y + placementBoard.height * .48, { steps: 22 });
    const placementPreview = await page.locator('.dg-snap-ghost').evaluate((element, geometry) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { valid: !element.hidden && !element.classList.contains('is-invalid'), column: Math.round(matrix.m41 / geometry.columnStep), row: Math.round((matrix.m42 - geometry.top) / geometry.rowStep) };
    }, graphGeometry);
    assert.equal(placementPreview.valid, true, 'carrying a card opens a valid snap preview on the board');
    assert.equal((await workspace()).tasks.length, tasksBeforePlacement + 1, 'drag preview does not persist before release');
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById('composer').hidden);
    const placedByHand = (await workspace()).tasks.find(task => task.title === 'Place by hand');
    assert.ok(placedByHand);
    assert.deepEqual([placedByHand.column, placedByHand.row], [placementPreview.column, placementPreview.row], 'release commits exactly the previewed slice and row');
    await revealCards(placedByHand.id);
    await drag(await center(card(placedByHand.id).locator('.dg-card-description')), await center(page.locator('#task-trash')));
    assert.ok((await workspace()).tasks.find(task => task.id === placedByHand.id).deletedAt, 'graph cards can be dragged directly to the recycling bin');
    await page.locator('#undo').click();
    assert.ok(!(await workspace()).tasks.find(task => task.id === placedByHand.id).deletedAt, 'recycling remains recoverable');
    await page.locator('#undo').click();
    assert.equal((await workspace()).tasks.length, tasksBeforePlacement + 1, 'undo placement removes only the temporary card');
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
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('tag-picker').hidden);
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
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('composer').hidden);
    assert.equal(await card(fixture.algorithm).evaluate(element => element === window.testOriginalCard && !element.inert && getComputedStyle(element).visibility === 'visible'), true, 'Esc returns the original graph node instead of inserting a duplicate card');
    const returnedCard = await card(fixture.algorithm).boundingBox();
    assert.ok(Math.abs(returnedCard.x - restingCard.x) < 1 && Math.abs(returnedCard.y - restingCard.y) < 1 && returnedCard.width === restingCard.width, 'the returned card lands back in its original place at the original scale');
    await page.evaluate(() => { delete window.testOriginalCard; });
    await card(fixture.algorithm).dblclick();
    await flipCard('back');
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
    await page.mouse.move(editGrip.x, editGrip.y); await page.mouse.down();
    await page.mouse.move(editGrip.x + 18, editGrip.y + 24, { steps: 4 });
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
    assert.equal(await page.locator('#tag-query').evaluate(input => input === document.activeElement), true, 'old focus notifications do not interrupt the category picker');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('tag-picker').hidden);
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
