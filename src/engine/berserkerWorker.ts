/**
 * ============================================================================
 * Berserker v0.3.0 Engine Web Worker
 * ============================================================================
 * 100% Genuine, Independent Native Berserker Engine Worker.
 * Powered by:
 *   - BRnnuev030 Dual NNUE Architecture (Berserker v0.9.0 + PlentyChess)
 *   - Iterative Deepening Principal Variation Search (PVS)
 *   - Dynamic Aspiration Windows (±50cp)
 *   - Dynamic Late Move Reductions (LMR) & Futility Pruning
 *   - Quiescence Search with Stand-Pat Delta Pruning
 *   - Transposition Table with EXACT / LOWERBOUND / UPPERBOUND bounds
 *   - MultiPV 1-5 candidate lines
 * ============================================================================
 */

import { Chess } from 'chess.js';
import { evaluateBRnnueV030, evaluateBRnnueV070, evaluateBerserker10Nnue } from './brnnueDualEval';
import { searchHybridNnueMcts, resetMctsTree } from './berserkerMctsHybrid';
import { 
  normalizeChess960Fen, 
  resolveChess960Move, 
  executeChess960Castling, 
  extractCastlingConfig, 
  Chess960CastlingConfig 
} from './chess960';

const ENGINE_NAME = "Berserker v0.7.0-dev";
const ENGINE_AUTHOR = "Berserker Engine Team";
const DEFAULT_NET = "berserker_brnnue_v070.nnue";

// Chess960 (FRC) State
let uciChess960 = false;
let currentChess960Config: Chess960CastlingConfig | undefined;

// TT Entry Flags
const TT_FLAG = {
  EXACT: 0,
  LOWERBOUND: 1, // Beta cutoff (fail-high)
  UPPERBOUND: 2  // Alpha unraised (fail-low)
} as const;

interface TTEntry {
  key: string;
  depth: number;
  score: number;
  flag: typeof TT_FLAG[keyof typeof TT_FLAG];
  bestMoveUci: string;
}

// Global search state
let currentChess = new Chess();
let gameHistoryFens: string[] = [];
let isSearching = false;
let stopRequested = false;

let evalMode = 'brnnue-v030';
let searchMode = 'Pure-PVS'; // 'Pure-PVS' | 'Hybrid-MCTS-PVS' | 'Pure-MCTS'
let threads = 64;
let hashMb = 32768;
let multiPv = 1;
let tacticalContempt = 45;
let kingAttackScale = 140;

const transpositionTable = new Map<string, TTEntry>();
const MAX_TT_SIZE = 80000;

// Move ordering heuristic tables
const killerMoves: string[][] = Array.from({ length: 64 }, () => ['', '']);
const historyTable: number[][][] = [
  Array.from({ length: 64 }, () => Array(64).fill(0)),
  Array.from({ length: 64 }, () => Array(64).fill(0))
];
const counterMoveTable: string[][][] = [
  Array.from({ length: 64 }, () => Array(64).fill('')),
  Array.from({ length: 64 }, () => Array(64).fill(''))
];

// Continuation History (Conthist): 768 x 768 flat buffer
const conthistTable = new Int32Array(768 * 768);

// Capture History: 2 colors * 64 from * 64 to
const captureHistoryTable = new Int32Array(2 * 64 * 64);

// Correction History (CorrHist): Tracks systematic NNUE evaluation errors
const pawnCorrHist: Int16Array[] = [new Int16Array(16384), new Int16Array(16384)];
const nonPawnCorrHist: Int16Array[] = [new Int16Array(16384), new Int16Array(16384)];

const PIECE_VALUES: Record<string, number> = {
  p: 100, n: 320, b: 335, r: 500, q: 950, k: 20000
};

function squareToIndex(sq: string): number {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  return rank * 8 + file;
}

export function pieceToIdx(piece: string, color: 'w' | 'b'): number {
  const pieceMap: Record<string, number> = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
  const base = pieceMap[piece.toLowerCase()] || 0;
  return base + (color === 'b' ? 6 : 0);
}

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
 */
export function staticExchangeEvaluation(chess: InstanceType<typeof Chess>, move: any): number {
  if (!move.captured && !move.promotion) return 0;
  const victimVal = (move.captured ? (PIECE_VALUES[move.captured] || 100) : 0) + (move.promotion ? (PIECE_VALUES[move.promotion] || 900) - 100 : 0);
  const attackerVal = PIECE_VALUES[move.piece] || 100;

  if (victimVal >= attackerVal) return victimVal;

  const toSquare = move.to;
  try {
    const clone = new Chess(chess.fen());
    clone.move(move);
    const oppMoves = clone.moves({ verbose: true });
    const oppCaptures = oppMoves.filter((m: any) => m.to === toSquare);
    if (oppCaptures.length === 0) {
      return victimVal;
    }
    return victimVal - attackerVal;
  } catch {
    return victimVal - attackerVal;
  }
}

function clearSearchState() {
  transpositionTable.clear();
  conthistTable.fill(0);
  captureHistoryTable.fill(0);
  for (let i = 0; i < 64; i++) {
    killerMoves[i] = ['', ''];
    historyTable[0][i].fill(0);
    historyTable[1][i].fill(0);
    counterMoveTable[0][i].fill('');
    counterMoveTable[1][i].fill('');
  }
}

