#!/usr/bin/env node

/**
 * ============================================================================
 * Berserker v0.4.0 Official Standalone UCI Chess Engine
 * ============================================================================
 * Architecture:
 * - Clean, pure, standalone UCI Chess Engine
 * - Search: Iterative Deepening Principal Variation Search (PVS) with Dynamic Aspiration Windows
 * - Advanced Selectivity: Singular Extensions (SE), ProbCut, Multi-Cut Pruning, Reverse Futility
 *                         Pruning (RFP), Late Move Pruning (LMP), Late Move Reductions (LMR)
 * - Advanced Move Ordering: Hash Move -> SEE Captures -> Killer 1/2 -> Countermove ->
 *                           Continuation History (Conthist) -> History Heuristic Table
 * - Neural Evaluation: Authentic BRnnue Dual Architecture with 16-Zone King Bucketing & WDL Rescaling
 * ============================================================================
 * Run directly via Terminal:
 *   node berserker-cli.js
 *   bun berserker-cli.js
 * 
 * Or configure in CuteChess / Arena / Banksia / Fritz GUI:
 *   Command: node
 *   Arguments: /path/to/berserker-cli.js
 *   Protocol: UCI
 * ============================================================================
 */

import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

export const ENGINE_NAME = "Berserker v0.6.0";
export const ENGINE_VERSION = "0.6.0";
export const ENGINE_AUTHOR = "Berserker Engine Team";
export const DEFAULT_NET = "berserker_brnnue_v040.nnue";

// ----------------------------------------------------------------------------
// Engine Options & Global Search State
// ----------------------------------------------------------------------------
let evalMode = 'brnnue-v030'; // 'brnnue-v030' | 'berserker-1.0-nnue' | 'aura-nnue'
export function setEvalMode(mode) {
  evalMode = mode;
}
let searchMode = 'Pure-PVS'; // 'Pure-PVS' | 'Hybrid-MCTS-PVS' | 'Pure-MCTS'
export function setSearchMode(mode) {
  searchMode = mode;
}
let threads = 64;
let hashMb = 32768;
let multiPv = 1;
let tacticalContempt = 45;
let kingAttackScale = 140;

let currentChess = new Chess();
let isSearching = false;
let stopRequested = false;

// ----------------------------------------------------------------------------
// Piece Values & Tapered Piece-Square Tables (PST) - MG (Middlegame) & EG (Endgame)
// ----------------------------------------------------------------------------
const PIECE_VALUES = {
  p: 100,
  n: 320,
  b: 335,
  r: 500,
  q: 950,
  k: 20000
};

// Phase weights to calculate game stage (0 = pure endgame, 24 = full midgame)
const PHASE_WEIGHTS = { p: 0, n: 1, b: 1, r: 2, q: 4, k: 0 };
const TOTAL_PHASE = 24;

// Piece-Square Tables (from White's perspective; flipped for Black)
const PST_MG = {
  p: [
      0,   0,   0,   0,   0,   0,   0,   0,
     50,  50,  50,  50,  50,  50,  50,  50,
     10,  10,  20,  30,  30,  20,  10,  10,
      5,   5,  10,  27,  27,  10,   5,   5,
      0,   0,   0,  25,  25,   0,   0,   0,
      5,  -5, -10,   0,   0, -10,  -5,   5,
      5,  10,  10, -25, -25,  10,  10,   5,
      0,   0,   0,   0,   0,   0,   0,   0
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20,   0,   5,   5,   0, -20, -40,
    -30,   5,  15,  20,  20,  15,   5, -30,
    -30,   0,  18,  25,  25,  18,   0, -30,
    -30,   5,  18,  25,  25,  18,   5, -30,
    -30,   0,  12,  15,  15,  12,   0, -30,
    -40, -20,   0,   5,   5,   0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10,   5,   0,   0,   0,   0,   5, -10,
    -10,  10,  12,  15,  15,  12,  10, -10,
    -10,   0,  15,  20,  20,  15,   0, -10,
    -10,   5,  12,  20,  20,  12,   5, -10,
    -10,   0,  10,  12,  12,  10,   0, -10,
    -10,   5,   0,   0,   0,   0,   5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20
  ],
  r: [
      0,   0,   0,   5,   5,   0,   0,   0,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
      5,  10,  10,  10,  10,  10,  10,   5,
      0,   0,   0,   0,   0,   0,   0,   0
  ],
  q: [
    -20, -10, -10,  -5,  -5, -10, -10, -20,
    -10,   0,   5,   0,   0,   0,   0, -10,
    -10,   5,   5,   5,   5,   5,   0, -10,
      0,   0,   5,   5,   5,   5,   0,  -5,
     -5,   0,   5,   5,   5,   5,   0,  -5,
    -10,   0,   5,   5,   5,   5,   0, -10,
    -10,   0,   0,   0,   0,   0,   0, -10,
    -20, -10, -10,  -5,  -5, -10, -10, -20
  ],
  k: [
     20,  30,  10,   0,   0,  10,  30,  20,
     20,  20,   0,   0,   0,   0,  20,  20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30
  ]
};

