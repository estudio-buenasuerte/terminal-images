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
const MAX_INLINE_BYTES = 2 * 1024 * 1024
const CACHE_LIMIT = 24
const FALLBACK_SIZE: TSize = { width: 1600, height: 1000 }

const pictures = new Map<string, TPicture>()
const readPaths = new Map<string, string>()

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Reject malformed bytes so a bad image cannot break a transcript redraw.
const decodeBase64 = (text: string) => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) return new Uint8Array()
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

// Only a complete PNG header supplies usable dimensions for an inline picture.
export const pngSize = (base64: string): TSize | null => {
  const header = decodeBase64(base64.slice(0, 44))
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (header.length < 24 || !signature.every((byte, index) => header[index] === byte)) return null

  const view = new DataView(header.buffer)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

// Padding is not decoded data and must not push an exact-limit PNG over budget.
const pngBytes = (base64: string) =>
  (base64.length * 3) / 4 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)

// Accept the absolute paths supplied by either POSIX or Windows engines.
const isAbsolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

// Forward slashes let the filesystem API read Windows paths consistently.
const normalizePath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) ? path.replace(/\\/g, '/') : path

// Both platforms' separators can occur in attachment names.
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

const isDrawable = (file: TAttachment) =>
  file.isImage &&
  isAbsolute(file.path) &&
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

// Preserve a Windows drive colon while encoding names for clickable local links.
export const fileUrl = (path: string) => {
  const normalized = normalizePath(path)
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized.slice(0, 2)}${normalized.slice(2).split('/').map(encodeURIComponent).join('/')}`
  }
  return `file://${normalized.split('/').map(encodeURIComponent).join('/')}`
}

const boxFor = ({ width, height }: TSize, maxColumns: number, maxRows: number) => {
  let columns = Math.min(maxColumns, Math.max(1, Math.round(width / 10)))
  let rows = Math.max(1, Math.round((columns * height) / width / CELL_RATIO))

  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.round((rows * CELL_RATIO * width) / height))
  }

  return { columns: Math.min(columns, 255), rows: Math.min(rows, 255) }
}

type TReadImage = { base64: string | null; size: TSize; bytes: number; path?: string }

// Keep a known path even when its bytes cannot be drawn, so the row can link it.
const readImage = (output: unknown, path?: string): TReadImage | null => {
  const read = output as TReadOutput | undefined
  if (!read || read.type !== 'image' || read.file.type !== 'image/png') return null

  const { base64, dimensions } = read.file
  const bytes = pngBytes(base64)
  const header = pngSize(base64)
  const width = dimensions?.originalWidth ?? dimensions?.displayWidth
  const height = dimensions?.originalHeight ?? dimensions?.displayHeight
  const size = header && width && height ? { width, height } : header
  const inline = size !== null && bytes <= MAX_INLINE_BYTES
  if (!inline && !path) return null

  return { base64: inline ? base64 : null, size: size ?? FALLBACK_SIZE, bytes, path }
}

// ---- the person's own prompts ----
// `file` is the PNG the terminal draws; `source` is what the person named or
// pasted, linked below the picture. They differ when the source needed converting.
type TPromptPicture = { file: string; source: string; size: TSize | null; bytes: number; generation: number }
// The engine's own copies of a prompt's attachments, still to be read: the
// folder it writes them to and how many the prompt attached.
type TEngineImages = { dir: string; wanted: number; resolved: number }
type TPending = {
  text: string
  pictures: TPromptPicture[]
  at: number
  engine?: TEngineImages
  // File resolution started at submit and not yet finished.
  resolving?: Promise<void>
}

const PROMPT_MAX_COLUMNS = 60
const PROMPT_MAX_ROWS = 20
const MAX_PATHS = 8
const PENDING_LIMIT = 20
const PENDING_TTL_MS = 2 * 60 * 1000
const ROWS_LIMIT = 200
const CAPTURE_FOLDER = 'claude-prompt-images'
const CWD_SLUG_LIMIT = 200

