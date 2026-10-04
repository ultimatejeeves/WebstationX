// Checks GsTransferFast (page runs, and the SIMD column path for aligned PSMT8/PSMT4) against the
// reference per-pixel transfer loops from CGSHandler.
// Build: em++ -O2 -msimd128 -std=c++17 -I<Play>/Source -I<Play>/deps/Framework/include ... transfer-test.cpp <Play>/Source/gs/GsPixelFormats.cpp -o t.js && node t.js
#include <cstdio>
#include <cstring>
#include <random>
#include <vector>
#include <chrono>
#include "gs/GsPixelFormats.h"
#include "gs/GsTransferFast.h"

using namespace GsTransferFast;

template <typename Storage>
bool RefGeneric(uint8* ram, const Rect& r, uint32& rrx, uint32& rry, const typename Storage::Unit* src, uint32 n)
{
	bool dirty = false;
	CGsPixelFormats::CPixelIndexor<Storage> Indexor(ram, r.dstPtr, r.dstWidth);
	for(unsigned int i = 0; i < n; i++)
	{
		uint32 nX = (rrx + r.dsax) % 2048;
		uint32 nY = (rry + r.dsay) % 2048;
		auto p = Indexor.GetPixelAddress(nX, nY);
		if(*p != src[i])
		{
			*p = src[i];
			dirty = true;
		}
		rrx++;
		if(rrx == r.rrw)
		{
			rrx = 0;
			rry++;
		}
	}
	return dirty;
}

bool RefPSMT4(uint8* ram, const Rect& r, uint32& rrx, uint32& rry, const uint8* src, uint32 n)
{
	bool dirty = false;
	CGsPixelFormats::CPixelIndexorPSMT4 Indexor(ram, r.dstPtr, r.dstWidth);
	for(unsigned int i = 0; i < n; i++)
	{
		uint8 px[2] = {uint8(src[i] & 0x0F), uint8((src[i] >> 4) & 0x0F)};
		for(int j = 0; j < 2; j++)
		{
			uint32 nX = (rrx + r.dsax) % 2048;
			uint32 nY = (rry + r.dsay) % 2048;
			if(Indexor.GetPixel(nX, nY) != px[j])
			{
				Indexor.SetPixel(nX, nY, px[j]);
				dirty = true;
			}
			rrx++;
			if(rrx == r.rrw)
			{
				rrx = 0;
				rry++;
			}
		}
	}
	return dirty;
}

int main()
{
	const uint32 RAM = CGSHandler::RAMSIZE;
	std::vector<uint8> a(RAM), b(RAM);
	std::mt19937 rng(1234);
	int failures = 0;
	for(int iter = 0; iter < 3000; iter++)
	{
		for(uint32 k = 0; k < RAM; k++) a[k] = b[k] = uint8(rng());
		int fmt = iter % 4; // 0 = PSMCT32, 1 = PSMCT16, 2 = PSMT8, 3 = PSMT4
		Rect r;
		r.dstPtr = (rng() % 512) * 256 * ((iter % 7 == 0) ? 64 : 1) % RAM;
		r.dstWidth = 1 + rng() % 16;
		r.dsax = rng() % ((iter % 11 == 0) ? 2048 : 300);
		r.dsay = rng() % ((iter % 13 == 0) ? 2048 : 300);
		r.rrw = 1 + rng() % 200;
		uint32 rrx0 = rng() % r.rrw, rry0 = rng() % 8;
		uint32 n = 1 + rng() % 5000;
		if(iter % 3 != 0)
		{
			// Column aligned (the SIMD column path): x and width on columns, rows from a multiple of 4.
			uint32 cw = (fmt == 3) ? 32 : 16;
			r.dsax = (rng() % (2048 / cw)) * cw;
			if(iter % 2) r.dsax %= 512;
			r.dsay = (rng() % 512) * 4;
			if(iter % 5 == 1) r.dsay %= 64;
			r.rrw = cw * (1 + rng() % 12);
			rrx0 = (iter % 4 == 1) ? rng() % r.rrw : 0;
			rry0 = (rng() % 4) * ((iter % 6 == 2) ? 1 : 4);
			n = r.rrw * (1 + rng() % 40) + ((iter % 5 == 3) ? rng() % 64 : 0);
			if(fmt == 3) n = (n + 1) / 2;
		}
		std::vector<uint8> src(n * 4 + 8);
		for(auto& s : src) s = (iter % 5 == 0) ? 0 : uint8(rng());
		uint32 ax = rrx0, ay = rry0, bx = rrx0, by = rry0;
		bool da = false, db = false;
		switch(fmt)
		{
		case 0:
			da = RefGeneric<CGsPixelFormats::STORAGEPSMCT32>(a.data(), r, ax, ay, (uint32*)src.data(), n);
			db = WriteGeneric<CGsPixelFormats::STORAGEPSMCT32>(b.data(), r, bx, by, (uint32*)src.data(), n);
			break;
		case 1:
			da = RefGeneric<CGsPixelFormats::STORAGEPSMCT16>(a.data(), r, ax, ay, (uint16*)src.data(), n);
			db = WriteGeneric<CGsPixelFormats::STORAGEPSMCT16>(b.data(), r, bx, by, (uint16*)src.data(), n);
			break;
		case 2:
			da = RefGeneric<CGsPixelFormats::STORAGEPSMT8>(a.data(), r, ax, ay, src.data(), n);
			db = WriteGeneric<CGsPixelFormats::STORAGEPSMT8>(b.data(), r, bx, by, src.data(), n);
			break;
		case 3:
			da = RefPSMT4(a.data(), r, ax, ay, src.data(), n);
			db = WritePSMT4(b.data(), r, bx, by, src.data(), n);
			break;
		}
		if(da != db || ax != bx || ay != by || memcmp(a.data(), b.data(), RAM) != 0)
		{
			if(failures++ < 10) printf("MISMATCH iter %d fmt %d dirty %d/%d cursor %u,%u vs %u,%u\n", iter, fmt, da, db, ax, ay, bx, by);
		}
	}
	// Throughput: a 256x256 PSMT8 upload and a 256x256 PSMT4 upload, repeated.
	Rect r{0, 4, 0, 0, 256};
	std::vector<uint8> src(256 * 256);
	for(auto& s : src) s = uint8(rng());
	for(int pass = 0; pass < 2; pass++)
	{
		auto t0 = std::chrono::steady_clock::now();
		for(int k = 0; k < 200; k++)
		{
			uint32 x = 0, y = 0;
			if(pass == 0) RefGeneric<CGsPixelFormats::STORAGEPSMT8>(a.data(), r, x, y, src.data(), 256 * 256);
			else RefPSMT4(a.data(), r, x, y, src.data(), 128 * 256);
		}
		auto t1 = std::chrono::steady_clock::now();
		for(int k = 0; k < 200; k++)
		{
			uint32 x = 0, y = 0;
			if(pass == 0) WriteGeneric<CGsPixelFormats::STORAGEPSMT8>(b.data(), r, x, y, src.data(), 256 * 256);
			else WritePSMT4(b.data(), r, x, y, src.data(), 128 * 256);
		}
		auto t2 = std::chrono::steady_clock::now();
		double ref = std::chrono::duration<double, std::milli>(t1 - t0).count();
		double fast = std::chrono::duration<double, std::milli>(t2 - t1).count();
		printf("%s: ref %.1f ms, fast %.1f ms (%.1fx)\n", pass == 0 ? "PSMT8" : "PSMT4", ref, fast, ref / fast);
	}
	printf(failures ? "FAILED (%d)\n" : "ALL OK\n", failures);
	return failures ? 1 : 0;
}
