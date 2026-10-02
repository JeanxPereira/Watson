// SPDX-License-Identifier: GPL-3.0+
//
// Records what the EE side hands to the GIF, and where it came from, as JSON Lines.
// Every function here runs on the CPU thread.

#pragma once

#include "common/Pcsx2Defs.h"

#include <string>

namespace GifTrace
{
	extern bool g_active;

	// Each returns an empty string on success, else the reason.
	std::string Start(const std::string& path);
	std::string Stop(u64* packets);

	// The EE and VU1 register files are only current under the interpreters.
	bool InterpretersActive();

	void Origin(u32 channel);
	void Data(u32 transferType, const u8* mem, u32 size);
	void Rewind(u32 path, u32 size);
	void Packet(u32 path, const u8* mem, u32 size, u32 pending);
	void Vsync();

	__fi void OnOrigin(u32 channel) { if (g_active) Origin(channel); }
	__fi void OnData(u32 transferType, const u8* mem, u32 size) { if (g_active) Data(transferType, mem, size); }
	__fi void OnRewind(u32 path, u32 size) { if (g_active) Rewind(path, size); }
	__fi void OnPacket(u32 path, const u8* mem, u32 size, u32 pending) { if (g_active) Packet(path, mem, size, pending); }
	__fi void OnVsync() { if (g_active) Vsync(); }
} // namespace GifTrace
