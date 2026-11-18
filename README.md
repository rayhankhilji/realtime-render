# realtime-render: Live View

Watch your coding agent build things **live, inside the Claude Code chat**.

Live View is a Claude Code plugin that docks a pane beside the conversation in the
Claude desktop app. Every time the agent changes something, the pane re-renders the
result and moves the agent's cursor to the part that changed. Ask Claude for a
Three.js scene, an app UI, a logo set, a GIF, a 3D model or a Blender file, and you
watch it come together step by step. A timeline lets you scrub back through every
step.

## What it shows

| The agent is working on | The pane shows |
|---|---|
| A web page, app UI or Three.js / WebGL scene (`.html` and the JS/CSS behind it) | The page rendered in a headless browser |
| A dev server (Vite, Next, …) | The running app, after `/live-view url http://localhost:5173` |
| Images, logos, brand assets (`.png` `.jpg` `.svg` `.webp` `.gif`) | The image |
| Video (`.mp4` `.webm` `.mov`) | A frame from the video |
| 3D models (`.glb` `.gltf` `.obj` `.stl` `.ply` `.fbx`) | The model, lit and framed, on a grid |
| Blender (`.blend`) | The scene, exported through Blender in the background |
| Markdown | The rendered document |
| Anything else (backend code, configs) | The diff the agent just made |

Commands the agent runs (`Bash`) are covered too: when one finishes, Live View
looks at which files changed while it ran and shows the most visual one. That's how
a Python script that writes a GIF, or an `ffmpeg` command, ends up in the pane.

On top of the picture:

- **Agent cursor**: glides from where it was to the region that changed and
  outlines it. Changes are found by diffing consecutive frames, so it works for
  any visual output.
- **Status line**: what the agent is doing right now ("Editing main.js…",
  "Rendering…").
- **Code**: the edit that caused the frame, as a diff.
- **Timeline**: ⏮ ◀ ▶ and *Go live* to step through every frame of the session.
- **Widget mode**: minimize the pane and it becomes a small live thumbnail.

## How it works

```
agent edits a file ──► tool.call hook (plugins/live-view/hooks/register.tsx)
                         │ decides what to show: the file itself, the page that
                         │ uses it, or a pinned URL
                         ▼
                       renderer (plugins/live-view/renderer/server.mjs)
                         │ headless Chrome draws it to a JPEG and diffs it
                         │ against the last frame to find what changed
                         ▼
                       pane (ui.render hook) draws the frame as an SVG with the
                       cursor animated on top, plus code and the timeline
```

The renderer is a small local Node process. It starts on first use and talks to
the plugin over a Unix socket. On first start it installs its two dependencies
(`playwright-core`, `three`) and uses Chrome, Chromium, Edge or Brave from your
machine, or a Playwright install if you have one.

## Install

In Claude Code:

```
/plugin install live-view --marketplace rayhankhilji/realtime-render
```

Requirements: macOS or Linux, Node 18+, and Chrome (or Chromium, Edge or Brave).
Blender is only needed for `.blend` files. Set `LIVE_VIEW_BLENDER` if it isn't in
the usual place, and `LIVE_VIEW_CHROME` to point at a specific browser.

The pane appears in the Claude desktop app. In the terminal, the pane shows text
and code but not the rendered picture.

## Commands

| Command | What it does |
|---|---|
| `/live-view` | Open the pane |
| `/live-view url http://localhost:5173` | Always show this URL (use with a dev server and hot reload) |
| `/live-view file path/to/thing.glb` | Always show this file |
| `/live-view auto` | Go back to following whatever the agent changes |
| `/live-view refresh` | Render the current target again |
| `/live-view clear` | Clear the timeline |

## Developing

- `plugins/live-view/hooks/register.tsx`: the hooks (tool calls, commands, the pane)
- `plugins/live-view/hooks/frame.ts`: file kinds and the frame SVG (picture + cursor)
- `plugins/live-view/renderer/`: the headless renderer and its preview pages
- `claude plugin validate plugins/live-view` and `claude plugin test plugins/live-view`
- `scripts/sync-dev-mod.sh <dev-mods folder>` copies the plugin into a session's
  dev-mods folder so it hot-reloads while you work on it

## Not yet

- Frames update after each agent action, so the view moves in steps. The cursor
  animation smooths the jumps but doesn't fill them in.
- Pages that need a build step (React/Vite with bare imports) need a pinned dev-server URL.
- Windows isn't supported yet (the renderer uses a Unix socket and `sh`).
- Several agents at once (one cursor each) and Figma-style live design tools are
  next.
