// Runs actual EE -> Wasm compiled blocks. No disc, BIOS, renderer, or game overrides.
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include "MIPS.h"
#include "COP_SCU.h"
#include "COP_FPU.h"
#include "ee/COP_VU.h"
#include "ee/MA_EE.h"
#include "ee/PS2OS.h"
#include "ee/EeExecutor.h"
#include "ee/EeBasicBlock.h"
#include "MemoryUtils.h"
#include "Jitter_CodeGen_Wasm.h"
#include "WsxJitCache.h"

// Generated from the hosted VM's registry by run-ee-memory-tests.sh.
#include "ee-test-registry.h"

static unsigned checks = 0, failures = 0, accesses = 0, translations = 0;
static uint32 checkedAddress = 0, checkedWrite = 0;
static bool fault = false;
static void Check(bool ok, const char* name)
{
    ++checks;
    if(!ok) { ++failures; printf("FAIL: %s\n", name); }
}
static uint32 Translate(CMIPS*, uint32 address)
{
    ++translations;
    return address & 0xFFFF;
}
static uint32 CheckAccess(CMIPS* cpu, uint32 address, uint32 write)
{
    checkedAddress = address;
    checkedWrite = write;
    if(!fault) return MIPS_EXCEPTION_NONE;
    cpu->m_State.nCOP0[CCOP_SCU::BADVADDR] = address;
    cpu->m_State.nHasException = MIPS_EXCEPTION_TLB;
    return MIPS_EXCEPTION_TLB;
}

struct Fixture
{
    CMIPS cpu{MEMORYMAP_ENDIAN_LSBF, true};
    CMA_EE arch;
    CCOP_SCU scu{MIPS_REGSIZE_64};
    CCOP_FPU fpu{MIPS_REGSIZE_64};
    CCOP_VU vu{MIPS_REGSIZE_64};
    alignas(16) uint32 code[16] = {};
    alignas(16) uint32 data[MIPS_PAGE_SIZE / 4] = {};
    Fixture()
    {
        cpu.m_pArch = &arch;
        cpu.m_pCOP[0] = &scu;
        cpu.m_pCOP[1] = &fpu;
        cpu.m_pCOP[2] = &vu;
        cpu.m_pAddrTranslator = &Translate;
        cpu.m_pMemoryMap->InsertInstructionMap(0x1000, 0x103F, code, 0);
        cpu.m_pMemoryMap->InsertReadMap(0x1000, 0x103F, code, 0);
        cpu.m_pMemoryMap->InsertReadMap(0x2000, 0x2FFF, data, 0);
        cpu.m_pMemoryMap->InsertWriteMap(0x2000, 0x2FFF, data, 0);
        cpu.m_pMemoryMap->SetPreAccessHandler(0x2000, []() { ++accesses; });
    }
    void Prepare(uint32 op, uint32 rt = 2, int16 offset = -16)
    {
        cpu.Reset();
        cpu.m_State.nPC = 0x1000;
        cpu.m_State.cycleQuota = 1; // return after this block, no dispatcher needed
        cpu.m_State.nGPR[1].nV0 = 0x40002010;
        cpu.m_State.nGPR[2] = uint128{0x11223344, 0x55667788, 0x99AABBCC, 0xDDEEFF00};
        cpu.m_State.nCOP2[2] = cpu.m_State.nGPR[2];
        cpu.m_State.nCOP1[2] = 0x11223344;
        for(unsigned i = 0; i < MIPS_PAGE_SIZE / 4; ++i) data[i] = 0xA0B0C000 + i;
        code[0] = (op << 26) | (1 << 21) | (rt << 16) | uint16(offset);
        code[1] = 0x24030077; // addiu v1, zero, 0x77: must not execute after a fault
        checkedAddress = checkedWrite = 0xFFFFFFFF;
        accesses = translations = 0;
    }
    void Run()
    {
        CBasicBlock block(cpu, 0x1000, 0x1004); // no persistent cache for instruction tests
        block.Compile();
        block.Execute();
    }
};

