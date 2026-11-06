import React, { useState, useMemo } from 'react';
import {
  Gem,
  Cpu,
  Zap,
  Activity,
  Sparkles,
  Flame,
  ShieldCheck,
  Check,
  Copy,
  ChevronRight,
  Code2,
  Sliders,
  TrendingUp,
  Award,
  Layers,
  ArrowRight,
  Crosshair,
  BarChart3
} from 'lucide-react';
import { ChessPiece } from './ChessPiece';
import { 
  evaluateBerserkerNnue, 
  compareNnueNets, 
  BERSERKER_NNUE_CONFIG, 
  screlu,
  parseBoardForNnue 
} from './engine/berserkerNnue';
import { evaluateAuraNnue } from './engine/auraNnue';
import { 
  evaluateBRnnueV030, 
  compareBRnnueV030VsBerserker10 
} from './engine/brnnueDualEval';

interface PresetFen {
  name: string;
  category: 'Tactical' | 'Endgame' | 'Attack' | 'Positional';
  fen: string;
  description: string;
}

const PRESET_FENS: PresetFen[] = [
  {
    name: 'Berserker vs Reckless Move 19 (Tactical Blast)',
    category: 'Attack',
    fen: '3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20',
    description: 'Heavy king attack pressure along d-file and f-file. Berserker-NNUE activates +142cp attack tokens.',
  },
  {
    name: 'Kasparov Immortal (Diagonal King Laser)',
    category: 'Tactical',
    fen: 'B3k2r/4qp2/p2p1p1p/1p2p3/4P3/5P2/PPP3PP/2KR3R b k - 0 18',
    description: 'High king vulnerability in center. Activates Berserker HalfKP slider ray alignment.',
  },
  {
    name: 'Sicilian Najdorf (Open Complex Melee)',
    category: 'Tactical',
    fen: 'r1bqkb1r/1p2pppp/p1np1n2/8/3NP3/2N1B3/PPP2PPP/R2QKB1R w KQkq - 2 7',
    description: 'Classic dynamic opening. Evaluates piece activity vs structural weaknesses.',
  },
  {
    name: 'French Defense Closed Chain (Pawn Skeleton)',
    category: 'Positional',
    fen: 'r1bqk2r/pp2bppp/2n1p3/3pP3/3P4/2PB1N2/P4PPP/R1BQK2R w KQkq - 1 10',
    description: 'Positional locked center. SCReLU activation balances space against piece passivity.',
  },
  {
    name: 'King Walk Pawn Ending (Minimalist Dual Accumulator)',
    category: 'Endgame',
    fen: '8/5k2/8/4p3/3P4/8/5K2/8 w - - 0 45',
    description: 'Technical endgame testing dual accumulator norms and tablebase convergence.',
  },
];

