import React, { useState, useEffect, useRef } from 'react';
import { 
  Terminal as TerminalIcon, 
  Play, 
  Square, 
  Copy, 
  Check, 
  Trash2, 
  Cpu, 
  Zap, 
  Sparkles, 
  Layers, 
  Activity,
  BookOpen
} from 'lucide-react';
import { useBerserkerEngine } from './useBerserkerEngine';
import { evaluateAuraNnue } from './engine/auraNnue';
import { evaluateBerserker10Nnue } from './engine/brnnueDualEval';
import { NNUE_RAW_DOWNLOAD_URL } from './engine/wasmEngine';

export const UciEngineConsole: React.FC = () => {
  const {
    isReady,
    isNnueReady,
    nnueProgress,
    isSearching,
    searchInfo,
    bestMove,
    rawLogs,
    clearLogs,
    sendCommand,
    setOption,
  } = useBerserkerEngine();

  const [inputCmd, setInputCmd] = useState<string>('uci');
  const [copiedLogs, setCopiedLogs] = useState<boolean>(false);
  const [activeEvalMode, setActiveEvalMode] = useState<'brnnue-v030' | 'berserker-1.0-nnue' | 'aura-nnue'>('brnnue-v030');
  const [customFen, setCustomFen] = useState<string>('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const [localLogs, setLocalLogs] = useState<string[]>([
    'Berserker v0.7.0 C++20 WebAssembly Engine Initializing...',
    'Neural Network: Auto-Loaded SF-Arch NNUE (nn-bddd9d57eb87.nnue • 138.4 MB) • IndexedDB + GitHub Raw Stream',
    `Raw NNUE URL: ${NNUE_RAW_DOWNLOAD_URL}`,
    'Type UCI commands below or click quick-actions.',
    '--------------------------------------------------------------------------------'
  ]);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [rawLogs, localLogs]);

  const handleSend = (cmdToSend?: string) => {
    const cmd = (cmdToSend || inputCmd).trim();
    if (!cmd) return;

    setLocalLogs((prev) => [...prev, `> ${cmd}`]);

    if (cmd === 'eval') {
      if (activeEvalMode === 'berserker-1.0-nnue') {
        const bsz10Eval = evaluateBerserker10Nnue(customFen);
        setLocalLogs((prev) => [
          ...prev,
          `[Berserker 1.0 Baseline] Eval: ${bsz10Eval.centipawns > 0 ? '+' : ''}${(bsz10Eval.centipawns / 100).toFixed(2)} (${bsz10Eval.centipawns} cp)`
        ]);
      } else if (activeEvalMode === 'aura-nnue') {
        const auraEval = evaluateAuraNnue(customFen);
        setLocalLogs((prev) => [
          ...prev,
          `[AURA-NNUE] Eval: ${auraEval.centipawns > 0 ? '+' : ''}${(auraEval.centipawns / 100).toFixed(2)} (${auraEval.centipawns} cp) | Expert: ${auraEval.activeExpert}`
        ]);
      }
      // Always dispatch to the WASM worker so the embedded nn-bddd9d57eb87.nnue net evaluates the worker's current position
      sendCommand('eval');
      if (!cmdToSend) setInputCmd('');
      return;
    }

    if (cmd.startsWith('position fen ')) {
      const fenPart = cmd.replace('position fen ', '').trim();
      setCustomFen(fenPart.split(' moves ')[0]);
    } else if (cmd === 'position startpos' || cmd.startsWith('position startpos ')) {
      setCustomFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    }

    sendCommand(cmd);
    if (!cmdToSend) setInputCmd('');
  };

  const allLogs = [...localLogs, ...rawLogs];

  return (
    <div className="space-y-6">
      {/* Engine Status Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40">
              Berserker v0.7.0-wasm
            </span>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              {isNnueReady
                ? 'NNUE Active (138.4MB SIMD)'
                : nnueProgress !== null
                ? `Auto-Loading NNUE (${nnueProgress}%)...`
                : isReady
                ? 'WASM Ready'
                : 'Auto-Loading WASM + NNUE...'}
            </span>
            <span className="text-xs text-slate-400 font-mono">
              Status: {isReady ? 'Engine Ready (UCI)' : 'Auto-Loading Network...'}
            </span>
          </div>
          <h2 className="text-lg font-bold text-white mt-1 flex items-center gap-2">
            <TerminalIcon className="w-5 h-5 text-purple-400" />
            Standalone UCI Engine Terminal
          </h2>
          <p className="text-xs text-slate-400">
            Raw UCI console • Auto-loads nn-bddd9d57eb87.nnue (138.4 MB) via{' '}
            <a
              href={NNUE_RAW_DOWNLOAD_URL}
              download="nn-bddd9d57eb87.nnue"
              className="text-purple-300 underline hover:text-purple-200"
            >
              GitHub Raw Link
            </a>
          </p>
        </div>

        {/* Dual Eval Mode Toggle */}
        <div className="flex items-center gap-1.5 bg-slate-950 p-1.5 rounded-xl border border-slate-800">
          <span className="text-[11px] text-slate-400 font-semibold px-2">Net:</span>
          <button
            onClick={() => {
              setActiveEvalMode('brnnue-v030');
              setOption('EvalMode', 'brnnue-v030');
              setLocalLogs((p) => [...p, '[UCI] Evaluator: Auto-Loaded SF-Arch NNUE (nn-bddd9d57eb87.nnue WASM SIMD)']);
            }}
            className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold transition flex items-center gap-1.5 ${
              activeEvalMode === 'brnnue-v030'
                ? 'bg-purple-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            NNUE (138.4MB)
          </button>
          <button
            onClick={() => {
              setActiveEvalMode('berserker-1.0-nnue');
              setOption('EvalMode', 'berserker-1.0-nnue');
              setLocalLogs((p) => [...p, '[UCI] Added Berserker 1.0 baseline comparison readout']);
            }}
            className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold transition flex items-center gap-1.5 ${
              activeEvalMode === 'berserker-1.0-nnue'
                ? 'bg-slate-700 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Berserker 1.0
          </button>
          <button
            onClick={() => {
              setActiveEvalMode('aura-nnue');
              setOption('EvalMode', 'aura-nnue');
              setLocalLogs((p) => [...p, '[UCI] Added Aura-NNUE (GeoSparse-MoE) secondary readout']);
            }}
            className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold transition flex items-center gap-1.5 ${
              activeEvalMode === 'aura-nnue'
                ? 'bg-amber-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Aura-NNUE
          </button>
        </div>
      </div>

      {/* Terminal Display */}
      <div className="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col h-[520px]">
        {/* Terminal Header */}
        <div className="bg-slate-900/90 px-4 py-2.5 border-b border-slate-800 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-rose-500/80 inline-block" />
            <span className="w-3 h-3 rounded-full bg-amber-500/80 inline-block" />
            <span className="w-3 h-3 rounded-full bg-emerald-500/80 inline-block" />
            <span className="text-slate-400 ml-2 font-semibold">berserker@wasm-uci:~$</span>
          </div>

          <div className="flex items-center gap-2">
            {isSearching && (
              <span className="flex items-center gap-1.5 text-purple-400 text-[11px] animate-pulse">
                <span className="w-2 h-2 rounded-full bg-purple-400" />
                Searching (Depth {searchInfo.depth} • {searchInfo.nps.toLocaleString()} NPS)
              </span>
            )}
            <button
              onClick={() => {
                navigator.clipboard.writeText(allLogs.join('\n'));
                setCopiedLogs(true);
                setTimeout(() => setCopiedLogs(false), 2000);
              }}
              className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition"
              title="Copy terminal logs"
            >
              {copiedLogs ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            </button>
            <button
              onClick={() => {
                setLocalLogs([]);
                clearLogs();
              }}
              className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-rose-400 rounded transition"
              title="Clear terminal"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Terminal Output Area */}
        <div className="flex-1 p-4 font-mono text-xs overflow-y-auto space-y-1 text-slate-300 selection:bg-purple-600 selection:text-white">
          {allLogs.map((logLine, idx) => {
            const isUserCmd = logLine.startsWith('>');
            const isBestMove = logLine.startsWith('bestmove');
            const isNnueInfo = logLine.startsWith('info string NNUE') || logLine.includes('nn-bddd9d57eb87.nnue');
            const isInfo = logLine.startsWith('info');
            const isReady = logLine.includes('readyok') || logLine.includes('uciok');
            const isEval = isNnueInfo || logLine.includes('[Berserker') || logLine.includes('[AURA-NNUE]');

            let colorClass = 'text-slate-300';
            if (isUserCmd) colorClass = 'text-amber-300 font-bold';
            else if (isBestMove) colorClass = 'text-emerald-400 font-bold bg-emerald-950/30 px-1 py-0.5 rounded';
            else if (isReady) colorClass = 'text-cyan-400 font-bold';
            else if (isEval) colorClass = 'text-sky-300 font-semibold';
            else if (isInfo) colorClass = 'text-purple-300/90';

            return (
              <div key={idx} className={`${colorClass} leading-relaxed break-all`}>
                {logLine}
              </div>
            );
          })}
          <div ref={terminalEndRef} />
        </div>

        {/* Quick Action UCI Buttons */}
        <div className="bg-slate-900/60 p-2.5 border-t border-slate-800/80 flex flex-wrap items-center gap-1.5 text-xs font-mono">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mr-1">Quick UCI:</span>
          <button
            onClick={() => handleSend('uci')}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
          >
            uci
          </button>
          <button
            onClick={() => handleSend('isready')}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
          >
            isready
          </button>
          <button
            onClick={() => handleSend('ucinewgame')}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
          >
            ucinewgame
          </button>
          <button
            onClick={() => handleSend('eval')}
            className="px-2.5 py-1 rounded bg-purple-950 hover:bg-purple-900 text-purple-300 border border-purple-800 transition font-bold"
          >
            eval (NNUE)
          </button>
          <button
            onClick={() => handleSend('position startpos')}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
          >
            position startpos
          </button>
          <button
            onClick={() => handleSend('go depth 10')}
            className="px-2.5 py-1 rounded bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-800 transition font-bold"
          >
            go depth 10
          </button>
          <button
            onClick={() => handleSend('go movetime 2000')}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
          >
            go movetime 2000
          </button>
          {isSearching && (
            <button
              onClick={() => handleSend('stop')}
              className="px-2.5 py-1 rounded bg-rose-950 hover:bg-rose-900 text-rose-300 border border-rose-800 transition font-bold flex items-center gap-1"
            >
              <Square className="w-3 h-3" /> stop
            </button>
          )}
        </div>

        {/* Command Input Bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="bg-slate-900 p-3 border-t border-slate-800 flex items-center gap-3"
        >
          <span className="text-purple-400 font-mono font-bold">{'>'}</span>
          <input
            type="text"
            value={inputCmd}
            onChange={(e) => setInputCmd(e.target.value)}
            placeholder="Enter UCI command (e.g. go depth 20, eval, position fen ...)"
            className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 font-mono text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition"
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-mono text-xs font-bold transition flex items-center gap-1.5 shadow-md"
          >
            <Play className="w-3.5 h-3.5" />
            Send
          </button>
        </form>
      </div>

      {/* Real-time Telemetry Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
          <span className="text-[10px] text-slate-400 uppercase font-mono font-semibold block">Search Depth</span>
          <span className="text-xl font-bold font-mono text-purple-300 mt-1 block">
            {searchInfo.depth > 0 ? `${searchInfo.depth} / ${searchInfo.seldepth}` : '—'}
          </span>
          <span className="text-[11px] text-slate-500 font-mono">PVS Alpha-Beta plies</span>
        </div>

        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
          <span className="text-[10px] text-slate-400 uppercase font-mono font-semibold block">Search Nodes</span>
          <span className="text-xl font-bold font-mono text-cyan-300 mt-1 block">
            {searchInfo.nodes > 0 ? searchInfo.nodes.toLocaleString() : '—'}
          </span>
          <span className="text-[11px] text-slate-500 font-mono">
            {searchInfo.nps > 0 ? `@ ${searchInfo.nps.toLocaleString()} NPS` : 'WASM Vectorized'}
          </span>
        </div>

        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
          <span className="text-[10px] text-slate-400 uppercase font-mono font-semibold block">Engine Score</span>
          <span className="text-xl font-bold font-mono text-white mt-1 block">
            {searchInfo.scoreCp > 0 ? `+${(searchInfo.scoreCp / 100).toFixed(2)}` : (searchInfo.scoreCp / 100).toFixed(2)}
          </span>
          <span className="text-[11px] text-slate-500 font-mono">
            {searchInfo.mate ? `Mate in ${searchInfo.mate}` : `${searchInfo.scoreCp} cp`}
          </span>
        </div>

        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
          <span className="text-[10px] text-slate-400 uppercase font-mono font-semibold block">Best Move</span>
          <span className="text-xl font-bold font-mono text-emerald-400 mt-1 block">
            {bestMove || '—'}
          </span>
          <span className="text-[11px] text-slate-500 font-mono">Primary Candidate</span>
        </div>
      </div>
    </div>
  );
};
