// Live View renderer: a small local server that turns whatever an agent is
// building (a web page, an image, a 3D model, a video, a Blender file) into
// a compact JPEG frame, and reports where it changed since the last frame so
// the pane can point the agent's cursor there.
//
// It listens on a Unix socket (argv[2]) and speaks JSON:
//   GET  /health
//   POST /render  { target: { type: 'file' | 'url', value }, saveAs? }
//   POST /recent  { cwd, sinceMs }   files changed since then, newest first

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SOCK = process.argv[2] || path.join(os.tmpdir(), 'live-view.sock');
const ORIGIN = 'http://live-view.local';
const VIEWPORT = { width: 1120, height: 700 };
const FRAME = { width: 720, height: 450 };
const MAX_B64 = 100_000; // the pane's SVG holds at most 131,072 characters

const KINDS = {
  page: ['html', 'htm'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'],
  video: ['mp4', 'webm', 'mov', 'm4v'],
  model: ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'],
  blend: ['blend'],
  markdown: ['md', 'markdown', 'mdx'],
};

export function kindOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  for (const [kind, exts] of Object.entries(KINDS)) if (exts.includes(ext)) return kind;
  return 'code';
}

// ---------- browser ----------

let browserPromise = null;
const lastFrame = new Map(); // target key -> previous frame (base64 jpeg)

function loadPlaywright() {
  // Prefer a full Playwright install (it knows where its browser is), then
  // the bundled playwright-core driving a Chrome-family browser on the machine.
  for (const name of ['playwright', path.join(here, 'node_modules/playwright-core')]) {
    try { return { pw: require(name), full: name === 'playwright' }; } catch {}
  }
  throw new Error('Playwright is not installed: run npm install in ' + here);
}