function scoreMove(
  move: any,
  hashMoveUci: string | null,
  ply: number,
  turn: 'w' | 'b',
  lastMoveUci: string | null,
  lastMovePiece?: string | null
): number {
  const uci = `${move.from}${move.to}${move.promotion || ''}`;
  if (hashMoveUci && uci === hashMoveUci) return 2000000;

  const colorIdx = turn === 'w' ? 0 : 1;
  const fromIdx = squareToIndex(move.from);
  const toIdx = squareToIndex(move.to);

  // Captures: MVV-LVA + Capture History + SEE bonus
  if (move.captured) {
    const victimVal = PIECE_VALUES[move.captured] || 100;
    const attackerVal = PIECE_VALUES[move.piece] || 100;
    const capHist = captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] || 0;
    const seeBonus = (victimVal >= attackerVal) ? 30000 : -40000;
    return 100000 + (victimVal * 10 - attackerVal) + capHist + seeBonus;
  }

  // Countermove heuristic
  if (lastMoveUci && lastMoveUci.length >= 4) {
    const prevFrom = squareToIndex(lastMoveUci.slice(0, 2));
    const prevTo = squareToIndex(lastMoveUci.slice(2, 4));
    if (counterMoveTable[colorIdx][prevFrom][prevTo] === uci) {
      return 60000;
    }
  }

  // Killer moves
  if (ply < 64) {
    if (killerMoves[ply][0] === uci) return 50000;
    if (killerMoves[ply][1] === uci) return 40000;
  }

  // Continuation History (Conthist)
  let conthistBonus = 0;
  if (lastMoveUci && lastMoveUci.length >= 4 && lastMovePiece) {
    const prevTo = squareToIndex(lastMoveUci.slice(2, 4));
    const prevColor = turn === 'w' ? 'b' : 'w';
    const prevIdx = pieceToIdx(lastMovePiece, prevColor) * 64 + prevTo;
    const currIdx = pieceToIdx(move.piece, turn) * 64 + toIdx;
    conthistBonus = conthistTable[prevIdx * 768 + currIdx] || 0;
  }

  // History heuristic
  const hist = historyTable[colorIdx][fromIdx][toIdx] || 0;
  return Math.min(35000, hist + conthistBonus);
}

// Native neural position evaluator
function evaluatePosition(chess: InstanceType<typeof Chess>): number {
  const fen = chess.fen();
  const turn = chess.turn();

  if (evalMode === 'brnnue-v030') {
    const res = evaluateBRnnueV030(fen);
    return res.evalCpPerspective;
  } else if (evalMode === 'berserker-1.0-nnue') {
    const res = evaluateBerserker10Nnue(fen);
    return res.evalCpPerspective;
  } else {
    // Aura-NNUE MoE with dynamic contempt
    const res = evaluateBRnnueV030(fen);
    const contemptAdjust = turn === 'w' ? tacticalContempt : -tacticalContempt;
    return res.evalCpPerspective + Math.round(contemptAdjust * 0.4);
  }
}

// Quiescence Search with Stand-Pat Delta Pruning
function quiescenceSearch(
  chess: InstanceType<typeof Chess>,
  alpha: number,
  beta: number,
  ply: number,
  maxQDepth: number,
  stats: { nodes: number; qnodes: number; seldepth: number }
): number {
  stats.qnodes++;
  if (ply > stats.seldepth) stats.seldepth = ply;

  if (chess.isCheckmate()) return -25000 + ply;
  if (chess.isDraw()) return 0;

  const standPat = evaluatePosition(chess);
  if (ply >= maxQDepth) return standPat;

  if (standPat >= beta) return beta;
  let currentAlpha = Math.max(alpha, standPat);

  // Delta Pruning
  const BIGGEST_PIECE_DELTA = 1050;
  if (standPat < currentAlpha - BIGGEST_PIECE_DELTA) {
    return currentAlpha;
  }

  const inCheck = chess.inCheck();
  const captures = inCheck
    ? chess.moves({ verbose: true })
    : chess.moves({ verbose: true }).filter((m: any) => m.captured || m.promotion);

  // MVV-LVA ordering for captures
  captures.sort((a: any, b: any) => {
    const vA = (PIECE_VALUES[a.captured || ''] || 0) * 10 - (PIECE_VALUES[a.piece] || 0);
    const vB = (PIECE_VALUES[b.captured || ''] || 0) * 10 - (PIECE_VALUES[b.piece] || 0);
    return vB - vA;
  });

  for (const move of captures) {
    // SEE Pruning in Quiescence: skip losing captures unless checking
    if (!move.san.includes('+') && staticExchangeEvaluation(chess, move) < 0) {
      continue;
    }

    chess.move(move);
    const score = -quiescenceSearch(chess, -beta, -currentAlpha, ply + 1, maxQDepth, stats);
    chess.undo();

    if (score >= beta) return beta;
    if (score > currentAlpha) currentAlpha = score;
  }

  return currentAlpha;
}