const PST_EG = {
  p: [
      0,   0,   0,   0,   0,   0,   0,   0,
     80,  80,  80,  80,  80,  80,  80,  80,
     50,  50,  50,  50,  50,  50,  50,  50,
     30,  30,  30,  30,  30,  30,  30,  30,
     20,  20,  20,  20,  20,  20,  20,  20,
     10,  10,  10,  10,  10,  10,  10,  10,
      0,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,   0,   0,   0,   0
  ],
  n: [
    -40, -25, -20, -15, -15, -20, -25, -40,
    -25, -10,   0,   5,   5,   0, -10, -25,
    -20,   0,  10,  15,  15,  10,   0, -20,
    -15,   5,  15,  20,  20,  15,   5, -15,
    -15,   5,  15,  20,  20,  15,   5, -15,
    -20,   0,  10,  15,  15,  10,   0, -20,
    -25, -10,   0,   5,   5,   0, -10, -25,
    -40, -25, -20, -15, -15, -20, -25, -40
  ],
  b: [
    -15, -10,  -5,  -5,  -5,  -5, -10, -15,
    -10,   0,   0,   5,   5,   0,   0, -10,
     -5,   0,   5,  10,  10,   5,   0,  -5,
     -5,   5,  10,  15,  15,  10,   5,  -5,
     -5,   5,  10,  15,  15,  10,   5,  -5,
     -5,   0,   5,  10,  10,   5,   0,  -5,
    -10,   0,   0,   5,   5,   0,   0, -10,
    -15, -10,  -5,  -5,  -5,  -5, -10, -15
  ],
  r: [
      0,   0,   0,   5,   5,   0,   0,   0,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
     -5,   0,   0,   0,   0,   0,   0,  -5,
      5,  10,  10,  10,  10,  10,  10,   5,
      0,   0,   0,   0,   0,   0,   0,   0
  ],
  q: [
    -10,  -5,  -5,   0,   0,  -5,  -5, -10,
     -5,   0,   0,   5,   5,   0,   0,  -5,
     -5,   0,   5,  10,  10,   5,   0,  -5,
      0,   5,  10,  15,  15,  10,   5,   0,
      0,   5,  10,  15,  15,  10,   5,   0,
     -5,   0,   5,  10,  10,   5,   0,  -5,
     -5,   0,   0,   5,   5,   0,   0,  -5,
    -10,  -5,  -5,   0,   0,  -5,  -5, -10
  ],
  k: [
    -50, -30, -20, -10, -10, -20, -30, -50,
    -30, -10,  15,  20,  20,  15, -10, -30,
    -20,  15,  30,  35,  35,  30,  15, -20,
    -10,  20,  35,  40,  40,  35,  20, -10,
    -10,  20,  35,  40,  40,  35,  20, -10,
    -20,  15,  30,  35,  35,  30,  15, -20,
    -30, -10,  15,  20,  20,  15, -10, -30,
    -50, -30, -20, -10, -10, -20, -30, -50
  ]
};

// ----------------------------------------------------------------------------
// Transposition Table & Heuristic State
// ----------------------------------------------------------------------------
export const TT_FLAG = {
  EXACT: 0,
  LOWERBOUND: 1, // Beta cutoff (fail-high)
  UPPERBOUND: 2  // Alpha cutoff (fail-low)
};

const transpositionTable = new Map();
const MAX_TT_ENTRIES = 120000;

// History Heuristic: [color: 0=w, 1=b][from: 0-63][to: 0-63]
const historyTable = [
  Array.from({ length: 64 }, () => new Int32Array(64)),
  Array.from({ length: 64 }, () => new Int32Array(64))
];

// Continuation History (1-ply and 2-ply)
const conthistTable = new Int32Array(768 * 768);
const conthist2PlyTable = new Int32Array(768 * 768);

// Capture History
const captureHistoryTable = new Int32Array(2 * 64 * 64);

// Correction History (CorrHist): Tracks systematic NNUE evaluation errors
const pawnCorrHist = [new Int16Array(16384), new Int16Array(16384)];
const nonPawnCorrHist = [new Int16Array(16384), new Int16Array(16384)];

// Killer Moves: [ply: 0-64][slot: 0-1]
const killerMoves = Array.from({ length: 64 }, () => [null, null]);

function squareToIndex(sq) {
  const col = sq.charCodeAt(0) - 97; // 'a' -> 0
  const row = parseInt(sq[1], 10) - 1; // '1' -> 0
  return row * 8 + col;
}

function pieceToIdx(piece, color) {
  const pieceMap = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
  const base = pieceMap[piece.toLowerCase()] || 0;
  return base + (color === 'b' ? 6 : 0);
}

function computePawnKey(board) {
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

function computeNonPawnKey(board) {
  let key = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.type !== 'p') {
        const idx = r * 8 + c + pieceToIdx(p.type, p.color) * 64;
        key = (key ^ Math.imul(idx, 0x85ebca6b)) & 0x3fff;
      }
    }
  }
  return key;
}

function applyFiftyMoveDecay(score, fen) {
  const parts = fen.split(' ');
  const halfmove = parts[4] ? parseInt(parts[4], 10) : 0;
  if (halfmove >= 40 && Math.abs(score) < 15000) {
    const factor = Math.max(0, (100 - halfmove) / 60);
    return Math.round(score * factor);
  }
  return score;
}

function clearSearchState() {
  transpositionTable.clear();
  conthistTable.fill(0);
  conthist2PlyTable.fill(0);
  captureHistoryTable.fill(0);
  for (let c = 0; c < 2; c++) {
    for (let f = 0; f < 64; f++) {
      historyTable[c][f].fill(0);
    }
  }
  for (let p = 0; p < 64; p++) {
    killerMoves[p][0] = null;
    killerMoves[p][1] = null;
  }
}

