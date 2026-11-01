import type { BuiltinToolResults, EngineInterface, PromptOrigin, Register } from 'claude-code'

type TOutput = BuiltinToolResults['SendUserFile']
type TReadOutput = BuiltinToolResults['Read']
type TAttachment = TOutput['attachments'][number]
type TSize = { width: number; height: number }
type TPicture = { size: TSize | null; png: string | null }

const SEND_MAX_COLUMNS = 80
const SEND_MAX_ROWS = 30
const READ_MAX_COLUMNS = 40
const READ_MAX_ROWS = 15
const READ_PATHS_LIMIT = 200
const MARGIN = 4
const CELL_RATIO = 2
const MAX_READ_BYTES = 4 * 1024 * 1024
const MAX_INLINE_BYTES = 2 * 1024 * 1024
const CACHE_LIMIT = 24
const FALLBACK_SIZE: TSize = { width: 1600, height: 1000 }

const pictures = new Map<string, TPicture>()
const readPaths = new Map<string, string>()

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const decodeBase64 = (text: string) => {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0

  for (const char of text) {
    const value = ALPHABET.indexOf(char)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }

  return new Uint8Array(bytes)
}

const pngSize = (base64: string): TSize | null => {
  const header = decodeBase64(base64.slice(0, 44))
  const isSignature = header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
  if (!isSignature) return null

  const view = new DataView(header.buffer)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const isDrawable = (file: TAttachment) =>
  file.isImage &&
  file.path.startsWith('/') &&
  /\.png$/i.test(file.path) &&
  file.pathValidated !== false

const hasError = (file: TAttachment) => Boolean(file.upload_error || file.partial_error)

const cacheKey = (file: TAttachment) => `${file.path}:${file.size}`

const remember = (key: string, picture: TPicture) => {
  pictures.delete(key)
  pictures.set(key, picture)
  if (pictures.size > CACHE_LIMIT) {
    const oldest = pictures.keys().next().value
    if (oldest !== undefined) pictures.delete(oldest)
  }
}

const fileUrl = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`

const boxFor = ({ width, height }: TSize, maxColumns: number, maxRows: number) => {
  let columns = Math.min(maxColumns, Math.max(1, Math.round(width / 10)))
  let rows = Math.max(1, Math.round((columns * height) / width / CELL_RATIO))

  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.round((rows * CELL_RATIO * width) / height))
  }

  return { columns: Math.min(columns, 255), rows: Math.min(rows, 255) }
}

type TReadImage = { base64: string; size: TSize; path?: string }

const readImage = (output: unknown, path?: string): TReadImage | null => {
  const read = output as TReadOutput | undefined
  if (!read || read.type !== 'image' || read.file.type !== 'image/png') return null

  const { base64, dimensions } = read.file
  if ((base64.length * 3) / 4 > MAX_INLINE_BYTES) return null

  const width = dimensions?.originalWidth ?? dimensions?.displayWidth
  const height = dimensions?.originalHeight ?? dimensions?.displayHeight
  const size = width && height ? { width, height } : pngSize(base64)

  return size ? { base64, size, path } : null
}

// ---- the person's own prompts ----
// `file` is the PNG the terminal draws; `source` is what the person named or
// pasted, linked below the picture. They differ when the source needed converting.
type TPromptPicture = { file: string; source: string; size: TSize; generation: number }
// The engine's own copies of a prompt's attachments, still to be read: the
// folder it writes them to and how many the prompt attached.
type TEngineImages = { dir: string; wanted: number }
type TPending = {
  text: string
  pictures: TPromptPicture[]
  at: number
  engine?: TEngineImages
  // A read of the engine's copies started at submit and not yet finished.
  resolving?: Promise<void>
}

const PROMPT_MAX_COLUMNS = 60
const PROMPT_MAX_ROWS = 20
const MAX_PATHS = 8
const PENDING_LIMIT = 20
const PENDING_TTL_MS = 2 * 60 * 1000
const ROWS_LIMIT = 200
const CAPTURE_FOLDER = 'claude-prompt-images'

// Prompts whose pictures are known but whose transcript row has not drawn yet.
const pending: TPending[] = []
// Transcript rows (by message id) that already matched a prompt.
const rows = new Map<string, TPromptPicture[]>()

let home = ''
let uid = ''
let captureDir = ''
let generation = 0

// Only the person's own prompts: typed here, or sent from Remote Control.
const isOwn = (origin: PromptOrigin) => origin.kind === 'composer' || origin.kind === 'bridge'
// The Mac clipboard belongs to a prompt typed at this terminal alone.
const isLocal = (origin: PromptOrigin) => origin.kind === 'composer'

const rememberPending = (entry: TPending) => {
  pending.push(entry)
  if (pending.length > PENDING_LIMIT) pending.shift()
}

const forgetPending = (entry: TPending) => {
  const index = pending.indexOf(entry)
  if (index >= 0) pending.splice(index, 1)
}

const claim = async ($: EngineInterface, requestId: string, text: string, now: number) => {
  const known = rows.get(requestId)
  if (known) return known

  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (now - (pending[index]?.at ?? now) > PENDING_TTL_MS) pending.splice(index, 1)
  }

  const index = pending.findIndex(entry => entry.text === text)
  const entry = pending[index]
  if (!entry) return null

  if (entry.resolving) await entry.resolving
  else if (entry.engine) await resolveEngineImages($, entry)
  // The engine's copies are not on disk yet: the row stays pending for a later redraw.
  if (entry.pictures.length === 0) return null

  pending.splice(index, 1)
  rows.set(requestId, entry.pictures)
  if (rows.size > ROWS_LIMIT) {
    const oldest = rows.keys().next().value
    if (oldest !== undefined) rows.delete(oldest)
  }

  return entry.pictures
}



// A string inside AppleScript double quotes.
const appleScriptString = (text: string) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

// Every still-image format `sips` turns into PNG; the terminal draws PNG alone.
const IMAGE_PATTERN = /\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i

// Absolute or ~/ paths ending in an image extension: quoted, backslash-escaped, or plain.
// A plain path starts the text or follows whitespace or an opener, so `src/logo.png`
// does not yield `/logo.png`.
const PATH_PATTERN =
  /"((?:\/|~\/)[^"\n]+?\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp))"|'((?:\/|~\/)[^'\n]+?\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp))'|(?<=^|[\s(\[,:=])((?:\/|~\/)(?:[^\s\\"']|\\ )+?\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp))(?=[\s,;:)\]]|$)/gim

// A pasted image the engine expanded with its source file.
const SOURCE_PATTERN = /\[Image: source: (\/[^\]\n]+?\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp))\]/gi

const isPng = (path: string) => /\.png$/i.test(path)

// A short stable name for a converted file: djb2 over the source path.
const hashOf = (text: string) => {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  return hash.toString(36)
}

export const pathsIn = (text: string, homeDir: string) => {
  const found = new Set<string>()

  for (const match of text.matchAll(SOURCE_PATTERN)) {
    if (match[1]) found.add(match[1])
  }

  for (const match of text.matchAll(PATH_PATTERN)) {
    const raw = match[1] ?? match[2] ?? match[3]
    if (!raw) continue
    const unescaped = raw.replace(/\\ /g, ' ')
    const absolute = unescaped.startsWith('~/') ? `${homeDir}${unescaped.slice(1)}` : unescaped
    if (absolute.startsWith('/') && !absolute.includes('/../')) found.add(absolute)
  }

  return [...found].slice(0, MAX_PATHS)
}

const sizeOf = async ($: EngineInterface, path: string): Promise<TSize> => {
  try {
    const { exitCode, stdout } = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path], {
      timeoutMs: 5000,
    })
    if (exitCode !== 0) return FALLBACK_SIZE
    const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1])
    const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1])
    return width > 0 && height > 0 ? { width, height } : FALLBACK_SIZE
  } catch {
    return FALLBACK_SIZE
  }
}

// A PNG copy of any other still image, kept in the capture folder and reused
// while the source is unchanged. Nothing without a capture folder.
const toPng = async ($: EngineInterface, source: string, generation: number): Promise<string | null> => {
  if (!captureDir) return null
  const target = `${captureDir}/conv-${hashOf(source)}-${generation}.png`
  try {
    if (await $.fs.exists(target)) return target
    const { exitCode } = await $.process.run(['sips', '-s', 'format', 'png', source, '--out', target], {
      timeoutMs: 15000,
    })
    if (exitCode !== 0) return null
    const stat = await $.fs.stat(target)
    return stat.kind === 'file' && stat.size > 0 ? target : null
  } catch {
    return null
  }
}

const pictureFor = async ($: EngineInterface, source: string): Promise<TPromptPicture | null> => {
  try {
    const stat = await $.fs.stat(source)
    if (stat.kind !== 'file' || stat.size === 0) return null
    const generation = Math.round(stat.mtimeMs)
    const file = isPng(source) ? source : await toPng($, source, generation)
    if (!file) return null
    return { file, source, size: await sizeOf($, file), generation }
  } catch {
    return null
  }
}

// The clipboard's image written to `target` as `expression` names it
// (`«class PNGf»`, `TIFF picture`): the path when bytes landed, else null.
const writeClipboard = async ($: EngineInterface, target: string, expression: string): Promise<string | null> => {
  try {
    const { exitCode } = await $.process.run(
      [
        'osascript',
        '-e', `set f to open for access POSIX file "${appleScriptString(target)}" with write permission`,
        '-e', 'try',
        '-e', `write (the clipboard as ${expression}) to f`,
        '-e', 'end try',
        '-e', 'close access f',
      ],
      { timeoutMs: 10000 },
    )
    if (exitCode === 0) {
      const stat = await $.fs.stat(target)
      if (stat.size > 0) return target
    }
  } catch {
    // fall through to the cleanup
  }
  await $.process.run(['rm', '-f', target], { timeoutMs: 5000 }).catch(() => null)
  return null
}

const baseName = (path: string) => path.split('/').pop() ?? path

// The image file the clipboard points at (screenshot tools and Finder copies
// carry one), or null when it holds text, bytes alone, or nothing.
const clipboardFile = async ($: EngineInterface): Promise<string | null> => {
  try {
    const asFile = await $.process.run(
      ['osascript', '-e', 'POSIX path of (the clipboard as «class furl»)'],
      { timeoutMs: 5000 },
    )
    // A text clipboard comes back as that text with exit 0: insist on an image file.
    const filePath = asFile.stdout.trim()
    if (asFile.exitCode === 0 && filePath.startsWith('/') && IMAGE_PATTERN.test(filePath)) {
      const stat = await $.fs.stat(filePath).catch(() => null)
      if (stat?.kind === 'file') return filePath
    }
  } catch {
    // no file on the clipboard
  }
  return null
}

// The clipboard's image bytes written to a private file of our own: PNG where
// the tool offers it, else the TIFF every macOS image copy carries.
const clipboardBytes = async ($: EngineInterface): Promise<string | null> => {
  if (!captureDir) return null
  generation += 1
  const stem = `${captureDir}/paste-${Date.now()}-${generation}`
  const png = await writeClipboard($, `${stem}.png`, '«class PNGf»')
  if (png) return png
  return writeClipboard($, `${stem}.tiff`, 'TIFF picture')
}

// A dropped file by the name the engine kept for it: Spotlight's matches with
// exactly that name, the most recently modified one. A drop never touches the
// clipboard, so the clipboard is no witness to it.
const locateByName = async ($: EngineInterface, filename: string): Promise<string | null> => {
  if (filename.includes('/') || !IMAGE_PATTERN.test(filename)) return null
  try {
    const { exitCode, stdout } = await $.process.run(['mdfind', '-name', filename], { timeoutMs: 5000 })
    if (exitCode !== 0) return null
    const matches = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('/') && baseName(line) === filename)
      .slice(0, 20)
    let best: { path: string; mtimeMs: number } | null = null
    for (const path of matches) {
      const stat = await $.fs.stat(path).catch(() => null)
      if (stat?.kind === 'file' && stat.size > 0 && (!best || stat.mtimeMs > best.mtimeMs))
        best = { path, mtimeMs: stat.mtimeMs }
    }
    return best?.path ?? null
  } catch {
    return null
  }
}

// Where the engine writes its own copy of each attachment, numbered in order:
// /private/tmp/claude-<uid>/<cwd with every slash a dash>/<session id>/images.
// These are what the model receives, whatever the clipboard holds.
const engineImagesDir = async ($: EngineInterface): Promise<string | null> => {
  if (!uid) return null
  try {
    const [id, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
    if (!id || !cwd.startsWith('/')) return null
    return `/private/tmp/claude-${uid}/${cwd.replace(/\//g, '-')}/${id}/images`
  } catch {
    return null
  }
}

// The image files in that folder, in the engine's numbering order.
const engineImages = async ($: EngineInterface, dir: string): Promise<string[]> => {
  try {
    const entries = await $.fs.list(dir)
    return entries
      .filter(entry => entry.kind === 'file' && entry.size > 0 && IMAGE_PATTERN.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b))
  } catch {
    return []
  }
}

