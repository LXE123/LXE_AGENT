# Third-Party Notices

## HarmonyOS Sans

LXE Agent uses an unmodified copy of HarmonyOS Sans SC as its primary user
interface font.

Copyright 2021 Huawei Device Co., Ltd.

HarmonyOS Sans Fonts Software is licensed under the HarmonyOS Sans Fonts
License Agreement. The complete agreement is distributed with the Dashboard at
`legal/HarmonyOS-Sans-LICENSE.txt`.

## openclaw-lark CardKit presentation

Portions of `apps/gateway/src/channels/feishu/card-builder.ts` and
`apps/gateway/src/channels/feishu/markdown-style.ts` are adapted from openclaw-lark,
commit `18c44168489246a2f8663f14e12923d6622ff10a`.

Copyright (c) 2026 Lark Technologies Pte. Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ripgrep

Windows x64 installations download the official ripgrep 15.1.0 executable from
the BurntSushi/ripgrep GitHub release and install it as a versioned sidecar at
`~/.lxe/tools/ripgrep/15.1.0/win32-x64/rg.exe`. The executable is not committed
to this repository and is not added to PATH.

ripgrep is dual-licensed under the Unlicense and MIT licenses. The installer
copies the upstream `LICENSE-MIT` and `UNLICENSE` files beside the executable.
Upstream source and release artifacts: https://github.com/BurntSushi/ripgrep

## ExifTool

Windows x64 installations include the official ExifTool 13.59 64-bit executable
distribution by Phil Harvey. macOS source development and Preview download the
official ExifTool 13.59 full Perl distribution into the ignored local build
cache. In both cases ExifTool is used internally to read, write, and verify
media metadata. LXE Agent does not expose ExifTool as a general-purpose
command-line interface.

Copyright 2003-2026 Phil Harvey.

ExifTool is free software distributed under the same terms as Perl itself: the
GNU General Public License version 1 or later, or the Artistic License. Project,
license, source, and release information: https://exiftool.org/

The Windows distribution's upstream `LICENSE` and
`Licenses_Strawberry_Perl.zip` files remain inside the packaged
`exiftool_files` directory, next to the executable and its bundled Perl runtime.
The macOS development cache keeps the upstream `exiftool` script and its `lib`
directory together, as required by the upstream portable installation layout.

## Amazon Operations Skills

Portions of the Amazon Operations analysis heuristics are adapted
from `amazon-listing-optimizer` 1.0.0 and `amazon-review-monitor` 1.0.0 by
avmw2025, distributed through ClawHub and the LinkFox skill marketplace.

The machine-readable `skill.json` identifies the license as MIT. The associated
`skill-card.md` identifies it as MIT-0; this discrepancy is retained here rather
than silently changing the publisher metadata. The LXE adaptation preserves
attribution and does not include the original marketplace metadata or reports.

Sources:

- https://clawhub.ai/avmw2025/amazon-listing-optimizer
- https://clawhub.ai/avmw2025/skills/amazon-review-monitor

Copyright (c) avmw2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## fd

LXE Agent distributes fd 10.5.0 in its Windows runtime and prepares the same
version for macOS development. Binaries are downloaded from the official
https://github.com/sharkdp/fd/releases/tag/v10.5.0 release during preparation,
with their archive checksums recorded in `config/desktop-runtime/fd.lock.json`.
fd is dual-licensed under MIT or Apache-2.0; this distribution uses the MIT license.

Copyright (c) 2017-present The fd developers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Office skills and LibreOffice Kit

The three `office-*` skills are adapted from
DeepSeek Harness, commit `639ed015397290b3745d163aafe02ffee4aa3f84`,
`packages/skill/skill-office/assets`. Copyright (c) 2026 DeepSeek.
The upstream MIT license is retained in each skill.
Source: https://github.com/deepseek-ai/deepseek-harness