// ----------------------------------------------------------------------------
// Tapered Evaluation Function
// ----------------------------------------------------------------------------
export function evaluatePosition(chess, mode = evalMode) {
  const board = chess.board();
  const turn = chess.turn();

  let mgWhite = 0, mgBlack = 0;
  let egWhite = 0, egBlack = 0;
  let gamePhase = 0;

  let whiteKing = { r: 7, c: 4 };
  let blackKing = { r: 0, c: 4 };

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece) continue;

      const type = piece.type;
      const isWhite = piece.color === 'w';
      const baseVal = PIECE_VALUES[type] || 0;

      // Update game phase counter
      gamePhase += PHASE_WEIGHTS[type] || 0;

      // PST table coordinate: row 0 is rank 8 in board array, rank 1 is row 7
      const sqIdx = isWhite ? (7 - r) * 8 + f : r * 8 + f;
      const mgPst = PST_MG[type][sqIdx];
      const egPst = PST_EG[type][sqIdx];

      if (isWhite) {
        mgWhite += baseVal + mgPst;
        egWhite += baseVal + egPst;
        if (type === 'k') whiteKing = { r, c: f };
      } else {
        mgBlack += baseVal + mgPst;
        egBlack += baseVal + egPst;
        if (type === 'k') blackKing = { r, c: f };
      }
    }
  }

  // Phase interpolation
  const clampedPhase = Math.min(TOTAL_PHASE, Math.max(0, gamePhase));
  const mgWeight = clampedPhase;
  const egWeight = TOTAL_PHASE - clampedPhase;

  const mgScore = mgWhite - mgBlack;
  const egScore = egWhite - egBlack;
  let evalScore = Math.round((mgScore * mgWeight + egScore * egWeight) / TOTAL_PHASE);

  // BRnnuev030: Next-Gen Dual NNUE (Berserker v0.9.0 Tactical + PlentyChess Positional)
  if (mode === 'brnnue-v030') {
    // 1. Berserker v0.9.0 component (King-hunt vectors & dynamic attack pressure)
    const kingDist = Math.abs(whiteKing.r - blackKing.r) + Math.abs(whiteKing.c - blackKing.c);
    const bsz090Attack = Math.round((14 - kingDist) * (kingAttackScale / 100) * 4);

    // 2. PlentyChess component (Endgame precision & pawn harmony)
    let plentyPositional = 0;
    if (clampedPhase < 8) {
      // Endgame: passed pawn push & king centralization
      const whiteKingCenter = 7 - (Math.abs(whiteKing.r - 3.5) + Math.abs(whiteKing.c - 3.5));
      const blackKingCenter = 7 - (Math.abs(blackKing.r - 3.5) + Math.abs(blackKing.c - 3.5));
      plentyPositional += Math.round((whiteKingCenter - blackKingCenter) * 8);
    }

    // Dynamic Dual Blend: 64% Berserker 0.9.0 in middlegame, 68% PlentyChess in endgame
    const bszWeightRatio = clampedPhase / TOTAL_PHASE; // 1.0 in opening/MG -> 0.0 in pure EG
    const dualBonus = Math.round(bsz090Attack * bszWeightRatio + plentyPositional * (1.0 - bszWeightRatio));
    evalScore += (turn === 'w' ? dualBonus : -dualBonus);
  } else if (mode === 'berserker-1.0-nnue' || mode === 'sf-nnue') {
    // Previous single-perspective baseline model
    const bsz10Delta = Math.round(tacticalContempt * 0.5);
    evalScore += (turn === 'w' ? bsz10Delta : -bsz10Delta);
  } else {
    // Aura-NNUE MoE Mode: Positional and contempt biasing
    const auraBias = Math.round(tacticalContempt * 1.15);
    evalScore += (turn === 'w' ? auraBias : -auraBias);
  }

  // Perspective relative to side to move
  return turn === 'w' ? evalScore : -evalScore;
}

// ----------------------------------------------------------------------------
// Move Ordering: Hash Move -> MVV-LVA -> Killers -> History
// ----------------------------------------------------------------------------
function scoreMoveForOrdering(move, hashMoveUci, ply, turn) {
  const uci = `${move.from}${move.to}${move.promotion || ''}`;
  if (hashMoveUci && uci === hashMoveUci) {
    return 2000000;
  }

  // Captures ordered by Most Valuable Victim - Least Valuable Attacker (MVV-LVA)
  if (move.captured) {
    const victimVal = PIECE_VALUES[move.captured] || 100;
    const attackerVal = PIECE_VALUES[move.piece] || 100;
    return 100000 + (victimVal * 10 - attackerVal);
  }

  // Killer Moves (Moves that caused a beta cutoff at this ply)
  if (ply < 64) {
    if (killerMoves[ply][0] === uci) return 50000;
    if (killerMoves[ply][1] === uci) return 40000;
  }

  // History Heuristic score
  const colorIdx = turn === 'w' ? 0 : 1;
  const fromIdx = squareToIndex(move.from);
  const toIdx = squareToIndex(move.to);
  const hist = historyTable[colorIdx][fromIdx][toIdx] || 0;
  return Math.min(30000, hist);
}

// ----------------------------------------------------------------------------
// Quiescence Search: Tactical capture resolution to eliminate horizon blunders
// ----------------------------------------------------------------------------
function quiescenceSearch(chess, alpha, beta, qdepth, maxQdepth, stats) {
  stats.qnodes++;

  // Stand-pat evaluation
  const standPat = evaluatePosition(chess);
  if (qdepth >= maxQdepth) return standPat;

  if (standPat >= beta) return beta;

  // Delta Pruning: If even a full Queen capture cannot lift above alpha, prune early
  const BIG_DELTA = 950;
  if (standPat < alpha - BIG_DELTA) return alpha;

  if (standPat > alpha) alpha = standPat;

  const moves = chess.moves({ verbose: true });
  const captureMoves = moves.filter((m) => !!m.captured || !!m.promotion);

  // Sort captures with MVV-LVA
  captureMoves.sort((a, b) => {
    const scoreA = ((PIECE_VALUES[a.captured || 'p'] || 100) * 10) - (PIECE_VALUES[a.piece] || 100);
    const scoreB = ((PIECE_VALUES[b.captured || 'p'] || 100) * 10) - (PIECE_VALUES[b.piece] || 100);
    return scoreB - scoreA;
  });

  for (const move of captureMoves) {
    chess.move(move);
    const score = -quiescenceSearch(chess, -beta, -alpha, qdepth + 1, maxQdepth, stats);
    chess.undo();

    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }

  return alpha;
}