// Engine copies already drawn for an earlier prompt, by full path.
const CLAIMED_LIMIT = 400
const claimedEngineFiles = new Set<string>()

// Reads the copies the engine wrote for a pending prompt. The engine writes a
// copy the moment an image is pasted, before the prompt is submitted, so the
// newest files not yet drawn for an earlier prompt are this one's: the last
// `wanted` of them. Nothing there yet leaves the entry waiting for a later redraw.
const resolveEngineImages = async ($: EngineInterface, entry: TPending) => {
  const engine = entry.engine
  if (!engine) return
  const names = await engineImages($, engine.dir)
  const fresh = names.filter(name => !claimedEngineFiles.has(`${engine.dir}/${name}`)).slice(-engine.wanted)
  if (fresh.length === 0) return

  for (const name of fresh) {
    const path = `${engine.dir}/${name}`
    claimedEngineFiles.add(path)
    if (claimedEngineFiles.size > CLAIMED_LIMIT) {
      const oldest = claimedEngineFiles.values().next().value
      if (oldest !== undefined) claimedEngineFiles.delete(oldest)
    }
    const picture = await pictureFor($, path)
    if (picture && !entry.pictures.some(known => known.source === picture.source)) entry.pictures.push(picture)
  }
  entry.engine = undefined
}

