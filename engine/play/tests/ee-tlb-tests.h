// Architectural expectations: TX79 architecture manual, TLB and exception chapters.
#include "ee/DMAC.h"
#include "iop/IopBios.h"
#include "app_shared/DefaultAppConfig.h"
static void TlbTests()
{
    Fixture f;
    auto& s = f.cpu.m_State;
    // All supported paired page sizes, both halves, with low PFN bits deliberately set.
    for(uint32 size : {0x1000u, 0x4000u, 0x10000u, 0x40000u, 0x100000u, 0x400000u, 0x1000000u})
    for(uint32 half : {0u, 1u})
    {
        f.Prepare(0x23);
        s.nCOP0[CCOP_SCU::ENTRYHI] = 0x42;
        auto& e = s.tlbEntries[20];
        e = {((0x01234000 >> 12) << 6) | 6, ((0x03234000 >> 12) << 6) | 6,
             0x40000042, (size - 1) * 2 & 0x01FFE000};
        const uint32 address = 0x40000000 + size * half + size - 4;
        const uint32 expected = ((half ? 0x03234000 : 0x01234000) & ~(size - 1)) + size - 4;
        Check(CPS2OS::CheckTLBExceptions(&f.cpu, address, 1) == 0 &&
              CPS2OS::TranslateAddressTLB(&f.cpu, address) == expected, "paired TLB page translation");
    }
    for(uint32 flags : {0u, 1u, 2u, 3u})
    {
        f.Prepare(0x23);
        s.nCOP0[CCOP_SCU::ENTRYHI] = 0x43;
        s.tlbEntries[20] = {6u | (flags & 1), 6u | (flags >> 1), 0x40000042, 0};
        Check((CPS2OS::CheckTLBExceptions(&f.cpu, 0x40000000, 0) == 0) == (flags == 3),
              "ASID ignored only when both global bits are set");
    }
    for(uint32 kind : {0u, 1u, 2u}) // miss, invalid, modification
    for(uint32 write : {0u, 1u})
    {
        f.Prepare(0x23);
        s.nCOP0[4] = 0xAA800000;
        s.nCOP0[CCOP_SCU::ENTRYHI] = 0x42;
        s.nCOP0[CCOP_SCU::CAUSE] = 0x80000400;
        if(kind) s.tlbEntries[20] = {kind == 2 ? 2u : 0u, 0, 0x40000042, 0};
        uint32 result = CPS2OS::CheckTLBExceptions(&f.cpu, 0x40000124, write);
        if(kind == 2 && !write) Check(result == 0, "read-only page permits reads");
        else Check(result != 0 && s.nCOP0[CCOP_SCU::BADVADDR] == 0x40000124 &&
                   s.nCOP0[CCOP_SCU::ENTRYHI] == 0x40000042 && s.nCOP0[4] == 0xAAA00000 &&
                   s.nCOP0[CCOP_SCU::CAUSE] == (0x80000400 | (kind == 2 ? 4 : write ? 12 : 8)),
                   "TLB fault records address, VPN, context and cause");
    }
    // Default HLE mappings and the unmapped kernel segments remain accessible.
    for(uint32 address : {0x1000u, 0x20100000u, 0x30100000u, 0x70000000u, 0x80002000u, 0xA0002000u})
        Check(CPS2OS::CheckTLBExceptions(&f.cpu, address, 1) == 0, "HLE/kernel direct mapping");
}