// Rows retain paths alone so old transcript pictures do not retain megabytes of bytes.
const promptPngs = new Map<string, string>()

// Cache each file version separately so an overwrite cannot reuse stale bytes.
const promptPng = async ($: EngineInterface, file: string, generation: number): Promise<string | null> => {
  if (!isPng(file)) return null
  const key = `${file}:${generation}`
  try {
    const cached = promptPngs.get(key)
    const base64 = cached ?? (await $.fs.read(file, { as: 'bytes' })).base64
    if (!pngSize(base64)) return null
    promptPngs.delete(key)
    promptPngs.set(key, base64)
    if (promptPngs.size > CACHE_LIMIT) {
      const oldest = promptPngs.keys().next().value
      if (oldest !== undefined) promptPngs.delete(oldest)
    }
    return base64
  } catch {
    return null
  }
}

// Prompts whose pictures are known but whose transcript row has not drawn yet.
const pending: TPending[] = []
// Transcript rows (by message id) that already matched a prompt.
const rows = new Map<string, TPromptPicture[]>()
// The same pictures by prompt text: the engine can draw a prompt's row again
// under another message id, and that draw has no pending entry left to match.
const claimedByText = new Map<string, TPromptPicture[]>()

const rememberRow = (requestId: string, text: string, pictures: TPromptPicture[]) => {
  rows.set(requestId, pictures)
  if (rows.size > ROWS_LIMIT) {
    const oldest = rows.keys().next().value
    if (oldest !== undefined) rows.delete(oldest)
  }
  claimedByText.delete(text)
  claimedByText.set(text, pictures)
  if (claimedByText.size > ROWS_LIMIT) {
    const oldest = claimedByText.keys().next().value
    if (oldest !== undefined) claimedByText.delete(oldest)
  }
}

let home = ''
let uid = ''
let captureDir = ''
let platform: 'darwin' | 'linux' | 'win32' = 'darwin'
let engineRoot = ''
let converter: Promise<keyof typeof CONVERTERS | null> | undefined

// Only the person's own prompts: typed here, or sent from Remote Control.
const isOwn = (origin: PromptOrigin) => origin.kind === 'composer' || origin.kind === 'bridge'

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
  if (known && !pending.some(entry => entry.text === text)) return known

  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (now - (pending[index]?.at ?? now) > PENDING_TTL_MS) pending.splice(index, 1)
  }

  const index = pending.findIndex(entry => entry.text === text)
  const entry = pending[index]
  if (!entry) {
    const drawn = claimedByText.get(text)
    if (drawn) rememberRow(requestId, text, drawn)
    return drawn ?? null
  }

  if (entry.resolving) await entry.resolving
  else if (entry.engine) {
    entry.resolving = resolveEngineImages($, entry).finally(() => {
      entry.resolving = undefined
    })
    await entry.resolving
  }
  // The engine's copies are not on disk yet: the row stays pending for a later redraw.
  if (entry.pictures.length === 0) return null

  if (!entry.engine) forgetPending(entry)
  rememberRow(requestId, text, entry.pictures)

  return entry.pictures
}



// Only still-image formats can be converted for the terminal's PNG element.
const IMAGE_PATTERN = /\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i

// Absolute or ~/ paths ending in an image extension: quoted, backslash-escaped, or plain.
// A plain path starts the text or follows whitespace or an opener, so `src/logo.png`
// does not yield `/logo.png`.
const PATH_PATTERN =
  /"((?:[A-Za-z]:[\\/]|\/|~\/)[^"\n]+?\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp))"|'((?:[A-Za-z]:[\\/]|\/|~\/)[^'\n]+?\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp))'|(?<=^|[\s([,:=])((?:[A-Za-z]:[\\/]|\/|~\/)(?:[^\s"']|\\ )+?\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp))(?=[\s,;:)\]]|$)/gim

// A pasted image the engine expanded with its source file.
const SOURCE_PATTERN = /\[Image: source: ((?:[A-Za-z]:[\\/]|\/)[^\]\n]+?\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp))\]/gi

const isPng = (path: string) => /\.png$/i.test(path)

