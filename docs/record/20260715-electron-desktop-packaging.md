# Electron desktop packaging

The Windows desktop build keeps the React Dashboard as the Electron Renderer,
runs the Gateway in Electron Main, and launches one private compiled
`agent-cli.exe` over stdin/stdout JSON Lines.

## Managed build inputs

Run the build on Windows x64. PyInstaller and the managed native runtimes are
not cross-compiled from macOS or Linux.

Prepare the pinned private runtime with:

```powershell
bun run desktop:runtime:win
```

The first run downloads Node 22.22.2, Python 3.12.10, uv 0.11.19,
ripgrep 15.1.0, Playwright Chromium, and the pinned DingTalk/Lark npm packages.
Validated downloads and a complete runtime image are cached under
`build/desktop-runtime-cache/win32-x64`, so a later build can be reconstructed
offline:

```powershell
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File scripts/prepare-desktop-runtime.ps1 -Offline -Force
```

Set `LXE_DESKTOP_RUNTIME_ROOT` and `LXE_DESKTOP_CACHE_ROOT` to place the large
runtime and cache on another drive. Explicit `-RuntimeRoot` and `-CacheRoot`
parameters take precedence. The preparer never installs into system Node,
system Python, or the repository `.venv`.

The generated `build/desktop-runtime-inputs.json` supplies these resource
staging paths automatically:

- `LXE_DESKTOP_NODE_ROOT`: Node with `node.exe`, npm/npx, and the pinned DingTalk
  and Lark CLI packages.
- `LXE_DESKTOP_PYTHON_ROOT`: relocatable Python 3.12.10 distribution.
  Production dependencies are exported from `uv.lock` and installed into the
  private copy with user site-packages disabled.
- `LXE_DESKTOP_UV_PATH`: `uv.exe`.
- `LXE_DESKTOP_RG_PATH`: `rg.exe`.
- `LXE_DESKTOP_PLAYWRIGHT_ROOT`: Playwright Chromium browser directory.

These five environment variables remain supported as per-field overrides for
custom build infrastructure. `LXE_DESKTOP_RUNTIME_DESCRIPTOR` can point resource
staging at a non-default descriptor.

Then run:

```powershell
bun run desktop:dist:win
```

The command prepares or reuses the managed runtime, injects it only into the
build subprocess environment, rebuilds the Windows `lxeskill` bundle, compiles
`agent-cli.exe`, stages resources, and creates the NSIS installer.

`desktop:resources` fails closed when a required runtime is missing and writes a
SHA-256 manifest for every staged file. Only Git-tracked project resources are
copied, so local `.env`, authentication, sessions, and business artifacts cannot
leak into the installer.

Authenticode signing uses electron-builder's standard `CSC_LINK` and
`CSC_KEY_PASSWORD` environment variables. Unsigned output is intended only for
internal test machines.
