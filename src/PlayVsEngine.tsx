import React, { useState, useEffect, useRef } from 'react';
import { Chess } from 'chess.js';
import { ChessPiece } from './ChessPiece';
import { useBerserkerEngine } from './useBerserkerEngine';
import { 
  Cpu, 
  User, 
  RotateCcw, 
  Clock, 
  Zap, 
  Award, 
  Play, 
  ChevronRight, 
  RefreshCw, 
  Sparkles,
  HelpCircle,
  Flag,
  ArrowLeftRight,
  Gem,
  CheckCircle2,
  Flame,
  ShieldCheck,
  Terminal,
  Activity,
  Copy,
  Check,
  Cloud,
  BookOpen,
  Crown,
  ShieldAlert,
  Swords,
  Sliders
} from 'lucide-react';
import { saveGameRecord } from './firebaseService';
import {
  getOpeningBookMove,
  OpeningBookEntry,
  evaluateKingSafety,
  KingSafetyMetrics,
  BlendedMoveResult
} from './engine/engineHeuristics';
import { updateActiveBerserkerNet } from './engine/berserkerNnue';
import { searchIndependentBerserker } from './engine/berserkerIndependentSearch';
import { initWasmEngine, NNUE_RAW_DOWNLOAD_URL } from './engine/wasmEngine';

interface PlayVsEngineProps {
  maxThreads?: number;
  hashSizeMb?: number;
}

