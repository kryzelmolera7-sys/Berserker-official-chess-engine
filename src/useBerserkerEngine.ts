import { useState, useEffect, useRef, useCallback } from 'react';

export interface BerserkerSearchInfo {
  depth: number;
  seldepth: number;
  scoreCp: number;
  mate: number | null;
  nodes: number;
  nps: number;
  timeMs: number;
  pv: string;
  hashFull: number;
  wdl: {
    win: number;
    draw: number;
    loss: number;
  };
}

export interface BerserkerMultiPvCandidate {
  rank: number;
  bestMove: string;
  scoreCp: number;
  mate: number | null;
  depth: number;
  nodes: number;
  pv: string;
}

export interface BerserkerEngineConfig {
  threads: number;
  hashMb: number;
  multiPv: number;
  contempt: number;
  kingAttackScale: number;
  showWdl: boolean;
}

export interface UseBerserkerEngineReturn {
  isReady: boolean;
  isSearching: boolean;
  searchInfo: BerserkerSearchInfo;
  bestMove: string | null;
  ponderMove: string | null;
  multiPvCandidates: BerserkerMultiPvCandidate[];
  rawLogs: string[];
  engineConfig: BerserkerEngineConfig;
  startSearch: (fen: string, movetimeMs?: number) => void;
  startInfiniteSearch: (fen: string) => void;
  stopSearch: () => void;
  sendCommand: (cmd: string) => void;
  setOption: (name: string, value: string | number | boolean) => void;
  setMultiPv: (lines: number) => void;
  setHashSize: (mb: number) => void;
  setThreads: (threads: number) => void;
  setContempt: (contemptCp: number) => void;
  setKingAttackScale: (scalePercent: number) => void;
}

/**
 * Calculates win/draw/loss probabilities using FIDE / CCRL logistic model
 */
export function calculateWdlProbabilities(scoreCp: number, ply = 30): { win: number; draw: number; loss: number } {
  // Normalize cp into win percentage using standard logistic function
  const winExp = 1 / (1 + Math.exp(-scoreCp / 160));
  const lossExp = 1 / (1 + Math.exp(scoreCp / 160));
  
  // Draw probability increases with ply depth and decreases with high score deltas
  const absScore = Math.abs(scoreCp);
  const drawBase = 0.45 * Math.exp(-absScore / 250);
  
  const win = Math.max(0, Math.min(1, winExp * (1 - drawBase * 0.5)));
  const loss = Math.max(0, Math.min(1, lossExp * (1 - drawBase * 0.5)));
  const draw = Math.max(0, 1 - win - loss);
  
  return {
    win: Math.round(win * 1000) / 10,
    draw: Math.round(draw * 1000) / 10,
    loss: Math.round(loss * 1000) / 10,
  };
}

