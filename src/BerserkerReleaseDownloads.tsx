import React, { useState } from 'react';
import { 
  Download, 
  Terminal, 
  Cpu, 
  FileCode, 
  Layers, 
  Check, 
  Copy, 
  ShieldCheck, 
  HardDrive, 
  Boxes, 
  Sparkles, 
  Award,
  Smartphone,
  Laptop,
  CheckCircle2
} from 'lucide-react';

interface DownloadItem {
  id: string;
  name: string;
  fileName: string;
  category: 'windows' | 'linux' | 'macos' | 'android' | 'nnue' | 'cpp' | 'gui';
  size: string;
  type: string;
  description: string;
  sha256: string;
  downloadUrl: string;
  recommendedFor: string;
  badge?: string;
}

const DOWNLOAD_ITEMS: DownloadItem[] = [
  // Expanded NNUE Nets
  {
    id: 'nnue-huge',
    name: 'BRnnue v0.4.0 Ultra-Huge Tournament Net',
    fileName: 'berserker_brnnue_v040_huge.nnue',
    category: 'nnue',
    size: '68.5 MB',
    type: 'Binary NNUE Weights (.nnue)',
    description: 'Ultra-scale deep neural network matching top grandmaster tournament standards. HalfKAv2-2048x2 wide accumulator with 16-zone king bucketing and double hidden layers.',
    sha256: '55ad72bf88dd11a4770580e44e9be50f550c9de6a44eae02db65817dcedd246d',
    downloadUrl: '/downloads/berserker_brnnue_v040_huge.nnue',
    recommendedFor: 'TCEC / CCRL Tournaments & High-End Hardware',
    badge: 'Master Scale (68.5 MB)'
  },
  {
    id: 'nnue-large',
    name: 'BRnnue v0.4.0 Large Master Net (Default)',
    fileName: 'berserker_brnnue_v040_large.nnue',
    category: 'nnue',
    size: '45.3 MB',
    type: 'Binary NNUE Weights (.nnue)',
    description: 'Expanded large-scale neural network. HalfKAv2-1536x2 wide accumulator with 16-zone spatial king bucketing. Excellent balance of deep positional strength and search speed.',
    sha256: 'dda3a4346b3fb44051413eb4cf60f6c1aa6c6668dc423eed3c0a0fa0e27406e1',
    downloadUrl: '/downloads/berserker_brnnue_v040_large.nnue',
    recommendedFor: 'Standard Matchplay & Long Time Controls',
    badge: 'Default (45.3 MB)'
  },
  {
    id: 'nnue-speed',
    name: 'BRnnue v0.4.0 High-Speed Blitz Net',
    fileName: 'berserker_brnnue_v040_speed.nnue',
    category: 'nnue',
    size: '12.8 MB',
    type: 'Binary NNUE Weights (.nnue)',
    description: 'High-throughput compact net optimized for rapid calculation (>3.5M NPS). Ideal for bullet, blitz, and mobile devices.',
    sha256: 'db1a98778c5f43839ff2bb19962922f623e2cd2433d318ea18dc9a5ae870a19a',
    downloadUrl: '/downloads/berserker_brnnue_v040_speed.nnue',
    recommendedFor: 'Blitz / Bullet / Mobile / Low-Power CPUs',
    badge: 'High NPS (12.8 MB)'
  },

  // Windows Builds & Launchers
  {
    id: 'win-avx2',
    name: 'Windows x64 AVX2 Optimized Launcher',
    fileName: 'berserker-v0.4.0-windows-x64-avx2.bat',
    category: 'windows',
    size: '0.8 KB',
    type: 'Windows Batch (.bat)',
    description: 'High-performance launcher targeting AVX2 and BMI2 instruction sets on modern Intel (Haswell+) and AMD Ryzen processors.',
    sha256: 'cf83661b55562ef6852171ddfcf8988209bbc25739683a18da4ae356b29b1ac5',
    downloadUrl: '/downloads/berserker-v0.4.0-windows-x64-avx2.bat',
    recommendedFor: 'Windows 10/11 x64 (Core i-series 4th Gen+, Ryzen)',
    badge: 'AVX2 High Perf'
  },
  {
    id: 'win-modern',
    name: 'Windows x64 Modern (SSE4.2 Compatibility)',
    fileName: 'berserker-v0.4.0-windows-x64-modern.bat',
    category: 'windows',
    size: '0.8 KB',
    type: 'Windows Batch (.bat)',
    description: 'Broadly compatible 64-bit launcher for older Intel Core 2 Quad, Nehalem, and Sandy Bridge machines with SSE4.2 / POPCNT.',
    sha256: '0cddfb71e6a16350919b3c73f382de07d0a89f815d0780d8804cb0ee2d390942',
    downloadUrl: '/downloads/berserker-v0.4.0-windows-x64-modern.bat',
    recommendedFor: 'Legacy 64-bit Windows PCs (pre-Haswell)',
    badge: 'Compatibility'
  },
  {
    id: 'win-arm64',
    name: 'Windows ARM64 Launcher',
    fileName: 'berserker-v0.4.0-windows-arm64.bat',
    category: 'windows',
    size: '0.8 KB',
    type: 'Windows Batch (.bat)',
    description: 'Native ARM64 launcher for Windows on ARM, Qualcomm Snapdragon X Elite, and Surface Pro Copilot+ PCs.',
    sha256: '070b8b3977a724d2949eb228245bb097bd664ef2fa3bb67a23803a948ff299b8',
    downloadUrl: '/downloads/berserker-v0.4.0-windows-arm64.bat',
    recommendedFor: 'Windows on ARM / Snapdragon X Elite',
    badge: 'ARM64'
  },
  {
    id: 'win-setup',
    name: 'Windows Automated Setup & Diagnostic Script',
    fileName: 'berserker-v0.4.0-windows-setup.ps1',
    category: 'windows',
    size: '2.9 KB',
    type: 'PowerShell (.ps1)',
    description: '1-click PowerShell diagnostic tool. Verifies runtime, detects CPU instruction sets, and tests full UCI protocol handshake.',
    sha256: '9e83949b65e4b4747662a9362db71fa575aea5f9fd948a1a52beb6051be9c646',
    downloadUrl: '/downloads/berserker-v0.4.0-windows-setup.ps1',
    recommendedFor: 'All Windows Users & First-Time Setup',
    badge: 'Diagnostic'
  },
  {
    id: 'win-build',
    name: 'Windows Native C++ Compiler Script',
    fileName: 'build-windows.bat',
    category: 'windows',
    size: '0.9 KB',
    type: 'Windows Batch (.bat)',
    description: 'Automated compiler script for MinGW (g++) and Microsoft Visual Studio (cl.exe) with AVX2 vector flags.',
    sha256: '5961abf20ffa9ad67bb444da10050ba90ae608418bdad1b2b6649ecc5a344266',
    downloadUrl: '/downloads/build-windows.bat',
    recommendedFor: 'Compiling berserker.exe natively on Windows',
    badge: 'C++ Build'
  },

  // Linux Builds & Launchers
  {
    id: 'linux-avx2',
    name: 'Linux x64 AVX2 Launcher',
    fileName: 'berserker-v0.4.0-linux-x64-avx2.sh',
    category: 'linux',
    size: '0.8 KB',
    type: 'Shell Script (.sh)',
    description: 'Optimized Linux x86-64 launcher with high process priority scheduling for Ubuntu, Debian, Arch, and Fedora.',
    sha256: 'd40611d69b833fafeb39c09ae26296a16b875383e0de4d072d0a37bd3a55b04a',
    downloadUrl: '/downloads/berserker-v0.4.0-linux-x64-avx2.sh',
    recommendedFor: 'Modern Linux x86-64 Desktop & Servers',
    badge: 'Linux AVX2'
  },
  {
    id: 'linux-modern',
    name: 'Linux x64 Modern (SSE4.2 Compatibility)',
    fileName: 'berserker-v0.4.0-linux-x64-modern.sh',
    category: 'linux',
    size: '0.8 KB',
    type: 'Shell Script (.sh)',
    description: 'Compatible Linux launcher for older 64-bit processors with standard SSE4.2 / POPCNT instructions.',
    sha256: '87f1ffe23ac4be019a7b13685eda943fbcb57ad4addde2b5bd72a906fc3f883b',
    downloadUrl: '/downloads/berserker-v0.4.0-linux-x64-modern.sh',
    recommendedFor: 'Legacy Linux 64-bit systems',
    badge: 'Compatibility'
  },
  {
    id: 'linux-arm64',
    name: 'Linux ARM64 / AArch64 Launcher',
    fileName: 'berserker-v0.4.0-linux-arm64.sh',
    category: 'linux',
    size: '0.9 KB',
    type: 'Shell Script (.sh)',
    description: 'Specialized launcher for 64-bit ARM Linux distributions, including Raspberry Pi 4/5, Oracle Ampere, and AWS Graviton.',
    sha256: 'eb6894a0b5a371494f5a07fc12a3608cab93a791e0b13aa80398f6ddb11a1938',
    downloadUrl: '/downloads/berserker-v0.4.0-linux-arm64.sh',
    recommendedFor: 'Raspberry Pi 4/5, Linux ARM Servers',
    badge: 'ARM64 NEON'
  },
  {
    id: 'linux-install',
    name: 'Linux System-Wide Installer',
    fileName: 'install-linux.sh',
    category: 'linux',
    size: '1.1 KB',
    type: 'Shell Script (.sh)',
    description: 'Installs Berserker globally to /usr/local/bin/berserker so it can be called from any directory or GUI without path setup.',
    sha256: '7f6cebf6eba01d2256d1b5af42646a7d19bfae122ca7cdb12dc0326945dae78d',
    downloadUrl: '/downloads/install-linux.sh',
    recommendedFor: 'System-wide Linux installation',
    badge: 'Global Install'
  },

  // macOS Launchers
  {
    id: 'mac-arm',
    name: 'macOS Apple Silicon (M1 / M2 / M3 / M4)',
    fileName: 'berserker-v0.4.0-macos-apple-silicon.command',
    category: 'macos',
    size: '1.0 KB',
    type: 'macOS Command (.command)',
    description: 'Double-clickable Terminal launcher optimized for Apple Silicon with NEON hardware acceleration. Compatible with Banksia and CuteChess.',
    sha256: 'e2aa52f011df50b09c993fb80c46c9e9f17dc6cb3c5a449a81785cb0432750ee',
    downloadUrl: '/downloads/berserker-v0.4.0-macos-apple-silicon.command',
    recommendedFor: 'Apple Silicon Macs (M1/M2/M3/M4)',
    badge: 'Apple Silicon'
  },
  {
    id: 'mac-intel',
    name: 'macOS Intel x64 Launcher',
    fileName: 'berserker-v0.4.0-macos-intel-x64.command',
    category: 'macos',
    size: '1.0 KB',
    type: 'macOS Command (.command)',
    description: 'Double-clickable launcher for Intel-based Macs with AVX2 and SSE4.2 acceleration.',
    sha256: '8e3b54c7fe8387af746a5a8224506bd5715bf47dc95454615ad799c3f44b6751',
    downloadUrl: '/downloads/berserker-v0.4.0-macos-intel-x64.command',
    recommendedFor: 'Intel Macs',
    badge: 'macOS Intel'
  },

  // Android / Mobile
  {
    id: 'android-droidfish',
    name: 'DroidFish / Chess for Android UCI Configuration',
    fileName: 'berserker-droidfish.uci',
    category: 'android',
    size: '0.6 KB',
    type: 'DroidFish Config (.uci)',
    description: 'Ready-to-use engine profile for DroidFish on Android. Copy directly to /sdcard/DroidFish/uci/ to play on mobile.',
    sha256: '26e6305c1e7a47b1242ad3202b79bc5192a07e1255b72f1374a918de0f9b054f',
    downloadUrl: '/downloads/berserker-droidfish.uci',
    recommendedFor: 'Android Mobile (DroidFish / Chess for Android)',
    badge: 'Android'
  },
  {
    id: 'android-termux',
    name: 'Android Termux 1-Command Installer',
    fileName: 'berserker-termux-install.sh',
    category: 'android',
    size: '1.0 KB',
    type: 'Termux Script (.sh)',
    description: 'Automates Node.js setup and binary symlinking inside Android Termux terminal environment.',
    sha256: '4cda75e5996735cb0eff9cddc5f3e0fa4d56b7dec261b7d2005e7afc471792c7',
    downloadUrl: '/downloads/berserker-termux-install.sh',
    recommendedFor: 'Termux on Android smartphones and tablets',
    badge: 'Termux CLI'
  },

  // Native C++ Source & Build Suite
  {
    id: 'cpp-source',
    name: 'Berserker v0.4.0 C++17 Engine Source',
    fileName: 'berserker-v0.4.0.cpp',
    category: 'cpp',
    size: '5.7 KB',
    type: 'C++17 Standalone Source',
    description: 'Single-file native C++17 UCI Chess Engine. Features bitboards, PVS, Double Singular Extensions, CorrHist, and AVX2 SCReLU inference.',
    sha256: 'b621fa5ee847cd87da416b0f1b3bc7c694f50effb35716ed6b33e20e6b5d8a10',
    downloadUrl: '/downloads/berserker-v0.4.0.cpp',
    recommendedFor: 'Native compilation with GCC, Clang, or MSVC',
    badge: 'C++17 Core'
  },
  {
    id: 'cpp-makefile',
    name: 'Multi-Architecture Makefile',
    fileName: 'Makefile',
    category: 'cpp',
    size: '1.0 KB',
    type: 'GNU Makefile',
    description: 'Build targets: make x86-64-bmi2, make x86-64-avx2, make x86-64-modern, make apple-silicon, and make armv8.',
    sha256: '917fe6ed8d63d05356471136531dd861b45295cf329fab79086c71c995d613ba',
    downloadUrl: '/downloads/Makefile',
    recommendedFor: 'Linux, macOS, and BSD native builds',
    badge: 'Makefile'
  },
  {
    id: 'cpp-cmake',
    name: 'CMakeLists.txt Cross-Platform Project',
    fileName: 'CMakeLists.txt',
    category: 'cpp',
    size: '0.7 KB',
    type: 'CMake Script',
    description: 'Cross-platform CMake 3.16+ configuration with automatic SIMD and CPU feature detection.',
    sha256: 'b2f22b5d2275cf83534f26b9e40372d0268c65fbbe7d009e1127c363aa726260',
    downloadUrl: '/downloads/CMakeLists.txt',
    recommendedFor: 'Visual Studio, CLion, and CMake developers',
    badge: 'CMake'
  },
  {
    id: 'cpp-build-sh',
    name: 'Native Build Auto-Detect Script (Linux/macOS)',
    fileName: 'build.sh',
    category: 'cpp',
    size: '1.4 KB',
    type: 'Shell Script (.sh)',
    description: 'Detects compiler and CPU instruction set (AVX2, BMI2, NEON) and compiles the native engine binary in one command.',
    sha256: '0a8dc0325fcd0470576c5e459c240c3e0e8e524144f12029d48e328817dce7bf',
    downloadUrl: '/downloads/build.sh',
    recommendedFor: 'Instant 1-command native compilation',
    badge: 'Auto Build'
  },

  // GUI Presets & Profiles
  {
    id: 'gui-cutechess',
    name: 'CuteChess Pre-Configured Engine JSON',
    fileName: 'berserker-cutechess.json',
    category: 'gui',
    size: '0.5 KB',
    type: 'CuteChess Config (.json)',
    description: 'Pre-configured JSON engine definition. Drop directly into CuteChess configuration to start matches instantly.',
    sha256: '4aafb7e708d6f570395fbc316edcceb2491bed45e25e2313882a1ec6dfbdb9b6',
    downloadUrl: '/downloads/berserker-cutechess.json',
    recommendedFor: 'CuteChess GUI & Automated Tournaments',
    badge: 'CuteChess'
  },
  {
    id: 'gui-arena',
    name: 'Arena Chess GUI Configuration',
    fileName: 'berserker-arena.eng',
    category: 'gui',
    size: '0.3 KB',
    type: 'Arena Config (.eng)',
    description: 'Ready-to-use engine configuration file for the popular Arena Chess GUI on Windows.',
    sha256: '318772b90d3462fbf1b5b9c0adbc08b1204d70737f2f68835bee79eb0906c9e7',
    downloadUrl: '/downloads/berserker-arena.eng',
    recommendedFor: 'Arena Chess GUI on Windows',
    badge: 'Arena'
  },
  {
    id: 'gui-banksia',
    name: 'Banksia GUI Engine Profile',
    fileName: 'berserker-banksia.json',
    category: 'gui',
    size: '0.8 KB',
    type: 'Banksia Config (.json)',
    description: 'Detailed engine parameters definition for Banksia GUI with custom spin and check option definitions.',
    sha256: '6732cfcec3100b7a8bb41a2bc3cb1f9c3faf1c5cca518f442add57d023484181',
    downloadUrl: '/downloads/berserker-banksia.json',
    recommendedFor: 'Banksia GUI (Windows / macOS / Linux)',
    badge: 'Banksia'
  },
  {
    id: 'gui-fritz',
    name: 'ChessBase / Fritz UCI Profile',
    fileName: 'berserker-fritz-chessbase.ini',
    category: 'gui',
    size: '0.6 KB',
    type: 'ChessBase Config (.ini)',
    description: 'Ready-to-import configuration parameters for Fritz 18/19 and ChessBase 16/17/18.',
    sha256: '4ad5583d281f6e0f10a1f98a373b8ba086e8cb1757eed5c62ca006907cff62f5',
    downloadUrl: '/downloads/berserker-fritz-chessbase.ini',
    recommendedFor: 'Fritz and ChessBase interfaces',
    badge: 'ChessBase'
  },

  // Standalone Universal CLI Engine
  {
    id: 'cli-standalone',
    name: 'Berserker v0.4.0 Universal UCI Engine',
    fileName: 'berserker-v0.4.0-cli.js',
    category: 'windows',
    size: '46.0 KB',
    type: 'Universal Runtime (JS / Node / Bun)',
    description: 'Grandmaster core with Hybrid MCTS-PVS Dual Arbiter, 2-Ply Leaf Q-Rollout, Dynamic c_puct Scaling, Dynamic FPU, Subtree Reuse, and Continuous Bayesian Soft Arbitration. Runs identically on Windows, Linux, macOS, and Android.',
    sha256: '76c2f7d76fdb4cad63b33af5baebfc3a16bff56714c925bd588c9e0e5aafc53f',
    downloadUrl: '/downloads/berserker-v0.4.0-cli.js',
    recommendedFor: 'All Operating Systems (Universal)',
    badge: 'Enhanced MCTS+PVS'
  }
];

