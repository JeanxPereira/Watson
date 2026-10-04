// SPDX-License-Identifier: GPL-3.0+

#include "SpuTrace.h"
#include "GifTrace.h"

#include "Common.h"
#include "Config.h"
#include "Counters.h"
#include "IopMem.h"
#include "R3000A.h"
#include "R5900OpcodeTables.h"
#include "SPU2/defs.h"
#include "SPU2/spu2.h"
#include "SIO/Pad/Pad.h"
#include "common/FileSystem.h"

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>

namespace SpuTrace
{
	bool g_active = false;
	bool g_stages = false;
	bool g_iopProbing = false;
	bool g_iopRecProbing = false;

	static constexpr u32 TICK = 768;
	// Per sample, little-endian s32: core 0 then core 1, each dry L R, wet L R, pre-reverb L R,
	// post-reverb L R, core result L R (dry + wet after the effect volume, before the master
	// volume); then the core 0 output after its master volume (SPU2 RAM 0x800/0xA00), then the
	// final output before the clamp to 16 bits.
	static constexpr u32 STAGE_WORDS = 24;
	static const char* const s_stageFields =
		"\"c0.dry.l\",\"c0.dry.r\",\"c0.wet.l\",\"c0.wet.r\",\"c0.pre.l\",\"c0.pre.r\",\"c0.post.l\",\"c0.post.r\",\"c0.mix.l\",\"c0.mix.r\","
		"\"c1.dry.l\",\"c1.dry.r\",\"c1.wet.l\",\"c1.wet.r\",\"c1.pre.l\",\"c1.pre.r\",\"c1.post.l\",\"c1.post.r\",\"c1.mix.l\",\"c1.mix.r\","
		"\"c0.out.l\",\"c0.out.r\",\"out.l\",\"out.r\"";

	static std::FILE* s_file = nullptr;
	static std::FILE* s_wav = nullptr;
	static std::FILE* s_stagesFile = nullptr;
	static std::thread::id s_thread;
	static std::string s_error;
	static std::string s_line;
	static bool s_dmaData = true;
	static s32 s_captureFrame = -1;
	static u64 s_samples = 0;
	static u64 s_writes = 0;
	static u64 s_dmas = 0;
	static u64 s_probeHits = 0;
	static s32 s_stage[STAGE_WORDS];
	static std::vector<GifTrace::ProbePoint> s_probes;
	static std::vector<GifTrace::PadStep> s_pad;
	static u32 s_padHeld = 0;

	static void fail(const char* why)
	{
		if (s_error.empty())
			s_error = why;
		g_active = false;
		g_stages = false;
		g_iopProbing = false;
	}

	static bool onCpuThread()
	{
		if (std::this_thread::get_id() == s_thread)
			return true;
		fail("a hook ran off the CPU thread");
		return false;
	}

	static void appendf(std::string& out, const char* format, ...)
	{
		char buffer[512];
		va_list args;
		va_start(args, format);
		vsnprintf(buffer, sizeof(buffer), format, args);
		va_end(args);
		out += buffer;
	}

	static void flushLine()
	{
		s_line += '\n';
		if (std::fwrite(s_line.data(), 1, s_line.size(), s_file) != s_line.size())
			fail("writing the trace file failed");
		s_line.clear();
	}

	static void appendHex(std::string& out, const u8* mem, size_t size)
	{
		static const char digits[] = "0123456789abcdef";
		const size_t at = out.size();
		out.resize(at + size * 2);
		for (size_t index = 0; index < size; index++)
		{
			out[at + index * 2] = digits[mem[index] >> 4];
			out[at + index * 2 + 1] = digits[mem[index] & 15];
		}
	}

	static u64 fnv1a(const u8* mem, size_t size)
	{
		u64 hash = 0xcbf29ce484222325ull;
		for (size_t index = 0; index < size; index++)
		{
			hash ^= mem[index];
			hash *= 0x100000001b3ull;
		}
		return hash;
	}

