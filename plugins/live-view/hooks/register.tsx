// Live View: a pane beside the chat that shows what the agent is building,
// re-rendered after every change it makes, with its cursor on what changed.
//
// Flow: a tool call that writes something (Write, Edit, Bash, ...) finishes
// -> the mod works out what to show (the file itself, the page that uses it,
// or a pinned dev-server URL) -> the renderer (renderer/server.mjs, a local
// headless browser) draws it to a JPEG -> a new frame lands in the timeline
// and the pane redraws.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Frame, FrameKind, Pin, View } from '../types'
import { baseName, cursorPoint, frameSvg, isVisual, kindOf, languageOf } from './frame'

const PANE = 'live-view'
const AGENT = 'Claude'
const COLOR = '#D97757'
const MAX_FRAMES = 80
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'])
const READERS: Record<string, string> = { Read: 'Reading', Grep: 'Searching', Glob: 'Looking through' }

const frames = atom({ plugin: 'live-view', key: 'frames' } as const, [] as Frame[], { shape: 'frames-1' })
const activity = atom({ plugin: 'live-view', key: 'activity' } as const, null as Activity | null, { shape: 'activity-1' })
const view = atom({ plugin: 'live-view', key: 'view' } as const, { index: null } as View, { shape: 'view-1' })
const pin = atom({ plugin: 'live-view', key: 'pin' } as const, {} as Pin, { shape: 'pin-1' })
const lastVisual = atom({ plugin: 'live-view', key: 'lastVisual' } as const, null as string | null, { shape: 'last-visual-1' })

type $ = EngineInterface
type Job = { touched: string; tool: string; snippet?: Frame['snippet']; sinceMs?: number }

// Module variables start over on a reload; session.start fills them again.
let cwd = '.'
let dataDir = ''
let sessionId = 'session'
let opened = false

// ---------------------------------------------------------------- renderer

const socketPath = ($: $) => `/tmp/claude-live-view-${hash($.plugin.root)}.sock`

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

async function call($: $, route: string, body?: unknown): Promise<any> {
  const sock = socketPath($)
  const payload = body === undefined ? undefined : JSON.stringify(body)
  try {
    const res = await $.http.fetch(`http://live-view${route}`, {
      method: payload ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: payload,
      socketPath: sock,
    })
    return JSON.parse(res.text)
  } catch {
    // Some hosts refuse plugin HTTP; curl over the same socket does the job.
    const args = ['curl', '-sS', '--max-time', '90', '--unix-socket', sock]
    if (payload) args.push('-X', 'POST', '-H', 'content-type: application/json', '--data-binary', '@-')
    const r = await $.process.run([...args, `http://live-view${route}`], { stdin: payload, timeoutMs: 95_000 })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'the renderer did not answer')
    return JSON.parse(r.stdout)
  }
}

let starting: Promise<void> | null = null

function ensureRenderer($: $) {
  starting ??= startRenderer($).catch((err) => {
    starting = null
    throw err
  })
  return starting
}

async function isHealthy($: $) {
  try {
    return (await call($, '/health'))?.ok === true
  } catch {
    return false
  }
}

async function startRenderer($: $) {
  if (await isHealthy($)) return
  const log = `${dataDir || '/tmp'}/live-view-renderer.log`
  await $.process.run(['sh', `${$.plugin.root}/renderer/start.sh`, socketPath($), log], { timeoutMs: 600_000 })
  for (let i = 0; i < 60; i++) {
    if (await isHealthy($)) return
    await $.clock.sleep(250)
  }
  throw new Error(`the renderer did not start (log: ${log})`)
}

// ---------------------------------------------------------------- pipeline

const queue: Job[] = []
let running = false

function schedule($: $, job: Job) {
  queue.push(job)
  if (!running) $.clock.after(1, () => void drain($))
}

async function drain($: $) {
  if (running) return
  running = true
  try {
    while (queue.length) {
      // Fall behind by more than a couple of changes and only the newest is drawn.
      const batch = queue.splice(0)
      for (const job of batch.length > 3 ? batch.slice(-1) : batch) {
        await renderJob($, job).catch((err) =>
          addFrame($, { kind: 'error', target: job.touched, touched: job.touched, tool: job.tool, snippet: job.snippet, error: String(err?.message ?? err) }),
        )
      }
    }
  } finally {
    running = false
    await update($, activity, (a) => (a?.verb === 'Rendering' ? null : a))
  }
}

