# Watson Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-built PCSX2 at the latest upstream tag, carrying the inherited DebugServer patch, that the Watson MCP server connects to and reads EE registers from.

**Architecture:** Watson merges the history of `hkmodd/PCSX2-MCP` and rearranges it into `Emulator/` (the C++ patch) and `Server/` (the TypeScript MCP bridge). `Emulator/Build.ps1` clones a pinned PCSX2 tag into the git-ignored `References/pcsx2`, drops the patch in, applies two hook edits, and builds with the Visual Studio generator. `Emulator/Run.ps1` launches that build against an isolated data directory in `Runtime/`.

**Tech Stack:** C++ (PCSX2 v2.9.94, MSVC, CMake "Visual Studio 18 2026"), TypeScript on Node 22.15+ (`@modelcontextprotocol/sdk`, `zod`), `node:test`, PowerShell 7.

**Spec:** `docs/superpowers/specs/2026-10-01-watson-design.md`

## Global Constraints

- Windows only. PowerShell 7 for scripts.
- Node 22.15 or newer.
- PCSX2 is never vendored. It lives in `References/pcsx2`, which is git-ignored.
- Pinned upstream: tag `v2.9.94`, commit `81526d4dc7cc70e4ae75abb35a789417456c6d43`.
- Watson is GPL-3.0. The SPDX header of `DebugServer.cpp` and `DebugServer.h` stays as found (`MIT`); the README records the discrepancy.
- The DebugServer listens on `127.0.0.1:21512`, loopback only.
- Watson's PCSX2 runs with `-datapath <Watson>/Runtime` and never with `-portable`. Portable mode takes priority over `-datapath` in PCSX2 and would write next to the executable.
- Tool names are prefixed `watson_`. No `pcsx2_*` or `ps2recomp_*` tool remains.
- No credit or attribution to an AI anywhere: commits, README, comments.
- Commit subject format: `Type(Scope): Imperative description`, at most 72 characters. Types: `Fix`, `Feat`, `Refactor`, `Build`, `Docs`. Scopes: `Emulator`, `Server`, `Project`.

## Review Focus

1. **Port 21512 already taken** (the old prebuilt hkmodd PCSX2 is still open). Expected: `Run.ps1` refuses to launch and says which process holds the port, instead of the smoke test silently talking to the wrong emulator. Pinned in Task 3.
2. **The emulator closes the socket while a request is pending.** Expected: the request rejects promptly with a message naming the closed connection, not a 10-second hang. Pinned in Task 1.
3. **A response arrives split across two TCP chunks.** Expected: one parsed reply. Pinned in Task 1.
4. **`Build.ps1` runs a second time on an already patched tree.** Expected: it detects the applied hooks and continues, instead of failing on `git apply`. Pinned in Task 2.
5. **A command arrives before any VM has booted.** Expected: `status` answers `alive: false`; PCSX2 does not crash. Pinned in Task 3.

---

## File Structure

| Path | Responsibility |
|---|---|
| `Emulator/DebugServer.cpp`, `Emulator/DebugServer.h` | The patch body, inherited. Runs inside PCSX2. |
| `Emulator/upstream.json` | The pinned PCSX2 tag, commit and dependency archive. |
| `Emulator/hooks.patch` | The edits to upstream files: two calls in `VMManager.cpp`, two lines in `pcsx2/CMakeLists.txt`. |
| `Emulator/MakeHooks.py` | Regenerates `hooks.patch` from a clean tree. Used when the pin moves. |
| `Emulator/Build.ps1` | Clone, dependencies, patch, configure, build. |
| `Emulator/Run.ps1` | Prepare `Runtime/` and launch the built PCSX2. |
| `Server/src/*.ts` | The MCP bridge, inherited: `index.ts`, `debug-server-client.ts`, `pine-client.ts`. |
| `Server/tests/client.test.mjs` | Client framing against a fake DebugServer. |
| `Server/tests/tools.test.mjs` | Tool names over real MCP stdio. |
| `Server/tests/live.test.mjs` | Live smoke against a running Watson PCSX2. Skips with a reason when none is listening. |
| `README.md` | What Watson is, credits, licensing note, how to build and run. |
| `docs/UPSTREAM-README.md` | The inherited README, kept for reference. |

