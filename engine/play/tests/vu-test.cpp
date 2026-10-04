#include "MemoryUtils.h"
#include "BasicBlock.h"
#include "Jitter_CodeGen_Wasm.h"
#include "ee-test-registry.h"
#include "VuAssembler.h"
#include <cstring>
#define main upstream_main
#include "Main.cpp"
#undef main

static void FlagsAcrossUploads()
{
    CTestVm vm;
    for(bool retainedCache : {false, true})
    {
        CVuExecutor::SetKeepCachedBlocksOnReset(retainedCache);
        vm.Reset();
        auto mem = reinterpret_cast<uint32*>(vm.m_microMem);
        CVuAssembler producer(mem);
        producer.Write(CVuAssembler::Upper::SUBbc(CVuAssembler::DEST_W, CVuAssembler::VF0,
                       CVuAssembler::VF2, CVuAssembler::VF1, CVuAssembler::BC_X), CVuAssembler::Lower::NOP());
        for(int i = 0; i < 5; ++i) producer.Write(CVuAssembler::Upper::NOP(), CVuAssembler::Lower::NOP());
        producer.Write(CVuAssembler::Upper::NOP() | CVuAssembler::Upper::E_BIT, CVuAssembler::Lower::NOP());
        producer.Write(CVuAssembler::Upper::NOP(), CVuAssembler::Lower::NOP());
        vm.ExecuteTest(0);
        // No flag reader existed when the producer was compiled or executed.
        CVuAssembler consumer(mem + 64);
        consumer.Write(CVuAssembler::Upper::NOP(), CVuAssembler::Lower::FSAND(CVuAssembler::VI13, 0x41));
        consumer.Write(CVuAssembler::Upper::NOP() | CVuAssembler::Upper::E_BIT, CVuAssembler::Lower::NOP());
        consumer.Write(CVuAssembler::Upper::NOP(), CVuAssembler::Lower::NOP());
        vm.m_executor.ClearActiveBlocksInRange(256, 280, false);
        vm.ExecuteTest(256);
        TEST_VERIFY(vm.m_cpu.m_State.nCOP2VI[13] == 0x41); // current Z and sticky Z
    }
    CVuExecutor::SetKeepCachedBlocksOnReset(false);
    puts("PASS: VU flags across uploads and retained caches");
}

int main(int argc, const char** argv)
{
    RegisterTestFunctions();
    if(argc > 1 && !strcmp(argv[1], "--assertion-self-test")) { TEST_VERIFY(false); }
    if(argc > 1 && !strcmp(argv[1], "--uploads")) { FlagsAcrossUploads(); return 0; }
    // Name each upstream test so a failure is actionable even with optimizations enabled.
    const char* names[] = {"Add", "Branch", "DynamicStall", "DynamicStall2", "FdivEfuMix",
        "Flags1", "Flags2", "Flags3", "Flags4", "IntBranchDelay1", "IntBranchDelay2", "IntBranchDelay3",
        "MinMax", "MinMaxFlags", "Stall1", "Stall2", "Stall3", "Stall4", "Stall5", "Stall6", "TriAce"};
    fesetround(FE_TOWARDZERO);
    FpUtils::SetDenormalHandlingMode();
    CTestVm vm;
    unsigned index = 0, failures = 0;
    for(const auto& factory : s_factories)
    {
        printf("RUN: %s\n", names[index]);
        vm.Reset();
        std::unique_ptr<CTest> test(factory());
        try { test->Execute(vm); printf("PASS: %s\n", names[index]); }
        catch(const std::exception& e) {
            ++failures;
            printf("FAIL: %s (%s), VF3=%08x %08x %08x %08x\n", names[index], e.what(),
                   vm.m_cpu.m_State.nCOP2[3].nV0, vm.m_cpu.m_State.nCOP2[3].nV1,
                   vm.m_cpu.m_State.nCOP2[3].nV2, vm.m_cpu.m_State.nCOP2[3].nV3);
        }
        ++index;
    }
    try { FlagsAcrossUploads(); }
    catch(const std::exception& e) { ++failures; printf("FAIL: uploads (%s)\n", e.what()); }
    printf("VU: %u upstream tests plus upload regressions, %u failures\n", index, failures);
    return failures ? 1 : 0;
}
