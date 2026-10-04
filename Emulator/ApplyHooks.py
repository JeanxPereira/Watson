#!/usr/bin/env python3
"""Put Watson into a PCSX2 checkout of any version: copy its sources into pcsx2/DebugTools and
apply hooks.patch, merging three-way where upstream moved the code around the hooks.

python Emulator/ApplyHooks.py <pcsx2 tree> [--report <file.md>]

The patch records the blobs of the pinned PCSX2 commit (upstream.json); those blobs are fetched
into the tree when missing, so git can merge each hooked file against its pinned version. When a
hook still does not apply, every hunk is tried alone and the report names each failing hunk with
the conflict git left for it. The tree is left as it was before the patch in that case.

Exit 0: hooks applied (cleanly or by merge). Exit 1: some hunk does not apply. Exit 2: setup error.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCH = HERE / "hooks.patch"
PIN = json.loads((HERE / "upstream.json").read_text(encoding="utf-8"))
SOURCES = ["DebugServer.cpp", "DebugServer.h", "GifTrace.cpp", "GifTrace.h", "SpuTrace.cpp", "SpuTrace.h"]


def git(tree, *args, check=False):
    result = subprocess.run(["git", "-C", str(tree), *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and result.returncode != 0:
        raise SystemExit(f"ApplyHooks: git {' '.join(args)} exited {result.returncode}: {result.stderr.strip()}")
    return result


def split_patch(text):
    """[(path, header, [hunk, ...])] with each header and hunk as text ending in a newline."""
    files = []
    for block in re.split(r"(?m)^(?=diff --git )", text):
        if not block.startswith("diff --git "):
            continue
        parts = re.split(r"(?m)^(?=@@ )", block)
        path = re.search(r"(?m)^\+\+\+ b/(.+)$", parts[0]).group(1)
        files.append((path, parts[0], parts[1:]))
    return files


def ensure_pinned_blobs(tree, files):
    blobs = [re.search(r"(?m)^index ([0-9a-f]+)\.\.", header).group(1) for _, header, _ in files]
    missing = [blob for blob in blobs if git(tree, "cat-file", "-e", blob).returncode != 0]
    if not missing:
        return True
    fetched = git(tree, "fetch", "--quiet", "--no-tags", "--depth", "1", PIN["repository"], PIN["commit"])
    if fetched.returncode != 0:
        print(f"ApplyHooks: could not fetch the pinned commit {PIN['commit']}: {fetched.stderr.strip()}")
    still = [blob for blob in blobs if git(tree, "cat-file", "-e", blob).returncode != 0]
    if still:
        print(f"ApplyHooks: {len(still)} pinned blob(s) unavailable; three-way merge is off for those files")
    return not still


def restore(tree, paths):
    git(tree, "reset", "--quiet", "--", *paths)
    git(tree, "checkout", "--", *paths, check=True)


def conflicts(tree, path):
    """The conflict regions git left in path, each with its first line number."""
    try:
        lines = (Path(tree) / path).read_text(encoding="utf-8", errors="replace").splitlines()
    except FileNotFoundError:
        return []
    regions, start = [], None
    for number, line in enumerate(lines, 1):
        if line.startswith("<<<<<<< "):
            start = number
        elif line.startswith(">>>>>>> ") and start is not None:
            regions.append((start, "\n".join(lines[start - 1:number])))
            start = None
    return regions


def try_hunk(tree, path, header, hunk, scratch):
    """Apply one hunk alone, three-way; return (ok, conflict text) and put the file back."""
    mini = Path(scratch) / "hunk.patch"
    mini.write_text(header + hunk, encoding="utf-8", newline="\n")
    result = git(tree, "apply", "--3way", "--whitespace=nowarn", str(mini))
    found = conflicts(tree, path)
    restore(tree, [path])
    if result.returncode == 0 and not found:
        return True, ""
    text = "\n\n".join(f"line {line}:\n{region}" for line, region in found) or result.stderr.strip()
    return False, text


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("tree")
    parser.add_argument("--report", help="write a Markdown report here")
    args = parser.parse_args()
    tree = Path(args.tree).resolve()
    if git(tree, "rev-parse", "--git-dir").returncode != 0:
        print(f"ApplyHooks: {tree} is not a git checkout")
        return 2

    head = git(tree, "rev-parse", "HEAD", check=True).stdout.strip()
    described = git(tree, "describe", "--tags", "--always").stdout.strip() or head[:9]
    text = PATCH.read_text(encoding="utf-8")
    files = split_patch(text)
    paths = [path for path, _, _ in files]
    lines = [f"PCSX2 {described} ({head}), hooks.patch of PCSX2 {PIN['tag']} ({PIN['commit'][:9]})", ""]

    debug_tools = tree / "pcsx2" / "DebugTools"
    if not debug_tools.is_dir():
        print(f"ApplyHooks: {debug_tools} does not exist")
        return 2
    for name in SOURCES:
        shutil.copyfile(HERE / name, debug_tools / name)

    def finish(code, verdict, body=()):
        out = "\n".join([*lines, verdict, *body]) + "\n"
        print(out, end="")
        if args.report:
            Path(args.report).write_text(out, encoding="utf-8", newline="\n")
        return code

    if git(tree, "apply", "--reverse", "--check", str(PATCH)).returncode == 0:
        return finish(0, "Result: hooks already applied.")
    if git(tree, "apply", "--check", "--whitespace=nowarn", str(PATCH)).returncode == 0:
        git(tree, "apply", "--whitespace=nowarn", str(PATCH), check=True)
        return finish(0, f"Result: all {sum(len(h) for _, _, h in files)} hunks applied cleanly.")

    three_way = ensure_pinned_blobs(tree, files)
    with tempfile.TemporaryDirectory() as scratch:
        drifted = []
        for path, header, hunks in files:
            single = Path(scratch) / "file.patch"
            single.write_text(header + "".join(hunks), encoding="utf-8", newline="\n")
            if git(tree, "apply", "--check", "--whitespace=nowarn", str(single)).returncode != 0:
                drifted.append(path)
    merged = git(tree, "apply", "--3way", "--whitespace=nowarn", str(PATCH))
    left = [path for path in paths if conflicts(tree, path)]
    if merged.returncode == 0 and not left:
        body = ["", "Merged three-way (their context moved upstream):", *[f"- {path}" for path in drifted]]
        return finish(0, "Result: hooks applied, some by three-way merge.", body)

    restore(tree, paths)
    failing = []
    with tempfile.TemporaryDirectory() as scratch:
        for path, header, hunks in files:
            for index, hunk in enumerate(hunks, 1):
                ok, conflict = try_hunk(tree, path, header, hunk, scratch)
                if not ok:
                    failing.append((path, index, len(hunks), hunk.splitlines()[0], hunk, conflict))

    total = sum(len(h) for _, _, h in files)
    body = ["", f"{len(failing)} of {total} hunks fail" + ("" if three_way else " (three-way merge unavailable)") + ":", ""]
    if not failing:
        body += ["Every hunk applies alone, but not together; git said:", "```", merged.stderr.strip(), "```"]
    for path, index, count, at, hunk, conflict in failing:
        body += [f"### {path}, hunk {index} of {count} `{at}`", "", "The hunk:", "```diff", hunk.rstrip("\n"), "```", "",
                 "What git left:", "```", conflict, "```", ""]
    return finish(1, "Result: HOOKS DO NOT APPLY; the tree is back as it was before the patch.", body)


if __name__ == "__main__":
    sys.exit(main())