	// The time of a record: the capture frame, the frame counter, the IOP cycle, and the samples
	// mixed since the trace started. The mixer runs behind the IOP and catches up at every SPU2
	// access, so at a write `sample` is the index of the first sample the write can affect.
	static void appendWhen()
	{
		appendf(s_line, ",\"captureFrame\":%d,\"frame\":%u,\"cycle\":%llu,\"sample\":%llu", s_captureFrame, g_FrameCount,
			static_cast<unsigned long long>(psxRegs.cycle), static_cast<unsigned long long>(s_samples));
	}

	// IOP RAM through any segment, as a probe may read it.
	static const u8* iopGuest(u32 address, u32 length)
	{
		const u32 physical = address & 0x1fffffffu;
		if (physical < Ps2MemSize::ExposedIopRam && length <= Ps2MemSize::ExposedIopRam - physical)
			return iopMem->Main + physical;
		return nullptr;
	}

	void Write(u32 address, u16 value)
	{
		if (!onCpuThread())
			return;
		s_writes++;
		s_line += "{\"type\":\"write\"";
		appendWhen();
		appendf(s_line, ",\"pc\":\"0x%08x\",\"address\":\"0x%08x\",\"value\":\"0x%04x\"", psxRegs.pc, address, value);
		const u32 mem = address & 0xffff;
		if (address >> 16 != 0x1f80 && (mem & 0x7ff) < 0x760 && ((mem & ~0x400u) & 0x7ff) == 0x1ac)
		{
			// A halfword through the data port lands at the core's transfer address, which then moves on.
			const V_Core& core = Cores[(mem >> 10) & 1];
			appendf(s_line, ",\"tsa\":\"0x%05x\"", core.TSA & 0xfffff);
		}
		s_line += '}';
		flushLine();
	}

	void Dma(u32 core, const u16* mem, u32 words)
	{
		if (!onCpuThread())
			return;
		s_dmas++;
		const u8* bytes = reinterpret_cast<const u8*>(mem);
		const bool inside = bytes >= iopMem->Main && bytes + static_cast<size_t>(words) * 2 <= iopMem->Main + Ps2MemSize::ExposedIopRam;
		const V_Core& state = Cores[core];
		s_line += "{\"type\":\"dma\"";
		appendWhen();
		appendf(s_line, ",\"core\":%u,\"tsa\":\"0x%05x\",\"words\":%u,\"adma\":%s", core, state.TSA & 0xfffff, words,
			(state.AutoDMACtrl & (core + 1)) == (core + 1) ? "true" : "false");
		if (inside)
			appendf(s_line, ",\"iopAddress\":\"0x%06x\",\"fnv1a64\":\"%016llx\"", static_cast<u32>(bytes - iopMem->Main),
				static_cast<unsigned long long>(fnv1a(bytes, static_cast<size_t>(words) * 2)));
		s_line += '}';
		flushLine();
	}

	void Ram(u32 core, const char* kind, u32 address, const u16* mem, u32 words)
	{
		if (!onCpuThread() || words == 0)
			return;
		const size_t bytes = static_cast<size_t>(words) * 2;
		const u8* source = reinterpret_cast<const u8*>(mem);
		s_line += "{\"type\":\"ram\"";
		appendWhen();
		appendf(s_line, ",\"core\":%u,\"kind\":\"%s\",\"address\":\"0x%05x\",\"words\":%u,\"fnv1a64\":\"%016llx\"", core, kind, address,
			words, static_cast<unsigned long long>(fnv1a(source, bytes)));
		if (s_dmaData)
		{
			s_line += ",\"hex\":\"";
			appendHex(s_line, source, bytes);
			s_line += '"';
		}
		s_line += '}';
		flushLine();
	}

	void CoreMix(u32 core, s32 dryL, s32 dryR, s32 wetL, s32 wetR, s32 preL, s32 preR, s32 postL, s32 postR, s32 mixL, s32 mixR)
	{
		s32* at = s_stage + (core ? 10 : 0);
		at[0] = dryL; at[1] = dryR; at[2] = wetL; at[3] = wetR; at[4] = preL;
		at[5] = preR; at[6] = postL; at[7] = postR; at[8] = mixL; at[9] = mixR;
	}

