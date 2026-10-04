// Exercise the actual IOP archive path, including the SPU2 register wrapper.
// These are state-continuity tests, not assertions of hardware IRQ semantics.
#include <cstdio>
#include <vector>
#include <array>
#include <chrono>
#include <cstring>
#include "iop/Iop_SubSystem.h"
#include "iop/IopBios.h"
#include "Ps2Const.h"
#include "MemStream.h"
#include "app_shared/DefaultAppConfig.h"
#include "states/RegisterStateCollectionFile.h"
#include "states/MemoryStateFile.h"
#include "MemoryUtils.h"
#include "BasicBlock.h"
#include "Jitter_CodeGen_Wasm.h"
#include "ee-test-registry.h"

using namespace Iop;
using Core = Spu2::CCore;
static unsigned checks = 0, failures = 0;
static void Check(bool ok, const char* name)
{
    ++checks;
    if(!ok) { ++failures; printf("FAIL: %s\n", name); }
}

static CRegisterStateCollectionFile Snapshot(CSpuBase& spu, unsigned core)
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

static void Save(CSubSystem& iop, Framework::CMemStream& saved, bool legacy)
{
    Framework::CZipArchiveWriter writer;
    iop.SaveState(writer);
    if(!legacy) { writer.Write(saved); return; }
    // Preserve all existing base-core state but remove the new wrapper member.
    Framework::CMemStream full;
    writer.Write(full);
    full.Seek(0, Framework::STREAM_SEEK_SET);
    Framework::CZipArchiveReader reader(full);
    Framework::CZipArchiveWriter old;
    std::vector<std::vector<uint8>> data;
    for(const auto& entry : reader.GetFileHeaders())
    {
        if(entry.first == "iop_spu/spu2.xml") continue;
        auto stream = reader.BeginReadFile(entry.first.c_str());
        data.emplace_back(entry.second.uncompressedSize);
        auto& bytes = data.back();
        stream->Read(bytes.data(), bytes.size());
        old.InsertFile(std::make_unique<CMemoryStateFile>(entry.first.c_str(), bytes.data(), bytes.size()));
    }
    old.Write(saved);
}

static void Load(CSubSystem& iop, Framework::CMemStream& saved)
{
    saved.Seek(0, Framework::STREAM_SEEK_SET);
    Framework::CZipArchiveReader reader(saved);
    iop.LoadState(reader);
}