const BROWSER_PATHS = [
  process.env.LIVE_VIEW_CHROME,
  '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

async function launch() {
  const { pw, full } = loadPlaywright();
  const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'];
  if (full) {
    try { return await pw.chromium.launch({ args }); } catch {}
  }
  for (const p of BROWSER_PATHS) {
    if (!fs.existsSync(p)) continue;
    try { return await pw.chromium.launch({ executablePath: p, args }); } catch {}
  }
  return pw.chromium.launch({ channel: 'chrome', args });
}

function browser() {
  if (!browserPromise) {
    browserPromise = launch().then((b) => {
      b.on('disconnected', () => { browserPromise = null; });
      return b;
    }, (err) => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

// Every page the renderer opens lives under one made-up origin, so a page's
// relative imports (ES modules, textures, models) resolve against the disk.
async function newPage() {
  const b = await browser();
  const ctx = await b.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    let file;
    if (url.pathname.startsWith('/fs/')) file = decodeURIComponent(url.pathname.slice(3));
    else if (url.pathname.startsWith('/three/')) file = path.join(here, 'node_modules/three', url.pathname.slice(7));
    else if (url.pathname.startsWith('/pages/')) file = path.join(here, 'pages', url.pathname.slice(7));
    if (!file) return route.fulfill({ status: 404, body: 'not found' });
    try {
      const st = await fsp.stat(file);
      if (st.isDirectory()) file = path.join(file, 'index.html');
      return route.fulfill({ path: file, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
    } catch {
      return route.fulfill({ status: 404, body: 'not found' });
    }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return { page, ctx, errors };
}

const fsUrl = (file) => `${ORIGIN}/fs${file.split(path.sep).map(encodeURIComponent).join('/')}`;

async function settle(page, readyFlag) {
  if (readyFlag) {
    await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 15000 }).catch(() => {});
    const err = await page.evaluate(() => window.__error || null);
    if (err) throw new Error(err);
  } else {
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  }
  // Give canvases and animations a few frames to draw.
  await page.waitForTimeout(500);
}

// ---------- frame post-processing (in the browser) ----------

// Scales a screenshot down to the frame size, encodes it as a JPEG small
// enough for the pane, and finds the box that changed since `prev`.
async function finish(page, pngBase64, prev) {
  return page.evaluate(async ({ png, prev, frame, maxB64 }) => {
    const load = (src) => new Promise((ok, fail) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => fail(new Error('could not decode frame'));
      im.src = src;
    });
    const img = await load('data:image/png;base64,' + png);
    const scale = Math.min(frame.width / img.width, frame.height / img.height, 1);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    let q = 0.72;
    let url = c.toDataURL('image/jpeg', q);
    while (url.length - 23 > maxB64 && q > 0.2) { q -= 0.1; url = c.toDataURL('image/jpeg', q); }
    const jpeg = url.slice('data:image/jpeg;base64,'.length);

    // Change detection on a coarse grid, JPEG against JPEG so compression
    // noise cancels out, keeping the largest connected patch of change.
    let bbox = null;
    if (prev) {
      try {
        const [now, old] = await Promise.all([load(url), load('data:image/jpeg;base64,' + prev)]);
        const GW = 72, GH = 45;
        const sample = (im) => {
          const s = document.createElement('canvas');
          s.width = GW; s.height = GH;
          const sg = s.getContext('2d');
          sg.drawImage(im, 0, 0, GW, GH);
          return sg.getImageData(0, 0, GW, GH).data;
        };
        const a = sample(now), b = sample(old);
        const hit = new Uint8Array(GW * GH);
        for (let i = 0; i < GW * GH; i++) {
          const d = Math.abs(a[i * 4] - b[i * 4]) + Math.abs(a[i * 4 + 1] - b[i * 4 + 1]) + Math.abs(a[i * 4 + 2] - b[i * 4 + 2]);
          if (d > 60) hit[i] = 1;
        }
        // Connected patches (8-neighbour, bridging one-cell gaps).
        const seen = new Uint8Array(GW * GH);
        let best = null, total = 0;
        for (let start = 0; start < GW * GH; start++) {
          if (!hit[start] || seen[start]) continue;
          const stack = [start];
          seen[start] = 1;
          let n = 0, x0 = GW, y0 = GH, x1 = -1, y1 = -1;
          while (stack.length) {
            const i = stack.pop();
            const x = i % GW, y = (i / GW) | 0;
            n++;
            if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
              const j = ny * GW + nx;
              if (hit[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
            }
          }
          total += n;
          if (n >= 3 && (!best || n > best.n)) best = { n, x0, y0, x1, y1 };
        }
        if (best) bbox = [best.x0 / GW, best.y0 / GH, (best.x1 + 1 - best.x0) / GW, (best.y1 + 1 - best.y0) / GH, total / (GW * GH)];
      } catch {}
    }
    return { jpeg, width: w, height: h, bbox };
  }, { png: pngBase64, prev, frame: FRAME, maxB64: MAX_B64 });
}

// ---------- rendering by kind ----------

async function capture(url, { readyFlag = false, fullPage = false } = {}) {
  const { page, ctx, errors } = await newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    await settle(page, readyFlag);
    const png = (await page.screenshot({ type: 'png', fullPage })).toString('base64');
    return { png, errors, page, ctx };
  } catch (err) {
    await ctx.close().catch(() => {});
    throw err;
  }
}

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr })); else resolve(stdout);
    });
  });
}

async function blendToGlb(file) {
  const out = path.join(os.tmpdir(), `live-view-${process.pid}-${Date.now()}.glb`);
  const blender = process.env.LIVE_VIEW_BLENDER
    || ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender']
      .find((p) => fs.existsSync(p))
    || 'blender';
  const py = `import bpy; bpy.ops.export_scene.gltf(filepath=${JSON.stringify(out)}, export_format='GLB', export_apply=True)`;
  try {
    await run(blender, ['-b', file, '--python-expr', py]);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('Blender is not installed, so .blend files cannot be previewed (set LIVE_VIEW_BLENDER to its path)');
    throw new Error('Blender could not export the scene: ' + String(err.stderr || err.message).slice(-300));
  }
  return out;
}