---

### Task 1: Import the upstream fork and make the server Watson's

**Files:**
- Create: `Server/tests/client.test.mjs`, `Server/tests/tools.test.mjs`, `README.md`
- Move: `pcsx2-plugin/*` → `Emulator/`, `pcsx2-mcp-server/*` → `Server/`, inherited `README.md` → `docs/UPSTREAM-README.md`
- Modify: `.gitignore`, `Server/package.json`, `Server/src/index.ts`, `Server/src/debug-server-client.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Server/dist/index.js` (MCP stdio server, 28 tools named `watson_*`); `Server/dist/debug-server-client.js` exporting `DebugServerClient` with `constructor(host = '127.0.0.1', port = 21512)`, `connect(): Promise<void>`, `disconnect(): void`, `isConnected(): boolean`, `getStatus(cpu?): Promise<{alive, paused, pc, cycles}>`, `readRegisters(cpu?, category?): Promise<any>`; `npm test` in `Server/` builds then runs `node --test tests/`.

- [ ] **Step 1: Merge the upstream history**

```bash
cd /d/CodingProjects/Watson
git fetch https://github.com/hkmodd/PCSX2-MCP.git HEAD
git rev-parse --short=10 FETCH_HEAD
```

Expected: `8f9bf45ed8`. If it differs, upstream moved; stop and report the new commit before continuing.

```bash
git merge --allow-unrelated-histories --no-commit FETCH_HEAD
```

- [ ] **Step 2: Rearrange into Watson's layout**

```bash
git mv pcsx2-plugin Emulator
git mv pcsx2-mcp-server Server
git mv README.md docs/UPSTREAM-README.md
```

Replace the whole of `.gitignore` with:

```gitignore
References/
Runtime/

Server/node_modules/
Server/dist/

*.pdb
*.exp
*.lib

.vs/
.vscode/
*.suo
*.user

Thumbs.db
Desktop.ini
.DS_Store
```

- [ ] **Step 3: Write `README.md`**

```markdown
# Watson

The live witness for PS2 reverse engineering: an instrumented PCSX2 and an MCP server that let
an agent drive the emulator and record what it did.

Design: [docs/superpowers/specs/2026-10-01-watson-design.md](docs/superpowers/specs/2026-10-01-watson-design.md).

## Status

Phase 0: a self-built PCSX2 with the DebugServer patch, and 28 EE debugger tools over MCP.

## Build

```powershell
pwsh Emulator/Build.ps1
cd Server; npm ci; npm test
```

`Build.ps1` clones the PCSX2 tag pinned in `Emulator/upstream.json` into `References/pcsx2`,
applies the patch, and builds `pcsx2-qt` and `pcsx2-gsrunner`.

## Run

```powershell
pwsh Emulator/Run.ps1 -Bios <path to a BIOS .bin you dumped>
```

Watson keeps its own PCSX2 data in `Runtime/` and does not touch `Documents/PCSX2`.
No BIOS, game or ELF is distributed with Watson.

## Credits and licensing

Watson is a fork of [hkmodd/PCSX2-MCP](https://github.com/hkmodd/PCSX2-MCP), whose history is
merged into this repository. It links into [PCSX2](https://github.com/PCSX2/pcsx2).

Watson is licensed GPL-3.0, as PCSX2 is. `Emulator/DebugServer.cpp` and
`Emulator/DebugServer.h` carry an `SPDX-License-Identifier: MIT` header from upstream while
the upstream repository's `LICENSE` is GPL-3.0. The headers are kept as found.
```

