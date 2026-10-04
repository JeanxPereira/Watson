// SPDX-License-Identifier: GPL-3.0+
//
// Records what the EE side hands to the GIF, and where it came from, as JSON Lines.
// Every function here runs on the CPU thread.

#pragma once

#include "common/Pcsx2Defs.h"

#include <string>
#include <vector>

namespace GifTrace
{
	extern bool g_active;
	// True while a trace is running with at least one probe set.
	extern bool g_probing;
	// True while a state capture under the EE recompiler has probes set.
	extern bool g_recProbing;

	// Each returns an empty string on success, else the reason.
	// `probes` follows the grammar in docs/superpowers/plans/2026-10-02-watson-probes.md; empty for none.
	// `recompiled`: a capture under the EE recompiler, whose probes fire from breakpoint checks
	// compiled at their addresses. `context`: origins carry the instruction and call stack that
	// started each DMA (interpreters only).
	// `pad` (`frame:frames:button+button;...`) and `writes` (`frame:0xaddress:hex;...`) are applied
	// at the start of each capture frame, before the EE runs it; frame 0 starts at the first vsync
	// after Start. A probe may carry a window, `pc@from-until`, of capture frames it records in.
	std::string Start(const std::string& path, const std::string& probes, bool recompiled = false, bool context = true,
		const std::string& pad = {}, const std::string& writes = {});
	std::string Stop(u64* packets);

	// The EE and VU1 register files are only current under the interpreters.
	bool InterpretersActive();

	// A range of memory to record at a probe: `length` bytes at base + offset, where base is a
	// register (or zero for an absolute address), or at the pointer stored there.
	struct ProbeRange
	{
		bool deref;
		int reg;
		u32 offset;
		u32 length;
	};
	// One probe as asked for; several may share a program counter, each with its own ranges.
	// It records only while the capture frame is in [from, until); frame -1 is the part before
	// the first vsync.
	struct ProbeSpec
	{
		u32 index;
		s32 from;
		s32 until;
		std::vector<ProbeRange> ranges;
	};
	struct ProbePoint
	{
		u32 pc;
		std::vector<ProbeSpec> specs;
	};
	// Probe text to probe points sorted by program counter; an empty string, or the reason it is refused.
	// The EE and the IOP share the grammar and the register names.
	std::string ParseProbes(const std::string& text, std::vector<ProbePoint>* out);
	extern const char* const g_registerNames[32];

	// Buttons held on port 1 from capture frame `frame` for `frames` frames; `mask` has bit `bind`.
	struct PadStep
	{
		s32 frame;
		s32 frames;
		u32 mask;
	};
	std::string ParsePad(const std::string& text, std::vector<PadStep>* out);

	// Pad buttons by name, as the pad commands and the pad schedule take them.
	struct PadButton
	{
		const char* name;
		u32 bind;
	};
	extern const PadButton g_padButtons[16];

	void Origin(u32 channel);
	void Data(u32 transferType, const u8* mem, u32 size);
	void Rewind(u32 path, u32 size);
	void Packet(u32 path, const u8* mem, u32 size, u32 pending);
	void Vsync();
	void FrameStart();
	void Exec(u32 pc);
	bool IsRecProbe(u32 pc);
	void RecCheck(u32 pc);
	// isBreakpointNeeded's flags for the probes at addr and, after a branch, in its delay slot.
	int RecProbeFlags(u32 addr, bool branch);
	// Called by the recompiler's breakpoint check: records the probes at pc; true when no real
	// breakpoint there needs the check to go on.
	bool RecProbeOnly(u32 pc);

	__fi void OnOrigin(u32 channel) { if (g_active) Origin(channel); }
	__fi void OnData(u32 transferType, const u8* mem, u32 size) { if (g_active) Data(transferType, mem, size); }
	__fi void OnRewind(u32 path, u32 size) { if (g_active) Rewind(path, size); }
	__fi void OnPacket(u32 path, const u8* mem, u32 size, u32 pending) { if (g_active) Packet(path, mem, size, pending); }
	__fi void OnVsync() { if (g_active) Vsync(); }
	// Called at each vsync start on the CPU thread, after the vsync is recorded and before the EE
	// runs the next frame.
	__fi void OnFrameStart() { if (g_active) FrameStart(); }
	// Called by the EE interpreter before each instruction.
	__fi void OnExec(u32 pc) { if (g_probing) Exec(pc); }
} // namespace GifTrace