async function render(target) {
  const key = `${target.type}:${target.value}`;
  if (target.type === 'url') return frameFrom(key, 'page', await capture(target.value));

  const file = path.resolve(target.value);
  const st = await fsp.stat(file).catch(() => null);
  if (!st) return { ok: false, kind: kindOf(file), error: `${path.basename(file)} does not exist yet` };

  const kind = kindOf(file);
  switch (kind) {
    case 'page':
      return frameFrom(key, kind, await capture(fsUrl(file)));
    case 'image':
    case 'video':
      return frameFrom(key, kind, await capture(`${ORIGIN}/pages/media.html?type=${kind}&src=${encodeURIComponent(fsUrl(file))}`, { readyFlag: true }));
    case 'model':
      return frameFrom(key, kind, await capture(`${ORIGIN}/pages/model.html?src=${encodeURIComponent(fsUrl(file))}`, { readyFlag: true }));
    case 'blend': {
      const glb = await blendToGlb(file);
      try {
        return frameFrom(key, kind, await capture(`${ORIGIN}/pages/model.html?src=${encodeURIComponent(fsUrl(glb))}`, { readyFlag: true }));
      } finally { fsp.rm(glb, { force: true }); }
    }
    default: {
      // Text the pane draws itself: Markdown, or code.
      const text = st.size > 200_000 ? (await fsp.readFile(file, 'utf8')).slice(0, 200_000) : await fsp.readFile(file, 'utf8');
      return { ok: true, kind, text };
    }
  }
}

async function frameFrom(key, kind, shot) {
  try {
    const prev = lastFrame.get(key) ?? null;
    const f = await finish(shot.page, shot.png, prev);
    lastFrame.set(key, f.jpeg);
    return { ok: true, kind, ...f, isFirst: !prev, errors: shot.errors.slice(0, 5) };
  } finally {
    await shot.ctx.close().catch(() => {});
  }
}

// ---------- recent files ----------

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '.venv', '__pycache__', '.turbo', '.claude']);

async function recent(cwd, sinceMs) {
  const out = [];
  let seen = 0;
  async function walk(dir, depth) {
    if (depth > 6 || seen > 5000) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.')) continue;
      const p = path.join(dir, e.name);
      seen++;
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) {
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.mtimeMs >= sinceMs) out.push({ path: p, mtimeMs: st.mtimeMs, kind: kindOf(p) });
      }
    }
  }
  await walk(cwd, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 50);
}

// ---------- server ----------

let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, pid: process.pid });
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === 'POST' && req.url === '/render') {
      const result = await serial(() => render(body.target).catch((err) => ({ ok: false, error: err.message })));
      if (result.ok && result.jpeg && body.saveAs) {
        await fsp.mkdir(path.dirname(body.saveAs), { recursive: true });
        await fsp.writeFile(body.saveAs, Buffer.from(result.jpeg, 'base64'));
        delete result.jpeg; // the caller reads it from disk
      }
      return send(200, result);
    }
    if (req.method === 'POST' && req.url === '/recent') return send(200, { files: await recent(body.cwd, body.sinceMs ?? 0) });
    return send(404, { error: 'no such route' });
  } catch (err) {
    return send(500, { ok: false, error: err.message });
  }
});

try { fs.unlinkSync(SOCK); } catch {}
server.listen(SOCK, () => console.log(`[live-view] renderer listening on ${SOCK} (pid ${process.pid})`));

// Exit when nobody has asked for anything in a long while.
let lastUse = Date.now();
server.on('request', () => { lastUse = Date.now(); });
setInterval(() => {
  if (Date.now() - lastUse > 6 * 60 * 60 * 1000) { server.close(); process.exit(0); }
}, 60_000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { fs.unlinkSync(SOCK); } catch {} process.exit(0); });