- [ ] **Step 4: Commit the import**

```bash
git add -A
git commit -m "Build(Project): Merge hkmodd/PCSX2-MCP and adopt Watson layout"
```

- [ ] **Step 5: Add the test script and install**

In `Server/package.json`, set `"name": "watson-server"`, `"version": "0.1.0"`,
`"description": "Watson MCP server: live PS2 witness over an instrumented PCSX2"`,
`"bin": { "watson": "dist/index.js" }`, and add to `"scripts"`:

```json
"test": "npm run build && node --test tests/"
```

```bash
cd Server && npm ci && npm run build
```

Expected: `dist/index.js` and `dist/debug-server-client.js` exist.

- [ ] **Step 6: Write the failing client tests**

Create `Server/tests/client.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DebugServerClient } from '../dist/debug-server-client.js';

const STATUS = '{"ok":true,"data":{"alive":true,"paused":false,"pc":"00100000","cycles":5}}\n';

function fakeServer(onLine) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(JSON.parse(line), socket);
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('status round trip', async () => {
  const seen = [];
  const server = await fakeServer((req, socket) => { seen.push(req); socket.write(STATUS); });
  const client = new DebugServerClient('127.0.0.1', server.address().port);
  await client.connect();
  const st = await client.getStatus();
  assert.equal(st.pc, '00100000');
  assert.equal(st.alive, true);
  assert.deepEqual(seen, [{ cmd: 'status', cpu: 'ee' }]);
  client.disconnect();
  server.close();
});

test('a response split across two chunks parses as one reply', async () => {
  const server = await fakeServer((_req, socket) => {
    socket.write(STATUS.slice(0, 20));
    setTimeout(() => socket.write(STATUS.slice(20)), 30);
  });
  const client = new DebugServerClient('127.0.0.1', server.address().port);
  await client.connect();
  const st = await client.getStatus();
  assert.equal(st.cycles, 5);
  client.disconnect();
  server.close();
});

test('a socket closed with a request pending rejects promptly', async () => {
  const server = await fakeServer((_req, socket) => socket.destroy());
  const client = new DebugServerClient('127.0.0.1', server.address().port);
  await client.connect();
  const started = Date.now();
  await assert.rejects(client.getStatus(), /closed/i);
  assert.ok(Date.now() - started < 2000, 'must not wait for the 10 s command timeout');
  assert.equal(client.isConnected(), false);
  server.close();
});
```

- [ ] **Step 7: Run them and see the third fail**

Run: `cd Server && npm test`
Expected: the first two pass; `a socket closed with a request pending rejects promptly` fails with a timeout-shaped error (`Command timeout: status`) after about 10 seconds.

- [ ] **Step 8: Reject the pending request on close**

In `Server/src/debug-server-client.ts`, replace:

```ts
      this.socket.on('close', () => {
        this.connected = false;
      });
```

with:

```ts
      this.socket.on('close', () => {
        this.connected = false;
        if (this.pendingReject) {
          const reject = this.pendingReject;
          this.pendingResolve = null;
          this.pendingReject = null;
          reject(new Error('DebugServer connection closed'));
        }
      });
```

- [ ] **Step 9: Run them and see all three pass**

Run: `cd Server && npm test`
Expected: 3 pass, 0 fail.

- [ ] **Step 10: Commit**

```bash
git add Server/package.json Server/package-lock.json Server/tests/client.test.mjs Server/src/debug-server-client.ts
git commit -m "Fix(Server): Reject pending request when the socket closes"
```

- [ ] **Step 11: Write the failing tool-name test**

Create `Server/tests/tools.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('the server exposes exactly the 28 inherited tools, named watson_*', async () => {
  const client = new Client({ name: 'watson-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  await client.close();

  assert.equal(names.length, 28);
  assert.deepEqual(names.filter((n) => !n.startsWith('watson_')), []);
  for (const n of ['watson_connect', 'watson_status', 'watson_read_registers', 'watson_get_backtrace']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});
```

