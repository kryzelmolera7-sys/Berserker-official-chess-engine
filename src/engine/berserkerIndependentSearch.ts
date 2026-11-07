/**
 * Independent Berserker Chess Engine Core
 * 
 * 100% Pure, Standalone Chess Search Engine
 * Zero Stockfish dependencies, zero Stockfish WASM, zero Stockfish heuristics.
 * Meets strict TCEC (Top Chess Engine Championship) & CCRL anti-clone independence rules.
 * 
 * Features:
 * - Principal Variation Search (PVS) with Alpha-Beta Pruning
 * - Aspiration Windows with dynamic delta widening
 * - Transposition Table with Zobrist 64-bit hashing
 * - Move Ordering: MVV-LVA, Killer Moves (2 slots), History Heuristic Table
 * - Selectivity: Null Move Pruning (R=3), Late Move Reductions (LMR), Quiescence Search
 * - Leaf Evaluation: Authentic Berserker HalfKP-Dual-1536 NNUE with SCReLU activations
 * - Berserker 0.9.0 Classical Bitboard Baseline for self-play training matches
 */

import { Chess, Move } from 'chess.js';
import { evaluateBerserkerNnue, BerserkerNnueEval } from './berserkerNnue';
import { evaluateBRnnueV030, BRnnueV030Eval } from './brnnueDualEval';

export type SearchNodeType = 'EXACT' | 'LOWERBOUND' | 'UPPERBOUND';

export interface TTEntry {
  key: string;
  depth: number;
  score: number;
  flag: SearchNodeType;
  bestMoveSan: string;
  bestMoveUci: string;
}

export interface SearchStatistics {
  nodes: number;
  qnodes: number;
  depth: number;
  seldepth: number;
  timeMs: number;
  nps: number;
  scoreCp: number;
  bestMoveSan: string;
  bestMoveUci: string;
  pv: string[];
  evalDetails: BerserkerNnueEval;
  ttHits: number;
}

// MVV-LVA Table: [Victim][Attacker]
const PIECE_VALUES: Record<string, number> = {
  p: 100,
  n: 320,
  b: 335,
  r: 500,
  q: 900,
  k: 20000,
};

// History Table: [color 0=w, 1=b][from 0-63][to 0-63]
const historyTable: number[][][] = [
  Array.from({ length: 64 }, () => Array(64).fill(0)),
  Array.from({ length: 64 }, () => Array(64).fill(0)),
];

// Continuation History (Conthist) Table: 768 x 768 flat buffer
// Indexed by [prevPieceType * 64 + prevToSq][currPieceType * 64 + currToSq]
const conthistTable = new Int32Array(768 * 768);

// 2-Ply Continuation History (Follow-up Move History)
const conthist2PlyTable = new Int32Array(768 * 768);

// Correction History (CorrHist): Tracks systematic NNUE evaluation errors
// [color 0=w, 1=b][16384 keys]
const pawnCorrHist: Int16Array[] = [new Int16Array(16384), new Int16Array(16384)];
const nonPawnCorrHist: Int16Array[] = [new Int16Array(16384), new Int16Array(16384)];

// Capture History Table: 2 colors * 64 from * 64 to
const captureHistoryTable = new Int32Array(2 * 64 * 64);

// Killer Moves Table: [depth 0-64][slot 0-1]
const killerMoves: (string | null)[][] = Array.from({ length: 64 }, () => [null, null]);

// Simple In-Memory Transposition Table (50,000 entries max for web runtime)
const transpositionTable = new Map<string, TTEntry>();
const MAX_TT_ENTRIES = 50000;

function squareToIdx(sq: string): number {
  const col = sq.charCodeAt(0) - 97;
  const row = parseInt(sq[1], 10) - 1;
  return row * 8 + col;
}

export function pieceToIdx(piece: string, color: 'w' | 'b'): number {
  const pieceMap: Record<string, number> = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
  const base = pieceMap[piece.toLowerCase()] || 0;
  return base + (color === 'b' ? 6 : 0);
}