struct Op { const char* name; uint32 code; bool store; };
static const Op ops[] = {
    {"LW", 0x23, false}, {"SW", 0x2B, true},
    {"LD", 0x37, false}, {"SD", 0x3F, true},
    {"LDL", 0x1A, false}, {"LDR", 0x1B, false},
    {"SDL", 0x2C, true}, {"SDR", 0x2D, true},
    {"LQ", 0x1E, false}, {"SQ", 0x1F, true},
    {"LWC1", 0x31, false}, {"SWC1", 0x39, true},
    {"LQC2", 0x36, false}, {"SQC2", 0x3E, true},
};

static void FaultTests()
{
    Fixture f;
    for(bool direct : {false, true})
    {
        f.cpu.m_pageLookup[0x40002000 / MIPS_PAGE_SIZE] = direct ? f.data : nullptr;
        for(const auto& op : ops)
        for(uint32 rt : {2u, 0u})
        for(uint32 position : {0u, 1u})
        {
            f.Prepare(op.code, rt);
            if(position) { f.code[1] = f.code[0]; f.code[0] = 0; }
            f.cpu.m_TLBExceptionChecker = &CheckAccess;
            fault = true;
            const auto before = f.cpu.m_State;
            uint32 beforeData[MIPS_PAGE_SIZE / 4];
            memcpy(beforeData, f.data, sizeof(beforeData));
            try { f.Run(); }
            catch(const std::exception& e) { printf("%s: %s\n", op.name, e.what()); }
            char name[100];
            snprintf(name, sizeof(name), "%s fault rt=%u position=%u %s", op.name, rt, position, direct ? "page" : "proxy");
            Check(f.cpu.m_State.nHasException == MIPS_EXCEPTION_TLB &&
                  f.cpu.m_State.nCOP0[CCOP_SCU::EPC] == 0x1000 + position * 4 &&
                  checkedAddress == 0x40002000 && checkedWrite == op.store &&
                  !memcmp(before.nGPR, f.cpu.m_State.nGPR, sizeof(before.nGPR)) &&
                  !memcmp(before.nCOP1, f.cpu.m_State.nCOP1, sizeof(before.nCOP1)) &&
                  !memcmp(before.nCOP2, f.cpu.m_State.nCOP2, sizeof(before.nCOP2)) &&
                  !memcmp(beforeData, f.data, sizeof(beforeData)) && accesses == 0 && translations == 0, name);
        }
    }
}

static void QuadTests()
{
    Fixture f;
    fault = false;
    f.cpu.m_TLBExceptionChecker = &CheckAccess;
    for(bool direct : {false, true})
    for(uint32 op : {0x1Eu, 0x1Fu, 0x36u, 0x3Eu})
    for(int16 offset = 0; offset < 16; ++offset)
    {
        f.cpu.m_pageLookup[0x40002000 / MIPS_PAGE_SIZE] = direct ? f.data : nullptr;
        f.Prepare(op, 2, offset);
        bool store = (op == 0x1F || op == 0x3E);
        bool cop2 = (op == 0x36 || op == 0x3E);
        auto& reg = cop2 ? f.cpu.m_State.nCOP2[2] : f.cpu.m_State.nGPR[2];
        uint128 expected;
        memcpy(&expected, store ? static_cast<void*>(&reg) : static_cast<void*>(f.data + 4), 16);
        const uint32 guardBefore = f.data[3], guardAfter = f.data[8];
        bool ran = true;
        try { f.Run(); }
        catch(const std::exception& e) { ran = false; }
        char name[100];
        snprintf(name, sizeof(name), "quad op=%02x offset=%d %s", op, offset, direct ? "page" : "proxy");
        Check(ran && !memcmp(&expected, store ? static_cast<void*>(f.data + 4) : static_cast<void*>(&reg), 16) &&
              f.data[3] == guardBefore && f.data[8] == guardAfter && f.cpu.m_State.nGPR[3].nV0 == 0x77, name);
    }
}

