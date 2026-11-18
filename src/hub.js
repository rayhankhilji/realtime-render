// The hub: one local HTTP + WebSocket server that holds the scene and fans
// every change out to open viewers. Many agents (MCP processes, scripts, any
// HTTP client) can write to the same hub at once.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { Scene } from './scene.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '../public');
const THREE_DIR = path.dirname(createRequire(import.meta.url).resolve('three/package.json'));

const AGENT_COLORS = ['#ff6b4a', '#3fb6ff', '#b07bff', '#2fd38a', '#ffc53d', '#ff5fa8', '#5ee0e0'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export class Hub {
  constructor() {
    this.scene = new Scene();
    this.agents = new Map(); // id -> { id, name, color, status, lastSeen }
    this.viewers = new Set();
    this.pendingSnapshots = new Map(); // reqId -> { resolve, timer }
    this.reqSeq = 0;
    this.colorSeq = 0;
  }

  // ---- core API (used in-process and over HTTP) ----

  touchAgent({ id, name }) {
    if (!id) id = 'anonymous';
    let a = this.agents.get(id);
    if (!a) {
      a = { id, name: name || id, color: AGENT_COLORS[this.colorSeq++ % AGENT_COLORS.length], status: null, lastSeen: 0 };
      this.agents.set(id, a);
    }
    if (name) a.name = name;
    a.lastSeen = Date.now();
    return a;
  }

  applyOps(agentRef, ops) {
    const agent = this.touchAgent(agentRef);
    const results = [];
    const applied = [];
    for (const op of ops) {
      const r = this.scene.apply(op);
      results.push(r.ok ? { ok: true } : { ok: false, error: r.error });
      if (r.ok && r.op) {
        applied.push(r.op);
        if (r.op.type === 'status') agent.status = r.op.text;
      }
    }
    if (applied.length) this.broadcast({ type: 'ops', agent: publicAgent(agent), ops: applied });
    this.broadcastAgents();
    return { results, version: this.scene.version, parts: this.scene.parts.size };
  }

  removeAgent(id) {
    if (this.agents.delete(id)) this.broadcastAgents();
  }

  snapshot({ view = 'current', width = 768, height = 576, timeoutMs = 8000 } = {}) {
    const viewer = [...this.viewers].find((ws) => ws.readyState === ws.OPEN);
    if (!viewer) return Promise.resolve({ ok: false, error: 'no viewer is open' });
    const reqId = ++this.reqSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSnapshots.delete(reqId);
        resolve({ ok: false, error: 'viewer did not answer in time' });
      }, timeoutMs);
      this.pendingSnapshots.set(reqId, { resolve, timer });
      viewer.send(JSON.stringify({ type: 'snapshot', reqId, view, width, height }));
    });
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.viewers) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  broadcastAgents() {
    this.broadcast({ type: 'agents', agents: [...this.agents.values()].map(publicAgent) });
  }

  // ---- server ----

  listen(port, host = '127.0.0.1') {
    const server = http.createServer((req, res) => this.#handle(req, res));
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws) => this.#onViewer(ws));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.server = server;
        resolve(server);
      });
    });
  }

  #onViewer(ws) {
    this.viewers.add(ws);
    ws.send(JSON.stringify({ type: 'init', scene: this.scene.toJSON(), agents: [...this.agents.values()].map(publicAgent) }));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'snapshot_result') {
        const p = this.pendingSnapshots.get(msg.reqId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pendingSnapshots.delete(msg.reqId);
        p.resolve(msg.error ? { ok: false, error: msg.error } : { ok: true, dataUrl: msg.dataUrl });
      }
    });
    ws.on('close', () => this.viewers.delete(ws));
  }

  async #handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await this.#api(req, res, url);
      return this.#static(res, url.pathname);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  }

  async #api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/health':
        return json(res, 200, { app: 'realtime-render', viewers: this.viewers.size, parts: this.scene.parts.size });
      case 'GET /api/scene':
        return json(res, 200, this.scene.toJSON());
      case 'POST /api/ops': {
        const body = await readJson(req);
        if (!Array.isArray(body.ops)) return json(res, 400, { error: 'ops must be an array' });
        return json(res, 200, this.applyOps(body.agent ?? {}, body.ops));
      }
      case 'POST /api/snapshot': {
        const body = await readJson(req);
        return json(res, 200, await this.snapshot(body));
      }
      case 'POST /api/bye': {
        const body = await readJson(req);
        this.removeAgent(body.id);
        return json(res, 200, { ok: true });
      }
      default:
        return json(res, 404, { error: `no route ${route}` });
    }
  }

  #static(res, pathname) {
    let root = PUBLIC_DIR;
    let rel = pathname === '/' ? '/index.html' : pathname;
    if (rel.startsWith('/vendor/three/')) {
      root = THREE_DIR;
      rel = rel.slice('/vendor/three'.length);
    }
    const file = path.resolve(root, '.' + decodeURIComponent(rel));
    if (!file.startsWith(root + path.sep)) return json(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  }
}

const publicAgent = (a) => ({ id: a.id, name: a.name, color: a.color, status: a.status, lastSeen: a.lastSeen });

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
