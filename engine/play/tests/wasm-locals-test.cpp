// Compile with em++ plus CodeGen/src/WasmModuleBuilder.cpp and Framework/src/{Stream,MemStream}.cpp.
// Validates real emitted modules in V8, including the 127 -> 128 LEB length boundary that crashed ATV2.
#include <cstdio>
#include <emscripten.h>
#include "WasmModuleBuilder.h"
#include "MemStream.h"

int main()
{
    for(unsigned type = 0; type < 5; type++)
    {
        for(uint32 count : {0u, 1u, 127u, 128u, 255u, 16383u, 16384u})
        {
            CWasmModuleBuilder builder;
            builder.AddFunctionType({{}, {}});
            CWasmModuleBuilder::FUNCTION function;
            if(type == 0 || type == 4) function.localI32Count = count;
            if(type == 1 || type == 4) function.localI64Count = count;
            if(type == 2 || type == 4) function.localF32Count = count;
            if(type == 3 || type == 4) function.localV128Count = count;
            function.code = {0x0B}; // end
            builder.AddFunction(function);
            Framework::CMemStream stream;
            builder.WriteModule(stream);
            // V8 limits total locals to 50k; the mixed case exercises the lower boundaries.
            if(type == 4 && count > 255) continue;
            int valid = EM_ASM_INT({
                const bytes = HEAPU8.slice($0, $0 + $1);
                try { new WebAssembly.Module(bytes); return 1; }
                catch(e) { console.error(e.message); return 0; }
            }, stream.GetBuffer(), stream.GetSize());
            if(!valid) { printf("FAIL type=%u locals=%u\n", type, count); return 1; }
        }
    }
    puts("PASS: emitted wasm modules at all local-count boundaries");
}