static void TlbInstructionTests()
{
    Fixture f;
    auto run = [&](uint32 instruction) {
        f.code[0] = instruction; f.code[1] = 0;
        f.cpu.m_State.nPC = 0x1000; f.cpu.m_State.cycleQuota = 1;
        try { f.Run(); return true; }
        catch(const std::exception& e) { printf("COP0 compile: %s\n", e.what()); return false; }
    };
    for(uint32 index = 0; index < 48; ++index)
    {
        f.Prepare(0);
        auto& s = f.cpu.m_State;
        s.nCOP0[CCOP_SCU::INDEX] = index;
        s.nCOP0[CCOP_SCU::ENTRYHI] = 0x40000042 + index * 0x2000;
        s.nCOP0[CCOP_SCU::ENTRYLO0] = 0x406;
        s.nCOP0[CCOP_SCU::ENTRYLO1] = 0x806;
        Check(run(0x42000002) && s.tlbEntries[index].entryHi == 0x40000042 + index * 0x2000,
              "TLBWI targets every one of 48 slots");
        s.nCOP0[CCOP_SCU::ENTRYLO0] = 0;
        Check(run(0x42000001) && s.nCOP0[CCOP_SCU::ENTRYLO0] == 0x406, "TLBR reads indexed slot");
        s.nCOP0[CCOP_SCU::INDEX] = 0xDEADBEEF;
        Check(run(0x42000008) && s.nCOP0[CCOP_SCU::INDEX] == index, "TLBP finds indexed entry");
        s.nCOP0[CCOP_SCU::ENTRYHI] ^= 1;
        Check(run(0x42000008) && (s.nCOP0[CCOP_SCU::INDEX] & 0x80000000), "TLBP reports ASID miss");
    }
    for(uint32 index = 48; index < 64; ++index)
    {
        f.Prepare(0);
        auto& s = f.cpu.m_State;
        s.nCOP0[CCOP_SCU::INDEX] = index;
        s.nCOP0[CCOP_SCU::ENTRYHI] = 0x40000042;
        auto before = s;
        Check(run(0x42000002) && !memcmp(before.tlbEntries, s.tlbEntries, sizeof(s.tlbEntries)),
              "reserved TLB index cannot alias a real slot");
    }
    f.Prepare(0);
    auto& s = f.cpu.m_State;
    s.nCOP0[CCOP_SCU::INDEX] = 20;
    s.nCOP0[CCOP_SCU::ENTRYHI] = 0x401FFFFF;
    s.nCOP0[CCOP_SCU::PAGEMASK] = 0x1FE000;
    s.nCOP0[CCOP_SCU::ENTRYLO0] = 7;
    s.nCOP0[CCOP_SCU::ENTRYLO1] = 6;
    run(0x42000002);
    Check(s.tlbEntries[20].entryHi == 0x400000FF && s.tlbEntries[20].entryLo0 == 6,
          "TLBWI masks VPN by PageMask and combines global bits");
    for(auto& entry : s.tlbEntries) entry.entryHi = 0x60000000;
    s.tlbEntries[20] = {0, 0, 0, 0};
    s.nCOP0[CCOP_SCU::ENTRYHI] = 0;
    Check(run(0x42000008) && s.nCOP0[CCOP_SCU::INDEX] == 20,
          "TLBP matches page zero even when invalid");
}

static void TlbDelayTests()
{
    Fixture f;
    for(bool nested : {false, true})
    for(uint32 branch : {0u, 0x10000002u, 0x14000002u, 0x50000002u, 0x54000002u})
    {
        f.Prepare(0x23);
        f.code[1] = f.code[0];
        f.code[0] = branch;
        f.cpu.m_TLBExceptionChecker = &CPS2OS::CheckTLBExceptions;
        auto& s = f.cpu.m_State;
        s.nCOP0[CCOP_SCU::STATUS] = nested ? CMIPS::STATUS_EXL : 0;
        s.nCOP0[CCOP_SCU::EPC] = 0x76543210;
        s.nCOP0[CCOP_SCU::CAUSE] = 0x400;
        f.Run();
        if(branch == 0x54000002) // not-taken BNEL annuls its delay slot
            Check((s.nHasException & ~MIPS_EXCEPTION_STATUS_QUOTADONE) == 0 && s.nCOP0[CCOP_SCU::EPC] == 0x76543210, "annulled delay slot cannot fault");
        else
            Check(s.nHasException != 0 && s.nCOP0[CCOP_SCU::EPC] == (nested ? 0x76543210 : branch ? 0x1000 : 0x1004) &&
                  (s.nCOP0[CCOP_SCU::CAUSE] & 0x80000000) == ((!nested && branch) ? 0x80000000 : 0) && accesses == 0,
                  "EPC/BD for taken, untaken, likely and nested exceptions");
    }
    f.Prepare(0x23);
    f.cpu.m_TLBExceptionChecker = &CPS2OS::CheckTLBExceptions;
    f.cpu.m_pAddrTranslator = &CPS2OS::TranslateAddressTLB;
    f.Run();
    Check(f.cpu.m_State.nHasException != 0 && accesses == 0, "unmapped load faults before access");
    auto& s = f.cpu.m_State;
    s.tlbEntries[30] = {(0x2000 >> 6) | 7, 0, 0x40002000, 0};
    s.nPC = s.nCOP0[CCOP_SCU::EPC];
    s.nHasException = 0; s.cycleQuota = 1;
    f.Run();
    Check((s.nHasException & ~MIPS_EXCEPTION_STATUS_QUOTADONE) == 0 && s.nGPR[2].nV0 == f.data[0], "repaired mapping allows faulting instruction to retry");
}

