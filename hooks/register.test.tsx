import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { cwdSlug, pathsIn } from './register'

const HOME = '/Users/me'

test('finds image paths of every accepted format, however they were dragged in', async () => {
  const text = [
    'look at /tmp/shot.png and "/tmp/with space.JPG"',
    "then '/tmp/photo.heic' and ~/Desktop/Screen\\ Shot.webp,",
    'plus /tmp/scan.tiff /tmp/clip.gif /tmp/old.bmp /tmp/also.jpeg',
  ].join('\n')

  expect(pathsIn(text, HOME)).toEqual([
    '/tmp/shot.png',
    '/tmp/with space.JPG',
    '/tmp/photo.heic',
    '/Users/me/Desktop/Screen Shot.webp',
    '/tmp/scan.tiff',
    '/tmp/clip.gif',
    '/tmp/old.bmp',
    '/tmp/also.jpeg',
  ])
})

test('reads the pasted-image marker for PNG and JPEG sources, once each', async () => {
  const text =
    'before [Image: source: /private/tmp/x/images/1.png] after [Image: source: /private/tmp/x/images/2.jpg] [Image: source: /private/tmp/x/images/1.png]'

  expect(pathsIn(text, HOME)).toEqual(['/private/tmp/x/images/1.png', '/private/tmp/x/images/2.jpg'])
})

test('ignores non-image paths, relative paths and escapes out of a directory', async () => {
  const text = 'see /tmp/notes.txt, src/logo.png, /tmp/../etc/shot.png and /tmp/shot.png.bak'

  expect(pathsIn(text, HOME)).toEqual([])
})

const result = (output: unknown, surface: 'terminal' | 'desktop' = 'terminal') =>
  ({
    plugin: 'terminal-images',
    component: 'ToolResult',
    requestId: 'toolu_1',
    surface,
    props: { tool_use_id: 'toolu_1', tool: 'SendUserFile', output, isErrored: false },
  }) as const

const png = {
  path: '/tmp/shot #1.png',
  size: 1234,
  isImage: true,
  scaled: { width: 800, height: 500, original_width: 1600, original_height: 1000 },
}

const engine = (on: On) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

test('draws a PNG inline in the terminal with its path below', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(result({ caption: 'Before and after', attachments: [png] }))

  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Before and after/ }))?.text).toBe('Before and after')
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeFalsy()
  await ui.unmount()
})

test('leaves every other surface to the engine', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(result({ attachments: [png] }, 'desktop'))

  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('leaves downloads, other formats and failed sends to the engine', async ($, on) => {
  engine(on)
  const cases = [
    { display: 'attach', attachments: [png] },
    { attachments: [{ ...png, path: '/tmp/photo.jpg' }] },
    { attachments: [{ ...png, upload_error: 'too large' }] },
  ]

  for (const output of cases) {
    const ui = await $.ui.mount(result(output))
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await ui.unmount()
  }
})

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg=='

const read = (type: string) =>
  ({
    plugin: 'terminal-images',
    component: 'ToolResult',
    requestId: 'toolu_2',
    surface: 'terminal',
    props: {
      tool_use_id: 'toolu_2',
      tool: 'Read',
      isErrored: false,
      output: {
        type: 'image',
        file: { base64: TINY_PNG, type, originalSize: 95, dimensions: { originalWidth: 4, originalHeight: 2 } },
      },
    },
  }) as const

test('draws a PNG that Claude read, in any session', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(read('image/png'))

  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeFalsy()
  await ui.unmount()
})