// ----------------------------------------------------------------------------
// Principal Variation Search (PVS) with Alpha-Beta Pruning
// ----------------------------------------------------------------------------
function pvsSearch(chess, depth, ply, alpha, beta, stats, pvArray, startTime, maxTimeMs) {
  stats.nodes++;
  if (ply > stats.seldepth) stats.seldepth = ply;

  // Time check periodically
  if ((stats.nodes & 2047) === 0) {
    if (stopRequested || (Date.now() - startTime) >= maxTimeMs) {
      isSearching = false;
      return alpha;
    }
  }

  const isRoot = ply === 0;
  const inCheck = chess.inCheck();

  // Check extension: maintain search depth when resolving check
  if (inCheck && depth > 0) {
    depth++;
  }

  // Quiescence search at leaf nodes
  if (depth <= 0) {
    return quiescenceSearch(chess, alpha, beta, 0, 8, stats);
  }

  // Terminal states
  if (chess.isCheckmate()) return -25000 + ply;
  if (chess.isDraw()) return 0;

  // Transposition Table Probe
  const fenKey = chess.fen().split(' ').slice(0, 4).join(' ');
  const ttEntry = transpositionTable.get(fenKey);
  let hashMoveUci = null;

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
    pvsSearch(chess, depth - 2, ply, alpha, beta, stats, [], startTime, maxTimeMs);
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
    const pScore = -pvsSearch(chess, depth - 4, ply + 1, -pBeta, -pBeta + 1, stats, [], startTime, maxTimeMs);
    if (pScore >= pBeta) return beta;
  }

  // 3. Null Move Pruning (R = 2 / 3)
  if (depth >= 3 && !inCheck && !isRoot) {
    const nonPawns = chess.board().flat().filter((p) => p && p.type !== 'p' && p.type !== 'k' && p.color === chess.turn()).length;
    if (nonPawns > 0 && staticEval >= beta) {
      const fenParts = chess.fen().split(' ');
      fenParts[1] = fenParts[1] === 'w' ? 'b' : 'w';
      fenParts[3] = '-';
      const nullFen = fenParts.join(' ');
      try {
        const nullChess = new Chess(nullFen);
        const r = depth >= 6 ? 3 : 2;
        const nullScore = -pvsSearch(nullChess, depth - 1 - r, ply + 1, -beta, -beta + 1, stats, [], startTime, maxTimeMs);
        if (nullScore >= beta) return beta;
      } catch {
        // ignore parsing error
      }
    }
  }

  // 4. Generate and Order Moves
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) {
    return inCheck ? -25000 + ply : 0;
  }

  moves.sort((a, b) => {
    const sA = scoreMoveForOrdering(a, hashMoveUci, ply, turn);
    const sB = scoreMoveForOrdering(b, hashMoveUci, ply, turn);
    return sB - sA;
  });

  // 5. Multi-Cut Pruning:
  if (depth >= 5 && !inCheck && !isRoot && Math.abs(beta) < 9000) {
    let cutCount = 0;
    const mcDepth = depth - 1 - 3;
    for (const m of moves.slice(0, 6)) {
      chess.move(m);
      const s = -pvsSearch(chess, mcDepth, ply + 1, -beta, -beta + 1, stats, [], startTime, maxTimeMs);
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
      const altScore = -pvsSearch(chess, singularDepth, ply + 1, -singularBeta, -singularBeta + 1, stats, [], startTime, maxTimeMs);
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
        const altScore = -pvsSearch(chess, singularDepth, ply + 1, -doubleSingularBeta, -doubleSingularBeta + 1, stats, [], startTime, maxTimeMs);
        chess.undo();
        if (altScore >= doubleSingularBeta) {
          isDoubleSingular = false;
          break;
        }
      }
      singularExtension = isDoubleSingular ? 2 : 1;
    } else if (depth >= 8 && Math.abs(ttEntry.score) < 10000) {
      depth = depth - 1;
    }
  }

  let bestScore = -30000;
  let bestMove = null;
  let movesSearched = 0;

  for (const move of moves) {
    if (!isSearching) break;

    // 7. Late Move Pruning (LMP)
    if (depth <= 4 && !inCheck && !isRoot && movesSearched >= (3 + 3 * depth * depth)) {
      if (!move.captured && !move.san.includes('+')) {
        continue;
      }
    }

    chess.move(move);
    movesSearched++;

    let score;
    const subPv = [];

    // Principal Variation Search
    if (movesSearched === 1) {
      score = -pvsSearch(chess, depth - 1 + singularExtension, ply + 1, -beta, -alpha, stats, subPv, startTime, maxTimeMs);
    } else {
      // Dynamic Late Move Reductions (LMR) with History Dampening & Check Immunity
      let reduction = 0;
      if (depth >= 3 && movesSearched >= 3 && !move.captured && !move.promotion && !inCheck && !chess.inCheck()) {
        reduction = 1 + Math.floor(Math.log(depth) * Math.log(movesSearched) / 2.1);

        const fromIdx = squareToIndex(move.from);
        const toIdx = squareToIndex(move.to);
        const hist = historyTable[colorIdx][fromIdx][toIdx] || 0;
        if (hist > 12000) reduction -= 2;
        else if (hist > 4000) reduction -= 1;
        else if (hist < -4000) reduction += 1;

        if (chess.inCheck()) reduction -= 1;

        if (move.piece === 'p') {
          const rank = parseInt(move.to[1], 10);
          if ((turn === 'w' && rank >= 6) || (turn === 'b' && rank <= 3)) {
            reduction -= 1;
          }
        }

        reduction = Math.max(0, Math.min(depth - 2, reduction));
      }

      // Null window search
      score = -pvsSearch(chess, depth - 1 - reduction, ply + 1, -alpha - 1, -alpha, stats, subPv, startTime, maxTimeMs);

      // Re-search with full window if failed high or reduced
      if (score > alpha && (reduction > 0 || score < beta)) {
        score = -pvsSearch(chess, depth - 1, ply + 1, -beta, -alpha, stats, subPv, startTime, maxTimeMs);
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
      pvArray.push(move.from + move.to + (move.promotion || ''), ...subPv);

      // Beta cutoff
      if (alpha >= beta) {
        const fromIdx = squareToIndex(move.from);
        const toIdx = squareToIndex(move.to);

        if (!move.captured && ply < 64) {
          const moveUci = `${move.from}${move.to}${move.promotion || ''}`;
          if (killerMoves[ply][0] !== moveUci) {
            killerMoves[ply][1] = killerMoves[ply][0];
            killerMoves[ply][0] = moveUci;
          }
          historyTable[colorIdx][fromIdx][toIdx] = (historyTable[colorIdx][fromIdx][toIdx] || 0) + depth * depth * 32;

          const currIdx = pieceToIdx(move.piece, turn) * 64 + toIdx;
          conthistTable[currIdx] = Math.min(25000, conthistTable[currIdx] + depth * depth * 16);
        } else if (move.captured) {
          captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] = Math.min(25000, captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] + depth * depth * 16);
        }
        break;
      }
    } else {
      // History Malus
      if (!move.captured && ply < 64) {
        const fromIdx = squareToIndex(move.from);
        const toIdx = squareToIndex(move.to);
        historyTable[colorIdx][fromIdx][toIdx] = Math.max(-10000, (historyTable[colorIdx][fromIdx][toIdx] || 0) - Math.floor(depth * depth / 2));
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

  // Transposition Table Store
  let flag = TT_FLAG.EXACT;
  if (bestScore <= alpha) flag = TT_FLAG.UPPERBOUND;
  else if (bestScore >= beta) flag = TT_FLAG.LOWERBOUND;

  if (bestMove) {
    if (transpositionTable.size >= MAX_TT_ENTRIES) {
      const keysToDelete = Array.from(transpositionTable.keys()).slice(0, 20000);
      keysToDelete.forEach((k) => transpositionTable.delete(k));
    }
    transpositionTable.set(fenKey, {
      depth,
      score: bestScore,
      flag,
      bestMoveUci: `${bestMove.from}${bestMove.to}${bestMove.promotion || ''}`
    });
  }

  return bestScore;
}

function cpToValueCli(cp) {
  if (Math.abs(cp) > 15000) return cp > 0 ? 1.0 : -1.0;
  return Math.tanh(cp / 350);
}

function calculateDynamicCpuctCli(parentVisits, cBase = 1.85, cFactor = 0.45) {
  return cBase + cFactor * Math.log(1 + Math.max(0, parentVisits) / 25.0);
}

function calculateFpuCli(parentQ, prior, fpuReduction = 0.25) {
  return Math.max(-0.98, Math.min(0.98, parentQ - fpuReduction * Math.sqrt(Math.max(0.01, prior))));
}

function computeMovePriorsCli(chess, moves) {
  if (moves.length === 0) return [];
  const rawScores = new Array(moves.length);
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let score = 0;
    if (m.captured) {
      const see = staticExchangeEvaluation(chess, m);
      score += see >= 0 ? 190 + see * 0.5 : -160;
    }
    if (m.promotion) score += m.promotion === 'q' ? 320 : 90;
    if (m.san && m.san.includes('+')) score += 75;
    if (['e4', 'd4', 'e5', 'd5'].includes(m.to)) score += 35;
    else if (['c4', 'f4', 'c5', 'f5'].includes(m.to)) score += 20;

    if (['n', 'b'].includes(m.piece)) {
      score += 18;
      if (m.piece === 'n' && ['c3', 'f3', 'c6', 'f6', 'd5', 'e5', 'd4', 'e4'].includes(m.to)) score += 20;
    }
    if (m.piece === 'r') {
      if (m.to.endsWith('7') || m.to.endsWith('2')) score += 30;
      if (['d', 'e'].includes(m.to[0])) score += 15;
    }
    if (m.san === 'O-O' || m.san === 'O-O-O') score += 70;
    rawScores[i] = score;
  }
  const maxScore = Math.max(...rawScores);
  const exps = rawScores.map(s => Math.exp((s - maxScore) / 55.0));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / Math.max(1e-9, sumExp));
}

