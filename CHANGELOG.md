# Changelog

All notable changes to this project are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.3.0 (2026-11-05)

### Added

- A platform layer for darwin, linux and win32. Linux and Windows are untested.
- Marketplace packaging, install instructions and an MIT license for this mod.
- CI validation and the test kit on Ubuntu and macOS.

### Changed

- One 2 MiB byte budget per row everywhere.
- A clickable file link instead of a blank box where bytes cannot go.

### Removed

- Clipboard and Spotlight fallbacks.

## 0.2.0 (2026-11-01)

### Changed

- Prompt images are drawn from the engine's own copies.

## 0.1.0 (2026-10-27)

This release predates the git history. The date is the day the repo folder was created.

### Added

- A fork of [claude-inline-images](https://github.com/kbrianps/claude-inline-images) with prompt image drawing.