	void Core0Out(s32 left, s32 right)
	{
		s_stage[20] = left;
		s_stage[21] = right;
	}

	void Mix(s32 left, s32 right)
	{
		if (!onCpuThread())
			return;
		if (s_wav)
		{
			const s16 frame[2] = {static_cast<s16>(std::clamp(left, -0x8000, 0x7fff)), static_cast<s16>(std::clamp(right, -0x8000, 0x7fff))};
			if (std::fwrite(frame, sizeof(frame), 1, s_wav) != 1)
				fail("writing the WAV file failed");
		}
		if (s_stagesFile)
		{
			s_stage[22] = left;
			s_stage[23] = right;
			if (std::fwrite(s_stage, sizeof(s_stage), 1, s_stagesFile) != 1)
				fail("writing the stage file failed");
		}
		s_samples++;
	}

	static void appendButtons(const char* key, u32 mask)
	{
		appendf(s_line, ",\"%s\":[", key);
		bool first = true;
		for (const GifTrace::PadButton& button : GifTrace::g_padButtons)
		{
			if (!(mask & (1u << button.bind)))
				continue;
			appendf(s_line, "%s\"%s\"", first ? "" : ",", button.name);
			first = false;
		}
		s_line += ']';
	}

	static void setPad(u32 wanted)
	{
		const u32 changed = wanted ^ s_padHeld;
		if (changed == 0)
			return;
		for (const GifTrace::PadButton& button : GifTrace::g_padButtons)
		{
			if (changed & (1u << button.bind))
				Pad::SetControllerState(0, button.bind, (wanted & (1u << button.bind)) ? 1.0f : 0.0f);
		}
		s_padHeld = wanted;
		if (!s_file || !s_error.empty())
			return;
		s_line += "{\"type\":\"pad\"";
		appendWhen();
		appendButtons("press", wanted & changed);
		appendButtons("release", ~wanted & changed);
		appendButtons("held", wanted);
		s_line += '}';
		flushLine();
	}

	void FrameStart()
	{
		if (!onCpuThread())
			return;
		s_captureFrame++;
		// The mixer has not caught up with the IOP yet: `pending` ticks of 768 IOP cycles are due
		// and will be mixed at the next SPU2 access, before anything that access changes.
		s_line += "{\"type\":\"frame\"";
		appendWhen();
		appendf(s_line, ",\"lClocks\":%llu,\"pending\":%llu}", static_cast<unsigned long long>(lClocks),
			static_cast<unsigned long long>((psxRegs.cycle - lClocks) / TICK));
		flushLine();
		u32 wanted = 0;
		for (const GifTrace::PadStep& step : s_pad)
		{
			if (s_captureFrame >= step.frame && s_captureFrame - step.frame < step.frames)
				wanted |= step.mask;
		}
		setPad(wanted);
	}

	static const GifTrace::ProbePoint* find(u32 pc)
	{
		const auto found = std::lower_bound(s_probes.begin(), s_probes.end(), pc,
			[](const GifTrace::ProbePoint& point, u32 value) { return point.pc < value; });
		return found == s_probes.end() || found->pc != pc ? nullptr : &*found;
	}

	static void record(u32 pc, const GifTrace::ProbeSpec& spec)
	{
		s_probeHits++;
		appendf(s_line, "{\"type\":\"probe\",\"cpu\":\"iop\",\"pc\":\"0x%08x\",\"probe\":%u", pc, spec.index);
		appendWhen();
		s_line += ",\"gpr\":\"";
		for (int index = 0; index < 32; index++)
			appendf(s_line, "%08x", psxRegs.GPR.r[index]);
		appendf(s_line, "\",\"hi\":\"0x%08x\",\"lo\":\"0x%08x\",\"mem\":[", psxRegs.GPR.n.hi, psxRegs.GPR.n.lo);
		bool first = true;
		for (const GifTrace::ProbeRange& range : spec.ranges)
		{
			u32 address = (range.reg ? psxRegs.GPR.r[range.reg] : 0) + range.offset;
			bool readable = true;
			if (range.deref)
			{
				const u8* pointer = iopGuest(address, 4);
				readable = pointer != nullptr;
				if (readable)
					std::memcpy(&address, pointer, 4);
			}
			const u8* mem = readable ? iopGuest(address, range.length) : nullptr;
			if (!first)
				s_line += ',';
			first = false;
			if (mem)
			{
				appendf(s_line, "{\"address\":%u,\"hex\":\"", address);
				appendHex(s_line, mem, range.length);
				s_line += "\"}";
			}
			else
			{
				appendf(s_line, "{\"address\":%u,\"error\":\"not readable\"}", readable ? address : 0u);
			}
		}
		s_line += "]}";
		flushLine();
	}

