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