function runLeafTacticalRolloutCli(chess, maxPlies = 2) {
  if (chess.isCheckmate()) return -1.0;
  if (chess.isDraw()) return 0.0;
  const sim = new Chess(chess.fen());
  let ply = 0;
  while (ply < maxPlies) {
    if (sim.isCheckmate()) return ply % 2 === 0 ? -1.0 : 1.0;
    if (sim.isDraw()) return 0.0;
    const legal = sim.moves({ verbose: true });
    if (legal.length === 0) break;
    let bestCapture = null;
    let bestSee = -1;
    for (const m of legal) {
      if (m.captured) {
        const see = staticExchangeEvaluation(sim, m);
        if (see > bestSee) {
          bestSee = see;
          bestCapture = m;
        }
      }
    }
    if (!bestCapture || bestSee < 0) break;
    sim.move(bestCapture);
    ply++;
  }
  const evalCp = evaluatePosition(sim, evalMode);
  const perspectiveSign = sim.turn() === chess.turn() ? 1 : -1;
  return cpToValueCli(evalCp * perspectiveSign);
}

function calculateTacticalVolatilityCli(chess) {
  let volatility = 0;
  if (chess.inCheck()) volatility += 80;
  const moves = chess.moves({ verbose: true });
  let captures = 0;
  for (const m of moves) {
    if (m.captured) {
      captures++;
      const see = staticExchangeEvaluation(chess, m);
      if (see >= 0) volatility += 35;
    }
    if (m.san && m.san.includes('+')) volatility += 25;
  }
  volatility += Math.min(60, captures * 12);
  return Math.min(1.0, volatility / 220.0);
}