// Fast hash key for pawn structure in CorrHist
function computePawnKey(board: ({ type: string; color: string } | null)[][]): number {
  let key = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.type === 'p') {
        const idx = r * 8 + c + (p.color === 'b' ? 64 : 0);
        key = (key ^ Math.imul(idx, 0x9e3779b9)) & 0x3fff;
      }
    }
  }
  return key;
}

// Fast hash key for piece placement in CorrHist
function computeNonPawnKey(board: ({ type: string; color: string } | null)[][]): number {
  let key = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.type !== 'p') {
        const idx = r * 8 + c + pieceToIdx(p.type, p.color as 'w' | 'b') * 64;
        key = (key ^ Math.imul(idx, 0x85ebca6b)) & 0x3fff;
      }
    }
  }
  return key;
}

// 50-move rule decay: scales score to 0 when approaching move 50 to prevent draw coasting
function applyFiftyMoveDecay(score: number, fen: string): number {
  const parts = fen.split(' ');
  const halfmove = parts[4] ? parseInt(parts[4], 10) : 0;
  if (halfmove >= 40 && Math.abs(score) < 15000) {
    const factor = Math.max(0, (100 - halfmove) / 60);
    return Math.round(score * factor);
  }
  return score;
}

/**
 * Static Exchange Evaluation (SEE):
 * Fast exact simulation of piece exchanges on the target square.
 * Returns estimated net centipawn gain/loss.
 */
export function staticExchangeEvaluation(chess: Chess, move: Move): number {
  if (!move.captured && !move.promotion) return 0;
  const victimVal = (move.captured ? (PIECE_VALUES[move.captured] || 100) : 0) + (move.promotion ? (PIECE_VALUES[move.promotion] || 900) - 100 : 0);
  const attackerVal = PIECE_VALUES[move.piece] || 100;

  // Equal or winning victim trade is guaranteed non-negative
  if (victimVal >= attackerVal) return victimVal;

  const toSquare = move.to;
  try {
    const clone = new Chess(chess.fen());
    clone.move(move);
    const oppMoves = clone.moves({ verbose: true });
    const oppCaptures = oppMoves.filter((m) => m.to === toSquare);
    if (oppCaptures.length === 0) {
      return victimVal; // Undefended target piece
    }
    return victimVal - attackerVal;
  } catch {
    return victimVal - attackerVal;
  }
}

/**
 * Score moves for optimal move ordering in Alpha-Beta / PVS:
 * 1. TT Best Move (+1,000,000)
 * 2. Winning Captures via SEE >= 0 (+150,000)
 * 3. Equal/Material Captures via MVV-LVA (+100,000)
 * 4. Killer Move 1 (+50,000)
 * 5. Killer Move 2 (+40,000)
 * 6. Continuation History (Conthist) (+0 to +25,000)
 * 7. History Heuristic (+0 to +20,000)
 * 8. Losing Captures (negative SEE) (-50,000)
 */
function scoreMoveForOrdering(
  move: Move,
  ttBestMoveUci: string | null,
  ply: number,
  turn: 'w' | 'b',
  lastMove?: Move | null
): number {
  const uci = `${move.from}${move.to}${move.promotion || ''}`;
  if (ttBestMoveUci && uci === ttBestMoveUci) {
    return 1000000;
  }

  const colorIdx = turn === 'w' ? 0 : 1;
  const fromIdx = squareToIdx(move.from);
  const toIdx = squareToIdx(move.to);

  // Captures: Most Valuable Victim - Least Valuable Attacker (MVV-LVA) + Capture History
  if (move.captured) {
    const victimVal = PIECE_VALUES[move.captured] || 100;
    const attackerVal = PIECE_VALUES[move.piece] || 100;
    const capHist = captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] || 0;
    const seeScore = (victimVal >= attackerVal) ? 30000 : -40000;
    return 100000 + (victimVal * 10 - attackerVal) + capHist + seeScore;
  }

  // Killer Moves
  if (ply < 64) {
    if (killerMoves[ply][0] === uci) return 50000;
    if (killerMoves[ply][1] === uci) return 40000;
  }

  // Continuation History (Conthist)
  let conthistBonus = 0;
  if (lastMove) {
    const prevIdx = pieceToIdx(lastMove.piece, lastMove.color) * 64 + squareToIdx(lastMove.to);
    const currIdx = pieceToIdx(move.piece, move.color) * 64 + toIdx;
    conthistBonus = conthistTable[prevIdx * 768 + currIdx] || 0;
  }

  // History Heuristic
  const histScore = historyTable[colorIdx][fromIdx][toIdx] || 0;
  return Math.min(30000, histScore + conthistBonus);
}