	void IopExec(u32 pc)
	{
		const GifTrace::ProbePoint* point = find(pc);
		if (!point || !onCpuThread() || !g_active)
			return;
		for (const GifTrace::ProbeSpec& spec : point->specs)
		{
			if (s_captureFrame >= spec.from && s_captureFrame < spec.until)
				record(pc, spec);
		}
	}

	bool IsIopRecProbe(u32 pc)
	{
		return g_iopRecProbing && find(pc) != nullptr;
	}

	// A breakpoint check the IOP recompiler compiled at pc: for a probe there, or for one in the
	// delay slot of the branch at pc. Registers and pc are flushed before the check runs.
	void IopRecCheck(u32 pc)
	{
		IopExec(pc);
		if (find(pc + 4) && (R5900::GetInstruction(iopMemRead32(pc)).flags & IS_BRANCH))
			IopExec(pc + 4);
	}

	static void writeWavHeader(std::FILE* file, u32 dataBytes)
	{
		u8 header[44];
		const auto put32 = [&header](int at, u32 value) { std::memcpy(header + at, &value, 4); };
		const auto put16 = [&header](int at, u16 value) { std::memcpy(header + at, &value, 2); };
		std::memcpy(header, "RIFF", 4);
		put32(4, 36 + dataBytes);
		std::memcpy(header + 8, "WAVEfmt ", 8);
		put32(16, 16);
		put16(20, 1);
		put16(22, 2);
		put32(24, SPU2::GetConsoleSampleRate());
		put32(28, SPU2::GetConsoleSampleRate() * 4);
		put16(32, 4);
		put16(34, 16);
		std::memcpy(header + 36, "data", 4);
		put32(40, dataBytes);
		std::fseek(file, 0, SEEK_SET);
		std::fwrite(header, 1, sizeof(header), file);
		std::fseek(file, 0, SEEK_END);
	}

	static void closeAll()
	{
		for (std::FILE** file : {&s_file, &s_wav, &s_stagesFile})
		{
			if (*file)
				std::fclose(*file);
			*file = nullptr;
		}
	}

