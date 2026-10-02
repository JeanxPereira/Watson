// SPDX-FileCopyrightText: 2026 PS2Recomp Debug Bridge
// SPDX-License-Identifier: MIT
//
// PCSX2 Debug Server — JSON/TCP API wrapping full DebugInterface
// Protocol: newline-delimited JSON over TCP (port 21512)
//
// Request:  {"cmd":"read_registers","cpu":"ee","category":0}\n
// Response: {"ok":true,"data":{...}}\n
//
// Integration:
//   1. Drop DebugServer.h + DebugServer.cpp into pcsx2/DebugTools/
//   2. Add to CMakeLists.txt
//   3. Call DebugServer::Start() from VMManager::Initialize()
//   4. Call DebugServer::Stop() from VMManager::Shutdown()
//   5. Call DebugServer::OnBreakpointHit() from breakpoint handler

// ============================================================
// NOTE: This file uses a minimal inline JSON builder to avoid
// external dependencies. PCSX2 doesn't bundle nlohmann/json
// in all configurations.
// ============================================================

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
typedef SOCKET socket_t;
#define SOCKET_INVALID INVALID_SOCKET
#define CLOSE_SOCKET closesocket
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
typedef int socket_t;
#define SOCKET_INVALID (-1)
#define CLOSE_SOCKET close
#endif

#include "DebugServer.h"
#include "GifTrace.h"
#include "DebugInterface.h"
#include "Breakpoints.h"
#include "MipsStackWalk.h"
#include "Config.h"
#include "Host.h"
#include "VMManager.h"
#include "Counters.h"
#include "MTGS.h"
#include "GS/GS.h"
#include "SIO/Pad/Pad.h"
#include "SIO/Pad/PadDualshock2.h"
#include "common/Error.h"
#include "common/FileSystem.h"

#include <cstring>
#include <cstdio>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>
#include <future>
#include <memory>
#include <functional>
#include <condition_variable>
#include <sstream>
#include <algorithm>

// Forward declarations — these are PCSX2 globals
extern R5900DebugInterface r5900Debug;
extern R3000DebugInterface r3000Debug;

namespace DebugServer
{
	// ============================================================
	// Minimal JSON Builder
	// ============================================================
	class JsonBuilder
	{
	public:
		void startObject() { comma(); m_buf += '{'; m_needComma.push_back(false); }
		void endObject() { m_buf += '}'; m_needComma.pop_back(); if (!m_needComma.empty()) m_needComma.back() = true; }
		void startArray() { comma(); m_buf += '['; m_needComma.push_back(false); }
		void endArray() { m_buf += ']'; m_needComma.pop_back(); if (!m_needComma.empty()) m_needComma.back() = true; }

		void key(const char* k)
		{
			comma();
			m_buf += '"';
			escapeStr(k);
			m_buf += "\":";
			m_needComma.back() = false; // value follows
		}

		void valStr(const char* v) { comma(); m_buf += '"'; escapeStr(v); m_buf += '"'; m_needComma.back() = true; }
		void valStr(const std::string& v) { valStr(v.c_str()); }
		void valInt(int64_t v) { comma(); m_buf += std::to_string(v); m_needComma.back() = true; }
		void valUint(uint64_t v) { comma(); m_buf += std::to_string(v); m_needComma.back() = true; }
		void valBool(bool v) { comma(); m_buf += v ? "true" : "false"; m_needComma.back() = true; }
		void valNull() { comma(); m_buf += "null"; m_needComma.back() = true; }

		void valHex32(uint32_t v)
		{
			char buf[16];
			snprintf(buf, sizeof(buf), "0x%08x", v);
			comma();
			m_buf += '"';
			m_buf += buf;
			m_buf += '"';
			m_needComma.back() = true;
		}

		void valHex128(u128 v)
		{
			char buf[40];
			snprintf(buf, sizeof(buf), "%08x%08x%08x%08x",
				v._u32[3], v._u32[2], v._u32[1], v._u32[0]);
			comma();
			m_buf += '"';
			m_buf += buf;
			m_buf += '"';
			m_needComma.back() = true;
		}

		// Key-value shortcuts
		void kv(const char* k, const char* v) { key(k); valStr(v); }
		void kv(const char* k, const std::string& v) { key(k); valStr(v); }
		void kv(const char* k, int v) { key(k); valInt(static_cast<int64_t>(v)); }
		void kv(const char* k, unsigned int v) { key(k); valUint(static_cast<uint64_t>(v)); }
		void kv(const char* k, int64_t v) { key(k); valInt(v); }
		void kv(const char* k, uint64_t v) { key(k); valUint(v); }
		void kv(const char* k, bool v) { key(k); valBool(v); }

		std::string str() const { return m_buf; }
		void clear() { m_buf.clear(); m_needComma.clear(); }

	private:
		void comma()
		{
			if (!m_needComma.empty() && m_needComma.back())
				m_buf += ',';
		}
		void escapeStr(const char* s)
		{
			for (; *s; ++s)
			{
				switch (*s)
				{
					case '"': m_buf += "\\\""; break;
					case '\\': m_buf += "\\\\"; break;
					case '\n': m_buf += "\\n"; break;
					case '\r': m_buf += "\\r"; break;
					case '\t': m_buf += "\\t"; break;
					default: m_buf += *s; break;
				}
			}
		}

		std::string m_buf;
		std::vector<bool> m_needComma;
	};

	// ============================================================
	// Minimal JSON Parser (just enough for our commands)
	// ============================================================
	struct JsonValue
	{
		enum Type { NONE, STRING, NUMBER, BOOL, OBJECT };
		Type type = NONE;
		std::string strVal;
		int64_t numVal = 0;
		bool boolVal = false;
	};

