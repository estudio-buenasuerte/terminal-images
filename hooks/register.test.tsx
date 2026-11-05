import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { cwdSlug, fileUrl, pathsIn, pngSize } from './register'

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
  promptEngine(on)
  const ui = await $.ui.mount(result({ caption: 'Before and after', attachments: [png] }))

  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Before and after/ }))?.text).toBe('Before and after')
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeFalsy()
  await ui.unmount()
})

test('leaves every other surface to the engine', async ($, on) => {
  const { reads, runs } = promptEngine(on)
  const ui = await $.ui.mount(result({ attachments: [png] }, 'desktop'))

  expect(reads).toEqual([])
  expect(runs).toEqual([])

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

const promptEngine = (on: On, {
  platform = 'darwin',
  cwd = platform === 'win32' ? 'C:\\Users\\me\\Developer\\my.app' : CWD,
  tmpRoot = '',
  sizes = [95],
  converters = ['magick', 'convert', 'ffmpeg'],
  env = {},
  now = 0,
}: {
  platform?: 'darwin' | 'linux' | 'win32'
  cwd?: string
  tmpRoot?: string
  sizes?: number[]
  converters?: string[]
  env?: Record<string, string>
  now?: number
} = {}) => {
  const variables = {
    HOME: platform === 'win32' ? '' : HOME,
    TMPDIR: platform === 'win32' ? '' : '/tmp/t',
    OS: platform === 'win32' ? 'Windows_NT' : '',
    USERPROFILE: platform === 'win32' ? 'C:/Users/me' : '',
    TEMP: platform === 'win32' ? 'C:/Users/me/AppData/Local/Temp' : '',
    TMP: '',
    CLAUDE_CODE_TMPDIR: tmpRoot,
    ...env,
  }
  const captureBase = platform === 'win32'
    ? variables.TEMP || variables.TMP || `${variables.USERPROFILE}/AppData/Local/Temp`
    : variables.TMPDIR || `${variables.HOME}/.cache`
  const captureDir = `${captureBase.replace(/\\/g, '/').replace(/\/$/, '')}/claude-prompt-images`
  const root = (tmpRoot || (platform === 'darwin' ? '/private/tmp' : platform === 'linux' ? '/tmp' : captureBase)).replace(/\\/g, '/').replace(/\/$/, '')
  const uidDir = `${root}/claude-${platform === 'win32' ? '0' : '501'}`
  const slug = cwdSlug(cwd)
  const dir = `${uidDir}/${slug}${cwd.length > 200 ? '-hash' : ''}/sess1/images`
  const runs: string[][] = []
  const lists: string[] = []
  const reads: string[] = []
  const state: {
    visible: boolean
    folderExists: boolean
    visibleCount: number
    copyExitCode: number
    mtimeMs: number
    base64: string
    readFails: boolean
    conversionExitCode: number
    unameExitCode: number
    probeThrows: boolean
    captureEntries: { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }[]
    gatedPath?: string
    readGate?: Promise<void>
    onRead?: () => void
    conversionGate?: Promise<void>
    onConvert?: () => void
  } = {
    visible: true,
    folderExists: true,
    visibleCount: sizes.length,
    copyExitCode: 0,
    mtimeMs: 1,
    base64: TINY_PNG,
    readFails: false,
    conversionExitCode: 0,
    unameExitCode: 0,
    probeThrows: false,
    captureEntries: [],
  }

  // The kit resolves every path against the host working directory, so on a
  // POSIX host a drive path arrives prefixed; Node on Windows keeps it absolute.
  const seen = (path: string) => path.replace(/^\/.*?(?=[A-Za-z]:\/)/, "")
  mock.env(on, variables)
  mock.clock(on, { now })
  engine(on)
  on('session.id', () => ({ value: 'sess1' }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.start', () => ({ cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('fs.list', ($, e) => {
    lists.push(seen(e.path))
    const entry = (name: string, kind: 'file' | 'dir', size: number) => ({ name, kind, size, mtimeMs: 1, isLink: false })
    const entries =
      seen(e.path) === captureDir
        ? state.captureEntries
        : seen(e.path) === uidDir
        ? [entry('unrelated', 'dir', 0), entry(`${slug}-file`, 'file', 95), entry(`${slug}-missing`, 'dir', 0), entry(`${slug}-hash`, 'dir', 0)]
        : seen(e.path) === dir && state.visible
          ? sizes.slice(0, state.visibleCount).map((size, index) => entry(`${index + 1}.png`, 'file', size))
          : []
    return { value: entries }
  })
  on('fs.exists', ($, e) => ({ value: state.folderExists && seen(e.path) === dir }))
  on('fs.stat', ($, e) => ({ value: {
    kind: 'file',
    size: sizes[Number(/(\d+)\.png$/.exec(seen(e.path))?.[1] ?? 1) - 1] ?? 95,
    mtimeMs: state.mtimeMs,
    isLink: false,
  } }))
  on('fs.read', async ($, e) => {
    reads.push(seen(e.path))
    if (seen(e.path) === state.gatedPath) {
      state.onRead?.()
      await state.readGate
    }
    if (state.readFails) throw new Error('unreadable')
    return { value: { base64: state.base64 } }
  })
  on('process.run', async ($, e) => {
    runs.push([...e.argv])
    const tool = e.argv[0] ?? ''
    const isProbe = e.argv[1] === '-version'
    const isConversion = ['sips', 'magick', 'convert', 'ffmpeg'].includes(tool) && !isProbe
    if (isProbe && state.probeThrows) throw new Error('missing executable')
    if (isConversion) {
      state.onConvert?.()
      await state.conversionGate
    }
    const stdout = tool === 'uname' ? platform === 'darwin' ? 'Darwin\n' : 'Linux\n' : tool === 'id' ? '501\n' : ''
    const exitCode = tool === 'cp' || (tool === 'powershell' && e.argv[4]?.startsWith('Copy-Item'))
      ? state.copyExitCode
      : isProbe ? converters.includes(tool) ? 0 : 1
        : isConversion ? state.conversionExitCode
          : tool === 'uname' ? state.unameExitCode : 0
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { dir, uidDir, captureDir, runs, lists, reads, state }
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

  expect(lists).toEqual([CAPTURE_DIR, uidDir, dir])
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
  expect(lists).toEqual([CAPTURE_DIR, dir])
  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  await ui.unmount()
})

test('copies a pasted image once and draws its bytes again under another message id', async ($, on) => {
  const { dir, runs, reads, state } = promptEngine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('a pasted image'))

  for (const requestId of ['m1', 'm2', 'm1']) {
    const ui = await $.ui.mount(message('a pasted image', requestId))
    expect(await ui.find({ type: 'Image' })).toBeTruthy()
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
  expect(runs.some(argv => argv[0] === 'find')).toBe(false)
})

test('links a large pasted PNG without drawing an Image', async ($, on) => {
  const { reads } = promptEngine(on, { sizes: [INLINE_BYTES + 1] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('a large pasted image'))
  const ui = await $.ui.mount(message('a large pasted image'))

  expect(await ui.find({ type: 'Image' })).toBeFalsy()
  expect(await ui.find({ type: 'Link', text: `${CAPTURE_DIR}/engine-sess1-1.png` })).toBeTruthy()
  expect(reads).toEqual([])
  await ui.unmount()
})

test('draws PNG bytes at the exact inline limit', async ($, on) => {
  promptEngine(on, { sizes: [INLINE_BYTES] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('an image at the limit'))
  const ui = await $.ui.mount(message('an image at the limit'))

  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  await ui.unmount()
})

test('uses the inline budget in picture order and links later pictures', async ($, on) => {
  promptEngine(on, { sizes: [1.5 * 1024 * 1024, 1.5 * 1024 * 1024, 95] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('three pasted images', 3))
  const ui = await $.ui.mount(message('three pasted images'))

  expect(await ui.find({ type: 'Image', key: `${CAPTURE_DIR}/engine-sess1-1.png` })).toBeTruthy()
  for (const index of [2, 3]) {
    const path = `${CAPTURE_DIR}/engine-sess1-${index}.png`
    expect(await ui.find({ type: 'Image', key: path })).toBeFalsy()
    expect(await ui.find({ type: 'Link', text: path })).toBeTruthy()
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

test('rejects empty, truncated, non-PNG and malformed base64 headers without throwing', async () => {
  for (const base64 of ['', 'iVBORw==', TINY_PNG.slice(0, 28), 'aGVsbG8=', '!@#$%', `AVBORw0KGgo${TINY_PNG.slice(11)}`, `iVBORwAAAAA${TINY_PNG.slice(11)}`]) {
    expect(pngSize(base64)).toBe(null)
  }
  expect(pngSize(TINY_PNG)).toEqual({ width: 4, height: 2 })
})

test('applies one inline budget to all PNGs in a collapsed Read group', async ($, on) => {
  engine(on)
  const base64 = TINY_PNG.slice(0, 32).padEnd(2 * 1024 * 1024, 'A')
  const grouped = group('image/png')
  const calls = [1, 2].map(index => ({
    ...grouped.props.calls[0],
    tool_use_id: `read-${index}`,
    input: { file_path: `/tmp/budget-${index}.png` },
    output: {
      ...read('image/png').props.output,
      file: { ...read('image/png').props.output.file, base64 },
    },
  }))
  const ui = await $.ui.mount({ ...grouped, props: { ...grouped.props, calls } })

  expect(await ui.find({ type: 'Image', key: '/tmp/budget-1.png' })).toBeTruthy()
  expect(await ui.find({ type: 'Image', key: '/tmp/budget-2.png' })).toBeFalsy()
  expect(await ui.find({ type: 'Link', text: '/tmp/budget-2.png' })).toBeTruthy()
  await ui.unmount()
})

test('applies one inline budget to all SendUserFile attachments', async ($, on) => {
  promptEngine(on)
  const attachments = [1, 2].map(index => ({ ...png, path: `/tmp/send-${index}.png`, size: 1.5 * 1024 * 1024 }))
  const ui = await $.ui.mount(result({ attachments }))

  expect(await ui.find({ type: 'Image', key: '/tmp/send-1.png' })).toBeTruthy()
  expect(await ui.find({ type: 'Image', key: '/tmp/send-2.png' })).toBeFalsy()
  expect(await ui.find({ type: 'Link', text: '/tmp/send-2.png' })).toBeTruthy()
  await ui.unmount()
})

test('reads new prompt bytes when the same filename has a new modification time', async ($, on) => {
  const { reads, state } = promptEngine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('first /tmp/changed.png', 0))
  const first = await $.ui.mount(message('first /tmp/changed.png'))
  expect(await first.find({ type: 'Image', key: '/tmp/changed.png' })).toBeTruthy()
  await first.unmount()

  state.mtimeMs = 2
  state.base64 = 'invalid new bytes'
  await $.prompt.submit(prompt('second /tmp/changed.png', 0))
  const later = await $.ui.mount(message('second /tmp/changed.png', 'm2'))
  expect(reads.filter(path => path === '/tmp/changed.png').length >= 2).toBe(true)
  expect(await later.find({ type: 'Image' })).toBeFalsy()
  expect(await later.find({ type: 'Link', text: '/tmp/changed.png' })).toBeTruthy()
  await later.unmount()
})

test('recovers a pasted attachment independently of a typed image path', async ($, on) => {
  promptEngine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('compare /tmp/typed.png with this paste'))
  const ui = await $.ui.mount(message('compare /tmp/typed.png with this paste'))

  expect(await ui.find({ type: 'Image', key: '/tmp/typed.png' })).toBeTruthy()
  expect(await ui.find({ type: 'Image', key: `${CAPTURE_DIR}/engine-sess1-1.png` })).toBeTruthy()
  await ui.unmount()
})

test('keeps partially resolved engine copies pending across redraws of the same row', async ($, on) => {
  const { state, runs } = promptEngine(on, { sizes: [95, 95] })
  state.visibleCount = 1
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('two copies arriving separately', 2))
  const first = await $.ui.mount(message('two copies arriving separately'))
  expect(await first.find({ type: 'Image', key: `${CAPTURE_DIR}/engine-sess1-1.png` })).toBeTruthy()
  expect(await first.find({ type: 'Image', key: `${CAPTURE_DIR}/engine-sess1-2.png` })).toBeFalsy()
  await first.unmount()

  state.visibleCount = 2
  const later = await $.ui.mount(message('two copies arriving separately'))
  expect(await later.find({ type: 'Image', key: `${CAPTURE_DIR}/engine-sess1-1.png` })).toBeTruthy()
  expect(await later.find({ type: 'Image', key: `${CAPTURE_DIR}/engine-sess1-2.png` })).toBeTruthy()
  expect(runs.filter(argv => argv[0] === 'cp').length).toBe(2)
  await later.unmount()
})

test('does not wait for engine copies when the short-cwd images folder is absent', async ($, on) => {
  const { state, lists, runs } = promptEngine(on)
  state.folderExists = false
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('missing images directory'))
  const first = await $.ui.mount(message('missing images directory'))
  expect(await first.find({ type: 'Image' })).toBeFalsy()
  await first.unmount()

  state.folderExists = true
  const later = await $.ui.mount(message('missing images directory', 'm2'))
  expect(await later.find({ type: 'Image' })).toBeFalsy()
  expect(lists).toEqual([CAPTURE_DIR])
  expect(runs.some(argv => argv[0] === 'cp')).toBe(false)
  await later.unmount()
})

test('does no file or process work on non-terminal rendering surfaces', async ($, on) => {
  const { reads, runs, lists } = promptEngine(on)
  const events = [
    { ...result({ attachments: [png] }), surface: 'desktop' as const },
    { ...read('image/png'), surface: 'desktop' as const },
    { ...group('image/png'), surface: 'desktop' as const },
    { ...message('non-terminal /tmp/shot.png'), surface: 'desktop' as const },
  ]
  for (const event of events) {
    const ui = await $.ui.mount(event)
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await ui.unmount()
  }
  expect(reads).toEqual([])
  expect(runs).toEqual([])
  expect(lists).toEqual([])
})

test('continues submit while a path conversion is still running', async ($, on) => {
  const { state } = promptEngine(on)
  let finishConversion!: () => void
  let startedConversion!: () => void
  state.conversionGate = new Promise<void>(resolve => { finishConversion = resolve })
  const started = new Promise<void>(resolve => { startedConversion = resolve })
  state.onConvert = startedConversion
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('convert /tmp/photo.jpg', 0))
  await started
  finishConversion()
  const ui = await $.ui.mount(message('convert /tmp/photo.jpg'))

  expect(await ui.find({ type: 'Image', key: '/tmp/photo.jpg' })).toBeTruthy()
  await ui.unmount()
})

test('removes a claimed pending entry by identity after concurrent submits shift the array', async ($, on) => {
  const { state } = promptEngine(on)
  state.visible = false
  let finishRead!: () => void
  let startedRead!: () => void
  state.gatedPath = '/tmp/slow.png'
  state.readGate = new Promise<void>(resolve => { finishRead = resolve })
  const started = new Promise<void>(resolve => { startedRead = resolve })
  state.onRead = startedRead
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('older pending attachment'))
  await $.prompt.submit(prompt('slow /tmp/slow.png', 0))
  const drawing = $.ui.mount(message('slow /tmp/slow.png'))
  await started
  for (let index = 0; index < 19; index += 1) {
    await $.prompt.submit(prompt(`new pending ${index}`))
    const waiting = await $.ui.mount(message(`new pending ${index}`, `waiting-${index}`))
    expect(await waiting.find({ type: 'Image' })).toBeFalsy()
    await waiting.unmount()
  }
  finishRead()
  const first = await drawing
  expect(await first.find({ type: 'Image' })).toBeTruthy()
  await first.unmount()

  state.visible = true
  const later = await $.ui.mount(message('new pending 0', 'm2'))
  expect(await later.find({ type: 'Image' })).toBeTruthy()
  await later.unmount()
})

test('uses a link when SendUserFile bytes are oversized, unreadable or invalid', async ($, on) => {
  const { state } = promptEngine(on)
  for (const mode of ['oversized', 'unreadable', 'invalid']) {
    state.readFails = mode === 'unreadable'
    state.base64 = mode === 'invalid' ? 'not PNG bytes' : TINY_PNG
    const path = `/tmp/${mode}.png`
    const ui = await $.ui.mount(result({ attachments: [{ ...png, path, size: mode === 'oversized' ? INLINE_BYTES + 1 : 95 }] }))
    expect(await ui.find({ type: 'Image' })).toBeFalsy()
    expect(await ui.find({ type: 'Link', text: path })).toBeTruthy()
    await ui.unmount()
  }
})

test('uses a link when prompt bytes are unreadable or invalid', async ($, on) => {
  const { state } = promptEngine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  for (const mode of ['unreadable', 'invalid']) {
    state.readFails = mode === 'unreadable'
    state.base64 = mode === 'invalid' ? 'not PNG bytes' : TINY_PNG
    const path = `/tmp/${mode}.png`
    const text = `inspect ${path}`
    await $.prompt.submit(prompt(text, 0))
    const ui = await $.ui.mount(message(text, mode))
    expect(await ui.find({ type: 'Image' })).toBeFalsy()
    expect(await ui.find({ type: 'Link', text: path })).toBeTruthy()
    await ui.unmount()
  }
})

test('links invalid Read bytes with a known path and leaves unknown paths to the engine', async ($, on) => {
  engine(on)
  const invalid = { ...read('image/png').props.output, file: { ...read('image/png').props.output.file, base64: '' } }
  const grouped = group('image/png')
  const ui = await $.ui.mount({
    ...grouped,
    props: { ...grouped.props, calls: [{ ...grouped.props.calls[0], output: invalid }] },
  })
  expect(await ui.find({ type: 'Image' })).toBeFalsy()
  expect(await ui.find({ type: 'Link', text: '/tmp/test.png' })).toBeTruthy()
  await ui.unmount()

  const unknown = read('image/png')
  const fallback = await $.ui.mount({ ...unknown, props: { ...unknown.props, output: invalid } })
  expect(await fallback.find({ type: 'Image' })).toBeFalsy()
  expect((await fallback.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await fallback.unmount()
})

test('links an empty prompt PNG instead of losing its path', async ($, on) => {
  const { state } = promptEngine(on, { sizes: [0] })
  state.base64 = ''
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('inspect /tmp/empty.png', 0))
  const ui = await $.ui.mount(message('inspect /tmp/empty.png'))

  expect(await ui.find({ type: 'Image' })).toBeFalsy()
  expect(await ui.find({ type: 'Link', text: '/tmp/empty.png' })).toBeTruthy()
  await ui.unmount()
})

test('accepts Windows drive paths, quoted spaces, source markers and the Windows home', async () => {
  expect(pathsIn(String.raw`C:\Users\me\shot.png C:/Users/me/forward.png "C:\Users\me\my shot.jpg" 'D:/my photos/shot.webp' ~/Pictures/home.png`, 'C:\\Users\\me', 'win32')).toEqual([
    'C:/Users/me/shot.png',
    'C:/Users/me/forward.png',
    'C:/Users/me/my shot.jpg',
    'D:/my photos/shot.webp',
    'C:/Users/me/Pictures/home.png',
  ])
  expect(pathsIn(String.raw`[Image: source: C:\Users\me\paste.png]`, HOME, 'win32')).toEqual(['C:/Users/me/paste.png'])
  expect(pathsIn(String.raw`C:\Users\me\..\shot.png C:/Users/me/shot.png.bak`, HOME, 'win32')).toEqual([])
})

test('keeps backslash-escaped spaces on POSIX and literal backslashes on Windows', async () => {
  expect(pathsIn(String.raw`/tmp/Screen\ Shot.png`, HOME, 'linux')).toEqual(['/tmp/Screen Shot.png'])
  expect(pathsIn(String.raw`~/Pictures/Screen\ Shot.png`, 'C:/Users/me', 'win32')).toEqual([])
  expect(pathsIn(String.raw`"C:\Users\me\ shot.png"`, HOME, 'win32')).toEqual(['C:/Users/me/ shot.png'])
  expect(pathsIn(String.raw`~/Pictures\nested\shot.png`, 'C:/Users/me', 'win32')).toEqual(['C:/Users/me/Pictures/nested/shot.png'])
  expect(pathsIn(String.raw`/tmp/Pictures\nested\shot.png`, HOME, 'linux')).toEqual([])
})

test('encodes local file links with the right drive or POSIX root', async () => {
  expect(fileUrl(String.raw`C:\Users\me\shot #1.png`)).toBe('file:///C:/Users/me/shot%20%231.png')
  expect(fileUrl('D:/Users/me/100%.png')).toBe('file:///D:/Users/me/100%25.png')
  expect(fileUrl('/Users/me/shot #1.png')).toBe('file:///Users/me/shot%20%231.png')
})

test('keeps the darwin engine root, private mkdir and sips conversion', async ($, on) => {
  const { runs, dir } = promptEngine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('darwin /tmp/photo.jpg'))
  const ui = await $.ui.mount(message('darwin /tmp/photo.jpg'))

  expect(dir).toBe('/private/tmp/claude-501/-Users-me-Developer-my-app/sess1/images')
  expect(runs.slice(0, 3)).toEqual([['uname', '-s'], ['id', '-u'], ['mkdir', '-p', '-m', '700', CAPTURE_DIR]])
  const conversion = runs.find(argv => argv[0] === 'sips')
  expect(conversion).toEqual(['sips', '-s', 'format', 'png', '/tmp/photo.jpg', '--out', conversion?.[6]])
  expect(runs.filter(argv => argv[0] === 'cp')).toEqual([['cp', `${dir}/1.png`, `${CAPTURE_DIR}/engine-sess1-1.png`]])
  expect(runs.some(argv => argv[1] === '-version' || argv[1] === '-g')).toBe(false)
  expect(await ui.find({ type: 'Image', key: '/tmp/photo.jpg' })).toBeTruthy()
  await ui.unmount()
})

test('detects Linux with uname and id and copies from the /tmp engine root', async ($, on) => {
  const { runs, dir } = promptEngine(on, { platform: 'linux' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('linux pasted image'))
  const ui = await $.ui.mount(message('linux pasted image'))

  expect(dir).toBe('/tmp/claude-501/-Users-me-Developer-my-app/sess1/images')
  expect(runs).toEqual([
    ['uname', '-s'], ['id', '-u'], ['mkdir', '-p', '-m', '700', CAPTURE_DIR],
    ['cp', `${dir}/1.png`, `${CAPTURE_DIR}/engine-sess1-1.png`],
  ])
  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  await ui.unmount()
})

test('falls back to Linux when uname fails', async ($, on) => {
  const { state, dir, runs } = promptEngine(on, { platform: 'linux' })
  state.unameExitCode = 1
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('failed uname paste'))
  const ui = await $.ui.mount(message('failed uname paste'))
  expect(runs.some(argv => argv[0] === 'cp' && argv[1] === `${dir}/1.png`)).toBe(true)
  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  await ui.unmount()
})

test('detects Windows from OS and uses PowerShell and claude-0 under TEMP', async ($, on) => {
  const { dir, captureDir, runs, reads } = promptEngine(on, { platform: 'win32', env: { HOME } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\Users\\me\\Developer\\my.app' })
  await $.prompt.submit(prompt('windows pasted image'))
  const ui = await $.ui.mount(message('windows pasted image'))

  expect(dir).toBe('C:/Users/me/AppData/Local/Temp/claude-0/C--Users-me-Developer-my-app/sess1/images')
  expect(runs).toEqual([
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Directory -Force -LiteralPath '${captureDir}'`],
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Copy-Item -LiteralPath '${dir}/1.png' -Destination '${captureDir}/engine-sess1-1.png'`],
  ])
  expect(reads).toEqual([`${captureDir}/engine-sess1-1.png`])
  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  await ui.unmount()
})

test('detects Windows from USERPROFILE without HOME and normalizes typed paths', async ($, on) => {
  const { runs, reads } = promptEngine(on, { platform: 'win32', env: { OS: '' } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:/Users/me' })
  const text = String.raw`windows C:\Users\me\typed.png ~/Pictures/home.png`
  await $.prompt.submit(prompt(text, 0))
  const ui = await $.ui.mount(message(text))
  expect(runs.map(argv => argv[0])).toEqual(['powershell'])
  expect(reads).toEqual(['C:/Users/me/typed.png', 'C:/Users/me/Pictures/home.png'])
  expect(await ui.find({ type: 'Image', key: 'C:/Users/me/typed.png' })).toBeTruthy()
  expect(await ui.find({ type: 'Link', text: 'C:/Users/me/Pictures/home.png' })).toBeTruthy()
  await ui.unmount()
})

test('draws SendUserFile Windows paths using normalized filesystem paths', async ($, on) => {
  const { reads } = promptEngine(on, { platform: 'win32' })
  const path = String.raw`C:\Users\me\shot #1.png`
  const ui = await $.ui.mount(result({ attachments: [{ ...png, path }] }))
  expect(reads).toEqual(['C:/Users/me/shot #1.png'])
  expect(await ui.find({ type: 'Image', key: path })).toBeTruthy()
  expect(await ui.find({ type: 'Link', text: path })).toBeTruthy()
  await ui.unmount()
})

for (const platform of ['linux', 'win32'] as const) {
  for (const tool of ['magick', 'convert', 'ffmpeg', 'none']) {
    test(`${platform} selects ${tool} and caches its converter probes`, async ($, on) => {
      const { runs } = promptEngine(on, { platform, converters: tool === 'none' ? [] : [tool] })
      await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
      for (const name of ['first', 'second']) {
        const source = platform === 'win32' ? `C:/Users/me/${name}.jpg` : `/tmp/${name}.jpg`
        const text = `convert ${source}`
        await $.prompt.submit(prompt(text, 0))
        const ui = await $.ui.mount(message(text, name))
        expect(Boolean(await ui.find({ type: 'Image' }))).toBe(tool !== 'none')
        expect(await ui.find({ type: 'Link', text: source })).toBeTruthy()
        await ui.unmount()
      }
      const tools = ['magick', 'convert', 'ffmpeg']
      expect(runs.filter(argv => argv[1] === '-version')).toEqual(
        tools.slice(0, tool === 'none' ? 3 : tools.indexOf(tool) + 1).map(name => [name, '-version']),
      )
      const conversions = runs.filter(argv => tools.includes(argv[0] ?? '') && argv[1] !== '-version')
      expect(conversions.length).toBe(tool === 'none' ? 0 : 2)
      for (const [index, argv] of conversions.entries()) {
        const source = `${platform === 'win32' ? 'C:/Users/me' : '/tmp'}/${index === 0 ? 'first' : 'second'}.jpg`
        expect(argv).toEqual(tool === 'ffmpeg'
          ? ['ffmpeg', '-y', '-i', source, '-frames:v', '1', argv[6]]
          : [tool, source, argv[2]])
      }
      if (platform === 'win32') expect(runs.some(argv => ['uname', 'id', 'mkdir', 'cp', 'rm', 'sips'].includes(argv[0] ?? ''))).toBe(false)
    })
  }
}

test('keeps source links when converter probes throw or conversion fails', async ($, on) => {
  const { state, runs } = promptEngine(on, { platform: 'linux' })
  state.probeThrows = true
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('missing tools /tmp/no-tools.jpg', 0))
  const missing = await $.ui.mount(message('missing tools /tmp/no-tools.jpg'))
  expect(await missing.find({ type: 'Image' })).toBeFalsy()
  expect(await missing.find({ type: 'Link', text: '/tmp/no-tools.jpg' })).toBeTruthy()
  await missing.unmount()

  state.probeThrows = false
  state.conversionExitCode = 1
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('failed conversion /tmp/failed.jpg', 0))
  const failed = await $.ui.mount(message('failed conversion /tmp/failed.jpg', 'failed'))
  expect(await failed.find({ type: 'Image' })).toBeFalsy()
  expect(await failed.find({ type: 'Link', text: '/tmp/failed.jpg' })).toBeTruthy()
  expect(runs.some(argv => argv[0] === 'magick' && argv[1] === '/tmp/failed.jpg')).toBe(true)
  await failed.unmount()
})

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  test(`${platform} prunes only capture files older than one day`, async ($, on) => {
    const day = 24 * 60 * 60 * 1000
    const { state, captureDir, runs, lists } = promptEngine(on, { platform, now: 2 * day })
    state.captureEntries = [
      ...['paste-old.png', 'conv-old.png', 'engine-old.png', 'unrelated.png'].map(name => ({ name, kind: 'file' as const, size: 95, mtimeMs: 0, isLink: false })),
      { name: 'paste-recent.png', kind: 'file', size: 95, mtimeMs: 2 * day, isLink: false },
      { name: 'conv-boundary.png', kind: 'file', size: 95, mtimeMs: day, isLink: false },
      { name: 'engine-folder', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ]
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    expect(lists).toEqual([captureDir])
    const deletions = runs.filter(argv => argv[0] === 'rm' || argv[4]?.startsWith('Remove-Item'))
    expect(deletions).toEqual(['paste-old.png', 'conv-old.png', 'engine-old.png'].map(name => platform === 'win32'
      ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Remove-Item -LiteralPath '${captureDir}/${name}'`]
      : ['rm', '-f', `${captureDir}/${name}`]))
  })
}

test('caps capture pruning at 200 deletions per session start', async ($, on) => {
  const { state, runs } = promptEngine(on, { now: 2 * 24 * 60 * 60 * 1000 })
  state.captureEntries = Array.from({ length: 205 }, (_, index) => ({ name: `paste-${index}.png`, kind: 'file', size: 95, mtimeMs: 0, isLink: false }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  expect(runs.filter(argv => argv[0] === 'rm').length).toBe(200)
})

test('quotes PowerShell paths and honors a Windows engine root override', async ($, on) => {
  const { captureDir, dir, runs } = promptEngine(on, {
    platform: 'win32', tmpRoot: 'D:\\engine temp', env: { TEMP: "C:\\Users\\O'Brien\\Temp" },
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
  await $.prompt.submit(prompt('windows custom temp'))
  const ui = await $.ui.mount(message('windows custom temp'))
  expect(dir.startsWith('D:/engine temp/claude-0/')).toBe(true)
  expect(runs).toEqual([
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Directory -Force -LiteralPath '${captureDir.replace(/'/g, "''")}'`],
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Copy-Item -LiteralPath '${dir}/1.png' -Destination '${captureDir.replace(/'/g, "''")}/engine-sess1-1.png'`],
  ])
  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  await ui.unmount()
})

for (const fallback of ['posix-home', 'windows-tmp', 'windows-home']) {
  test(`uses the ${fallback} capture folder fallback`, async ($, on) => {
    const platform = fallback === 'posix-home' ? 'linux' : 'win32'
    const { runs, captureDir } = promptEngine(on, { platform, env: { TMPDIR: '', TEMP: '', TMP: fallback === 'windows-tmp' ? 'D:/temp' : '' } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
    expect(captureDir).toBe(fallback === 'posix-home' ? `${HOME}/.cache/claude-prompt-images`
      : fallback === 'windows-tmp' ? 'D:/temp/claude-prompt-images' : 'C:/Users/me/AppData/Local/Temp/claude-prompt-images')
    expect(runs[runs.length - 1]).toEqual(platform === 'win32'
      ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Directory -Force -LiteralPath '${captureDir}'`]
      : ['mkdir', '-p', '-m', '700', captureDir])
  })
}