// A private folder under the user's own temp dir; yesterday's captures go.
const prepareCaptureDir = async ($: EngineInterface) => {
  try {
    const { exitCode, stdout } = await $.process.run(
      ['sh', '-c', 'printf "%s\\n%s\\n%s" "$HOME" "${TMPDIR:-}" "$(id -u)"'],
      { timeoutMs: 5000 },
    )
    if (exitCode !== 0) return
    const [homeDir = '', tmpDir = '', userId = ''] = stdout.split('\n')
    home = homeDir.trim()
    uid = /^\d+$/.test(userId.trim()) ? userId.trim() : ''
    const base = tmpDir.trim().replace(/\/$/, '') || (home ? `${home}/.cache` : '')
    if (!base) return
    const dir = `${base}/${CAPTURE_FOLDER}`
    const made = await $.process.run(['mkdir', '-p', '-m', '700', dir], { timeoutMs: 5000 })
    if (made.exitCode !== 0) return
    captureDir = dir
    await $.process.run(
      ['find', dir, '-maxdepth', '1', '-type', 'f', '(', '-name', 'paste-*', '-o', '-name', 'conv-*', ')', '-mtime', '+1', '-delete'],
      { timeoutMs: 10000 },
    )
  } catch {
    captureDir = ''
  }
}

