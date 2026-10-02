// SPDX-License-Identifier: GPL-3.0+

#include "GifTrace.h"

#include "DebugInterface.h"
#include "MipsStackWalk.h"

#include "Common.h"
#include "Config.h"
#include "Counters.h"
#include "Gif_Unit.h"
#include "VUmicro.h"
#include "common/FileSystem.h"

#include <cstdarg>
#include <cstdio>
#include <thread>

namespace GifTrace
{
	bool g_active = false;

	static std::FILE* s_file = nullptr;
	static std::thread::id s_thread;
	static std::string s_error;
	static std::string s_line;
	static u64 s_packets = 0;
	static u32 s_nextOrigin = 1;
	// Last origin per DMA channel: 1 is VIF1, 2 is GIF.
	static u32 s_origin[3] = {0, 0, 0};

	static void fail(const char* why)
	{
		if (s_error.empty())
			s_error = why;
		g_active = false;
	}

	static bool onCpuThread()
	{
		if (std::this_thread::get_id() == s_thread)
			return true;
		fail("a hook ran off the CPU thread");
		return false;
	}

	static void appendf(const char* format, ...)
	{
		char buffer[256];
		va_list args;
		va_start(args, format);
		vsnprintf(buffer, sizeof(buffer), format, args);
		va_end(args);
		s_line += buffer;
	}

	static void flushLine()
	{
		s_line += '\n';
		if (std::fwrite(s_line.data(), 1, s_line.size(), s_file) != s_line.size())
			fail("writing the trace file failed");
		s_line.clear();
	}

	// Appends ,"pc":..,"ra":..,"sp":..,"stack":[..] for the instruction the EE is executing.
	static void appendContext()
	{
		// The interpreter advances pc before it executes, in a delay slot too.
		const u32 pc = cpuRegs.pc - 4;
		const u32 ra = cpuRegs.GPR.n.ra.UL[0];
		const u32 sp = cpuRegs.GPR.n.sp.UL[0];
		u32 entry = 0;
		for (const auto& thread : r5900Debug.GetThreadList())
		{
			if (thread->Status() == ThreadStatus::THS_RUN)
			{
				entry = thread->EntryPoint();
				break;
			}
		}
		appendf(",\"pc\":\"0x%08x\",\"ra\":\"0x%08x\",\"sp\":\"0x%08x\",\"stack\":[", pc, ra, sp);
		int count = 0;
		for (const auto& frame : MipsStackWalk::Walk(&r5900Debug, pc, ra, sp, entry))
		{
			if (count == 16)
				break;
			appendf("%s{\"entry\":\"0x%08x\",\"pc\":\"0x%08x\",\"sp\":\"0x%08x\"}", count ? "," : "", frame.entry, frame.pc, frame.sp);
			count++;
		}
		s_line += ']';
	}

	// False when the bytes are not in guest memory: they sat in an emulator buffer first.
	static bool locate(const u8* mem, const char** space, u32* address)
	{
		const uptr at = reinterpret_cast<uptr>(mem);
		const uptr main = reinterpret_cast<uptr>(eeMem->Main);
		const uptr scratch = reinterpret_cast<uptr>(eeMem->Scratch);
		const uptr vu1 = reinterpret_cast<uptr>(vuRegs[1].Mem);
		if (at >= main && at < main + Ps2MemSize::MainRam)
		{
			*space = "ee";
			*address = static_cast<u32>(at - main);
		}
		else if (at >= scratch && at < scratch + Ps2MemSize::Scratch)
		{
			*space = "scratchpad";
			*address = static_cast<u32>(at - scratch);
		}
		else if (at >= vu1 && at < vu1 + VU1_MEMSIZE)
		{
			*space = "vu1";
			*address = static_cast<u32>(at - vu1);
		}
		else
		{
			*space = "host";
			*address = 0;
			return false;
		}
		return true;
	}

	bool InterpretersActive()
	{
		return !CHECK_EEREC && !REC_VU1;
	}

	std::string Start(const std::string& path)
	{
		if (s_file)
			return "a trace is already being recorded";
		if (CHECK_EEREC)
			return "the EE recompiler is on, and under it the EE registers are not current when data is sent; launch with the interpreter option";
		if (REC_VU1)
			return "the VU1 recompiler is on, and under it the VU1 program counter is not current; launch with the interpreter option";
		s_file = FileSystem::OpenCFile(path.c_str(), "wb");
		if (!s_file)
			return "cannot open " + path;

		s_thread = std::this_thread::get_id();
		s_error.clear();
		s_line.clear();
		s_packets = 0;
		s_nextOrigin = 1;
		s_origin[1] = s_origin[2] = 0;

		appendf("{\"type\":\"header\",\"version\":1,\"frame\":%u}", g_FrameCount);
		flushLine();
		// Bytes a path already holds were copied before anyone was watching.
		for (u32 index = 0; index < 3; index++)
		{
			const Gif_Path& held = gifUnit.gifPath[index];
			const u32 pending = held.curSize - held.gsPack.offset;
			if (pending == 0)
				continue;
			appendf("{\"type\":\"data\",\"path\":%u,\"kind\":\"pending\",\"origin\":0,\"space\":\"unknown\",\"address\":0,\"size\":%u}", index + 1, pending);
			flushLine();
		}
		if (!s_error.empty())
		{
			std::fclose(s_file);
			s_file = nullptr;
			return s_error;
		}
		g_active = true;
		return {};
	}