- [ ] **Step 12: Run it and see it fail**

Run: `cd Server && npm test`
Expected: FAIL, `30 !== 28`.

- [ ] **Step 13: Rename the tools and remove the PS2Recomp block**

In `Server/src/index.ts`:

1. Replace every occurrence of `pcsx2_` with `watson_` (tool names, the banner comments, and the two messages that say `use pcsx2_connect first` and `Use pcsx2_pause to stop.`).
2. Delete the line `const PS2RECOMP_ROOT = process.env.PS2RECOMP_ROOT || '...';`.
3. Delete everything from the banner comment `//  PS2Recomp Integration Tools` (including the `// ====` line above it) down to, but not including, the `// ====` line above `//  MCP Resources`. That removes `ps2recomp_lookup_function` and `ps2recomp_list_overrides`.
4. Delete the line ``console.error(`PS2Recomp root: ${PS2RECOMP_ROOT}`);``.
5. Delete the now unused imports `import * as fs from 'node:fs';` and `import * as path from 'node:path';`.
6. Change the server identity to `new McpServer({ name: 'watson', version: '0.1.0' }, ...)` and the startup log to `console.error('Watson MCP server running');`.
7. Replace the header comment block (lines 2–14) with:

```ts
/**
 * Watson MCP server.
 *
 * Connects to the DebugServer inside a Watson-built PCSX2 (port 21512), with Pine IPC
 * (port 28011) as a fallback for memory and savestates.
 */
```

Verify nothing was missed:

```bash
grep -n "pcsx2_\|ps2recomp\|PS2RECOMP\|fs\.\|path\." Server/src/index.ts
```

Expected: no output.

- [ ] **Step 14: Run the tests and see them pass**

Run: `cd Server && npm test`
Expected: 4 pass, 0 fail.

- [ ] **Step 15: Commit**

```bash
git add Server/src/index.ts Server/tests/tools.test.mjs
git commit -m "Refactor(Server): Rename tools to watson_ and drop PS2Recomp tools"
```

---

### Task 2: Build PCSX2 at the pinned tag with the patch

**Files:**
- Create: `Emulator/upstream.json`, `Emulator/MakeHooks.py`, `Emulator/hooks.patch`, `Emulator/Build.ps1`

**Interfaces:**
- Consumes: `Emulator/DebugServer.cpp`, `Emulator/DebugServer.h` from Task 1.
- Produces: `References/pcsx2/build/pcsx2-qt/Release/pcsx2-qt.exe` and `References/pcsx2/build/pcsx2-gsrunner/Release/pcsx2-gsrunner.exe`. `Build.ps1` exits 0 on success and non-zero with a one-line reason otherwise. `Build.ps1 -PrepareOnly` stops after cloning and patching.

- [ ] **Step 1: Pin upstream**

Create `Emulator/upstream.json`:

```json
{
  "repository": "https://github.com/PCSX2/pcsx2.git",
  "tag": "v2.9.94",
  "commit": "81526d4dc7cc70e4ae75abb35a789417456c6d43",
  "dependencies": "https://github.com/PCSX2/pcsx2-windows-dependencies/releases/download/latest-windows-dependencies/pcsx2-windows-dependencies.7z"
}
```

- [ ] **Step 2: Write the hook generator**

Create `Emulator/MakeHooks.py`. It edits a clean PCSX2 tree in place and refuses if any anchor
is missing or ambiguous, so a moved pin fails loudly instead of patching the wrong place.