static void CacheTests()
{
    static std::vector<std::vector<uint8>> blobs; // imported bytes must outlive cache entries
    Fixture f;
    CEeExecutor executor(f.cpu, reinterpret_cast<uint8*>(f.data));
    // Same instructions and address, but different exception-checking mode.
    for(bool persistent : {false, true})
    {
        for(bool enabled : {false, true, false, true})
        {
            f.Prepare(0x23);
            fault = true;
            f.cpu.m_TLBExceptionChecker = enabled ? &CheckAccess : nullptr;
            BasicBlockPtr block;
            if(persistent)
            {
                block = std::make_shared<CEeBasicBlock>(f.cpu, 0x1000, 0x1004, BLOCK_CATEGORY_PS2_EE);
                block->Compile();
            }
            else block = executor.BlockFactory(f.cpu, 0x1000, 0x1004);
            block->Execute();
            Check(enabled ? f.cpu.m_State.nHasException == MIPS_EXCEPTION_TLB :
                            f.cpu.m_State.nGPR[2].nV0 == f.data[0],
                  persistent ? "persistent cache respects TLB mode" : "EE block cache respects TLB mode");
            if(persistent)
            {
                auto pending = WsxJitCache::TakePending();
                if(!pending.empty())
                {
                    blobs.push_back(std::move(pending));
                    WsxJitCache::Load(blobs.back().data(), blobs.back().size());
                }
            }
        }
    }
}

static void ActiveCacheTests()
{
    Fixture f;
    auto executor = std::make_unique<CEeExecutor>(f.cpu, reinterpret_cast<uint8*>(f.data));
    f.cpu.m_executor = std::move(executor);
    for(bool restart : {false, true})
    for(bool enabled : {false, false, true, false, true, true})
    {
        if(restart)
        {
            CEeExecutor::SetKeepCachedBlocksOnReset(true);
            f.cpu.m_executor->Reset();
        }
        f.Prepare(0x23);
        f.cpu.m_TLBExceptionChecker = enabled ? &CheckAccess : nullptr;
        fault = true;
        // Link a branch block to a load block. No fault must reach syscall;
        // a fault must leave v1 unchanged even after links have warmed up.
        f.code[8] = f.code[0];
        f.code[9] = 0x24030077;
        f.code[10] = 0x0000000C; // syscall
        f.code[0] = 0x08000408; // j 0x1020
        f.code[1] = 0;
        f.cpu.m_executor->Execute(100);
        Check(enabled ? (f.cpu.m_State.nHasException == MIPS_EXCEPTION_TLB &&
                         f.cpu.m_State.nCOP0[CCOP_SCU::EPC] == 0x1020 && f.cpu.m_State.nGPR[3].nV0 == 0) :
                        (f.cpu.m_State.nHasException == MIPS_EXCEPTION_SYSCALL && f.cpu.m_State.nGPR[3].nV0 == 0x77),
              restart ? "retained restart cache respects TLB mode" : "active linked blocks respect TLB mode");
    }
    CEeExecutor::SetKeepCachedBlocksOnReset(false);
}

#include "ee-tlb-tests.h"

int main(int argc, char** argv)
{
    RegisterTestFunctions();
    if(argc > 1 && !strcmp(argv[1], "--tlb")) { TlbTests(); TlbInstructionTests(); TlbDelayTests(); TlbRoutingTests(); }
    else if(argc > 1 && !strcmp(argv[1], "--cache")) CacheTests();
    else if(argc > 1 && !strcmp(argv[1], "--quad")) QuadTests();
    else { FaultTests(); CacheTests(); ActiveCacheTests(); QuadTests(); TlbTests(); TlbInstructionTests(); TlbDelayTests(); TlbRoutingTests(); }
    printf("EE memory: %u checks, %u failures\n", checks, failures);
    return failures ? 1 : 0;
}