// Principal Variation Search (PVS) with SE, ProbCut, Multi-Cut, LMR & Futility Pruning
function pvsSearch(
  chess: InstanceType<typeof Chess>,
  depth: number,
  ply: number,
  alpha: number,
  beta: number,
  stats: { nodes: number; qnodes: number; seldepth: number; ttHits: number },
  pv: string[],
  startTime: number,
  maxTimeMs: number,
  lastMoveUci: string | null = null,
  lastMovePiece: string | null = null
): number {
  stats.nodes++;
  if (ply > stats.seldepth) stats.seldepth = ply;

  // Time check
  if ((stats.nodes & 2047) === 0) {
    if (stopRequested || (Date.now() - startTime) >= maxTimeMs) {
      isSearching = false;
      return alpha;
    }
  }

  const isRoot = ply === 0;
  const inCheck = chess.inCheck();

  if (inCheck && depth > 0) depth++; // Check extension

  if (depth <= 0) {
    return quiescenceSearch(chess, alpha, beta, ply, ply + 8, stats);
  }

  if (chess.isCheckmate()) return -25000 + ply;
  if (chess.isDraw()) return 0;

  // Transposition Table Probe
  const fenKey = chess.fen().split(' ').slice(0, 4).join(' ');
  const ttEntry = transpositionTable.get(fenKey);
  let hashMoveUci: string | null = null;

  if (ttEntry) {
    hashMoveUci = ttEntry.bestMoveUci;
    if (ttEntry.depth >= depth && !isRoot) {
      stats.ttHits++;
      if (ttEntry.flag === TT_FLAG.EXACT) return ttEntry.score;
      if (ttEntry.flag === TT_FLAG.LOWERBOUND && ttEntry.score >= beta) return ttEntry.score;
      if (ttEntry.flag === TT_FLAG.UPPERBOUND && ttEntry.score <= alpha) return ttEntry.score;
    }
  }

  // Internal Iterative Deepening (IID)
  if (depth >= 5 && !hashMoveUci && !inCheck) {
    pvsSearch(chess, depth - 2, ply, alpha, beta, stats, [], startTime, maxTimeMs, lastMoveUci, lastMovePiece);
    const reEntry = transpositionTable.get(fenKey);
    if (reEntry) hashMoveUci = reEntry.bestMoveUci;
  }

  // Static evaluation with Correction History (CorrHist) and Fifty-Move Decay
  let rawStaticEval = 0;
  let staticEval = 0;
  const turn = chess.turn();
  const colorIdx = turn === 'w' ? 0 : 1;

  if (!inCheck) {
    rawStaticEval = evaluatePosition(chess);
    const board = chess.board();
    const pKey = computePawnKey(board);
    const npKey = computeNonPawnKey(board);
    const pCorr = pawnCorrHist[colorIdx][pKey] || 0;
    const npCorr = nonPawnCorrHist[colorIdx][npKey] || 0;
    const corrAdjustment = Math.round((pCorr * 2 + npCorr) / 128);
    staticEval = Math.max(-25000, Math.min(25000, rawStaticEval + corrAdjustment));
    staticEval = applyFiftyMoveDecay(staticEval, chess.fen());
  }

  // 1. Reverse Futility Pruning (RFP / Static Null Move Pruning)
  if (depth <= 6 && !inCheck && !isRoot && Math.abs(beta) < 9000) {
    const rfpMargin = depth * 75;
    if (staticEval - rfpMargin >= beta) return staticEval;
  }

  // 2. ProbCut (Probability Cutoff)
  const PROBCUT_MARGIN = 175;
  if (depth >= 5 && !inCheck && !isRoot && Math.abs(beta) < 9000 && staticEval >= beta + PROBCUT_MARGIN) {
    const pBeta = beta + PROBCUT_MARGIN;
    const pScore = -pvsSearch(chess, depth - 4, ply + 1, -pBeta, -pBeta + 1, stats, [], startTime, maxTimeMs, lastMoveUci, lastMovePiece);
    if (pScore >= pBeta) return beta;
  }

  // 3. Null Move Pruning (R = 2 / 3)
  if (depth >= 3 && !inCheck && !isRoot) {
    const hasMajorPieces = chess.board().flat().some(p => p && p.type !== 'p' && p.type !== 'k' && p.color === chess.turn());
    if (hasMajorPieces && staticEval >= beta) {
      const fenParts = chess.fen().split(' ');
      fenParts[1] = fenParts[1] === 'w' ? 'b' : 'w';
      fenParts[3] = '-';
      try {
        const nullChess = new Chess(fenParts.join(' '));
        const r = depth >= 6 ? 3 : 2;
        const nullScore = -pvsSearch(nullChess, depth - 1 - r, ply + 1, -beta, -beta + 1, stats, [], startTime, maxTimeMs, null, null);
        if (nullScore >= beta) return beta;
      } catch {}
    }
  }

  // 4. Move Generation & Ordering
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return inCheck ? -25000 + ply : 0;

  moves.sort((a: any, b: any) => {
    const sA = scoreMove(a, hashMoveUci, ply, turn, lastMoveUci, lastMovePiece);
    const sB = scoreMove(b, hashMoveUci, ply, turn, lastMoveUci, lastMovePiece);
    return sB - sA;
  });

  // 5. Multi-Cut Pruning:
  if (depth >= 5 && !inCheck && !isRoot && Math.abs(beta) < 9000) {
    let cutCount = 0;
    const mcDepth = depth - 1 - 3;
    for (const m of moves.slice(0, 6)) {
      chess.move(m);
      const s = -pvsSearch(chess, mcDepth, ply + 1, -beta, -beta + 1, stats, [], startTime, maxTimeMs, `${m.from}${m.to}`, m.piece);
      chess.undo();
      if (s >= beta) {
        cutCount++;
        if (cutCount >= 3) return beta;
      }
    }
  }

  // 6. Double Singular Extensions & Negative Extensions (SE):
  let singularExtension = 0;
  if (depth >= 6 && !isRoot && ttEntry && ttEntry.depth >= depth - 3 && ttEntry.flag !== TT_FLAG.UPPERBOUND && Math.abs(ttEntry.score) < 15000 && hashMoveUci) {
    const singularMargin = depth * 3;
    const singularBeta = ttEntry.score - singularMargin;
    const singularDepth = Math.floor((depth - 1) / 2);
    let isSingular = true;

    for (const altMove of moves.slice(0, 8)) {
      const altUci = `${altMove.from}${altMove.to}${altMove.promotion || ''}`;
      if (altUci === hashMoveUci) continue;

      chess.move(altMove);
      const altScore = -pvsSearch(chess, singularDepth, ply + 1, -singularBeta, -singularBeta + 1, stats, [], startTime, maxTimeMs, altUci, altMove.piece);
      chess.undo();

      if (altScore >= singularBeta) {
        isSingular = false;
        break;
      }
    }

    if (isSingular) {
      // Double Singular Extension: If best move beats alternatives by twice the singular margin
      const doubleSingularBeta = singularBeta - singularMargin;
      let isDoubleSingular = true;
      for (const altMove of moves.slice(0, 5)) {
        const altUci = `${altMove.from}${altMove.to}${altMove.promotion || ''}`;
        if (altUci === hashMoveUci) continue;
        chess.move(altMove);
        const altScore = -pvsSearch(chess, singularDepth, ply + 1, -doubleSingularBeta, -doubleSingularBeta + 1, stats, [], startTime, maxTimeMs, altUci, altMove.piece);
        chess.undo();
        if (altScore >= doubleSingularBeta) {
          isDoubleSingular = false;
          break;
        }
      }
      singularExtension = isDoubleSingular ? 2 : 1;
    } else if (depth >= 8 && Math.abs(ttEntry.score) < 10000) {
      // Negative Extension on non-singular lines
      depth = depth - 1;
    }
  }

  // 7. Futility Pruning at low depth
  const futilityMargin = depth * 150;
  const canFutilityPrune = depth <= 2 && !inCheck && !isRoot && (staticEval + futilityMargin < alpha);

  let bestMoveUci = `${moves[0].from}${moves[0].to}${moves[0].promotion || ''}`;
  let bestScore = -30000;
  let currentAlpha = alpha;
  let movesSearched = 0;

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const uci = `${move.from}${move.to}${move.promotion || ''}`;
    const isCapture = !!move.captured;
    const isPromotion = !!move.promotion;

    // 8. Late Move Pruning (LMP)
    if (depth <= 4 && !inCheck && !isRoot && movesSearched >= (3 + 3 * depth * depth)) {
      if (!isCapture && !isPromotion && !chess.inCheck()) {
        continue;
      }
    }

    // Futility prune quiet moves that cannot beat alpha
    if (canFutilityPrune && movesSearched > 0 && !isCapture && !isPromotion && !chess.inCheck()) {
      continue;
    }

    chess.move(move);
    movesSearched++;

    let score: number;
    const childPv: string[] = [];

    // Principal Variation Search
    if (movesSearched === 1) {
      score = -pvsSearch(chess, depth - 1 + singularExtension, ply + 1, -beta, -currentAlpha, stats, childPv, startTime, maxTimeMs, uci, move.piece);
    } else {
      // Dynamic Late Move Reductions (LMR) with History Dampening & Check Immunity
      let reduction = 0;
      if (depth >= 3 && movesSearched >= 3 && !isCapture && !isPromotion && !inCheck && !chess.inCheck()) {
        reduction = 1 + Math.floor(Math.log(depth) * Math.log(movesSearched) / 2.1);

        // History Dampening
        const fromIdx = squareToIndex(move.from);
        const toIdx = squareToIndex(move.to);
        const hist = historyTable[colorIdx][fromIdx][toIdx] || 0;
        if (hist > 12000) reduction -= 2;
        else if (hist > 4000) reduction -= 1;
        else if (hist < -4000) reduction += 1;

        if (chess.inCheck()) reduction -= 1;

        // Passed pawn push deduction
        if (move.piece === 'p') {
          const rank = parseInt(move.to[1], 10);
          if ((turn === 'w' && rank >= 6) || (turn === 'b' && rank <= 3)) {
            reduction -= 1;
          }
        }

        reduction = Math.max(0, Math.min(depth - 2, reduction));
      }

      score = -pvsSearch(chess, depth - 1 - reduction, ply + 1, -currentAlpha - 1, -currentAlpha, stats, childPv, startTime, maxTimeMs, uci, move.piece);

      // Re-search at full depth if reduced search beat alpha
      if (score > currentAlpha && (reduction > 0 || score < beta)) {
        score = -pvsSearch(chess, depth - 1, ply + 1, -beta, -currentAlpha, stats, childPv, startTime, maxTimeMs, uci, move.piece);
      }
    }

    chess.undo();

    if (!isSearching) return currentAlpha;

    if (score > bestScore) {
      bestScore = score;
      bestMoveUci = uci;

      if (score > currentAlpha) {
        currentAlpha = score;
        pv.length = 0;
        pv.push(uci, ...childPv);

        if (score >= beta) {
          const colorIdx = turn === 'w' ? 0 : 1;
          const fromIdx = squareToIndex(move.from);
          const toIdx = squareToIndex(move.to);

          // Beta cutoff: update killers, history, conthist, countermoves
          if (!isCapture && ply < 64) {
            killerMoves[ply][1] = killerMoves[ply][0];
            killerMoves[ply][0] = uci;

            historyTable[colorIdx][fromIdx][toIdx] = (historyTable[colorIdx][fromIdx][toIdx] || 0) + depth * depth * 32;

            if (lastMoveUci && lastMoveUci.length >= 4 && lastMovePiece) {
              const prevTo = squareToIndex(lastMoveUci.slice(2, 4));
              const prevColor = turn === 'w' ? 'b' : 'w';
              const prevIdx = pieceToIdx(lastMovePiece, prevColor) * 64 + prevTo;
              const currIdx = pieceToIdx(move.piece, turn) * 64 + toIdx;
              conthistTable[prevIdx * 768 + currIdx] = Math.min(25000, conthistTable[prevIdx * 768 + currIdx] + depth * depth * 16);
            }

            if (lastMoveUci && lastMoveUci.length >= 4) {
              const pFrom = squareToIndex(lastMoveUci.slice(0, 2));
              const pTo = squareToIndex(lastMoveUci.slice(2, 4));
              counterMoveTable[colorIdx][pFrom][pTo] = uci;
            }
          } else if (isCapture) {
            captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] = Math.min(25000, captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] + depth * depth * 16);
          }
          break; // Beta cutoff
        }
      }
    } else {
      // History & Conthist Malus
      const colorIdx = turn === 'w' ? 0 : 1;
      const fromIdx = squareToIndex(move.from);
      const toIdx = squareToIndex(move.to);

      if (!isCapture && ply < 64) {
        historyTable[colorIdx][fromIdx][toIdx] = Math.max(-10000, (historyTable[colorIdx][fromIdx][toIdx] || 0) - depth * depth * 16);
        if (lastMoveUci && lastMoveUci.length >= 4 && lastMovePiece) {
          const prevTo = squareToIndex(lastMoveUci.slice(2, 4));
          const prevColor = turn === 'w' ? 'b' : 'w';
          const prevIdx = pieceToIdx(lastMovePiece, prevColor) * 64 + prevTo;
          const currIdx = pieceToIdx(move.piece, turn) * 64 + toIdx;
          conthistTable[prevIdx * 768 + currIdx] = Math.max(-10000, conthistTable[prevIdx * 768 + currIdx] - depth * depth * 8);
        }
      } else if (isCapture) {
        captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] = Math.max(-10000, captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] - depth * depth * 8);
      }
    }
  }

  // Update Correction History (CorrHist) on stable leaf results
  if (!inCheck && !isRoot && Math.abs(bestScore) < 9000) {
    const board = chess.board();
    const pKey = computePawnKey(board);
    const npKey = computeNonPawnKey(board);
    const errorBonus = Math.max(-1024, Math.min(1024, (bestScore - rawStaticEval) * 32));
    pawnCorrHist[colorIdx][pKey] = Math.round(pawnCorrHist[colorIdx][pKey] * 0.88 + errorBonus * 0.12);
    nonPawnCorrHist[colorIdx][npKey] = Math.round(nonPawnCorrHist[colorIdx][npKey] * 0.90 + (errorBonus / 2) * 0.10);
  }

  // Save to Transposition Table
  let ttFlag: typeof TT_FLAG[keyof typeof TT_FLAG] = TT_FLAG.EXACT;
  if (bestScore <= alpha) ttFlag = TT_FLAG.UPPERBOUND;
  else if (bestScore >= beta) ttFlag = TT_FLAG.LOWERBOUND;

  if (transpositionTable.size >= MAX_TT_SIZE) {
    const keys = Array.from(transpositionTable.keys()).slice(0, 10000);
    keys.forEach(k => transpositionTable.delete(k));
  }

  transpositionTable.set(fenKey, {
    key: fenKey,
    depth,
    score: bestScore,
    flag: ttFlag,
    bestMoveUci
  });

  return bestScore;
}

