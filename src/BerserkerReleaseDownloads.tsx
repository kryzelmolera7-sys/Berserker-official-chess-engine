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
  ExternalLink,
  ChevronRight,
  HardDrive,
  Boxes,
  Sparkles,
  Award
} from 'lucide-react';

interface DownloadItem {
  id: string;
  name: string;
  fileName: string;
  category: 'executables' | 'nnue' | 'gui' | 'source';
  size: string;
  type: string;
  description: string;
  sha256: string;
  downloadUrl: string;
  recommendedFor: string;
}

const DOWNLOAD_ITEMS: DownloadItem[] = [
  {
    id: 'cli-standalone',
    name: 'Berserker v0.4.0 Standalone UCI Engine',
    fileName: 'berserker-v0.4.0-cli.js',
    category: 'executables',
    size: '30.6 KB',
    type: 'JavaScript / Node / Bun',
    description: 'Complete standalone UCI engine. Zero external dependencies. Runs directly with Node.js or Bun in any terminal or chess GUI.',
    sha256: '56b266d2da15591f881201181d97c302f9ad07363225f5388e490db33513e664',
    downloadUrl: '/downloads/berserker-v0.4.0-cli.js',
    recommendedFor: 'Windows / macOS / Linux (All GUIs)'
  },
  {
    id: 'nnue-weights',
    name: 'BRnnue v0.4.0 Binary Neural Weights',
    fileName: 'berserker_brnnue_v040.nnue',
    category: 'nnue',
    size: '4.0 MB',
    type: 'Binary NNUE Weights (.nnue)',
    description: 'Trained neural network weights file featuring HalfKP dual-accumulator architecture with 16-zone spatial king bucketing.',
    sha256: '3e58b284e453252d0c6b304f2565445ca96e49fc70083883d66fcb2edd580e40',
    downloadUrl: '/downloads/berserker_brnnue_v040.nnue',
    recommendedFor: 'Berserker CLI, C++ Engine & Custom Trainers'
  },
  {
    id: 'cpp-source',
    name: 'Berserker v0.4.0 C++17 Engine Source',
    fileName: 'berserker-v0.4.0.cpp',
    category: 'source',
    size: '5.1 KB',
    type: 'C++17 Standalone Source',
    description: 'Single-file native C++17 UCI Chess Engine. Features bitboards, PVS, Singular Extensions, and AVX2 SCReLU inference.',
    sha256: 'cd6ebc7160d0ebf738a73d7e07d44ca9fd5104fe054d300c4b05bc016af75ded',
    downloadUrl: '/downloads/berserker-v0.4.0.cpp',
    recommendedFor: 'High-Performance Native Compilation'
  },
  {
    id: 'windows-launcher',
    name: 'Windows 1-Click Batch Launcher',
    fileName: 'berserker-v0.4.0-windows.bat',
    category: 'executables',
    size: '0.8 KB',
    type: 'Windows Batch (.bat)',
    description: 'One-click launcher for Windows with high CPU scheduling priority. Automatically locates Bun or Node.js runtime.',
    sha256: 'd8deb4d2f28e4860ea8924fd2f7ff0b0615a776c6dea6f0fdb5522c4c75041db',
    downloadUrl: '/downloads/berserker-v0.4.0-windows.bat',
    recommendedFor: 'Windows Arena / Command Prompt'
  },
  {
    id: 'linux-launcher',
    name: 'Linux / macOS Shell Launcher',
    fileName: 'berserker-v0.4.0-linux.sh',
    category: 'executables',
    size: '0.7 KB',
    type: 'Unix Shell Script (.sh)',
    description: 'Executable shell launcher with automatic path resolution and standard UCI I/O streaming.',
    sha256: 'd0090913844f6c17c2f56703e0c19fb5a05d72e4b45f2172f7d2610ea806d1c7',
    downloadUrl: '/downloads/berserker-v0.4.0-linux.sh',
    recommendedFor: 'Linux & macOS CuteChess / Banksia'
  },
  {
    id: 'cutechess-config',
    name: 'CuteChess Pre-Configured Engine JSON',
    fileName: 'berserker-cutechess.json',
    category: 'gui',
    size: '0.5 KB',
    type: 'CuteChess Config (.json)',
    description: 'Pre-configured JSON engine definition. Drop directly into CuteChess configuration to start matches instantly.',
    sha256: '4aafb7e708d6f570395fbc316edcceb2491bed45e25e2313882a1ec6dfbdb9b6',
    downloadUrl: '/downloads/berserker-cutechess.json',
    recommendedFor: 'CuteChess Tournaments'
  },
  {
    id: 'arena-config',
    name: 'Arena Chess GUI Configuration',
    fileName: 'berserker-arena.eng',
    category: 'gui',
    size: '0.3 KB',
    type: 'Arena Config (.eng)',
    description: 'Ready-to-use engine configuration file for the popular Arena Chess GUI on Windows.',
    sha256: '318772b90d3462fbf1b5b9c0adbc08b1204d70737f2f68835bee79eb0906c9e7',
    downloadUrl: '/downloads/berserker-arena.eng',
    recommendedFor: 'Arena Chess GUI'
  }
];