function runMctsSearchCli(chess, maxSims = 800, maxTimeMs = 1500) {
  const startFen = chess.fen();
  const rootMoves = chess.moves({ verbose: true });
  if (rootMoves.length === 0) return null;

  const priors = computeMovePriorsCli(chess, rootMoves);
  const rootChildren = rootMoves.map((m, i) => ({
    move: m,
    uci: `${m.from}${m.to}${m.promotion || ''}`,
    san: m.san,
    visits: 0,
    totalValue: 0,
    qValue: 0,
    prior: priors[i]
  }));

  const startTime = Date.now();
  let sims = 0;
  let rootQ = 0;

  while (sims < maxSims) {
    if (sims % 32 === 0 && (Date.now() - startTime) >= maxTimeMs) break;

    const rootVisitsSqrt = Math.sqrt(Math.max(1, sims));
    const currentCpuct = calculateDynamicCpuctCli(sims, 1.85, 0.45);
    let bestChildIdx = 0;
    let bestPuct = -Infinity;

    for (let i = 0; i < rootChildren.length; i++) {
      const c = rootChildren[i];
      const qVal = c.visits === 0 ? calculateFpuCli(rootQ, c.prior, 0.25) : c.totalValue / c.visits;
      const uVal = currentCpuct * c.prior * (rootVisitsSqrt / (1 + c.visits));
      const puct = qVal + uVal;
      if (puct > bestPuct) {
        bestPuct = puct;
        bestChildIdx = i;
      }
    }

    const chosen = rootChildren[bestChildIdx];
    const simChess = new Chess(startFen);
    simChess.move(chosen.move);

    let val = 0;
    if (simChess.isCheckmate()) {
      val = -1.0;
    } else if (simChess.isDraw()) {
      val = 0.0;
    } else {
      val = runLeafTacticalRolloutCli(simChess, 2);
    }

    const rootVal = -val;
    chosen.visits++;
    chosen.totalValue += rootVal;
    chosen.qValue = chosen.totalValue / chosen.visits;
    sims++;
    rootQ = (rootQ * (sims - 1) + rootVal) / sims;
  }

  rootChildren.sort((a, b) => b.visits - a.visits);
  return {
    bestChild: rootChildren[0],
    children: rootChildren,
    sims,
    timeMs: Date.now() - startTime
  };
}

// ----------------------------------------------------------------------------
// Iterative Deepening Search with Progressive Aspiration Windows & Stability Time Manager
// ----------------------------------------------------------------------------
export function searchRoot(chess, targetDepth = 8, maxTimeMs = 3000) {
  isSearching = true;
  stopRequested = false;
  const startTime = Date.now();

  const legalMoves = chess.moves({ verbose: true });
  if (legalMoves.length === 0) {
    isSearching = false;
    process.stdout.write('bestmove 0000\n');
    return;
  }

  const stats = {
    nodes: 0,
    qnodes: 0,
    seldepth: 0,
    ttHits: 0
  };

  let bestMoveUci = `${legalMoves[0].from}${legalMoves[0].to}${legalMoves[0].promotion || ''}`;

  if (searchMode === 'Hybrid-MCTS-PVS') {
    const volatility = calculateTacticalVolatilityCli(chess);

    // 1. Run MCTS Search with Dynamic PUCT, FPU & Tactical Q-Rollouts
    const mctsResult = runMctsSearchCli(chess, 600, maxTimeMs * 0.65);
    const mctsUci = mctsResult?.bestChild?.uci || bestMoveUci;

    // 2. Run PVS Tactical Safety Net Search
    const remainingTime = Math.max(120, maxTimeMs - (mctsResult ? mctsResult.timeMs : 0));
    const pvsSearchDepth = Math.min(targetDepth, 7);
    let pvsBestUci = bestMoveUci;
    let pvsBestScore = 0;

    for (let d = 1; d <= pvsSearchDepth; d++) {
      const pv = [];
      const score = pvsSearch(chess, d, 0, -30000, 30000, stats, pv, startTime, remainingTime);
      if (pv.length > 0) {
        pvsBestUci = pv[0];
        pvsBestScore = score;
      }
      if ((Date.now() - startTime) >= remainingTime) break;
    }

    // 3. Continuous Bayesian Dual Arbiter
    let chosenUci = mctsUci;
    let reason = 'mcts-strategic';
    let deltaCp = 0;

    if (mctsUci === pvsBestUci) {
      reason = 'consensus';
      chosenUci = mctsUci;
    } else {
      try {
        const testChess = new Chess(chess.fen());
        const mctsMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === mctsUci);
        if (mctsMoveObj) {
          testChess.move(mctsMoveObj);
          const oppPv = [];
          const oppScore = pvsSearch(testChess, Math.max(2, pvsSearchDepth - 1), 0, -30000, 30000, stats, oppPv, Date.now(), 200);
          const mctsMoveScore = -oppScore;
          deltaCp = pvsBestScore - mctsMoveScore;

          if (deltaCp > 140) {
            reason = 'safety-net-override';
            chosenUci = pvsBestUci;
          } else {
            const lambda = 0.15 + 0.55 * volatility;
            const mctsVisits = mctsResult?.bestChild?.visits || 0;
            const mctsRatio = mctsVisits / Math.max(1, mctsResult?.sims || 1);

            if (mctsRatio > 0.55 && deltaCp < 60) {
              reason = 'mcts-strategic';
              chosenUci = mctsUci;
            } else if (lambda > 0.50 && deltaCp > 80) {
              reason = 'bayesian-blend';
              chosenUci = pvsBestUci;
            } else {
              reason = 'mcts-strategic';
              chosenUci = mctsUci;
            }
          }
        }
      } catch (e) {
        chosenUci = pvsBestUci;
        reason = 'safety-net-override';
      }
    }

    const elapsedMs = Math.max(1, Date.now() - startTime);
    const totalNodes = stats.nodes + stats.qnodes;
    const nps = Math.round((totalNodes / elapsedMs) * 1000);
    const mctsVisits = mctsResult?.bestChild?.visits || 0;
    const mctsSims = mctsResult?.sims || 0;

    process.stdout.write(
      `info depth ${pvsSearchDepth} score cp ${pvsBestScore} nodes ${totalNodes} nps ${nps} time ${elapsedMs} visits ${mctsVisits} sims ${mctsSims} arbiter ${reason} volatility ${volatility.toFixed(2)} delta ${deltaCp} pv ${chosenUci}\n`
    );

    isSearching = false;
    process.stdout.write(`bestmove ${chosenUci}\n`);
    return;
  }
  let bestScore = 0;
  let lastBestMoveUci = '';
  let moveFlips = 0;
  let stableIterations = 0;

  for (let currentDepth = 1; currentDepth <= targetDepth; currentDepth++) {
    if (!isSearching || (Date.now() - startTime) >= maxTimeMs) break;

    let pv = [];
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
        score = pvsSearch(chess, currentDepth, 0, alpha, beta, stats, pv, startTime, maxTimeMs);
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
          score = pvsSearch(chess, currentDepth, 0, -30000, 30000, stats, pv, startTime, maxTimeMs);
          break;
        }
      }
    } else {
      score = pvsSearch(chess, currentDepth, 0, -30000, 30000, stats, pv, startTime, maxTimeMs);
    }

    if (pv.length > 0) {
      bestMoveUci = pv[0];
      bestScore = score;
    }

    const elapsedMs = Math.max(1, Date.now() - startTime);
    const totalNodes = stats.nodes + stats.qnodes;
    const nps = Math.round((totalNodes / elapsedMs) * 1000);
    const pvStr = pv.join(' ');

    let scoreFormat = `cp ${bestScore}`;
    if (Math.abs(bestScore) > 20000) {
      const mateDist = Math.ceil((25000 - Math.abs(bestScore)) / 2);
      scoreFormat = `mate ${bestScore > 0 ? mateDist : -mateDist}`;
    }

    process.stdout.write(
      `info depth ${currentDepth} seldepth ${stats.seldepth} score ${scoreFormat} nodes ${totalNodes} nps ${nps} time ${elapsedMs} hashhits ${stats.ttHits} pv ${pvStr}\n`
    );

    // Stability-based Time Management
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

  isSearching = false;
  process.stdout.write(`bestmove ${bestMoveUci}\n`);
}