```python
#!/usr/bin/env python3
"""Apply Watson's hook edits to a clean PCSX2 tree. Every anchor must match exactly once.

python Emulator/MakeHooks.py <pcsx2 tree>
Then, inside the tree: git diff -- pcsx2/VMManager.cpp pcsx2/CMakeLists.txt > hooks.patch
"""
import sys
from pathlib import Path

EDITS = {
    "pcsx2/VMManager.cpp": [
        ('#include "DebugTools/SymbolImporter.h"\n',
         '#include "DebugTools/DebugServer.h"\n#include "DebugTools/SymbolImporter.h"\n'),
        ('\tReloadPINE();\n\n\tif (EmuConfig.EnableDiscordPresence)\n',
         '\tReloadPINE();\n\n\tDebugServer::Start();\n\n\tif (EmuConfig.EnableDiscordPresence)\n'),
        ('\tShutdownDiscordPresence();\n\n\tPINEServer::Deinitialize();\n',
         '\tShutdownDiscordPresence();\n\n\tDebugServer::Stop();\n\n\tPINEServer::Deinitialize();\n'),
    ],
    "pcsx2/CMakeLists.txt": [
        ('\tDebugTools/BiosDebugData.cpp)\n',
         '\tDebugTools/DebugServer.cpp\n\tDebugTools/BiosDebugData.cpp)\n'),
        ('\tDebugTools/BiosDebugData.h)\n',
         '\tDebugTools/DebugServer.h\n\tDebugTools/BiosDebugData.h)\n'),
    ],
}


def main(tree: str) -> int:
    root = Path(tree)
    for relative, edits in EDITS.items():
        path = root / relative
        text = path.read_text(encoding="utf-8", newline="")
        for anchor, replacement in edits:
            count = text.count(anchor)
            if count != 1:
                print(f"NOT APPLIED {relative}: anchor matched {count} times: {anchor!r}")
                return 1
            text = text.replace(anchor, replacement)
        path.write_text(text, encoding="utf-8", newline="")
        print(f"edited {relative}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
```

- [ ] **Step 3: Write `Build.ps1`**

Create `Emulator/Build.ps1`:

```powershell
#requires -Version 7
param([switch]$PrepareOnly)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Pin = Get-Content (Join-Path $PSScriptRoot 'upstream.json') -Raw | ConvertFrom-Json
$References = Join-Path $Root 'References'
$Tree = Join-Path $References 'pcsx2'
$Hooks = Join-Path $PSScriptRoot 'hooks.patch'
$SevenZip = 'C:\Program Files\7-Zip\7z.exe'

function Fail([string]$Reason) { Write-Host "Build.ps1: $Reason"; exit 1 }
function Run([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "$Exe $($Arguments -join ' ') exited $LASTEXITCODE" }
}

New-Item -ItemType Directory -Force $References | Out-Null

if (-not (Test-Path (Join-Path $Tree '.git'))) {
    Run git @('clone', '--depth', '1', '--branch', $Pin.tag, '-c', 'core.autocrlf=false', $Pin.repository, $Tree)
}
$Head = (& git -C $Tree rev-parse HEAD).Trim()
if ($Head -ne $Pin.commit) { Fail "References/pcsx2 is at $Head, upstream.json pins $($Pin.commit)" }

if (-not (Test-Path (Join-Path $Tree 'deps\lib\cmake\Qt6'))) {
    if (-not (Test-Path $SevenZip)) { Fail "7-Zip not found at $SevenZip" }
    $Archive = Join-Path $References 'pcsx2-windows-dependencies.7z'
    if (-not (Test-Path $Archive)) { Run curl.exe @('-L', '--fail', '--retry', '3', '-o', $Archive, $Pin.dependencies) }
    Run $SevenZip @('x', '-y', "-o$Tree", $Archive)
    if (-not (Test-Path (Join-Path $Tree 'deps\lib\cmake\Qt6'))) {
        Fail "dependency archive did not produce References/pcsx2/deps/lib/cmake/Qt6"
    }
}

Copy-Item (Join-Path $PSScriptRoot 'DebugServer.cpp') (Join-Path $Tree 'pcsx2\DebugTools\DebugServer.cpp') -Force
Copy-Item (Join-Path $PSScriptRoot 'DebugServer.h') (Join-Path $Tree 'pcsx2\DebugTools\DebugServer.h') -Force

& git -C $Tree apply --reverse --check $Hooks 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host 'hooks already applied'
} else {
    Run git @('-C', $Tree, 'apply', '--check', $Hooks)
    Run git @('-C', $Tree, 'apply', $Hooks)
    Write-Host 'hooks applied'
}

if ($PrepareOnly) { Write-Host 'prepared'; exit 0 }

$Build = Join-Path $Tree 'build'
Run cmake @('-S', $Tree, '-B', $Build, '-G', 'Visual Studio 18 2026', '-A', 'x64', "-DCMAKE_PREFIX_PATH=$(Join-Path $Tree 'deps')")
Run cmake @('--build', $Build, '--config', 'Release', '--target', 'pcsx2-qt', 'pcsx2-gsrunner')

foreach ($Exe in 'pcsx2-qt\Release\pcsx2-qt.exe', 'pcsx2-gsrunner\Release\pcsx2-gsrunner.exe') {
    if (-not (Test-Path (Join-Path $Build $Exe))) { Fail "build finished without $Exe" }
}
Write-Host 'built'
```

