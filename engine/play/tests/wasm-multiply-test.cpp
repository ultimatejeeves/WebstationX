#include <cstdio>
#include <cstddef>
#include <chrono>
#include <vector>
#include "Jitter.h"
#include "Jitter_CodeGen_Wasm.h"
#include "MemoryFunction.h"
#include "MemStream.h"
#include "BasicBlock.h"
#include "MemoryUtils.h"
#include "ee-test-registry.h"

// Independent integer significand oracle for finite IEEE binary32 truncation.
static uint32 Expected(uint32 a, uint32 b)
{
    uint32 sign = (a ^ b) & 0x80000000;
    int ea = (a >> 23) & 255, eb = (b >> 23) & 255;
    uint64 ma = (a & 0x7FFFFF) | (ea ? 0x800000 : 0);
    uint64 mb = (b & 0x7FFFFF) | (eb ? 0x800000 : 0);
    uint64 product = ma * mb;
    if(!product) return sign;
    int power = (ea ? ea - 150 : -149) + (eb ? eb - 150 : -149);
    int top = 0;
    for(uint64 p = product; p >>= 1;) ++top;
    int exponent = top + power;
    if(exponent > 127) return sign | 0x7F7FFFFF;
    if(exponent < -126)
    {
        int shift = -149 - power;
        return sign | (shift >= 64 ? 0 : shift >= 0 ? product >> shift : product << -shift);
    }
    uint64 significand = top >= 23 ? product >> (top - 23) : product << (23 - top);
    return sign | ((exponent + 127) << 23) | (significand & 0x7FFFFF);
}

static unsigned TestSignZero()
{
    struct alignas(16) Context { uint32 input[4], flags; } context{};
    unsigned checks = 0, failures = 0;
    const uint32 edges[] = {0, 0x80000000, 0x3F800000, 0xBF800000,
        1, 0x80000001, 0x7F800000, 0xFFC00001};
    for(bool locals : {false, true})
    {
        Jitter::g_wasmLocalsAsRegisters = locals;
        Jitter::CJitter jit(new Jitter::CCodeGen_Wasm());
        Framework::CMemStream code;
        jit.SetStream(&code);
        jit.Begin();
        jit.MD_PushRel(offsetof(Context, input));
        jit.MD_MakeSignZero();
        jit.PullRel(offsetof(Context, flags));
        jit.End();
        CMemoryFunction function(code.GetBuffer(), code.GetSize());
        uint32 seed = 0x87654321;
        for(unsigned batch = 0; batch < 20000; ++batch)
        {
            unsigned expected = 0;
            for(unsigned lane = 0; lane < 4; ++lane)
            {
                seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
                auto value = batch < 4096 ? edges[(batch >> (lane * 3)) & 7] : seed;
                context.input[lane] = value;
                if(value & 0x80000000) expected |= 128 >> lane;
                if((value & 0x7FFFFFFF) == 0) expected |= 8 >> lane;
            }
            function(&context);
            ++checks;
            if(context.flags != expected)
            {
                if(failures < 8) printf("FAIL: flags expected=%02x actual=%02x\n", expected, context.flags);
                ++failures;
            }
        }
        auto start = std::chrono::steady_clock::now();
        for(unsigned i = 0; i < 5000000; ++i) function(&context);
        double ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - start).count() / 5000000;
        printf("Sign/zero locals=%u: %zu module bytes, %.1f ns/call\n", locals, size_t(code.GetSize()), ns);
    }
    printf("Wasm sign/zero: %u checks, %u failures\n", checks, failures);
    return failures;
}

int main(int argc, char**)
{
    RegisterTestFunctions();
    struct alignas(16) Context { uint32 a[4], b[4], result[4]; } context{};
    unsigned checks = 0, failures = 0;
    for(bool locals : {false, true})
    for(bool alias : {false, true})
    {
        Jitter::g_wasmLocalsAsRegisters = locals;
        auto backend = new Jitter::CCodeGen_Wasm();
        backend->SetTruncateFloatMultiply(argc == 1);
        Jitter::CJitter jit(backend);
        Framework::CMemStream code;
        jit.SetStream(&code);
        jit.Begin();
        jit.MD_PushRel(offsetof(Context, a));
        jit.MD_PushRel(offsetof(Context, b));
        jit.MD_MulS();
        jit.MD_PullRel(alias ? offsetof(Context, a) : offsetof(Context, result));
        jit.End();
        CMemoryFunction function(code.GetBuffer(), code.GetSize());
        uint32 seed = 0x12345678;
        auto random = [&]() { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return seed; };
        const uint32 edges[] = {0, 0x80000000, 1, 0x007FFFFF, 0x00800000, 0x3F800000,
            0x3F800001, 0xBF800001, 0x7F7FFFFF, 0xFF7FFFFF, 0x46FCC888, 0x43A0DA10};
        for(unsigned batch = 0; batch < 20000; ++batch)
        {
            uint32 expected[4];
            for(unsigned lane = 0; lane < 4; ++lane)
            {
                unsigned item = batch * 4 + lane;
                context.a[lane] = batch < 36 ? edges[item / 12] : random();
                context.b[lane] = batch < 36 ? edges[item % 12] : random();
                // Restrict random inputs to finite binary32 values, preserving both signs.
                if((context.a[lane] & 0x7F800000) == 0x7F800000) context.a[lane] ^= 0x00800000;
                if((context.b[lane] & 0x7F800000) == 0x7F800000) context.b[lane] ^= 0x00800000;
                expected[lane] = Expected(context.a[lane], context.b[lane]);
            }
            function(&context);
            for(unsigned lane = 0; lane < 4; ++lane)
            {
                ++checks;
                uint32 actual = alias ? context.a[lane] : context.result[lane];
                if(actual != expected[lane])
                {
                    if(failures < 8) printf("FAIL: lane=%u expected=%08x actual=%08x\n", lane, expected[lane], actual);
                    ++failures;
                }
            }
        }
    }
    printf("Wasm multiply: %u checks, %u failures\n", checks, failures);
    failures += TestSignZero();
    return failures ? 1 : 0;
}