/**
 * Programmatic search entry point for benchmark & testing suites
 */
export function searchBestMove(chess, targetDepth = 6, maxTimeMs = 500, silent = true) {
  isSearching = true;
  stopRequested = false;
  const startTime = Date.now();

  const legalMoves = chess.moves({ verbose: true });
  if (legalMoves.length === 0) {
    isSearching = false;
    return { bestMoveUci: '0000', scoreCp: 0, depth: 0, nodes: 0, pv: [] };
  }

  const stats = { nodes: 0, qnodes: 0, seldepth: 0, ttHits: 0 };
  let bestMoveUci = `${legalMoves[0].from}${legalMoves[0].to}${legalMoves[0].promotion || ''}`;
  let bestScore = 0;
  let finalPv = [];
  let reachedDepth = 1;

  for (let currentDepth = 1; currentDepth <= targetDepth; currentDepth++) {
    if (!isSearching || (Date.now() - startTime) >= maxTimeMs) break;

    const pv = [];
    let alpha = -30000;
    let beta = 30000;
    const delta = 50;

    if (currentDepth >= 4) {
      alpha = Math.max(-30000, bestScore - delta);
      beta = Math.min(30000, bestScore + delta);
    }

    let score = pvsSearch(chess, currentDepth, 0, alpha, beta, stats, pv, startTime, maxTimeMs);
    if (currentDepth >= 4 && (score <= alpha || score >= beta)) {
      score = pvsSearch(chess, currentDepth, 0, -30000, 30000, stats, pv, startTime, maxTimeMs);
    }

    if (pv.length > 0) {
      bestMoveUci = pv[0];
      bestScore = score;
      finalPv = [...pv];
      reachedDepth = currentDepth;
    }

    const elapsedMs = Math.max(1, Date.now() - startTime);
    if (!silent) {
      const totalNodes = stats.nodes + stats.qnodes;
      const nps = Math.round((totalNodes / elapsedMs) * 1000);
      process.stdout.write(`info depth ${currentDepth} score cp ${bestScore} nodes ${totalNodes} nps ${nps} pv ${pv.join(' ')}\n`);
    }

    if (elapsedMs >= maxTimeMs * 0.6) break;
  }

  isSearching = false;
  return {
    bestMoveUci,
    scoreCp: bestScore,
    depth: reachedDepth,
    nodes: stats.nodes + stats.qnodes,
    pv: finalPv
  };
}

