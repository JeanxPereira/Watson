#!/usr/bin/env python3
"""Apply Watson's hook edits to a clean PCSX2 tree. Every anchor must match exactly once.

Anchors are written with LF and matched on LF-normalized text; each file keeps the line
ending it was checked out with.

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

CRLF = "\r\n"
LF = "\n"


def main(tree: str) -> int:
    root = Path(tree)
    for relative, edits in EDITS.items():
        path = root / relative
        with open(path, encoding="utf-8", newline="") as file:
            text = file.read()
        ending = CRLF if CRLF in text else LF
        text = text.replace(CRLF, LF)
        for anchor, replacement in edits:
            count = text.count(anchor)
            if count != 1:
                print(f"NOT APPLIED {relative}: anchor matched {count} times: {anchor!r}")
                return 1
            text = text.replace(anchor, replacement)
        with open(path, "w", encoding="utf-8", newline="") as file:
            file.write(text.replace(LF, ending))
        print(f"edited {relative}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
