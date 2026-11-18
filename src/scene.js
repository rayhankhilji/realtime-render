// The authoritative scene state. Everything the viewer shows is derived from
// this plus the stream of ops that changed it.

export const SHAPES = [
  'box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'plane', 'group',
];

const DEFAULTS = {
  shape: 'box',
  position: [0, 0, 0],
  rotation: [0, 0, 0], // degrees
  scale: [1, 1, 1],
  color: '#9aa4b2',
  metalness: 0.1,
  roughness: 0.6,
  opacity: 1,
  parent: null,
  name: null,
};

const PART_KEYS = Object.keys(DEFAULTS);

export class Scene {
  constructor() {
    this.parts = new Map(); // id -> part
    this.version = 0;
  }

  toJSON() {
    return { version: this.version, parts: [...this.parts.values()] };
  }

  // Applies one op. Returns { ok, op, error }. `op` is the normalized op that
  // should be broadcast to viewers (it may carry more detail than the input).
  apply(op) {
    try {
      const out = this.#apply(op);
      if (out) this.version++;
      return { ok: true, op: out };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  #apply(op) {
    switch (op.type) {
      case 'add': {
        const id = String(op.part?.id ?? '');
        if (!id) throw new Error('part.id is required');
        if (this.parts.has(id)) throw new Error(`part "${id}" already exists (use update_parts)`);
        const part = { id, ...DEFAULTS };
        for (const k of PART_KEYS) if (op.part[k] !== undefined) part[k] = op.part[k];
        validate(part, this);
        this.parts.set(id, part);
        return { type: 'add', part: { ...part }, world: this.worldPosition(id) };
      }
      case 'update': {
        const id = String(op.id ?? '');
        const part = this.parts.get(id);
        if (!part) throw new Error(`no part "${id}"`);
        const next = { ...part };
        const changes = {};
        for (const k of PART_KEYS) {
          if (op.changes?.[k] !== undefined) { next[k] = op.changes[k]; changes[k] = op.changes[k]; }
        }
        if (changes.parent !== undefined && this.#wouldCycle(id, changes.parent)) {
          throw new Error(`cannot parent "${id}" under its own descendant`);
        }
        validate(next, this);
        this.parts.set(id, next);
        return { type: 'update', id, changes, world: this.worldPosition(id) };
      }
      case 'remove': {
        const id = String(op.id ?? '');
        if (!this.parts.has(id)) throw new Error(`no part "${id}"`);
        const world = this.worldPosition(id);
        const removed = [];
        const walk = (pid) => {
          for (const p of this.parts.values()) if (p.parent === pid) walk(p.id);
          removed.push(pid);
        };
        walk(id);
        for (const r of removed) this.parts.delete(r);
        return { type: 'remove', id, removed, world };
      }
      case 'clear': {
        this.parts.clear();
        return { type: 'clear' };
      }
      case 'status':
      case 'focus':
        // Presence-only ops: don't touch the scene, still broadcast.
        return { type: op.type, text: op.text ?? null, position: op.position ?? null };
      default:
        throw new Error(`unknown op type "${op.type}"`);
    }
  }

  #wouldCycle(id, parent) {
    let cur = parent;
    while (cur) {
      if (cur === id) return true;
      cur = this.parts.get(cur)?.parent ?? null;
    }
    return false;
  }

  // Approximate world position (ignores parent rotation/scale beyond a simple
  // composition). Used to point the agent's cursor at what it's touching.
  worldPosition(id) {
    const chain = [];
    let cur = this.parts.get(id);
    while (cur) { chain.unshift(cur); cur = cur.parent ? this.parts.get(cur.parent) : null; }
    let pos = [0, 0, 0];
    let rot = [0, 0, 0];
    let scl = [1, 1, 1];
    for (const p of chain) {
      const local = rotate(mul(p.position, scl), rot);
      pos = add(pos, local);
      rot = add(rot, p.rotation);
      scl = mul(scl, p.scale);
    }
    return pos;
  }
}

function validate(part, scene) {
  if (!SHAPES.includes(part.shape)) throw new Error(`shape must be one of ${SHAPES.join(', ')}`);
  for (const k of ['position', 'rotation', 'scale']) {
    const v = part[k];
    if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new Error(`${k} must be [x, y, z] numbers`);
    }
  }
  if (part.parent != null && part.parent !== '' && !scene.parts.has(part.parent)) {
    throw new Error(`parent "${part.parent}" does not exist`);
  }
  if (part.parent === '') part.parent = null;
  if (part.parent === part.id) throw new Error('a part cannot be its own parent');
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];

// Euler XYZ rotation in degrees, matching three.js's default order.
function rotate(v, deg) {
  const [rx, ry, rz] = deg.map((d) => (d * Math.PI) / 180);
  let [x, y, z] = v;
  // three.js 'XYZ' order applies Z, then Y, then X to the vector.
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  return [x, y, z];
}
