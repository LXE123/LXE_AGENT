# Electron desktop packaging

The Windows desktop build keeps the React Dashboard as the Electron Renderer,
runs the Gateway in Electron Main, and launches one private compiled
`agent-cli.exe` over stdin/stdout JSON Lines.

## Build inputs

Run the build on Windows x64. PyInstaller and the managed native runtimes are
not cross-compiled from macOS or Linux.

The resource staging command requires these local, pre-provisioned paths:

- `LXE_DESKTOP_NODE_ROOT`: Node with `node.exe`, npm/npx, and the pinned DingTalk
  and Lark CLI packages already installed.
- `LXE_DESKTOP_PYTHON_ROOT`: relocatable Python 3.12.10 distribution.
  It must include the pinned script dependencies (`openpyxl`, `pandas`, Pillow,
  and `requests`); resource staging imports them with user site-packages disabled.
- `LXE_DESKTOP_UV_PATH`: `uv.exe`.
- `LXE_DESKTOP_RG_PATH`: `rg.exe`.
- `LXE_DESKTOP_PLAYWRIGHT_ROOT`: Playwright Chromium browser directory.

Then run:

```powershell
bun run desktop:dist:win
```

The command rebuilds the Windows `lxeskill` bundle before compiling
`agent-cli.exe`, staging resources, and creating the NSIS installer.

`desktop:resources` fails closed when a required runtime is missing and writes a
SHA-256 manifest for every staged file. Only Git-tracked project resources are
copied, so local `.env`, authentication, sessions, and business artifacts cannot
leak into the installer.

Authenticode signing uses electron-builder's standard `CSC_LINK` and
`CSC_KEY_PASSWORD` environment variables. Unsigned output is intended only for
internal test machines.