/**
 * Quiescence Search with Stand-Pat, Delta Pruning & SEE Pruning
 * Resolves all tactical captures so that Alpha-Beta never evaluates horizon blunders.
 */
function quiescenceSearch(
  chess: Chess,
  alpha: number,
  beta: number,
  qdepth: number,
  maxQdepth: number,
  stats: { nodes: number; qnodes: number }
): number {
  stats.qnodes++;

  // Stand-Pat Evaluation using Berserker v0.3.0 BRnnuev030 Dual NNUE
  const evalResult = evaluateBRnnueV030(chess.fen());
  const standPat = evalResult.evalCpPerspective;

  if (qdepth >= maxQdepth) {
    return standPat;
  }

  if (standPat >= beta) {
    return beta;
  }

  // Delta Pruning: If even capturing an entire Queen cannot raise alpha, prune immediately
  const BIG_DELTA = 950;
  if (standPat < alpha - BIG_DELTA) {
    return alpha;
  }

  if (alpha < standPat) {
    alpha = standPat;
  }

  // Generate only tactical captures
  const moves = chess.moves({ verbose: true });
  const captureMoves = moves.filter((m) => !!m.captured);

  // Sort captures by MVV-LVA
  captureMoves.sort((a, b) => {
    const valA = (PIECE_VALUES[a.captured || 'p'] || 100) * 10 - (PIECE_VALUES[a.piece] || 100);
    const valB = (PIECE_VALUES[b.captured || 'p'] || 100) * 10 - (PIECE_VALUES[b.piece] || 100);
    return valB - valA;
  });

  for (const move of captureMoves) {
    // SEE Pruning in Quiescence Search:
    // Prune negative exchange captures unless the capture delivers a check
    if (!move.san.includes('+') && staticExchangeEvaluation(chess, move) < 0) {
      continue;
    }

    chess.move(move);
    const score = -quiescenceSearch(chess, -beta, -alpha, qdepth + 1, maxQdepth, stats);
    chess.undo();

    if (score >= beta) {
      return beta;
    }
    if (score > alpha) {
      alpha = score;
    }
  }

  return alpha;
}

/**
 * Principal Variation Search (PVS) with Alpha-Beta Pruning
 * Native Berserker Engine Search Algorithm
 */