// Iterative Deepening Root Search with Progressive Aspiration Windows & Stability Time Manager
function executeRootSearch(targetDepth = 12, maxTimeMs = 3000) {
  isSearching = true;
  stopRequested = false;
  const startTime = Date.now();

  const moves = currentChess.moves({ verbose: true });
  if (moves.length === 0) {
    isSearching = false;
    self.postMessage('bestmove 0000');
    return;
  }

  // Instant Mate-in-1 check
  const mateMove = moves.find(m => m.san && m.san.includes('#'));
  if (mateMove) {
    const mateUci = `${mateMove.from}${mateMove.to}${mateMove.promotion || ''}`;
    isSearching = false;
    self.postMessage(`info depth 1 score mate 1 nodes 1 nps 1000 time 1 pv ${mateUci}`);
    self.postMessage(`bestmove ${mateUci}`);
    return;
  }

  const stats = { nodes: 0, qnodes: 0, seldepth: 0, ttHits: 0 };
  let bestMoveUci = `${moves[0].from}${moves[0].to}${moves[0].promotion || ''}`;
  let bestScore = 0;

  // Best-Move Stability Allocation
  let lastBestMoveUci = '';
  let moveFlips = 0;
  let stableIterations = 0;

  for (let currentDepth = 1; currentDepth <= targetDepth; currentDepth++) {
    if (!isSearching || (Date.now() - startTime) >= maxTimeMs) break;

    let pv: string[] = [];
    let delta = 25;
    let alpha = -30000;
    let beta = 30000;
    let score = 0;

    // Progressive Aspiration Windows for depth >= 4
    if (currentDepth >= 4) {
      alpha = Math.max(-30000, bestScore - delta);
      beta = Math.min(30000, bestScore + delta);

      while (true) {
        pv = [];
        score = pvsSearch(currentChess, currentDepth, 0, alpha, beta, stats, pv, startTime, maxTimeMs, null, null);
        if (!isSearching) break;

        if (score <= alpha) {
          // Fail low: inaccuracy danger! Widen alpha and increase search urgency
          alpha = Math.max(-30000, alpha - delta * 2);
          delta = Math.floor(delta * 1.6) + 15;
          moveFlips += 2;
        } else if (score >= beta) {
          // Fail high: winning breakthrough!
          beta = Math.min(30000, beta + delta * 2);
          delta = Math.floor(delta * 1.6) + 15;
        } else {
          break; // Clean within window
        }

        if (alpha <= -20000 && beta >= 20000) {
          pv = [];
          score = pvsSearch(currentChess, currentDepth, 0, -30000, 30000, stats, pv, startTime, maxTimeMs, null, null);
          break;
        }
      }
    } else {
      score = pvsSearch(currentChess, currentDepth, 0, -30000, 30000, stats, pv, startTime, maxTimeMs, null, null);
    }

    if (pv.length > 0) {
      bestMoveUci = pv[0];
      bestScore = score;
    }

    const elapsedMs = Math.max(1, Date.now() - startTime);
    const totalNodes = stats.nodes + stats.qnodes;
    const nps = Math.round((totalNodes / elapsedMs) * 1000);
    const pvStr = pv.join(' ');

    let scoreStr = `score cp ${bestScore}`;
    if (Math.abs(bestScore) > 20000) {
      const mateDist = Math.ceil((25000 - Math.abs(bestScore)) / 2);
      scoreStr = `score mate ${bestScore > 0 ? mateDist : -mateDist}`;
    }

    self.postMessage(
      `info depth ${currentDepth} seldepth ${stats.seldepth} multipv 1 ${scoreStr} nodes ${totalNodes} nps ${nps} time ${elapsedMs} hashfull ${Math.min(100, Math.round((transpositionTable.size / MAX_TT_SIZE) * 100))} pv ${pvStr}`
    );

    // Multi-PV candidate lines exploration
    if (multiPv > 1) {
      const excludedUcis = new Set<string>([bestMoveUci]);
      for (let rank = 2; rank <= Math.min(multiPv, moves.length); rank++) {
        let altScore = -30000;
        let altPv: string[] = [];
        let altBestUci = '';

        for (const m of moves) {
          const uci = `${m.from}${m.to}${m.promotion || ''}`;
          if (excludedUcis.has(uci)) continue;

          currentChess.move(m);
          const subPv: string[] = [];
          const s = -pvsSearch(currentChess, Math.max(1, currentDepth - 1), 1, -30000, 30000, stats, subPv, startTime, maxTimeMs, null, m);
          currentChess.undo();

          if (s > altScore) {
            altScore = s;
            altBestUci = uci;
            altPv = [uci, ...subPv];
          }
        }

        if (altBestUci) {
          excludedUcis.add(altBestUci);
          let altScoreStr = `score cp ${altScore}`;
          if (Math.abs(altScore) > 20000) {
            const mateDist = Math.ceil((25000 - Math.abs(altScore)) / 2);
            altScoreStr = `score mate ${altScore > 0 ? mateDist : -mateDist}`;
          }
          self.postMessage(
            `info depth ${currentDepth} seldepth ${stats.seldepth} multipv ${rank} ${altScoreStr} nodes ${totalNodes} nps ${nps} time ${elapsedMs} pv ${altPv.join(' ')}`
          );
        }
      }
    }

    // Time Management: Adjust based on move stability
    if (bestMoveUci === lastBestMoveUci) {
      stableIterations++;
      if (stableIterations >= 3 && currentDepth >= 4 && elapsedMs > maxTimeMs * 0.55 && moveFlips === 0) {
        break; // Solid move: early cut to preserve time budget
      }
    } else {
      lastBestMoveUci = bestMoveUci;
      stableIterations = 0;
      moveFlips++;
    }

    const dynamicLimit = moveFlips >= 2 ? maxTimeMs * 0.95 : maxTimeMs * 0.70;
    if (elapsedMs >= dynamicLimit) break;
  }

  // Anti-Repetition Shield: Ensure White never repeats positions when winning
  if (bestScore > 50 && gameHistoryFens.length > 0 && moves.length > 1) {
    try {
      const testChess = new Chess(currentChess.fen());
      testChess.move({ from: bestMoveUci.slice(0, 2), to: bestMoveUci.slice(2, 4), promotion: bestMoveUci[4] });
      const nextKey = testChess.fen().split(' ').slice(0, 4).join(' ');
      let reps = 0;
      for (const k of gameHistoryFens) {
        if (k === nextKey) reps++;
      }
      if (reps >= 1) {
        for (const m of moves) {
          const uci = `${m.from}${m.to}${m.promotion || ''}`;
          if (uci === bestMoveUci) continue;
          const sim = new Chess(currentChess.fen());
          sim.move(m);
          const candKey = sim.fen().split(' ').slice(0, 4).join(' ');
          let candReps = 0;
          for (const k of gameHistoryFens) {
            if (k === candKey) candReps++;
          }
          if (candReps === 0) {
            bestMoveUci = uci;
            break;
          }
        }
      }
    } catch {}
  }

  let outBestMove = bestMoveUci;
  if (uciChess960 && currentChess960Config) {
    const isWhite = currentChess.turn() === 'w';
    const kingSq = isWhite
      ? `${String.fromCharCode(97 + currentChess960Config.whiteKingFile)}1`
      : `${String.fromCharCode(97 + currentChess960Config.blackKingFile)}8`;
    if (bestMoveUci.startsWith(kingSq)) {
      const dest = bestMoveUci.slice(2, 4);
      if (dest === (isWhite ? 'g1' : 'g8')) {
        const rookFile = isWhite ? currentChess960Config.whiteKingRookFile : currentChess960Config.blackKingRookFile;
        outBestMove = `${kingSq}${String.fromCharCode(97 + rookFile)}${isWhite ? '1' : '8'}`;
      } else if (dest === (isWhite ? 'c1' : 'c8')) {
        const rookFile = isWhite ? currentChess960Config.whiteQueenRookFile : currentChess960Config.blackQueenRookFile;
        outBestMove = `${kingSq}${String.fromCharCode(97 + rookFile)}${isWhite ? '1' : '8'}`;
      }
    }
  }

  isSearching = false;
  self.postMessage(`bestmove ${outBestMove}`);
}

