#!/usr/bin/env python3
"""Apply Watson's hook edits to a clean PCSX2 tree. Every anchor must match exactly once.

Anchors are written with LF and matched on LF-normalized text; each file keeps the line
ending it was checked out with.

The server starts and stops in the Qt host, not in VMManager: pcsx2-gsrunner shares VMManager
and must not open the debug port.

python Emulator/MakeHooks.py <pcsx2 tree>
Then, inside the tree: git diff -- pcsx2-qt/QtHost.cpp pcsx2/CMakeLists.txt > hooks.patch
"""
import sys
from pathlib import Path

EDITS = {
    "pcsx2-qt/QtHost.cpp": [
        ('#include "pcsx2/DebugTools/Debug.h"\n',
         '#include "pcsx2/DebugTools/Debug.h"\n#include "pcsx2/DebugTools/DebugServer.h"\n'),
        ('\t\treturn;\n\t}\n\n\t// Start background polling because the VM won\'t do it for us.\n',
         '\t\treturn;\n\t}\n\n\tDebugServer::Start();\n\n'
         '\t// Start background polling because the VM won\'t do it for us.\n'),
        ('\tdestroyBackgroundControllerPollTimer();\n\tVMManager::Internal::CPUThreadShutdown();\n',
         '\tdestroyBackgroundControllerPollTimer();\n\tDebugServer::Stop();\n'
         '\tVMManager::Internal::CPUThreadShutdown();\n'),
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
