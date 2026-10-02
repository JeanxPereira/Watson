#!/usr/bin/env python3
"""Apply Watson's hook edits to a clean PCSX2 tree. Every anchor must match exactly once.

Anchors are written with LF and matched on LF-normalized text; each file keeps the line
ending it was checked out with.

The server starts and stops in the Qt host, not in VMManager: pcsx2-gsrunner shares VMManager
and must not open the debug port.

python Emulator/MakeHooks.py <pcsx2 tree>
Then, inside the tree: git diff > hooks.patch
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
         '\tDebugTools/DebugServer.cpp\n\tDebugTools/GifTrace.cpp\n\tDebugTools/BiosDebugData.cpp)\n'),
        ('\tDebugTools/BiosDebugData.h)\n',
         '\tDebugTools/DebugServer.h\n\tDebugTools/GifTrace.h\n\tDebugTools/BiosDebugData.h)\n'),
    ],
    # The trace hooks: data entering a path, bytes a path takes back, a packet entering the
    # MTGS ring, vsync, and the two DMA channels being set going.
    "pcsx2/Gif_Unit.h": [
        ('#include "MTGS.h"\n',
         '#include "MTGS.h"\n#include "DebugTools/GifTrace.h"\n'),
        ('\t\t\t\tgsPack.Reset();\n\t\t\t\tcurSize = curOffset;\n',
         '\t\t\t\tgsPack.Reset();\n\t\t\t\tGifTrace::OnRewind(idx, curSize - curOffset);\n\t\t\t\tcurSize = curOffset;\n'),
        ('\t\t\t\t\t\tdmaRewind = curSize - curOffset;\n',
         '\t\t\t\t\t\tdmaRewind = curSize - curOffset;\n\t\t\t\t\t\tGifTrace::OnRewind(idx, dmaRewind);\n'),
        ('\t\tgifPath[tranType & 3].CopyGSPacketData(pMem, size, aligned);\n',
         '\t\tGifTrace::OnData(tranType, pMem, size);\n'
         '\t\tgifPath[tranType & 3].CopyGSPacketData(pMem, size, aligned);\n'),
    ],
    "pcsx2/MTGS.cpp": [
        ('\t//DevCon.WriteLn("Adding Completed Gif Packet [size=%x]", gsPack.size);\n',
         '\t//DevCon.WriteLn("Adding Completed Gif Packet [size=%x]", gsPack.size);\n'
         '\tGifTrace::OnPacket(path, &gifUnit.gifPath[path].buffer[gsPack.offset], gsPack.size,\n'
         '\t\tgifUnit.gifPath[path].curSize - (gsPack.offset + gsPack.size));\n'),
    ],
    "pcsx2/GS.cpp": [
        ('\ts_GSRegistersWritten = false;\n\tMTGS::PostVsyncStart(registers_written);\n',
         '\ts_GSRegistersWritten = false;\n\tGifTrace::OnVsync();\n\tMTGS::PostVsyncStart(registers_written);\n'),
    ],
    # The probe hook: the EE interpreter reports each instruction it is about to execute.
    "pcsx2/Interpreter.cpp": [
        ('#include "DebugTools/Breakpoints.h"\n',
         '#include "DebugTools/Breakpoints.h"\n#include "DebugTools/GifTrace.h"\n'),
        ('\tconst u32 pc = cpuRegs.pc;\n\t// We need to increase the pc before executing the memRead32.',
         '\tconst u32 pc = cpuRegs.pc;\n\tGifTrace::OnExec(pc);\n'
         '\t// We need to increase the pc before executing the memRead32.'),
    ],
    "pcsx2/Gif.cpp": [
        ('void dmaGIF()\n{\n', 'void dmaGIF()\n{\n\tGifTrace::OnOrigin(2);\n'),
    ],
    "pcsx2/Vif1_Dma.cpp": [
        ('void dmaVIF1()\n{\n', 'void dmaVIF1()\n{\n\tGifTrace::OnOrigin(1);\n'),
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
