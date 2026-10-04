// SPDX-License-Identifier: GPL-3.0+
//
// Records what reaches the SPU2, what it mixes and what the IOP was doing, as JSON Lines, with the
// mixed output beside it. Every function here runs on the CPU thread.

#pragma once

#include "common/Pcsx2Defs.h"

#include <string>

namespace SpuTrace
{
	extern bool g_active;
	// True while a trace records the per-stage mix streams.
	extern bool g_stages;
	// True while a trace with IOP probes runs under the IOP interpreter.
	extern bool g_iopProbing;
	// True while a trace with IOP probes runs under the IOP recompiler.
	extern bool g_iopRecProbing;

	struct Options
	{
		// JSON Lines: header, register writes, DMA starts, SPU2 RAM writes by DMA, IOP probes,
		// pad changes, frame starts, end.
		std::string path;
		// The final output (s16 stereo, 48 kHz) as a WAV file; empty for none.
		std::string wav;
		// The per-stage streams (see the header record for their layout); empty for none.
		std::string stages;
		// IOP probes, in the grammar of the EE probes; empty for none.
		std::string probes;
		// Pad schedule, `frame:frames:button+button;...`, applied at the start of each capture frame.
		std::string pad;
		// Whether each DMA write into SPU2 RAM carries its words.
		bool dmaData = true;
	};

	// Returns an empty string on success, else the reason.
	std::string Start(const Options& options);
	struct Totals
	{
		u64 writes;
		u64 dmas;
		u64 samples;
		u64 probes;
	};
	std::string Stop(Totals* totals);

	// The SPU2 RAM, the register mirror and the cores' state as JSON, written to files.
	std::string ReadState(const std::string& ram, const std::string& regs, const std::string& state);

	void Write(u32 address, u16 value);
	void Dma(u32 core, const u16* mem, u32 words);
	void Ram(u32 core, const char* kind, u32 address, const u16* mem, u32 words);
	void CoreMix(u32 core, s32 dryL, s32 dryR, s32 wetL, s32 wetR, s32 preL, s32 preR, s32 postL, s32 postR, s32 mixL, s32 mixR);
	void Core0Out(s32 left, s32 right);
	void Mix(s32 left, s32 right);
	void FrameStart();
	void IopExec(u32 pc);
	bool IsIopRecProbe(u32 pc);
	void IopRecCheck(u32 pc);

	// Called by SPU2write after the mixer has caught up with the IOP, before the write lands.
	__fi void OnWrite(u32 address, u16 value) { if (g_active) Write(address, value); }
	// Called when DMA4 (core 0) or DMA7 (core 1) starts writing `words` halfwords into SPU2 RAM.
	__fi void OnDma(u32 core, const u16* mem, u32 words) { if (g_active) Dma(core, mem, words); }
	// Called before each copy into SPU2 RAM: `address` and `words` count halfwords.
	__fi void OnRam(u32 core, u32 address, const u16* mem, u32 words) { if (g_active) Ram(core, "dma", address, mem, words); }
	__fi void OnAdmaRam(u32 core, u32 address, const u16* mem, u32 bytes) { if (g_active) Ram(core, "adma", address, mem, bytes / 2); }
	// Called by the mixer for each core at each sample, then for the core 0 output, then for the final output.
	__fi void OnCoreMix(u32 core, s32 dryL, s32 dryR, s32 wetL, s32 wetR, s32 preL, s32 preR, s32 postL, s32 postR, s32 mixL, s32 mixR)
	{
		if (g_stages)
			CoreMix(core, dryL, dryR, wetL, wetR, preL, preR, postL, postR, mixL, mixR);
	}
	__fi void OnCore0Out(s32 left, s32 right) { if (g_stages) Core0Out(left, right); }
	__fi void OnMix(s32 left, s32 right) { if (g_active) Mix(left, right); }
	__fi void OnFrameStart() { if (g_active) FrameStart(); }
	// Called by the IOP interpreter before each instruction.
	__fi void OnIopExec(u32 pc) { if (g_iopProbing) IopExec(pc); }
} // namespace SpuTrace
