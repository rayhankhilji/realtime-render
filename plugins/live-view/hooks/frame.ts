// Pure helpers: what kind of thing a file is, and the SVG the pane draws for
// one frame (the rendered picture, the changed region, the agent's cursor).

import type { Frame, FrameKind } from '../types'

const KINDS: Record<string, FrameKind> = {}
for (const [kind, exts] of Object.entries({
  page: ['html', 'htm'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'],
  video: ['mp4', 'webm', 'mov', 'm4v'],
  model: ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'],
  blend: ['blend'],
  markdown: ['md', 'markdown', 'mdx'],
} as Record<FrameKind, string[]>)) {
  for (const ext of exts) KINDS[ext] = kind as FrameKind
}

export function kindOf(file: string): FrameKind {
  const ext = file.split('/').pop()?.split('.').pop()?.toLowerCase() ?? ''
  return KINDS[ext] ?? 'code'
}

export const isVisual = (kind: FrameKind) =>
  kind === 'page' || kind === 'image' || kind === 'video' || kind === 'model' || kind === 'blend'

export const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p

const LANGS: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', css: 'css', scss: 'scss', html: 'html',
  json: 'json', sh: 'bash', glsl: 'glsl', frag: 'glsl', vert: 'glsl', swift: 'swift', kt: 'kotlin',
  java: 'java', c: 'c', cpp: 'cpp', h: 'c', yml: 'yaml', yaml: 'yaml', toml: 'toml', svg: 'xml',
}
export const languageOf = (file: string) => LANGS[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'text'

/** Where the cursor rests on a frame, as 0..1 of its width and height. */
export function cursorPoint(f: Frame | undefined): [number, number] {
  const b = f?.bbox
  if (!b) return [0.5, 0.5]
  return [b[0] + b[2] / 2, b[1] + b[3] / 2]
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The picture for one frame, with the agent's cursor gliding from where it
 * was on the frame before to the region that changed, and that region
 * outlined. `busy` adds a pulse while the agent is still working.
 */
export function frameSvg(opts: {
  frame: Frame
  jpegBase64: string
  from: [number, number]
  agent: string
  color: string
  busy: boolean
  caption: string
}): string {
  const { frame, jpegBase64, from, agent, color, busy, caption } = opts
  const W = frame.width ?? 720
  const H = frame.height ?? 450
  const to = cursorPoint(frame)
  const fx = (from[0] * W).toFixed(1)
  const fy = (from[1] * H).toFixed(1)
  const tx = (to[0] * W).toFixed(1)
  const ty = (to[1] * H).toFixed(1)

  const b = frame.bbox
  // A change covering most of the picture (a camera move, a new page) gets no box.
  const showBox = b && b[2] * b[3] < 0.7
  const box = showBox
    ? `<rect x="${(b[0] * W - 4).toFixed(1)}" y="${(b[1] * H - 4).toFixed(1)}" width="${(b[2] * W + 8).toFixed(1)}" height="${(b[3] * H + 8).toFixed(1)}" rx="6" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="2" stroke-dasharray="6 4" opacity="0">
        <animate attributeName="opacity" begin="0.7s" dur="0.4s" from="0" to="1" fill="freeze"/>
        <animate attributeName="stroke-dashoffset" begin="0s" dur="1.2s" from="0" to="-20" repeatCount="indefinite"/>
      </rect>`
    : ''

  const label = esc(agent)
  const labelW = 14 + label.length * 7.4
  const pulse = busy
    ? `<circle r="10" fill="none" stroke="${color}" stroke-width="2">
        <animate attributeName="r" values="6;22" dur="1.2s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.9;0" dur="1.2s" repeatCount="indefinite"/>
      </circle>`
    : ''

  const cap = esc(caption)
  const capW = Math.min(W - 16, 16 + cap.length * 6.6)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">
  <image href="data:image/jpeg;base64,${jpegBase64}" x="0" y="0" width="${W}" height="${H}"/>
  ${box}
  <g transform="translate(${tx} ${ty})">
    <animateTransform attributeName="transform" type="translate" from="${fx} ${fy}" to="${tx} ${ty}" dur="0.9s" calcMode="spline" keyTimes="0;1" keySplines="0.3 0 0.2 1" fill="freeze"/>
    ${pulse}
    <path d="M0 0 L0 18 L4.6 13.8 L8 21 L11 19.6 L7.8 12.6 L14 12.6 Z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
    <g transform="translate(14 20)">
      <rect width="${labelW.toFixed(1)}" height="20" rx="10" fill="${color}"/>
      <text x="7" y="14" font-size="12" font-weight="600" fill="#fff">${label}</text>
    </g>
  </g>
  <g transform="translate(8 ${H - 30})">
    <rect width="${capW.toFixed(1)}" height="22" rx="6" fill="#000" fill-opacity="0.55"/>
    <text x="8" y="15" font-size="11.5" fill="#fff">${cap}</text>
  </g>
</svg>`
}