async function renderJob($: $, job: Job) {
  await ensureRenderer($)
  let touched = job.touched
  let kind: FrameKind = kindOf(touched)

  if (job.tool === 'Bash') {
    // A command can write anything: look at what changed while it ran.
    const { files } = await call($, '/recent', { cwd, sinceMs: (job.sinceMs ?? Date.now()) - 1500 })
    if (!files?.length) return
    const pick = files.find((f: { kind: FrameKind }) => isVisual(f.kind)) ?? files[0]
    touched = pick.path
    kind = pick.kind
  }

  const pinned = await read($, pin)
  let target: { type: 'file' | 'url'; value: string } | null = null
  if (pinned.url) target = { type: 'url', value: pinned.url }
  else if (pinned.file) target = { type: 'file', value: pinned.file }
  else if (isVisual(kind)) {
    target = { type: 'file', value: touched }
    await update($, lastVisual, () => touched)
  } else if (kind === 'markdown') {
    const text = await $.fs.read(touched).catch(() => '')
    return addFrame($, { kind: 'markdown', target: touched, touched, tool: job.tool, text: text.slice(0, 20_000) })
  } else {
    // Code: show it through the last thing it drew, or the project's page.
    const shown = (await read($, lastVisual)) ?? (await findPage($))
    if (shown) target = { type: 'file', value: shown }
  }

  if (!target) return addFrame($, { kind: 'code', target: touched, touched, tool: job.tool, snippet: job.snippet ?? (await snippetOf($, touched)) })

  const list = await read($, frames)
  const id = (list.at(-1)?.id ?? 0) + 1
  const imagePath = `${dataDir}/frames/${sessionId}/${id}.jpg`
  const res = await call($, '/render', { target, saveAs: imagePath })
  if (!res.ok) {
    return addFrame($, { kind: 'error', target: target.value, touched, tool: job.tool, snippet: job.snippet, error: res.error })
  }
  if (target.type === 'file' && !pinned.file && !pinned.url && isVisual(res.kind)) await update($, lastVisual, () => target!.value)
  return addFrame($, {
    id,
    kind: res.kind,
    target: target.value,
    touched,
    tool: job.tool,
    imagePath,
    width: res.width,
    height: res.height,
    bbox: res.bbox ?? null,
    snippet: job.snippet,
    error: res.errors?.length ? `Page errors: ${res.errors.join(' · ').slice(0, 300)}` : undefined,
  })
}

async function findPage($: $) {
  for (const p of ['index.html', 'public/index.html', 'src/index.html']) {
    const full = `${cwd}/${p}`
    const st = await $.fs.stat(full).catch(() => null)
    if (st) return full
  }
  return null
}

async function snippetOf($: $, file: string): Promise<Frame['snippet']> {
  const text = await $.fs.read(file).catch(() => '')
  return { source: text.split('\n').slice(0, 80).join('\n').slice(0, 6000), path: file, format: 'source', startLine: 1 }
}

async function addFrame($: $, f: Omit<Frame, 'id' | 'at'> & { id?: number }) {
  await update($, frames, (list) => {
    const id = f.id ?? (list.at(-1)?.id ?? 0) + 1
    return [...list, { ...f, id, at: Date.now() } as Frame].slice(-MAX_FRAMES)
  })
  if (!opened) {
    opened = true
    void openPane($, 'first frame')
  }
}


// Opens the pane and records whether a surface actually drew it. A pane
// opened by the plugin itself (not by the person) may wait undrawn, so say
// how to open it.
const diag: string[] = []
async function openPane($: $, why: string) {
  const r = await $.ui.open({ id: PANE, title: 'Live View' }).catch((err) => ({ isPlaced: false as const, reason: String(err) }))
  diag.push(`${new Date().toISOString()} open(${why}) -> ${r.isPlaced ? 'placed' : `not placed: ${r.reason}`}`)
  if (dataDir) void $.fs.write(`${dataDir}/debug.log`, diag.slice(-50).join('\n') + '\n').catch(() => {})
  if (!r.isPlaced && why !== 'command') $.ui.toast('Live View has a new frame: type /live-view to open the pane')
  return r
}