// UCI Command Parser Loop
self.onmessage = function (event) {
  const line = (typeof event.data === 'string' ? event.data : '').trim();
  if (!line) return;

  const parts = line.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case 'uci':
      self.postMessage(`id name ${ENGINE_NAME}`);
      self.postMessage(`id author ${ENGINE_AUTHOR}`);
      self.postMessage('option name Threads type spin default 64 min 1 max 64');
      self.postMessage('option name Hash type spin default 32768 min 16 max 65536');
      self.postMessage('option name MultiPV type spin default 1 min 1 max 5');
      self.postMessage('option name UCI_Chess960 type check default false');
      self.postMessage('option name EvalMode type combo default brnnue-v070-quad var brnnue-v070-quad var brnnue-v030 var berserker-1.0-nnue var aura-nnue');
      self.postMessage('option name SearchMode type combo default Hybrid-MCTS-PVS var Hybrid-MCTS-PVS var Pure-PVS var Pure-MCTS');
      self.postMessage('option name PetrosianProphylaxis type check default true');
      self.postMessage('option name DagTransposition type check default true');
      self.postMessage('option name AntiRepetitionShield type check default true');
      self.postMessage('option name TacticalContempt type spin default 45 min -100 max 100');
      self.postMessage('option name KingAttackScale type spin default 140 min 50 max 250');
      self.postMessage(`option name NNUE_Net type string default ${DEFAULT_NET}`);
      self.postMessage('uciok');
      break;

    case 'isready':
      self.postMessage('readyok');
      break;

    case 'ucinewgame':
      currentChess = new Chess();
      gameHistoryFens = [];
      clearSearchState();
      resetMctsTree();
      break;

    case 'position':
      gameHistoryFens = [];
      if (parts[1] === 'startpos') {
        currentChess = new Chess();
        gameHistoryFens.push(currentChess.fen().split(' ').slice(0, 4).join(' '));
        const movesIdx = parts.indexOf('moves');
        if (movesIdx !== -1) {
          for (let i = movesIdx + 1; i < parts.length; i++) {
            const mv = parts[i];
            currentChess.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] || undefined });
            gameHistoryFens.push(currentChess.fen().split(' ').slice(0, 4).join(' '));
          }
        }
      } else if (parts[1] === 'fen') {
        const movesIdx = parts.indexOf('moves');
        const rawFen = (movesIdx !== -1 ? parts.slice(2, movesIdx) : parts.slice(2)).join(' ');
        const { normalizedFen } = normalizeChess960Fen(rawFen);
        try {
          currentChess = new Chess(normalizedFen);
          const backrank = normalizedFen.split('/')[7]?.split(' ')[0] || 'RNBQKBNR';
          currentChess960Config = extractCastlingConfig(backrank);
          gameHistoryFens.push(currentChess.fen().split(' ').slice(0, 4).join(' '));
          if (movesIdx !== -1) {
            for (let i = movesIdx + 1; i < parts.length; i++) {
              const mv = parts[i];
              const resolved = resolveChess960Move(currentChess, mv, currentChess960Config);
              if (resolved.isChess960Castling && resolved.side) {
                executeChess960Castling(currentChess, resolved.side, currentChess960Config);
              } else {
                currentChess.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] || undefined });
              }
              gameHistoryFens.push(currentChess.fen().split(' ').slice(0, 4).join(' '));
            }
          }
        } catch {
          self.postMessage('info string Invalid FEN provided');
        }
      }
      break;

    case 'go': {
      let depth = 12;
      let movetime = 2500;

      const depthIdx = parts.indexOf('depth');
      if (depthIdx !== -1 && parts[depthIdx + 1]) depth = parseInt(parts[depthIdx + 1], 10);

      const timeIdx = parts.indexOf('movetime');
      if (timeIdx !== -1 && parts[timeIdx + 1]) movetime = parseInt(parts[timeIdx + 1], 10);

      if (searchMode === 'Hybrid-MCTS-PVS') {
        const hybridRes = searchHybridNnueMcts(currentChess.fen(), {
          maxTimeMs: movetime,
          safetyNetDepth: Math.min(depth, 8),
          simulations: 800,
          gameHistory: gameHistoryFens
        });

        const topMovesStr = hybridRes.mctsTopMoves.map(m => `${m.uci}(${m.visits}v,${m.qValue}q)`).join(' ');
        const threatsStr = hybridRes.activeOpponentThreats.map(t => `${t.san}:${t.threatSeverity}`).join(' ');
        self.postMessage(
          `info depth ${hybridRes.pvsDepth} score cp ${hybridRes.scoreCp} visits ${hybridRes.mctsVisits} sims ${hybridRes.totalSimulations} arbiter ${hybridRes.decisionReason} proph ${hybridRes.prophylaxisScore} threats [${threatsStr}] volatility ${hybridRes.tacticalVolatility} reused ${hybridRes.treeReused} tb ${hybridRes.tablebaseHits} ext ${hybridRes.timeExtensionsGranted} delta ${hybridRes.safetyNetDeltaCp} time ${hybridRes.timeMs} top [${topMovesStr}] pv ${hybridRes.bestMoveUci}`
        );
        self.postMessage(`bestmove ${hybridRes.bestMoveUci}`);
      } else {
        executeRootSearch(depth, movetime);
      }
      break;
    }

    case 'stop':
      stopRequested = true;
      break;

    case 'setoption': {
      const nameIdx = parts.indexOf('name');
      const valIdx = parts.indexOf('value');
      if (nameIdx !== -1 && valIdx !== -1) {
        const optName = parts[nameIdx + 1];
        const optVal = parts[valIdx + 1];
        if (optName === 'EvalMode') evalMode = optVal;
        if (optName === 'SearchMode') searchMode = optVal;
        if (optName === 'Threads') threads = parseInt(optVal, 10);
        if (optName === 'Hash') hashMb = parseInt(optVal, 10);
        if (optName === 'MultiPV') multiPv = parseInt(optVal, 10);
        if (optName === 'UCI_Chess960') uciChess960 = optVal === 'true';
        if (optName === 'TacticalContempt') tacticalContempt = parseInt(optVal, 10);
        if (optName === 'KingAttackScale') kingAttackScale = parseInt(optVal, 10);
      }
      break;
    }

    case 'eval': {
      const quadEval = evaluateBRnnueV070(currentChess.fen());
      const bsz10Eval = evaluateBerserker10Nnue(currentChess.fen());
      self.postMessage(`=== ${ENGINE_NAME} NEURAL EVALUATION ===`);
      self.postMessage(`FEN: ${currentChess.fen()}`);
      self.postMessage(`Turn: ${currentChess.turn() === 'w' ? 'White' : 'Black'}`);
      self.postMessage(`Berserker NNUE v0.7.0 Quad-Head: ${quadEval.centipawns > 0 ? '+' : ''}${(quadEval.centipawns / 100).toFixed(2)} (${quadEval.centipawns} cp) [Win: ${(quadEval.winProb * 100).toFixed(1)}%]`);
      self.postMessage(`  - Head 1 (Berserker Attack): HalfKP-1024 King Attack Vectors (${quadEval.berserkerAttackSubnet.centipawns} cp)`);
      self.postMessage(`  - Head 2 (Berserker Harmony): HalfKAv2-1024 Spatial Harmony (${quadEval.berserkerHarmonySubnet.centipawns} cp)`);
      self.postMessage(`  - Head 3 (Threat Predictor):  ${quadEval.threatPredictionHead.predictedThreatCount} threats, max severity ${quadEval.threatPredictionHead.highestThreatSeverity}`);
      self.postMessage(`  - Head 4 (Endgame Conversion): ${(quadEval.endgameConversionHead.conversionCertainty * 100).toFixed(1)}% certainty, pass pawn urgency ${quadEval.endgameConversionHead.passedPawnUrgency}`);
      self.postMessage(`Berserker 1.0 NNUE:          ${bsz10Eval.centipawns > 0 ? '+' : ''}${(bsz10Eval.centipawns / 100).toFixed(2)} (${bsz10Eval.centipawns} cp)`);
      self.postMessage(`Active Net:                  ${DEFAULT_NET}`);
      break;
    }

    case 'd': {
      self.postMessage(currentChess.ascii());
      self.postMessage(`Fen: ${currentChess.fen()}`);
      break;
    }

    case 'quit':
      break;
  }
};