	std::string Start(const Options& options)
	{
		if (s_file)
			return "an SPU trace is already being recorded";
		std::vector<GifTrace::ProbePoint> points;
		std::vector<GifTrace::PadStep> steps;
		for (const std::string& refused : {GifTrace::ParseProbes(options.probes, &points), GifTrace::ParsePad(options.pad, &steps)})
		{
			if (!refused.empty())
				return refused;
		}
		s_file = FileSystem::OpenCFile(options.path.c_str(), "wb");
		if (!s_file)
			return "cannot open " + options.path;
		if (!options.wav.empty() && !(s_wav = FileSystem::OpenCFile(options.wav.c_str(), "wb")))
		{
			closeAll();
			return "cannot open " + options.wav;
		}
		if (!options.stages.empty() && !(s_stagesFile = FileSystem::OpenCFile(options.stages.c_str(), "wb")))
		{
			closeAll();
			return "cannot open " + options.stages;
		}
		if (s_wav)
			writeWavHeader(s_wav, 0);
		s_probes = std::move(points);
		s_pad = std::move(steps);
		s_padHeld = 0;
		s_dmaData = options.dmaData;
		s_captureFrame = -1;
		s_samples = s_writes = s_dmas = s_probeHits = 0;
		std::memset(s_stage, 0, sizeof(s_stage));
		s_thread = std::this_thread::get_id();
		s_error.clear();
		s_line.clear();

		const bool iopRec = CHECK_IOPREC;
		appendf(s_line, "{\"type\":\"header\",\"version\":1,\"frame\":%u,\"cycle\":%llu,\"lClocks\":%llu,\"tick\":%u,\"sampleRate\":%u",
			g_FrameCount, static_cast<unsigned long long>(psxRegs.cycle), static_cast<unsigned long long>(lClocks), TICK,
			SPU2::GetConsoleSampleRate());
		appendf(s_line, ",\"iopRecompiler\":%s,\"eeRecompiler\":%s,\"dmaData\":%s", iopRec ? "true" : "false",
			CHECK_EEREC ? "true" : "false", s_dmaData ? "true" : "false");
		s_line += ",\"probes\":\"" + options.probes + "\",\"pad\":\"" + options.pad + '"';
		appendf(s_line, ",\"wav\":%s,\"stages\":", s_wav ? "true" : "false");
		if (s_stagesFile)
			appendf(s_line, "{\"bytesPerSample\":%u,\"type\":\"s32le\",\"fields\":[%s]}", STAGE_WORDS * 4, s_stageFields);
		else
			s_line += "null";
		s_line += '}';
		flushLine();
		if (!s_error.empty())
		{
			closeAll();
			return s_error;
		}
		g_active = true;
		g_stages = s_stagesFile != nullptr;
		if (!s_probes.empty())
		{
			if (iopRec)
			{
				// Blocks compiled before have no check at the probes: throw them away.
				g_iopRecProbing = true;
				psxCpu->Reset();
			}
			else
			{
				g_iopProbing = true;
			}
		}
		return {};
	}

	std::string Stop(Totals* totals)
	{
		if (!s_file)
			return "no SPU trace is being recorded";
		setPad(0);
		g_active = false;
		g_stages = false;
		g_iopProbing = false;
		if (g_iopRecProbing)
		{
			g_iopRecProbing = false;
			psxCpu->Reset();
		}
		if (s_error.empty())
		{
			appendf(s_line, "{\"type\":\"end\",\"writes\":%llu,\"dmas\":%llu,\"samples\":%llu,\"probes\":%llu", static_cast<unsigned long long>(s_writes),
				static_cast<unsigned long long>(s_dmas), static_cast<unsigned long long>(s_samples), static_cast<unsigned long long>(s_probeHits));
			appendWhen();
			s_line += '}';
			flushLine();
		}
		if (s_wav)
			writeWavHeader(s_wav, static_cast<u32>(s_samples * 4));
		for (std::FILE* file : {s_file, s_wav, s_stagesFile})
		{
			if (file && std::fclose(file) != 0 && s_error.empty())
				s_error = "closing a trace file failed";
		}
		s_file = s_wav = s_stagesFile = nullptr;
		totals->writes = s_writes;
		totals->dmas = s_dmas;
		totals->samples = s_samples;
		totals->probes = s_probeHits;
		std::string error;
		error.swap(s_error);
		return error;
	}

	static void appendSlide(std::string& out, const char* name, const V_VolumeSlide& slide)
	{
		appendf(out, "\"%s\":{\"reg\":\"0x%04x\",\"value\":%d,\"counter\":%u}", name, slide.Reg_VOL, slide.Value, slide.Counter);
	}

	static void appendGates(std::string& out, const char* name, const V_CoreGates& gates)
	{
		appendf(out, "\"%s\":{\"inpL\":%d,\"inpR\":%d,\"sndL\":%d,\"sndR\":%d,\"extL\":%d,\"extR\":%d}", name, gates.InpL, gates.InpR,
			gates.SndL, gates.SndR, gates.ExtL, gates.ExtR);
	}