	static std::unordered_map<std::string, JsonValue> parseJsonObject(const std::string& json)
	{
		std::unordered_map<std::string, JsonValue> result;
		size_t i = 0;
		// Skip to first '{'
		while (i < json.size() && json[i] != '{') i++;
		i++; // skip '{'

		while (i < json.size())
		{
			// Skip whitespace/commas
			while (i < json.size() && (json[i] == ' ' || json[i] == '\t' || json[i] == '\n' || json[i] == '\r' || json[i] == ','))
				i++;
			if (i >= json.size() || json[i] == '}') break;

			// Read key
			if (json[i] != '"') break;
			i++;
			std::string key;
			while (i < json.size() && json[i] != '"')
			{
				if (json[i] == '\\' && i + 1 < json.size()) { key += json[i + 1]; i += 2; }
				else { key += json[i]; i++; }
			}
			i++; // skip closing '"'

			// Skip colon
			while (i < json.size() && json[i] != ':') i++;
			i++;

			// Skip whitespace
			while (i < json.size() && (json[i] == ' ' || json[i] == '\t')) i++;

			JsonValue val;
			if (json[i] == '"')
			{
				// String value
				i++;
				std::string sv;
				while (i < json.size() && json[i] != '"')
				{
					if (json[i] == '\\' && i + 1 < json.size()) { sv += json[i + 1]; i += 2; }
					else { sv += json[i]; i++; }
				}
				i++; // skip closing '"'
				val.type = JsonValue::STRING;
				val.strVal = sv;
			}
			else if (json[i] == 't' || json[i] == 'f')
			{
				val.type = JsonValue::BOOL;
				val.boolVal = (json[i] == 't');
				while (i < json.size() && json[i] != ',' && json[i] != '}') i++;
			}
			else if (json[i] == '-' || (json[i] >= '0' && json[i] <= '9'))
			{
				std::string ns;
				bool isHex = false;
				if (json[i] == '0' && i + 1 < json.size() && (json[i + 1] == 'x' || json[i + 1] == 'X'))
				{
					isHex = true;
					i += 2;
				}
				while (i < json.size() && ((json[i] >= '0' && json[i] <= '9') ||
					   json[i] == '-' ||
					   (isHex && ((json[i] >= 'a' && json[i] <= 'f') || (json[i] >= 'A' && json[i] <= 'F')))))
				{
					ns += json[i]; i++;
				}
				val.type = JsonValue::NUMBER;
				if (isHex) val.numVal = (int64_t)strtoull(ns.c_str(), nullptr, 16);
				else val.numVal = strtoll(ns.c_str(), nullptr, 10);
			}
			else
			{
				// Skip unknown
				while (i < json.size() && json[i] != ',' && json[i] != '}') i++;
			}

			result[key] = val;
		}

		return result;
	}

	static std::string getStr(const std::unordered_map<std::string, JsonValue>& m, const char* key, const char* def = "")
	{
		auto it = m.find(key);
		if (it != m.end() && it->second.type == JsonValue::STRING) return it->second.strVal;
		return def;
	}

