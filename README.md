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

Pasted and dropped attachments are drawn from the engine's own copies, the numbered files Claude Code writes under `/private/tmp/claude-<uid>/<cwd>/<session>/images/` for the model. The engine writes one the moment an image is pasted, and the newest ones not yet drawn for an earlier prompt are that prompt's, so what is drawn is exactly what the model received, whatever the clipboard holds and whichever tool produced the image.

Only when that folder cannot be located does the mod fall back to the clipboard: an attachment with a file name is matched to the clipboard's file by name, else found by name with Spotlight; one without a name is read from the clipboard as the file it points to, else as PNG bytes, else as the TIFF every macOS image copy carries. At most one such paste per prompt.

Paths in the prompt text are drawn directly: absolute or `~/` paths ending in `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.heic`, `.heif`, `.tif`, `.tiff` or `.bmp`, plain, quoted or backslash-escaped, plus the `[Image: source: …]` marker the engine adds to a pasted image.

The terminal draws PNG alone, so any other format is converted with `sips` into a private folder under `TMPDIR` (`claude-prompt-images`, mode 700), reused while the source is unchanged and pruned after a day. Clipboard captures go to the same folder. The prompt part is macOS only: it shells out to `osascript`, `sips` and `mdfind`.

## What it does not do

- Read and SendUserFile images are PNG only, because the terminal image element takes PNG or raw pixels: a JPEG Claude reads keeps Claude Code's default line.
- PNGs over 2 MiB are drawn from the file path, which needs the terminal to read the file itself: it works in local Ghostty and kitty, not over SSH or inside tmux.
- When a group of reads is expanded (ctrl+o), Claude Code's own rows are shown.
- If you paste two images and remove one from the composer before sending, the newest file on disk may be the removed one, so the drawing can be off. The model still receives the right image.
- Desktop app, VS Code extension and mobile are left untouched.

## Development

```
claude plugin validate ~/.claude/skills/terminal-images
claude plugin test ~/.claude/skills/terminal-images
npx -p typescript tsc --noEmit -p ~/.claude/skills/terminal-images
```

The tests cover the Read, SendUserFile and grouped-Read rendering and the prompt path parsing. The engine-copy, clipboard and Spotlight paths need a live session.

The plugin API this mod uses is early access in Claude Code and may change between releases.

## Credits and license

MIT. The Read and SendUserFile rendering is taken from Brian Pravato's inline-images plugin ([kbrianps/claude-inline-images](https://github.com/kbrianps/claude-inline-images), MIT); its license is kept in `LICENSE.upstream`.
