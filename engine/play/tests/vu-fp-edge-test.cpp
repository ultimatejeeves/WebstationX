#include <cmath>
#include <cstdio>
#include <cstring>
#include "MipsJitter.h"
#include "Jitter_CodeGen_Wasm.h"
#include "MemoryFunction.h"
#include "MemStream.h"
#include "BasicBlock.h"
#include "MemoryUtils.h"
#include "ee/VUShared.h"
#include "ee/FpAddTruncate.h"
#include "ee/MA_EE.h"
#include "COP_FPU.h"
#include "ee-test-registry.h"

// Independent double-precision oracle: mask the smaller operand before addition
// to model the published one-guard-bit alignment. No production helper is reused.
// These are model-derived cases, not newly captured console measurements.
static uint32 Expected(uint32 a, uint32 b)
{
    int ea = (a >> 23) & 255, eb = (b >> 23) & 255;
    if(!ea) a &= 0x80000000;
    if(!eb) b &= 0x80000000;
    auto mask = [](uint32 v, int distance) {
        if(distance > 24) return v & 0x80000000;
        return distance > 1 ? v & ~((1U << (distance - 1)) - 1) : v;
    };
    if(ea > eb) b = mask(b, ea - eb);
    if(eb > ea) a = mask(a, eb - ea);
    auto decode = [](uint32 v) {
        int exponent = (v >> 23) & 255;
        double magnitude = exponent ? std::ldexp(double((v & 0x7FFFFF) | 0x800000), exponent - 150) : 0;
        return v >> 31 ? -magnitude : magnitude;
    };
    double result = decode(a) + decode(b);
    if(result == 0) return (a & b) & 0x80000000;
    uint32 sign = result < 0 ? 0x80000000 : 0;
    int exponent;
    double fraction = std::frexp(std::fabs(result), &exponent);
    int encodedExponent = exponent + 126;
    if(encodedExponent <= 0) return sign;
    if(encodedExponent > 255) return sign | 0x7FFFFFFF;
    return sign | (uint32(encodedExponent) << 23) | (uint32(std::ldexp(fraction, 24)) & 0x7FFFFF);
}