export const register: Register = on => {
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded) return next(e)

    const images = e.props.calls.flatMap(call => {
      if (call.tool !== 'Read' || call.isRunning || call.isErrored || call.isInterrupted) return []
      const path = (call.input as { file_path?: string } | undefined)?.file_path
      const image = readImage(call.output, path)
      return image ? [image] : []
    })
    if (images.length === 0) return next(e)

    const line = await next(e)
    const viewportColumns = e.viewport?.columns ?? READ_MAX_COLUMNS + MARGIN
    const maxColumns = Math.max(10, Math.min(READ_MAX_COLUMNS, viewportColumns - MARGIN))
    const { Box, Text, Image, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1}>
        {line}
        {images.map((image, index) => {
          const box = boxFor(image.size, maxColumns, READ_MAX_ROWS)
          const name = image.path?.split('/').pop() ?? 'image.png'

          return (
            <Box key={`${index}:${image.path ?? ''}`} flexDirection="column" gap={1} marginLeft={2}>
              <Image source={{ png: image.base64 }} columns={box.columns} rows={box.rows} alt={`[image] ${name}`} />
              {image.path ? (
                <Text dimColor>
                  <Link href={fileUrl(image.path)} label={image.path} />
                </Text>
              ) : null}
            </Box>
          )
        })}
      </Box>
    )
  })

  on('tool.call', { tool: 'Read' }, ($, e, next) => {
    readPaths.set(e.tool_use_id, e.file_path)
    if (readPaths.size > READ_PATHS_LIMIT) {
      const oldest = readPaths.keys().next().value
      if (oldest !== undefined) readPaths.delete(oldest)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.tool !== 'Read' || e.props.isErrored) {
      return next(e)
    }

    const image = readImage(e.props.output, readPaths.get(e.props.tool_use_id))
    if (!image) return next(e)

    const viewportColumns = e.viewport?.columns ?? READ_MAX_COLUMNS + MARGIN
    const maxColumns = Math.max(10, Math.min(READ_MAX_COLUMNS, viewportColumns - MARGIN))
    const box = boxFor(image.size, maxColumns, READ_MAX_ROWS)
    const path = image.path
    const name = path?.split('/').pop() ?? 'image.png'
    const { Box, Text, Image, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1} marginBottom={1}>
        <Image source={{ png: image.base64 }} columns={box.columns} rows={box.rows} alt={`[image] ${name}`} />
        {path ? (
          <Text dimColor>
            <Link href={fileUrl(path)} label={path} />
          </Text>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.tool !== 'SendUserFile' || e.props.isErrored) {
      return next(e)
    }

    const output = e.props.output as TOutput | undefined
    const attachments = output?.attachments ?? []
    if (!output || output.display === 'attach' || attachments.some(hasError)) return next(e)

    const images = attachments.filter(isDrawable)
    if (images.length === 0) return next(e)

    for (const image of images) {
      const key = cacheKey(image)
      if (pictures.has(key)) continue

      const original = image.scaled
        ? { width: image.scaled.original_width, height: image.scaled.original_height }
        : null

      if (image.size > MAX_READ_BYTES) {
        remember(key, { size: original, png: null })
        continue
      }

      try {
        const { base64 } = await $.fs.read(image.path, { as: 'bytes' })
        const size = pngSize(base64)
        const png = size && image.size <= MAX_INLINE_BYTES ? base64 : null
        remember(key, { size: size ?? original, png })
      } catch {
        remember(key, { size: original, png: null })
      }
    }

    const viewportColumns = e.viewport?.columns ?? SEND_MAX_COLUMNS + MARGIN
    const maxColumns = Math.max(10, Math.min(SEND_MAX_COLUMNS, viewportColumns - MARGIN))
    const others = attachments.filter(file => !images.includes(file))
    const { Box, Text, Image, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1} marginTop={1} marginBottom={1}>
        {output.caption ? <Text dimColor>{output.caption}</Text> : null}
        {images.map(image => {
          const picture = pictures.get(cacheKey(image))
          const box = boxFor(picture?.size ?? FALLBACK_SIZE, maxColumns, SEND_MAX_ROWS)
          const name = image.path.split('/').pop() ?? image.path

          return (
            <Box key={image.path} flexDirection="column" gap={1}>
              <Image
                source={
                  picture?.png
                    ? { png: picture.png }
                    : { file: image.path, format: 'png', generation: image.size }
                }
                columns={box.columns}
                rows={box.rows}
                alt={`[image] ${name}`}
              />
              <Text dimColor>
                <Link href={fileUrl(image.path)} label={image.path} />
              </Text>
            </Box>
          )
        })}
        {others.map(file => (
          <Text key={file.path} dimColor>
            {file.path}
          </Text>
        ))}
      </Box>
    )
  })

  // ---- the person's own prompts ----
  on('session.start', async ($, e, next) => {
    await prepareCaptureDir($)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || !isOwn(e.origin)) return next(e)

    const paths = pathsIn(e.text, home)
    const images = (e.attachments ?? []).filter(item => item.type === 'image')
    const pictures = (await Promise.all(paths.map(path => pictureFor($, path)))).filter(
      (picture): picture is TPromptPicture => picture !== null,
    )

    // Attachments beyond the paths named, for a prompt typed at this terminal.
    // One the engine kept a file name for was dropped or pasted as a file: it is
    // the clipboard's file only when the names agree, else Spotlight finds it by
    // name. One without a name came as bytes, and only the clipboard has those;
    // at most one such paste is recoverable.
    const extra = images.slice(paths.length)
    let engine: TEngineImages | undefined
    const engineDir = extra.length > 0 && isOwn(e.origin) ? await engineImagesDir($) : null
    if (engineDir) {
      // The engine writes its own copy of each attachment as it is pasted: the
      // newest copies not drawn for an earlier prompt are this one's.
      engine = { dir: engineDir, wanted: extra.length }
    } else if (extra.length > 0 && isLocal(e.origin)) {
      const seen = new Set(pictures.map(picture => picture.source))
      const add = async (source: string) => {
        const picture = await pictureFor($, source)
        if (picture && !seen.has(picture.source)) {
          seen.add(picture.source)
          pictures.push(picture)
        }
      }
      const onClipboard = await clipboardFile($)
      let unnamed = 0
      for (const item of extra) {
        if (!item.filename) {
          unnamed += 1
          continue
        }
        const found =
          onClipboard && baseName(onClipboard) === item.filename ? onClipboard : await locateByName($, item.filename)
        if (found) await add(found)
      }
      if (unnamed > 0) {
        const captured = onClipboard ?? (await clipboardBytes($))
        if (captured) await add(captured)
      }
    }

    if (pictures.length === 0 && !engine) return next(e)

    const entry: TPending = { text: e.text, pictures, at: await $.clock.now(), engine }
    // Read off the submit path: the row's first draw waits for this read, and a
    // copy still being written is read at a later redraw.
    if (entry.engine) {
      entry.resolving = resolveEngineImages($, entry)
        .catch(() => undefined)
        .finally(() => {
          entry.resolving = undefined
        })
    }
    rememberPending(entry)
    const entered = await next(e)
    if (entered.drop !== undefined) forgetPending(entry)

    return entered
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !isOwn(e.props.origin)) return next(e)
    // Most rows have no picture waiting: no clock hop for them.
    if (!rows.has(e.requestId) && pending.length === 0) return next(e)

    const pictures = await claim($, e.requestId, e.props.text, await $.clock.now())
    if (!pictures || pictures.length === 0) return next(e)

    const line = await next(e)
    const viewportColumns = e.viewport?.columns ?? PROMPT_MAX_COLUMNS + MARGIN
    const maxColumns = Math.max(10, Math.min(PROMPT_MAX_COLUMNS, viewportColumns - MARGIN))
    const { Box, Text, Image, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1}>
        {line}
        {pictures.map(picture => {
          const box = boxFor(picture.size, maxColumns, PROMPT_MAX_ROWS)
          const name = picture.source.split('/').pop() ?? 'image.png'

          return (
            <Box key={picture.source} flexDirection="column" gap={1} marginLeft={2}>
              <Image
                source={{ file: picture.file, format: 'png', generation: picture.generation }}
                columns={box.columns}
                rows={box.rows}
                alt={`[image] ${name}`}
              />
              <Text dimColor>
                <Link href={fileUrl(picture.source)} label={picture.source} />
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