static void TlbRoutingTests()
{
    Fixture f;
    CMIPS iop{MEMORYMAP_ENDIAN_LSBF};
    std::vector<uint8> ram(0x2000000), bios(0x400000), spr(0x4000), iopRam(0x200000);
    CIopBios iopBios(iop, iopRam.data(), spr.data());
    CDMAC dmac(ram.data(), spr.data(), ram.data(), ram.data(), f.cpu);
    CSIF sif(dmac, ram.data(), iopRam.data());
    CGSHandler* gs = nullptr;
    CPS2OS os(f.cpu, ram.data(), bios.data(), spr.data(), gs, sif, iopBios);
    auto& s = f.cpu.m_State;
    auto install = [&](uint32 syscall, uint32 cause, uint32 handler) {
        f.code[0] = 0xC;
        s.nCOP0[CCOP_SCU::EPC] = 0x1000;
        s.nGPR[3].nV0 = syscall; s.nGPR[4].nV0 = cause; s.nGPR[5].nV0 = handler;
        os.HandleSyscall();
    };
    install(0xD, 2, 0x1800); install(0xD, 3, 0x1900);
    for(uint32 cause : {1u, 2u, 3u}) install(0xE, cause, 0x2000 + cause * 0x100);
    Check(f.cpu.m_TLBExceptionChecker == &CPS2OS::CheckTLBExceptions, "common/refill syscall enables checks");
    for(bool nested : {false, true})
    for(uint32 kind : {0u, 1u, 2u})
    for(uint32 write : {0u, 1u})
    {
        if(kind == 2 && !write) continue;
        f.Prepare(0x23);
        s.nCOP0[CCOP_SCU::ENTRYHI] = 0x42;
        if(kind) s.tlbEntries[20] = {kind == 2 ? 2u : 0u, 0, 0x40000042, 0};
        s.nCOP0[CCOP_SCU::STATUS] = nested ? CMIPS::STATUS_EXL : 0; // interrupts disabled
        s.nDelayedJumpAddr = 0xABC0;
        CPS2OS::CheckTLBExceptions(&f.cpu, 0x40000000, write);
        os.HandleTLBException();
        uint32 cause = kind == 2 ? 1 : write ? 3 : 2;
        Check(s.nPC == ((!kind && !nested) ? (write ? 0x1900 : 0x1800) : 0x2000 + cause * 0x100) &&
              (s.nCOP0[CCOP_SCU::STATUS] & CMIPS::STATUS_EXL) && s.nHasException == 0 &&
              s.nDelayedJumpAddr == MIPS_INVALID_PC, "refill/common vector routing with interrupts disabled");
    }
    // Handlers live in the existing RAM state region, including across a restore.
    auto saved = ram;
    for(uint32 cause : {1u, 2u, 3u}) install(0xE, cause, 0);
    install(0xD, 2, 0); install(0xD, 3, 0);
    Check(f.cpu.m_TLBExceptionChecker == nullptr, "removing all handlers disables checks");
    memcpy(ram.data(), saved.data(), ram.size());
    os.UpdateTLBEnabledState();
    s.nHasException = MIPS_EXCEPTION_TLB; s.nCOP0[CCOP_SCU::CAUSE] = 4;
    os.HandleTLBException();
    Check(s.nPC == 0x2100 && f.cpu.m_TLBExceptionChecker != nullptr, "restored RAM restores common TLB handlers");
}