int main()
{
    RegisterTestFunctions();
    unsigned failures = 0, checks = 0;
    auto check = [&](uint32 a, uint32 b, uint32 expected, uint32 actual, const char* path) {
        ++checks;
        if(actual != expected) {
            if(failures < 12) printf("FAIL %s: %08x + %08x expected=%08x actual=%08x\n", path, a, b, expected, actual);
            ++failures;
        }
    };
    const uint32 fixtures[][3] = {
        {0, 0x80000000, 0}, {0x80000000, 0x80000000, 0x80000000},
        {1, 1, 0}, {0x807FFFFF, 0x80000001, 0x80000000},
        {0x00800001, 0x80800000, 0}, {0x80800001, 0x00800000, 0x80000000},
        {0x3F800000, 0x33800000, 0x3F800000},
        {0x3F800000, 0x34400000, 0x3F800001},
        {0x3F800000, 0xB3000000, 0x3F800000},
        {0x3F800000, 0xB3800001, 0x3F7FFFFF},
        {0x7F800000, 0xFF800000, 0}, {0x7FFFFFFF, 0xFFFFFFFF, 0},
        {0x7F000000, 0x7F000000, 0x7F800000},
        {0x7FFFFFFF, 0x7FFFFFFF, 0x7FFFFFFF},
        {0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF},
        {0x7F800001, 0, 0x7F800001}, {0xFF800001, 0, 0xFF800001},
    };
    for(auto& fixture : fixtures) {
        check(fixture[0], fixture[1], fixture[2], Expected(fixture[0], fixture[1]), "oracle fixture");
        check(fixture[0], fixture[1], fixture[2], FpAddTruncate(fixture[0], fixture[1]), "helper fixture");
    }
    uint32 seed = 0x09123121;
    auto random = [&]() { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return seed; };
    for(unsigned i = 0; i < 200000; ++i) {
        uint32 a = random(), b = random();
        // Frequent cancellation, nearby exponents, exponent gaps, all bit patterns.
        if(i % 4 == 0) b = a ^ 0x80000000;
        if(i % 4 == 1) b = (b & 0x807FFFFF) | (a & 0x7F800000);
        check(a, b, Expected(a, b), FpAddTruncate(a, b), "helper random");
    }
    // Sweep every exponent, both signs and the guard-bit transition at gaps 24/25.
    for(unsigned exponent = 0; exponent < 256; ++exponent)
    for(unsigned gap = 0; gap < 32; ++gap)
    for(unsigned signs = 0; signs < 4; ++signs) {
        uint32 a = (exponent << 23) | 0x7FFFFF | ((signs & 1) << 31);
        uint32 b = ((exponent > gap ? exponent - gap : 0) << 23) | 1 | ((signs & 2) << 30);
        check(a, b, Expected(a, b), FpAddTruncate(a, b), "exponent sweep");
        check(b, a, Expected(b, a), FpAddTruncate(b, a), "reversed sweep");
    }
    // Execute the actual VU emitter with its existing accurate-ADDI hint. Exercise
    // destination masks, VF0 scratch results, aliasing, and both allocator modes.
    CMIPS cpu(MEMORYMAP_ENDIAN_LSBF);
    for(bool locals : {false, true}) for(unsigned fd : {0U, 1U, 2U}) for(unsigned dest = 0; dest < 16; ++dest) {
        Jitter::g_wasmLocalsAsRegisters = locals;
        Framework::CMemStream code;
        CMipsJitter jit(new Jitter::CCodeGen_Wasm());
        jit.SetStream(&code);
        jit.Begin();
        VUShared::ADDi(&jit, dest, fd, 1, 0, VUShared::COMPILEHINT_USE_ACCURATE_ADDI);
        jit.End();
        CMemoryFunction function(code.GetBuffer(), code.GetSize());
        for(unsigned sample = 0; sample < 128; ++sample) {
            cpu.Reset();
            cpu.m_State.nCOP2I = sample < 17 ? fixtures[sample][1] : random();
            uint32 expected[4], source[4], b = cpu.m_State.nCOP2I;
            unsigned output = fd ? fd : 32;
            for(unsigned lane = 0; lane < 4; ++lane) {
                cpu.m_State.nCOP2[output].nV[lane] = 0xDEADBEEF;
                source[lane] = sample < 17 ? fixtures[sample][0] : random();
                cpu.m_State.nCOP2[1].nV[lane] = source[lane];
                expected[lane] = dest & (8 >> lane) ? Expected(source[lane], b) : cpu.m_State.nCOP2[output].nV[lane];
            }
            function(&cpu);
            unsigned flags = 0;
            for(unsigned lane = 0; lane < 4; ++lane)
            {
                check(source[lane], b, expected[lane], cpu.m_State.nCOP2[output].nV[lane], "ADDI JIT");
                if(!(dest & (8 >> lane))) continue;
                if(expected[lane] >> 31) flags |= 128 >> lane;
                if(!(expected[lane] & 0x7FFFFFFF)) flags |= 8 >> lane;
            }
            check(0, 0, 0x3F800000, cpu.m_State.nCOP2[0].nV[3], "VF0 preserved");
            for(unsigned time : {3U, 4U}) {
                cpu.m_State.pipeTime = time;
                VUShared::CheckFlagPipelineImmediate(VUShared::g_pipeInfoMac, &cpu, 0);
                VUShared::CheckFlagPipelineImmediate(VUShared::g_pipeInfoSticky, &cpu, 0);
                check(0, 0, time < 4 ? 0 : flags, cpu.m_State.nCOP2MF, "MAC latency");
                check(0, 0, time < 4 ? 0 : flags, cpu.m_State.nCOP2SF, "sticky latency");
            }
        }
    }
    // The same helper is also selected by the EE accurate ADD.S/SUB.S hint.
    // Compile real instructions so missing hosted imports fail this test.
    CMA_EE arch;
    CCOP_FPU fpu(MIPS_REGSIZE_64);
    CMIPS ee(MEMORYMAP_ENDIAN_LSBF, true);
    ee.m_pArch = &arch;
    ee.m_pCOP[1] = &fpu;
    ee.m_pAddrTranslator = [](CMIPS*, uint32 address) { return address; };
    uint32 instruction = 0;
    ee.m_pMemoryMap->InsertInstructionMap(0x1000, 0x1003, &instruction, 0);
    for(bool locals : {false, true}) for(unsigned subtract : {0U, 1U}) for(unsigned fd : {0U, 1U, 2U, 3U}) {
        Jitter::g_wasmLocalsAsRegisters = locals;
        instruction = (0x11U << 26) | (16 << 21) | (2 << 16) | (1 << 11) | (fd << 6) | subtract;
        CBasicBlock block(ee, 0x1000, 0x1000);
        block.AddBlockCompileHints(CMA_EE::COMPILEHINT_FPU_USE_ACCURATE_ADD_SUB);
        block.Compile();
        for(unsigned sample = 0; sample < 1000; ++sample) {
            ee.Reset();
            uint32 a = sample < 17 ? fixtures[sample][0] : random();
            uint32 b = sample < 17 ? fixtures[sample][1] : random();
            ee.m_State.nCOP1[1] = a;
            ee.m_State.nCOP1[2] = b;
            ee.m_State.nPC = 0x1000;
            ee.m_State.cycleQuota = 1;
            block.Execute();
            check(a, b, Expected(a, b ^ (subtract << 31)), ee.m_State.nCOP1[fd], subtract ? "SUB.S JIT" : "ADD.S JIT");
        }
    }
    printf("EE/VU FP edges: %u checks, %u failures\n", checks, failures);
    return failures ? 1 : 0;
}