// A short stable name for a converted file: djb2 over the source path.
const hashOf = (text: string) => {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  return hash.toString(36)
}

export const pathsIn = (text: string, homeDir: string, pathPlatform = platform) => {
  const found = new Set<string>()

  for (const match of text.matchAll(SOURCE_PATTERN)) {
    if (match[1]) found.add(normalizePath(match[1]))
  }

  for (const match of text.matchAll(PATH_PATTERN)) {
    const raw = match[1] ?? match[2] ?? match[3]
    if (!raw) continue
    if (pathPlatform !== 'win32' && !/^[A-Za-z]:[\\/]/.test(raw) && match[3] && /\\(?! )/.test(raw)) continue
    const unescaped = pathPlatform === 'win32' || /^[A-Za-z]:[\\/]/.test(raw) ? raw : raw.replace(/\\ /g, ' ')
    const absolute = normalizePath(unescaped.startsWith('~/') ? `${homeDir}${unescaped.slice(1)}` : unescaped)
    if (pathPlatform === 'win32' && match[3]?.includes('\\ ')) continue
    if (isAbsolute(absolute) && !absolute.includes('/../')) found.add(absolute)
  }

  return [...found].slice(0, MAX_PATHS)
}

// Keep each supported converter's argv together so no conversion needs a shell.
const CONVERTERS = {
  sips: (source: string, target: string) => ['sips', '-s', 'format', 'png', source, '--out', target],
  magick: (source: string, target: string) => ['magick', source, target],
  convert: (source: string, target: string) => ['convert', source, target],
  ffmpeg: (source: string, target: string) => ['ffmpeg', '-y', '-i', source, '-frames:v', '1', target],
}

// Share even an unsuccessful probe across all non-PNG images in a session.
const converterFor = ($: EngineInterface) => converter ??= (async () => {
  if (platform === 'darwin') return 'sips' as const
  for (const tool of ['magick', 'convert', 'ffmpeg'] as const) {
    try {
      const { exitCode } = await $.process.run([tool, '-version'], { timeoutMs: 5000 })
      if (exitCode === 0) return tool
    } catch {
      // A missing executable leaves the next converter available to try.
    }
  }
  return null
})()

