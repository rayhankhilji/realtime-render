export type FrameKind =
  | 'page' | 'image' | 'video' | 'model' | 'blend' | 'markdown' | 'code' | 'error'

/** One moment of the agent's work: what it changed and how that looks. */
export type Frame = {
  id: number
  at: number
  kind: FrameKind
  /** What the picture shows: a file path or a URL. */
  target: string
  /** The file the agent changed (or the command it ran). */
  touched: string
  tool: string
  /** The rendered JPEG on disk, for visual kinds. */
  imagePath?: string
  width?: number
  height?: number
  /** Where the picture changed since the last frame: x, y, w, h as 0..1. */
  bbox?: [x: number, y: number, w: number, h: number, share: number] | null
  /** The code change that caused this frame. */
  snippet?: { source: string; path: string; format: 'source' | 'diff'; startLine?: number }
  /** Markdown text, for markdown frames. */
  text?: string
  error?: string
}

/** What the agent is doing right now, shown above the picture. */
export type Activity = { verb: string; subject: string; at: number }

/** Which frame the person is looking at: null follows the newest. */
export type View = { index: number | null }

/** A target the person pinned: a dev-server URL or a file. */
export type Pin = { url?: string; file?: string }

declare module 'claude-code' {
  interface PluginState {
    'live-view': {
      frames: Shaped<Frame[]>
      activity: Shaped<Activity | null>
      view: Shaped<View>
      pin: Shaped<Pin>
      lastVisual: Shaped<string | null>
    }
  }
}