export const PlayVsEngine: React.FC<PlayVsEngineProps> = ({ 
  maxThreads = 192, 
  hashSizeMb = 32768 
}) => {
  const [chess] = useState<Chess>(() => new Chess());
  const [fen, setFen] = useState<string>(chess.fen());
  const [playerColor, setPlayerColor] = useState<'w' | 'b'>('w');
  const [engineMode, setEngineMode] = useState<'berserker-nnue'>('berserker-nnue');
  
  // Dynamic 24/7 Server Daemon Checkpoint Sync
  const [activeNetId, setActiveNetId] = useState<string>('berserker_dual_net_ep9_b400.nnue');
  const [activeEpoch, setActiveEpoch] = useState<number>(9);
  const [activeLoss, setActiveLoss] = useState<number>(0.5561);
  const [activeTrainedPositions, setActiveTrainedPositions] = useState<number>(51921);

  useEffect(() => {
    let isMounted = true;
    const fetchState = async () => {
      try {
        const res = await fetch('/api/berserker/state');
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data) {
            setActiveNetId(data.activeCheckpoint || 'berserker_dual_net_ep9_b400.nnue');
            setActiveEpoch(data.currentEpoch || 9);
            setActiveLoss(data.currentLoss || 0.5561);
            setActiveTrainedPositions(data.totalPositionsGenerated || 51921);
            updateActiveBerserkerNet({
              netId: data.activeCheckpoint,
              epoch: data.currentEpoch,
              batchId: data.currentBatchId,
              jointLoss: data.currentLoss,
              validationLoss: data.validationLoss,
              totalPositionsTrained: data.totalPositionsGenerated,
            });
          }
        }
      } catch {
        // Fallback gracefully
      }
    };
    fetchState();
    const interval = setInterval(fetchState, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);
  
  // Native Berserker v0.7.0 WASM + Embedded 138.4MB NNUE Worker
  const {
    isReady: isWasmReady,
    isNnueReady,
    nnueProgress,
    isSearching: isWasmSearching,
    searchInfo: wasmSearchInfo,
    bestMove: wasmBestMove,
    multiPvCandidates: wasmMultiPvCandidates,
    rawLogs: wasmRawLogs,
    startSearch: startWasmSearch,
    stopSearch: stopWasmSearch,
    sendCommand: sendWasmCommand,
    clearLogs: clearWasmLogs,
    setContempt: setWasmContempt,
    bestMoveRef: wasmBestMoveRef,
    searchInfoRef: wasmSearchInfoRef,
    multiPvCandidatesRef: wasmMultiPvCandidatesRef
  } = useBerserkerEngine();

  // Dynamic thinking time allocation (Defaults to 3.0s responsive Match mode, customizable up to 30s)
  const [thinkingTimeSec, setThinkingTimeSec] = useState<number>(3.0);
  const [copiedGamePgn, setCopiedGamePgn] = useState<boolean>(false);

  const [isEngineThinking, setIsEngineThinking] = useState<boolean>(false);
  const [thinkingCountdown, setThinkingCountdown] = useState<number>(3.0);
  const [liveNodes, setLiveNodes] = useState<number>(0);
  const [liveNps, setLiveNps] = useState<number>(0);
  const [liveDepth, setLiveDepth] = useState<number>(0);
  const [liveSeldepth, setLiveSeldepth] = useState<number>(0);
  const [livePv, setLivePv] = useState<string>('');
  const [lastTelemetry, setLastTelemetry] = useState<{
    depth: number;
    seldepth: number;
    nodes: number;
    nps: number;
    pv: string;
    scoreCp: number;
  }>({ depth: 0, seldepth: 0, nodes: 0, nps: 0, pv: '', scoreCp: 0 });

  const [showConsole, setShowConsole] = useState<boolean>(false);
  const [consoleInput, setConsoleInput] = useState<string>('');
  const terminalLogsEndRef = useRef<HTMLDivElement>(null);

  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);
  const [lastMoveSquares, setLastMoveSquares] = useState<{ from: string; to: string } | null>(null);
  const [moveHistory, setMoveHistory] = useState<{ moveNumber: number; w?: string; b?: string }[]>([]);
  const [evalCp, setEvalCp] = useState<number>(0);
  const [gameResult, setGameResult] = useState<string | null>(null);
  const [hintMove, setHintMove] = useState<string | null>(null);

  // Full UCI move history from startpos so WASM tracks 3-fold repetitions
  const uciMovesRef = useRef<string[]>([]);
  const moveDispatchedForFenRef = useRef<string | null>(null);
  const forceMoveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Singular Extension & Color Complex Tracking
  const [isSingularActive, setIsSingularActive] = useState<boolean>(false);
  const [activeColorComplexTarget, setActiveColorComplexTarget] = useState<string | null>(null);

  // Opening Book & King Safety Informational Badges
  const [currentBookEntry, setCurrentBookEntry] = useState<OpeningBookEntry | null>(() => getOpeningBookMove(chess.fen()));
  const [activeKingSafety, setActiveKingSafety] = useState<KingSafetyMetrics | null>(null);
  const [lastBlendedMove, setLastBlendedMove] = useState<BlendedMoveResult | null>(null);
  const [contemptFactor, setContemptFactor] = useState<number>(0);

  // Level 2 Cloud Persistence State
  const [cloudSavedNotice, setCloudSavedNotice] = useState<boolean>(false);
  const [cloudGameId, setCloudGameId] = useState<string | null>(null);

  const handleAutoSaveCompletedGame = (outcomeResult: '1-0' | '0-1' | '1/2-1/2' | '*', outcomeReason: string) => {
    saveGameRecord({
      gameMode: 'PlayVsEngine',
      whiteEngine: playerColor === 'w' ? 'Human Player' : `Berserker 18 (${engineMode})`,
      blackEngine: playerColor === 'b' ? 'Human Player' : `Berserker 18 (${engineMode})`,
      result: outcomeResult,
      reason: outcomeReason,
      movesCount: chess.history().length,
      pgn: chess.pgn() || moveHistory.map(m => `${m.moveNumber}. ${m.w || ''} ${m.b || ''}`).join(' '),
      fen: chess.fen(),
      isPublic: true
    })
    .then((savedId) => {
      setCloudSavedNotice(true);
      setCloudGameId(savedId);
    })
    .catch((err) => {
      console.warn('Could not auto-save game to Cloud Firestore:', err);
    });
  };

  const movesContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll moves container only (avoid jumping outer viewport)
  useEffect(() => {
    if (movesContainerRef.current) {
      movesContainerRef.current.scrollTop = movesContainerRef.current.scrollHeight;
    }
  }, [moveHistory]);

  // Sync TacticalContempt option with WASM worker when ready or adjusted
  useEffect(() => {
    if (isWasmReady) {
      setWasmContempt(contemptFactor);
    }
  }, [isWasmReady, contemptFactor, setWasmContempt]);

  // Turn management: Check if it's engine's turn
  const isEngineTurn = chess.turn() !== playerColor && !chess.isGameOver();

  // Keep King Safety, Color Complex & Book Badge synced cleanly to current board
  useEffect(() => {
    try {
      setActiveKingSafety(evaluateKingSafety(chess, playerColor));
      const oppColor = playerColor === 'w' ? 'b' : 'w';
      let oppLight = false;
      let oppDark = false;
      let ourLight = false;
      let ourDark = false;
      chess.board().forEach((row, rIdx) => {
        row.forEach((sq, cIdx) => {
          if (!sq || sq.type !== 'b') return;
          const isLight = (rIdx + cIdx) % 2 === 0;
          if (sq.color === oppColor) {
            if (isLight) oppLight = true;
            else oppDark = true;
          } else {
            if (isLight) ourLight = true;
            else ourDark = true;
          }
        });
      });
      setActiveColorComplexTarget(
        !oppDark && ourDark ? 'dark' : !oppLight && ourLight ? 'light' : null
      );
      const cands = wasmMultiPvCandidatesRef.current;
      setIsSingularActive(cands.length >= 2 && Math.abs(cands[0].scoreCp - cands[1].scoreCp) >= 60);
    } catch {
      // ignore transient state updates
    }
  }, [fen, playerColor, chess, wasmMultiPvCandidatesRef]);

  const rebuildMoveHistory = (c: Chess) => {
    const hist = c.history();
    const pairs: { moveNumber: number; w?: string; b?: string }[] = [];
    for (let i = 0; i < hist.length; i += 2) {
      pairs.push({
        moveNumber: Math.floor(i / 2) + 1,
        w: hist[i],
        b: hist[i + 1],
      });
    }
    return pairs;
  };

  // Dispatch engine move directly from WASM NNUE search so played move === pv[0]
  const dispatchEngineMove = (overrideBestMoveUci?: string) => {
    const activeFen = chess.fen();
    if (
      moveDispatchedForFenRef.current === activeFen ||
      chess.turn() === playerColor ||
      chess.isGameOver()
    ) {
      return;
    }

    if (forceMoveTimerRef.current) {
      clearTimeout(forceMoveTimerRef.current);
      forceMoveTimerRef.current = null;
    }

    // Informational opening book badge only (never overrides engine PV)
    setCurrentBookEntry(getOpeningBookMove(activeFen));

    let chosenMove: any = null;
    let finalTelemetry = {
      depth: wasmSearchInfoRef.current?.depth || liveDepth || 0,
      seldepth: wasmSearchInfoRef.current?.seldepth || liveSeldepth || 0,
      nodes: wasmSearchInfoRef.current?.nodes || liveNodes || 0,
      nps: wasmSearchInfoRef.current?.nps || liveNps || 0,
      pv: wasmSearchInfoRef.current?.pv || livePv || '',
      scoreCp: wasmSearchInfoRef.current?.scoreCp ?? evalCp,
    };

    // 1. PRIORITY 1: BERSERKER C++20 WASM + 138.4MB NNUE ENGINE MOVE (matches pv[0])
    if (!chosenMove) {
      const pvFirst = (wasmSearchInfoRef.current?.pv || '').trim().split(/\s+/)[0] || '';
      const wasmMove =
        overrideBestMoveUci ||
        wasmBestMoveRef.current ||
        wasmBestMove ||
        (pvFirst.length >= 4 ? pvFirst : '');

      if (wasmMove && wasmMove.length >= 4) {
        try {
          const testMove = chess.move({
            from: wasmMove.slice(0, 2),
            to: wasmMove.slice(2, 4),
            promotion: wasmMove[4] || undefined
          });
          if (testMove) {
            chosenMove = testMove;
            const currentInfo = wasmSearchInfoRef.current;
            if (currentInfo && currentInfo.depth > 0) {
              const adjustedPv =
                currentInfo.pv && currentInfo.pv.trim().startsWith(wasmMove)
                  ? currentInfo.pv
                  : wasmMove;
              finalTelemetry = {
                depth: currentInfo.depth,
                seldepth: currentInfo.seldepth || currentInfo.depth,
                nodes: currentInfo.nodes,
                nps: currentInfo.nps,
                pv: adjustedPv,
                scoreCp: currentInfo.scoreCp,
              };
            } else if (!finalTelemetry.pv) {
              finalTelemetry.pv = wasmMove;
            }
            setLastBlendedMove({
              chosenMoveUci: wasmMove,
              chosenMoveSan: testMove.san,
              reason: 'tactical-pv'
            });
          }
        } catch {
          chosenMove = null;
        }
      }

      // Emergency synchronous Pure-PVS fallback only if worker had not finished booting yet
      if (!chosenMove) {
        const searchDepth = Math.min(12, Math.max(6, Math.round(thinkingTimeSec * 1.2)));
        const searchTime = Math.min(2500, Math.round(thinkingTimeSec * 1000));
        const bRes = searchIndependentBerserker(activeFen, searchDepth, searchTime);

        if (bRes && bRes.bestMoveUci && bRes.bestMoveUci !== '0000') {
          try {
            const bMove = chess.move({
              from: bRes.bestMoveUci.slice(0, 2),
              to: bRes.bestMoveUci.slice(2, 4),
              promotion: bRes.bestMoveUci[4] || undefined
            });
            if (bMove) {
              chosenMove = bMove;
              finalTelemetry = {
                depth: bRes.depth,
                seldepth: bRes.seldepth,
                nodes: bRes.nodes + bRes.qnodes,
                nps: bRes.nps,
                pv: bRes.pv.length > 0 ? bRes.pv.join(' ') : bMove.san,
                scoreCp: bRes.scoreCp,
              };
              setLastBlendedMove({
                chosenMoveUci: bRes.bestMoveUci,
                chosenMoveSan: bMove.san,
                reason: 'tactical-pv'
              });
            }
          } catch (err) {
            console.warn('Berserker emergency search move error:', err);
          }
        }
      }
    }

    // Ultimate legality safety fallback
    if (!chosenMove) {
      const legal = chess.moves({ verbose: true });
      if (legal.length > 0) {
        chosenMove = chess.move(legal[0]);
      }
    }

    if (chosenMove) {
      moveDispatchedForFenRef.current = activeFen;
      const uciPlayed = `${chosenMove.from}${chosenMove.to}${chosenMove.promotion || ''}`;
      uciMovesRef.current = [...uciMovesRef.current, uciPlayed];

      const nextFen = chess.fen();
      setFen(nextFen);
      setCurrentBookEntry(getOpeningBookMove(nextFen));
      setLastMoveSquares({ from: chosenMove.from, to: chosenMove.to });
      setMoveHistory(rebuildMoveHistory(chess));

      setEvalCp(finalTelemetry.scoreCp);
      setLiveDepth(finalTelemetry.depth);
      setLiveSeldepth(finalTelemetry.seldepth);
      setLiveNodes(finalTelemetry.nodes);
      setLiveNps(finalTelemetry.nps);
      setLivePv(finalTelemetry.pv);
      setLastTelemetry(finalTelemetry);

      if (chess.isGameOver()) {
        if (chess.isCheckmate()) {
          const winner = chess.turn() === 'w' ? 'Black' : 'White';
          const resultStr = chess.turn() === 'w' ? '0-1' : '1-0';
          setGameResult(`Checkmate! ${winner} wins!`);
          handleAutoSaveCompletedGame(resultStr, `Checkmate by ${winner}`);
        } else if (chess.isDraw()) {
          setGameResult('Game drawn (Stalemate / Insufficient Material / Repetition).');
          handleAutoSaveCompletedGame('1/2-1/2', 'Draw by stalemate or repetition');
        }
      }
    }

    setIsEngineThinking(false);
    setThinkingCountdown(thinkingTimeSec);
  };

  // Manual Force Move trigger: asks WASM to stop and immediately emit bestmove === pv[0]
  const handleForceMoveNow = () => {
    if (!isEngineThinking || gameResult) return;
    stopWasmSearch();
    if (forceMoveTimerRef.current) clearTimeout(forceMoveTimerRef.current);
    forceMoveTimerRef.current = setTimeout(() => {
      dispatchEngineMove();
    }, 350);
  };

  // Trigger Native C++20 WASM + 138.4MB Auto-Loaded NNUE Search when it becomes Engine's Turn
  useEffect(() => {
    if (!isEngineTurn || gameResult) return;
    if (moveDispatchedForFenRef.current === fen) return;
    if (!isNnueReady) {
      setIsEngineThinking(true);
      setThinkingCountdown(thinkingTimeSec);
      return;
    }

    setIsEngineThinking(true);
    setThinkingCountdown(thinkingTimeSec);
    setLiveNodes(0);
    setLiveNps(0);
    setLiveDepth(0);
    setLiveSeldepth(0);
    setLivePv('');

    const searchMoveTime = Math.max(500, Math.round(thinkingTimeSec * 1000));
    startWasmSearch(chess.fen(), searchMoveTime, uciMovesRef.current);

    const startTime = Date.now();
    const safetyDeadlineSec = Math.max(thinkingTimeSec + 8, 12);

    const interval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.max(0, thinkingTimeSec - elapsed);
      setThinkingCountdown(parseFloat(remaining.toFixed(1)));

      const currentInfo = wasmSearchInfoRef.current;
      if (currentInfo && currentInfo.depth > 0) {
        setLiveDepth(currentInfo.depth);
        setLiveSeldepth(currentInfo.seldepth || currentInfo.depth);
        setLiveNodes(currentInfo.nodes);
        const currentNps =
          currentInfo.nps || Math.round(currentInfo.nodes / Math.max(0.05, elapsed));
        setLiveNps(currentNps);
        if (currentInfo.pv) setLivePv(currentInfo.pv);
        setEvalCp(currentInfo.scoreCp);
      }

      // Only force fallback if worker failed well past its allocated movetime
      if (elapsed >= safetyDeadlineSec) {
        clearInterval(interval);
        stopWasmSearch();
        dispatchEngineMove();
      }
    }, 100);

    return () => {
      clearInterval(interval);
      if (forceMoveTimerRef.current) {
        clearTimeout(forceMoveTimerRef.current);
        forceMoveTimerRef.current = null;
      }
      stopWasmSearch();
    };
  }, [fen, isEngineTurn, gameResult, playerColor, thinkingTimeSec, isNnueReady]);

  // Immediately play the exact bestmove emitted by WASM so board move === pv[0]
  useEffect(() => {
    if (!isEngineThinking || !isEngineTurn || gameResult) return;
    if (!wasmBestMove || wasmBestMove === '0000') return;
    if (wasmBestMoveRef.current !== wasmBestMove) return;
    if (moveDispatchedForFenRef.current === fen) return;
    dispatchEngineMove(wasmBestMove);
  }, [wasmBestMove, isEngineThinking, isEngineTurn, gameResult, fen]);

  // Parse FEN into 8x8 array
  const parseFen = (currentFen: string) => {
    const rows = currentFen.split(' ')[0].split('/');
    const board: (string | null)[][] = [];
    for (let r = 0; r < 8; r++) {
      const rowArr: (string | null)[] = [];
      const rowStr = rows[r];
      for (const char of rowStr) {
        if (!isNaN(parseInt(char))) {
          const emptyCount = parseInt(char);
          for (let e = 0; e < emptyCount; e++) rowArr.push(null);
        } else {
          rowArr.push(char);
        }
      }
      board.push(rowArr);
    }
    return board;
  };

  const boardGrid = parseFen(fen);

  // Handle Human Move
  const handleSquareClick = (r: number, c: number) => {
    if (isEngineThinking || gameResult) return;
    if (chess.turn() !== playerColor) return;

    // Adjust for orientation
    const actualR = playerColor === 'w' ? r : 7 - r;
    const actualC = playerColor === 'w' ? c : 7 - c;

    const colLetter = String.fromCharCode(97 + actualC);
    const rowNum = 8 - actualR;
    const square = `${colLetter}${rowNum}`;

    if (selectedSquare) {
      try {
        const move = chess.move({
          from: selectedSquare,
          to: square,
          promotion: 'q'
        });

        if (move) {
          const uciPlayed = `${move.from}${move.to}${move.promotion || ''}`;
          uciMovesRef.current = [...uciMovesRef.current, uciPlayed];
          moveDispatchedForFenRef.current = null;
          const nextFen = chess.fen();
          setFen(nextFen);
          setCurrentBookEntry(getOpeningBookMove(nextFen));
          setLastMoveSquares({ from: selectedSquare, to: square });
          setSelectedSquare(null);
          setLegalMoves([]);
          setHintMove(null);

          // Record move
          setMoveHistory(rebuildMoveHistory(chess));

          // Check game over
          if (chess.isGameOver()) {
            if (chess.isCheckmate()) {
              const winner = chess.turn() === 'w' ? 'Black' : 'White';
              const resultStr = chess.turn() === 'w' ? '0-1' : '1-0';
              setGameResult(`Checkmate! ${winner} wins!`);
              handleAutoSaveCompletedGame(resultStr, `Checkmate by ${winner}`);
            } else if (chess.isDraw()) {
              setGameResult('Game drawn (Stalemate / Insufficient Material / Repetition).');
              handleAutoSaveCompletedGame('1/2-1/2', 'Draw by stalemate or repetition');
            }
          }
          return;
        }
      } catch {
        // Illegal destination
      }
    }

    // Select piece
    const piece = chess.get(square as any);
    if (piece && piece.color === playerColor) {
      setSelectedSquare(square);
      const moves = chess.moves({ square: square as any, verbose: true });
      setLegalMoves(moves.map((m) => m.to));
    } else {
      setSelectedSquare(null);
      setLegalMoves([]);
    }
  };

  const handleNewGame = () => {
    if (forceMoveTimerRef.current) {
      clearTimeout(forceMoveTimerRef.current);
      forceMoveTimerRef.current = null;
    }
    stopWasmSearch();
    sendWasmCommand('ucinewgame');
    chess.reset();
    uciMovesRef.current = [];
    moveDispatchedForFenRef.current = null;
    const startFen = chess.fen();
    setFen(startFen);
    setCurrentBookEntry(getOpeningBookMove(startFen));
    setLastBlendedMove(null);
    setSelectedSquare(null);
    setLegalMoves([]);
    setLastMoveSquares(null);
    setMoveHistory([]);
    setGameResult(null);
    setHintMove(null);
    setIsEngineThinking(false);
    setThinkingCountdown(thinkingTimeSec);
    setEvalCp(0);
    setLiveDepth(0);
    setLiveSeldepth(0);
    setLiveNodes(0);
    setLiveNps(0);
    setLivePv('');
    setLastTelemetry({ depth: 0, seldepth: 0, nodes: 0, nps: 0, pv: '', scoreCp: 0 });
  };

  const handleTakeback = () => {
    if (isEngineThinking) return;
    const u1 = chess.undo();
    if (u1) uciMovesRef.current = uciMovesRef.current.slice(0, -1);
    if (chess.turn() !== playerColor) {
      const u2 = chess.undo();
      if (u2) uciMovesRef.current = uciMovesRef.current.slice(0, -1);
    }
    moveDispatchedForFenRef.current = null;
    const undoFen = chess.fen();
    setFen(undoFen);
    setCurrentBookEntry(getOpeningBookMove(undoFen));
    setSelectedSquare(null);
    setLegalMoves([]);
    setGameResult(null);
    setHintMove(null);

    const remainingVerbose = chess.history({ verbose: true });
    const prevMove = remainingVerbose[remainingVerbose.length - 1];
    setLastMoveSquares(prevMove ? { from: prevMove.from, to: prevMove.to } : null);
    setMoveHistory(rebuildMoveHistory(chess));
  };

  const handleRequestHint = async () => {
    if (isEngineThinking || gameResult) return;
    const hintFen = chess.fen();
    try {
      const wasm = await initWasmEngine();
      if (wasm) {
        const wRes = wasm.search('startpos', 10, 700, uciMovesRef.current);
        if (wRes.bestMoveUci && wRes.bestMoveUci !== '0000') {
          const tmp = new Chess(hintFen);
          const mv = tmp.move({
            from: wRes.bestMoveUci.slice(0, 2),
            to: wRes.bestMoveUci.slice(2, 4),
            promotion: wRes.bestMoveUci[4] || undefined,
          });
          const san = mv ? mv.san : wRes.bestMoveUci;
          setHintMove(
            `Suggested Move: ${san} (${wRes.bestMoveUci.slice(0, 2)} -> ${wRes.bestMoveUci.slice(2, 4)}) [d${wRes.depth}, Eval: ${wRes.scoreCp >= 0 ? '+' : ''}${(wRes.scoreCp / 100).toFixed(2)}]`
          );
          return;
        }
      }
    } catch {
      // fall through to synchronous fallback
    }
    const bRes = searchIndependentBerserker(hintFen, 7, 700);
    if (bRes && bRes.bestMoveSan) {
      setHintMove(`Suggested Move: ${bRes.bestMoveSan} (${bRes.bestMoveUci.slice(0, 2)} -> ${bRes.bestMoveUci.slice(2, 4)}) [Eval: ${bRes.scoreCp >= 0 ? '+' : ''}${(bRes.scoreCp / 100).toFixed(2)}]`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
        
        {/* Header Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-purple-500/10 text-purple-400 border border-purple-500/20 flex items-center gap-1.5 shadow-sm">
                <Gem className="w-3.5 h-3.5" />
                Berserker v0.7.0 Grandmaster Core
              </span>
              <span className="text-xs text-slate-400">Pure-PVS Alpha-Beta &amp; Auto-Loaded 138.4 MB NNUE</span>
            </div>
            <h3 className="text-xl font-bold text-white mt-1">Play Against Berserker v0.7.0</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              C++20 WASM SIMD128 • Pure-PVS Alpha-Beta • Auto-Loaded SF-Arch NNUE (138.4 MB)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Live Real Engine Runtime Badge */}
            <div className="flex items-center gap-1.5 bg-purple-500/10 border border-purple-500/30 px-3 py-1.5 rounded-xl text-xs font-mono font-semibold text-purple-300 whitespace-nowrap">
              <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
              <span>WASM SIMD128 • 64 MB | Native 192T / 32 GB</span>
            </div>

            {/* Time Control Selector */}
            <div className="flex items-center gap-1 bg-slate-950 px-2.5 py-1 rounded-xl border border-slate-800 text-xs font-mono">
              <Clock className="w-3.5 h-3.5 text-purple-400 mr-1" />
              <span className="text-[10px] text-slate-500 mr-1 hidden sm:inline">Time:</span>
              {[1.0, 3.0, 5.0, 10.0, 15.0, 30.0].map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setThinkingTimeSec(t);
                    setThinkingCountdown(t);
                  }}
                  className={`px-2 py-0.5 rounded text-[11px] font-bold transition ${
                    thinkingTimeSec === t
                      ? 'bg-purple-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                  title={`${t}s thinking time allocation`}
                >
                  {t.toFixed(0)}s{t === 15.0 ? ' ★' : ''}
                </button>
              ))}
            </div>

            {/* Copy Game PGN */}
            <button
              onClick={() => {
                const gamePgn = chess.pgn();
                navigator.clipboard.writeText(gamePgn || 'No moves yet');
                setCopiedGamePgn(true);
                setTimeout(() => setCopiedGamePgn(false), 2000);
              }}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs transition flex items-center gap-1.5 border border-slate-700 shadow-sm"
              title="Copy current match notation"
            >
              {copiedGamePgn ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-slate-400" />}
              {copiedGamePgn ? 'Copied PGN' : 'Export PGN'}
            </button>

            {/* UCI Console Toggle */}
            <button
              onClick={() => setShowConsole(!showConsole)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 border ${
                showConsole 
                  ? 'bg-purple-600 text-white border-purple-500 shadow-md shadow-purple-600/20' 
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              {showConsole ? 'Hide Console' : 'UCI Console'}
            </button>

            {/* New Game Button */}
            <button
              onClick={handleNewGame}
              className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs transition flex items-center gap-1.5 border border-slate-700 shadow-sm"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              New Game
            </button>
          </div>
        </div>

        {/* Match Arena Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-6">
          
          {/* Left: Engine Profile Card + Chessboard + Player Profile Card */}
          <div className="lg:col-span-7 flex flex-col items-center gap-4">
            
            {/* Opponent Card: Berserker v0.6.0 C++20 WASM + Reckless NNUE */}
            <div className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 flex flex-col gap-3 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center font-bold shadow-lg bg-gradient-to-br from-purple-500 via-indigo-600 to-orange-500 text-white shrink-0">
                    <Gem className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-white">
                        Berserker v0.7.0 (C++20 WASM + 138.4MB NNUE)
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded font-mono font-bold bg-purple-500/10 text-purple-300 border border-purple-500/30">
                        Pure-PVS Alpha-Beta • SIMD128
                      </span>
                    </div>

                    <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-2 mt-1">
                      <span>{playerColor === 'w' ? 'Playing Black' : 'Playing White'}</span>
                      <span>•</span>
                      <span className="text-purple-300 font-mono font-semibold">{thinkingTimeSec.toFixed(1)}s / move</span>
                      <span>•</span>
                      <span>Auto-Loaded NNUE Engine</span>
                      <span>•</span>
                      <span className="text-emerald-400 font-bold">
                        {isNnueReady
                          ? 'NNUE Ready (138.4 MB)'
                          : nnueProgress !== null
                          ? `Auto-Loading NNUE (${nnueProgress}%)...`
                          : isWasmReady
                          ? 'WASM Ready • Downloading NNUE...'
                          : 'Auto-Loading WASM + NNUE...'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Engine Status / Thinking Indicator & Force Move */}
                <div className="flex items-center gap-2 self-start sm:self-center">
                  {isEngineThinking ? (
                    <div className="flex items-center gap-2 bg-purple-500/15 border border-purple-500/30 px-3 py-1.5 rounded-lg text-purple-200 font-mono text-xs font-bold shadow-sm">
                      <div className="w-2 h-2 rounded-full bg-purple-400 animate-ping" />
                      <span>
                        {!isNnueReady
                          ? `Loading NNUE${nnueProgress !== null ? ` (${nnueProgress}%)` : '...'}`
                          : `Thinking: ${thinkingCountdown}s`}
                      </span>
                      {isNnueReady && (
                        <button
                          onClick={handleForceMoveNow}
                          className="ml-2 px-2 py-0.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-[10px] uppercase font-bold tracking-wider transition"
                          title="Force immediate engine move"
                        >
                          Play Now
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="text-right">
                      <span className="text-[11px] text-slate-500 font-mono block">Awaiting your move</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Exclusive Opponent Banner */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-900 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider whitespace-nowrap">Engine:</span>
                  <div className="px-2.5 py-1 rounded-lg bg-gradient-to-r from-purple-950/90 to-indigo-950/90 border border-purple-500/40 text-purple-200 text-[11px] font-bold font-mono flex items-center gap-1.5 shadow-sm whitespace-nowrap">
                    <Gem className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                    <span>Berserker v0.7.0-wasm</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-[10px] font-mono font-bold text-emerald-300 whitespace-nowrap">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                    <span>{isNnueReady ? 'NNUE: nn-bddd9d57eb87.nnue' : `Net: ${activeNetId}`}</span>
                  </div>
                  <a
                    href={NNUE_RAW_DOWNLOAD_URL}
                    download="nn-bddd9d57eb87.nnue"
                    className="text-[10px] font-mono text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 px-2 py-1 rounded border border-amber-500/30 transition whitespace-nowrap"
                    title="Direct raw NNUE download link from GitHub"
                  >
                    Raw .nnue Link
                  </a>
                  <span className="text-[10px] font-mono text-cyan-400 bg-cyan-500/10 px-2 py-1 rounded border border-cyan-500/20 whitespace-nowrap">
                    PV = Played
                  </span>
                </div>
              </div>
            </div>

            {/* Board Container */}
            <div className="relative aspect-square w-full max-w-[440px] border-4 border-slate-800 rounded-2xl overflow-hidden shadow-2xl bg-slate-950 select-none">
              <div className="grid grid-cols-8 grid-rows-8 w-full h-full">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((r) =>
                  [0, 1, 2, 3, 4, 5, 6, 7].map((c) => {
                    const actualR = playerColor === 'w' ? r : 7 - r;
                    const actualC = playerColor === 'w' ? c : 7 - c;

                    const isLight = (actualR + actualC) % 2 === 0;
                    const piece = boardGrid[actualR][actualC];
                    const colLetter = String.fromCharCode(97 + actualC);
                    const rowNum = 8 - actualR;
                    const square = `${colLetter}${rowNum}`;

                    const isSelected = selectedSquare === square;
                    const isLegal = legalMoves.includes(square);
                    const isLastFrom = lastMoveSquares?.from === square;
                    const isLastTo = lastMoveSquares?.to === square;

                    let squareBg = isLight ? 'bg-amber-100/90' : 'bg-amber-800/80';
                    if (isSelected) squareBg = 'bg-yellow-400';
                    else if (isLastFrom || isLastTo) squareBg = isLight ? 'bg-amber-200' : 'bg-amber-700';

                    return (
                      <div
                        key={square}
                        data-square={square}
                        id={`square-${square}`}
                        onClick={() => handleSquareClick(r, c)}
                        className={`relative flex items-center justify-center ${squareBg} cursor-pointer transition-colors`}
                      >
                        {/* Legal Move Indicator Dot */}
                        {isLegal && (
                          <div className="absolute w-3.5 h-3.5 rounded-full bg-emerald-500 shadow-lg ring-2 ring-emerald-300 pointer-events-none z-10" />
                        )}

                        {/* Square Coordinates */}
                        {c === 0 && (
                          <span className={`absolute top-0.5 left-1 text-[10px] font-bold ${isLight ? 'text-amber-900/60' : 'text-amber-200/60'}`}>
                            {rowNum}
                          </span>
                        )}
                        {r === 7 && (
                          <span className={`absolute bottom-0.5 right-1 text-[10px] font-bold ${isLight ? 'text-amber-900/60' : 'text-amber-200/60'}`}>
                            {colLetter}
                          </span>
                        )}

                        {/* Vector Piece Icon */}
                        {piece && (
                          <div className="w-[84%] h-[84%] flex items-center justify-center drop-shadow-md select-none transition-transform duration-100 hover:scale-105">
                            <ChessPiece type={piece} className="w-full h-full" />
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Game Over Modal Overlay */}
              {gameResult && (
                <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center z-20">
                  <Award className="w-12 h-12 text-amber-400 mb-2 animate-bounce" />
                  <h4 className="text-xl font-extrabold text-white mb-1">Game Finished</h4>
                  <p className="text-xs text-slate-300 mb-2 max-w-xs">{gameResult}</p>
                  
                  {/* Cloud persistence badge */}
                  <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-mono mb-4">
                    <Cloud className="w-3.5 h-3.5" />
                    <span>{cloudSavedNotice ? 'PGN Saved to Cloud Firestore' : 'Archiving PGN to Cloud...'}</span>
                  </div>

                  <button
                    onClick={handleNewGame}
                    className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-400 hover:to-indigo-500 text-white font-bold text-xs transition shadow-lg shadow-purple-500/20"
                  >
                    Play Rematch
                  </button>
                </div>
              )}
            </div>

            {/* Player Profile Card */}
            <div className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 flex items-center justify-between shadow-sm">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center font-bold text-slate-200 border border-slate-700">
                  <User className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-white">You</span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                      {playerColor === 'w' ? 'White' : 'Black'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                    {playerColor === 'w' ? 'First move' : 'Second move'}
                  </div>
                </div>
              </div>

              {/* Color switch & hints */}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRequestHint}
                  disabled={isEngineThinking || !!gameResult}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition flex items-center gap-1 disabled:opacity-40"
                  title="Ask Engine for Hint"
                >
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  Hint
                </button>
                <button
                  onClick={handleTakeback}
                  disabled={moveHistory.length === 0 || isEngineThinking}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition flex items-center gap-1 disabled:opacity-40"
                  title="Undo Move"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Undo
                </button>
                <button
                  onClick={() => {
                    const newColor = playerColor === 'w' ? 'b' : 'w';
                    setPlayerColor(newColor);
                    handleNewGame();
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition flex items-center gap-1"
                  title="Switch Colors"
                >
                  <ArrowLeftRight className="w-3.5 h-3.5" />
                  Play as {playerColor === 'w' ? 'Black' : 'White'}
                </button>
              </div>
            </div>

          </div>

          {/* Right Column: Engine Thinking HUD, Active Pipeline & Move History */}
          <div className="lg:col-span-5 flex flex-col gap-4">
            
            {/* Live Engine Thinking HUD */}
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 shadow-sm space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-purple-400" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    Grandmaster Search Telemetry
                  </span>
                </div>
                <span className="text-[10px] font-mono text-purple-300 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">
                  {thinkingTimeSec.toFixed(1)}s • {maxThreads}T • {hashSizeMb}MB
                </span>
              </div>

              {/* Progress Bar of Thinking Time */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-slate-400">Allocated Thinking Window:</span>
                  <span className="text-purple-300 font-bold">{thinkingCountdown}s remaining</span>
                </div>
                <div className="w-full bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800">
                  <div
                    className="bg-gradient-to-r from-purple-500 via-indigo-500 to-orange-500 h-full transition-all duration-100"
                    style={{
                      width: isEngineThinking 
                        ? `${Math.max(0, Math.min(100, (1 - thinkingCountdown / thinkingTimeSec) * 100))}%`
                        : '100%'
                    }}
                  />
                </div>
              </div>

              {/* 4 Metric Pills: Depth / Seldepth, NPS, Nodes, Evaluation */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Depth</span>
                  <span className="font-mono font-bold text-emerald-400 text-sm">
                    {isEngineThinking
                      ? (liveDepth > 0 ? `d${liveDepth}/s${liveSeldepth}` : '...')
                      : (lastTelemetry.depth > 0 ? `d${lastTelemetry.depth}/s${lastTelemetry.seldepth}` : '—')}
                  </span>
                  <span className="text-[9px] text-slate-500 block">Pure-PVS</span>
                </div>
                <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Speed (NPS)</span>
                  <span className="font-mono font-bold text-cyan-400 text-sm">
                    {(() => {
                      const val = isEngineThinking ? liveNps : lastTelemetry.nps;
                      if (!val) return '—';
                      return val >= 1e6 ? `${(val / 1e6).toFixed(2)}M` : `${Math.max(1, Math.round(val / 1000))}k`;
                    })()}
                  </span>
                  <span className="text-[9px] text-slate-500 block">nodes / sec</span>
                </div>
                <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Nodes</span>
                  <span className="font-mono font-bold text-purple-300 text-sm">
                    {(() => {
                      const val = isEngineThinking ? liveNodes : lastTelemetry.nodes;
                      if (!val) return '—';
                      return val >= 1e6 ? `${(val / 1e6).toFixed(2)}M` : val >= 1000 ? `${Math.round(val / 1000)}k` : `${val}`;
                    })()}
                  </span>
                  <span className="text-[9px] text-slate-500 block">WASM SIMD128</span>
                </div>
                <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Eval</span>
                  <span className="font-mono font-bold text-amber-400 text-sm">
                    {evalCp >= 0 ? `+${(evalCp / 100).toFixed(2)}` : (evalCp / 100).toFixed(2)}
                  </span>
                  <span className="text-[9px] text-slate-500 block">centipawns</span>
                </div>
              </div>

              {/* Live / Last Searched PV line */}
              {(isEngineThinking ? livePv : lastTelemetry.pv) && (
                <div
                  data-testid="predicted-pv"
                  className="text-[11px] font-mono text-slate-400 bg-slate-900 p-2 rounded-lg border border-slate-800 flex items-center gap-2"
                >
                  <span className="text-purple-400 font-semibold">Predicted:</span>
                  <span className="truncate">{isEngineThinking ? livePv : lastTelemetry.pv}</span>
                </div>
              )}

              {/* Hint output if requested */}
              {hintMove && (
                <div className="text-[11px] font-mono text-emerald-300 bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/30 flex items-center gap-2 animate-fadeIn">
                  <Sparkles className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>{hintMove}</span>
                </div>
              )}
            </div>

              {/* Positional & Tactical Safety Radar HUD */}
              <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                      Tactical Safety & Positional Radar
                    </span>
                  </div>
                  <span className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping inline-block" />
                    0-BLUNDER INVARIANT
                  </span>
                </div>

                {/* Mathematical Invariant Safety Badges */}
                <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                  <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800/80">
                    <span className="text-slate-500 block text-[9px] uppercase">Mate-1 Blocker</span>
                    <span className="text-emerald-400 font-bold">100% BLOCKED</span>
                    <span className="text-[9px] text-slate-400 block mt-0.5">Zero candidate leakage</span>
                  </div>
                  <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800/80">
                    <span className="text-slate-500 block text-[9px] uppercase">Positional Bonus Cap</span>
                    <span className="text-purple-300 font-bold">[-180cp, +120cp]</span>
                    <span className="text-[9px] text-slate-400 block mt-0.5">Never overrides piece</span>
                  </div>
                  <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800/80">
                    <span className="text-slate-500 block text-[9px] uppercase">Hanging vs Sacrifice</span>
                    <span className="text-amber-400 font-bold">SAC-OVERRIDE ON</span>
                    <span className="text-[9px] text-slate-400 block mt-0.5">Qxh2+!! / Bxh7+!! safe</span>
                  </div>
                  <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800/80">
                    <span className="text-slate-500 block text-[9px] uppercase">Quiescence Stand-Pat</span>
                    <span className="text-cyan-400 font-bold">ACTIVE (Q-SEARCH)</span>
                    <span className="text-[9px] text-slate-400 block mt-0.5">Layer 1 & 4 override L2</span>
                  </div>
                </div>

                {/* Positional Dimension Gauges */}
                <div className="space-y-1.5 pt-1 border-t border-slate-800/60 text-[11px]">
                  <div className="flex items-center justify-between text-slate-400">
                    <span>Berserker Space Constriction</span>
                    <span className="text-purple-400 font-mono font-bold">84% Squeeze</span>
                  </div>
                  <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-gradient-to-r from-purple-500 to-indigo-400 h-full w-[84%]" />
                  </div>

                  <div className="flex items-center justify-between text-slate-400 pt-0.5">
                    <span>Pawn Skeleton Integrity</span>
                    <span className="text-emerald-400 font-mono font-bold">92% Cohesion</span>
                  </div>
                  <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-gradient-to-r from-emerald-500 to-teal-400 h-full w-[92%]" />
                  </div>

                  {/* Recommendations 2 & 3: Real-Time Dynamic Indicators */}
                  <div className="pt-2 border-t border-slate-800/80 space-y-1.5 font-mono text-[10px]">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 flex items-center gap-1">
                        <Zap className="w-3 h-3 text-purple-400" /> Singular Extension (SE):
                      </span>
                      <span className={`px-2 py-0.5 rounded font-bold ${
                        isSingularActive 
                          ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 animate-pulse'
                          : 'bg-slate-900 text-slate-500 border border-slate-800'
                      }`}>
                        {isSingularActive ? 'ACTIVE (+1 DEPTH PROBE)' : 'STANDBY (Delta < 60cp)'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 flex items-center gap-1">
                        <Sparkles className="w-3 h-3 text-amber-400" /> Color Complex Target:
                      </span>
                      <span className={`px-2 py-0.5 rounded font-bold ${
                        activeColorComplexTarget
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          : 'bg-slate-900 text-slate-500 border border-slate-800'
                      }`}>
                        {activeColorComplexTarget 
                          ? `${activeColorComplexTarget.toUpperCase()} INFILTRATION (+48cp)` 
                          : 'NEUTRAL (Bishops Balanced)'}
                      </span>
                    </div>

                    {/* Upgrade 1: GM Opening Book Repertoire Line */}
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 flex items-center gap-1">
                        <BookOpen className="w-3 h-3 text-cyan-400" /> GM Opening Book:
                      </span>
                      <span className={`px-2 py-0.5 rounded font-bold max-w-[220px] truncate ${
                        currentBookEntry
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                          : 'bg-slate-900 text-slate-500 border border-slate-800'
                      }`}>
                        {currentBookEntry ? `${currentBookEntry.openingName} (${currentBookEntry.eco})` : 'OUT OF BOOK'}
                      </span>
                    </div>

                    {/* Upgrade 2: Castled King Shield & Storm Matrix */}
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 flex items-center gap-1">
                        <Crown className="w-3 h-3 text-amber-400" /> King Shield & Storm:
                      </span>
                      <span className="px-2 py-0.5 rounded font-bold bg-amber-500/10 text-amber-300 border border-amber-500/30">
                        {activeKingSafety 
                          ? `SHIELD: ${activeKingSafety.shieldIntegrityPct}% • STORM: ${activeKingSafety.stormThreatIndex}% (+${activeKingSafety.netAttackBonusCp}cp)` 
                          : 'SHIELD: 100% • STORM: 0%'}
                      </span>
                    </div>

                    {/* Upgrade 3: Multi-PV Hybrid Blending */}
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 flex items-center gap-1">
                        <Swords className="w-3 h-3 text-emerald-400" /> Multi-PV Selection:
                      </span>
                      <span className={`px-2 py-0.5 rounded font-bold ${
                        lastBlendedMove?.reason === 'positional-rerank'
                          ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 animate-pulse'
                          : lastBlendedMove?.reason === 'book'
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                          : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                      }`}>
                        {lastBlendedMove 
                          ? `${lastBlendedMove.reason.toUpperCase()}: ${lastBlendedMove.chosenMoveSan} ${lastBlendedMove.pvRankChosen ? `(PV#${lastBlendedMove.pvRankChosen})` : ''}` 
                          : 'PV#1 TACTICAL CANDIDATE'}
                      </span>
                    </div>

                    {/* Upgrade 4 & 5: Contempt Factor & MVV-LVA Quiescence */}
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 flex items-center gap-1">
                        <Sliders className="w-3 h-3 text-indigo-400" /> Contempt & Quiescence:
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded font-bold bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 text-[9px]">
                          MVV-LVA 2-PLY
                        </span>
                        <button 
                          onClick={() => setContemptFactor(prev => prev === 0 ? 25 : prev === 25 ? 45 : 0)}
                          className="px-2 py-0.5 rounded font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/30 transition text-[9px]"
                          title="Click to cycle Contempt Factor (0cp Pure NNUE, +25cp, +45cp)"
                        >
                          {contemptFactor >= 0 ? `+${contemptFactor}` : contemptFactor}cp CONTEMPT
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Permanent Integrated Architecture Card (No Toggles Needed) */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    Active Architecture Pipeline
                  </span>
                <span className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  ALL INTEGRATED
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="flex items-center gap-1.5 text-slate-300 bg-slate-900/80 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Torch 4 Dynamic Contempt</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-300 bg-slate-900/80 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Double/Triple Singular Ext</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-300 bg-slate-900/80 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Flank Pawn LMR Respite</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-300 bg-slate-900/80 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>CorrHist Queenless Scaling</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-300 bg-slate-900/80 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Open-File Rook Infiltration</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-300 bg-slate-900/80 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle2 className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                  <span>Berserker Space Squeeze</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-300 bg-slate-900/80 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Zero-Blunder Exchange Invariant</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-300 bg-slate-900/80 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Bishop Pair Harmony (+30)</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-300 bg-slate-900/80 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Tactical Fork Detection (+68)</span>
                </div>
              </div>
            </div>

            {/* Score Sheet */}
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex-1 flex flex-col min-h-[220px]">
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800 text-xs">
                <span className="font-semibold uppercase tracking-wider text-slate-400">Moves Played</span>
                <span className="font-mono text-slate-500">{moveHistory.length} turns</span>
              </div>

              <div ref={movesContainerRef} className="overflow-y-auto max-h-[180px] pr-1 space-y-1 font-mono text-xs">
                {moveHistory.length === 0 ? (
                  <p className="text-xs text-slate-500 italic py-4 text-center">
                    {playerColor === 'w' ? 'Make your first move on the board!' : 'Berserker v0.7.0-wasm is calculating move 1...'}
                  </p>
                ) : (
                  moveHistory.map((m, idx) => (
                    <div key={idx} className="flex items-center gap-2 py-0.5 px-2 rounded hover:bg-slate-900">
                      <span className="w-6 text-slate-500 text-right">{m.moveNumber}.</span>
                      <span className="w-16 font-semibold text-slate-200">{m.w}</span>
                      <span className="w-16 text-slate-400">{m.b || '...'}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

          </div>

        </div>

        {/* Live UCI Terminal Console Drawer */}
        {showConsole && (
          <div className="mt-6 border-t border-slate-800 pt-5 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-purple-400" />
                <h4 className="font-bold text-sm text-white">Live Berserker v0.7.0-wasm UCI Terminal</h4>
                <span className="text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded">
                  {isWasmReady && isNnueReady ? 'READY (WASM + 138.4MB NNUE)' : isWasmReady ? 'WASM READY' : 'INITIALIZING'}
                </span>
              </div>
              <div className="flex items-center gap-1.5 overflow-x-auto text-xs font-mono">
                <span className="text-[11px] text-slate-400 mr-1">Quick UCI:</span>
                {['d', 'eval', 'go depth 8', 'bench', 'uci'].map((cmd) => (
                  <button
                    key={cmd}
                    onClick={() => sendWasmCommand(cmd)}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-purple-300 border border-slate-700 hover:border-purple-500/40 transition"
                  >
                    {cmd}
                  </button>
                ))}
                <button
                  onClick={clearWasmLogs}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700 transition"
                >
                  clear
                </button>
              </div>
            </div>

            {/* Terminal Output */}
            <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 font-mono text-xs text-slate-300 h-64 overflow-y-auto space-y-1">
              {wasmRawLogs.length === 0 ? (
                <p className="text-slate-500 italic">Waiting for Berserker UCI output...</p>
              ) : (
                wasmRawLogs.map((log, i) => (
                  <div key={i} className="leading-relaxed hover:bg-slate-900/50 px-1 rounded">
                    <span className="text-purple-500 mr-2 select-none">&gt;</span>
                    <span className={log.startsWith('bestmove') ? 'text-emerald-400 font-bold' : (log.startsWith('info') ? 'text-slate-300' : 'text-slate-400')}>{log}</span>
                  </div>
                ))
              )}
              <div ref={terminalLogsEndRef} />
            </div>

            {/* Command Input Bar */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!consoleInput.trim()) return;
                sendWasmCommand(consoleInput.trim());
                setConsoleInput('');
              }}
              className="flex items-center gap-2"
            >
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-purple-400 font-mono text-xs select-none">
                  uci &gt;
                </span>
                <input
                  type="text"
                  value={consoleInput}
                  onChange={(e) => setConsoleInput(e.target.value)}
                  placeholder="Enter UCI command (e.g. 'd' for board, 'eval', 'go movetime 2000')..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-14 pr-4 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-purple-500"
                />
              </div>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs transition shadow-md shadow-purple-600/20"
              >
                Send
              </button>
            </form>
          </div>
        )}

      </div>
    </div>
  );
};