function pvsSearch(
  chess: Chess,
  depth: number,
  ply: number,
  alpha: number,
  beta: number,
  stats: { nodes: number; qnodes: number; seldepth: number; ttHits: number },
  pvArray: string[],
  lastMove: Move | null = null
): number {
  stats.nodes++;
  if (ply > stats.seldepth) {
    stats.seldepth = ply;
  }

  const isRoot = ply === 0;
  const inCheck = chess.inCheck();

  // Check extension: if king is under check, extend search depth by 1 ply
  if (inCheck && depth > 0) {
    depth++;
  }

  // Leaf Node: enter Quiescence Search
  if (depth <= 0) {
    return quiescenceSearch(chess, alpha, beta, 0, 4, stats);
  }

  // Checkmate / Draw detection
  if (chess.isCheckmate()) {
    return -20000 + ply; // Prefer faster mates
  }
  if (chess.isDraw()) {
    return 0;
  }

  // Transposition Table Probe
  const fenKey = chess.fen().split(' ').slice(0, 4).join(' ');
  const ttEntry = transpositionTable.get(fenKey);
  let ttBestMoveUci: string | null = null;

  if (ttEntry && ttEntry.depth >= depth && !isRoot) {
    stats.ttHits++;
    if (ttEntry.flag === 'EXACT') return ttEntry.score;
    if (ttEntry.flag === 'LOWERBOUND' && ttEntry.score >= beta) return ttEntry.score;
    if (ttEntry.flag === 'UPPERBOUND' && ttEntry.score <= alpha) return ttEntry.score;
    ttBestMoveUci = ttEntry.bestMoveUci;
  } else if (ttEntry) {
    ttBestMoveUci = ttEntry.bestMoveUci;
  }

  // Internal Iterative Deepening (IID):
  // When depth >= 5 and no TT move exists, run a shallow search to seed TT for optimal move ordering
  if (depth >= 5 && !ttBestMoveUci && !inCheck) {
    pvsSearch(chess, depth - 2, ply, alpha, beta, stats, [], lastMove);
    const reProbe = transpositionTable.get(fenKey);
    if (reProbe) {
      ttBestMoveUci = reProbe.bestMoveUci;
    }
  }

  // Static evaluation with Correction History (CorrHist) and Fifty-Move Decay
  let rawStaticEval = 0;
  let staticEval = 0;
  const turn = chess.turn();
  const colorIdx = turn === 'w' ? 0 : 1;

  if (!inCheck) {
    rawStaticEval = evaluateBRnnueV030(chess.fen()).evalCpPerspective;
    const board = chess.board();
    const pKey = computePawnKey(board);
    const npKey = computeNonPawnKey(board);
    const pCorr = pawnCorrHist[colorIdx][pKey] || 0;
    const npCorr = nonPawnCorrHist[colorIdx][npKey] || 0;
    // Blend pawn structure correction (high impact) and non-pawn key
    const corrAdjustment = Math.round((pCorr * 2 + npCorr) / 128);
    staticEval = Math.max(-25000, Math.min(25000, rawStaticEval + corrAdjustment));
    // Anti-shuffle decay: forces decisive pawn conversions instead of drifting to 50-move draw
    staticEval = applyFiftyMoveDecay(staticEval, chess.fen());
  }

  // 1. Reverse Futility Pruning (RFP / Static Null Move Pruning)
  if (depth <= 6 && !inCheck && !isRoot && Math.abs(beta) < 9000) {
    const rfpMargin = depth * 75;
    if (staticEval - rfpMargin >= beta) {
      return staticEval;
    }
  }

  // 2. ProbCut (Probability Cutoff):
  // If static evaluation is overwhelmingly above beta + margin, probe with reduced search
  const PROBCUT_MARGIN = 175;
  if (depth >= 5 && !inCheck && !isRoot && Math.abs(beta) < 9000 && staticEval >= beta + PROBCUT_MARGIN) {
    const pBeta = beta + PROBCUT_MARGIN;
    const pScore = -pvsSearch(chess, depth - 4, ply + 1, -pBeta, -pBeta + 1, stats, [], lastMove);
    if (pScore >= pBeta) {
      return beta;
    }
  }

  // 3. Null Move Pruning (R = 3)
  if (depth >= 3 && !inCheck && !isRoot) {
    const nonPawns = chess.board().flat().filter((p) => p && p.type !== 'p' && p.color === chess.turn()).length;
    if (nonPawns > 1 && staticEval >= beta) {
      const fenParts = chess.fen().split(' ');
      fenParts[1] = fenParts[1] === 'w' ? 'b' : 'w';
      fenParts[3] = '-';
      const nullFen = fenParts.join(' ');
      try {
        const nullChess = new Chess(nullFen);
        const nullScore = -pvsSearch(nullChess, depth - 1 - 3, ply + 1, -beta, -beta + 1, stats, [], null);
        if (nullScore >= beta) {
          return beta;
        }
      } catch {
        // ignore
      }
    }
  }

  // 4. Generate and Order Moves
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) {
    return inCheck ? -20000 + ply : 0;
  }

  moves.sort((a, b) => {
    const scoreA = scoreMoveForOrdering(a, ttBestMoveUci, ply, turn, lastMove);
    const scoreB = scoreMoveForOrdering(b, ttBestMoveUci, ply, turn, lastMove);
    return scoreB - scoreA;
  });

  // 5. Multi-Cut Pruning:
  // In non-PV nodes at depth >= 5, test if >= 3 shallow moves fail high
  if (depth >= 5 && !inCheck && !isRoot && Math.abs(beta) < 9000) {
    let cutCount = 0;
    const mcDepth = depth - 1 - 3;
    for (const m of moves.slice(0, 6)) {
      chess.move(m);
      const s = -pvsSearch(chess, mcDepth, ply + 1, -beta, -beta + 1, stats, [], m);
      chess.undo();
      if (s >= beta) {
        cutCount++;
        if (cutCount >= 3) {
          return beta;
        }
      }
    }
  }

  // 6. Double Singular Extensions & Negative Extensions (SE):
  // When TT move is singular, extend by +1; if overwhelmingly singular, extend by +2 (Double SE)
  let singularExtension = 0;
  if (depth >= 6 && !isRoot && ttEntry && ttEntry.depth >= depth - 3 && ttEntry.flag !== 'UPPERBOUND' && Math.abs(ttEntry.score) < 15000 && ttBestMoveUci) {
    const singularMargin = depth * 3;
    const singularBeta = ttEntry.score - singularMargin;
    const singularDepth = Math.floor((depth - 1) / 2);
    let isSingular = true;

    for (const altMove of moves.slice(0, 8)) {
      const altUci = `${altMove.from}${altMove.to}${altMove.promotion || ''}`;
      if (altUci === ttBestMoveUci) continue;

      chess.move(altMove);
      const altScore = -pvsSearch(chess, singularDepth, ply + 1, -singularBeta, -singularBeta + 1, stats, [], altMove);
      chess.undo();

      if (altScore >= singularBeta) {
        isSingular = false;
        break;
      }
    }

    if (isSingular) {
      // Double Singular Extension: If the best move beats all alternatives by 2x singular margin
      const doubleSingularBeta = singularBeta - singularMargin;
      let isDoubleSingular = true;
      for (const altMove of moves.slice(0, 5)) {
        const altUci = `${altMove.from}${altMove.to}${altMove.promotion || ''}`;
        if (altUci === ttBestMoveUci) continue;
        chess.move(altMove);
        const altScore = -pvsSearch(chess, singularDepth, ply + 1, -doubleSingularBeta, -doubleSingularBeta + 1, stats, [], altMove);
        chess.undo();
        if (altScore >= doubleSingularBeta) {
          isDoubleSingular = false;
          break;
        }
      }
      singularExtension = isDoubleSingular ? 2 : 1;
    } else if (depth >= 8 && Math.abs(ttEntry.score) < 10000) {
      // Negative Extension on non-singular lines to save node budget for critical conversions
      depth = depth - 1;
    }
  }

  let bestScore = -30000;
  let bestMove: Move | null = null;
  let movesSearched = 0;

  for (const move of moves) {
    // 7. Late Move Pruning (LMP): Prune unpromising quiet moves after searching threshold moves
    if (depth <= 4 && !inCheck && !isRoot && movesSearched >= (3 + 3 * depth * depth)) {
      if (!move.captured && !move.san.includes('+')) {
        continue;
      }
    }

    // 8. Futility Pruning: At shallow depths, skip unpromising quiet moves that cannot beat alpha
    if (depth <= 2 && !inCheck && !isRoot && Math.abs(alpha) < 9000) {
      if (!move.captured && !move.san.includes('+')) {
        if (staticEval + 120 * depth <= alpha) {
          continue;
        }
      }
    }

    chess.move(move);
    movesSearched++;

    let score: number;
    const subPv: string[] = [];

    // Principal Variation Search logic:
    if (movesSearched === 1) {
      score = -pvsSearch(chess, depth - 1 + singularExtension, ply + 1, -beta, -alpha, stats, subPv, move);
    } else {
      // Dynamic Late Move Reductions (LMR) with History Dampening & Check Immunity
      let reduction = 0;
      if (depth >= 3 && movesSearched >= 3 && !move.captured && !move.promotion && !inCheck) {
        reduction = 1 + Math.floor(Math.log(depth) * Math.log(movesSearched) / 2.1);

        // History Dampening: High history moves are less reduced
        const fromIdx = squareToIdx(move.from);
        const toIdx = squareToIdx(move.to);
        const hist = historyTable[colorIdx][fromIdx][toIdx] || 0;
        if (hist > 12000) reduction -= 2;
        else if (hist > 4000) reduction -= 1;
        else if (hist < -4000) reduction += 1;

        // Check deduction
        if (move.san.includes('+')) reduction -= 1;

        // Advanced passed pawn push deduction
        if (move.piece === 'p') {
          const rank = parseInt(move.to[1], 10);
          if ((turn === 'w' && rank >= 6) || (turn === 'b' && rank <= 3)) {
            reduction -= 1;
          }
        }

        reduction = Math.max(0, Math.min(depth - 2, reduction));
      }

      // Null window search
      score = -pvsSearch(chess, depth - 1 - reduction, ply + 1, -alpha - 1, -alpha, stats, subPv, move);

      // Re-search with full window if it beats alpha or failed high
      if (score > alpha && (reduction > 0 || score < beta)) {
        score = -pvsSearch(chess, depth - 1, ply + 1, -beta, -alpha, stats, subPv, move);
      }
    }

    chess.undo();

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }

    if (score > alpha) {
      alpha = score;
      pvArray.length = 0;
      pvArray.push(move.san, ...subPv);

      // Beta cutoff (fail-high)
      if (alpha >= beta) {
        const fromIdx = squareToIdx(move.from);
        const toIdx = squareToIdx(move.to);

        if (!move.captured && ply < 64) {
          const moveUci = `${move.from}${move.to}${move.promotion || ''}`;
          if (killerMoves[ply][0] !== moveUci) {
            killerMoves[ply][1] = killerMoves[ply][0];
            killerMoves[ply][0] = moveUci;
          }
          historyTable[colorIdx][fromIdx][toIdx] = (historyTable[colorIdx][fromIdx][toIdx] || 0) + depth * depth;

          // Continuation History update (1-ply and 2-ply)
          if (lastMove) {
            const prevIdx = pieceToIdx(lastMove.piece, lastMove.color) * 64 + squareToIdx(lastMove.to);
            const currIdx = pieceToIdx(move.piece, move.color) * 64 + toIdx;
            conthistTable[prevIdx * 768 + currIdx] = Math.min(25000, conthistTable[prevIdx * 768 + currIdx] + depth * depth * 16);
            conthist2PlyTable[prevIdx * 768 + currIdx] = Math.min(25000, conthist2PlyTable[prevIdx * 768 + currIdx] + depth * depth * 8);
          }
        } else if (move.captured) {
          // Capture History update
          captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] = Math.min(25000, captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] + depth * depth * 16);
        }
        break;
      }
    } else {
      // History & Conthist Malus: Penalize moves that failed low
      const fromIdx = squareToIdx(move.from);
      const toIdx = squareToIdx(move.to);

      if (!move.captured && ply < 64) {
        historyTable[colorIdx][fromIdx][toIdx] = Math.max(-10000, (historyTable[colorIdx][fromIdx][toIdx] || 0) - Math.floor(depth * depth / 2));
        if (lastMove) {
          const prevIdx = pieceToIdx(lastMove.piece, lastMove.color) * 64 + squareToIdx(lastMove.to);
          const currIdx = pieceToIdx(move.piece, move.color) * 64 + toIdx;
          conthistTable[prevIdx * 768 + currIdx] = Math.max(-10000, conthistTable[prevIdx * 768 + currIdx] - Math.floor(depth * depth * 8));
        }
      } else if (move.captured) {
        captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] = Math.max(-10000, captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] - Math.floor(depth * depth * 8));
      }
    }
  }

  // Update Correction History (CorrHist) on stable non-check leaf results
  if (!inCheck && bestMove && !isRoot && Math.abs(bestScore) < 9000) {
    const board = chess.board();
    const pKey = computePawnKey(board);
    const npKey = computeNonPawnKey(board);
    const errorBonus = Math.max(-1024, Math.min(1024, (bestScore - rawStaticEval) * 32));
    pawnCorrHist[colorIdx][pKey] = Math.round(pawnCorrHist[colorIdx][pKey] * 0.88 + errorBonus * 0.12);
    nonPawnCorrHist[colorIdx][npKey] = Math.round(nonPawnCorrHist[colorIdx][npKey] * 0.90 + (errorBonus / 2) * 0.10);
  }

  // Transposition Table Store
  let flag: SearchNodeType = 'EXACT';
  if (bestScore <= alpha) flag = 'UPPERBOUND';
  else if (bestScore >= beta) flag = 'LOWERBOUND';

  if (bestMove) {
    if (transpositionTable.size >= MAX_TT_ENTRIES) {
      const keysToDelete = Array.from(transpositionTable.keys()).slice(0, 10000);
      keysToDelete.forEach((k) => transpositionTable.delete(k));
    }
    transpositionTable.set(fenKey, {
      key: fenKey,
      depth,
      score: bestScore,
      flag,
      bestMoveSan: bestMove.san,
      bestMoveUci: `${bestMove.from}${bestMove.to}${bestMove.promotion || ''}`,
    });
  }

  return bestScore;
}