LXE bundles `@deepseek-ai/libreoffice-kit` 0.1.5 and its version-matched native
engine (Windows x64 and macOS development 0.1.5). Kit and LibreOffice are
MPL-2.0; engine dependencies have their own notices. The complete upstream
`licenses/`, `sources/`, `prebuilds.json`, NOTICE files and program resources
remain under `runtime/office/node_modules/@deepseek-ai/` in the Windows app.
Source recipes identify the exact LibreOffice revision and patches; the package
source and license references are retained unchanged.
Package: https://www.npmjs.com/package/@deepseek-ai/libreoffice-kit
LibreOffice source: https://github.com/LibreOffice/core

Windows installations also include Microsoft's unmodified Visual C++ v14 x64
Redistributable, pinned by URL, version and SHA-256 in
`config/desktop-runtime/office/vc-redist.lock.json`. Microsoft license terms
are embedded in that installer. The application installs it locally if the
required runtime is absent or older; Office operations do not download it.
Source: https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist

Python Office dependencies include python-docx 1.2.0 (MIT), python-pptx 1.0.2
(MIT), lxml (BSD-3-Clause) and XlsxWriter (BSD-2-Clause). Their distribution
metadata and license files remain in the packaged Python site-packages.

## Desktop file previews

The spreadsheet parsers, read-only FortuneSheet/ExcelJS patches, read-only viewer
styles, zoom/paging behavior, and native file
association helpers and legacy Office test fixtures are adapted from DeepSeek Harness (MIT, Copyright 2026
DeepSeek). Source: https://github.com/deepseek-ai/deepseek-harness, revision
`639ed015397290b3745d163aafe02ffee4aa3f84`. The full MIT text ships at
`dashboard/legal/file-preview/DeepSeek-MIT.txt`. Patches are retained in `config/dependency-patches/`.

Pinned preview dependencies are FortuneSheet core/react 1.0.4 (MIT, Copyright
2022 Suzhou Ruilisi Technology Co., Ltd), ExcelJS 4.4.0 (MIT), SheetJS CE 0.20.3
(Apache-2.0), PapaParse 5.5.3 (MIT), fast-xml-parser 5.11.1 (MIT), fflate 0.8.3
(MIT) and PDF.js 6.3.289 (Apache-2.0). Their license texts ship in
`dashboard/legal/file-preview/`. FortuneSheet license source:
https://github.com/ruilisi/fortune-sheet/blob/v1.0.4/LICENSE.

PDF.js character maps, standard fonts, image-decoder WASM and their individual
licenses are retained together in `dashboard/preview-pdf/`. All preview workers
and resources are served from the packaged dashboard; no CDN is used.

## Composer references

The workspace file search and reference grammar, name ranking, inline reference
editing semantics, candidate menus, sent-message reference projection and explicit skill gesture
are adapted from DeepSeek Harness (MIT, Copyright 2026 DeepSeek), revision
`639ed015397290b3745d163aafe02ffee4aa3f84`:
`packages/context/file-reference-local`, `packages/client/ui-conversation`,
`packages/client/ui-primitives`, `packages/client/ui-input-trigger`,
`packages/client/ui-reference`, `packages/client/ui-theme`, `packages/client/ui-skill` and
`packages/skill/tool-skill`. Source: https://github.com/deepseek-ai/deepseek-harness.

The composer uses Lexical and its plain-text, history, text and utils modules
pinned to 0.49.0 (MIT, Copyright Meta Platforms, Inc. and affiliates).
Source: https://github.com/facebook/lexical/tree/v0.49.0.
Their full MIT texts ship in `dashboard/legal/composer/`. LXE keeps its existing
React 19 runtime and bundles all editor code locally.

## DeepSeek Harness Windows ACL sandbox

The Windows exec sandbox includes adapted code from DeepSeek Harness,
commit `639ed015397290b3745d163aafe02ffee4aa3f84`, copyright (c) 2026 DeepSeek,
licensed under MIT. The full license is retained in
`packages/agent/runtime/native/windows-sandbox/LICENSE` and distributed as
`runtime/exec-sandbox/DSH-LICENSE`. Koffi 3.1.1 and its license are distributed
with the native launcher dependencies.
