#include <chrono>
#include <cstdio>
#include <cstring>
#include "MipsJitter.h"
#include "Jitter_CodeGen_Wasm.h"
#include "MemoryFunction.h"
#include "MemStream.h"
#include "BasicBlock.h"
#include "MemoryUtils.h"
#include "ee/VUShared.h"
#include "ee-test-registry.h"

int main()
{
    RegisterTestFunctions();
    unsigned checks = 0, failures = 0;
    CMIPS cpu(MEMORYMAP_ENDIAN_LSBF), reference(MEMORYMAP_ENDIAN_LSBF);
    for(bool locals : {false, true}) {
        Jitter::g_wasmLocalsAsRegisters = locals;
        Framework::CMemStream code;
        CMipsJitter jit(new Jitter::CCodeGen_Wasm());
        jit.SetStream(&code);
        jit.Begin();
        VUShared::GetStatus(&jit, offsetof(CMIPS, m_State.nCOP2VI[1]), 7);
        jit.End();
        CMemoryFunction function(code.GetBuffer(), code.GetSize());
        uint32 seed = 0x23911983;
        auto random = [&]() { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return seed; };
        for(unsigned i = 0; i < 200000; ++i) {
            cpu.Reset();
            cpu.m_State.pipeTime = i < 131072 ? 100 : random();
            cpu.m_State.pipeMac.index = random() & (FLAG_PIPELINE_SLOTS - 1);
            cpu.m_State.pipeSticky.index = random() & (FLAG_PIPELINE_SLOTS - 1);
            cpu.m_State.nCOP2MF = random();
            cpu.m_State.nCOP2SF = random();
            cpu.m_State.nCOP2DF = i < 131072 ? i >> 16 : random();
            for(unsigned slot = 0; slot < FLAG_PIPELINE_SLOTS; ++slot) {
                cpu.m_State.pipeMac.values[slot] = i < 131072 ? i & 255 : random();
                cpu.m_State.pipeSticky.values[slot] = i < 131072 ? (i >> 8) & 255 : random();
                cpu.m_State.pipeMac.pipeTimes[slot] = cpu.m_State.pipeTime + (i < 131072 ? 0 : random() % 16);
                cpu.m_State.pipeSticky.pipeTimes[slot] = cpu.m_State.pipeTime + (i < 131072 ? 0 : random() % 16);
            }
            reference.m_State = cpu.m_State;
            VUShared::CheckFlagPipelineImmediate(VUShared::g_pipeInfoMac, &reference, 7);
            VUShared::CheckFlagPipelineImmediate(VUShared::g_pipeInfoSticky, &reference, 7);
            unsigned mac = reference.m_State.nCOP2MF, sticky = reference.m_State.nCOP2SF;
            unsigned expected = !!(mac & 15) | (!!(mac & 240) << 1) |
                (!!(sticky & 15) << 6) | (!!(sticky & 240) << 7) | (!!reference.m_State.nCOP2DF << 5);
            reference.m_State.nCOP2VI[1] = expected;
            function(&cpu);
            ++checks;
            if(memcmp(&cpu.m_State, &reference.m_State, sizeof(cpu.m_State))) {
                if(failures < 8) printf("FAIL status: sample=%u expected=%08x actual=%08x\n", i, expected, cpu.m_State.nCOP2VI[1]);
                ++failures;
            }
        }
        // Informational JIT microbenchmark; gameplay measurements remain separate.
        auto start = std::chrono::steady_clock::now();
        for(unsigned i = 0; i < 2000000; ++i) function(&cpu);
        double ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - start).count() / 2000000;
        printf("STATUS locals=%u: %zu module bytes, %.1f ns/call\n", locals, size_t(code.GetSize()), ns);
    }
    printf("VU status: %u complete-state comparisons, %u failures\n", checks, failures);
    return failures ? 1 : 0;
}