export const useBerserkerEngine = (): UseBerserkerEngineReturn & {
  bestMoveRef: React.MutableRefObject<string | null>;
  searchInfoRef: React.MutableRefObject<BerserkerSearchInfo>;
  multiPvCandidatesRef: React.MutableRefObject<BerserkerMultiPvCandidate[]>;
} => {
  const [isReady, setIsReady] = useState<boolean>(false);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [engineConfig, setEngineConfig] = useState<BerserkerEngineConfig>({
    threads: 4,
    hashMb: 1024,
    multiPv: 3,
    contempt: 45,
    kingAttackScale: 140,
    showWdl: true,
  });

  const [searchInfo, setSearchInfo] = useState<BerserkerSearchInfo>({
    depth: 0,
    seldepth: 0,
    scoreCp: 0,
    mate: null,
    nodes: 0,
    nps: 0,
    timeMs: 0,
    pv: '',
    hashFull: 0,
    wdl: { win: 33.3, draw: 33.4, loss: 33.3 },
  });

  const [bestMove, setBestMove] = useState<string | null>(null);
  const [ponderMove, setPonderMove] = useState<string | null>(null);
  const [multiPvCandidates, setMultiPvCandidates] = useState<BerserkerMultiPvCandidate[]>([]);
  const [rawLogs, setRawLogs] = useState<string[]>([]);

  const workerRef = useRef<Worker | null>(null);
  const bestMoveRef = useRef<string | null>(null);
  const searchInfoRef = useRef<BerserkerSearchInfo>(searchInfo);
  const multiPvCandidatesRef = useRef<BerserkerMultiPvCandidate[]>([]);
  const multiPvMapRef = useRef<Map<number, BerserkerMultiPvCandidate>>(new Map());

  // Initialize Worker
  useEffect(() => {
    let worker: Worker | null = null;
    try {
      worker = new Worker('/berserker-engine-worker.js');
    } catch {
      try {
        worker = new Worker('/stockfish-19-lite-single.js');
      } catch (err) {
        console.error('Failed to initialize Berserker worker', err);
      }
    }

    if (!worker) return;
    workerRef.current = worker;

    worker.onmessage = (event) => {
      const line = typeof event.data === 'string' ? event.data : '';
      if (!line) return;

      // Keep last 100 log lines
      setRawLogs((prev) => {
        const next = [...prev, line];
        return next.length > 100 ? next.slice(-100) : next;
      });

      if (line === 'readyok' || line.includes('uciok')) {
        setIsReady(true);
      }

      // Parse search info lines
      // e.g. "info depth 18 seldepth 28 multipv 1 score cp 45 nodes 84920 nps 1750000 hashfull 32 pv e2e4 c7c5 ..."
      if (line.startsWith('info ') && line.includes('depth ')) {
        const depthMatch = line.match(/\bdepth (\d+)/);
        const seldepthMatch = line.match(/\bseldepth (\d+)/);
        const scoreCpMatch = line.match(/\bscore cp (-?\d+)/);
        const mateMatch = line.match(/\bscore mate (-?\d+)/);
        const nodesMatch = line.match(/\bnodes (\d+)/);
        const npsMatch = line.match(/\bnps (\d+)/);
        const timeMatch = line.match(/\btime (\d+)/);
        const hashFullMatch = line.match(/\bhashfull (\d+)/);
        const multiPvMatch = line.match(/\bmultipv (\d+)/);
        const pvIndex = line.indexOf(' pv ');

        const depth = depthMatch ? parseInt(depthMatch[1], 10) : searchInfoRef.current.depth;
        const seldepth = seldepthMatch ? parseInt(seldepthMatch[1], 10) : searchInfoRef.current.seldepth;
        let scoreCp = scoreCpMatch ? parseInt(scoreCpMatch[1], 10) : searchInfoRef.current.scoreCp;
        const mate = mateMatch ? parseInt(mateMatch[1], 10) : null;
        if (mate !== null) {
          scoreCp = mate > 0 ? 10000 - mate * 10 : -10000 - mate * 10;
        }

        const nodes = nodesMatch ? parseInt(nodesMatch[1], 10) : searchInfoRef.current.nodes;
        const nps = npsMatch ? parseInt(npsMatch[1], 10) : searchInfoRef.current.nps;
        const timeMs = timeMatch ? parseInt(timeMatch[1], 10) : searchInfoRef.current.timeMs;
        const hashFull = hashFullMatch ? parseInt(hashFullMatch[1], 10) : searchInfoRef.current.hashFull;
        const pv = pvIndex !== -1 ? line.substring(pvIndex + 4).trim() : searchInfoRef.current.pv;
        const multiPvRank = multiPvMatch ? parseInt(multiPvMatch[1], 10) : 1;

        const wdl = calculateWdlProbabilities(scoreCp, depth);

        // Track multi-PV line
        const moves = pv.split(/\s+/);
        const primaryMove = moves[0] || '';

        if (primaryMove) {
          const candidate: BerserkerMultiPvCandidate = {
            rank: multiPvRank,
            bestMove: primaryMove,
            scoreCp,
            mate,
            depth,
            nodes,
            pv,
          };
          multiPvMapRef.current.set(multiPvRank, candidate);

          const sortedCandidates = Array.from(multiPvMapRef.current.values())
            .sort((a, b) => a.rank - b.rank);
          multiPvCandidatesRef.current = sortedCandidates;
          setMultiPvCandidates(sortedCandidates);
        }

        // Only update primary search info on multipv 1
        if (multiPvRank === 1) {
          const updated: BerserkerSearchInfo = {
            depth,
            seldepth,
            scoreCp,
            mate,
            nodes,
            nps,
            timeMs,
            pv,
            hashFull,
            wdl,
          };
          searchInfoRef.current = updated;
          setSearchInfo(updated);
        }
      }

      // Parse bestmove line
      // e.g. "bestmove e2e4 ponder e7e5"
      if (line.startsWith('bestmove')) {
        const parts = line.split(/\s+/);
        const bm = parts[1] || null;
        const ponderIdx = parts.indexOf('ponder');
        const pm = ponderIdx !== -1 && parts[ponderIdx + 1] ? parts[ponderIdx + 1] : null;

        bestMoveRef.current = bm;
        setBestMove(bm);
        setPonderMove(pm);
        setIsSearching(false);
      }
    };

    // Configure Berserker UCI options
    worker.postMessage('uci');
    worker.postMessage(`setoption name Threads value 4`);
    worker.postMessage(`setoption name Hash value 1024`);
    worker.postMessage(`setoption name MultiPV value 3`);
    worker.postMessage(`setoption name UCI_ShowWDL value true`);
    worker.postMessage('isready');

    return () => {
      try {
        worker.postMessage('quit');
        worker.terminate();
      } catch (err) {
        console.warn('Worker termination cleanup error', err);
      }
    };
  }, []);

  const sendCommand = useCallback((cmd: string) => {
    if (workerRef.current) {
      workerRef.current.postMessage(cmd);
    }
  }, []);

  const setOption = useCallback((name: string, value: string | number | boolean) => {
    sendCommand(`setoption name ${name} value ${value}`);
  }, [sendCommand]);

  const setMultiPv = useCallback((lines: number) => {
    const clamped = Math.max(1, Math.min(5, lines));
    setEngineConfig((prev) => ({ ...prev, multiPv: clamped }));
    setOption('MultiPV', clamped);
  }, [setOption]);

  const setHashSize = useCallback((mb: number) => {
    const clamped = Math.max(16, Math.min(4096, mb));
    setEngineConfig((prev) => ({ ...prev, hashMb: clamped }));
    setOption('Hash', clamped);
  }, [setOption]);

  const setThreads = useCallback((threads: number) => {
    const clamped = Math.max(1, Math.min(16, threads));
    setEngineConfig((prev) => ({ ...prev, threads: clamped }));
    setOption('Threads', clamped);
  }, [setOption]);

  const setContempt = useCallback((contemptCp: number) => {
    const clamped = Math.max(-100, Math.min(100, contemptCp));
    setEngineConfig((prev) => ({ ...prev, contempt: clamped }));
    setOption('Contempt', clamped);
    setOption('TacticalContempt', clamped);
  }, [setOption]);

  const setKingAttackScale = useCallback((scalePercent: number) => {
    const clamped = Math.max(50, Math.min(250, scalePercent));
    setEngineConfig((prev) => ({ ...prev, kingAttackScale: clamped }));
    setOption('KingAttackScale', clamped);
  }, [setOption]);

  const startSearch = useCallback((fen: string, movetimeMs = 3000) => {
    if (!workerRef.current) return;
    setIsSearching(true);
    bestMoveRef.current = null;
    setBestMove(null);
    setPonderMove(null);
    multiPvMapRef.current.clear();
    setMultiPvCandidates([]);

    workerRef.current.postMessage('stop');
    workerRef.current.postMessage(`position fen ${fen}`);
    workerRef.current.postMessage(`go movetime ${movetimeMs}`);
  }, []);

  const startInfiniteSearch = useCallback((fen: string) => {
    if (!workerRef.current) return;
    setIsSearching(true);
    bestMoveRef.current = null;
    setBestMove(null);
    setPonderMove(null);
    multiPvMapRef.current.clear();
    setMultiPvCandidates([]);

    workerRef.current.postMessage('stop');
    workerRef.current.postMessage(`position fen ${fen}`);
    workerRef.current.postMessage('go infinite');
  }, []);

  const stopSearch = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage('stop');
    }
  }, []);

  return {
    isReady,
    isSearching,
    searchInfo,
    bestMove,
    ponderMove,
    multiPvCandidates,
    rawLogs,
    engineConfig,
    startSearch,
    startInfiniteSearch,
    stopSearch,
    sendCommand,
    setOption,
    setMultiPv,
    setHashSize,
    setThreads,
    setContempt,
    setKingAttackScale,
    bestMoveRef,
    searchInfoRef,
    multiPvCandidatesRef,
  };
};

// Aliases for backwards-compatibility
export const useStockfish = useBerserkerEngine;