test('leaves a JPEG that Claude read to the engine', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(read('image/jpeg'))

  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

const group = (type: string, isExpanded = false) =>
  ({
    plugin: 'terminal-images',
    component: 'ToolGroup',
    requestId: 'group_1',
    surface: 'terminal',
    props: {
      isActive: false,
      isExpanded,
      calls: [
        {
          tool_use_id: 'toolu_3',
          tool: 'Read',
          input: { file_path: '/tmp/test.png' },
          isRunning: false,
          isErrored: false,
          isInterrupted: false,
          output: read(type).props.output,
        },
      ],
    },
  }) as const

test('keeps the grouped Read line and draws the PNG under it', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(group('image/png'))

  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('leaves an expanded group and a JPEG read to the engine', async ($, on) => {
  engine(on)
  for (const mounted of [group('image/png', true), group('image/jpeg')]) {
    const ui = await $.ui.mount(mounted)
    expect(await ui.find({ type: 'Image' })).toBeFalsy()
    await ui.unmount()
  }
})

const CWD = '/Users/me/Developer/my.app'
const CAPTURE_DIR = '/tmp/t/claude-prompt-images'
const INLINE_BYTES = 2 * 1024 * 1024

const promptEngine = (on: On, { cwd = CWD, tmpRoot = '', sizes = [95] } = {}) => {
  const root = tmpRoot || '/private/tmp'
  const uidDir = `${root}/claude-501`
  const slug = cwdSlug(cwd)
  const dir = `${uidDir}/${slug}${cwd.length > 200 ? '-hash' : ''}/sess1/images`
  const runs: string[][] = []
  const lists: string[] = []
  const reads: string[] = []
  const state = { visible: true, copyExitCode: 0 }

  mock.env(on, { HOME, TMPDIR: '/tmp/t', CLAUDE_CODE_TMPDIR: tmpRoot })
  mock.clock(on)
  engine(on)
  on('session.id', () => ({ value: 'sess1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.start', () => ({ cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('fs.list', ($, e) => {
    lists.push(e.path)
    const entry = (name: string, kind: 'file' | 'dir', size: number) => ({ name, kind, size, mtimeMs: 1, isLink: false })
    const entries =
      e.path === uidDir
        ? [entry('unrelated', 'dir', 0), entry(`${slug}-file`, 'file', 95), entry(`${slug}-missing`, 'dir', 0), entry(`${slug}-hash`, 'dir', 0)]
        : e.path === dir && state.visible
          ? sizes.map((size, index) => entry(`${index + 1}.png`, 'file', size))
          : []
    return { value: entries }
  })
  on('fs.exists', ($, e) => ({ value: e.path === dir }))
  on('fs.stat', ($, e) => ({ value: {
    kind: 'file',
    size: sizes[Number(/(\d+)\.png$/.exec(e.path)?.[1] ?? 1) - 1] ?? 95,
    mtimeMs: 1,
    isLink: false,
  } }))
  on('fs.read', ($, e) => {
    reads.push(e.path)
    return { value: { base64: TINY_PNG } }
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[0] === 'sh'
      ? `${HOME}\n/tmp/t\n501`
      : e.argv[0] === 'sips' ? 'pixelWidth: 4\npixelHeight: 2' : ''
    const exitCode = e.argv[0] === 'cp' ? state.copyExitCode : 0
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { dir, uidDir, runs, lists, reads, state }
}

const prompt = (text: string, count = 1) => ({
  text,
  wait: false,
  origin: { kind: 'composer' },
  attachments: Array.from({ length: count }, () => ({ type: 'image', mediaType: 'image/png' } as const)),
}) as const

const message = (text: string, requestId = 'm1') => ({
  plugin: 'terminal-images',
  component: 'UserMessage',
  surface: 'terminal',
  requestId,
  viewport: { columns: 100, rows: 30 },
  props: { text, origin: { kind: 'composer' }, isExpanded: false },
}) as const

test('uses the engine slug for punctuation and cuts long working directories at 200 characters', async () => {
  expect(cwdSlug(CWD)).toBe('-Users-me-Developer-my-app')
  expect(cwdSlug('/Users/me/my app_name')).toBe('-Users-me-my-app-name')
  expect(cwdSlug(`/${'a'.repeat(299)}`)).toBe(`-${'a'.repeat(199)}`)
})

test('finds a long engine slug by its prefix and the session images folder', async ($, on) => {
  const { dir, uidDir, lists, runs } = promptEngine(on, { cwd: `/${'a'.repeat(299)}` })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('long working directory'))
  const ui = await $.ui.mount(message('long working directory'))

  expect(lists).toEqual([uidDir, dir])
  expect(runs.filter(argv => argv[0] === 'cp')).toEqual([
    ['cp', `${dir}/1.png`, `${CAPTURE_DIR}/engine-sess1-1.png`],
  ])
  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  await ui.unmount()
})

test('finds engine images under the configured temporary root', async ($, on) => {
  const { lists, dir } = promptEngine(on, { tmpRoot: '/custom/tmp' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('custom temporary root'))
  const ui = await $.ui.mount(message('custom temporary root'))

  expect(dir).toBe('/custom/tmp/claude-501/-Users-me-Developer-my-app/sess1/images')
  expect(lists).toEqual([dir])
  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  await ui.unmount()
})

test('copies a pasted image once and draws its bytes again under another message id', async ($, on) => {
  const { dir, runs, reads, state } = promptEngine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('a pasted image'))

  for (const requestId of ['m1', 'm2', 'm1']) {
    const ui = await $.ui.mount(message('a pasted image', requestId))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: TINY_PNG })
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await ui.unmount()
    state.visible = false
  }

  expect(dir).toBe('/private/tmp/claude-501/-Users-me-Developer-my-app/sess1/images')
  expect(runs.filter(argv => argv[0] === 'cp')).toEqual([
    ['cp', `${dir}/1.png`, `${CAPTURE_DIR}/engine-sess1-1.png`],
  ])
  expect(reads).toEqual([`${CAPTURE_DIR}/engine-sess1-1.png`])
  expect(runs.some(argv => argv[0] === 'sips')).toBe(false)
  expect(runs.find(argv => argv[0] === 'find')?.includes('engine-*')).toBe(true)
})

test('draws a large pasted PNG from its capture-folder copy', async ($, on) => {
  const { reads } = promptEngine(on, { sizes: [INLINE_BYTES + 1] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('a large pasted image'))
  const ui = await $.ui.mount(message('a large pasted image'))

  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({
    file: `${CAPTURE_DIR}/engine-sess1-1.png`, format: 'png', generation: 1,
  })
  expect(reads).toEqual([])
  await ui.unmount()
})

test('draws PNG bytes at the exact inline limit', async ($, on) => {
  promptEngine(on, { sizes: [INLINE_BYTES] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('an image at the limit'))
  const ui = await $.ui.mount(message('an image at the limit'))

  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: TINY_PNG })
  await ui.unmount()
})

test('uses the inline budget in picture order and keeps later pictures on files', async ($, on) => {
  promptEngine(on, { sizes: [1.5 * 1024 * 1024, 1.5 * 1024 * 1024, 95] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('three pasted images', 3))
  const ui = await $.ui.mount(message('three pasted images'))

  expect((await ui.find({ type: 'Image', key: `${CAPTURE_DIR}/engine-sess1-1.png` }))?.props.source).toEqual({
    png: TINY_PNG,
  })
  for (const index of [2, 3]) {
    expect((await ui.find({ type: 'Image', key: `${CAPTURE_DIR}/engine-sess1-${index}.png` }))?.props.source).toEqual({
      file: `${CAPTURE_DIR}/engine-sess1-${index}.png`,
      format: 'png',
      generation: 1,
    })
  }
  await ui.unmount()
})

test('leaves an identical later prompt without attachments free of earlier pictures', async ($, on) => {
  promptEngine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('the same words'))
  const first = await $.ui.mount(message('the same words'))
  expect(await first.find({ type: 'Image' })).toBeTruthy()
  await first.unmount()

  await $.prompt.submit(prompt('the same words', 0))
  const later = await $.ui.mount(message('the same words', 'm2'))
  expect(await later.find({ type: 'Image' })).toBeFalsy()
  await later.unmount()
})

test('keeps an engine image pending until the file appears for a redraw', async ($, on) => {
  const { state, runs } = promptEngine(on)
  state.visible = false
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('an image still being written'))
  const first = await $.ui.mount(message('an image still being written'))
  expect(await first.find({ type: 'Image' })).toBeFalsy()
  await first.unmount()

  state.visible = true
  const later = await $.ui.mount(message('an image still being written', 'm2'))
  expect(await later.find({ type: 'Image' })).toBeTruthy()
  expect(runs.filter(argv => argv[0] === 'cp').length).toBe(1)
  await later.unmount()
})
