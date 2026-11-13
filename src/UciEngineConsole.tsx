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
import { evaluateBerserkerNnue } from './engine/berserkerNnue';
import { evaluateBRnnueV030, evaluateBRnnueV070, evaluateBerserker10Nnue } from './engine/brnnueDualEval';
import { getChess960PositionInfo, getRandomChess960Index } from './engine/chess960';

export const UciEngineConsole: React.FC = () => {
  const {
    isReady,
    isSearching,
    searchInfo,
    bestMove,
    multiPvCandidates,
    rawLogs,
    startSearch,
    startInfiniteSearch,
    stopSearch,
    sendCommand,
    setOption,
    setMultiPv
  } = useBerserkerEngine();

  const [inputCmd, setInputCmd] = useState<string>('uci');
  const [copiedLogs, setCopiedLogs] = useState<boolean>(false);
  const [activeEvalMode, setActiveEvalMode] = useState<'brnnue-v030' | 'berserker-1.0-nnue' | 'aura-nnue'>('brnnue-v030');
  const [customFen, setCustomFen] = useState<string>('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const [rustMultiPv, setRustMultiPv] = useState<number>(1);
  const [isChess960Active, setIsChess960Active] = useState<boolean>(false);
  const [rustTelemetry, setRustTelemetry] = useState<{
    depth: number;
    seldepth: number;
    nodes: number;
    nps: number;
    scoreCp: number;
    mate: number | null;
    bestMove: string;
  } | null>(null);
  const lastRawIdxRef = useRef<number>(0);
  const [localLogs, setLocalLogs] = useState<string[]>([
    'Berserker v0.7.0 Native Rust & Dual NNUE Engine Core Initialized.',
    'Default Neural Evaluator: Berserker NNUE v0.7.0 Tapered PeSTO + SCReLU Matrix.',
    'Search Core: Bitboard PVS + Threat-Biased SE + Petrosian Prophylaxis + CorrHist.',
    'Type UCI commands below or click quick-actions.',
    '--------------------------------------------------------------------------------'
  ]);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rawLogs.length > lastRawIdxRef.current) {
      const incoming = rawLogs.slice(lastRawIdxRef.current);
      lastRawIdxRef.current = rawLogs.length;
      setLocalLogs((prev) => [...prev, ...incoming]);
    }
  }, [rawLogs]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [localLogs]);

  const handleSend = (cmdToSend?: string) => {
    const cmd = (cmdToSend || inputCmd).trim();
    if (!cmd) return;

    setLocalLogs((prev) => [...prev, `> ${cmd}`]);

    if (cmd === 'eval') {
      if (activeEvalMode === 'brnnue-v030') {
        const dualEval = evaluateBRnnueV030(customFen);
        setLocalLogs((prev) => [
          ...prev,
          `[Berserker NNUE Dual Architecture] Eval: ${dualEval.centipawns > 0 ? '+' : ''}${(dualEval.centipawns / 100).toFixed(2)} (${dualEval.centipawns} cp)`,
          `  • Subnet 1 (Berserker Attack):     ${dualEval.berserker090.centipawns > 0 ? '+' : ''}${(dualEval.berserker090.centipawns / 100).toFixed(2)} (${(dualEval.phaseWeight.berserkerWeight * 100).toFixed(0)}% weight)`,
          `  • Subnet 2 (Berserker Positional): ${dualEval.plentychess.centipawns > 0 ? '+' : ''}${(dualEval.plentychess.centipawns / 100).toFixed(2)} (${(dualEval.phaseWeight.plentyChessWeight * 100).toFixed(0)}% weight)`,
          `  • Phase: ${dualEval.phaseWeight.gamePhase} | Tension: ${dualEval.tacticalTensionIndex} pts | Net: ${dualEval.netId}`,
          `  • WDL: Win ${(dualEval.winProb * 100).toFixed(1)}% | Draw ${(dualEval.drawProb * 100).toFixed(1)}% | Loss ${(dualEval.lossProb * 100).toFixed(1)}%`
        ]);
      } else if (activeEvalMode === 'berserker-1.0-nnue') {
        const bsz10Eval = evaluateBerserker10Nnue(customFen);
        setLocalLogs((prev) => [
          ...prev,
          `[Berserker 1.0 NNUE] Eval: ${bsz10Eval.centipawns > 0 ? '+' : ''}${(bsz10Eval.centipawns / 100).toFixed(2)} (${bsz10Eval.centipawns} cp)`,
          `[Berserker 1.0 NNUE] Net: ${bsz10Eval.netId} (Previous Single-Perspective Baseline)`,
          `[Berserker 1.0 NNUE] WDL: Win ${(bsz10Eval.winProb * 100).toFixed(1)}% | Loss ${((1 - bsz10Eval.winProb) * 100).toFixed(1)}%`
        ]);
      } else {
        const auraEval = evaluateAuraNnue(customFen);
        setLocalLogs((prev) => [
          ...prev,
          `[AURA-NNUE] Eval: ${auraEval.centipawns > 0 ? '+' : ''}${(auraEval.centipawns / 100).toFixed(2)} (${auraEval.centipawns} cp)`,
          `[AURA-NNUE] Active MoE Expert: ${auraEval.activeExpert} (${(auraEval.routingConfidence * 100).toFixed(0)}% weight)`,
          `[AURA-NNUE] WDL: Win ${(auraEval.winProb * 100).toFixed(1)}% | Draw ${(auraEval.drawProb * 100).toFixed(1)}% | Loss ${(auraEval.lossProb * 100).toFixed(1)}%`
        ]);
      }
      return;
    }

    if (cmd.startsWith('position fen ')) {
      const fenPart = cmd.replace('position fen ', '').trim();
      setCustomFen(fenPart.split(' moves ')[0]);
    } else if (cmd === 'position startpos') {
      setCustomFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      setIsChess960Active(false);
    } else if (cmd.toLowerCase().startsWith('setoption name multipv value ')) {
      const val = parseInt(cmd.split(/\s+/).pop() || '1', 10);
      if (!Number.isNaN(val)) setRustMultiPv(Math.max(1, Math.min(5, val)));
    } else if (cmd.toLowerCase().startsWith('setoption name uci_chess960 value ')) {
      setIsChess960Active(cmd.toLowerCase().endsWith('true'));
    }

    sendCommand(cmd);
    if (!cmdToSend) setInputCmd('');
  };

  const allLogs = localLogs;

  return (
    <div className="space-y-6">
      {/* Engine Status Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40">
              Berserker 18 v0.2.0-alpha
            </span>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              +570 Elo vs v0.9.0
            </span>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-orange-500/20 text-orange-300 border border-orange-500/30 flex items-center gap-1">
              🦀 Native Rust v0.7.0 (Bitboard PVS)
            </span>
            <span className="text-xs text-slate-400 font-mono">
              Status: {isReady ? 'Engine Ready (UCI)' : 'Booting...'}
            </span>
          </div>
          <h2 className="text-lg font-bold text-white mt-1 flex items-center gap-2">
            <TerminalIcon className="w-5 h-5 text-purple-400" />
            Standalone UCI Engine Terminal
          </h2>
          <p className="text-xs text-slate-400">
            Raw UCI console interface • Communicating directly with Berserker 18 search core
          </p>
        </div>

        {/* Dual Eval Mode Toggle */}
        <div className="flex items-center gap-1.5 bg-slate-950 p-1.5 rounded-xl border border-slate-800">
          <span className="text-[11px] text-slate-400 font-semibold px-2">Net:</span>
          <button
            onClick={() => {
              setActiveEvalMode('brnnue-v030');
              setOption('EvalMode', 'brnnue-v030');
              setLocalLogs((p) => [...p, '[UCI] Switched evaluator to Berserker NNUE (Dual Subnet Architecture)']);
            }}
            className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold transition flex items-center gap-1.5 ${
              activeEvalMode === 'brnnue-v030'
                ? 'bg-purple-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            BRnnuev030
          </button>
          <button
            onClick={() => {
              setActiveEvalMode('berserker-1.0-nnue');
              setOption('EvalMode', 'berserker-1.0-nnue');
              setLocalLogs((p) => [...p, '[UCI] Switched evaluator to Berserker 1.0 NNUE (Previous Baseline)']);
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
              setLocalLogs((p) => [...p, '[UCI] Switched evaluator to Aura-NNUE (GeoSparse-MoE)']);
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
            <span className="text-slate-400 ml-2 font-semibold">berserker@uci-shell:~$</span>
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
            const isInfo = logLine.startsWith('info');
            const isReady = logLine.includes('readyok') || logLine.includes('uciok');
            const isEval = logLine.includes('[Berserker') || logLine.includes('[AURA-NNUE]') || logLine.includes('info string eval');

            let colorClass = 'text-slate-300';
            if (isUserCmd) colorClass = 'text-amber-300 font-bold';
            else if (isBestMove) colorClass = 'text-emerald-400 font-bold bg-emerald-950/30 px-1 py-0.5 rounded';
            else if (isReady) colorClass = 'text-cyan-400 font-bold';
            else if (isInfo) colorClass = 'text-purple-300/90';
            else if (isEval) colorClass = 'text-sky-300 font-semibold';

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
            eval ({activeEvalMode === 'brnnue-v030' ? 'BRnnuev030' : activeEvalMode === 'berserker-1.0-nnue' ? 'Berserker 1.0' : 'Aura-NNUE'})
          </button>
          <button
            onClick={() => handleSend('position startpos')}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
          >
            position startpos
          </button>
          <button
            onClick={() => {
              const sp = getRandomChess960Index();
              const info = getChess960PositionInfo(sp);
              setIsChess960Active(true);
              handleSend('setoption name UCI_Chess960 value true');
              handleSend(`position fen ${info.fen}`);
              setLocalLogs((p) => [...p, `[Chess960] Loaded SP ${sp}: [${info.backrank}] - ${info.fen}`]);
            }}
            className="px-2.5 py-1 rounded bg-amber-950 hover:bg-amber-900 text-amber-300 border border-amber-800 transition font-bold"
          >
            🎲 Chess960 Random
          </button>
          <button
            onClick={() => {
              const nextPv = rustMultiPv === 3 ? 1 : 3;
              setRustMultiPv(nextPv);
              setMultiPv(nextPv);
              setOption('MultiPV', nextPv);
              setLocalLogs((p) => [...p, `[UCI] MultiPV set to ${nextPv} candidate line${nextPv > 1 ? 's' : ''}`]);
            }}
            className={`px-2.5 py-1 rounded border transition text-xs font-semibold ${
              rustMultiPv === 3
                ? 'bg-purple-700 text-white border-purple-400'
                : 'bg-purple-950 hover:bg-purple-900 text-purple-300 border-purple-800'
            }`}
          >
            MultiPV: {rustMultiPv === 3 ? '3 (Active)' : '3'}
          </button>
          <button
            onClick={() => handleSend('go depth 15')}
            className="px-2.5 py-1 rounded bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-800 transition font-bold"
          >
            go depth 15
          </button>
          <button
            onClick={async () => {
              setLocalLogs((p) => [
                ...p,
                `> [Native Rust Engine] Searching depth 10 (MultiPV=${rustMultiPv}${isChess960Active ? ', Chess960' : ''})...`
              ]);
              try {
                const res = await fetch('/api/rust/search', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    fen: customFen,
                    depth: 10,
                    movetime: 1500,
                    isChess960: isChess960Active,
                    multiPv: rustMultiPv
                  }),
                });
                const data = await res.json();
                if (data.error) {
                  setLocalLogs((p) => [...p, `[Rust Engine Error] ${data.error}`]);
                } else if (data.infoLines) {
                  if (data.telemetry) {
                    setRustTelemetry({
                      depth: data.telemetry.depth || 10,
                      seldepth: data.telemetry.seldepth || 12,
                      nodes: data.telemetry.nodes || 0,
                      nps: data.telemetry.nps || 0,
                      scoreCp: data.telemetry.scoreCp || 0,
                      mate: data.telemetry.mate ?? null,
                      bestMove: data.bestmove || '—',
                    });
                  }
                  const summary = data.telemetry
                    ? `⚡ [Berserker Rust] Depth ${data.telemetry.depth}/${data.telemetry.seldepth} • ${data.telemetry.nodes?.toLocaleString() || 0} nodes @ ${(data.telemetry.nps || 0).toLocaleString()} NPS${data.telemetry.tbHits ? ` • TB hits: ${data.telemetry.tbHits}` : ''}`
                    : '⚡ [Berserker Rust] Search completed successfully!';
                  setLocalLogs((p) => [...p, ...data.infoLines, `bestmove ${data.bestmove}`, summary]);
                }
              } catch (e: any) {
                setLocalLogs((p) => [...p, `[Rust Engine Error] ${e.message}`]);
              }
            }}
            className="px-2.5 py-1 rounded bg-orange-950 hover:bg-orange-900 text-orange-300 border border-orange-800 transition font-bold flex items-center gap-1"
          >
            🦀 Rust Native Search
          </button>
          <button
            onClick={async () => {
              setLocalLogs((p) => [...p, '> [Native Rust Engine] Running legal move-tree perft 4...']);
              try {
                const res = await fetch('/api/rust/perft', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ fen: customFen, depth: 4, isChess960: isChess960Active }),
                });
                const data = await res.json();
                if (data.perftLine) {
                  setLocalLogs((p) => [...p, `[Rust Perft] ${data.perftLine}`]);
                } else if (data.error) {
                  setLocalLogs((p) => [...p, `[Rust Engine Error] ${data.error}`]);
                }
              } catch (e: any) {
                setLocalLogs((p) => [...p, `[Rust Engine Error] ${e.message}`]);
              }
            }}
            className="px-2.5 py-1 rounded bg-amber-950/80 hover:bg-amber-900 text-amber-200 border border-amber-700/80 transition font-bold"
          >
            🦀 Rust Perft 4
          </button>
          <a
            href="/downloads/berserker-v0.7.0-rust.tar.gz"
            download="berserker-v0.7.0-rust.tar.gz"
            className="px-2.5 py-1 rounded bg-orange-900/60 hover:bg-orange-800 text-orange-200 border border-orange-700/80 transition text-xs font-bold inline-flex items-center gap-1"
          >
            📦 Download Rust Crate
          </a>
          <button
            onClick={() => handleSend('go movetime 3000')}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
          >
            go movetime 3000
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
      {(() => {
        const displayDepth = searchInfo.depth > 0 ? searchInfo.depth : (rustTelemetry?.depth || 0);
        const displaySeldepth = searchInfo.depth > 0 ? searchInfo.seldepth : (rustTelemetry?.seldepth || 0);
        const displayNodes = searchInfo.nodes > 0 ? searchInfo.nodes : (rustTelemetry?.nodes || 0);
        const displayNps = searchInfo.nps > 0 ? searchInfo.nps : (rustTelemetry?.nps || 0);
        const displayScoreCp = searchInfo.depth > 0 ? searchInfo.scoreCp : (rustTelemetry?.scoreCp ?? 0);
        const displayMate = searchInfo.depth > 0 ? searchInfo.mate : (rustTelemetry?.mate ?? null);
        const displayBest = bestMove || rustTelemetry?.bestMove || '';

        return (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase font-mono font-semibold block">Search Depth</span>
              <span className="text-xl font-bold font-mono text-purple-300 mt-1 block">
                {displayDepth > 0 ? `${displayDepth} / ${displaySeldepth}` : '—'}
              </span>
              <span className="text-[11px] text-slate-500 font-mono">
                {rustTelemetry && searchInfo.depth === 0 ? 'Native Rust Bitboard PVS' : 'PVS Alpha-Beta plies'}
              </span>
            </div>

            <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase font-mono font-semibold block">Search Nodes</span>
              <span className="text-xl font-bold font-mono text-cyan-300 mt-1 block">
                {displayNodes > 0 ? displayNodes.toLocaleString() : '—'}
              </span>
              <span className="text-[11px] text-slate-500 font-mono">
                {displayNps > 0 ? `@ ${displayNps.toLocaleString()} NPS` : 'Ready'}
              </span>
            </div>

            <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase font-mono font-semibold block">Engine Score</span>
              <span className="text-xl font-bold font-mono text-white mt-1 block">
                {displayScoreCp > 0 ? `+${(displayScoreCp / 100).toFixed(2)}` : (displayScoreCp / 100).toFixed(2)}
              </span>
              <span className="text-[11px] text-slate-500 font-mono">
                {displayMate ? `Mate in ${displayMate}` : `${displayScoreCp} cp`}
              </span>
            </div>

            <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase font-mono font-semibold block">Best Move</span>
              <span className="text-xl font-bold font-mono text-emerald-400 mt-1 block">
                {displayBest || '—'}
              </span>
              <span className="text-[11px] text-slate-500 font-mono">Primary Candidate</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
