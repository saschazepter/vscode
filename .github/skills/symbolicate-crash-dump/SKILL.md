---
name: symbolicate-crash-dump
description: "Symbolicate a native VS Code crash dump (.dmp) using electron-minidump. Use when given a crash dump file, asked to symbolicate a crash, resolve missing method names in a native crash backtrace, or attach Electron/Insiders/Stable symbol files. VS Code team members only; requires macOS or Linux."
---

# Symbolicate a Crash Dump

Turn a native VS Code crash dump (`.dmp`) into a readable backtrace with method names using [electron-minidump](https://www.npmjs.com/package/electron-minidump).

> **VS Code team members only.** Symbol files for internal Electron, Insiders, and Stable builds live in a private-adjacent release repo. A **macOS or Linux** device is required — electron-minidump does not run on Windows.

## Prerequisites

- A crash dump file (`*.dmp`). See [Creating a crash report](#creating-a-crash-report) below if you don't have one yet.
- A global install of `electron-minidump`:
    ```bash
    npm install -g electron-minidump
    ```

## Procedure

### 1. Run an initial symbolication pass

This generates or refreshes the electron-minidump cache and tells you which symbols are still missing.

```bash
electron-minidump crash-file.dmp > symbolicated-output.log
```

Inspect `symbolicated-output.log`. Look at the top frames of the backtrace: if a frame names a module (e.g. `Electron Framework`) but has **no method name after it**, symbols for that module are required.

> **Retry on transient download errors.** electron-minidump downloads symbols from public symbol servers, so a run can fail on a transient network error (e.g. `failed to download ... (code 56)` or `(code 28)`). Successfully downloaded symbols are cached, so simply re-running the same command resumes where it left off. Retrying a few times is expected:
> ```bash
> for i in 1 2 3 4 5; do
>     electron-minidump crash-file.dmp > symbolicated-output.log && break
>     sleep 3
> done
> ```

### 2. Get the appropriate symbol files

Match the symbol source to the build that produced the crash:

| Build that crashed | Symbol files source |
|--------------------|---------------------|
| Insiders / Stable (internal Electron) | [microsoft/vscode-electron-prebuilt releases](https://github.com/microsoft/vscode-electron-prebuilt/releases) |
| Code - OSS (OSS Electron) | [electron/electron releases](https://github.com/electron/electron/releases) |

Download the symbol zip matching the Electron version, platform, and architecture (e.g. `insiders-symbols-v19.1.8-darwin-x64.zip`).

### 3. Copy the `.sym` files into the electron-minidump cache

The cache lives at:

```bash
"$(npm root -g)/electron-minidump/cache/breakpad_symbols"
```

Unzip the downloaded symbols, then, for each required module, copy the `.sym` file into the matching module/hash subdirectory in the cache. **Verify the folder hashes match** before copying — the cache already contains empty hash subdirectories that must line up with the ones from the symbol zip.

Example (Electron Framework symbols on macOS x64):

```bash
# Unzip somewhere, e.g. ~/insiders-symbols/
# Confirm the cache has a matching (empty) hash subdirectory:
ls "$(npm root -g)/electron-minidump/cache/breakpad_symbols/Electron Framework"

# Copy the .sym for the matching hash into the cache:
cp "~/insiders-symbols/Electron Framework/<hash>/Electron Framework.sym" \
   "$(npm root -g)/electron-minidump/cache/breakpad_symbols/Electron Framework/<hash>"
```

Repeat for any other modules the initial pass reported as missing method names.

### 4. Re-run symbolication

```bash
electron-minidump crash-file.dmp > symbolicated-output.log
```

The backtrace in `symbolicated-output.log` should now have method names attached. If some frames are still bare, return to step 2 for the module(s) still missing symbols.

## Reading the result

Once you have a symbolicated backtrace, turn it into a root cause by answering two questions:

### Which module owns the crash?

Look at the **top frame of the crashing thread** (marked `(crashed)`) and its module name:

- If it's a **VS Code / Electron module** — `Code.exe`, `runtime.node`, `Electron Framework`, `libnode`, `libffmpeg`, V8 frames — the fault is likely inside the product or Electron.
- If it's a **third-party / OS module** — an antivirus, VPN, proxy, or shell-extension DLL injected into the process — the crash is almost certainly caused by that software, not VS Code. Injected DLLs often appear interleaved with `runtime.node`/V8 frames because they hook the runtime.

Find where the module is loaded on disk to confirm it's third-party. On Windows the `strings` of the dump usually reveal the full path, e.g. a DLL under `C:\WINDOWS\system32\` or a vendor folder rather than the VS Code install directory:

```bash
strings -a crash-file.dmp | grep -i "<SuspectModule>" | sort -u
```

### Which process crashed?

The process type tells you whether this is the main process, a renderer/window, or the extension host. On modern Electron the **extension host runs inside a Node utility process**, so a crash there shows up as the `node.mojom.NodeService` utility — not a process literally named "extension host":

```bash
strings -a crash-file.dmp | grep -oiE "utility-sub-type=[a-zA-Z0-9._-]+|node\.mojom\.[A-Za-z]+|--type=[a-z-]+" | sort -u
```

| Signal | Process |
|--------|---------|
| `node.mojom.NodeService` / `utility-sub-type=node.mojom.NodeService` | Extension host (Node utility process) |
| `--type=renderer` | A workbench window (renderer) |
| `--type=gpu-process` | GPU process |
| (no `--type`) | Main process |

Match this against the reported symptom (e.g. an "extension host crash-loop" should correspond to a `NodeService` utility crash).

When you have multiple dumps, symbolicate each and compare the crash reason and top frame — an identical signature across dumps confirms a single, reproducible cause.

## Creating a crash report

If you don't yet have a `.dmp` file, produce one with the `--crash-reporter-directory` option:

1. Close all instances of VS Code.
2. Run `code --crash-reporter-directory <absolute-path>` from the command line (use `code-insiders` for the Insiders build).
3. Take the steps that lead to the crash.
4. Look for a `*.dmp` file in that folder.

You can only symbolicate crashes from a build you have matching symbols for. Crashes from Insiders/Stable need the internal Electron symbols; crashes from a local source build (Code - OSS) need the OSS Electron symbols.

## Remote Extension Host crashes (Linux, gdb)

Native crashes in a remote server's extension host use core dumps and `gdb` instead of electron-minidump:

1. Before running the server, allow core dumps: `ulimit -c unlimited`.
2. Reproduce the crash. Retrieve the core dump via `coredumpctl`, or from the path in `/proc/sys/kernel/core_pattern`.
3. Load it in gdb and capture output:
    ```bash
    gdb -se <path-to-vscode-server>/node -c <path-to-core-file>
    ```
   Then run and collect the output of:
    ```
    set pagination off
    info sharedlibrary
    info registers
    bt full
    disassemble
    ```

## Tips

- Keep `crash-file.dmp` and `symbolicated-output.log` out of the repo — they are throwaway artifacts.
- The cache path is dynamic; always resolve it with `$(npm root -g)` rather than hardcoding a home directory.
- If method names are still missing after adding symbols, double-check the Electron version, platform (`darwin`/`linux`), and arch (`x64`/`arm64`) of the symbol zip match the crashed build.