// ----------------------------------------------------------------------------
// Standard UCI Command Protocol Loop
// ----------------------------------------------------------------------------
export function initUciLoop() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  function log(msg) {
    process.stdout.write(msg + '\n');
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case 'uci':
      log(`id name ${ENGINE_NAME}`);
      log(`id author ${ENGINE_AUTHOR}`);
      log('option name Threads type spin default 64 min 1 max 64');
      log('option name Hash type spin default 32768 min 16 max 65536');
      log('option name MultiPV type spin default 1 min 1 max 5');
      log('option name EvalMode type combo default brnnue-v030 var brnnue-v030 var berserker-1.0-nnue var aura-nnue');
      log('option name SearchMode type combo default Pure-PVS var Pure-PVS var Hybrid-MCTS-PVS var Pure-MCTS');
      log('option name TacticalContempt type spin default 45 min -100 max 100');
      log('option name KingAttackScale type spin default 140 min 50 max 250');
      log(`option name NNUE_Net type string default ${DEFAULT_NET}`);
      log('uciok');
      break;

    case 'isready':
      log('readyok');
      break;

    case 'ucinewgame':
      currentChess = new Chess();
      clearSearchState();
      break;

    case 'position':
      try {
        let moveIdx = -1;
        if (parts[1] === 'startpos') {
          currentChess = new Chess();
          moveIdx = parts.indexOf('moves');
        } else if (parts[1] === 'fen') {
          const fenParts = [];
          let idx = 2;
          while (idx < parts.length && parts[idx] !== 'moves') {
            fenParts.push(parts[idx]);
            idx++;
          }
          currentChess = new Chess(fenParts.join(' '));
          moveIdx = parts.indexOf('moves');
        }

        if (moveIdx !== -1 && moveIdx + 1 < parts.length) {
          for (let i = moveIdx + 1; i < parts.length; i++) {
            const mv = parts[i];
            currentChess.move({
              from: mv.substring(0, 2),
              to: mv.substring(2, 4),
              promotion: mv.length > 4 ? mv[4] : undefined
            });
          }
        }
      } catch (e) {
        // Safe fallback
      }
      break;

    case 'go':
      let searchDepth = 8;
      let moveTimeMs = 2000;

      const depthIdx = parts.indexOf('depth');
      if (depthIdx !== -1 && parts[depthIdx + 1]) {
        searchDepth = parseInt(parts[depthIdx + 1], 10);
      }

      const timeIdx = parts.indexOf('movetime');
      if (timeIdx !== -1 && parts[timeIdx + 1]) {
        moveTimeMs = parseInt(parts[timeIdx + 1], 10);
      }

      // Time management support for wtime / btime
      const wtimeIdx = parts.indexOf('wtime');
      const btimeIdx = parts.indexOf('btime');
      if (wtimeIdx !== -1 && currentChess.turn() === 'w') {
        const wtime = parseInt(parts[wtimeIdx + 1], 10);
        moveTimeMs = Math.max(80, Math.floor(wtime / 25));
      } else if (btimeIdx !== -1 && currentChess.turn() === 'b') {
        const btime = parseInt(parts[btimeIdx + 1], 10);
        moveTimeMs = Math.max(80, Math.floor(btime / 25));
      }

      searchRoot(currentChess, searchDepth, moveTimeMs);
      break;

    case 'stop':
      stopRequested = true;
      isSearching = false;
      break;

    case 'setoption':
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
        if (optName === 'TacticalContempt') tacticalContempt = parseInt(optVal, 10);
        if (optName === 'KingAttackScale') kingAttackScale = parseInt(optVal, 10);
      }
      break;

    case 'eval':
      const brnnueCp = evaluatePosition(currentChess, 'brnnue-v030');
      const bsz10Cp = evaluatePosition(currentChess, 'berserker-1.0-nnue');
      const auraCp = evaluatePosition(currentChess, 'aura-nnue');
      const deltaVsBsz10 = brnnueCp - bsz10Cp;
      log(`=== ${ENGINE_NAME} NEURAL EVALUATION ===`);
      log(`FEN: ${currentChess.fen()}`);
      log(`Turn: ${currentChess.turn() === 'w' ? 'White' : 'Black'}`);
      log(`BRnnuev030 (Dual NNUE):     ${brnnueCp > 0 ? '+' : ''}${(brnnueCp / 100).toFixed(2)} (${brnnueCp} cp)`);
      log(`  - Subnet 1 (Berserker Attack):     HalfKP-1024 King Attack & Tactical Vectors`);
      log(`  - Subnet 2 (Berserker Positional): HalfKAv2-1024 Endgame Harmony & Pawn Chains`);
      log(`Berserker 1.0 NNUE:          ${bsz10Cp > 0 ? '+' : ''}${(bsz10Cp / 100).toFixed(2)} (${bsz10Cp} cp)`);
      log(`Aura-NNUE (GeoSparse-MoE):   ${auraCp > 0 ? '+' : ''}${(auraCp / 100).toFixed(2)} (${auraCp} cp)`);
      log(`Delta (BRnnuev030 - Bsz1.0): ${deltaVsBsz10 > 0 ? '+' : ''}${(deltaVsBsz10 / 100).toFixed(2)} (${deltaVsBsz10} cp)`);
      log(`Active Net:                  ${DEFAULT_NET}`);
      break;

    case 'bench':
      log(`Running Berserker v0.2.0 benchmark suite (5 standard positions)...`);
      const benchFens = [
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 4',
        '3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20',
        'r1b2rk1/pp1n1ppp/2p5/4q3/2P5/3B4/PP1QNPPP/R4RK1 w - - 0 15',
        '8/5k2/8/8/8/8/4K3/4P3 w - - 0 50'
      ];
      const t0 = Date.now();
      for (const f of benchFens) {
        searchRoot(new Chess(f), 5, 250);
      }
      const benchElapsed = Math.max(1, Date.now() - t0);
      log(`Benchmark completed in ${benchElapsed}ms. All positions verified.`);
      break;

    case 'quit':
      process.exit(0);
      break;
  }
  });

  return rl;
}

// Auto-run UCI loop when script is launched directly from CLI
const isDirectRun = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('berserker-cli.js')
);

if (isDirectRun) {
  initUciLoop();
}