	static std::string stateJson()
	{
		std::string out;
		appendf(out, "{\"frame\":%u,\"cycle\":%llu,\"lClocks\":%llu,\"pending\":%llu,\"ticks\":%u,\"outPos\":%u,\"inputPos\":%u,\"playMode\":%d,",
			g_FrameCount, static_cast<unsigned long long>(psxRegs.cycle), static_cast<unsigned long long>(lClocks),
			static_cast<unsigned long long>((psxRegs.cycle - lClocks) / TICK), Cycles, OutPos, InputPos, PlayMode);
		appendf(out, "\"spdif\":{\"out\":%u,\"info\":%u,\"mode\":%u,\"media\":%u,\"protection\":%u},\"cores\":[", Spdif.Out, Spdif.Info,
			Spdif.Mode, Spdif.Media, Spdif.Protection);
		for (u32 c = 0; c < 2; c++)
		{
			const V_Core& core = Cores[c];
			appendf(out, "%s{\"index\":%u,\"tsa\":\"0x%05x\",\"activeTsa\":\"0x%05x\",\"irqa\":\"0x%05x\",\"irqEnable\":%s,\"fxEnable\":%s,\"mute\":%s,",
				c ? "," : "", c, core.TSA, core.ActiveTSA, core.IRQA, core.IRQEnable ? "true" : "false", core.FxEnable ? "true" : "false",
				core.Mute ? "true" : "false");
			appendf(out, "\"autoDmaCtrl\":%u,\"admaInProgress\":%s,\"dmaBits\":%d,\"noiseClk\":%u,\"noiseCnt\":%u,\"noiseOut\":%u,\"keyOn\":\"0x%06x\",\"keyOff\":\"0x%06x\",",
				core.AutoDMACtrl, core.AdmaInProgress ? "true" : "false", core.DMABits, core.NoiseClk, core.NoiseCnt, core.NoiseOut, core.KeyOn, core.KeyOff);
			appendf(out, "\"regs\":{\"pmon\":\"0x%06x\",\"non\":\"0x%06x\",\"vmixl\":\"0x%06x\",\"vmixr\":\"0x%06x\",\"vmixel\":\"0x%06x\",\"vmixer\":\"0x%06x\",\"endx\":\"0x%06x\",\"mmix\":\"0x%04x\",\"statx\":\"0x%04x\",\"attr\":\"0x%04x\"},",
				core.Regs.PMON, core.Regs.NON, core.Regs.VMIXL, core.Regs.VMIXR, core.Regs.VMIXEL, core.Regs.VMIXER, core.Regs.ENDX, core.Regs.MMIX,
				core.Regs.STATX, core.Regs.ATTR);
			out += "\"masterVol\":{";
			appendSlide(out, "left", core.MasterVol.Left);
			out += ',';
			appendSlide(out, "right", core.MasterVol.Right);
			appendf(out, "},\"extVol\":[%d,%d],\"inpVol\":[%d,%d],\"fxVol\":[%d,%d],", core.ExtVol.Left, core.ExtVol.Right, core.InpVol.Left,
				core.InpVol.Right, core.FxVol.Left, core.FxVol.Right);
			appendGates(out, "dryGate", core.DryGate);
			out += ',';
			appendGates(out, "wetGate", core.WetGate);
			appendf(out, ",\"effectsStartA\":\"0x%05x\",\"effectsEndA\":\"0x%05x\",\"revbSampleBufPos\":%u,", core.EffectsStartA, core.EffectsEndA,
				core.RevbSampleBufPos);
			const V_Reverb& r = core.Revb;
			appendf(out, "\"revb\":{\"inCoefL\":%d,\"inCoefR\":%d,\"apf1Size\":%u,\"apf2Size\":%u,\"apf1Vol\":%d,\"apf2Vol\":%d,\"iirVol\":%d,\"wallVol\":%d,",
				r.IN_COEF_L, r.IN_COEF_R, r.APF1_SIZE, r.APF2_SIZE, r.APF1_VOL, r.APF2_VOL, r.IIR_VOL, r.WALL_VOL);
			appendf(out, "\"comb1Vol\":%d,\"comb2Vol\":%d,\"comb3Vol\":%d,\"comb4Vol\":%d,\"sameLSrc\":%u,\"sameRSrc\":%u,\"diffLSrc\":%u,\"diffRSrc\":%u,",
				r.COMB1_VOL, r.COMB2_VOL, r.COMB3_VOL, r.COMB4_VOL, r.SAME_L_SRC, r.SAME_R_SRC, r.DIFF_L_SRC, r.DIFF_R_SRC);
			appendf(out, "\"sameLDst\":%u,\"sameRDst\":%u,\"diffLDst\":%u,\"diffRDst\":%u,\"comb1LSrc\":%u,\"comb1RSrc\":%u,\"comb2LSrc\":%u,\"comb2RSrc\":%u,",
				r.SAME_L_DST, r.SAME_R_DST, r.DIFF_L_DST, r.DIFF_R_DST, r.COMB1_L_SRC, r.COMB1_R_SRC, r.COMB2_L_SRC, r.COMB2_R_SRC);
			appendf(out, "\"comb3LSrc\":%u,\"comb3RSrc\":%u,\"comb4LSrc\":%u,\"comb4RSrc\":%u,\"apf1LDst\":%u,\"apf1RDst\":%u,\"apf2LDst\":%u,\"apf2RDst\":%u},",
				r.COMB3_L_SRC, r.COMB3_R_SRC, r.COMB4_L_SRC, r.COMB4_R_SRC, r.APF1_L_DST, r.APF1_R_DST, r.APF2_L_DST, r.APF2_R_DST);
			out += "\"voices\":[";
			for (u32 v = 0; v < V_Core::NumVoices; v++)
			{
				const V_Voice& voice = core.Voices[v];
				appendf(out, "%s{\"index\":%u,\"volume\":{", v ? "," : "", v);
				appendSlide(out, "left", voice.Volume.Left);
				out += ',';
				appendSlide(out, "right", voice.Volume.Right);
				appendf(out, "},\"adsr\":{\"reg1\":\"0x%04x\",\"reg2\":\"0x%04x\",\"value\":%d,\"phase\":%u,\"counter\":%u},", voice.ADSR.regADSR1,
					voice.ADSR.regADSR2, voice.ADSR.Value, voice.ADSR.Phase, voice.ADSR.Counter);
				appendf(out, "\"pitch\":\"0x%04x\",\"startA\":\"0x%05x\",\"loopStartA\":\"0x%05x\",\"nextA\":\"0x%05x\",\"prev1\":%d,\"prev2\":%d,",
					voice.Pitch, voice.StartA, voice.LoopStartA, voice.NextA, voice.Prev1, voice.Prev2);
				appendf(out, "\"modulated\":%s,\"noise\":%s,\"loopMode\":%d,\"loopFlags\":%d,\"sp\":%d,\"outX\":%d,\"decPosRead\":%u,\"decPosWrite\":%u,",
					voice.Modulated ? "true" : "false", voice.Noise ? "true" : "false", voice.LoopMode, voice.LoopFlags, voice.SP, voice.OutX,
					voice.DecPosRead, voice.DecPosWrite);
				const V_VoiceGates& gates = core.VoiceGates[v];
				appendf(out, "\"gates\":{\"dryL\":%d,\"dryR\":%d,\"wetL\":%d,\"wetR\":%d}}", gates.DryL, gates.DryR, gates.WetL, gates.WetR);
			}
			out += "]}";
		}
		out += "]}";
		return out;
	}

	static std::string writeFile(const std::string& path, const void* data, size_t size)
	{
		if (path.empty())
			return {};
		std::FILE* file = FileSystem::OpenCFile(path.c_str(), "wb");
		if (!file)
			return "cannot open " + path;
		const bool written = std::fwrite(data, 1, size, file) == size;
		const bool closed = std::fclose(file) == 0;
		return written && closed ? std::string() : "writing " + path + " failed";
	}

	std::string ReadState(const std::string& ram, const std::string& regs, const std::string& state)
	{
		// The mixer is not run forward first: catching it up here would move the SPU2's DMA
		// checks and change what the emulator does next. `pending` says how far behind it is.
		for (const std::string& failed : {writeFile(ram, _spu2mem, sizeof(_spu2mem)), writeFile(regs, spu2regs, sizeof(spu2regs))})
		{
			if (!failed.empty())
				return failed;
		}
		const std::string json = stateJson();
		return writeFile(state, json.data(), json.size());
	}
} // namespace SpuTrace
