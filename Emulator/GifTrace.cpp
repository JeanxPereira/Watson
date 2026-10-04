// SPDX-License-Identifier: GPL-3.0+

#include "GifTrace.h"

#include "Breakpoints.h"
#include "DebugInterface.h"
#include "MipsStackWalk.h"

#include "Common.h"
#include "Config.h"
#include "Counters.h"
#include "Gif_Unit.h"
#include "R5900.h"
#include "R5900OpcodeTables.h"
#include "VUmicro.h"
#include "SIO/Pad/Pad.h"
#include "SIO/Pad/PadDualshock2.h"
#include "common/FileSystem.h"

#include <algorithm>
#include <climits>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>

namespace GifTrace
{
	bool g_active = false;
	bool g_probing = false;
	bool g_recProbing = false;

	const PadButton g_padButtons[16] = {
		{"up", PadDualshock2::Inputs::PAD_UP}, {"right", PadDualshock2::Inputs::PAD_RIGHT},
		{"down", PadDualshock2::Inputs::PAD_DOWN}, {"left", PadDualshock2::Inputs::PAD_LEFT},
		{"triangle", PadDualshock2::Inputs::PAD_TRIANGLE}, {"circle", PadDualshock2::Inputs::PAD_CIRCLE},
		{"cross", PadDualshock2::Inputs::PAD_CROSS}, {"square", PadDualshock2::Inputs::PAD_SQUARE},
		{"select", PadDualshock2::Inputs::PAD_SELECT}, {"start", PadDualshock2::Inputs::PAD_START},
		{"l1", PadDualshock2::Inputs::PAD_L1}, {"l2", PadDualshock2::Inputs::PAD_L2},
		{"r1", PadDualshock2::Inputs::PAD_R1}, {"r2", PadDualshock2::Inputs::PAD_R2},
		{"l3", PadDualshock2::Inputs::PAD_L3}, {"r3", PadDualshock2::Inputs::PAD_R3},
	};

	static std::vector<ProbePoint> s_probes;
	static std::string s_probeText;

	struct MemoryWrite
	{
		s32 frame;
		u32 address;
		std::vector<u8> bytes;
	};
	static std::vector<PadStep> s_pad;
	static std::vector<MemoryWrite> s_writes;
	static std::string s_padText;
	static std::string s_writeText;
	// The capture frame running: -1 until the first vsync after Start, then counted at each one.
	static s32 s_captureFrame = -1;
	// Buttons the schedule holds down now.
	static u32 s_padHeld = 0;
	// True while recording under the EE recompiler: probes fire from its breakpoint checks, and
	// the registers at a DMA start are not current, so origins carry no context.
	static bool s_recompiled = false;
	// Whether an origin carries the instruction and the call stack that started the DMA. The stack
	// walk is most of a traced frame's cost.
	static bool s_context = true;

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
		g_probing = false;
		g_recProbing = false;
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

