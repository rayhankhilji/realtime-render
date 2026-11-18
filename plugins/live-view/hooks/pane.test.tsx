import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'live-view',
  component: 'Pane',
  requestId: 'live-view',
  props: {
    title: 'Live View',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const FRAME = {
  id: 1, at: Date.now(), kind: 'page', target: '/p/index.html', touched: '/p/main.js', tool: 'Edit',
  imagePath: '/data/1.jpg', width: 720, height: 450, bbox: [0.4, 0.3, 0.2, 0.2, 0.04],
  snippet: { source: '-a\n+b', path: '/p/main.js', format: 'diff' },
}

test('an empty pane says what it is for', async ($) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Waiting for the agent/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('a frame draws its picture, its code and the timeline', async ($, on) => {
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    if (key === 'frames') return { value: { value: { shape: 'frames-1', value: [FRAME] }, version: 1 } }
    return { value: { value: undefined, version: 0 } }
  })
  on('fs.read', () => ({ value: { base64: '/9j/AAAA' } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeTruthy()
  expect(await ui.find({ type: 'Code' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /1 \/ 1/ }))?.text).toBeTruthy()
  await ui.unmount()
})