	static int64_t getNum(const std::unordered_map<std::string, JsonValue>& m, const char* key, int64_t def = 0)
	{
		auto it = m.find(key);
		if (it != m.end() && it->second.type == JsonValue::NUMBER) return it->second.numVal;
		// Also try parsing string as hex
		if (it != m.end() && it->second.type == JsonValue::STRING)
		{
			const auto& s = it->second.strVal;
			if (s.size() > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X'))
				return (int64_t)strtoull(s.c_str() + 2, nullptr, 16);
			return strtoll(s.c_str(), nullptr, 10);
		}
		return def;
	}

	static bool getBool(const std::unordered_map<std::string, JsonValue>& m, const char* key, bool def = false)
	{
		auto it = m.find(key);
		if (it != m.end() && it->second.type == JsonValue::BOOL) return it->second.boolVal;
		return def;
	}

	// ============================================================
	// Get DebugInterface by CPU name
	// ============================================================
	static DebugInterface* getCpu(const std::string& name)
	{
		if (name == "iop" || name == "r3000" || name == "IOP")
			return &r3000Debug;
		return &r5900Debug; // default to EE
	}

	static BreakPointCpu getBpCpu(const std::string& name)
	{
		if (name == "iop" || name == "r3000" || name == "IOP")
			return BREAKPOINT_IOP;
		return BREAKPOINT_EE;
	}

	// ============================================================
	// Command Handlers
	// ============================================================

	static std::atomic<bool> s_running{false};

	// Runs fn on the CPU thread and waits for it. The CPU thread owns the recompiler and the
	// breakpoint tables; touching them from the socket thread races it. The wait is bounded and
	// watches s_running so a client thread can never keep Stop() from joining it.
	//
	// A call that is given up on is cancelled: the queued function checks the flag first and
	// does nothing, so a command reported as failed cannot take effect later, and nothing runs
	// after the emulator has torn its memory down. A call already executing cannot be cancelled;
	// that case is reported as still running.
	enum class CpuRun { Done, Cancelled, StillRunning };

	static CpuRun runOnCpuThread(std::function<void()> fn, int timeoutMs = 5000)
	{
		struct Call
		{
			std::promise<void> done;
			std::atomic<bool> abandoned{false};
			std::atomic<bool> started{false};
		};
		auto call = std::make_shared<Call>();
		std::future<void> finished = call->done.get_future();
		Host::RunOnCPUThread([fn = std::move(fn), call]() {
			call->started.store(true);
			if (!call->abandoned.load())
				fn();
			call->done.set_value();
		});
		const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
		while (std::chrono::steady_clock::now() < deadline && s_running.load())
		{
			if (finished.wait_for(std::chrono::milliseconds(20)) == std::future_status::ready)
				return CpuRun::Done;
		}
		call->abandoned.store(true);
		return call->started.load() ? CpuRun::StillRunning : CpuRun::Cancelled;
	}

	static std::string cpuRunFailure(CpuRun run, const std::string& what)
	{
		return run == CpuRun::StillRunning
			? "the CPU thread is still running " + what + "; it may yet take effect"
			: "the CPU thread did not run " + what + " in time; it was cancelled";
	}

	static bool waitUntilPaused(DebugInterface* cpu, int timeoutMs)
	{
		const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
		while (std::chrono::steady_clock::now() < deadline)
		{
			if (cpu->isCpuPaused())
				return true;
			if (!s_running.load())
				return false;
			std::this_thread::sleep_for(std::chrono::milliseconds(1));
		}
		return cpu->isCpuPaused();
	}

	static std::string errorReply(const std::string& message)
	{
		JsonBuilder j;
		j.startObject();
		j.kv("ok", false);
		j.kv("error", message);
		j.endObject();
		return j.str();
	}

	// Paths cross the wire with forward slashes because this JSON reader does not unescape
	// backslashes. PCSX2 opens files through the \\?\ extended-length form, which takes no
	// forward slash, so a path is made native before PCSX2 sees it.
	static std::string wirePath(const std::unordered_map<std::string, JsonValue>& m, const char* key)
	{
		std::string path = getStr(m, key, "");
#ifdef _WIN32
		std::replace(path.begin(), path.end(), '/', '\\');
#endif
		return path;
	}

	struct PadButton { const char* name; u32 bind; };
	static const PadButton s_padButtons[] = {
		{"up", PadDualshock2::Inputs::PAD_UP}, {"right", PadDualshock2::Inputs::PAD_RIGHT},
		{"down", PadDualshock2::Inputs::PAD_DOWN}, {"left", PadDualshock2::Inputs::PAD_LEFT},
		{"triangle", PadDualshock2::Inputs::PAD_TRIANGLE}, {"circle", PadDualshock2::Inputs::PAD_CIRCLE},
		{"cross", PadDualshock2::Inputs::PAD_CROSS}, {"square", PadDualshock2::Inputs::PAD_SQUARE},
		{"select", PadDualshock2::Inputs::PAD_SELECT}, {"start", PadDualshock2::Inputs::PAD_START},
		{"l1", PadDualshock2::Inputs::PAD_L1}, {"l2", PadDualshock2::Inputs::PAD_L2},
		{"r1", PadDualshock2::Inputs::PAD_R1}, {"r2", PadDualshock2::Inputs::PAD_R2},
		{"l3", PadDualshock2::Inputs::PAD_L3}, {"r3", PadDualshock2::Inputs::PAD_R3},
	};

	static std::string handleOnCpuThread(const std::string& jsonLine)
	{
		auto params = parseJsonObject(jsonLine);
		std::string cmd = getStr(params, "cmd");
		std::string cpuName = getStr(params, "cpu", "ee");
		DebugInterface* cpu = getCpu(cpuName);

		JsonBuilder j;

		// ----- STATUS -----
		if (cmd == "status")
		{
			j.startObject();
			j.kv("ok", true);
			j.key("data"); j.startObject();
			j.kv("alive", cpu->isAlive());
			j.kv("paused", cpu->isCpuPaused());
			j.key("pc"); j.valHex32(cpu->getPC());
			j.kv("cycles", (int64_t)cpu->getCycles());
			j.kv("frame", (int64_t)g_FrameCount);
			j.kv("interpreter", GifTrace::InterpretersActive());
			j.endObject();
			j.endObject();
		}
		// ----- READ REGISTERS (ALL) -----
		else if (cmd == "read_registers")
		{
			int cat = (int)getNum(params, "category", -1);
			j.startObject();
			j.kv("ok", true);
			j.key("data"); j.startObject();

			int catStart = (cat >= 0) ? cat : 0;
			int catEnd = (cat >= 0) ? cat + 1 : cpu->getRegisterCategoryCount();

			for (int c = catStart; c < catEnd; c++)
			{
				j.key(cpu->getRegisterCategoryName(c));
				j.startObject();
				j.kv("size", cpu->getRegisterSize(c));
				j.kv("count", cpu->getRegisterCount(c));
				j.key("regs"); j.startArray();
				for (int r = 0; r < cpu->getRegisterCount(c); r++)
				{
					j.startObject();
					j.kv("name", cpu->getRegisterName(c, r));
					j.key("value"); j.valHex128(cpu->getRegister(c, r));
					j.kv("display", cpu->getRegisterString(c, r));
					j.endObject();
				}
				j.endArray();
				j.endObject();
			}

			j.key("pc"); j.valHex32(cpu->getPC());
			j.key("hi"); j.valHex128(cpu->getHI());
			j.key("lo"); j.valHex128(cpu->getLO());
			j.endObject();
			j.endObject();
		}
		// ----- WRITE REGISTER -----
		else if (cmd == "write_register")
		{
			int cat = (int)getNum(params, "category", 0);
			int num = (int)getNum(params, "index", 0);
			// Value can be a hex string or number
			std::string valStr = getStr(params, "value", "0");
			u128 newVal = {};
			// Parse hex string (up to 128-bit)
			if (valStr.size() > 2 && valStr[0] == '0' && (valStr[1] == 'x' || valStr[1] == 'X'))
				valStr = valStr.substr(2);
			// Pad to 32 hex chars (128 bits)
			while (valStr.size() < 32) valStr = "0" + valStr;
			for (int i = 0; i < 4; i++)
			{
				std::string part = valStr.substr(24 - i * 8, 8);
				newVal._u32[i] = (uint32_t)strtoul(part.c_str(), nullptr, 16);
			}
			cpu->setRegister(cat, num, newVal);

			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- SET PC -----
		else if (cmd == "set_pc")
		{
			u32 pc = (u32)getNum(params, "value", 0);
			cpu->setPc(pc);
			j.startObject();
			j.kv("ok", true);
			j.key("pc"); j.valHex32(pc);
			j.endObject();
		}
		// ----- READ MEMORY -----
		else if (cmd == "read_memory")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			int len = (int)getNum(params, "length", 256);
			if (len > 65536) len = 65536;

			j.startObject();
			j.kv("ok", true);
			j.key("address"); j.valHex32(addr);
			j.kv("length", (int64_t)len);

			// Hex string output
			j.key("hex");
			std::string hexStr;
			hexStr.reserve(len * 2);
			for (int i = 0; i < len; i++)
			{
				bool valid = true;
				u32 byte = cpu->Read8(addr + i, &valid);
				if (!valid) byte = 0;
				char hb[4];
				snprintf(hb, sizeof(hb), "%02x", byte & 0xFF);
				hexStr += hb;
			}
			j.valStr(hexStr);
			j.endObject();
		}
		// ----- WRITE MEMORY -----
		else if (cmd == "write_memory")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			std::string hexData = getStr(params, "data", "");
			int written = 0;
			for (size_t i = 0; i + 1 < hexData.size(); i += 2)
			{
				u8 byte = (u8)strtoul(hexData.substr(i, 2).c_str(), nullptr, 16);
				cpu->Write8(addr + written, byte);
				written++;
			}
			j.startObject();
			j.kv("ok", true);
			j.kv("written", (int64_t)written);
			j.endObject();
		}
		// ----- DISASSEMBLE -----
		else if (cmd == "disassemble")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			int count = (int)getNum(params, "count", 20);
			bool simplify = getBool(params, "simplify", true);
			if (count > 500) count = 500;

			j.startObject();
			j.kv("ok", true);
			j.key("instructions"); j.startArray();
			for (int i = 0; i < count; i++)
			{
				u32 pc = addr + i * 4;
				if (!cpu->isValidAddress(pc)) break;

				bool valid = true;
				u32 opcode = cpu->Read32(pc, &valid);

				j.startObject();
				j.key("address"); j.valHex32(pc);
				j.key("opcode"); j.valHex32(opcode);
				j.kv("disasm", cpu->disasm(pc, simplify));
				j.endObject();
			}
			j.endArray();
			j.endObject();
		}
		// ----- EVALUATE EXPRESSION -----
		else if (cmd == "evaluate")
		{
			std::string expr = getStr(params, "expression", "0");
			u64 result = 0;
			std::string error;
			bool ok = cpu->evaluateExpression(expr.c_str(), result, error);

			j.startObject();
			j.kv("ok", ok);
			if (ok)
			{
				j.key("result"); j.valUint(result);
				char hexBuf[20];
				snprintf(hexBuf, sizeof(hexBuf), "0x%llx", (unsigned long long)result);
				j.kv("hex", hexBuf);
			}
			else
			{
				j.kv("error", error);
			}
			j.endObject();
		}
		// ----- SET BREAKPOINT -----
		else if (cmd == "set_breakpoint")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			bool temp = getBool(params, "temporary", false);
			bool enabled = getBool(params, "enabled", true);
			std::string condExpr = getStr(params, "condition", "");
			std::string desc = getStr(params, "description", "");
			auto bpCpu = getBpCpu(cpuName);