- [ ] **Step 4: Run it before the hooks exist and see it fail**

Run: `pwsh Emulator/Build.ps1 -PrepareOnly`
Expected: the clone succeeds, the dependency archive downloads and extracts, then it stops with `Build.ps1: git -C ... apply --check ...hooks.patch exited` because `hooks.patch` does not exist yet. The tree is left clean.

- [ ] **Step 5: Generate `hooks.patch` from the clean tree**

```bash
cd /d/CodingProjects/Watson
python Emulator/MakeHooks.py References/pcsx2
git -C References/pcsx2 diff -- pcsx2/VMManager.cpp pcsx2/CMakeLists.txt > Emulator/hooks.patch
git -C References/pcsx2 checkout -- pcsx2/VMManager.cpp pcsx2/CMakeLists.txt
git -C References/pcsx2 status --short
```

Expected: `MakeHooks.py` prints `edited pcsx2/VMManager.cpp` and `edited pcsx2/CMakeLists.txt`. `hooks.patch` has 5 added lines: one `#include`, `DebugServer::Start();`, `DebugServer::Stop();`, and the two CMake source entries. After the checkout, `status --short` lists only the two untracked `DebugServer` files, or nothing.

- [ ] **Step 6: Prepare twice and see idempotence**

Run: `pwsh Emulator/Build.ps1 -PrepareOnly`
Expected: `hooks applied`, then `prepared`, exit 0.

Run it again: `pwsh Emulator/Build.ps1 -PrepareOnly`
Expected: `hooks already applied`, then `prepared`, exit 0.

- [ ] **Step 7: Commit**

```bash
git add Emulator/upstream.json Emulator/MakeHooks.py Emulator/hooks.patch Emulator/Build.ps1
git commit -m "Build(Emulator): Pin PCSX2 v2.9.94 and script the patched build"
```

- [ ] **Step 8: Build**

Run: `pwsh Emulator/Build.ps1`
Expected: `built`, exit 0. This takes several minutes.

If the build fails, read the first compiler error and classify it:

- **The error is in `pcsx2/DebugTools/DebugServer.cpp`.** The patch was written against upstream of March 2026. Compare the failing call with the declaration at the pinned tag in `References/pcsx2/pcsx2/DebugTools/DebugInterface.h` or `Breakpoints.h`, fix the call in `Emulator/DebugServer.cpp` only, and re-run `Build.ps1`. Every method name the patch calls was checked to exist at `v2.9.94`; a failure here is a signature or type change.
- **The error is in an upstream file.** Stop. Report the file, the error text and the compiler version. Do not edit upstream sources beyond `hooks.patch`.