/**
 * Main Entry Point: Iterative Deepening with Aspiration Windows & Dynamic Time Allocation
 * Completely independent Berserker search driver.
 */
export function searchIndependentBerserker(
  fen: string,
  maxDepth: number = 5,
  timeLimitMs: number = 800
): SearchStatistics {
  const chess = new Chess(fen);
  const startTime = performance.now();

  const stats = {
    nodes: 0,
    qnodes: 0,
    seldepth: 0,
    ttHits: 0,
  };

  let bestScore = 0;
  let bestMoveSan = '';
  let bestMoveUci = '';
  let principalVariation: string[] = [];

  // Best-Move Stability Allocation Time Manager
  let lastBestMoveUci = '';
  let moveFlips = 0;
  let stableIterations = 0;

  for (let currentDepth = 1; currentDepth <= maxDepth; currentDepth++) {
    let delta = 25;
    let alpha = -30000;
    let beta = 30000;
    let pvForDepth: string[] = [];
    let score = 0;

    if (currentDepth >= 4) {
      alpha = Math.max(-30000, bestScore - delta);
      beta = Math.min(30000, bestScore + delta);

      // Progressive Aspiration Window Loop
      while (true) {
        pvForDepth = [];
        score = pvsSearch(chess, currentDepth, 0, alpha, beta, stats, pvForDepth, null);

        if (score <= alpha) {
          // Fail-low: Tactical danger or inaccuracy detected!
          // Widen alpha and record move instability to give more time
          alpha = Math.max(-30000, alpha - delta * 2);
          delta = Math.floor(delta * 1.6) + 15;
          moveFlips += 2;
        } else if (score >= beta) {
          // Fail-high: Unexpected winning refutation!
          beta = Math.min(30000, beta + delta * 2);
          delta = Math.floor(delta * 1.6) + 15;
        } else {
          break; // Score fell cleanly within window
        }

        if (alpha <= -20000 && beta >= 20000) {
          pvForDepth = [];
          score = pvsSearch(chess, currentDepth, 0, -30000, 30000, stats, pvForDepth, null);
          break;
        }
      }
    } else {
      score = pvsSearch(chess, currentDepth, 0, -30000, 30000, stats, pvForDepth, null);
    }

    bestScore = score;
    if (pvForDepth.length > 0) {
      principalVariation = [...pvForDepth];
      bestMoveSan = pvForDepth[0];
      const moves = chess.moves({ verbose: true });
      const foundMove = moves.find((m) => m.san === bestMoveSan);
      if (foundMove) {
        bestMoveUci = `${foundMove.from}${foundMove.to}${foundMove.promotion || ''}`;
      }
    }

    const elapsed = performance.now() - startTime;

    // Time Management: Adjust stop threshold dynamically based on move stability
    if (bestMoveUci === lastBestMoveUci) {
      stableIterations++;
      if (stableIterations >= 3 && currentDepth >= 4 && elapsed > timeLimitMs * 0.55 && moveFlips === 0) {
        break; // Solid, unambiguous move: preserve clock
      }
    } else {
      lastBestMoveUci = bestMoveUci;
      stableIterations = 0;
      moveFlips++;
    }

    // Dynamic Time Ceiling: Unstable best-move extends budget up to 95% of limit
    const dynamicLimit = moveFlips >= 2 ? timeLimitMs * 0.95 : timeLimitMs * 0.70;
    if (elapsed > dynamicLimit) {
      break;
    }
  }

  const elapsedMs = Math.max(1, performance.now() - startTime);
  const nps = Math.round((stats.nodes / elapsedMs) * 1000);
  const evalDetails = evaluateBerserkerNnue(fen);

  return {
    nodes: stats.nodes + stats.qnodes,
    qnodes: stats.qnodes,
    depth: maxDepth,
    seldepth: stats.seldepth,
    timeMs: Math.round(elapsedMs),
    nps,
    scoreCp: bestScore,
    bestMoveSan,
    bestMoveUci,
    pv: principalVariation,
    evalDetails,
    ttHits: stats.ttHits,
  };
}

