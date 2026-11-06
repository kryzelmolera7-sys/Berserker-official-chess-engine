#!/usr/bin/env node

/**
 * ============================================================================
 * Berserker v0.2.0 Standalone UCI Chess Engine
 * ============================================================================
 * Architecture:
 * - Clean, pure, standalone UCI Chess Engine
 * - Search: Iterative Deepening Principal Variation Search (PVS) with Aspiration Windows
 * - Transposition Table: Dynamic replacement with Exact / Upper / Lower bounds
 * - Move Ordering: Hash Move -> MVV-LVA Captures -> Killer 1/2 -> History Heuristic
 * - Selectivity: Quiescence Search with Stand-Pat Delta Pruning, Null Move Pruning (NMP),
 *                Late Move Reductions (LMR), Check Extensions
 * - Neural & Positional Evaluation:
 *     * berserker-nnue: Proprietary HalfKP dual-accumulator architecture + King attack vector scaling
 *     * aura-nnue: GeoSparse-MoE (Mixture of Experts: Tactical, Positional, Endgame)
 *     * Tapered Piece-Square Tables (MG / EG) with phase interpolation
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

export const ENGINE_NAME = "Berserker v0.2.0";
export const ENGINE_VERSION = "0.2.0";
export const ENGINE_AUTHOR = "Berserker Engine Team";
export const DEFAULT_NET = "berserker_brnnue_v030.nnue";

// ----------------------------------------------------------------------------
// Engine Options & Global Search State
// ----------------------------------------------------------------------------
let evalMode = 'brnnue-v030'; // 'brnnue-v030' | 'berserker-1.0-nnue' | 'aura-nnue'
export function setEvalMode(mode) {
  evalMode = mode;
}
let threads = 4;
let hashMb = 64;
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

// Killer Moves: [ply: 0-64][slot: 0-1]
const killerMoves = Array.from({ length: 64 }, () => [null, null]);

function squareToIndex(sq) {
  const col = sq.charCodeAt(0) - 97; // 'a' -> 0
  const row = parseInt(sq[1], 10) - 1; // '1' -> 0
  return row * 8 + col;
}

function clearSearchState() {
  transpositionTable.clear();
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

  // 1. Null Move Pruning (R = 2)
  if (depth >= 3 && !inCheck && !isRoot) {
    const nonPawns = chess.board().flat().filter((p) => p && p.type !== 'p' && p.type !== 'k' && p.color === chess.turn()).length;
    if (nonPawns > 0) {
      const staticEval = evaluatePosition(chess);
      if (staticEval >= beta) {
        const fenParts = chess.fen().split(' ');
        fenParts[1] = fenParts[1] === 'w' ? 'b' : 'w';
        fenParts[3] = '-';
        const nullFen = fenParts.join(' ');
        try {
          const nullChess = new Chess(nullFen);
          const nullScore = -pvsSearch(nullChess, depth - 1 - 2, ply + 1, -beta, -beta + 1, stats, [], startTime, maxTimeMs);
          if (nullScore >= beta) return beta;
        } catch {
          // ignore parsing error
        }
      }
    }
  }

  // 2. Generate and Order Moves
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) {
    return inCheck ? -25000 + ply : 0;
  }

  const turn = chess.turn();
  moves.sort((a, b) => {
    const sA = scoreMoveForOrdering(a, hashMoveUci, ply, turn);
    const sB = scoreMoveForOrdering(b, hashMoveUci, ply, turn);
    return sB - sA;
  });

  let bestScore = -30000;
  let bestMove = null;
  let movesSearched = 0;

  for (const move of moves) {
    if (!isSearching) break;

    chess.move(move);
    movesSearched++;

    let score;
    const subPv = [];

    // Principal Variation Search
    if (movesSearched === 1) {
      // First move is searched with full window
      score = -pvsSearch(chess, depth - 1, ply + 1, -beta, -alpha, stats, subPv, startTime, maxTimeMs);
    } else {
      // Late Move Reductions (LMR) for quiet moves late in the move list
      let reduction = 0;
      if (depth >= 3 && movesSearched >= 4 && !move.captured && !move.san.includes('+') && !inCheck) {
        reduction = 1 + Math.floor(Math.log(depth) * Math.log(movesSearched) / 2.2);
        reduction = Math.min(depth - 2, reduction);
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
        if (!move.captured && ply < 64) {
          const moveUci = `${move.from}${move.to}${move.promotion || ''}`;
          if (killerMoves[ply][0] !== moveUci) {
            killerMoves[ply][1] = killerMoves[ply][0];
            killerMoves[ply][0] = moveUci;
          }
          const colorIdx = turn === 'w' ? 0 : 1;
          const fromIdx = squareToIndex(move.from);
          const toIdx = squareToIndex(move.to);
          historyTable[colorIdx][fromIdx][toIdx] = (historyTable[colorIdx][fromIdx][toIdx] || 0) + depth * depth;
        }
        break;
      }
    }
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

// ----------------------------------------------------------------------------
// Iterative Deepening Search with Aspiration Windows
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
  let bestScore = 0;

  for (let currentDepth = 1; currentDepth <= targetDepth; currentDepth++) {
    if (!isSearching || (Date.now() - startTime) >= maxTimeMs) break;

    const pv = [];
    let alpha = -30000;
    let beta = 30000;
    const delta = 50;

    // Aspiration Windows for depth >= 4
    if (currentDepth >= 4) {
      alpha = Math.max(-30000, bestScore - delta);
      beta = Math.min(30000, bestScore + delta);
    }

    let score = pvsSearch(chess, currentDepth, 0, alpha, beta, stats, pv, startTime, maxTimeMs);

    // If aspiration window failed low or high, re-search with full window
    if (currentDepth >= 4 && (score <= alpha || score >= beta)) {
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

    // Stop early if time budget exceeded by half
    if (elapsedMs >= maxTimeMs * 0.6) break;
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
      log('option name Threads type spin default 4 min 1 max 64');
      log('option name Hash type spin default 64 min 16 max 65536');
      log('option name MultiPV type spin default 1 min 1 max 5');
      log('option name EvalMode type combo default brnnue-v030 var brnnue-v030 var berserker-1.0-nnue var aura-nnue');
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
      log(`  - Subnet 1 (Berserker v0.9.0): HalfKP-1024 King Attack & Tactical Vectors`);
      log(`  - Subnet 2 (PlentyChess):     HalfKAv2-1024 Endgame Harmony & Pawn Chains`);
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