- [ ] **Step 9: Commit any patch fixes**

Only if Step 8 changed `Emulator/DebugServer.cpp`:

```bash
git add Emulator/DebugServer.cpp
git commit -m "Fix(Emulator): Adapt DebugServer to the PCSX2 v2.9.94 debug API"
```

---

### Task 3: Launch the built PCSX2 and prove the connection

**Files:**
- Create: `Emulator/Run.ps1`, `Server/tests/live.test.mjs`
- Modify: `D:\CodingProjects\CrystalClockVK\.mcp.json`

**Interfaces:**
- Consumes: `References/pcsx2/build/pcsx2-qt/Release/pcsx2-qt.exe` from Task 2; `DebugServerClient` and `dist/index.js` from Task 1.
- Produces: `Run.ps1 [-Bios <file>]` starts PCSX2 with its data in `Runtime/` and prints its process id; without `-Bios` it starts with no VM. `Server/tests/live.test.mjs` passes against a running Watson PCSX2 and skips, naming the reason, when port 21512 is closed.

- [ ] **Step 1: Write the live smoke test**

Create `Server/tests/live.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PORT = 21512;
const EXPECT_VM = process.env.WATSON_EXPECT_VM === '1';

function listening() {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

test('live: the DebugServer answers status', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  const client = new DebugServerClient('127.0.0.1', PORT);
  await client.connect();
  const st = await client.getStatus();
  client.disconnect();
  assert.equal(typeof st.alive, 'boolean');
  assert.equal(st.alive, EXPECT_VM, EXPECT_VM ? 'a VM should be running' : 'no VM should be running');
});

test('live: EE registers are readable through MCP', async (t) => {
  if (!(await listening())) return t.skip(`nothing listening on 127.0.0.1:${PORT}; start Emulator/Run.ps1`);
  if (!EXPECT_VM) return t.skip('set WATSON_EXPECT_VM=1 and launch with -Bios to read registers of a running VM');
  const client = new Client({ name: 'watson-live', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
  const connect = await client.callTool({ name: 'watson_connect', arguments: { mode: 'debug' } });
  assert.match(connect.content[0].text, /DebugServer: connected/);
  const regs = await client.callTool({ name: 'watson_read_registers', arguments: {} });
  await client.close();
  assert.ok(!regs.isError, regs.content[0].text);
  assert.match(regs.content[0].text, /\bpc\b/i);
  assert.match(regs.content[0].text, /\bgp\b/i);
});
```

- [ ] **Step 2: Run it with nothing listening and see the skips**

Close any PCSX2 that is open, then run: `cd Server && npm test`
Expected: 4 pass, 2 skipped, each skip saying `nothing listening on 127.0.0.1:21512; start Emulator/Run.ps1`.

- [ ] **Step 3: Write `Run.ps1`**

Create `Emulator/Run.ps1`:

```powershell
#requires -Version 7
param([string]$Bios)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Exe = Join-Path $Root 'References\pcsx2\build\pcsx2-qt\Release\pcsx2-qt.exe'
$Runtime = Join-Path $Root 'Runtime'
$Ini = Join-Path $Runtime 'inis\PCSX2.ini'
$Port = 21512

function Fail([string]$Reason) { Write-Host "Run.ps1: $Reason"; exit 1 }

function Set-IniValue([string]$Path, [string]$Section, [string]$Key, [string]$Value) {
    $Lines = [System.Collections.Generic.List[string]](Get-Content $Path)
    $Start = $Lines.IndexOf("[$Section]")
    if ($Start -lt 0) { $Lines.Add("[$Section]"); $Lines.Add("$Key = $Value"); Set-Content $Path $Lines; return }
    $End = $Start + 1
    while ($End -lt $Lines.Count -and -not $Lines[$End].StartsWith('[')) {
        if ($Lines[$End] -match "^\s*$([regex]::Escape($Key))\s*=") { $Lines[$End] = "$Key = $Value"; Set-Content $Path $Lines; return }
        $End++
    }
    $Lines.Insert($Start + 1, "$Key = $Value")
    Set-Content $Path $Lines
}

if (-not (Test-Path $Exe)) { Fail "no build at $Exe; run Emulator/Build.ps1" }

$Holder = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($Holder) {
    $Process = Get-Process -Id $Holder.OwningProcess -ErrorAction SilentlyContinue
    Fail "port $Port is already held by $($Process.Path) (pid $($Holder.OwningProcess)); close it first"
}

if (-not (Test-Path $Ini)) {
    New-Item -ItemType Directory -Force $Runtime | Out-Null
    $Init = Start-Process -FilePath $Exe -ArgumentList @('-datapath', "`"$Runtime`"", '-testconfig') -Wait -PassThru
    if (-not (Test-Path $Ini)) { Fail "-testconfig (exit $($Init.ExitCode)) did not create $Ini" }
}
Set-IniValue $Ini 'UI' 'SetupWizardIncomplete' 'false'