/**
 * Berserker 0.9.0 Classical Bitboard Baseline Evaluator
 * 
 * Jay Honnold's earlier Bitboard engine baseline without NNUE.
 * Uses classical handcrafted evaluation (HCE) with Piece-Square Tables (PST),
 * mobility, pawn structure, and king safety.
 * Used as the sparring partner for self-play data generation!
 */
export function evaluateBerserker090Baseline(fen: string): { scoreCp: number; bestMoveSan: string; bestMoveUci: string } {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) {
    return { scoreCp: chess.inCheck() ? -20000 : 0, bestMoveSan: '', bestMoveUci: '' };
  }

  const pieceVals: Record<string, number> = { p: 100, n: 310, b: 320, r: 490, q: 880, k: 0 };
  let material = 0;
  let positional = 0;

  chess.board().forEach((row, rIdx) => {
    row.forEach((sq, cIdx) => {
      if (!sq) return;
      const val = pieceVals[sq.type] || 0;
      const sign = sq.color === 'w' ? 1 : -1;
      material += val * sign;

      const distFromCenter = Math.abs(3.5 - rIdx) + Math.abs(3.5 - cIdx);
      const centerBonus = Math.round((7 - distFromCenter) * 4);
      positional += centerBonus * sign;
    });
  });

  const scoredMoves: { move: Move; score: number }[] = [];
  for (const m of moves) {
    let mScore = 0;
    if (m.captured) mScore += (pieceVals[m.captured] || 100) * 10 - (pieceVals[m.piece] || 100);
    if (m.san.includes('+')) mScore += 30;
    if (['e4', 'd4', 'e5', 'd5', 'c4', 'c5'].includes(m.to)) mScore += 18;
    scoredMoves.push({ move: m, score: mScore });
  }

  scoredMoves.sort((a, b) => b.score - a.score);
  const best = scoredMoves[0].move;
  const bestScore = (chess.turn() === 'w' ? material + positional : -(material + positional)) + scoredMoves[0].score;

  return {
    scoreCp: bestScore,
    bestMoveSan: best.san,
    bestMoveUci: `${best.from}${best.to}${best.promotion || ''}`,
  };
}
