import { describe, expect, it } from "vitest";
import { detectHardware, fakeHardware, type ExecFile, type HardwareDeps } from "../../src/capacity/hardware.js";

const GIB = 2 ** 30;
const NOW = new Date("2026-11-15T12:00:00.000Z");

/** system_profiler output with the fields detection must never read (serial numbers, vendor ids). */
const SYSTEM_PROFILER = JSON.stringify({
  SPDisplaysDataType: [
    {
      _name: "Apple M2 Max",
      sppci_model: "Apple M2 Max",
      sppci_cores: "38",
      spdisplays_vendor: "sppci_vendor_Apple",
      spdisplays_ndrvs: [{ _name: "Built-in Display", _spdisplays_display_serial_number: "SERIAL-TESTKEY-0001" }],
    },
  ],
});

function deps(over: Partial<HardwareDeps> = {}, execFile?: ExecFile) {
  const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const exec: ExecFile = execFile ?? (async () => ({ stdout: "" }));
  const recorded: ExecFile = async (file, args, opts) => {
    calls.push({ file, args, opts: opts as unknown as Record<string, unknown> });
    return exec(file, args, opts);
  };
  const d: HardwareDeps = {
    execFile: recorded,
    platform: "darwin",
    arch: "arm64",
    totalmem: () => 32 * GIB,
    cpus: () => Array.from({ length: 12 }, () => ({ model: "Apple M2 Max" })),
    release: () => "25.0.0",
    which: () => null,
    env: {},
    now: () => NOW,
    ...over,
  };
  return { d, calls };
}