			CBreakPoints::AddBreakPoint(bpCpu, addr, temp, enabled);

			if (!desc.empty())
				CBreakPoints::ChangeBreakPointDescription(bpCpu, addr, desc);

			if (!condExpr.empty())
			{
				BreakPointCond cond;
				cond.debug = cpu;
				cond.expressionString = condExpr;
				std::string error;
				if (cpu->initExpression(condExpr.c_str(), cond.expression, error))
				{
					CBreakPoints::ChangeBreakPointAddCond(bpCpu, addr, cond);
				}
			}

			j.startObject();
			j.kv("ok", true);
			j.key("address"); j.valHex32(addr);
			j.endObject();
		}
		// ----- REMOVE BREAKPOINT -----
		else if (cmd == "remove_breakpoint")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			CBreakPoints::RemoveBreakPoint(getBpCpu(cpuName), addr);
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- SET MEMCHECK (WATCHPOINT) -----
		else if (cmd == "set_memcheck")
		{
			u32 start = (u32)getNum(params, "address", 0);
			u32 end = (u32)getNum(params, "end", start + 4);
			std::string typeStr = getStr(params, "type", "write");
			std::string actionStr = getStr(params, "action", "break");
			std::string desc = getStr(params, "description", "");
			std::string condExpr = getStr(params, "condition", "");

			MemCheckCondition cond = MEMCHECK_WRITE;
			if (typeStr == "read") cond = MEMCHECK_READ;
			else if (typeStr == "readwrite" || typeStr == "access") cond = MEMCHECK_READWRITE;
			else if (typeStr == "onchange") cond = (MemCheckCondition)(MEMCHECK_WRITE | MEMCHECK_WRITE_ONCHANGE);

			// PCSX2 removed MEMCHECK_LOG. A memcheck whose result has no break bit is skipped by
			// both the recompiler and the interpreter and never counts a hit, so accepting "log"
			// would report a watchpoint that can only ever show zero hits.
			if (actionStr == "log")
			{
				j.startObject();
				j.kv("ok", false);
				j.kv("error", std::string("log watchpoints are not supported by this PCSX2; use action break"));
				j.endObject();
				return j.str();
			}

			MemCheckResult result = MEMCHECK_BREAK;
			if (actionStr == "both") result = MEMCHECK_BOTH;

			auto bpCpu = getBpCpu(cpuName);
			CBreakPoints::AddMemCheck(bpCpu, start, end, cond, result);

			if (!desc.empty())
				CBreakPoints::ChangeMemCheckDescription(bpCpu, start, end, desc);

			if (!condExpr.empty())
			{
				BreakPointCond bpCond;
				bpCond.debug = cpu;
				bpCond.expressionString = condExpr;
				std::string error;
				if (cpu->initExpression(condExpr.c_str(), bpCond.expression, error))
					CBreakPoints::ChangeMemCheckAddCond(bpCpu, start, end, bpCond);
			}

			j.startObject();
			j.kv("ok", true);
			j.key("start"); j.valHex32(start);
			j.key("end"); j.valHex32(end);
			j.endObject();
		}
		// ----- REMOVE MEMCHECK -----
		else if (cmd == "remove_memcheck")
		{
			u32 start = (u32)getNum(params, "address", 0);
			u32 end = (u32)getNum(params, "end", start + 4);
			CBreakPoints::RemoveMemCheck(getBpCpu(cpuName), start, end);
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- LIST BREAKPOINTS -----
		else if (cmd == "list_breakpoints")
		{
			auto bps = CBreakPoints::GetBreakpoints(getBpCpu(cpuName), true);
			j.startObject();
			j.kv("ok", true);
			j.key("breakpoints"); j.startArray();
			for (const auto& bp : bps)
			{
				j.startObject();
				j.key("address"); j.valHex32(bp.addr);
				j.kv("enabled", bp.enabled);
				j.kv("temporary", bp.temporary);
				j.kv("stepping", bp.stepping);
				j.kv("has_condition", bp.hasCond);
				if (bp.hasCond)
					j.kv("condition", bp.cond.expressionString);
				if (!bp.description.empty())
					j.kv("description", bp.description);
				j.endObject();
			}
			j.endArray();
			j.endObject();
		}
		// ----- LIST MEMCHECKS -----
		else if (cmd == "list_memchecks")
		{
			auto mcs = CBreakPoints::GetMemChecks(getBpCpu(cpuName));
			j.startObject();
			j.kv("ok", true);
			j.key("memchecks"); j.startArray();
			for (const auto& mc : mcs)
			{
				j.startObject();
				j.key("start"); j.valHex32(mc.start);
				j.key("end"); j.valHex32(mc.end);
				j.kv("hits", (int64_t)mc.totalHits);
				j.key("last_pc"); j.valHex32(mc.lastPC);
				j.key("last_addr"); j.valHex32(mc.lastAddr);
				if (!mc.description.empty())
					j.kv("description", mc.description);
				j.endObject();
			}
			j.endArray();
			j.endObject();
		}
		// ----- PAUSE -----
		else if (cmd == "pause")
		{
			cpu->pauseCpu();
			j.startObject();
			j.kv("ok", true);
			j.key("pc"); j.valHex32(cpu->getPC());
			j.endObject();
		}
		// ----- RESUME -----
		else if (cmd == "resume")
		{
			// Skip current BP if we're sitting on one (matches PCSX2 GUI behavior)
			CBreakPoints::SetSkipFirst(getBpCpu(cpuName), cpu->getPC());
			cpu->resumeCpu();
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- GET THREADS -----
		else if (cmd == "get_threads")
		{
			auto threads = cpu->GetThreadList();
			j.startObject();
			j.kv("ok", true);
			j.key("threads"); j.startArray();
			for (const auto& t : threads)
			{
				j.startObject();
				j.kv("id", (int64_t)t->TID());
				j.key("pc"); j.valHex32(t->PC());
				j.kv("status", (int64_t)(int)t->Status());
				j.kv("wait_type", (int64_t)(int)t->Wait());
				j.endObject();
			}
			j.endArray();
			j.endObject();
		}
		// ----- GET MODULES (IOP only) -----
		else if (cmd == "get_modules")
		{
			auto mods = cpu->GetModuleList();
			j.startObject();
			j.kv("ok", true);
			j.key("modules"); j.startArray();
			for (const auto& m : mods)
			{
				j.startObject();
				j.kv("name", m.name);
				j.kv("version", (int64_t)m.version);
				j.endObject();
			}
			j.endArray();
			j.endObject();
		}
		// ----- GET BACKTRACE -----
		else if (cmd == "get_backtrace")
		{
			int maxFrames = (int)getNum(params, "max_frames", 32);
			if (maxFrames > 128) maxFrames = 128;

			u32 pc = cpu->getPC();
			u32 ra = cpu->getRegister(0, 31); // $ra
			u32 sp = cpu->getRegister(0, 29); // $sp

			// Find the running thread to get entry point and stack top
			u32 threadEntry = 0;
			auto threads = cpu->GetThreadList();
			for (const auto& t : threads)
			{
				if (t->Status() == ThreadStatus::THS_RUN)
				{
					threadEntry = t->EntryPoint();
					break;
				}
			}

			auto frames = MipsStackWalk::Walk(cpu, pc, ra, sp, threadEntry);

			j.startObject();
			j.kv("ok", true);
			j.kv("frame_count", (int64_t)(std::min)((int)frames.size(), maxFrames));
			j.key("frames"); j.startArray();
			int count = 0;
			for (const auto& f : frames)
			{
				if (count >= maxFrames) break;
				j.startObject();
				j.key("entry"); j.valHex32(f.entry);
				j.key("pc"); j.valHex32(f.pc);
				j.key("sp"); j.valHex32(f.sp);
				j.kv("stack_size", (int64_t)f.stackSize);
				j.kv("disasm", cpu->disasm(f.pc, true));
				j.endObject();
				count++;
			}
			j.endArray();
			j.endObject();
		}
		// ----- IS VALID ADDRESS -----
		else if (cmd == "is_valid_address")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			j.startObject();
			j.kv("ok", true);
			j.kv("valid", cpu->isValidAddress(addr));
			j.endObject();
		}
		// ----- READ STRING -----
		else if (cmd == "read_string")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			int maxLen = (int)getNum(params, "max_length", 256);
			if (maxLen > 4096) maxLen = 4096;

			std::string str;
			for (int i = 0; i < maxLen; i++)
			{
				bool valid = true;
				u32 byte = cpu->Read8(addr + i, &valid);
				if (!valid || byte == 0) break;
				str += (char)byte;
			}

			j.startObject();
			j.kv("ok", true);
			j.kv("string", str);
			j.kv("length", (int64_t)str.size());
			j.endObject();
		}
		// ----- CLEAR ALL BREAKPOINTS -----
		else if (cmd == "clear_breakpoints")
		{
			CBreakPoints::ClearAllBreakPoints();
			CBreakPoints::ClearAllMemChecks();
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- PAD SET -----
		else if (cmd == "pad_set")
		{
			const std::string list = getStr(params, "buttons", "");
			const float value = getNum(params, "value", 1) != 0 ? 1.0f : 0.0f;
			std::vector<u32> binds;
			std::string unknown;
			size_t start = 0;
			while (start <= list.size())
			{
				size_t end = list.find(',', start);
				if (end == std::string::npos) end = list.size();
				const std::string name = list.substr(start, end - start);
				start = end + 1;
				if (name.empty()) continue;
				bool found = false;
				for (const PadButton& button : s_padButtons)
					if (name == button.name) { binds.push_back(button.bind); found = true; break; }
				if (!found) unknown = name;
			}
			if (!unknown.empty() || binds.empty())
			{
				std::string valid;
				for (const PadButton& button : s_padButtons)
					valid += std::string(valid.empty() ? "" : ", ") + button.name;
				return errorReply((unknown.empty() ? std::string("no buttons given") : "unknown button " + unknown) + "; valid: " + valid);
			}
			for (const u32 bind : binds)
				Pad::SetControllerState(0, bind, value);
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- QUEUE SNAPSHOT -----
		else if (cmd == "queue_snapshot")
		{
			const std::string path = wirePath(params, "path");
			const u32 dumpFrames = (u32)getNum(params, "dump_frames", 0);
			if (path.size() < 5 || path.substr(path.size() - 4) != ".png")
				return errorReply("path must end in .png");
			MTGS::RunOnGSThread([path, dumpFrames]() { GSQueueSnapshot(path, dumpFrames); });
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- SAVE STATE FILE -----
		else if (cmd == "save_state_file")
		{
			const std::string path = wirePath(params, "path");
			if (path.empty())
				return errorReply("path is required");
			auto failure = std::make_shared<std::string>();
			VMManager::SaveState(path.c_str(), false, false, [failure](const std::string& message) { *failure = message; });
			if (!failure->empty())
				return errorReply("save state failed: " + *failure);
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- LOAD STATE FILE -----
		else if (cmd == "load_state_file")
		{
			const std::string path = wirePath(params, "path");
			if (!FileSystem::FileExists(path.c_str()))
				return errorReply("no state file at " + path);
			// PCSX2 resets the VM whenever a load fails part-way: the position is lost.
			Error error;
			if (!VMManager::LoadState(path.c_str(), &error))
				return errorReply("load state failed and PCSX2 reset the VM: " + error.GetDescription());
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- GIF TRACE -----
		else if (cmd == "gif_trace_start")
		{
			const std::string path = wirePath(params, "path");
			if (path.empty())
				return errorReply("path is required");
			const std::string refused = GifTrace::Start(path);
			if (!refused.empty())
				return errorReply(refused);
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		else if (cmd == "gif_trace_stop")
		{
			u64 packets = 0;
			const std::string failed = GifTrace::Stop(&packets);
			if (!failed.empty())
				return errorReply(failed);
			j.startObject();
			j.kv("ok", true);
			j.kv("packets", (int64_t)packets);
			j.endObject();
		}
		// ----- UNKNOWN COMMAND -----
		else
		{
			j.startObject();
			j.kv("ok", false);
			j.kv("error", "Unknown command: " + cmd);
			j.key("available_commands"); j.startArray();
			const char* cmds[] = {
				"status", "read_registers", "write_register", "set_pc",
				"read_memory", "write_memory", "read_string",
				"disassemble", "evaluate",
				"set_breakpoint", "remove_breakpoint", "list_breakpoints",
				"set_memcheck", "remove_memcheck", "list_memchecks",
				"pause", "resume", "step", "step_over",
				"get_threads", "get_modules",
				"is_valid_address", "clear_breakpoints",
				"frame_advance", "pad_set", "queue_snapshot", "save_state_file", "load_state_file",
				"gif_trace_start", "gif_trace_stop"
			};
			for (const char* c : cmds) j.valStr(c);
			j.endArray();
			j.endObject();
		}

		return j.str();
	}

	// ============================================================
	// TCP Server
	// ============================================================
	// step and step_over arm a temporary breakpoint, let the CPU run, and wait for it to stop.
	// The arming and the reading happen on the CPU thread; the waiting cannot.
	static std::string handleStep(const std::string& cpuName, DebugInterface* cpu, bool over)
	{
		auto oldPc = std::make_shared<u32>(0);
		const CpuRun armed = runOnCpuThread([cpuName, cpu, over, oldPc]() {
			const u32 pc = cpu->getPC();
			*oldPc = pc;
			CBreakPoints::SetSkipFirst(getBpCpu(cpuName), pc);
			u32 target = pc + 4;
			if (over)
			{
				bool valid = true;
				const u32 opcode = cpu->Read32(pc, &valid);
				const u32 op = (opcode >> 26) & 63;
				if (op == 3 || (op == 0 && (opcode & 63) == 9))
					target = pc + 8;
			}
			CBreakPoints::AddBreakPoint(getBpCpu(cpuName), target, true, true, true);
			cpu->resumeCpu();
		});
		if (armed != CpuRun::Done)
			return errorReply(cpuRunFailure(armed, "the step"));

		const bool stopped = waitUntilPaused(cpu, over ? 10000 : 5000);

		auto reply = std::make_shared<std::string>();
		const CpuRun read = runOnCpuThread([cpu, oldPc, stopped, reply]() {
			const u32 newPc = cpu->getPC();
			bool valid = true;
			JsonBuilder j;
			j.startObject();
			j.kv("ok", stopped);
			if (!stopped)
				j.kv("error", std::string("the CPU did not stop at the step breakpoint in time"));
			j.key("old_pc"); j.valHex32(*oldPc);
			j.key("new_pc"); j.valHex32(newPc);
			j.kv("disasm", cpu->disasm(newPc, true));
			j.kv("in_bios", (newPc < 0x00100000) || (newPc >= 0x80000000 && newPc < 0x80100000));
			j.key("opcode"); j.valHex32(cpu->Read32(newPc, &valid));
			j.endObject();
			*reply = j.str();
		});
		return read == CpuRun::Done ? *reply : errorReply(cpuRunFailure(read, "the step result"));
	}

	static std::string handleFrameAdvance(DebugInterface* cpu, int64_t frames)
	{
		if (frames < 1 || frames > 3600)
			return errorReply("frames must be between 1 and 3600");

		const u32 count = (u32)frames;
		auto first = std::make_shared<u32>(0);
		const CpuRun armed = runOnCpuThread([count, first]() {
			*first = g_FrameCount;
			VMManager::FrameAdvance(count);
		});
		if (armed != CpuRun::Done)
			return errorReply(cpuRunFailure(armed, "frame_advance"));

		// FrameAdvance switched the VM to Running on the CPU thread; it pauses itself after the
		// last frame. Allow real time for slow frames: interpreted ones are slower, and a traced
		// frame walks the stack at every DMA start (about 2 s per frame on the OSDSYS clock).
		const int perFrame = GifTrace::g_active ? 20000 : (GifTrace::InterpretersActive() ? 2000 : 100);
		const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2000 + (int)count * perFrame);
		while (std::chrono::steady_clock::now() < deadline)
		{
			if (!s_running.load())
				return errorReply("the server is stopping");
			if (!VMManager::HasValidVM())
				return errorReply("the VM stopped during frame_advance");
			if (VMManager::GetState() == VMState::Paused)
				break;
			std::this_thread::sleep_for(std::chrono::milliseconds(2));
		}
		if (VMManager::GetState() != VMState::Paused)
			return errorReply("the VM did not pause after frame_advance");

		// A breakpoint or a watchpoint also pauses the VM. PCSX2 keeps the frames that were not
		// run armed, so the next resume pauses again after them; the caller has to know.
		const u32 ran = g_FrameCount - *first;
		if (ran < count)
		{
			char pc[16];
			snprintf(pc, sizeof(pc), "0x%08x", cpu->getPC());
			return errorReply("stopped after " + std::to_string(ran) + " of " + std::to_string(count) +
				" frames at pc " + pc + ", by a breakpoint or watchpoint; " + std::to_string(count - ran) +
				" frames remain armed and the next resume will pause after them");
		}

		JsonBuilder j;
		j.startObject();
		j.kv("ok", true);
		j.kv("frame", (int64_t)g_FrameCount);
		j.endObject();
		return j.str();
	}

	static std::string handleCommand(const std::string& jsonLine)
	{
		auto params = parseJsonObject(jsonLine);
		const std::string cmd = getStr(params, "cmd");
		const std::string cpuName = getStr(params, "cpu", "ee");
		DebugInterface* cpu = getCpu(cpuName);

		// status reads only what is valid before any VM exists, and must answer even when the
		// CPU thread is busy.
		if (cmd == "status")
			return handleOnCpuThread(jsonLine);

		if (!cpu->isAlive())
			return errorReply("no VM is running; boot one before sending " + cmd);

		// The EE interpreter only checks breakpoints and watchpoints in developer builds. In this
		// one a breakpoint set under it never fires and a step never stops.
		if (getBpCpu(cpuName) == BREAKPOINT_EE && !CHECK_EEREC &&
			(cmd == "set_breakpoint" || cmd == "set_memcheck" || cmd == "step" || cmd == "step_over"))
		{
			return errorReply("the EE interpreter of this build never checks breakpoints or watchpoints, so " + cmd +
				" would silently do nothing; launch without the interpreter option");
		}

		if (cmd == "step" || cmd == "step_over")
			return handleStep(cpuName, cpu, cmd == "step_over");

		if (cmd == "frame_advance")
			return handleFrameAdvance(cpu, getNum(params, "frames", 1));

		// The VM can stop between the check above and the moment the CPU thread gets to this
		// command, so the CPU thread checks again before touching anything.
		auto reply = std::make_shared<std::string>();
		const CpuRun ran = runOnCpuThread([jsonLine, cmd, reply]() {
			*reply = VMManager::HasValidVM()
				? handleOnCpuThread(jsonLine)
				: errorReply("no VM is running; boot one before sending " + cmd);
		});
		return ran == CpuRun::Done ? *reply : errorReply(cpuRunFailure(ran, cmd));
	}

	static std::thread s_serverThread;
	static std::thread s_clientThread;
	static std::atomic<bool> s_clientActive{false};
	static std::atomic<socket_t> s_clientSocket{SOCKET_INVALID};
	static socket_t s_listenSocket = SOCKET_INVALID;

	static void clientHandler(socket_t clientSock)
	{
		std::string buffer;
		char recvBuf[4096];

		while (s_running.load())
		{
			int bytes = recv(clientSock, recvBuf, sizeof(recvBuf) - 1, 0);
			if (bytes <= 0) break;

			recvBuf[bytes] = '\0';
			buffer += recvBuf;

			// Process complete lines
			size_t newlinePos;
			while ((newlinePos = buffer.find('\n')) != std::string::npos)
			{
				std::string line = buffer.substr(0, newlinePos);
				buffer = buffer.substr(newlinePos + 1);

				// Trim
				while (!line.empty() && (line.back() == '\r' || line.back() == '\n'))
					line.pop_back();

				if (line.empty()) continue;

				std::string response = handleCommand(line);
				response += "\n";

				send(clientSock, response.c_str(), (int)response.size(), 0);
			}
		}

		// A client that dropped mid-press would leave its buttons held for whoever comes next.
		if (s_running.load())
		{
			// A trace the client left running would keep its file open and keep growing. This is
			// not sent through runOnCpuThread: that gives up after a bounded wait, and one traced
			// frame can outlast it. Stop touches only the trace's own file, so it is safe whenever
			// the CPU thread gets to it.
			Host::RunOnCPUThread([]() {
				u64 packets = 0;
				GifTrace::Stop(&packets);
			});
			runOnCpuThread([]() {
				if (!VMManager::HasValidVM())
					return;
				for (const PadButton& button : s_padButtons)
					Pad::SetControllerState(0, button.bind, 0.0f);
			}, 1000);
		}

		if (s_clientSocket.exchange(SOCKET_INVALID) == clientSock)
			CLOSE_SOCKET(clientSock);
		s_clientActive.store(false);
	}

	static void serverLoop(int port)
	{
#ifdef _WIN32
		WSADATA wsaData;
		WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif

		s_listenSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
		if (s_listenSocket == SOCKET_INVALID)
		{
			fprintf(stderr, "[DebugServer] Failed to create socket\n");
			return;
		}

		// On Windows SO_REUSEADDR lets a second process listen on the same port, and clients
		// then reach either one. The port must belong to exactly one emulator.
		int opt = 1;
#ifdef _WIN32
		setsockopt(s_listenSocket, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char*)&opt, sizeof(opt));
#else
		setsockopt(s_listenSocket, SOL_SOCKET, SO_REUSEADDR, (const char*)&opt, sizeof(opt));
#endif

		struct sockaddr_in addr = {};
		addr.sin_family = AF_INET;
		addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // localhost only
		addr.sin_port = htons((u_short)port);

		if (bind(s_listenSocket, (struct sockaddr*)&addr, sizeof(addr)) != 0)
		{
			fprintf(stderr, "[DebugServer] Failed to bind on port %d\n", port);
			CLOSE_SOCKET(s_listenSocket);
			s_listenSocket = SOCKET_INVALID;
			return;
		}

		if (listen(s_listenSocket, 2) != 0)
		{
			fprintf(stderr, "[DebugServer] Failed to listen\n");
			CLOSE_SOCKET(s_listenSocket);
			s_listenSocket = SOCKET_INVALID;
			return;
		}

		fprintf(stderr, "[DebugServer] Listening on 127.0.0.1:%d\n", port);

		while (s_running.load())
		{
			// Use select with timeout to allow clean shutdown
			fd_set readSet;
			FD_ZERO(&readSet);
			FD_SET(s_listenSocket, &readSet);

			struct timeval tv;
			tv.tv_sec = 1;
			tv.tv_usec = 0;

			int selectResult = select((int)s_listenSocket + 1, &readSet, nullptr, nullptr, &tv);
			if (selectResult <= 0) continue;

			socket_t clientSock = accept(s_listenSocket, nullptr, nullptr);
			if (clientSock == SOCKET_INVALID) continue;

			// The previous client's thread frees the slot a moment after its socket closes;
			// give it that moment before deciding the slot is taken.
			for (int waited = 0; waited < 1500 && s_clientActive.load() && s_running.load(); waited += 5)
				std::this_thread::sleep_for(std::chrono::milliseconds(5));

			if (s_clientActive.load())
			{
				// Half-close and drain so the refusal is delivered even when the client has
				// already sent its first command; a plain close would reset the connection.
				const std::string refusal = errorReply("another client is connected") + "\n";
				send(clientSock, refusal.c_str(), (int)refusal.size(), 0);
#ifdef _WIN32
				shutdown(clientSock, SD_SEND);
				DWORD drainTimeout = 200;
				setsockopt(clientSock, SOL_SOCKET, SO_RCVTIMEO, (const char*)&drainTimeout, sizeof(drainTimeout));
#else
				shutdown(clientSock, SHUT_WR);
#endif
				char drain[256];
				recv(clientSock, drain, sizeof(drain), 0);
				CLOSE_SOCKET(clientSock);
				continue;
			}

			if (s_clientThread.joinable())
				s_clientThread.join();
			s_clientActive.store(true);
			s_clientSocket.store(clientSock);
			s_clientThread = std::thread(clientHandler, clientSock);
		}

		CLOSE_SOCKET(s_listenSocket);
		s_listenSocket = SOCKET_INVALID;

#ifdef _WIN32
		WSACleanup();
#endif
	}

	void Start(int port)
	{
		if (s_running.exchange(true)) return;
		s_serverThread = std::thread(serverLoop, port);
	}

	void Stop()
	{
		if (!s_running.exchange(false)) return;

		// Closing the client socket wakes recv(); s_running going false wakes any wait on the
		// CPU thread. Only then can both threads be joined from the CPU thread itself.
		const socket_t client = s_clientSocket.exchange(SOCKET_INVALID);
		if (client != SOCKET_INVALID)
			CLOSE_SOCKET(client);

		if (s_serverThread.joinable())
			s_serverThread.join();
		if (s_clientThread.joinable())
			s_clientThread.join();
	}

	bool IsRunning()
	{
		return s_running.load();
	}

	void OnBreakpointHit()
	{
		// Future: notify connected clients of breakpoint events
	}

} // namespace DebugServer
