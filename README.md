# terminal-images

A Claude Code mod that draws images inline in the terminal (Ghostty, kitty, tmux with passthrough) instead of a one-line `[image] file.png` or `[Image #1]` reference. Three cases:

- **Images Claude reads** with the Read tool show up small under the "Read N files" line.
- **Images Claude sends you** with SendUserFile (Remote Control sessions) show up large, caption above.
- **Images in your own prompts** show up under your `>` row: anything you paste or drop into the composer, from any screenshot tool or Finder, and any image path you type, quote or drag in.

Every image has its path below it as a link that opens the file in your image viewer.

## Install

The mod is loaded from this folder. Keep it under `~/.claude/skills/terminal-images` to have Claude Code load it in every session, or point one session at it:

```
claude --plugin-dir ~/.claude/skills/terminal-images
```

A `--plugin-dir` load reloads on edits and prints `terminal-images: reloaded` in the transcript. The `~/.claude/skills` load does not; start a new session after changing the code.

Requires Claude Code 2.1.287 or newer (mods support). Tested with 2.1.316.

## Terminals

| Terminal | Result |
| --- | --- |
| Ghostty | image |
| kitty | image |
| tmux with passthrough (see below) | image |
| iTerm2 3.5+ in fullscreen rendering | image, per the Claude Code docs (not tested) |
| tmux without passthrough, GNU screen | `[image] name.png` and the clickable path |
| GNOME Terminal, Ptyxis, VS Code terminal | `[image] name.png` and the clickable path |

The picture uses the kitty graphics protocol. Where the terminal cannot draw it, you get the file name and the path, never a broken box.

### tmux

Add to `~/.tmux.conf` and restart tmux:

```
set -g allow-passthrough on
set -g focus-events on
```

## How prompt images are found

Pasted and dropped images come only from the engine's own copies: the numbered files Claude Code writes under `<CLAUDE_CODE_TMPDIR or /private/tmp>/claude-<uid>/<slug>/<session>/images/`, where the slug replaces every character outside `[a-zA-Z0-9]` in the working directory with `-` and, above 200 characters, uses the first 200 followed by `-` and an engine hash. The engine's copies are copied into the mod's capture folder and drawn from PNG bytes up to 2 MiB total per row; after a picture would exceed that budget, it and the remaining pictures show only their clickable file links. The engine writes one the moment an image is pasted, and the newest ones not yet drawn for an earlier prompt are that prompt's, so what is drawn is exactly what the model received, whichever tool produced the image.

Paths in the prompt text are drawn directly: absolute or `~/` paths ending in `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.heic`, `.heif`, `.tif`, `.tiff` or `.bmp`, plain, quoted or backslash-escaped, plus the `[Image: source: …]` marker the engine adds to a pasted image.

A drawn row is remembered by its message id and by its text, so when the engine draws the same prompt again under another id (it does once the message is stored, and on later redraws) the pictures stay under it.

The terminal draws PNG alone, so any other format is converted with `sips` into a private folder under `TMPDIR` (`claude-prompt-images`, mode 700), reused while the source is unchanged and pruned after a day. The converter table uses `sips` on macOS as described above; Linux and Windows try ImageMagick 7 (`magick`), ImageMagick 6 (`convert`) and `ffmpeg` in that order, keeping the clickable source link if no converter is found or conversion fails.

## Platforms

- macOS: tested by Lucas. Uses `sips` and a private capture folder under `TMPDIR` (or `~/.cache`), mode 700; the default engine temp root is `/private/tmp`.
- Linux: untested (stub tests only). The default engine temp root is `/tmp`; capture files use `TMPDIR` or `~/.cache`.
- Windows: untested (stub tests only). The engine temp root is assumed to be Node's temp directory, `%TEMP%`; this is unverified on a real Windows machine. Capture files use `TEMP`, then `TMP`, then `%USERPROFILE%/AppData/Local/Temp`, and folder, copy and delete operations use PowerShell. The engine uses `claude-0` for its image folder.

Outside macOS, install ImageMagick (`magick` or `convert`) or `ffmpeg` to convert non-PNG prompt images. Without one, those images show their links; PNG images need no converter. `CLAUDE_CODE_TMPDIR` overrides the engine temp root on every platform.

If the engine does not detect your terminal's image support, set `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` as an escape hatch.

## Known limits

- Two prompt rows with identical text can be matched to the same pictures: the engine gives mods no per-prompt identity that survives redraws.
- A picture over 2 MiB, over the 2 MiB per-row budget, unreadable, or with an invalid PNG header shows only its clickable file path instead of a picture.

## What it does not do

- Read and SendUserFile images are PNG only, because the terminal image element takes PNG or raw pixels: a JPEG Claude reads keeps Claude Code's default line.
- When a group of reads is expanded (ctrl+o), Claude Code's own rows are shown.
- If you paste two images and remove one from the composer before sending, the newest file on disk may be the removed one, so the drawing can be off. The model still receives the right image.
- Desktop app, VS Code extension and mobile are left untouched.

## Development

```
claude plugin validate ~/.claude/skills/terminal-images
claude plugin test ~/.claude/skills/terminal-images
npx -p typescript tsc --noEmit -p ~/.claude/skills/terminal-images
```

The tests cover the Read, SendUserFile and grouped-Read rendering, prompt path parsing, and engine-copy prompt rendering and redraws.

The plugin API this mod uses is early access in Claude Code and may change between releases.

## Credits and license

MIT. The Read and SendUserFile rendering is taken from Brian Pravato's inline-images plugin ([kbrianps/claude-inline-images](https://github.com/kbrianps/claude-inline-images), MIT); its license is kept in `LICENSE.upstream`.
