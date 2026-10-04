// em++ -O2 -std=c++17 -I<Play>/Source -I<Play>/deps/Framework/include
//   frame-limiter-test.cpp <Play>/Source/FrameLimiter.cpp -o frame-limiter-test.cjs
#include <cstdio>
#include <emscripten.h>
#include "FrameLimiter.h"

int main()
{
    CFrameLimiter limiter;
    limiter.SetFrameRate(60);
    double worstWait = 0;
    for(int n = 0; n < 8; n++)
    {
        limiter.BeginFrame();
        double start = emscripten_get_now();
        while(emscripten_get_now() - start < 85) {} // work already missed the deadline
        double before = emscripten_get_now();
        limiter.EndFrame();
        double wait = emscripten_get_now() - before;
        if(wait > worstWait) worstWait = wait;
    }
    if(worstWait > 8) { printf("FAIL: late frames slept %.2f ms\n", worstWait); return 1; }
    limiter.SetFrameRate(60);
    limiter.BeginFrame();
    double before = emscripten_get_now();
    limiter.EndFrame();
    double wait = emscripten_get_now() - before;
    if(wait < 12) { printf("FAIL: fast frame was not limited (%.2f ms)\n", wait); return 1; }
    // A medium hitch used to leave up to four frames of debt. The next frames
    // ran unthrottled to repay it, producing a visible slow/fast rubber band.
    for(double hitch : {35.0, 55.0, 70.0, 110.0})
    {
        limiter.BeginFrame();
        double start = emscripten_get_now();
        while(emscripten_get_now() - start < hitch) {}
        limiter.EndFrame();
        for(int n = 0; n < 4; n++)
        {
            limiter.BeginFrame();
            double before = emscripten_get_now();
            limiter.EndFrame();
            double wait = emscripten_get_now() - before;
            if(wait < 12)
            {
                printf("FAIL: %.0f ms hitch caused a catch-up frame of %.2f ms\n", hitch, wait);
                return 1;
            }
        }
    }
    // Also miss a deadline from *inside* EndFrame (like a late timer wakeup
    // or a JIT precompile that exceeds its budget), not just during game work.
    bool overran = false;
    limiter.SetIdleWork([&](double) {
        overran = true;
        double start = emscripten_get_now();
        while(emscripten_get_now() - start < 35) {}
        return false;
    });
    for(int n = 0; n < 20 && !overran; n++)
    {
        limiter.BeginFrame();
        limiter.EndFrame();
    }
    if(!overran) { printf("FAIL: idle-work overrun was not exercised\n"); return 1; }
    limiter.SetIdleWork({});
    limiter.BeginFrame();
    before = emscripten_get_now();
    limiter.EndFrame();
    wait = emscripten_get_now() - before;
    if(wait < 12) { printf("FAIL: limiter overrun caused catch-up (%.2f ms)\n", wait); return 1; }
    limiter.SetFrameRate(0);
    limiter.BeginFrame();
    before = emscripten_get_now();
    limiter.EndFrame();
    if(emscripten_get_now() - before > 8) { printf("FAIL: uncapped frame waited\n"); return 1; }
    printf("PASS: late frames add at most %.2f ms; hitches and limiter overruns do not cause catch-up; uncapped mode remains free\n", worstWait);
}