describe("detectHardware", () => {
  it("on Apple Silicon reads the GPU from system_profiler and reports unified memory as GPU memory", async () => {
    const { d, calls } = deps({}, async () => ({ stdout: SYSTEM_PROFILER }));
    const info = await detectHardware(d);
    expect(info).toEqual({
      cpu: "Apple M2 Max", cores: 12, memoryGb: 32, gpu: "Apple M2 Max", gpuMemoryGb: 32,
      platform: "darwin", wsl: false, detectedAt: NOW.toISOString(),
    });
    expect(info.gpuMemoryGb).toBe(info.memoryGb);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["SPDisplaysDataType", "-json"]);
    expect(calls[0]!.file).toMatch(/system_profiler$/);
    expect(JSON.stringify(info)).not.toContain("SERIAL");
  });

  it("on an Intel Mac reads the GPU name but leaves its memory unreported", async () => {
    const out = JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "Intel Iris Plus Graphics" }] });
    const { d } = deps({ arch: "x64", totalmem: () => 16.4 * GIB }, async () => ({ stdout: out }));
    expect(await detectHardware(d)).toMatchObject({ gpu: "Intel Iris Plus Graphics", gpuMemoryGb: null, memoryGb: 16.4 });
  });

  it("on Linux reads the first nvidia-smi line found on PATH", async () => {
    const { d, calls } = deps(
      { platform: "linux", arch: "x64", which: (c) => (c === "nvidia-smi" ? "/usr/bin/nvidia-smi" : null), release: () => "6.8.0-generic" },
      async () => ({ stdout: "NVIDIA GeForce RTX 4090, 24564 MiB\nNVIDIA GeForce RTX 3060, 12288 MiB\n" }),
    );
    const info = await detectHardware(d);
    expect(info).toMatchObject({ gpu: "NVIDIA GeForce RTX 4090", gpuMemoryGb: 24, platform: "linux", wsl: false });
    expect(calls).toEqual([
      { file: "/usr/bin/nvidia-smi", args: ["--query-gpu=name,memory.total", "--format=csv,noheader"], opts: expect.objectContaining({ timeout: 10000, windowsHide: true }) },
    ]);
  });

  it("on Windows falls back to nvidia-smi under SystemRoot when none is on PATH", async () => {
    const { d, calls } = deps(
      { platform: "win32", arch: "x64", env: { SYSTEMROOT: "C:\\Windows" }, release: () => "10.0.26100" },
      async () => ({ stdout: "NVIDIA RTX A2000, 6138 MiB" }),
    );
    expect(await detectHardware(d)).toMatchObject({ gpu: "NVIDIA RTX A2000", gpuMemoryGb: 6, platform: "win32" });
    expect(calls.map((c) => c.file)).toEqual(["C:\\Windows\\System32\\nvidia-smi.exe"]);
  });

  it("leaves the GPU null and never throws when the program fails or is missing", async () => {
    const failing = deps({}, async () => {
      throw new Error("spawn ENOENT");
    });
    expect(await detectHardware(failing.d)).toMatchObject({ gpu: null, gpuMemoryGb: null, cpu: "Apple M2 Max", memoryGb: 32 });

    const missing = deps({ platform: "linux", which: () => null });
    expect(await detectHardware(missing.d)).toMatchObject({ gpu: null, gpuMemoryGb: null });
    expect(missing.calls).toEqual([]);
  });

  it("parses defensively: malformed output leaves the GPU null", async () => {
    for (const stdout of ["not json", "{}", JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 7 }] }), JSON.stringify({ SPDisplaysDataType: "x" })]) {
      const { d } = deps({}, async () => ({ stdout }));
      expect((await detectHardware(d)).gpu).toBeNull();
    }
    for (const stdout of ["", "garbage", "Name only", "NVIDIA, lots MiB"]) {
      const { d } = deps({ platform: "linux", which: () => "/usr/bin/nvidia-smi" }, async () => ({ stdout }));
      expect(await detectHardware(d)).toMatchObject({ gpu: null, gpuMemoryGb: null });
    }
  });

  it("never throws when the os lookups throw, leaving those fields null", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const { d } = deps({ cpus: boom, totalmem: boom, release: boom, platform: "linux" });
    expect(await detectHardware(d)).toMatchObject({ cpu: null, cores: null, memoryGb: null, wsl: false });
  });

  it("detects WSL from a Linux kernel release naming Microsoft", async () => {
    const { d } = deps({ platform: "linux", release: () => "5.15.0-microsoft-standard" });
    expect((await detectHardware(d)).wsl).toBe(true);
    const mac = deps({ release: () => "5.15.0-microsoft-standard" });
    expect((await detectHardware(mac.d)).wsl).toBe(false);
  });

  it("runs every program with an argument array, a timeout, bounded output and no window, never a shell command line", async () => {
    const platforms: Partial<HardwareDeps>[] = [
      {},
      { platform: "linux", which: () => "/usr/bin/nvidia-smi" },
      { platform: "win32", which: () => "C:\\Tools\\nvidia-smi.exe", env: { SystemRoot: "C:\\Windows" } },
    ];
    for (const over of platforms) {
      const { d, calls } = deps(over, async () => {
        throw new Error("fails");
      });
      await detectHardware(d);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.opts).toMatchObject({ timeout: 10000, windowsHide: true });
        expect(c.opts.maxBuffer).toBeGreaterThan(0);
        expect(c.opts.maxBuffer).toBeLessThanOrEqual(1024 * 1024);
        expect(c.opts).not.toHaveProperty("shell");
        expect(Array.isArray(c.args)).toBe(true);
        for (const s of [c.file, ...c.args]) expect(s).not.toMatch(/ /);
      }
    }
  });

  it("caps a long or control-character name instead of recording it whole", async () => {
    const out = JSON.stringify({ SPDisplaysDataType: [{ sppci_model: `GPU\u0000\n${"x".repeat(500)}` }] });
    const { d } = deps({}, async () => ({ stdout: out }));
    const gpu = (await detectHardware(d)).gpu!;
    expect(gpu.length).toBeLessThanOrEqual(120);
    expect(gpu).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe("fakeHardware", () => {
  it("is a fixed machine for tests", () => {
    expect(fakeHardware).toMatchObject({ cpu: "Fake CPU", cores: 8, memoryGb: 32, gpu: "Fake GPU", gpuMemoryGb: 24, wsl: false });
    expect(["darwin", "win32", "linux"]).toContain(fakeHardware.platform);
  });
});
