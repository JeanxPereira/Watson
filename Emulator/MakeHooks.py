#!/usr/bin/env python3
"""Apply Watson's hook edits to a clean PCSX2 tree. Every anchor must match exactly once.

Anchors are written with LF and matched on LF-normalized text; each file keeps the line
ending it was checked out with.

The server starts and stops in the Qt host, not in VMManager: pcsx2-gsrunner shares VMManager
and must not open the debug port.

python Emulator/MakeHooks.py <pcsx2 tree>
Then, inside the tree: git diff --full-index > hooks.patch (full blob ids let ApplyHooks.py
merge the hooks three-way into another PCSX2 version).
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
         '\tDebugTools/DebugServer.cpp\n\tDebugTools/GifTrace.cpp\n\tDebugTools/SpuTrace.cpp\n\tDebugTools/BiosDebugData.cpp)\n'),
        ('\tDebugTools/BiosDebugData.h)\n',
         '\tDebugTools/DebugServer.h\n\tDebugTools/GifTrace.h\n\tDebugTools/SpuTrace.h\n\tDebugTools/BiosDebugData.h)\n'),
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
    # Probes under the EE recompiler: a probe address is compiled as a breakpoint check, and the
    # check records the probe and goes on unless a real breakpoint is there too.
    "pcsx2/R5900.cpp": [
        ('#include "DebugTools/Breakpoints.h"\n',
         '#include "DebugTools/Breakpoints.h"\n#include "DebugTools/GifTrace.h"\n'),
        ('\t\tbpFlags += 2;\n\n\treturn bpFlags;\n',
         '\t\tbpFlags += 2;\n\tif (GifTrace::g_recProbing)\n\t\tbpFlags |= GifTrace::RecProbeFlags(addr, isBranchOrJump(addr));\n\n\treturn bpFlags;\n'),
    ],
    "pcsx2/x86/ix86-32/iR5900.cpp": [
        ('#include "DebugTools/Breakpoints.h"\n',
         '#include "DebugTools/Breakpoints.h"\n#include "DebugTools/GifTrace.h"\n'),
        ('void dynarecCheckBreakpoint()\n{\n\tu32 pc = cpuRegs.pc;\n',
         'void dynarecCheckBreakpoint()\n{\n\tu32 pc = cpuRegs.pc;\n'
         '\tif (GifTrace::RecProbeOnly(pc))\n\t\treturn;\n'),
    ],
    # The capture schedule: pad changes, memory writes and probe windows take effect at the start
    # of a frame, after the vsync is recorded and before the EE runs the frame.
    "pcsx2/Counters.cpp": [
        ('#include "Counters.h"\n',
         '#include "Counters.h"\n#include "DebugTools/GifTrace.h"\n#include "DebugTools/SpuTrace.h"\n'),
        ('\t// Poll input after MTGS frame push, just in case it has to stall to catch up.\n',
         '\tGifTrace::OnFrameStart();\n\tSpuTrace::OnFrameStart();\n\n'
         '\t// Poll input after MTGS frame push, just in case it has to stall to catch up.\n'),
    ],
    "pcsx2/Gif.cpp": [
        ('void dmaGIF()\n{\n', 'void dmaGIF()\n{\n\tGifTrace::OnOrigin(2);\n'),
    ],
    "pcsx2/Vif1_Dma.cpp": [
        ('void dmaVIF1()\n{\n', 'void dmaVIF1()\n{\n\tGifTrace::OnOrigin(1);\n'),
    ],
    # The sound hooks: every SPU2 register write once the mixer has caught up with the IOP, every
    # DMA4/7 start and every copy into SPU2 RAM, each mixed sample per stage, and the IOP probes
    # (interpreter before each instruction; recompiler through its breakpoint checks).
    "pcsx2/SPU2/spu2.cpp": [
        ('#include "SPU2/Dma.h"\n',
         '#include "SPU2/Dma.h"\n#include "DebugTools/SpuTrace.h"\n'),
        ('\tTimeUpdate(psxRegs.cycle);\n\n\tif (rmem >> 16 == 0x1f80)\n\t\tCores[0].WriteRegPS1(rmem, value);\n',
         '\tTimeUpdate(psxRegs.cycle);\n\tSpuTrace::OnWrite(rmem, value);\n\n\tif (rmem >> 16 == 0x1f80)\n\t\tCores[0].WriteRegPS1(rmem, value);\n'),
        ('\tCores[0].DoDMAwrite(pMem, size);\n',
         '\tSpuTrace::OnDma(0, pMem, size);\n\tCores[0].DoDMAwrite(pMem, size);\n'),
        ('\tCores[1].DoDMAwrite(pMem, size);\n',
         '\tSpuTrace::OnDma(1, pMem, size);\n\tCores[1].DoDMAwrite(pMem, size);\n'),
    ],
    "pcsx2/SPU2/Dma.cpp": [
        ('#include "SPU2/Dma.h"\n',
         '#include "SPU2/Dma.h"\n#include "DebugTools/SpuTrace.h"\n'),
        ('\tmemcpy(GetMemPtr(ActiveTSA), DMAPtr, buff1size * 2);\n',
         '\tSpuTrace::OnRam(Index, ActiveTSA, DMAPtr, buff1size);\n\tmemcpy(GetMemPtr(ActiveTSA), DMAPtr, buff1size * 2);\n'),
        ('\t\tmemcpy(GetMemPtr(0), DMAPtr, buff2end * 2);\n',
         '\t\tSpuTrace::OnRam(Index, 0, DMAPtr, buff2end);\n\t\tmemcpy(GetMemPtr(0), DMAPtr, buff2end * 2);\n'),
        ('\t\tif (DMAPtr != nullptr)\n\t\t\tmemcpy(GetMemPtr(0x2000 + (Index << 10) + spos), DMAPtr + InputDataProgress, size);\n',
         '\t\tSpuTrace::OnAdmaRam(Index, 0x2000 + (Index << 10) + spos, DMAPtr, InputDataProgress, size);\n'
         '\t\tif (DMAPtr != nullptr)\n\t\t\tmemcpy(GetMemPtr(0x2000 + (Index << 10) + spos), DMAPtr + InputDataProgress, size);\n'),
        ('\t\t\tif (DMAPtr != nullptr)\n\t\t\t\tmemcpy(GetMemPtr(0x2000 + (Index << 10) + spos), DMAPtr + InputDataProgress, 0x200);\n',
         '\t\t\tSpuTrace::OnAdmaRam(Index, 0x2000 + (Index << 10) + spos, DMAPtr, InputDataProgress, 0x200);\n'
         '\t\t\tif (DMAPtr != nullptr)\n\t\t\t\tmemcpy(GetMemPtr(0x2000 + (Index << 10) + spos), DMAPtr + InputDataProgress, 0x200);\n'),
    ],
    "pcsx2/SPU2/Mixer.cpp": [
        ('#include "SPU2/interpolate_table.h"\n',
         '#include "SPU2/interpolate_table.h"\n#include "DebugTools/SpuTrace.h"\n'),
        ('\treturn TD + ApplyVolume(RV, thiscore.FxVol);\n',
         '\tconst StereoOut32 Mixed(TD + ApplyVolume(RV, thiscore.FxVol));\n'
         '\tSpuTrace::OnCoreMix(coreidx, Voices.Dry.Left, Voices.Dry.Right, Voices.Wet.Left, Voices.Wet.Right, TW.Left, TW.Right, RV.Left, RV.Right, Mixed.Left, Mixed.Right);\n'
         '\treturn Mixed;\n'),
        ('\tspu2M_WriteFast(0xA00 + OutPos, Ext.Right);\n',
         '\tspu2M_WriteFast(0xA00 + OutPos, Ext.Right);\n\tSpuTrace::OnCore0Out(Ext.Left, Ext.Right);\n'),
        ('\tspu2Output(Out);\n',
         '\tSpuTrace::OnMix(Out.Left, Out.Right);\n\tspu2Output(Out);\n'),
    ],
    "pcsx2/R3000AInterpreter.cpp": [
        ('#include "DebugTools/Breakpoints.h"\n',
         '#include "DebugTools/Breakpoints.h"\n#include "DebugTools/SpuTrace.h"\n'),
        ('\tpsxRegs.code = iopMemRead32(psxRegs.pc);\n',
         '\tSpuTrace::OnIopExec(psxRegs.pc);\n\tpsxRegs.code = iopMemRead32(psxRegs.pc);\n'),
    ],
    "pcsx2/R3000A.cpp": [
        ('#include "DebugTools/Breakpoints.h"\n',
         '#include "DebugTools/Breakpoints.h"\n#include "DebugTools/SpuTrace.h"\n'),
        ('\t\tbpFlags += 2;\n\n\treturn bpFlags;\n',
         '\t\tbpFlags += 2;\n\tif (SpuTrace::g_iopRecProbing)\n\t\tbpFlags |= SpuTrace::IopRecProbeFlags(addr, psxIsBranchOrJump(addr));\n\n\treturn bpFlags;\n'),
    ],
    "pcsx2/x86/iR3000A.cpp": [
        ('#include "R5900OpcodeTables.h"\n',
         '#include "R5900OpcodeTables.h"\n#include "DebugTools/SpuTrace.h"\n'),
        ('static bool psxDynarecCheckBreakpoint()\n{\n\tu32 pc = psxRegs.pc;\n',
         'static bool psxDynarecCheckBreakpoint()\n{\n\tu32 pc = psxRegs.pc;\n'
         '\tif (SpuTrace::IopRecProbeOnly(pc))\n\t\treturn false;\n'),
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