// A PNG copy of any other still image, kept in the capture folder and reused
// while the source is unchanged. Nothing without a capture folder.
const toPng = async ($: EngineInterface, source: string, generation: number): Promise<string | null> => {
  if (!captureDir) return null
  const target = `${captureDir}/conv-${hashOf(source)}-${generation}.png`
  try {
    if (await $.fs.exists(target)) return target
    const tool = await converterFor($)
    if (!tool) return null
    const { exitCode } = await $.process.run(CONVERTERS[tool](source, target), {
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
    if (stat.kind !== 'file') return null
    const generation = stat.mtimeMs
    const file = isPng(source) ? source : (await toPng($, source, generation)) ?? source
    const bytes = file === source ? stat.size : (await $.fs.stat(file)).size
    const png = bytes <= MAX_INLINE_BYTES ? await promptPng($, file, generation) : null
    const size = png ? pngSize(png) : null
    return { file, source, size, bytes, generation }
  } catch {
    return null
  }
}

export const cwdSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, CWD_SLUG_LIMIT)

// Verify the engine's copy folder before keeping a prompt waiting for files.
const engineImagesDir = async ($: EngineInterface): Promise<string | null> => {
  if (!uid) return null
  try {
    const [id, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
    if (!id || !isAbsolute(cwd)) return null
    const dir = `${engineRoot}/claude-${uid}`
    const slug = cwdSlug(cwd)
    if (cwd.length <= CWD_SLUG_LIMIT) {
      const images = `${dir}/${slug}/${id}/images`
      return await $.fs.exists(images) ? images : null
    }

    // The engine appends a hash we cannot compute to a truncated slug.
    const entries = await $.fs.list(dir)
    for (const entry of entries) {
      if (entry.kind !== 'dir' || !entry.name.startsWith(slug)) continue
      const images = `${dir}/${entry.name}/${id}/images`
      if (await $.fs.exists(images)) return images
    }
    return null
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
  if (!engine || !captureDir) return
  const names = await engineImages($, engine.dir)
  const fresh = names
    .filter(name => !claimedEngineFiles.has(`${engine.dir}/${name}`))
    .slice(-(engine.wanted - engine.resolved))
  if (fresh.length === 0) return

  try {
    const id = await $.session.id()
    if (!id) return
    for (const name of fresh) {
      const path = `${engine.dir}/${name}`
      const target = `${captureDir}/engine-${id}-${name}`
      const { exitCode } = await copyFile($, path, target)
      if (exitCode !== 0) continue
      const picture = await pictureFor($, target)
      if (!picture) continue
      engine.resolved += 1
      claimedEngineFiles.add(path)
      if (claimedEngineFiles.size > CLAIMED_LIMIT) {
        const oldest = claimedEngineFiles.values().next().value
        if (oldest !== undefined) claimedEngineFiles.delete(oldest)
      }
      if (!entry.pictures.some(known => known.source === picture.source)) entry.pictures.push(picture)
    }
    if (engine.resolved >= engine.wanted) entry.engine = undefined
  } catch {
    // a copy that failed stays pending for a later redraw
  }
}

// PowerShell literals keep spaces, quotes and metacharacters inside the path.
const psLiteral = (path: string) => `'${path.replace(/'/g, "''")}'`

// A whole PowerShell command is one argv element on Windows.
const powershell = (command: string) => ['powershell', '-NoProfile', '-NonInteractive', '-Command', command]

// The engine has no mkdir API, so use the platform's directory command.
const makeFolder = ($: EngineInterface, dir: string) => $.process.run(
  platform === 'win32'
    ? powershell(`New-Item -ItemType Directory -Force -LiteralPath ${psLiteral(dir)}`)
    : ['mkdir', '-p', '-m', '700', dir],
  { timeoutMs: 5000 },
)

// Image bytes need a process copy because the filesystem write API is text-only.
const copyFile = ($: EngineInterface, from: string, to: string) => $.process.run(
  platform === 'win32'
    ? powershell(`Copy-Item -LiteralPath ${psLiteral(from)} -Destination ${psLiteral(to)}`)
    : ['cp', from, to],
  { timeoutMs: 5000 },
)

// Delete only selected captures without depending on a filesystem delete API.
const deleteFile = ($: EngineInterface, path: string) => $.process.run(
  platform === 'win32'
    ? powershell(`Remove-Item -LiteralPath ${psLiteral(path)}`)
    : ['rm', '-f', path],
  { timeoutMs: 5000 },
)

// Bound cleanup to old capture files so startup cannot delete unrelated files or run indefinitely.
const pruneCaptures = async ($: EngineInterface) => {
  const cutoff = await $.clock.now() - 24 * 60 * 60 * 1000
  const entries = await $.fs.list(captureDir)
  const old = entries.filter(entry =>
    entry.kind === 'file' && /^(?:paste-|conv-|engine-)/.test(entry.name) && entry.mtimeMs < cutoff,
  ).slice(0, 200)
  for (const entry of old) {
    try {
      await deleteFile($, `${captureDir}/${entry.name}`)
    } catch {
      // A capture that disappeared or cannot be removed must not block the next one.
    }
  }
}

// Detect once at session start because the engine exposes no platform field.
const detectPlatform = async ($: EngineInterface, os: string | undefined, userProfile: string | undefined, homeDir: string | undefined) => {
  if (os === 'Windows_NT' || (userProfile && !homeDir)) return 'win32'
  try {
    const { exitCode, stdout } = await $.process.run(['uname', '-s'], { timeoutMs: 5000 })
    if (exitCode === 0 && stdout.trim() === 'Darwin') return 'darwin'
  } catch {
    // Linux is the fallback when uname is unavailable.
  }
  return 'linux'
}

// A private folder under the user's own temp dir retains captures for one day.
const prepareCaptureDir = async ($: EngineInterface) => {
  home = ''
  uid = ''
  captureDir = ''
  engineRoot = ''
  converter = undefined
  try {
    const [homeDir, tmpDir, temp, tmp, userProfile, os, engineTmp] = await Promise.all([
      $.env.get('HOME'),
      $.env.get('TMPDIR'),
      $.env.get('TEMP'),
      $.env.get('TMP'),
      $.env.get('USERPROFILE'),
      $.env.get('OS'),
      $.env.get('CLAUDE_CODE_TMPDIR'),
    ])
    platform = await detectPlatform($, os, userProfile, homeDir)
    home = normalizePath((platform === 'win32' ? userProfile : homeDir) || '')
    const base = normalizePath(platform === 'win32'
      ? temp || tmp || (home ? `${home}/AppData/Local/Temp` : '')
      : tmpDir || (home ? `${home}/.cache` : '')).replace(/\/$/, '')
    if (platform === 'win32') uid = '0'
    else {
      const { exitCode, stdout } = await $.process.run(['id', '-u'], { timeoutMs: 5000 })
      if (exitCode === 0 && /^\d+$/.test(stdout.trim())) uid = stdout.trim()
    }
    // The Windows engine is assumed to use %TEMP% as Node's temp dir; unverified on a real machine.
    engineRoot = normalizePath(engineTmp || (platform === 'darwin' ? '/private/tmp' : platform === 'linux' ? '/tmp' : base)).replace(/\/$/, '')
    if (!base) return
    const dir = `${base}/${CAPTURE_FOLDER}`
    const made = await makeFolder($, dir)
    if (made.exitCode !== 0) return
    captureDir = dir
    await pruneCaptures($)
  } catch {
    captureDir = ''
  }
}

export const register: Register = on => {
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded) return next(e)

    let remaining = MAX_INLINE_BYTES
    const images = e.props.calls.flatMap(call => {
      if (call.tool !== 'Read' || call.isRunning || call.isErrored || call.isInterrupted) return []
      const path = (call.input as { file_path?: string } | undefined)?.file_path
      const image = readImage(call.output, path)
      if (!image) return []
      const inline = image.base64 !== null && image.bytes <= remaining
      if (image.bytes > remaining) remaining = 0
      else if (inline) remaining -= image.bytes
      if (!inline && !path) return []
      return [{ ...image, base64: inline ? image.base64 : null }]
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
          const name = image.path ? baseName(image.path) : 'image.png'

          return (
            <Box key={`${index}:${image.path ?? ''}`} flexDirection="column" gap={1} marginLeft={2}>
              {image.base64 ? (
                <Image
                  key={image.path ?? 'read'}
                  source={{ png: image.base64 }}
                  columns={box.columns}
                  rows={box.rows}
                  alt={`[image] ${name}`}
                />
              ) : null}
              {image.path ? (
                <Text dimColor>
                  <Link key={image.path} href={fileUrl(image.path)} label={image.path} />
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
    const name = path ? baseName(path) : 'image.png'
    const { Box, Text, Image, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1} marginBottom={1}>
        {image.base64 ? (
          <Image
            key={path ?? 'read'}
            source={{ png: image.base64 }}
            columns={box.columns}
            rows={box.rows}
            alt={`[image] ${name}`}
          />
        ) : null}
        {path ? (
          <Text dimColor>
            <Link key={path} href={fileUrl(path)} label={path} />
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

      if (image.size > MAX_INLINE_BYTES) {
        remember(key, { size: original, png: null })
        continue
      }

      try {
        const { base64 } = await $.fs.read(normalizePath(image.path), { as: 'bytes' })
        const size = pngSize(base64)
        const png = size && pngBytes(base64) <= MAX_INLINE_BYTES ? base64 : null
        remember(key, { size: size ?? original, png })
      } catch {
        remember(key, { size: original, png: null })
      }
    }

    const viewportColumns = e.viewport?.columns ?? SEND_MAX_COLUMNS + MARGIN
    const maxColumns = Math.max(10, Math.min(SEND_MAX_COLUMNS, viewportColumns - MARGIN))
    let remaining = MAX_INLINE_BYTES
    const others = attachments.filter(file => !images.includes(file))
    const { Box, Text, Image, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1} marginTop={1} marginBottom={1}>
        {output.caption ? <Text dimColor>{output.caption}</Text> : null}
        {images.map(image => {
          const picture = pictures.get(cacheKey(image))
          const bytes = Math.max(image.size, picture?.png ? pngBytes(picture.png) : 0)
          const png = picture?.png && bytes <= remaining ? picture.png : null
          if (bytes > remaining) remaining = 0
          else if (png) remaining -= bytes
          const box = boxFor(picture?.size ?? FALLBACK_SIZE, maxColumns, SEND_MAX_ROWS)
          const name = baseName(image.path)

          return (
            <Box key={image.path} flexDirection="column" gap={1}>
              {png ? (
                <Image
                  key={image.path}
                  source={{ png }}
                  columns={box.columns}
                  rows={box.rows}
                  alt={`[image] ${name}`}
                />
              ) : null}
              <Text dimColor>
                <Link key={image.path} href={fileUrl(image.path)} label={image.path} />
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
    if (paths.length === 0 && images.length === 0) {
      claimedByText.delete(e.text)
      return next(e)
    }

    const entry: TPending = { text: e.text, pictures: [], at: await $.clock.now() }
    rememberPending(entry)
    // Let submit continue while paths convert and the engine's independent attachments resolve.
    entry.resolving = (async () => {
      const pictures = await Promise.all(paths.map(path => pictureFor($, path)))
      for (const picture of pictures) {
        if (picture && !entry.pictures.some(known => known.source === picture.source)) entry.pictures.push(picture)
      }
      const dir = images.length > 0 ? await engineImagesDir($) : null
      if (dir) {
        entry.engine = { dir, wanted: images.length, resolved: 0 }
        await resolveEngineImages($, entry)
      }
      if (entry.pictures.length === 0 && !entry.engine) {
        claimedByText.delete(e.text)
        forgetPending(entry)
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        entry.resolving = undefined
      })
    const entered = await next(e)
    if (entered.drop !== undefined) forgetPending(entry)

    return entered
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !isOwn(e.props.origin)) return next(e)
    // Most rows have no picture waiting: no clock hop for them.
    if (!rows.has(e.requestId) && pending.length === 0 && !claimedByText.has(e.props.text)) return next(e)

    const pictures = await claim($, e.requestId, e.props.text, await $.clock.now())
    if (!pictures || pictures.length === 0) return next(e)

    let remaining = MAX_INLINE_BYTES
    const drawn: { picture: TPromptPicture; png: string | null }[] = []
    for (const picture of pictures) {
      const inline = picture.bytes <= remaining
      const png = inline ? await promptPng($, picture.file, picture.generation) : null
      const bytes = Math.max(picture.bytes, png ? pngBytes(png) : 0)
      const fits = png !== null && bytes <= remaining
      if (png) remaining = fits ? remaining - bytes : 0
      else if (!inline) remaining = 0
      drawn.push({ picture, png: fits ? png : null })
    }

    const line = await next(e)
    const viewportColumns = e.viewport?.columns ?? PROMPT_MAX_COLUMNS + MARGIN
    const maxColumns = Math.max(10, Math.min(PROMPT_MAX_COLUMNS, viewportColumns - MARGIN))
    const { Box, Text, Image, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1}>
        {line}
        {drawn.map(({ picture, png }) => {
          const size = png ? picture.size ?? pngSize(png) : null
          const box = size ? boxFor(size, maxColumns, PROMPT_MAX_ROWS) : null
          const name = baseName(picture.source)

          return (
            <Box key={picture.source} flexDirection="column" gap={1} marginLeft={2}>
              {png && box ? (
                <Image
                  key={picture.source}
                  source={{ png }}
                  columns={box.columns}
                  rows={box.rows}
                  alt={`[image] ${name}`}
                />
              ) : null}
              <Text dimColor>
                <Link key={picture.source} href={fileUrl(picture.source)} label={picture.source} />
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