int main(int argc, char** argv)
{
    RegisterTestFunctions();
    CSubSystem iop(true);
    iop.Reset();
    std::static_pointer_cast<CIopBios>(iop.m_bios)->Reset(PS2::IOP_RAM_SIZE, {});
    auto& spu = iop.m_spu2;
    for(auto* base : {&iop.m_spuCore0, &iop.m_spuCore1}) base->SetDestinationSamplingRate(48000);
    // Both voice register banks, including their first/last channels and the
    // separate address-register stride, must reach the intended voice only.
    for(unsigned core : {0u, 1u})
    for(unsigned voice = 0; voice < 24; ++voice)
    {
        auto& channel = spu.GetCore(core)->GetSpuBase().GetChannel(voice);
        auto voiceAddress = core * 0x400 + voice * 16;
        auto sampleAddress = core * 0x400 + voice * 12;
        auto value = 0x1000 + core * 0x100 + voice;
        spu.WriteRegister(Core::VP_PITCH + voiceAddress, value);
        Check(channel.pitch == value, "voice pitch bank/stride routing");
        spu.WriteRegister(Core::VP_VOLL + voiceAddress, value);
        Check(spu.ReadRegister(Core::VP_VOLL + voiceAddress) == value, "voice volume read/write routing");
        spu.WriteRegister(Core::VA_SSA_HI + sampleAddress, 1);
        spu.WriteRegister(Core::VA_SSA_LO + sampleAddress, value);
        Check(channel.address == ((1u << 17) | (value << 1)), "voice sample-address bank/stride routing");
    }
    // The upper volume bank switches core at 0x788 rather than via bit 10.
    for(unsigned core : {0u, 1u})
    {
        auto& base = spu.GetCore(core)->GetSpuBase();
        spu.WriteRegister(Core::P_AVOLL + core * 40, 0x1234 + core);
        spu.WriteRegister(Core::P_BVOLR + core * 40, 0x2345 + core);
        Check(spu.ReadRegister(Core::P_AVOLL + core * 40) == 0x1234 + core && base.m_extInputVolL == 0x1234 + core, "external-volume bank routing");
        Check(spu.ReadRegister(Core::P_BVOLR + core * 40) == 0x2345 + core && base.m_inputVolR == 0x2345 + core, "input-volume bank routing");
    }
    if(argc > 1 && !strcmp(argv[1], "--bench"))
    {
        // Only register dispatch is timed. Alternate banks and read/write paths;
        // no rendering, archive I/O, or JIT compilation enters the measurement.
        for(unsigned round = 0; round < 6; ++round)
        {
            uint32 checksum = 0;
            auto start = std::chrono::steady_clock::now();
            for(unsigned n = 0; n < 4000000; ++n)
            {
                const auto voiceAddress = Core::VP_VOLL + (n & 1) * 0x400 + (n % 24) * 16;
                const auto volumeAddress = Core::P_BVOLR + (n & 1) * 40;
                spu.WriteRegister(voiceAddress, n & 0x7FFF);
                checksum += spu.ReadRegister(voiceAddress);
                spu.WriteRegister(volumeAddress, n & 0x7FFF);
                checksum += spu.ReadRegister(volumeAddress);
            }
            const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
            printf("dispatch bench %u: %.3f ms checksum=%u\n", round, ms, checksum);
        }
        printf("SPU2 routing: %u checks, %u failures\n", checks, failures);
        return failures ? 1 : 0;
    }
    for(bool legacy : {false, true})
    for(bool bypass : {false, true})
    for(unsigned rate : {44100u, 48000u})
    {
        const unsigned otherRate = rate == 44100 ? 48000 : 44100;
        const unsigned output = 0x21 | (bypass ? 0x100 : 0);
        spu.WriteRegister(CSpu2::C_SPDIF_OUT, output);
        spu.WriteRegister(CSpu2::C_SPDIF_MODE, 0x1234);
        spu.WriteRegister(CSpu2::C_SPDIF_MEDIA, 0x5678);
        // The configured wrapper clock can differ from the currently applied clock.
        spu.GetCore(0)->SetBaseSamplingRate(rate);
        spu.GetCore(1)->SetBaseSamplingRate(otherRate);
        iop.m_spuCore0.SetBaseSamplingRate(otherRate);
        iop.m_spuCore1.SetBaseSamplingRate(rate);
        Framework::CMemStream saved;
        Save(iop, saved, legacy);
        for(unsigned prior : {0u, 0xFFFFu})
        {
            spu.WriteRegister(CSpu2::C_SPDIF_OUT, prior);
            spu.WriteRegister(CSpu2::C_SPDIF_MODE, prior);
            spu.WriteRegister(CSpu2::C_SPDIF_MEDIA, prior);
            spu.GetCore(0)->SetBaseSamplingRate(otherRate);
            spu.GetCore(1)->SetBaseSamplingRate(rate);
            Load(iop, saved);
            Check(spu.ReadRegister(CSpu2::C_SPDIF_OUT) == (legacy ? (bypass ? 0x100u : 0u) : output), "SPDIF output restored independently of prior run");
            Check(spu.ReadRegister(CSpu2::C_SPDIF_MODE) == (legacy ? 0u : 0x1234u), "SPDIF mode restored");
            Check(spu.ReadRegister(CSpu2::C_SPDIF_MEDIA) == (legacy ? 0u : 0x5678u), "SPDIF media restored");
            Check(Snapshot(iop.m_spuCore0, 0).GetRegisterState("GlobalRegs").GetRegister32("InputBypass") == bypass, "restored buffered-input bypass preserved");
            for(unsigned core : {0u, 1u})
            {
                auto& base = spu.GetCore(core)->GetSpuBase();
                auto applied = core ? rate : otherRate;
                Check(Snapshot(base, core).GetRegisterState("GlobalRegs").GetRegister32("BaseSamplingRate") == applied, "load does not apply the pending wrapper clock early");
                spu.WriteRegister(Core::CORE_ATTR + core * 0x400, 0);
                spu.WriteRegister(Core::VP_PITCH + core * 0x400, 1896);
                auto expected = legacy ? 48000u : (core ? otherRate : rate);
                Check(Snapshot(base, core).GetRegisterState("Channel00Regs").GetRegister32("SR_SrcSamplingRate") == expected * 1896, "future control/pitch writes use restored wrapper clock");
            }
        }
    }
    // IRQ watcher pending before render, and IRQINFO pending after render, are
    // separate stages. Restore and replay both without changing their semantics.
    for(unsigned mask = 0; mask < 4; ++mask)
    for(bool renderBeforeSave : {false, true})
    {
        iop.m_spuIrqWatcher.Reset();
        for(unsigned core : {0u, 1u})
        {
            auto& base = spu.GetCore(core)->GetSpuBase();
            base.ClearIrqPending();
            base.SetControl(CSpuBase::CONTROL_IRQ);
            base.SetIrqAddress(0x1000 + core * 16);
            if(mask & (1 << core)) iop.m_spuIrqWatcher.CheckIrq(0x1000 + core * 16);
        }
        auto render = [&]() {
            std::array<int16, 2> samples{};
            iop.m_spuCore0.Render(samples.data(), samples.size());
            iop.m_spuCore1.Render(samples.data(), samples.size());
        };
        if(renderBeforeSave) render();
        Framework::CMemStream saved;
        Save(iop, saved, false);
        auto trace = [&]() {
            if(!renderBeforeSave) render();
            return std::array<uint32, 2>{spu.ReadRegister(CSpu2::C_IRQINFO), spu.ReadRegister(CSpu2::C_IRQINFO)};
        };
        auto expected = trace();
        Check(expected == std::array<uint32, 2>{mask << 2, 0}, "IRQ fixture reaches expected pending/acknowledged phases");
        Load(iop, saved);
        Check(trace() == expected, "pending IRQ survives IOP snapshot and acknowledgement replays");
    }
    spu.WriteRegister(CSpu2::C_SPDIF_OUT, 0xFFFF);
    spu.WriteRegister(CSpu2::C_SPDIF_MODE, 0xFFFF);
    spu.WriteRegister(CSpu2::C_SPDIF_MEDIA, 0xFFFF);
    iop.Reset();
    Check(spu.ReadRegister(CSpu2::C_SPDIF_OUT) == 0, "reset clears SPDIF output");
    Check(spu.ReadRegister(CSpu2::C_SPDIF_MODE) == 0, "reset clears SPDIF mode");
    Check(spu.ReadRegister(CSpu2::C_SPDIF_MEDIA) == 0, "reset clears SPDIF media");
    printf("SPU2 subsystem: %u checks, %u failures\n", checks, failures);
    return failures ? 1 : 0;
}