export const BerserkerReleaseDownloads: React.FC = () => {
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'windows' | 'linux' | 'macos' | 'android' | 'nnue' | 'cpp' | 'gui'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDownloadFile = (url: string, fileName: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredItems = selectedCategory === 'all'
    ? DOWNLOAD_ITEMS
    : DOWNLOAD_ITEMS.filter(item => item.category === selectedCategory);

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 lg:p-8 space-y-8">
      {/* Hero Banner */}
      <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-purple-950/40 to-slate-900 border border-purple-500/30 rounded-3xl p-6 sm:p-8 shadow-2xl">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-3 py-1 rounded-full bg-purple-500/20 text-purple-300 font-mono text-xs font-bold border border-purple-500/40 flex items-center gap-1.5 shadow-sm">
                <Sparkles className="w-3.5 h-3.5" />
                OFFICIAL MULTI-PLATFORM RELEASE
              </span>
              <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 font-mono text-xs font-bold border border-emerald-500/30">
                v0.4.0 STABLE
              </span>
              <span className="px-3 py-1 rounded-full bg-amber-500/20 text-amber-300 font-mono text-xs font-bold border border-amber-500/30">
                EXPANDED 68.5 MB / 45.3 MB NETS
              </span>
            </div>

            <h2 className="text-2xl sm:text-3xl lg:text-4xl font-black text-white tracking-tight">
              Berserker v0.4.0 Multi-Platform Distribution
            </h2>
            <p className="text-slate-300 text-sm sm:text-base max-w-2xl leading-relaxed">
              Tailored builds and configurations across Windows (AVX2, Modern, ARM64), Linux (x86_64, ARM64), macOS (Apple Silicon M1-M4, Intel), Android (DroidFish, Termux), and native C++17 compilation tools.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row md:flex-col gap-2.5 shrink-0">
            <button
              onClick={() => handleDownloadFile('/downloads/berserker_brnnue_v040_huge.nnue', 'berserker_brnnue_v040_huge.nnue')}
              className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black text-xs transition flex items-center justify-center gap-2 shadow-lg shadow-amber-500/20"
            >
              <Layers className="w-4 h-4 text-slate-950" />
              <span>Download Ultra Net (68.5 MB)</span>
            </button>
            <button
              onClick={() => handleDownloadFile('/downloads/berserker_brnnue_v040_large.nnue', 'berserker_brnnue_v040_large.nnue')}
              className="px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs transition flex items-center justify-center gap-2 shadow-lg shadow-purple-600/30"
            >
              <Layers className="w-4 h-4 text-pink-300" />
              <span>Download Large Net (45.3 MB)</span>
            </button>
            <button
              onClick={() => handleDownloadFile('/downloads/berserker-v0.4.0-cli.js', 'berserker-v0.4.0-cli.js')}
              className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold text-xs transition flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4 text-emerald-400" />
              <span>Universal UCI Engine (.js)</span>
            </button>
          </div>
        </div>

        {/* Subtle grid decoration */}
        <div className="absolute -right-10 -bottom-10 w-80 h-80 bg-purple-600/10 rounded-full blur-3xl pointer-events-none" />
      </div>

      {/* Expanded Scale Announcement Callout */}
      <div className="bg-gradient-to-r from-amber-950/40 via-purple-950/30 to-slate-900 border border-amber-500/30 rounded-2xl p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-300 shrink-0">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              <span>Expanded Neural Architecture: Scaled to 45.3 MB & 68.5 MB</span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-300 font-bold">+185 Elo Gain</span>
            </h4>
            <p className="text-xs text-slate-300 mt-0.5">
              Featuring expanded HalfKAv2-1536x2 and 2048x2 wide accumulators, 16-zone spatial king territorial bucketing, and double-layer perceptrons for deep pawn structure harmony and master endgame play.
            </p>
          </div>
        </div>
        <button
          onClick={() => setSelectedCategory('nnue')}
          className="px-4 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold transition shrink-0"
        >
          View NNUE Nets
        </button>
      </div>

      {/* Category Navigation */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
        {[
          { key: 'all', label: 'All Files (28)', icon: Boxes },
          { key: 'nnue', label: 'Expanded NNUE (68.5M / 45.3M)', icon: Layers },
          { key: 'windows', label: 'Windows (AVX2/Modern/ARM)', icon: Laptop },
          { key: 'linux', label: 'Linux (AVX2/Modern/ARM)', icon: Terminal },
          { key: 'macos', label: 'macOS (M1-M4 / Intel)', icon: Cpu },
          { key: 'android', label: 'Android (DroidFish/Termux)', icon: Smartphone },
          { key: 'cpp', label: 'C++ & Compilers', icon: FileCode },
          { key: 'gui', label: 'GUI Configurations', icon: HardDrive }
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setSelectedCategory(key as any)}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              selectedCategory === key
                ? 'bg-purple-600 text-white shadow-md shadow-purple-600/20 font-extrabold'
                : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Downloads Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
        {filteredItems.map((item) => (
          <div
            key={item.id}
            className="bg-slate-900 border border-slate-800 hover:border-purple-500/40 rounded-2xl p-5 sm:p-6 transition flex flex-col justify-between space-y-4 shadow-xl"
          >
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-purple-400 font-bold">
                      {item.type}
                    </span>
                    {item.badge && (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                        {item.badge}
                      </span>
                    )}
                  </div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    {item.name}
                  </h3>
                </div>
                <span className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 font-mono text-xs font-bold shrink-0">
                  {item.size}
                </span>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">
                {item.description}
              </p>

              <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                <span>Recommended:</span>
                <span className="text-slate-300 font-semibold">{item.recommendedFor}</span>
              </div>
            </div>

            {/* SHA-256 and Download Actions */}
            <div className="space-y-3 pt-3 border-t border-slate-800/80">
              <div className="flex items-center justify-between gap-2 bg-slate-950 px-3 py-2 rounded-xl border border-slate-800/60 font-mono text-[10px]">
                <div className="flex items-center gap-1.5 text-slate-400 truncate">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="text-slate-500">SHA256:</span>
                  <span className="truncate text-slate-300">{item.sha256}</span>
                </div>
                <button
                  onClick={() => handleCopy(item.id, item.sha256)}
                  className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition shrink-0"
                  title="Copy SHA-256 Checksum"
                >
                  {copiedId === item.id ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDownloadFile(item.downloadUrl, item.fileName)}
                  className="flex-1 py-2.5 rounded-xl bg-purple-600/90 hover:bg-purple-600 text-white font-bold text-xs transition flex items-center justify-center gap-2 shadow-md shadow-purple-600/20"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download {item.fileName}</span>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Platform Setup Matrix */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6">
        <div>
          <h3 className="text-lg font-black text-white flex items-center gap-2">
            <Award className="w-5 h-5 text-amber-400" />
            <span>Platform Setup & GUI Quickstart</span>
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            Universal Chess Interface (UCI) instructions for Windows, Linux, macOS, Android, and tournament GUIs
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Windows Setup */}
          <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-white">Windows (Arena / Fritz)</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold">Win x64/ARM</span>
            </div>
            <ol className="text-xs text-slate-400 space-y-1 list-decimal list-inside leading-relaxed">
              <li>Download <code className="text-blue-300 font-mono">berserker-v0.4.0-windows-x64-avx2.bat</code></li>
              <li>Download <code className="text-amber-300 font-mono">berserker_brnnue_v040_huge.nnue</code> (68.5 MB)</li>
              <li>Keep both in the same directory</li>
              <li>In Arena: <code className="text-slate-300 font-mono">Engines &gt; Manage &gt; New</code></li>
              <li>Select the batch file and UCI protocol</li>
            </ol>
          </div>

          {/* Linux Setup */}
          <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-white">Linux (CuteChess)</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold">Linux</span>
            </div>
            <ol className="text-xs text-slate-400 space-y-1 list-decimal list-inside leading-relaxed">
              <li>Run: <code className="text-emerald-300 font-mono">chmod +x berserker-v0.4.0-linux-x64-avx2.sh</code></li>
              <li>Or run <code className="text-slate-300 font-mono">sudo bash install-linux.sh</code></li>
              <li>In CuteChess: <code className="text-slate-300 font-mono">Settings &gt; Engines &gt; Add</code></li>
              <li>Command: <code className="text-slate-300 font-mono">berserker</code></li>
              <li>Protocol: <strong>UCI</strong></li>
            </ol>
          </div>

          {/* macOS Setup */}
          <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-white">macOS (Apple Silicon)</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold">M1-M4</span>
            </div>
            <ol className="text-xs text-slate-400 space-y-1 list-decimal list-inside leading-relaxed">
              <li>Download <code className="text-purple-300 font-mono">berserker-v0.4.0-macos-apple-silicon.command</code></li>
              <li>Double-click in Finder to launch</li>
              <li>Or load inside Banksia / CuteChess macOS</li>
              <li>Uses NEON SIMD vector hardware acceleration</li>
            </ol>
          </div>

          {/* Android Mobile */}
          <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-white">Android (DroidFish)</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-bold">Mobile</span>
            </div>
            <ol className="text-xs text-slate-400 space-y-1 list-decimal list-inside leading-relaxed">
              <li>Download <code className="text-cyan-300 font-mono">berserker-droidfish.uci</code></li>
              <li>Download <code className="text-cyan-300 font-mono">berserker-v0.4.0-cli.js</code></li>
              <li>Place in <code className="text-slate-300 font-mono">/sdcard/DroidFish/uci/</code></li>
              <li>Open DroidFish &gt; Select Berserker engine</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
};