$Arguments = @('-datapath', "`"$Runtime`"")
if ($Bios) {
    $BiosFile = Get-Item $Bios -ErrorAction SilentlyContinue
    if (-not $BiosFile) { Fail "BIOS not found: $Bios" }
    Set-IniValue $Ini 'Folders' 'Bios' $BiosFile.DirectoryName
    Set-IniValue $Ini 'Filenames' 'BIOS' $BiosFile.Name
    $Arguments += '-bios'
}

$Started = Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru
Write-Host "pcsx2 pid $($Started.Id)"
```

- [ ] **Step 4: Launch with no VM and prove the server survives it**

```powershell
pwsh Emulator/Run.ps1
cd Server; npm test
```

Expected: `Run.ps1` prints `pcsx2 pid <n>` and a PCSX2 window opens without the setup wizard. `npm test`: `live: the DebugServer answers status` passes with `alive` false; the register test skips with `set WATSON_EXPECT_VM=1 ...`. PCSX2 is still running afterwards.

If the wizard appears, `Set-IniValue` did not land: open `Runtime/inis/PCSX2.ini`, confirm `[UI]` holds `SetupWizardIncomplete = false`, and fix `Set-IniValue` before going on.

- [ ] **Step 5: Prove the port guard**

With that PCSX2 still open, run: `pwsh Emulator/Run.ps1`
Expected: `Run.ps1: port 21512 is already held by ...pcsx2-qt.exe (pid <n>); close it first`, exit 1, and no second window.

Close PCSX2.

- [ ] **Step 6: Launch a BIOS and read EE registers through MCP**

```powershell
pwsh Emulator/Run.ps1 -Bios D:\CodingProjects\CrystalClockVK\References\bios\megadump\ps2-0230a-20080220.bin
$env:WATSON_EXPECT_VM = '1'; cd Server; npm test; Remove-Item Env:WATSON_EXPECT_VM
```

Expected: PCSX2 boots the BIOS into OSDSYS. `npm test`: 6 pass, 0 skipped. This is the phase exit criterion.

Close PCSX2.

- [ ] **Step 7: Commit**

```bash
git add Emulator/Run.ps1 Server/tests/live.test.mjs
git commit -m "Feat(Emulator): Launch the patched PCSX2 from an isolated data path"
```

- [ ] **Step 8: Point CrystalClockVK at Watson**

Replace the whole of `D:\CodingProjects\CrystalClockVK\.mcp.json` with:

```json
{
  "mcpServers": {
    "watson": {
      "command": "node",
      "args": ["D:\\CodingProjects\\Watson\\Server\\dist\\index.js"]
    }
  }
}
```

This replaces the `pcsx2` server that pointed at the prebuilt hkmodd release. Do not commit it
in CrystalClockVK; leave the change in the working tree and tell the user, who restarts the
session to load the new tools.