	std::string Stop(u64* packets)
	{
		if (!s_file)
			return "no trace is being recorded";
		g_active = false;
		if (s_error.empty())
		{
			appendf("{\"type\":\"end\",\"packets\":%llu}", static_cast<unsigned long long>(s_packets));
			flushLine();
		}
		if (std::fclose(s_file) != 0 && s_error.empty())
			s_error = "closing the trace file failed";
		s_file = nullptr;
		*packets = s_packets;
		std::string error;
		error.swap(s_error);
		return error;
	}

	void Origin(u32 channel)
	{
		if (!onCpuThread())
			return;
		const DMACh& registers = channel == 1 ? vif1ch : gifch;
		const u32 id = s_nextOrigin++;
		s_origin[channel] = id;
		appendf("{\"type\":\"origin\",\"id\":%u,\"channel\":\"%s\",\"frame\":%u,\"chcr\":\"0x%08x\",\"madr\":\"0x%08x\",\"qwc\":%u,\"tadr\":\"0x%08x\"",
			id, channel == 1 ? "vif1" : "gif", g_FrameCount, registers.chcr._u32, registers.madr, registers.qwc & 0xffffu, registers.tadr);
		appendContext();
		s_line += '}';
		flushLine();
	}

	void Data(u32 transferType, const u8* mem, u32 size)
	{
		if (!onCpuThread())
			return;
		const char* kind = "unknown";
		u32 origin = 0;
		switch (transferType)
		{
			case GIF_TRANS_XGKICK: kind = "xgkick"; origin = s_origin[1]; break;
			case GIF_TRANS_DIRECT: kind = "direct"; origin = s_origin[1]; break;
			case GIF_TRANS_DIRECTHL: kind = "directhl"; origin = s_origin[1]; break;
			case GIF_TRANS_DMA: kind = "dma"; origin = s_origin[2]; break;
			case GIF_TRANS_FIFO:
				// The EE wrote this quadword to the FIFO itself: the origin is this instruction.
				kind = "fifo";
				origin = s_nextOrigin++;
				appendf("{\"type\":\"origin\",\"id\":%u,\"channel\":\"fifo\",\"frame\":%u", origin, g_FrameCount);
				appendContext();
				s_line += '}';
				flushLine();
				break;
			default: break;
		}
		const char* space = "host";
		u32 address = 0;
		// Bytes that waited in the GIF FIFO, or were written to the VIF1 FIFO, arrive from an
		// emulator buffer; the channel may have been started again since, so the last start is
		// not known to be theirs.
		if (!locate(mem, &space, &address) && transferType != GIF_TRANS_FIFO)
			origin = 0;
		appendf("{\"type\":\"data\",\"path\":%u,\"kind\":\"%s\",\"origin\":%u,\"space\":\"%s\",\"address\":%u,\"size\":%u",
			(transferType & 3) + 1, kind, origin, space, address, size);
		if (transferType == GIF_TRANS_XGKICK)
			appendf(",\"vuTpc\":\"0x%04x\"", vuRegs[1].VI[REG_TPC].UL);
		s_line += '}';
		flushLine();
	}

	void Rewind(u32 path, u32 size)
	{
		if (!onCpuThread() || size == 0)
			return;
		appendf("{\"type\":\"rewind\",\"path\":%u,\"size\":%u}", path + 1, size);
		flushLine();
	}

	void Packet(u32 path, const u8* mem, u32 size, u32 pending)
	{
		if (!onCpuThread() || size == 0)
			return;
		static const char digits[] = "0123456789abcdef";
		appendf("{\"type\":\"packet\",\"path\":%u,\"size\":%u,\"pending\":%u,\"hex\":\"", path + 1, size, pending);
		const size_t at = s_line.size();
		s_line.resize(at + static_cast<size_t>(size) * 2);
		for (u32 index = 0; index < size; index++)
		{
			s_line[at + index * 2] = digits[mem[index] >> 4];
			s_line[at + index * 2 + 1] = digits[mem[index] & 15];
		}
		s_line += "\"}";
		flushLine();
		s_packets++;
	}

	void Vsync()
	{
		if (!onCpuThread())
			return;
		appendf("{\"type\":\"vsync\",\"frame\":%u}", g_FrameCount);
		flushLine();
	}
} // namespace GifTrace
