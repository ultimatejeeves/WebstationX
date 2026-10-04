#include <cstdio>
#include <vector>
#include <array>
#include "iop/Iop_SpuBase.h"
#include "MemStream.h"
#include "app_shared/DefaultAppConfig.h"
#include "states/RegisterStateCollectionFile.h"
#include <string>

static CRegisterStateCollectionFile Snapshot(Iop::CSpuBase& spu, unsigned core)
{
    Framework::CMemStream saved;
    Framework::CZipArchiveWriter writer;
    spu.SaveState(writer);
    writer.Write(saved);
    saved.Seek(0, Framework::STREAM_SEEK_SET);
    Framework::CZipArchiveReader reader(saved);
    auto name = "iop_spu/spu_" + std::to_string(core) + ".xml";
    return CRegisterStateCollectionFile(*reader.BeginReadFile(name.c_str()));
}

int main()
{
    unsigned checks = 0, failures = 0;
    for(unsigned core : {0u, 1u})
    for(unsigned phase : {0u, 1u, 73u, 255u})
    for(unsigned partial : {128u, 512u, 1024u})
    for(unsigned baseRate : {44100u, 48000u})
    for(bool bypass : {false, true})
    {
        std::vector<uint8> ram(0x200000);
        Iop::CSpuSampleCache cache;
        Iop::CSpuIrqWatcher irq;
        Iop::CSpuBase spu(ram.data(), ram.size(), &cache, &irq, core);
        spu.SetDestinationSamplingRate(48000);
        spu.SetBaseSamplingRate(baseRate);
        spu.SetInputBypass(bypass);
        spu.SetTransferMode(core ? spu.TRANSFER_MODE_BLOCK_CORE1IN : spu.TRANSFER_MODE_BLOCK_CORE0IN);
        std::array<int16, 512> input;
        for(unsigned i = 0; i < input.size(); ++i) input[i] = i * 31 - 8192;
        spu.ReceiveDma(reinterpret_cast<uint8*>(input.data()), 16, 64, 0);
        std::array<int16, 512> warm{};
        spu.Render(warm.data(), phase * 2);
        spu.ReceiveDma(reinterpret_cast<uint8*>(input.data()), 16, partial / 16, 0);
        auto savedRam = ram;
        Framework::CMemStream saved;
        Framework::CZipArchiveWriter writer;
        spu.SaveState(writer);
        writer.Write(saved);
        auto trace = [&]() {
            std::vector<int32> result;
            for(unsigned tick = 0; tick < 40; ++tick)
            {
                result.push_back(spu.ReceiveDma(reinterpret_cast<uint8*>(input.data()), 16, 8, 0));
                std::array<int16, 32> output{};
                spu.Render(output.data(), output.size());
                result.insert(result.end(), output.begin(), output.end());
            }
            return result;
        };
        auto expected = trace();
        // Deliberately leave a different buffered audio/DMA phase before restoring.
        trace();
        spu.SetBaseSamplingRate(baseRate == 48000 ? 44100 : 48000);
        spu.SetInputBypass(!bypass);
        std::copy(savedRam.begin(), savedRam.end(), ram.begin());
        saved.Seek(0, Framework::STREAM_SEEK_SET);
        Framework::CZipArchiveReader reader(saved);
        spu.LoadState(reader);
        auto actual = trace();
        ++checks;
        if(expected != actual)
        {
            ++failures;
            printf("FAIL: SPU%u restore phase=%u queued=%u clock=%u bypass=%u\n", core, phase, partial, baseRate, bypass);
        }
    }
    for(unsigned core : {0u, 1u})
    for(unsigned baseRate : {44100u, 48000u})
    for(unsigned previousRate : {44100u, 48000u})
    for(bool legacy : {false, true})
    {
        std::vector<uint8> ram(0x200000);
        Iop::CSpuSampleCache cache;
        Iop::CSpuIrqWatcher irq;
        Iop::CSpuBase spu(ram.data(), ram.size(), &cache, &irq, core);
        spu.SetDestinationSamplingRate(48000);
        spu.SetBaseSamplingRate(baseRate);
        auto state = Snapshot(spu, core);
        auto name = "iop_spu/spu_" + std::to_string(core) + ".xml";
        auto file = std::make_unique<CRegisterStateCollectionFile>(name.c_str());
        for(const auto& entry : state)
        {
            // A legacy silent core has no input/clock fields to infer from.
            file->InsertRegisterState(entry.first.c_str(),
                legacy && entry.first == "GlobalRegs" ? CRegisterState{} : entry.second);
        }
        Framework::CMemStream saved;
        Framework::CZipArchiveWriter writer;
        writer.InsertFile(std::move(file));
        writer.Write(saved);
        spu.SetBaseSamplingRate(previousRate);
        saved.Seek(0, Framework::STREAM_SEEK_SET);
        Framework::CZipArchiveReader reader(saved);
        // New states must override even a different machine fallback clock.
        spu.LoadState(reader, legacy ? baseRate : (baseRate == 48000 ? 44100 : 48000));
        spu.GetChannel(0).pitch = 1896;
        spu.OnChannelPitchChanged(0);
        auto restored = Snapshot(spu, core);
        auto actual = restored.GetRegisterState("Channel00Regs").GetRegister32("SR_SrcSamplingRate");
        ++checks;
        if(actual != baseRate * 1896)
        {
            ++failures;
            printf("FAIL: SPU%u clock=%u prior=%u legacy=%u got=%u\n", core, baseRate, previousRate, legacy, actual);
        }
    }
    printf("SPU replay: %u checks, %u failures\n", checks, failures);
    return failures ? 1 : 0;
}