	const char* const g_registerNames[32] = {
		"zero", "at", "v0", "v1", "a0", "a1", "a2", "a3", "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7",
		"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "t8", "t9", "k0", "k1", "gp", "sp", "s8", "ra"};

	static bool parseHex(const std::string& text, u32* value)
	{
		if (text.empty() || text.size() > 10)
			return false;
		size_t at = 0;
		if (text.size() > 2 && text[0] == '0' && (text[1] == 'x' || text[1] == 'X'))
			at = 2;
		if (at == text.size())
			return false;
		u32 result = 0;
		for (; at < text.size(); at++)
		{
			const char c = text[at];
			u32 digit;
			if (c >= '0' && c <= '9') digit = c - '0';
			else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
			else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
			else return false;
			if (result > 0x0fffffffu)
				return false;
			result = (result << 4) | digit;
		}
		*value = result;
		return true;
	}

	static std::vector<std::string> split(const std::string& text, char separator)
	{
		std::vector<std::string> parts;
		size_t start = 0;
		while (start <= text.size())
		{
			size_t end = text.find(separator, start);
			if (end == std::string::npos)
				end = text.size();
			parts.push_back(text.substr(start, end - start));
			start = end + 1;
		}
		return parts;
	}

	static constexpr s32 MAX_FRAME = 1000000;

	static bool parseFrame(const std::string& text, s32* value)
	{
		if (text.empty() || text.size() > 7)
			return false;
		s32 result = 0;
		for (const char c : text)
		{
			if (c < '0' || c > '9')
				return false;
			result = result * 10 + (c - '0');
		}
		if (result > MAX_FRAME)
			return false;
		*value = result;
		return true;
	}

	static constexpr size_t MAX_PROBES = 1024;
	static constexpr size_t MAX_RANGES = 64;
	static constexpr u32 MAX_LENGTH = 0x10000;

	// Returns an empty string and fills `out`, or the reason the text is refused.
	std::string ParseProbes(const std::string& text, std::vector<ProbePoint>* out)
	{
		out->clear();
		if (text.empty())
			return {};
		u32 index = 0;
		for (const std::string& part : split(text, ';'))
		{
			const auto bad = [&part](const char* why) { return "bad probe \"" + part + "\": " + why; };
			const size_t equals = part.find('=');
			u32 pc = 0;
			ProbeSpec spec{index++, -1, INT_MAX, {}};
			const std::string head = part.substr(0, equals);
			const size_t at = head.find('@');
			if (!parseHex(head.substr(0, at), &pc))
				return bad("the program counter is not a hex number");
			if (at != std::string::npos)
			{
				const std::string window = head.substr(at + 1);
				const size_t dash = window.find('-');
				if (dash == std::string::npos || window.size() == 1)
					return bad("a window is @from-until, either side optional");
				const std::string from = window.substr(0, dash);
				const std::string until = window.substr(dash + 1);
				if ((!from.empty() && !parseFrame(from, &spec.from)) || (!until.empty() && !parseFrame(until, &spec.until)))
					return bad("a window's frames must be decimal, 0 to 1000000");
				if (spec.until <= spec.from)
					return bad("a window must end after it opens");
			}
			if (equals != std::string::npos)
			{
				for (const std::string& item : split(part.substr(equals + 1), ','))
				{
					ProbeRange range{};
					std::string rest = item;
					if (!rest.empty() && rest[0] == '*')
					{
						range.deref = true;
						rest = rest.substr(1);
					}
					const size_t colon = rest.find(':');
					if (colon == std::string::npos)
						return bad("a range needs \":length\"");
					if (!parseHex(rest.substr(colon + 1), &range.length) || range.length == 0 || range.length > MAX_LENGTH)
						return bad("a length must be hex, between 1 and 0x10000");
					std::string base = rest.substr(0, colon);
					const size_t plus = base.find('+');
					if (plus != std::string::npos)
					{
						if (!parseHex(base.substr(plus + 1), &range.offset))
							return bad("an offset is not a hex number");
						base = base.substr(0, plus);
					}
					range.reg = -1;
					for (int index = 0; index < 32; index++)
					{
						if (base == g_registerNames[index])
							range.reg = index;
					}
					if (range.reg < 0)
					{
						// An address must carry its 0x: "A0" or "b0" would otherwise be read as one.
						u32 absolute = 0;
						const bool prefixed = base.size() > 2 && base[0] == '0' && (base[1] == 'x' || base[1] == 'X');
						if (!prefixed || !parseHex(base, &absolute))
							return bad("a base is neither a register name nor a 0x address");
						if (plus != std::string::npos)
							return bad("an address takes no offset; write the sum");
						range.reg = 0;
						range.offset = absolute;
					}
					if (spec.ranges.size() == MAX_RANGES)
						return bad("more than 64 ranges");
					spec.ranges.push_back(range);
				}
			}
			if (spec.index == MAX_PROBES)
				return bad("more than 1024 probes");
			const auto same = std::find_if(out->begin(), out->end(), [pc](const ProbePoint& point) { return point.pc == pc; });
			if (same != out->end())
				same->specs.push_back(std::move(spec));
			else
				out->push_back(ProbePoint{pc, {std::move(spec)}});
		}
		std::sort(out->begin(), out->end(), [](const ProbePoint& a, const ProbePoint& b) { return a.pc < b.pc; });
		return {};
	}

	// Guest memory a probe may read, and a write may change: EE RAM through any of its segments,
	// and the scratchpad.
	static const u8* guest(u32 address, u32 length)
	{
		if (address >= 0x70000000u && address < 0x70000000u + Ps2MemSize::Scratch)
		{
			const u32 at = address - 0x70000000u;
			return length <= Ps2MemSize::Scratch - at ? eeMem->Scratch + at : nullptr;
		}
		const u32 physical = address >= 0x80000000u ? (address & 0x1fffffffu) : address;
		if (physical < Ps2MemSize::MainRam && length <= Ps2MemSize::MainRam - physical)
			return eeMem->Main + physical;
		return nullptr;
	}

	static constexpr size_t MAX_SCHEDULE = 4096;
	static constexpr u32 MAX_WRITE = 0x10000;

	std::string ParsePad(const std::string& text, std::vector<PadStep>* out)
	{
		out->clear();
		if (text.empty())
			return {};
		for (const std::string& part : split(text, ';'))
		{
			const auto bad = [&part](const std::string& why) { return "bad pad entry \"" + part + "\": " + why; };
			const std::vector<std::string> fields = split(part, ':');
			if (fields.size() != 3)
				return bad("an entry is frame:frames:button+button");
			PadStep step{0, 0, 0};
			if (!parseFrame(fields[0], &step.frame))
				return bad("the frame must be decimal, 0 to 1000000");
			if (!parseFrame(fields[1], &step.frames) || step.frames == 0)
				return bad("frames must be decimal, 1 to 1000000");
			for (const std::string& name : split(fields[2], '+'))
			{
				const PadButton* found = nullptr;
				for (const PadButton& button : g_padButtons)
				{
					if (name == button.name)
						found = &button;
				}
				if (!found)
				{
					std::string valid;
					for (const PadButton& button : g_padButtons)
						valid += std::string(valid.empty() ? "" : ", ") + button.name;
					return bad("unknown button \"" + name + "\"; valid: " + valid);
				}
				step.mask |= 1u << found->bind;
			}
			if (out->size() == MAX_SCHEDULE)
				return bad("more than 4096 entries");
			out->push_back(step);
		}
		return {};
	}

	static std::string parseWrites(const std::string& text, std::vector<MemoryWrite>* out)
	{
		out->clear();
		if (text.empty())
			return {};
		for (const std::string& part : split(text, ';'))
		{
			const auto bad = [&part](const std::string& why) { return "bad write \"" + part.substr(0, 64) + "\": " + why; };
			const std::vector<std::string> fields = split(part, ':');
			if (fields.size() != 3)
				return bad("a write is frame:0xaddress:hex");
			MemoryWrite write{0, 0, {}};
			if (!parseFrame(fields[0], &write.frame))
				return bad("the frame must be decimal, 0 to 1000000");
			if (!parseHex(fields[1], &write.address))
				return bad("the address is not a hex number");
			const std::string& hex = fields[2];
			if (hex.empty() || hex.size() % 2 != 0 || hex.size() > MAX_WRITE * 2)
				return bad("the bytes must be whole hex bytes, 1 to 0x10000 of them");
			for (size_t at = 0; at < hex.size(); at += 2)
			{
				u32 byte = 0;
				if (!parseHex(hex.substr(at, 2), &byte))
					return bad("the bytes are not hex");
				write.bytes.push_back(static_cast<u8>(byte));
			}
			if (!guest(write.address, static_cast<u32>(write.bytes.size())))
				return bad("the bytes do not lie inside EE RAM or the scratchpad");
			if (out->size() == MAX_SCHEDULE)
				return bad("more than 4096 writes");
			out->push_back(std::move(write));
		}
		return {};
	}

	static void appendHex(const u8* mem, u32 size)
	{
		static const char digits[] = "0123456789abcdef";
		const size_t at = s_line.size();
		s_line.resize(at + static_cast<size_t>(size) * 2);
		for (u32 index = 0; index < size; index++)
		{
			s_line[at + index * 2] = digits[mem[index] >> 4];
			s_line[at + index * 2 + 1] = digits[mem[index] & 15];
		}
	}

	static void record(u32 pc, const ProbeSpec& spec)
	{
		appendf("{\"type\":\"probe\",\"pc\":\"0x%08x\",\"probe\":%u,\"frame\":%u,\"captureFrame\":%d,\"gpr\":\"", pc, spec.index, g_FrameCount, s_captureFrame);
		for (int index = 0; index < 32; index++)
			appendf("%08x", cpuRegs.GPR.r[index].UL[0]);
		s_line += "\",\"fpr\":\"";
		for (int index = 0; index < 32; index++)
			appendf("%08x", fpuRegs.fpr[index].UL);
		s_line += "\",\"mem\":[";
		bool first = true;
		for (const ProbeRange& range : spec.ranges)
		{
			u32 address = cpuRegs.GPR.r[range.reg].UL[0] + range.offset;
			bool readable = true;
			if (range.deref)
			{
				const u8* pointer = guest(address, 4);
				readable = pointer != nullptr;
				if (readable)
					std::memcpy(&address, pointer, 4);
			}
			const u8* mem = readable ? guest(address, range.length) : nullptr;
			if (!first)
				s_line += ',';
			first = false;
			if (mem)
			{
				appendf("{\"address\":%u,\"hex\":\"", address);
				appendHex(mem, range.length);
				s_line += "\"}";
			}
			else
			{
				appendf("{\"address\":%u,\"error\":\"not readable\"}", readable ? address : 0u);
			}
		}
		s_line += "]}";
		flushLine();
	}

	static const ProbePoint* find(u32 pc)
	{
		const auto found = std::lower_bound(s_probes.begin(), s_probes.end(), pc,
			[](const ProbePoint& point, u32 value) { return point.pc < value; });
		return found == s_probes.end() || found->pc != pc ? nullptr : &*found;
	}

	void Exec(u32 pc)
	{
		const ProbePoint* point = find(pc);
		if (!point || !onCpuThread())
			return;
		for (const ProbeSpec& spec : point->specs)
		{
			if (s_captureFrame >= spec.from && s_captureFrame < spec.until)
				record(pc, spec);
		}
	}

	bool IsRecProbe(u32 pc)
	{
		return g_recProbing && find(pc) != nullptr;
	}

	// A breakpoint check the recompiler compiled at pc: for a probe there, or for one in the
	// delay slot of the branch at pc. Registers are flushed before the check runs.
	void RecCheck(u32 pc)
	{
		Exec(pc);
		if (find(pc + 4) && (R5900::GetInstruction(memRead32(pc)).flags & IS_BRANCH))
			Exec(pc + 4);
	}

	int RecProbeFlags(u32 addr, bool branch)
	{
		return (IsRecProbe(addr) ? 1 : 0) | (branch && IsRecProbe(addr + 4) ? 2 : 0);
	}

	bool RecProbeOnly(u32 pc)
	{
		if (!g_recProbing)
			return false;
		RecCheck(pc);
		return !CBreakPoints::IsAddressBreakPoint(BREAKPOINT_EE, pc) && !CBreakPoints::IsAddressBreakPoint(BREAKPOINT_EE, pc + 4);
	}

	std::string Start(const std::string& path, const std::string& probes, bool recompiled, bool context,
		const std::string& pad, const std::string& writes)
	{
		if (s_file)
			return "a trace is already being recorded";
		if (recompiled && !CHECK_EEREC)
			return "a state capture runs under the EE recompiler; launch without the interpreter option";
		if (!recompiled && CHECK_EEREC)
			return "the EE recompiler is on, and under it the EE registers are not current when data is sent; launch with the interpreter option";
		if (!recompiled && REC_VU1)
			return "the VU1 recompiler is on, and under it the VU1 program counter is not current; launch with the interpreter option";
		std::vector<ProbePoint> points;
		std::vector<PadStep> steps;
		std::vector<MemoryWrite> patches;
		for (const std::string& refused : {ParseProbes(probes, &points), ParsePad(pad, &steps), parseWrites(writes, &patches)})
		{
			if (!refused.empty())
				return refused;
		}
		s_file = FileSystem::OpenCFile(path.c_str(), "wb");
		if (!s_file)
			return "cannot open " + path;
		s_probes = std::move(points);
		s_probeText = probes;
		s_pad = std::move(steps);
		s_writes = std::move(patches);
		s_padText = pad;
		s_writeText = writes;
		s_captureFrame = -1;
		s_padHeld = 0;
		s_recompiled = recompiled;
		s_context = context && !recompiled;

		s_thread = std::this_thread::get_id();
		s_error.clear();
		s_line.clear();
		s_packets = 0;
		s_nextOrigin = 1;
		s_origin[1] = s_origin[2] = 0;

		appendf("{\"type\":\"header\",\"version\":1,\"frame\":%u,\"recompiler\":%s,\"context\":%s,\"probes\":\"", g_FrameCount,
			recompiled ? "true" : "false", s_context ? "true" : "false");
		s_line += s_probeText;
		s_line += '"';
		if (!s_padText.empty())
			s_line += ",\"pad\":\"" + s_padText + '"';
		if (!s_writeText.empty())
			s_line += ",\"writes\":\"" + s_writeText + '"';
		s_line += '}';
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
		g_probing = !recompiled && !s_probes.empty();
		if (recompiled && !s_probes.empty())
		{
			// Blocks compiled before have no check at the probes: throw them away.
			g_recProbing = true;
			Cpu->Reset();
		}
		return {};
	}

	static void appendButtons(const char* key, u32 mask)
	{
		appendf(",\"%s\":[", key);
		bool first = true;
		for (const PadButton& button : g_padButtons)
		{
			if (!(mask & (1u << button.bind)))
				continue;
			appendf("%s\"%s\"", first ? "" : ",", button.name);
			first = false;
		}
		s_line += ']';
	}

	// Moves the buttons the schedule holds to `wanted`, recording the change while the trace can.
	static void setPad(u32 wanted)
	{
		const u32 changed = wanted ^ s_padHeld;
		if (changed == 0)
			return;
		for (const PadButton& button : g_padButtons)
		{
			if (changed & (1u << button.bind))
				Pad::SetControllerState(0, button.bind, (wanted & (1u << button.bind)) ? 1.0f : 0.0f);
		}
		s_padHeld = wanted;
		if (!s_error.empty())
			return;
		appendf("{\"type\":\"pad\",\"captureFrame\":%d,\"frame\":%u", s_captureFrame, g_FrameCount);
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
		u32 wanted = 0;
		for (const PadStep& step : s_pad)
		{
			if (s_captureFrame >= step.frame && s_captureFrame - step.frame < step.frames)
				wanted |= step.mask;
		}
		setPad(wanted);
		for (const MemoryWrite& write : s_writes)
		{
			if (write.frame != s_captureFrame)
				continue;
			const u32 size = static_cast<u32>(write.bytes.size());
			u8* mem = const_cast<u8*>(guest(write.address, size));
			std::memcpy(mem, write.bytes.data(), size);
			if (mem >= eeMem->Main && mem < eeMem->Main + Ps2MemSize::MainRam)
			{
				// Blocks the recompiler compiled from these bytes are stale: a write here is a patch.
				const u32 physical = static_cast<u32>(mem - eeMem->Main);
				Cpu->Clear(physical & ~3u, ((physical & 3u) + size + 3) / 4);
			}
			appendf("{\"type\":\"write\",\"captureFrame\":%d,\"frame\":%u,\"address\":\"0x%08x\",\"hex\":\"", s_captureFrame, g_FrameCount, write.address);
			appendHex(write.bytes.data(), size);
			s_line += "\"}";
			flushLine();
		}
	}

	std::string Stop(u64* packets)
	{
		if (!s_file)
			return "no trace is being recorded";
		// Buttons the schedule still holds come up with the capture.
		setPad(0);
		g_active = false;
		g_probing = false;
		if (g_recProbing)
		{
			g_recProbing = false;
			Cpu->Reset();
		}
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
		if (s_context)
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
				if (s_context)
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
		if (transferType == GIF_TRANS_XGKICK && !REC_VU1)
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
		appendf("{\"type\":\"packet\",\"path\":%u,\"size\":%u,\"pending\":%u,\"hex\":\"", path + 1, size, pending);
		appendHex(mem, size);
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