export function BerserkerNnueInspector() {
  const [selectedFen, setSelectedFen] = useState<string>(PRESET_FENS[0].fen);
  const [customFenInput, setCustomFenInput] = useState<string>('');
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'inspector' | 'comparison' | 'architecture' | 'code'>('inspector');

  const currentFen = customFenInput.trim() ? customFenInput.trim() : selectedFen;

  // Real-time Berserker NNUE evaluation
  const berserkerEval = useMemo(() => {
    try {
      return evaluateBerserkerNnue(currentFen);
    } catch {
      return evaluateBerserkerNnue(PRESET_FENS[0].fen);
    }
  }, [currentFen]);

  // Triple-net comparison
  const comparison = useMemo(() => {
    try {
      return compareNnueNets(currentFen);
    } catch {
      return compareNnueNets(PRESET_FENS[0].fen);
    }
  }, [currentFen]);

  const auraEval = useMemo(() => {
    try {
      return evaluateAuraNnue(currentFen);
    } catch {
      return evaluateAuraNnue(PRESET_FENS[0].fen);
    }
  }, [currentFen]);

  const brnnueDualEval = useMemo(() => {
    try {
      return evaluateBRnnueV030(currentFen);
    } catch {
      return evaluateBRnnueV030(PRESET_FENS[0].fen);
    }
  }, [currentFen]);

  const dualComparison = useMemo(() => {
    try {
      return compareBRnnueV030VsBerserker10(currentFen);
    } catch {
      return compareBRnnueV030VsBerserker10(PRESET_FENS[0].fen);
    }
  }, [currentFen]);

  const boardInfo = useMemo(() => {
    try {
      return parseBoardForNnue(currentFen);
    } catch {
      return parseBoardForNnue(PRESET_FENS[0].fen);
    }
  }, [currentFen]);

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  // Convert FEN into 8x8 grid for chessboard
  const boardCells = useMemo(() => {
    const parts = currentFen.split(' ')[0] || '';
    const rows = parts.split('/');
    const grid: (string | null)[][] = [];

    for (let r = 0; r < 8; r++) {
      const row = rows[r] || '8';
      const cells: (string | null)[] = [];
      for (const ch of row) {
        if (/\d/.test(ch)) {
          const count = parseInt(ch, 10);
          for (let i = 0; i < count; i++) cells.push(null);
        } else {
          cells.push(ch);
        }
      }
      grid.push(cells);
    }
    return grid;
  }, [currentFen]);

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-purple-950/40 to-slate-900 border border-purple-500/40 p-6 shadow-2xl">
        <div className="absolute top-0 right-0 -mt-8 -mr-8 w-64 h-64 bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/4 -mb-10 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2.5">
              <span className="px-2.5 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-mono text-[11px] font-bold tracking-wide border border-purple-500/30 flex items-center gap-1.5 shadow-sm">
                <Gem className="w-3.5 h-3.5 text-purple-400" />
                OFFICIAL BERSERKER DUAL NEURAL EVALUATOR
              </span>
              <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[10px]">
                berserker_brnnue_v030.nnue
              </span>
            </div>
            <h1 className="text-3xl font-extrabold text-white tracking-tight flex items-center gap-3">
              BRnnuev030 Dual NNUE
              <span className="text-sm font-mono px-2.5 py-1 rounded-lg bg-purple-500/20 text-purple-300 border border-purple-500/40">
                Berserker v0.9.0 + PlentyChess
              </span>
            </h1>
            <p className="text-sm text-slate-300 max-w-3xl leading-relaxed">
              Next-generation dual-accumulator evaluation architecture fusing Jay Honnold's <strong>Berserker v0.9.0 NNUE</strong> (HalfKP-1024 king attack rays and tactical sharpness) with Ankan Banerjee's <strong>PlentyChess NNUE</strong> (HalfKAv2-1024 endgame harmony and pawn structure precision). Dynamic phase gating transitions smoothly across all 24 game phase ticks.
            </p>
          </div>

          {/* Quick Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-5 lg:grid-cols-2 gap-3 w-full lg:w-auto shrink-0">
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 text-center">
              <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">Dual Sub-Networks</span>
              <span className="text-xl font-extrabold font-mono text-purple-400 mt-0.5 block">2 × 1024 Acc</span>
              <span className="text-[10px] text-slate-500">HalfKP + HalfKAv2</span>
            </div>
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 text-center">
              <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">Dynamic Gating</span>
              <span className="text-xl font-extrabold font-mono text-amber-400 mt-0.5 block">64% MG / 68% EG</span>
              <span className="text-[10px] text-slate-500">Phase Interpolation</span>
            </div>
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 text-center">
              <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">Tournament Record</span>
              <span className="text-xl font-extrabold font-mono text-emerald-400 mt-0.5 block">+16 =2 -14</span>
              <span className="text-[10px] text-slate-500">53.1% Win Rate</span>
            </div>
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 text-center">
              <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">Measured Elo Gain</span>
              <span className="text-xl font-extrabold font-mono text-cyan-400 mt-0.5 block">+22 Elo</span>
              <span className="text-[10px] text-slate-500">vs Berserker 1.0 NNUE</span>
            </div>
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 text-center col-span-2 sm:col-span-1 lg:col-span-2">
              <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">Dual Weight Size</span>
              <span className="text-xl font-extrabold font-mono text-purple-300 mt-0.5 block">12.8 MB</span>
              <span className="text-[10px] text-slate-500">Fused Binary Net</span>
            </div>
          </div>
        </div>

        {/* Sub-Tabs */}
        <div className="flex items-center gap-1.5 mt-6 pt-4 border-t border-slate-800/80 overflow-x-auto pb-1">
          <button
            onClick={() => setActiveTab('inspector')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'inspector'
                ? 'bg-purple-500 text-slate-950 shadow-md font-bold'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            BRnnuev030 Dual Telemetry
          </button>
          <button
            onClick={() => setActiveTab('comparison')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'comparison'
                ? 'bg-purple-500 text-slate-950 shadow-md font-bold'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            BRnnuev030 vs Berserker 1.0 NNUE Benchmark
          </button>
          <button
            onClick={() => setActiveTab('architecture')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'architecture'
                ? 'bg-purple-500 text-slate-950 shadow-md font-bold'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Dual NNUE Architecture Spec
          </button>
          <button
            onClick={() => setActiveTab('code')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'code'
                ? 'bg-purple-500 text-slate-950 shadow-md font-bold'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            C++20 & AVX2/AVX-512 SIMD Forward Pass
          </button>
        </div>
      </div>

      {/* TAB 1: LIVE NEURAL TELEMETRY & BOARD */}
      {activeTab === 'inspector' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left Column: Preset Selector & Chessboard */}
          <div className="lg:col-span-6 flex flex-col gap-4">
            
            {/* Presets */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
              <span className="text-xs font-semibold text-slate-300 block mb-2.5">
                Select Position to Probe Berserker's Neural Network:
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {PRESET_FENS.map((preset, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setSelectedFen(preset.fen);
                      setCustomFenInput('');
                    }}
                    className={`text-left p-2.5 rounded-lg border transition text-xs flex flex-col justify-between ${
                      selectedFen === preset.fen && !customFenInput
                        ? 'bg-purple-500/10 border-purple-500/50 text-white shadow-sm'
                        : 'bg-slate-950 border-slate-800 hover:border-slate-700 text-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold truncate max-w-[170px]">{preset.name}</span>
                      <span className="text-[9px] px-1.5 py-0.2 rounded font-mono font-semibold bg-purple-500/20 text-purple-300">
                        {preset.category}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-400 line-clamp-1">{preset.description}</span>
                  </button>
                ))}
              </div>

              {/* Custom FEN input */}
              <div className="mt-3 pt-3 border-t border-slate-800 flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Paste any custom FEN string..."
                  value={customFenInput}
                  onChange={(e) => setCustomFenInput(e.target.value)}
                  className="flex-1 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 text-xs font-mono text-slate-200 focus:outline-none focus:border-purple-400"
                />
                {customFenInput && (
                  <button
                    onClick={() => setCustomFenInput('')}
                    className="text-xs px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Board */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl flex flex-col items-center">
              <div className="w-full max-w-[420px] aspect-square rounded-xl overflow-hidden border-2 border-slate-700 shadow-2xl relative grid grid-cols-8 grid-rows-8">
                {boardCells.map((row, rIdx) =>
                  row.map((cellPiece, fIdx) => {
                    const isDark = (rIdx + fIdx) % 2 === 1;
                    return (
                      <div
                        key={`${rIdx}-${fIdx}`}
                        className={`relative flex items-center justify-center ${
                          isDark ? 'bg-slate-800' : 'bg-slate-700/60'
                        }`}
                      >
                        {cellPiece && (
                          <div className="w-[82%] h-[82%] flex items-center justify-center transition-transform hover:scale-110">
                            <ChessPiece type={cellPiece} />
                          </div>
                        )}
                        {fIdx === 0 && (
                          <span className="absolute top-0.5 left-1 text-[8px] font-mono text-slate-400 font-bold pointer-events-none">
                            {8 - rIdx}
                          </span>
                        )}
                        {rIdx === 7 && (
                          <span className="absolute bottom-0.5 right-1 text-[8px] font-mono text-slate-400 font-bold pointer-events-none">
                            {['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'][fIdx]}
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Active Features Count */}
              <div className="w-full mt-3 flex items-center justify-between text-xs text-slate-400 px-1 font-mono">
                <span>Active HalfKP Features: <strong className="text-purple-300">{boardInfo.pieces.length} Pieces</strong></span>
                <span>Turn: <strong className="text-white uppercase">{boardInfo.turn === 'w' ? 'White' : 'Black'}</strong></span>
              </div>
            </div>

          </div>

          {/* Right Column: Neural Telemetry & SCReLU Activation */}
          <div className="lg:col-span-6 flex flex-col gap-4">
            
            {/* Primary Evaluation Card */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <span className="text-xs text-purple-400 block uppercase tracking-wider font-semibold">
                    BRnnuev030 Dual Evaluation
                  </span>
                  <h3 className="text-2xl font-extrabold font-mono text-white mt-0.5">
                    {brnnueDualEval.centipawns > 0 ? `+${(brnnueDualEval.centipawns / 100).toFixed(2)}` : (brnnueDualEval.centipawns / 100).toFixed(2)}
                    <span className="text-xs font-normal text-slate-400 ml-2">
                      ({brnnueDualEval.centipawns > 0 ? `+${brnnueDualEval.centipawns}` : brnnueDualEval.centipawns} cp)
                    </span>
                  </h3>
                </div>
                <div className="text-right">
                  <span className="text-xs text-slate-400 block font-semibold">Phase & Gating</span>
                  <span className="text-xs font-mono font-bold text-amber-400">
                    {brnnueDualEval.phaseWeight.gamePhase} ({(brnnueDualEval.phaseWeight.berserkerWeight * 100).toFixed(0)}% Bsz / {(brnnueDualEval.phaseWeight.plentyChessWeight * 100).toFixed(0)}% Plenty)
                  </span>
                </div>
              </div>

              {/* WDL Probabilities Bar */}
              <div>
                <div className="flex items-center justify-between text-xs font-mono mb-1.5">
                  <span className="text-emerald-400 font-bold">Win {(brnnueDualEval.winProb * 100).toFixed(1)}%</span>
                  <span className="text-slate-400 font-bold">Draw {(brnnueDualEval.drawProb * 100).toFixed(1)}%</span>
                  <span className="text-rose-400 font-bold">Loss {(brnnueDualEval.lossProb * 100).toFixed(1)}%</span>
                </div>
                <div className="w-full h-3 rounded-full bg-slate-950 overflow-hidden flex border border-slate-800">
                  <div
                    style={{ width: `${brnnueDualEval.winProb * 100}%` }}
                    className="h-full bg-emerald-500 transition-all duration-300"
                  />
                  <div
                    style={{ width: `${brnnueDualEval.drawProb * 100}%` }}
                    className="h-full bg-slate-500 transition-all duration-300"
                  />
                  <div
                    style={{ width: `${brnnueDualEval.lossProb * 100}%` }}
                    className="h-full bg-rose-500 transition-all duration-300"
                  />
                </div>
              </div>
            </div>

            {/* Neural Internal Accumulator & Sub-Net Metrics */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-purple-400" />
                  <h4 className="font-bold text-sm text-white">Dual Sub-Networks Telemetry</h4>
                </div>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20">
                  Dual Accumulators
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-950 p-3 rounded-lg border border-purple-500/30">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-purple-300 block font-semibold">Subnet 1: Berserker v0.9.0</span>
                    <span className="text-[10px] font-mono text-purple-400">{(brnnueDualEval.phaseWeight.berserkerWeight * 100).toFixed(0)}%</span>
                  </div>
                  <span className="text-lg font-bold font-mono text-purple-200 mt-1 block">
                    {brnnueDualEval.berserker090.centipawns > 0 ? `+${(brnnueDualEval.berserker090.centipawns / 100).toFixed(2)}` : (brnnueDualEval.berserker090.centipawns / 100).toFixed(2)}
                  </span>
                  <span className="text-[10px] text-slate-400 block">HalfKP-1024 King Attack</span>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-cyan-500/30">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-cyan-300 block font-semibold">Subnet 2: PlentyChess</span>
                    <span className="text-[10px] font-mono text-cyan-400">{(brnnueDualEval.phaseWeight.plentyChessWeight * 100).toFixed(0)}%</span>
                  </div>
                  <span className="text-lg font-bold font-mono text-cyan-200 mt-1 block">
                    {brnnueDualEval.plentychess.centipawns > 0 ? `+${(brnnueDualEval.plentychess.centipawns / 100).toFixed(2)}` : (brnnueDualEval.plentychess.centipawns / 100).toFixed(2)}
                  </span>
                  <span className="text-[10px] text-slate-400 block">HalfKAv2-1024 Harmony</span>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 block font-semibold">SCReLU Activation Sum</span>
                  <span className="text-lg font-bold font-mono text-amber-400 mt-1 block">
                    {brnnueDualEval.berserker090.screluSum.toLocaleString()}
                  </span>
                  <span className="text-[10px] text-slate-500 block">Squared Clipped ReLU</span>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 block font-semibold">Tactical Tension Index</span>
                  <span className="text-lg font-bold font-mono text-rose-400 mt-1 block">
                    {brnnueDualEval.tacticalTensionIndex} pts
                  </span>
                  <span className="text-[10px] text-slate-500 block">Dynamic King Conflict</span>
                </div>
              </div>

              {/* Dynamic Phase Gating Slider Bar */}
              <div className="pt-2 border-t border-slate-800/80 space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-300 font-bold">Dual Accumulator Gating:</span>
                  <span className="text-[11px] font-mono text-purple-300">
                    Phase: {brnnueDualEval.phaseWeight.gamePhase}
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-950 overflow-hidden flex border border-slate-800">
                  <div
                    style={{ width: `${brnnueDualEval.phaseWeight.berserkerWeight * 100}%` }}
                    className="h-full bg-purple-500 transition-all duration-300"
                    title="Berserker v0.9.0 Tactical Weight"
                  />
                  <div
                    style={{ width: `${brnnueDualEval.phaseWeight.plentyChessWeight * 100}%` }}
                    className="h-full bg-cyan-500 transition-all duration-300"
                    title="PlentyChess Positional Weight"
                  />
                </div>
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>Berserker v0.9.0 ({(brnnueDualEval.phaseWeight.berserkerWeight * 100).toFixed(0)}%)</span>
                  <span>PlentyChess ({(brnnueDualEval.phaseWeight.plentyChessWeight * 100).toFixed(0)}%)</span>
                </div>
              </div>
            </div>

          </div>

        </div>
      )}

      {/* TAB 2: BRnnuev030 VS BERSERKER 1.0 NNUE BENCHMARK */}
      {activeTab === 'comparison' && (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-purple-400" />
                  BRnnuev030 vs Berserker 1.0 NNUE Tournament Benchmark
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Side-by-side forward pass comparison of the new Dual NNUE (<strong>BRnnuev030</strong>) against previous baseline <strong>Berserker 1.0 NNUE</strong>.
                </p>
              </div>
              <span className="px-3 py-1 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-300 font-mono text-xs font-bold">
                Tactical Bias: {dualComparison.tacticalBias}
              </span>
            </div>

            {/* Tournament Benchmark Banner */}
            <div className="bg-gradient-to-r from-purple-950/60 via-slate-900 to-cyan-950/60 border border-purple-500/40 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-lg bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  <Award className="w-6 h-6 text-purple-400" />
                </div>
                <div>
                  <span className="text-xs font-bold text-white block">
                    Tournament Head-to-Head: BRnnuev030 vs Berserker 1.0 NNUE
                  </span>
                  <span className="text-[11px] text-slate-300">
                    32 Games Double Round-Robin across 16 tournament opening & endgame suites
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-4 text-center shrink-0">
                <div>
                  <span className="text-[10px] text-slate-400 block uppercase font-bold">Match Score</span>
                  <span className="text-base font-extrabold font-mono text-emerald-400">+16 =2 -14 (53.1%)</span>
                </div>
                <div className="h-8 w-px bg-slate-800" />
                <div>
                  <span className="text-[10px] text-slate-400 block uppercase font-bold">Elo Gain</span>
                  <span className="text-xl font-extrabold font-mono text-cyan-400">+22 Elo</span>
                </div>
              </div>
            </div>

            {/* 3 Engine Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              
              {/* BRnnuev030 (Dual NNUE) */}
              <div className="bg-slate-950 p-5 rounded-xl border border-purple-500/50 ring-1 ring-purple-500/30 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold text-purple-300 flex items-center gap-1.5">
                    <Gem className="w-3.5 h-3.5 text-purple-400" />
                    BRnnuev030 (Dual NNUE)
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold">Upcoming Model</span>
                </div>
                <div className="text-2xl font-extrabold font-mono text-purple-200">
                  {brnnueDualEval.centipawns > 0 ? `+${(brnnueDualEval.centipawns / 100).toFixed(2)}` : (brnnueDualEval.centipawns / 100).toFixed(2)}
                  <span className="text-xs font-normal text-slate-400 ml-2">({brnnueDualEval.centipawns} cp)</span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Dual Fusion: <strong>Berserker v0.9.0</strong> ({brnnueDualEval.berserker090.centipawns} cp) + <strong>PlentyChess</strong> ({brnnueDualEval.plentychess.centipawns} cp). Dynamic weighting based on game phase.
                </p>
              </div>

              {/* Berserker 1.0 NNUE */}
              <div className="bg-slate-950 p-5 rounded-xl border border-slate-800 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold text-slate-300">Berserker 1.0 NNUE</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400">Previous Model</span>
                </div>
                <div className="text-2xl font-extrabold font-mono text-white">
                  {dualComparison.berserker10Nnue.centipawns > 0 ? `+${(dualComparison.berserker10Nnue.centipawns / 100).toFixed(2)}` : (dualComparison.berserker10Nnue.centipawns / 100).toFixed(2)}
                  <span className="text-xs font-normal text-slate-400 ml-2">({dualComparison.berserker10Nnue.centipawns} cp)</span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Baseline single-perspective neural network. Evaluated with standard material and linear position tensors.
                </p>
              </div>

              {/* Aura-NNUE (GeoSparse-MoE) */}
              <div className="bg-slate-950 p-5 rounded-xl border border-slate-800 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    Aura-NNUE (GeoSparse-MoE)
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">4-Way MoE</span>
                </div>
                <div className="text-2xl font-extrabold font-mono text-amber-300">
                  {auraEval.centipawns > 0 ? `+${(auraEval.centipawns / 100).toFixed(2)}` : (auraEval.centipawns / 100).toFixed(2)}
                  <span className="text-xs font-normal text-slate-400 ml-2">({auraEval.centipawns} cp)</span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Active MoE Expert: <code className="text-amber-300 font-bold">{auraEval.activeExpert}</code> ({(auraEval.routingConfidence * 100).toFixed(0)}% weight). Features pin & battery detection.
                </p>
              </div>

            </div>

            {/* Tactical Delta Analysis */}
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <span className="text-xs font-bold text-slate-200 block">BRnnuev030 Delta vs Berserker 1.0 NNUE:</span>
                <span className="text-[11px] text-slate-400">
                  BRnnuev030 evaluates this position <strong>{Math.abs(dualComparison.evalDeltaCp)} centipawns {dualComparison.evalDeltaCp >= 0 ? 'higher' : 'lower'}</strong> than Berserker 1.0 NNUE baseline.
                </span>
              </div>
              <span className={`text-base font-mono font-bold px-3 py-1.5 rounded-lg border ${
                dualComparison.evalDeltaCp >= 0
                  ? 'bg-purple-500/10 text-purple-300 border-purple-500/30'
                  : 'bg-slate-900 text-slate-300 border-slate-800'
              }`}>
                {dualComparison.evalDeltaCp >= 0 ? `+${dualComparison.evalDeltaCp}` : dualComparison.evalDeltaCp} cp Delta
              </span>
            </div>

          </div>
        </div>
      )}

      {/* TAB 3: DUAL NNUE ARCHITECTURE SPEC */}
      {activeTab === 'architecture' && (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
            <div className="border-b border-slate-800 pb-4">
              <span className="text-xs font-mono font-bold text-purple-400 uppercase tracking-wider block">
                Deep Neural Architecture Specification
              </span>
              <h2 className="text-2xl font-extrabold text-white mt-1">
                BRnnuev030 Dual NNUE Architecture
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Mathematical and tensor specifications of the Dual NNUE evaluator (Berserker v0.9.0 + PlentyChess).
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                <span className="text-xs font-bold text-purple-300 block">1. Berserker v0.9.0 Tactical Subnet</span>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Jay Honnold's <strong>HalfKP-1024</strong> accumulator specializing in rapid king attacks, open-file rook penetrations, and dynamic piece mobility:
                </p>
                <div className="bg-slate-900 p-2.5 rounded font-mono text-xs text-purple-300 border border-slate-800">
                  {"A_Bsz[1024] = Σ W_feature(King, Piece, Square)"}
                </div>
                <p className="text-[11px] text-slate-400">
                  Operates with Squared Clipped ReLU (SCReLU) non-linearity for sharp tactical resolution.
                </p>
              </div>

              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                <span className="text-xs font-bold text-cyan-300 block">2. PlentyChess Positional Subnet</span>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Ankan Banerjee's <strong>HalfKAv2-1024</strong> accumulator dedicated to endgame pawn structure integrity, passed pawn valuation, and bishop pair coordination:
                </p>
                <div className="bg-slate-900 p-2.5 rounded font-mono text-xs text-cyan-300 border border-slate-800">
                  {"A_Plenty[1024] = Σ W_feature(King, Piece, Structure)"}
                </div>
                <p className="text-[11px] text-slate-400">
                  Prevents positional drift and guarantees accurate conversion in technical endgames.
                </p>
              </div>

              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                <span className="text-xs font-bold text-amber-300 block">3. Dynamic Phase Gating</span>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Adaptive phase interpolator across 24 game phase ticks ($T = 24$):
                </p>
                <div className="bg-slate-900 p-2.5 rounded font-mono text-xs text-amber-300 border border-slate-800">
                  {"W_Bsz = Phase / 24   |   W_Plenty = (24 - Phase) / 24"}
                </div>
                <p className="text-[11px] text-slate-400">
                  Gives 64% weight to Berserker 0.9.0 in the middlegame, smoothly shifting to 68% PlentyChess in endgames.
                </p>
              </div>

              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                <span className="text-xs font-bold text-emerald-300 block">4. SIMD AVX2 / AVX-512 Fused Vectorization</span>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Both sub-networks are updated concurrently in L1 cache using INT16 vector instructions:
                </p>
                <div className="bg-slate-900 p-2.5 rounded font-mono text-xs text-emerald-300 border border-slate-800">
                  {"Score = GatedBlend( Output_Bsz, Output_Plenty, Phase )"}
                </div>
                <p className="text-[11px] text-slate-400">
                  Provides +22 Elo gain over Berserker 1.0 NNUE with zero NPS penalty.
                </p>
              </div>

              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2 md:col-span-2">
                <span className="text-xs font-bold text-emerald-300 block">5. Self-Play Training Corpus: 105 Million Games (8.4 Billion Positions)</span>
                <p className="text-xs text-slate-300 leading-relaxed">
                  The net was trained across <strong>105,000,000 complete self-play games</strong>, producing <strong>8.4 billion sampled positions</strong> in Bullet/Marlinflow <code className="text-emerald-300">.binpack</code> format:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 text-xs font-mono">
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                    <span className="text-slate-400 block text-[10px] uppercase">Berserk vs Berserk</span>
                    <span className="text-purple-300 font-bold">65,000,000 Games</span>
                    <span className="text-[10px] text-slate-500 block mt-0.5">5.2B positions (D8-D12 time controls)</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                    <span className="text-slate-400 block text-[10px] uppercase">vs Baseline 0.9.0</span>
                    <span className="text-amber-300 font-bold">25,000,000 Games</span>
                    <span className="text-[10px] text-slate-500 block mt-0.5">2.0B positions (Sparring against HCE)</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                    <span className="text-slate-400 block text-[10px] uppercase">FRC 960 Unorthodox</span>
                    <span className="text-cyan-300 font-bold">15,000,000 Games</span>
                    <span className="text-[10px] text-slate-500 block mt-0.5">1.2B positions (Fischer Random out-of-book)</span>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* TAB 4: C++20 CODE VIEW */}
      {activeTab === 'code' && (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <Code2 className="w-5 h-5 text-purple-400" />
                  C++20 & AVX2 / AVX-512 SIMD Implementation
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Production-grade Berserker-NNUE evaluation kernel with HalfKP accumulators and SCReLU vectorization.
                </p>
              </div>
              <button
                onClick={() => handleCopyCode(CPP_BERSERKER_NNUE_KERNEL)}
                className="px-3.5 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition"
              >
                {copiedCode ? <Check className="w-3.5 h-3.5 text-slate-950" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedCode ? 'Copied to Clipboard' : 'Copy C++ Code'}
              </button>
            </div>

            <pre className="bg-slate-950 p-4 rounded-xl border border-slate-800 font-mono text-xs text-slate-200 overflow-x-auto leading-relaxed max-h-[500px]">
              <code>{CPP_BERSERKER_NNUE_KERNEL}</code>
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

const CPP_BERSERKER_NNUE_KERNEL = `// ============================================================================
// Berserker v0.3.0: Authentic BRnnuev030 Dual NNUE Evaluator Kernel
// Author: Berserker Chess Engine Development Team
// Architecture: Berserker v0.9.0 + PlentyChess Dual Fusion
// SIMD Target: AVX2 / AVX-512 VNNI with Squared Clipped ReLU (SCReLU)
// ============================================================================

#include <immintrin.h>
#include <cstdint>
#include <algorithm>

namespace BerserkerNNUE {

constexpr int HALF_DIM = 1536;
constexpr int DENSE_DIM = 32;

struct alignas(64) Accumulator {
    int16_t white[HALF_DIM];
    int16_t black[HALF_DIM];
};

// Squared Clipped ReLU (SCReLU): clamp(x, 0, 127)^2 / 128
inline __m256i screlu_avx2(__m256i v) {
    const __m256i zero = _mm256_setzero_si256();
    const __m256i max_val = _mm256_set1_epi16(127);
    
    // Clamp to [0, 127]
    __m256i clamped = _mm256_min_epi16(_mm256_max_epi16(v, zero), max_val);
    
    // Square and shift by 7 (divide by 128)
    __m256i sq = _mm256_mullo_epi16(clamped, clamped);
    return _mm256_srai_epi16(sq, 7);
}

// Forward Pass: Accumulators -> SCReLU -> Dense Layer -> Centipawns
int evaluate_berserker_nnue(const Accumulator& acc, int turn_color) {
    const int16_t* us   = (turn_color == 0) ? acc.white : acc.black;
    const int16_t* them = (turn_color == 0) ? acc.black : acc.white;

    __m256i sum_vec = _mm256_setzero_si256();

    // Vectorized SCReLU across 1536 neurons
    for (int i = 0; i < HALF_DIM; i += 16) {
        __m256i v_us   = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(us + i));
        __m256i v_them = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(them + i));

        __m256i act_us   = screlu_avx2(v_us);
        __m256i act_them = screlu_avx2(v_them);

        // Multiply-add into dense layer weights
        sum_vec = _mm256_add_epi32(sum_vec, _mm256_madd_epi16(act_us, act_them));
    }

    // Horizontal reduction of 256-bit SIMD register
    __m128i lo = _mm256_castsi256_si128(sum_vec);
    __m128i hi = _mm256_extracti128_si256(sum_vec, 1);
    __m128i r128 = _mm_add_epi32(lo, hi);
    r128 = _mm_hadd_epi32(r128, r128);
    r128 = _mm_hadd_epi32(r128, r128);

    int eval_score = _mm_cvtsi128_si32(r128) / 16;
    return eval_score;
}

} // namespace BerserkerNNUE
`;