// What the agent's edit looked like, for the code under the picture.
function snippetFromCall(e: Record<string, any>): Frame['snippet'] | undefined {
  const cap = (s: string) => s.slice(0, 6000)
  const diff = (a: string, b: string) => [
    ...String(a ?? '').split('\n').map((l) => `-${l}`),
    ...String(b ?? '').split('\n').map((l) => `+${l}`),
  ].join('\n')
  switch (e.tool) {
    case 'Write':
      return { source: cap(String(e.content ?? '').split('\n').slice(0, 80).join('\n')), path: e.file_path, format: 'source', startLine: 1 }
    case 'Edit':
      return { source: cap(diff(e.old_string, e.new_string)), path: e.file_path, format: 'diff' }
    case 'MultiEdit':
      return { source: cap((e.edits ?? []).map((x: any) => diff(x.old_string, x.new_string)).join('\n')), path: e.file_path, format: 'diff' }
    case 'NotebookEdit':
      return { source: cap(String(e.new_source ?? '')), path: e.notebook_path, format: 'source' }
    default:
      return undefined
  }
}

const fileOf = (e: Record<string, any>): string | undefined => e.file_path ?? e.notebook_path ?? e.path

// ---------------------------------------------------------------- hooks

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    const env = await $.process.hookEnv().catch(() => ({}) as Record<string, string>)
    dataDir = env.CLAUDE_PLUGIN_DATA ?? `/tmp/claude-live-view-data`
    sessionId = env.CLAUDE_CODE_SESSION_ID ?? 'session'
    await $.command.register({
      name: 'live-view',
      description: 'Live View pane: /live-view [url <http://…> | file <path> | auto | refresh | clear]',
    })
    // Warm the renderer now so the first frame is quick; failures surface later.
    $.clock.after(1, () => void ensureRenderer($).catch(() => {}))
    if (e.surface !== 'terminal') {
      $.clock.after(1, () => void openPane($, `session start (${e.surface ?? 'no surface'})`))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, any>
    const tool = e.tool
    if (READERS[tool]) {
      const subject = baseName(String(input.file_path ?? input.pattern ?? input.path ?? ''))
      await update($, activity, () => ({ verb: READERS[tool], subject, at: Date.now() }))
      return next(e)
    }
    if (!WRITERS.has(tool)) return next(e)

    const startedAt = Date.now()
    const file = fileOf(input)
    const subject = tool === 'Bash' ? String(input.description ?? input.command ?? '').slice(0, 60) : baseName(file ?? '')
    const verb = tool === 'Bash' ? 'Running' : tool === 'Write' ? 'Writing' : 'Editing'
    await update($, activity, () => ({ verb, subject, at: startedAt }))

    const ran = await next(e)
    if (ran.deny !== undefined || (ran as { isError?: boolean }).isError) {
      await update($, activity, () => null)
      return ran
    }
    await update($, activity, () => ({ verb: 'Rendering', subject: subject || 'changes', at: Date.now() }))
    schedule($, { touched: file ?? cwd, tool, snippet: snippetFromCall(input), sinceMs: startedAt })
    return ran
  }).catch(($, e, next) => next(e)) // never let the viewer get in the agent's way

  on('turn.complete', async ($, e, next) => {
    if (!running) await update($, activity, () => null)
    return next(e)
  })

  on('command.run', { command: 'live-view' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const open = () => openPane($, 'command')
    switch (sub) {
      case '':
        const r = await open()
        return { text: r.isPlaced ? 'Live View is open.' : `Live View could not be shown here: ${r.reason}` }
      case 'url': {
        if (!/^https?:\/\//.test(arg)) return { text: 'Give a full address, like /live-view url http://localhost:5173' }
        await update($, pin, () => ({ url: arg }))
        schedule($, { touched: arg, tool: 'pin' })
        await open()
        return { text: `Live View now shows ${arg} after every change.` }
      }
      case 'file': {
        const full = arg.startsWith('/') ? arg : `${cwd}/${arg}`
        await update($, pin, () => ({ file: full }))
        schedule($, { touched: full, tool: 'pin' })
        await open()
        return { text: `Live View now shows ${arg} after every change.` }
      }
      case 'auto':
        await update($, pin, () => ({}))
        return { text: 'Live View follows whatever the agent changes again.' }
      case 'refresh': {
        const last = (await read($, frames)).at(-1)
        if (!last) return { text: 'Nothing to refresh yet.' }
        schedule($, { touched: last.target, tool: 'refresh' })
        return { text: 'Rendering again.' }
      }
      case 'clear':
        await update($, frames, () => [])
        await update($, view, () => ({ index: null }))
        await update($, lastVisual, () => null)
        return { text: 'Live View timeline cleared.' }
      default:
        return { text: 'Usage: /live-view [url <http://…> | file <path> | auto | refresh | clear]' }
    }
  })

  // ------------------------------------------------------------ drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Code, Markdown } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const list = await read($, frames)
    const v = await read($, view)
    const act = await read($, activity)
    const pinned = await read($, pin)
    const isWidget = e.props.placement === 'widget'

    const isLive = v.index === null || v.index >= list.length
    const idx = isLive ? list.length - 1 : Math.max(0, v.index!)
    const f: Frame | undefined = list[idx]
    const before = list.slice(0, Math.max(0, idx)).reverse().find((x) => x.imagePath && x.target === f?.target)
    const isBusy = isLive && act !== null && Date.now() - act.at < 120_000

    const status = isBusy
      ? `${act!.verb} ${act!.subject}…`
      : f
        ? `Idle · last change ${clock(f.at)}`
        : 'Waiting for the agent to build something'

    let picture = null
    if (f?.imagePath) {
      const bytes = await $.fs.read(f.imagePath, { as: 'bytes' }).catch(() => null)
      if (bytes && Svg) {
        const source = frameSvg({
          frame: f,
          jpegBase64: bytes.base64,
          from: cursorPoint(before),
          agent: AGENT,
          color: COLOR,
          busy: isBusy,
          caption: `${f.tool === 'Bash' ? 'Ran a command' : f.tool} · ${baseName(f.touched)}`,
        })
        picture = (
          <Svg
            source={source}
            alt={`Live render of ${baseName(f.target)} after ${AGENT} changed ${baseName(f.touched)}`}
            isInteractive
            width={isWidget ? 300 : undefined}
          />
        )
      } else if (bytes) {
        picture = <Text dimColor>Rendered {baseName(f.target)}: open this session in the Claude desktop app to see it.</Text>
      }
    }

    if (isWidget) {
      return (
        <Box flexDirection="column">
          {picture}
          <Text color={COLOR}>● {status}</Text>
        </Box>
      )
    }

    const step = (to: number | null) => () => update($, view, () => ({ index: to }))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text color={COLOR} bold>● {AGENT}</Text>
          <Text dimColor={!isBusy}>{status}</Text>
        </Box>

        {!f && (
          <Markdown
            text={[
              'Ask the agent to build something and it appears here as it works:',
              'a Three.js scene, an app UI, an image or GIF, a 3D model, a Blender file, a logo set.',
              '',
              'Using a dev server? Run `/live-view url http://localhost:5173` so every change shows the running app.',
            ].join('\n')}
          />
        )}

        {picture}
        {f?.kind === 'markdown' && f.text && <Markdown text={f.text} />}
        {f?.error && <Text color="red">{f.error}</Text>}
        {f?.snippet && (
          <Code
            source={f.snippet.source}
            path={f.snippet.path}
            language={languageOf(f.snippet.path)}
            format={f.snippet.format}
            startLine={f.snippet.startLine}
            wrap="truncate-end"
          />
        )}

        {list.length > 0 && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="first" label="⏮" onPress={step(0)} />
            <Button key="prev" label="◀" onPress={step(Math.max(0, idx - 1))} />
            <Text>
              {idx + 1} / {list.length}
            </Text>
            <Button key="next" label="▶" onPress={step(idx + 1 >= list.length - 1 ? null : idx + 1)} />
            <Button key="live" label={isLive ? '● Live' : 'Go live'} variant={isLive ? 'secondary' : 'primary'} onPress={step(null)} />
          </Box>
        )}

        {f && (
          <Text dimColor>
            {clock(f.at)} · {f.tool} {baseName(f.touched)}
            {f.target !== f.touched ? ` → showing ${baseName(f.target)}` : ''}
            {pinned.url ? ` · pinned to ${pinned.url}` : pinned.file ? ` · pinned to ${baseName(pinned.file)}` : ''}
          </Text>
        )}
      </Box>
    )
  })
}

function clock(ms: number) {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}