export const BerserkerReleaseDownloads: React.FC = () => {
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'executables' | 'nnue' | 'gui' | 'source'>('all');
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
                OFFICIAL RELEASE
              </span>
              <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 font-mono text-xs font-bold border border-emerald-500/30">
                STABLE v0.4.0
              </span>
              <span className="px-3 py-1 rounded-full bg-cyan-500/20 text-cyan-300 font-mono text-xs font-bold border border-cyan-500/30">
                ALL PLATFORMS
              </span>
            </div>

            <h2 className="text-2xl sm:text-3xl lg:text-4xl font-black text-white tracking-tight">
              Berserker v0.4.0 Download Hub
            </h2>
            <p className="text-slate-300 text-sm sm:text-base max-w-2xl leading-relaxed">
              Official release assets for Berserker v0.4.0. Download standalone CLI runtimes, native C++ engine sources, binary neural weights, and ready-to-run configurations for Windows, macOS, Linux, and tournament GUIs.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row md:flex-col gap-3 shrink-0">
            <button
              onClick={() => handleDownloadFile('/downloads/berserker-v0.4.0-cli.js', 'berserker-v0.4.0-cli.js')}
              className="px-5 py-3 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-sm transition flex items-center justify-center gap-2 shadow-lg shadow-purple-600/30"
            >
              <Download className="w-4 h-4" />
              <span>Download CLI Engine (.js)</span>
            </button>
            <button
              onClick={() => handleDownloadFile('/downloads/berserker_brnnue_v040.nnue', 'berserker_brnnue_v040.nnue')}
              className="px-5 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold text-sm transition flex items-center justify-center gap-2"
            >
              <Layers className="w-4 h-4 text-pink-400" />
              <span>Download NNUE Net (4 MB)</span>
            </button>
          </div>
        </div>

        {/* Subtle grid decoration */}
        <div className="absolute -right-10 -bottom-10 w-80 h-80 bg-purple-600/10 rounded-full blur-3xl pointer-events-none" />
      </div>

      {/* Category Navigation */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
        {[
          { key: 'all', label: 'All Assets', icon: Boxes },
          { key: 'executables', label: 'Standalone Executables', icon: Terminal },
          { key: 'nnue', label: 'Neural Weights (.nnue)', icon: Layers },
          { key: 'gui', label: 'GUI Configs (CuteChess & Arena)', icon: HardDrive },
          { key: 'source', label: 'C++17 Source', icon: FileCode }
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setSelectedCategory(key as any)}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 ${
              selectedCategory === key
                ? 'bg-purple-600 text-white shadow-md shadow-purple-600/20'
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
                  <span className="text-[10px] font-mono uppercase tracking-wider text-purple-400 font-bold block mb-1">
                    {item.type}
                  </span>
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
                  <span className="truncate">SHA256: {item.sha256}</span>
                </div>
                <button
                  onClick={() => handleCopy(`hash-${item.id}`, item.sha256)}
                  className="text-slate-400 hover:text-white transition shrink-0 ml-1 p-1"
                  title="Copy SHA-256 Hash"
                >
                  {copiedId === `hash-${item.id}` ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDownloadFile(item.downloadUrl, item.fileName)}
                  className="flex-1 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-mono text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-md shadow-purple-600/20"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download {item.fileName}</span>
                </button>
                <button
                  onClick={() => handleCopy(`curl-${item.id}`, `curl -O https://your-server.com${item.downloadUrl}`)}
                  className="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-xs border border-slate-700 transition flex items-center gap-1"
                  title="Copy curl command"
                >
                  {copiedId === `curl-${item.id}` ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Terminal className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* GUI & Quick Start Guide */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6">
        <div>
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <Award className="w-5 h-5 text-amber-400" />
            How to Load Berserker v0.4.0 into Chess GUIs
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            Standard Universal Chess Interface (UCI) protocol instructions for tournament organizers and players
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-white">CuteChess GUI</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold">Recommended</span>
            </div>
            <ol className="text-xs text-slate-400 space-y-1 list-decimal list-inside leading-relaxed">
              <li>Open CuteChess: <code className="text-purple-300">Tools &gt; Settings &gt; Engines</code></li>
              <li>Click <strong>Add...</strong></li>
              <li>Command: <code className="text-slate-300 font-mono">node</code></li>
              <li>Arguments: <code className="text-slate-300 font-mono">berserker-v0.4.0-cli.js</code></li>
              <li>Protocol: Select <strong>UCI</strong></li>
            </ol>
          </div>

          <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-white">Arena Chess GUI</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-bold">Windows</span>
            </div>
            <ol className="text-xs text-slate-400 space-y-1 list-decimal list-inside leading-relaxed">
              <li>Open Arena: <code className="text-purple-300">Engines &gt; Manage</code></li>
              <li>Click <strong>New</strong> and select <code className="text-slate-300 font-mono">berserker-v0.4.0-windows.bat</code></li>
              <li>Set Protocol to <strong>UCI</strong></li>
              <li>Click <strong>Apply</strong> and start playing</li>
            </ol>
          </div>

          <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-white">Native C++ Binary</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-bold">AVX2</span>
            </div>
            <ol className="text-xs text-slate-400 space-y-1 list-decimal list-inside leading-relaxed">
              <li>Download <code className="text-cyan-300">berserker-v0.4.0.cpp</code></li>
              <li>Compile with modern GCC/Clang:</li>
              <li className="font-mono text-[11px] text-slate-300 bg-slate-900 p-1.5 rounded mt-1">g++ -O3 -mavx2 berserker-v0.4.0.cpp -o berserker</li>
              <li>Load <code className="text-slate-300 font-mono">./berserker</code> directly in any GUI</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
};
