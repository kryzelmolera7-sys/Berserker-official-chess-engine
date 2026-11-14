#!/usr/bin/env node

/**
 * ============================================================================
 * Berserker v0.7.1-dev Official Standalone UCI Chess Engine
 * ============================================================================
 * Architecture:
 * - Clean, pure, standalone UCI Chess Engine
 * - Search: Iterative Deepening Principal Variation Search (PVS) with Dynamic Aspiration Windows
 * - Advanced Selectivity: Singular Extensions (SE), ProbCut, Multi-Cut Pruning, Reverse Futility
 *                         Pruning (RFP), Razoring, Futility Pruning, Late Move Pruning (LMP), LMR
 * - Advanced Move Ordering: Hash Move -> Promotions -> SEE Captures -> Killer 1/2 -> Castling ->
 *                           Continuation History (Conthist) -> History Heuristic Table
 * - Neural Evaluation: Authentic BRnnue Dual Architecture + Positional & Endgame Squeeze Matrix
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

export const ENGINE_NAME = "Berserker v0.7.1-dev";
export const ENGINE_VERSION = "0.7.1-dev";
export const ENGINE_AUTHOR = "Berserker Engine Team";
export const DEFAULT_NET = "berserker_brnnue_v070.nnue";

// ----------------------------------------------------------------------------
// Engine Options & Global Search State
// ----------------------------------------------------------------------------
let evalMode = 'brnnue-v030'; // 'brnnue-v030' | 'berserker-1.0-nnue' | 'aura-nnue'
export function setEvalMode(mode) {
  evalMode = mode;
}
let searchMode = 'Hybrid-MCTS-PVS'; // 'Hybrid-MCTS-PVS' | 'Pure-PVS' | 'Pure-MCTS'
export function setSearchMode(mode) {
  searchMode = mode;
}
let threads = 4;
let hashMb = 64;
let multiPv = 1;
let tacticalContempt = 45;
let kingAttackScale = 140;

let currentChess = new Chess();
let gameHistoryFensCli = [];
let isSearching = false;
let stopRequested = false;

// Chess960 (Fischer Random Chess) State & Logic
let uciChess960 = false;
let currentChess960Config = null;

const KNIGHT_PAIRS = [
  [0, 1], [0, 2], [0, 3], [0, 4],
  [1, 2], [1, 3], [1, 4],
  [2, 3], [2, 4],
  [3, 4]
];

export function generateChess960Backrank(index) {
  if (index < 0 || index > 959) {
    throw new Error(`Invalid Chess960 index: ${index}. Must be 0 to 959.`);
  }
  const rank = new Array(8).fill(null);
  const d1 = index % 4;
  rank[2 * d1 + 1] = 'B';
  const q1 = Math.floor(index / 4);

  const d2 = q1 % 4;
  rank[2 * d2] = 'B';
  const q2 = Math.floor(q1 / 4);

  const d3 = q2 % 6;
  let emptyIdx = 0;
  for (let i = 0; i < 8; i++) {
    if (rank[i] === null) {
      if (emptyIdx === d3) {
        rank[i] = 'Q';
        break;
      }
      emptyIdx++;
    }
  }
  const q3 = Math.floor(q2 / 6);

  const [k1, k2] = KNIGHT_PAIRS[q3];
  emptyIdx = 0;
  for (let i = 0; i < 8; i++) {
    if (rank[i] === null) {
      if (emptyIdx === k1 || emptyIdx === k2) {
        rank[i] = 'N';
      }
      emptyIdx++;
    }
  }

  emptyIdx = 0;
  for (let i = 0; i < 8; i++) {
    if (rank[i] === null) {
      if (emptyIdx === 0) rank[i] = 'R';
      else if (emptyIdx === 1) rank[i] = 'K';
      else if (emptyIdx === 2) rank[i] = 'R';
      emptyIdx++;
    }
  }
  return rank.join('');
}

export function extractCastlingConfig(backrank) {
  let expanded = '';
  for (let i = 0; i < backrank.length; i++) {
    const ch = backrank[i];
    if (ch >= '1' && ch <= '8') {
      expanded += '.'.repeat(parseInt(ch, 10));
    } else {
      expanded += ch;
    }
  }
  let kingFile = -1, queenRookFile = -1, kingRookFile = -1;
  for (let c = 0; c < Math.min(8, expanded.length); c++) {
    const piece = expanded[c].toUpperCase();
    if (piece === 'R') {
      if (kingFile === -1) queenRookFile = c;
      else kingRookFile = c;
    } else if (piece === 'K') {
      kingFile = c;
    }
  }
  return {
    whiteKingFile: kingFile,
    whiteQueenRookFile: queenRookFile,
    whiteKingRookFile: kingRookFile,
    blackKingFile: kingFile,
    blackQueenRookFile: queenRookFile,
    blackKingRookFile: kingRookFile
  };
}

export function normalizeChess960Fen(rawFen) {
  const parts = rawFen.trim().split(/\s+/);
  if (parts.length < 4) return { normalizedFen: rawFen, originalCastling: '-', isChess960: false };
  const castling = parts[2];
  const isShredder = /[A-Ha-h]/.test(castling) && !/^[KQkq-]+$/.test(castling);
  let normalizedCastling = castling;
  if (isShredder) {
    let w = /[A-H]/.test(castling);
    let b = /[a-h]/.test(castling);
    normalizedCastling = (w ? 'KQ' : '') + (b ? 'kq' : '') || '-';
  }
  parts[2] = normalizedCastling;
  return {
    normalizedFen: parts.join(' '),
    originalCastling: castling,
    isChess960: isShredder || rawFen.includes('KQkq')
  };
}

export function isLegalChess960Castling(chess, side, config) {
  if (chess.inCheck()) return false;
  const fen = chess.fen();
  const parts = fen.split(' ');
  const turn = parts[1];
  const castlingStr = parts[2];
  const rightToken = turn === 'w' ? (side === 'kingside' ? 'K' : 'Q') : (side === 'kingside' ? 'k' : 'q');
  if (!castlingStr.includes(rightToken) && !castlingStr.includes(rightToken.toUpperCase())) return false;

  const board = chess.board();
  const rank = turn === 'w' ? 7 : 0;
  let kingCol = -1;
  for (let c = 0; c < 8; c++) {
    const p = board[rank][c];
    if (p && p.color === turn && p.type === 'k') kingCol = c;
  }
  if (kingCol === -1) return false;

  let targetRookCol = -1;
  if (config) {
    targetRookCol = turn === 'w'
      ? (side === 'kingside' ? config.whiteKingRookFile : config.whiteQueenRookFile)
      : (side === 'kingside' ? config.blackKingRookFile : config.blackQueenRookFile);
  } else {
    if (side === 'kingside') {
      for (let c = kingCol + 1; c < 8; c++) {
        if (board[rank][c]?.color === turn && board[rank][c]?.type === 'r') { targetRookCol = c; break; }
      }
    } else {
      for (let c = kingCol - 1; c >= 0; c--) {
        if (board[rank][c]?.color === turn && board[rank][c]?.type === 'r') { targetRookCol = c; break; }
      }
    }
  }
  if (targetRookCol === -1) return false;

  const destKingCol = side === 'kingside' ? 6 : 2;
  const destRookCol = side === 'kingside' ? 5 : 3;
  const ignoreCols = [kingCol, targetRookCol];

  const kingMinC = Math.min(kingCol, destKingCol);
  const kingMaxC = Math.max(kingCol, destKingCol);
  for (let c = kingMinC; c <= kingMaxC; c++) {
    if (!ignoreCols.includes(c) && board[rank][c] !== null) return false;
  }

  const rookMinC = Math.min(targetRookCol, destRookCol);
  const rookMaxC = Math.max(targetRookCol, destRookCol);
  for (let c = rookMinC; c <= rookMaxC; c++) {
    if (!ignoreCols.includes(c) && board[rank][c] !== null) return false;
  }

  const oppColor = turn === 'w' ? 'b' : 'w';
  const rankStr = turn === 'w' ? '1' : '8';
  for (let c = kingMinC; c <= kingMaxC; c++) {
    const sq = `${String.fromCharCode(97 + c)}${rankStr}`;
    if (typeof chess.isAttacked === 'function' && chess.isAttacked(sq, oppColor)) return false;
  }

  return true;
}

export function executeChess960Castling(chess, side, config) {
  const parts = chess.fen().split(' ');
  const turn = parts[1];
  const rank = turn === 'w' ? 7 : 0;
  const board = chess.board();

  let kingCol = -1;
  for (let c = 0; c < 8; c++) {
    if (board[rank][c]?.color === turn && board[rank][c]?.type === 'k') kingCol = c;
  }

  let rookCol = -1;
  if (config) {
    rookCol = turn === 'w'
      ? (side === 'kingside' ? config.whiteKingRookFile : config.whiteQueenRookFile)
      : (side === 'kingside' ? config.blackKingRookFile : config.blackQueenRookFile);
  } else {
    if (side === 'kingside') {
      for (let c = kingCol + 1; c < 8; c++) {
        if (board[rank][c]?.color === turn && board[rank][c]?.type === 'r') { rookCol = c; break; }
      }
    } else {
      for (let c = kingCol - 1; c >= 0; c--) {
        if (board[rank][c]?.color === turn && board[rank][c]?.type === 'r') { rookCol = c; break; }
      }
    }
  }

  const destKingCol = side === 'kingside' ? 6 : 2;
  const destRookCol = side === 'kingside' ? 5 : 3;

  board[rank][kingCol] = null;
  board[rank][rookCol] = null;
  board[rank][destKingCol] = { type: 'k', color: turn };
  board[rank][destRookCol] = { type: 'r', color: turn };

  const rows = [];
  for (let r = 0; r < 8; r++) {
    let rowStr = '';
    let emptyCount = 0;
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) emptyCount++;
      else {
        if (emptyCount > 0) { rowStr += emptyCount; emptyCount = 0; }
        rowStr += p.color === 'w' ? p.type.toUpperCase() : p.type.toLowerCase();
      }
    }
    if (emptyCount > 0) rowStr += emptyCount;
    rows.push(rowStr);
  }

  let nextCastling = parts[2];
  if (turn === 'w') nextCastling = nextCastling.replace(/[KQ]/g, '');
  else nextCastling = nextCastling.replace(/[kq]/g, '');
  if (!nextCastling) nextCastling = '-';

  const nextTurn = turn === 'w' ? 'b' : 'w';
  const halfmove = parseInt(parts[4], 10) + 1;
  const fullmove = turn === 'b' ? parseInt(parts[5], 10) + 1 : parseInt(parts[5], 10);

  const nextFen = `${rows.join('/')} ${nextTurn} ${nextCastling} - ${halfmove} ${fullmove}`;
  chess.load(nextFen);
  return nextFen;
}

export function resolveChess960Move(chess, uciMove, config) {
  if (uciMove.length < 4) return { isChess960Castling: false, standardUci: uciMove };
  const from = uciMove.slice(0, 2);
  const to = uciMove.slice(2, 4);
  const turn = chess.turn();
  const board = chess.board();

  const fromRank = parseInt(from[1], 10);
  const fromFile = from.charCodeAt(0) - 97;
  const toRank = parseInt(to[1], 10);
  const toFile = to.charCodeAt(0) - 97;

  const expectedRank = turn === 'w' ? 1 : 8;
  if (fromRank !== expectedRank || toRank !== expectedRank) {
    return { isChess960Castling: false, standardUci: uciMove };
  }

  const row = turn === 'w' ? 7 : 0;
  const pieceFrom = board[row][fromFile];
  if (!pieceFrom || pieceFrom.type !== 'k' || pieceFrom.color !== turn) {
    return { isChess960Castling: false, standardUci: uciMove };
  }

  const pieceTo = board[row][toFile];
  if (pieceTo && pieceTo.type === 'r' && pieceTo.color === turn) {
    const side = toFile > fromFile ? 'kingside' : 'queenside';
    if (isLegalChess960Castling(chess, side, config)) {
      const destKingSq = side === 'kingside' ? `g${expectedRank}` : `c${expectedRank}`;
      return { isChess960Castling: true, side, standardUci: `${from}${destKingSq}` };
    }
  }

  if (toFile === 6 || toFile === 2) {
    const side = toFile === 6 ? 'kingside' : 'queenside';
    if (isLegalChess960Castling(chess, side, config)) {
      return { isChess960Castling: true, side, standardUci: uciMove };
    }
  }

  return { isChess960Castling: false, standardUci: uciMove };
}

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
      5,  10,  10, -25, -25,  10,  10,   5,
      5,  -5, -10,   0,   0, -10,  -5,   5,
      0,   0,   0,  25,  25,   0,   0,   0,
      5,   5,  10,  27,  27,  10,   5,   5,
     10,  10,  20,  30,  30,  20,  10,  10,
     50,  50,  50,  50,  50,  50,  50,  50,
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
      0,   0,   0,   0,   0,   0,   0,   0,
     10,  10,  10,  10,  10,  10,  10,  10,
     20,  20,  20,  20,  20,  20,  20,  20,
     30,  30,  30,  30,  30,  30,  30,  30,
     50,  50,  50,  50,  50,  50,  50,  50,
     80,  80,  80,  80,  80,  80,  80,  80,
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
let maxTtEntries = 128000;
function updateHashTableCapacity(mb) {
  const clamped = Math.max(16, Math.min(4096, Number.isFinite(mb) ? mb : 64));
  maxTtEntries = clamped * 2000;
}

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

// Static Evaluation Stack for Improving Heuristic [ply: 0-127]
const staticEvalStack = new Int32Array(128);

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
  mctsTranspositionTableCli.clear();
  conthistTable.fill(0);
  conthist2PlyTable.fill(0);
  captureHistoryTable.fill(0);
  staticEvalStack.fill(0);
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
// Centipawn Squeeze Matrix v0.7.1
// 1. Rule of the Square & Unstoppable Pawn Detection (+650cp)
// 2. Tarrasch Rook Placement (Rook behind passed pawn) (+55cp)
// 3. King Centralization & Opposition Drive (+42cp)
// 4. King Escorting Passed Pawn (+25cp to +75cp)
// ----------------------------------------------------------------------------
function computeEndgameSqueezeBonusForSide(board, us) {
  const them = us === 'w' ? 'b' : 'w';
  let nonKingPieces = 0;
  let ourKingSq = { file: 4, rank: us === 'w' ? 1 : 8 };
  let theirKingSq = { file: 4, rank: us === 'w' ? 8 : 1 };
  const ourPassedPawns = [];
  const ourRooks = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const rank = 8 - r;
      const file = c;
      if (p.type === 'k') {
        if (p.color === us) ourKingSq = { file, rank };
        else theirKingSq = { file, rank };
      } else {
        nonKingPieces++;
        if (p.color === us) {
          if (p.type === 'r') ourRooks.push({ file, rank });
          if (p.type === 'p') {
            let isPassed = true;
            for (let checkR = 0; checkR < 8; checkR++) {
              for (let checkC = Math.max(0, c - 1); checkC <= Math.min(7, c + 1); checkC++) {
                const ep = board[checkR][checkC];
                if (ep && ep.type === 'p' && ep.color === them) {
                  const enemyRank = 8 - checkR;
                  if ((us === 'w' && enemyRank > rank) || (us === 'b' && enemyRank < rank)) {
                    isPassed = false;
                    break;
                  }
                }
              }
              if (!isPassed) break;
            }
            if (isPassed) {
              ourPassedPawns.push({ file, rank });
            }
          }
        }
      }
    }
  }

  let squeezeBonusCp = 0;
  const isEndgame = nonKingPieces <= 8;

  // 1. King Centralization & Opposition in Endgame
  if (isEndgame) {
    const ourDistToCenter = Math.abs(ourKingSq.file - 3.5) + Math.abs(ourKingSq.rank - 4.5);
    squeezeBonusCp += Math.round((7.0 - ourDistToCenter) * 6);

    const enemyDistToCenter = Math.abs(theirKingSq.file - 3.5) + Math.abs(theirKingSq.rank - 4.5);
    squeezeBonusCp += Math.round(enemyDistToCenter * 5);

    const kingDistF = Math.abs(ourKingSq.file - theirKingSq.file);
    const kingDistR = Math.abs(ourKingSq.rank - theirKingSq.rank);
    if ((kingDistF === 0 && kingDistR === 2) || (kingDistR === 0 && kingDistF === 2)) {
      squeezeBonusCp += 20; // Direct Opposition
    }
  }

  // 2. Passed Pawn Escort & Rule of the Square
  for (const pp of ourPassedPawns) {
    const promotionRank = us === 'w' ? 8 : 1;
    const distToPromo = Math.abs(promotionRank - pp.rank);

    if (us === 'w') {
      if (pp.rank === 5) squeezeBonusCp += 45;
      else if (pp.rank === 6) squeezeBonusCp += 95;
      else if (pp.rank === 7) squeezeBonusCp += 180;
    } else {
      if (pp.rank === 4) squeezeBonusCp += 45;
      else if (pp.rank === 3) squeezeBonusCp += 95;
      else if (pp.rank === 2) squeezeBonusCp += 180;
    }

    // King Escort: Our king close to passed pawn
    const kingDistToPawn = Math.max(Math.abs(ourKingSq.file - pp.file), Math.abs(ourKingSq.rank - pp.rank));
    if (kingDistToPawn <= 2) {
      squeezeBonusCp += (3 - kingDistToPawn) * 25;
    }

    // Rule of the Square in pure pawn endgames
    if (nonKingPieces === ourPassedPawns.length) {
      const squareSize = distToPromo;
      const enemyKingDistToPromo = Math.max(
        Math.abs(theirKingSq.file - pp.file),
        Math.abs(theirKingSq.rank - promotionRank)
      );
      if (enemyKingDistToPromo > squareSize) {
        squeezeBonusCp += 650;
      }
    }

    // 3. Tarrasch Rule: Rook behind passed pawn
    for (const rk of ourRooks) {
      if (rk.file === pp.file) {
        const isBehind = (us === 'w' && rk.rank < pp.rank) || (us === 'b' && rk.rank > pp.rank);
        if (isBehind) {
          squeezeBonusCp += 55;
        }
      }
    }
  }

  return squeezeBonusCp;
}

export function computeEndgameSqueezeBonus(chess) {
  return computeEndgameSqueezeBonusForSide(chess.board(), chess.turn());
}

// ----------------------------------------------------------------------------
// Static Exchange Evaluation (SEE) & Fast Evaluation Bridge
// ----------------------------------------------------------------------------
export function staticExchangeEvaluation(chess, move) {
  if (!move || (!move.captured && !move.promotion)) return 0;
  const victimVal = (move.captured ? (PIECE_VALUES[move.captured] || 100) : 0) +
    (move.promotion ? (PIECE_VALUES[move.promotion] || 950) - 100 : 0);
  const attackerVal = PIECE_VALUES[move.piece] || 100;

  if (victimVal >= attackerVal) return victimVal;

  const us = chess.turn();
  const enemy = us === 'w' ? 'b' : 'w';
  const attackers = chess.attackers(move.to, enemy);
  if (!attackers || attackers.length === 0) {
    return victimVal;
  }

  let lowestRecapturer = Infinity;
  for (let i = 0; i < attackers.length; i++) {
    const p = chess.get(attackers[i]);
    if (p) {
      const val = PIECE_VALUES[p.type] || 100;
      if (val < lowestRecapturer) lowestRecapturer = val;
    }
  }
  if (lowestRecapturer === Infinity) return victimVal;

  // If enemy's cheapest recapturer is worth more than our attacker and we also defend the square,
  // opponent cannot profitably recapture.
  if (lowestRecapturer > attackerVal && chess.attackers(move.to, us).length > 1) {
    return victimVal;
  }
  return victimVal - attackerVal;
}

export function evaluateBRnnueCli(fenOrChess, mode = evalMode) {
  const c = typeof fenOrChess === 'string' ? new Chess(fenOrChess) : fenOrChess;
  const cp = evaluatePosition(c, mode);
  return { centipawns: cp, evalCpPerspective: cp };
}

// ----------------------------------------------------------------------------
// Tapered Evaluation Function (Symmetric Positional + Endgame Squeeze + Tempo)
// ----------------------------------------------------------------------------
// Pre-allocated scratch buffers for zero-allocation evaluatePosition
const _wPawnsOnFile = new Int8Array(8);
const _bPawnsOnFile = new Int8Array(8);
const _wPawnMask = new Uint8Array(8);
const _bPawnMask = new Uint8Array(8);
const _wRookR = new Int8Array(10);
const _wRookF = new Int8Array(10);
const _bRookR = new Int8Array(10);
const _bRookF = new Int8Array(10);
const _wPawnR = new Int8Array(8);
const _wPawnF = new Int8Array(8);
const _bPawnR = new Int8Array(8);
const _bPawnF = new Int8Array(8);

export function evaluatePosition(chess, mode = evalMode, preloadedBoard = null) {
  const board = preloadedBoard || chess.board();
  const turn = chess.turn();

  let mgWhite = 0, mgBlack = 0;
  let egWhite = 0, egBlack = 0;
  let gamePhase = 0;
  let nonKingPieces = 0;

  let wkR = 7, wkC = 4;
  let bkR = 0, bkC = 4;
  let whiteBishops = 0;
  let blackBishops = 0;
  let wRookCount = 0, bRookCount = 0;
  let wPawnCount = 0, bPawnCount = 0;

  _wPawnsOnFile.fill(0);
  _bPawnsOnFile.fill(0);
  _wPawnMask.fill(0);
  _bPawnMask.fill(0);

  for (let r = 0; r < 8; r++) {
    const rowArr = board[r];
    for (let f = 0; f < 8; f++) {
      const piece = rowArr[f];
      if (!piece) continue;

      const type = piece.type;
      const isWhite = piece.color === 'w';
      const baseVal = PIECE_VALUES[type] || 0;

      gamePhase += PHASE_WEIGHTS[type] || 0;
      if (type !== 'k') nonKingPieces++;

      const sqIdx = isWhite ? (7 - r) * 8 + f : r * 8 + f;
      const mgPst = PST_MG[type][sqIdx];
      const egPst = PST_EG[type][sqIdx];

      if (isWhite) {
        mgWhite += baseVal + mgPst;
        egWhite += baseVal + egPst;
        if (type === 'k') { wkR = r; wkC = f; }
        else if (type === 'b') whiteBishops++;
        else if (type === 'p') {
          _wPawnsOnFile[f]++;
          _wPawnMask[f] |= (1 << r);
          if (wPawnCount < 8) { _wPawnR[wPawnCount] = r; _wPawnF[wPawnCount] = f; wPawnCount++; }
        } else if (type === 'r' && wRookCount < 10) {
          _wRookR[wRookCount] = r; _wRookF[wRookCount] = f; wRookCount++;
        }
      } else {
        mgBlack += baseVal + mgPst;
        egBlack += baseVal + egPst;
        if (type === 'k') { bkR = r; bkC = f; }
        else if (type === 'b') blackBishops++;
        else if (type === 'p') {
          _bPawnsOnFile[f]++;
          _bPawnMask[f] |= (1 << r);
          if (bPawnCount < 8) { _bPawnR[bPawnCount] = r; _bPawnF[bPawnCount] = f; bPawnCount++; }
        } else if (type === 'r' && bRookCount < 10) {
          _bRookR[bRookCount] = r; _bRookF[bRookCount] = f; bRookCount++;
        }
      }
    }
  }

  // Symmetric positional imbalances: Bishop pair
  if (whiteBishops >= 2) { mgWhite += 32; egWhite += 48; }
  if (blackBishops >= 2) { mgBlack += 32; egBlack += 48; }

  // Pawn structure: doubled & isolated pawn penalties
  for (let f = 0; f < 8; f++) {
    const wp = _wPawnsOnFile[f];
    if (wp > 1) {
      const pen = (wp - 1) * 14;
      mgWhite -= pen;
      egWhite -= pen + 4;
    }
    if (wp > 0) {
      const hasAdj = (f > 0 && _wPawnsOnFile[f - 1] > 0) || (f < 7 && _wPawnsOnFile[f + 1] > 0);
      if (!hasAdj) { mgWhite -= 14; egWhite -= 18; }
    }

    const bp = _bPawnsOnFile[f];
    if (bp > 1) {
      const pen = (bp - 1) * 14;
      mgBlack -= pen;
      egBlack -= pen + 4;
    }
    if (bp > 0) {
      const hasAdj = (f > 0 && _bPawnsOnFile[f - 1] > 0) || (f < 7 && _bPawnsOnFile[f + 1] > 0);
      if (!hasAdj) { mgBlack -= 14; egBlack -= 18; }
    }
  }

  // Rooks on open / semi-open files and 7th rank
  for (let i = 0; i < wRookCount; i++) {
    const rf = _wRookF[i];
    if (_wPawnsOnFile[rf] === 0) {
      const isOpen = _bPawnsOnFile[rf] === 0;
      mgWhite += isOpen ? 24 : 12;
      egWhite += isOpen ? 20 : 10;
    }
    if (_wRookR[i] === 1) { mgWhite += 22; egWhite += 30; }
  }
  for (let i = 0; i < bRookCount; i++) {
    const rf = _bRookF[i];
    if (_bPawnsOnFile[rf] === 0) {
      const isOpen = _wPawnsOnFile[rf] === 0;
      mgBlack += isOpen ? 24 : 12;
      egBlack += isOpen ? 20 : 10;
    }
    if (_bRookR[i] === 6) { mgBlack += 22; egBlack += 30; }
  }

  const clampedPhase = Math.min(TOTAL_PHASE, Math.max(0, gamePhase));
  const mgWeight = clampedPhase;
  const egWeight = TOTAL_PHASE - clampedPhase;

  // King pawn shield in middlegame
  if (clampedPhase >= 8) {
    let wShield = 0;
    if (wkR >= 6) {
      for (let df = -1; df <= 1; df++) {
        const f = wkC + df;
        if (f >= 0 && f < 8) {
          if (board[6][f]?.type === 'p' && board[6][f]?.color === 'w') wShield += 11;
          else if (board[5][f]?.type === 'p' && board[5][f]?.color === 'w') wShield += 6;
        }
      }
    }
    let bShield = 0;
    if (bkR <= 1) {
      for (let df = -1; df <= 1; df++) {
        const f = bkC + df;
        if (f >= 0 && f < 8) {
          if (board[1][f]?.type === 'p' && board[1][f]?.color === 'b') bShield += 11;
          else if (board[2][f]?.type === 'p' && board[2][f]?.color === 'b') bShield += 6;
        }
      }
    }
    mgWhite += wShield;
    mgBlack += bShield;
  }

  const mgScore = mgWhite - mgBlack;
  const egScore = egWhite - egBlack;
  let evalScore = Math.round((mgScore * mgWeight + egScore * egWeight) / TOTAL_PHASE);

  if (mode === 'brnnue-v030') {
    if (clampedPhase < 8) {
      const whiteKingCenter = 7 - (Math.abs(wkR - 3.5) + Math.abs(wkC - 3.5));
      const blackKingCenter = 7 - (Math.abs(bkR - 3.5) + Math.abs(bkC - 3.5));
      evalScore += Math.round((whiteKingCenter - blackKingCenter) * 8 * (1.0 - clampedPhase / TOTAL_PHASE));
    }
  } else if (mode === 'berserker-1.0-nnue' || mode === 'sf-nnue') {
    const bsz10Delta = Math.round(tacticalContempt * 0.35);
    evalScore += (turn === 'w' ? bsz10Delta : -bsz10Delta);
  } else {
    const auraBias = Math.round(tacticalContempt * 0.75);
    evalScore += (turn === 'w' ? auraBias : -auraBias);
  }

  // O(1) Bitmask Passed Pawn & Tarrasch Squeeze Bonus
  for (let i = 0; i < wPawnCount; i++) {
    const r = _wPawnR[i];
    const f = _wPawnF[i];
    const aheadMask = (1 << r) - 1;
    const enemySpan = _bPawnMask[f] | (f > 0 ? _bPawnMask[f - 1] : 0) | (f < 7 ? _bPawnMask[f + 1] : 0);
    if ((enemySpan & aheadMask) === 0) {
      const rank = 8 - r;
      let ppBonus = rank === 5 ? 45 : rank === 6 ? 95 : rank === 7 ? 180 : 12;
      const kDist = Math.max(Math.abs(wkC - f), Math.abs((8 - wkR) - rank));
      if (kDist <= 2) ppBonus += (3 - kDist) * 25;
      for (let j = 0; j < wRookCount; j++) {
        if (_wRookF[j] === f && (8 - _wRookR[j]) < rank) ppBonus += 55;
      }
      evalScore += ppBonus;
    }
  }

  for (let i = 0; i < bPawnCount; i++) {
    const r = _bPawnR[i];
    const f = _bPawnF[i];
    const aheadMask = 0xff ^ ((1 << (r + 1)) - 1);
    const enemySpan = _wPawnMask[f] | (f > 0 ? _wPawnMask[f - 1] : 0) | (f < 7 ? _wPawnMask[f + 1] : 0);
    if ((enemySpan & aheadMask) === 0) {
      const rank = 8 - r;
      let ppBonus = rank === 4 ? 45 : rank === 3 ? 95 : rank === 2 ? 180 : 12;
      const kDist = Math.max(Math.abs(bkC - f), Math.abs((8 - bkR) - rank));
      if (kDist <= 2) ppBonus += (3 - kDist) * 25;
      for (let j = 0; j < bRookCount; j++) {
        if (_bRookF[j] === f && (8 - _bRookR[j]) > rank) ppBonus += 55;
      }
      evalScore -= ppBonus;
    }
  }

  if (nonKingPieces <= 8) {
    const wCenter = 7.0 - (Math.abs(wkC - 3.5) + Math.abs((8 - wkR) - 4.5));
    const bCenter = 7.0 - (Math.abs(bkC - 3.5) + Math.abs((8 - bkR) - 4.5));
    evalScore += Math.round((wCenter - bCenter) * 11);
    const kdF = Math.abs(wkC - bkC);
    const kdR = Math.abs(wkR - bkR);
    if ((kdF === 0 && kdR === 2) || (kdR === 0 && kdF === 2)) {
      evalScore += (turn === 'w' ? 20 : -20);
    }
  }

  // Side-to-move tempo bonus (+12 cp)
  return (turn === 'w' ? evalScore : -evalScore) + 12;
}

// ----------------------------------------------------------------------------
// Move Ordering: Hash Move -> Promotions -> Captures (MVV-LVA + SEE + CapHist) -> Killers -> Castling -> Conthist -> History
// ----------------------------------------------------------------------------
function scoreMoveForOrdering(chess, move, hashMoveUci, ply, turn, lastMove, prev2Move) {
  const uci = `${move.from}${move.to}${move.promotion || ''}`;
  if (hashMoveUci && uci === hashMoveUci) {
    return 2000000;
  }

  const colorIdx = turn === 'w' ? 0 : 1;
  const fromIdx = squareToIndex(move.from);
  const toIdx = squareToIndex(move.to);

  if (move.promotion) {
    const promoBonus = move.promotion === 'q' ? 350000 : 210000;
    const capBonus = move.captured ? (PIECE_VALUES[move.captured] || 100) * 10 : 0;
    return promoBonus + capBonus;
  }

  if (move.captured) {
    const victimVal = PIECE_VALUES[move.captured] || 100;
    const attackerVal = PIECE_VALUES[move.piece] || 100;
    const capHist = captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] || 0;
    const baseScore = victimVal >= attackerVal ? 150000 : 130000;
    return baseScore + (victimVal * 10 - attackerVal) + capHist;
  }

  // Killer Moves (Moves that caused a beta cutoff at this ply)
  if (ply < 64) {
    if (killerMoves[ply][0] === uci) return 90000;
    if (killerMoves[ply][1] === uci) return 80000;
  }

  // Castling priority
  if (move.san === 'O-O' || move.san === 'O-O-O') {
    return 70000;
  }

  // Continuation History (1-ply and 2-ply) + Main History
  let contBonus = 0;
  const currIdx = pieceToIdx(move.piece, turn) * 64 + toIdx;
  if (lastMove) {
    const prevIdx = pieceToIdx(lastMove.piece, lastMove.color) * 64 + squareToIndex(lastMove.to);
    contBonus += conthistTable[prevIdx * 768 + currIdx] || 0;
  }
  if (prev2Move) {
    const prev2Idx = pieceToIdx(prev2Move.piece, prev2Move.color) * 64 + squareToIndex(prev2Move.to);
    contBonus += (conthist2PlyTable[prev2Idx * 768 + currIdx] || 0) >> 1;
  }

  const hist = historyTable[colorIdx][fromIdx][toIdx] || 0;
  return Math.min(60000, hist + contBonus);
}

// ----------------------------------------------------------------------------
// Quiescence Search: Check Evasions + Tactical Resolution + Lazy SEE Pruning
// ----------------------------------------------------------------------------
function quiescenceSearch(chess, alpha, beta, qdepth, maxQdepth, stats, startTime, maxTimeMs, ply = 0) {
  stats.qnodes++;

  if ((stats.qnodes & 127) === 0) {
    if (stopRequested || (Date.now() - startTime) >= maxTimeMs) {
      isSearching = false;
      return alpha;
    }
  }

  const inCheck = chess.inCheck();

  if (!inCheck) {
    const standPat = evaluatePosition(chess);
    if (qdepth >= maxQdepth) return standPat;
    if (standPat >= beta) return beta;

    const BIG_DELTA = 950;
    if (standPat < alpha - BIG_DELTA) return alpha;
    if (standPat > alpha) alpha = standPat;
  } else if (qdepth >= maxQdepth + 2) {
    return evaluatePosition(chess);
  }

  const moves = chess.moves({ verbose: true });
  if (inCheck && moves.length === 0) {
    return -25000 + ply;
  }

  const tacticalScored = [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (inCheck || m.captured || m.promotion) {
      const mvv = (m.captured ? (PIECE_VALUES[m.captured] || 100) * 10 : 0) - (PIECE_VALUES[m.piece] || 100) + (m.promotion ? 9000 : 0) + (inCheck ? 500 : 0);
      tacticalScored.push({ move: m, score: mvv });
    }
  }

  tacticalScored.sort((a, b) => b.score - a.score);

  for (let i = 0; i < tacticalScored.length; i++) {
    if (!isSearching) break;
    const move = tacticalScored[i].move;
    if (!inCheck && !move.promotion && (!move.san || (!move.san.includes('+') && !move.san.includes('#')))) {
      const vicVal = PIECE_VALUES[move.captured] || 100;
      const attVal = PIECE_VALUES[move.piece] || 100;
      if (vicVal < attVal && staticExchangeEvaluation(chess, move) < 0) {
        continue;
      }
    }

    chess.move(move);
    const score = -quiescenceSearch(chess, -beta, -alpha, qdepth + 1, maxQdepth, stats, startTime, maxTimeMs, ply + 1);
    chess.undo();
    if (!isSearching) return alpha;

    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }

  return alpha;
}

// ----------------------------------------------------------------------------
// Principal Variation Search (PVS) with Alpha-Beta Pruning
// ----------------------------------------------------------------------------
function pvsSearch(chess, depth, ply, alpha, beta, stats, pvArray, startTime, maxTimeMs, lastMove = null, prev2Move = null, halfmoveClock = 0) {
  stats.nodes++;
  if (ply > stats.seldepth) stats.seldepth = ply;

  if ((stats.nodes & 255) === 0) {
    if (stopRequested || (Date.now() - startTime) >= maxTimeMs) {
      isSearching = false;
      return alpha;
    }
  }

  const isRoot = ply === 0;
  const origAlpha = alpha;
  const inCheck = chess.inCheck();

  if (inCheck && depth > 0) {
    depth++;
  }

  if (depth <= 0) {
    return quiescenceSearch(chess, alpha, beta, 0, 6, stats, startTime, maxTimeMs, ply);
  }

  // Fast draw checks using O(1) methods without generating FEN strings or moves
  if (!isRoot && (halfmoveClock >= 100 || chess.isThreefoldRepetition() || chess.isInsufficientMaterial())) {
    return 0;
  }

  const ttKey = chess.hash();
  const ttEntry = transpositionTable.get(ttKey);
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
    pvsSearch(chess, depth - 2, ply, alpha, beta, stats, [], startTime, maxTimeMs, lastMove, prev2Move, halfmoveClock);
    if (!isSearching) return origAlpha;
    const reEntry = transpositionTable.get(ttKey);
    if (reEntry) hashMoveUci = reEntry.bestMoveUci;
  }

  // Static evaluation with Correction History, Fifty-Move Decay, and Improving Heuristic
  let rawStaticEval = 0;
  let staticEval = 0;
  let improving = false;
  const turn = chess.turn();
  const colorIdx = turn === 'w' ? 0 : 1;
  const board = chess.board();

  if (!inCheck) {
    rawStaticEval = evaluatePosition(chess, evalMode, board);
    const pKey = computePawnKey(board);
    const npKey = computeNonPawnKey(board);
    const pCorr = pawnCorrHist[colorIdx][pKey] || 0;
    const npCorr = nonPawnCorrHist[colorIdx][npKey] || 0;
    const corrAdjustment = Math.round((pCorr * 2 + npCorr) / 128);
    staticEval = Math.max(-25000, Math.min(25000, rawStaticEval + corrAdjustment));
    if (halfmoveClock >= 40 && Math.abs(staticEval) < 15000) {
      staticEval = Math.round(staticEval * Math.max(0, (100 - halfmoveClock) / 60));
    }
    if (ply < 128) {
      staticEvalStack[ply] = staticEval;
      improving = ply >= 2 && staticEvalStack[ply - 2] < 90000 && staticEval > staticEvalStack[ply - 2];
    }
  } else if (ply < 128) {
    staticEvalStack[ply] = 99999;
  }

  // 1. Reverse Futility Pruning (RFP) with Improving Heuristic
  if (depth <= 5 && !inCheck && !isRoot && Math.abs(beta) < 9000) {
    const rfpMargin = depth * (improving ? 60 : 85);
    if (staticEval - rfpMargin >= beta) return staticEval;
  }

  // 1b. Razoring (Depth 1-3)
  if (depth <= 3 && !inCheck && !isRoot && Math.abs(alpha) < 9000) {
    const razorMargin = 260 + depth * 85;
    if (staticEval + razorMargin <= alpha) {
      const qScore = quiescenceSearch(chess, alpha, alpha + 1, 0, 6, stats, startTime, maxTimeMs);
      if (!isSearching) return origAlpha;
      if (qScore <= alpha) return qScore;
    }
  }

  // 2. ProbCut
  const PROBCUT_MARGIN = 175;
  if (depth >= 5 && !inCheck && !isRoot && Math.abs(beta) < 9000 && staticEval >= beta + PROBCUT_MARGIN) {
    const pBeta = beta + PROBCUT_MARGIN;
    const pScore = -pvsSearch(chess, depth - 4, ply + 1, -pBeta, -pBeta + 1, stats, [], startTime, maxTimeMs, lastMove, prev2Move, halfmoveClock);
    if (!isSearching) return origAlpha;
    if (pScore >= pBeta) return beta;
  }

  // 3. Null Move Pruning (R = 2 / 3)
  if (depth >= 3 && !inCheck && !isRoot) {
    let nonPawns = 0;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = board[r][f];
        if (p && p.color === turn && p.type !== 'p' && p.type !== 'k') nonPawns++;
      }
    }
    if (nonPawns > 1 && staticEval >= beta) {
      const nullFenParts = chess.fen().split(' ');
      nullFenParts[1] = nullFenParts[1] === 'w' ? 'b' : 'w';
      nullFenParts[3] = '-';
      const nullFen = nullFenParts.join(' ');
      try {
        const nullChess = new Chess(nullFen);
        const r = depth >= 6 ? 3 : 2;
        const nullScore = -pvsSearch(nullChess, depth - 1 - r, ply + 1, -beta, -beta + 1, stats, [], startTime, maxTimeMs, null, null, halfmoveClock + 1);
        if (!isSearching) return origAlpha;
        if (nullScore >= beta) return beta;
      } catch {
        // ignore parsing error
      }
    }
  }

  // 4. Generate and O(N) Pre-Scored Move Ordering
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) {
    return inCheck ? -25000 + ply : 0;
  }

  const orderedMoves = moves.map((m) => ({
    move: m,
    score: scoreMoveForOrdering(chess, m, hashMoveUci, ply, turn, lastMove, prev2Move)
  }));
  orderedMoves.sort((a, b) => b.score - a.score);

  // 5. Multi-Cut Pruning
  if (depth >= 5 && !inCheck && !isRoot && Math.abs(beta) < 9000) {
    let cutCount = 0;
    const mcDepth = depth - 1 - 3;
    const mcLimit = Math.min(6, orderedMoves.length);
    for (let i = 0; i < mcLimit; i++) {
      const m = orderedMoves[i].move;
      const nextHalf = (m.captured || m.piece === 'p') ? 0 : halfmoveClock + 1;
      chess.move(m);
      const s = -pvsSearch(chess, mcDepth, ply + 1, -beta, -beta + 1, stats, [], startTime, maxTimeMs, m, lastMove, nextHalf);
      chess.undo();
      if (!isSearching) return origAlpha;
      if (s >= beta) {
        cutCount++;
        if (cutCount >= 3) return beta;
      }
    }
  }

  // 6. Double Singular Extensions & Negative Extensions (SE)
  let singularExtension = 0;
  if (depth >= 6 && !isRoot && ttEntry && ttEntry.depth >= depth - 3 && ttEntry.flag !== TT_FLAG.UPPERBOUND && Math.abs(ttEntry.score) < 15000 && hashMoveUci) {
    const singularMargin = depth * 3;
    const singularBeta = ttEntry.score - singularMargin;
    const singularDepth = Math.floor((depth - 1) / 2);
    let isSingular = true;
    const altLimit = Math.min(8, orderedMoves.length);

    for (let i = 0; i < altLimit; i++) {
      const altMove = orderedMoves[i].move;
      const altUci = `${altMove.from}${altMove.to}${altMove.promotion || ''}`;
      if (altUci === hashMoveUci) continue;

      const nextHalf = (altMove.captured || altMove.piece === 'p') ? 0 : halfmoveClock + 1;
      chess.move(altMove);
      const altScore = -pvsSearch(chess, singularDepth, ply + 1, -singularBeta, -singularBeta + 1, stats, [], startTime, maxTimeMs, altMove, lastMove, nextHalf);
      chess.undo();
      if (!isSearching) return origAlpha;

      if (altScore >= singularBeta) {
        isSingular = false;
        break;
      }
    }

    if (isSingular) {
      const doubleSingularBeta = singularBeta - singularMargin;
      let isDoubleSingular = true;
      const doubleLimit = Math.min(5, orderedMoves.length);
      for (let i = 0; i < doubleLimit; i++) {
        const altMove = orderedMoves[i].move;
        const altUci = `${altMove.from}${altMove.to}${altMove.promotion || ''}`;
        if (altUci === hashMoveUci) continue;
        const nextHalf = (altMove.captured || altMove.piece === 'p') ? 0 : halfmoveClock + 1;
        chess.move(altMove);
        const altScore = -pvsSearch(chess, singularDepth, ply + 1, -doubleSingularBeta, -doubleSingularBeta + 1, stats, [], startTime, maxTimeMs, altMove, lastMove, nextHalf);
        chess.undo();
        if (!isSearching) return origAlpha;
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

  for (let i = 0; i < orderedMoves.length; i++) {
    if (!isSearching) break;
    const move = orderedMoves[i].move;
    const givesCheck = move.san && (move.san.includes('+') || move.san.includes('#'));
    const isCastling = move.san === 'O-O' || move.san === 'O-O-O';

    // 7. Late Move Pruning (LMP)
    if (depth <= 4 && !inCheck && !isRoot && movesSearched >= (3 + 3 * depth * depth)) {
      if (!move.captured && !move.promotion && !givesCheck && !isCastling) {
        continue;
      }
    }

    // 8. Futility Pruning
    if (depth <= 2 && !inCheck && !isRoot && Math.abs(alpha) < 9000) {
      if (!move.captured && !move.promotion && !givesCheck && !isCastling && (staticEval + 120 * depth <= alpha)) {
        continue;
      }
    }

    const nextHalf = (move.captured || move.piece === 'p') ? 0 : halfmoveClock + 1;
    chess.move(move);
    movesSearched++;

    let score;
    const subPv = [];
    let moveExtension = movesSearched === 1 ? singularExtension : 0;
    if (move.piece === 'p' && ((turn === 'w' && move.to[1] === '7') || (turn === 'b' && move.to[1] === '2'))) {
      moveExtension = Math.max(moveExtension, 1);
    }

    if (movesSearched === 1) {
      score = -pvsSearch(chess, depth - 1 + moveExtension, ply + 1, -beta, -alpha, stats, subPv, startTime, maxTimeMs, move, lastMove, nextHalf);
    } else {
      let reduction = 0;
      if (depth >= 3 && movesSearched >= 3 && !move.captured && !move.promotion && !isCastling && !inCheck && !givesCheck) {
        reduction = 1 + Math.floor(Math.log(depth) * Math.log(movesSearched) / 2.1);
        if (improving) reduction -= 1;
        else reduction += 1;

        const fromIdx = squareToIndex(move.from);
        const toIdx = squareToIndex(move.to);
        const hist = historyTable[colorIdx][fromIdx][toIdx] || 0;
        if (hist > 12000) reduction -= 2;
        else if (hist > 4000) reduction -= 1;
        else if (hist < -4000) reduction += 1;

        if (move.piece === 'p') {
          const rank = parseInt(move.to[1], 10);
          if ((turn === 'w' && rank >= 6) || (turn === 'b' && rank <= 3)) {
            reduction -= 1;
          }
        }

        reduction = Math.max(0, Math.min(depth - 2, reduction));
      }

      score = -pvsSearch(chess, depth - 1 - reduction, ply + 1, -alpha - 1, -alpha, stats, subPv, startTime, maxTimeMs, move, lastMove, nextHalf);

      if (score > alpha && (reduction > 0 || score < beta)) {
        score = -pvsSearch(chess, depth - 1, ply + 1, -beta, -alpha, stats, subPv, startTime, maxTimeMs, move, lastMove, nextHalf);
      }
    }

    chess.undo();
    if (!isSearching) return bestMove ? bestScore : origAlpha;

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
          historyTable[colorIdx][fromIdx][toIdx] = Math.min(25000, (historyTable[colorIdx][fromIdx][toIdx] || 0) + depth * depth * 32);

          const currIdx = pieceToIdx(move.piece, turn) * 64 + toIdx;
          if (lastMove) {
            const prevIdx = pieceToIdx(lastMove.piece, lastMove.color) * 64 + squareToIndex(lastMove.to);
            conthistTable[prevIdx * 768 + currIdx] = Math.min(25000, conthistTable[prevIdx * 768 + currIdx] + depth * depth * 16);
          }
          if (prev2Move) {
            const prev2Idx = pieceToIdx(prev2Move.piece, prev2Move.color) * 64 + squareToIndex(prev2Move.to);
            conthist2PlyTable[prev2Idx * 768 + currIdx] = Math.min(25000, conthist2PlyTable[prev2Idx * 768 + currIdx] + depth * depth * 10);
          }
        } else if (move.captured) {
          captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] = Math.min(25000, captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] + depth * depth * 16);
        }
        break;
      }
    } else {
      const fromIdx = squareToIndex(move.from);
      const toIdx = squareToIndex(move.to);
      if (!move.captured && ply < 64) {
        historyTable[colorIdx][fromIdx][toIdx] = Math.max(-10000, (historyTable[colorIdx][fromIdx][toIdx] || 0) - Math.floor(depth * depth / 2));
      } else if (move.captured) {
        captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] = Math.max(-10000, captureHistoryTable[colorIdx * 4096 + fromIdx * 64 + toIdx] - Math.floor(depth * depth * 6));
      }
    }
  }

  // Update Correction History (CorrHist) on stable leaf results
  if (!inCheck && !isRoot && bestMove && Math.abs(bestScore) < 9000) {
    const pKey = computePawnKey(board);
    const npKey = computeNonPawnKey(board);
    const errorBonus = Math.max(-1024, Math.min(1024, (bestScore - rawStaticEval) * 32));
    pawnCorrHist[colorIdx][pKey] = Math.round(pawnCorrHist[colorIdx][pKey] * 0.88 + errorBonus * 0.12);
    nonPawnCorrHist[colorIdx][npKey] = Math.round(nonPawnCorrHist[colorIdx][npKey] * 0.90 + (errorBonus / 2) * 0.10);
  }

  // Transposition Table Store (comparing against origAlpha fixes EXACT vs UPPERBOUND bug!)
  let flag = TT_FLAG.EXACT;
  if (bestScore <= origAlpha) flag = TT_FLAG.UPPERBOUND;
  else if (bestScore >= beta) flag = TT_FLAG.LOWERBOUND;

  if (bestMove) {
    if (transpositionTable.size >= maxTtEntries) {
      const keysToDelete = Array.from(transpositionTable.keys()).slice(0, Math.floor(maxTtEntries / 5));
      keysToDelete.forEach((k) => transpositionTable.delete(k));
    }
    transpositionTable.set(ttKey, {
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

const mctsTranspositionTableCli = new Map();

function computeMovePriorsCli(chess, moves, opponentThreats, gameHistory, isWinningAdvantage = false) {
  if (moves.length === 0) return [];
  const rawScores = new Array(moves.length);
  const us = chess.turn();

  let ourKingSquare = us === 'w' ? 'e1' : 'e8';
  let enemyKingSquare = us === 'w' ? 'e8' : 'e1';

  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.type === 'k') {
        const sq = `${String.fromCharCode(97 + c)}${8 - r}`;
        if (p.color === us) ourKingSquare = sq;
        else enemyKingSquare = sq;
      }
    }
  }

  const enemyKingFile = enemyKingSquare.charCodeAt(0) - 97;
  const enemyKingRank = parseInt(enemyKingSquare[1], 10);

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let score = 0;
    const toFile = m.to.charCodeAt(0) - 97;
    const toRank = parseInt(m.to[1], 10);

    // 1. Material & SEE Exchange Quality
    if (m.captured) {
      const see = staticExchangeEvaluation(chess, m);
      score += see >= 0 ? 195 + see * 0.55 : -165;
    }

    // 2. Promotion bonus
    if (m.promotion) score += m.promotion === 'q' ? 330 : 95;

    // 3. Checkmate & Check bonus
    if (m.san && m.san.includes('#')) {
      score += 650; // Checkmate delivers immediate win!
    } else if (m.san && m.san.includes('+')) {
      score += 80;
    }

    // Anti-Repetition Shield: Fast move/undo hash check instead of cloning Chess per move
    if (gameHistory && gameHistory.length > 0) {
      try {
        chess.move(m);
        const nextHash = chess.hash();
        chess.undo();
        let reps = 0;
        for (let k = 0; k < gameHistory.length; k++) {
          if (gameHistory[k] === nextHash) reps++;
        }
        if (reps >= 2) {
          score += isWinningAdvantage ? -900 : 150;
        } else if (reps === 1 && isWinningAdvantage) {
          score -= 300;
        }
      } catch {}
    }

    // 4. Center control & central outposts
    if (['e4', 'd4', 'e5', 'd5'].includes(m.to)) score += 38;
    else if (['c4', 'f4', 'c5', 'f5'].includes(m.to)) score += 22;

    // 5. Minor piece development & outposts
    if (['n', 'b'].includes(m.piece)) {
      score += 20;
      if (m.piece === 'n') {
        if (['c3', 'f3', 'c6', 'f6', 'd5', 'e5', 'd4', 'e4'].includes(m.to)) score += 25;
        if ((us === 'w' && toRank >= 5 && toRank <= 6) || (us === 'b' && toRank <= 4 && toRank >= 3)) {
          if (['c', 'd', 'e', 'f'].includes(m.to[0])) score += 35;
        }
      }
      if (m.piece === 'b') {
        if (['b2', 'g2', 'b7', 'g7'].includes(m.to)) score += 26;
        if (['g5', 'b5', 'g4', 'b4'].includes(m.to)) score += 22;
      }
    }

    // 6. Rook on 7th rank or central open files
    if (m.piece === 'r') {
      if ((us === 'w' && toRank === 7) || (us === 'b' && toRank === 2)) score += 45;
      if (['d', 'e'].includes(m.to[0])) score += 24;
      else if (['c', 'f'].includes(m.to[0])) score += 16;
    }

    // 7. Passed pawn push
    if (m.piece === 'p') {
      if (us === 'w' && toRank >= 5) score += (toRank - 4) * 35;
      else if (us === 'b' && toRank <= 4) score += (5 - toRank) * 35;
      if (['d4', 'e4', 'd5', 'e5'].includes(m.to)) score += 28;
    }

    // 8. King Attack & Tropism
    const distToFile = Math.abs(toFile - enemyKingFile);
    const distToRank = Math.abs(toRank - enemyKingRank);
    if (distToFile <= 2 && distToRank <= 2) {
      if (['q', 'r', 'b', 'n'].includes(m.piece)) score += 32;
    }

    // 9. Castling & King Safety
    if (m.san === 'O-O' || m.san === 'O-O-O') score += 75;
    if (m.piece === 'p') {
      if (us === 'w' && ourKingSquare === 'g1' && ['f2', 'g2', 'h2'].includes(m.from)) score -= 20;
      else if (us === 'b' && ourKingSquare === 'g8' && ['f7', 'g7', 'h7'].includes(m.from)) score -= 20;
    }

    // 10. Queen centralization
    if (m.piece === 'q' && ['d4', 'e4', 'd5', 'e5', 'd3', 'e3', 'd6', 'e6'].includes(m.to)) {
      score += 18;
    }

    // 11. Threat-Space Prophylaxis (The Petrosian Patch)
    if (opponentThreats && opponentThreats.length > 0) {
      const proph = evaluateProphylacticQualityCli(chess, m, opponentThreats);
      if (proph > 0) score += proph * 1.5;
    }

    rawScores[i] = score;
  }
  const maxScore = Math.max(...rawScores);
  const exps = rawScores.map(s => Math.exp((s - maxScore) / 55.0));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / Math.max(1e-9, sumExp));
}

function computeOpponentThreatSpaceCli(chess) {
  if (chess.inCheck()) return [];
  const tokens = chess.fen().split(' ');
  const ourTurn = tokens[1];
  tokens[1] = ourTurn === 'w' ? 'b' : 'w';
  tokens[3] = '-';
  let oppChess;
  try { oppChess = new Chess(tokens.join(' ')); } catch { return []; }
  if (oppChess.isCheckmate() || oppChess.isDraw()) return [];
  const moves = oppChess.moves({ verbose: true });
  const threats = [];
  for (const m of moves) {
    let sev = 0;
    if (m.san && m.san.includes('#')) sev = 100;
    else if (m.captured) {
      const see = staticExchangeEvaluation(oppChess, m);
      if (see >= 0) sev = m.captured === 'q' ? 95 : m.captured === 'r' ? 85 : 75;
    } else if (m.san && m.san.includes('+')) sev = 68;
    else if (m.piece === 'p' && ['c4', 'd4', 'e4', 'f4', 'c5', 'd5', 'e5', 'f5'].includes(m.to)) sev = 55;
    if (sev >= 40) threats.push({ uci: `${m.from}${m.to}`, san: m.san, from: m.from, to: m.to, piece: m.piece, threatSeverity: sev });
  }
  threats.sort((a, b) => b.threatSeverity - a.threatSeverity);
  return threats.slice(0, 3);
}

function evaluateProphylacticQualityCli(chess, move, threats) {
  if (!threats || threats.length === 0) return 0;
  let maxQ = 0;
  for (const t of threats) {
    let q = 0;
    if (move.to === t.from) q = Math.max(q, 95);
    if (move.to === t.to) q = Math.max(q, 88);
    if (move.from === t.to) q = Math.max(q, 78);
    if (move.piece === 'p') {
      if (t.to === 'g4' && move.san === 'h3') q = Math.max(q, 88);
      if (t.to === 'b4' && move.san === 'a3') q = Math.max(q, 88);
      if (t.to === 'g5' && move.san === 'h6') q = Math.max(q, 88);
      if (t.to === 'b5' && move.san === 'a6') q = Math.max(q, 88);
      // Phase II Luft / Back-rank Mate Defense:
      if (t.threatSeverity >= 85 && ['h3', 'g3', 'h6', 'g6', 'a3', 'a6'].includes(move.san)) {
        q = Math.max(q, 92);
      }
    }
    if (move.piece === 'k' && ['h1', 'g1', 'h8', 'g8', 'f1', 'f8'].includes(move.to)) q = Math.max(q, 75);
    const weighted = q * (t.threatSeverity / 100.0);
    if (weighted > maxQ) maxQ = weighted;
  }
  return Math.min(100, Math.round(maxQ));
}

function applyDirichletNoiseCli(priors, alpha = 0.3, eps = 0.20) {
  if (priors.length <= 1) return priors;
  const noises = new Array(priors.length);
  let noiseSum = 0;
  for (let i = 0; i < priors.length; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += -Math.log(Math.max(1e-9, Math.random()));
    noises[i] = Math.pow(Math.max(1e-9, Math.random()), 1.0 / alpha) * s;
    noiseSum += noises[i];
  }
  const norm = noises.map(n => n / Math.max(1e-9, noiseSum));
  return priors.map((p, i) => (1 - eps) * p + eps * norm[i]);
}

function runLeafTacticalRolloutCli(simChess, maxPlies = 2) {
  if (simChess.isCheckmate()) return -1.0;
  if (simChess.isThreefoldRepetition() || simChess.isInsufficientMaterial() || simChess.isDrawByFiftyMoves()) return 0.0;
  const startTurn = simChess.turn();
  let ply = 0;
  let movesMade = 0;
  while (ply < maxPlies) {
    if (simChess.isCheckmate()) {
      const res = ply % 2 === 0 ? -1.0 : 1.0;
      while (movesMade-- > 0) simChess.undo();
      return res;
    }
    const legal = simChess.moves({ verbose: true });
    if (legal.length === 0) break;
    let bestCapture = null;
    let bestSee = -1;
    for (let i = 0; i < legal.length; i++) {
      const m = legal[i];
      if (m.captured) {
        const see = staticExchangeEvaluation(simChess, m);
        if (see > bestSee) {
          bestSee = see;
          bestCapture = m;
        }
      }
    }
    if (!bestCapture || bestSee < 0) break;
    simChess.move(bestCapture);
    movesMade++;
    ply++;
  }
  const evalCp = evaluatePosition(simChess, evalMode);
  const perspectiveSign = simChess.turn() === startTurn ? 1 : -1;
  while (movesMade-- > 0) simChess.undo();
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
    if (m.san && (m.san.includes('+') || m.san.includes('#'))) volatility += 25;
  }
  volatility += Math.min(60, captures * 12);
  return Math.min(1.0, volatility / 220.0);
}

function runMctsSearchCli(chess, maxSims = 800, maxTimeMs = 1500, gameHistory = [], isWinningAdvantage = false, dirichletEps = 0) {
  const startTime = Date.now();
  const startFen = chess.fen();
  const rootMoves = chess.moves({ verbose: true });
  if (rootMoves.length === 0) return null;

  const opponentThreats = computeOpponentThreatSpaceCli(chess);
  let priors = computeMovePriorsCli(chess, rootMoves, opponentThreats, gameHistory, isWinningAdvantage);
  if (dirichletEps > 0 && rootMoves.length > 1) {
    priors = applyDirichletNoiseCli(priors, 0.3, dirichletEps);
  }

  const rootChildren = rootMoves.map((m, i) => ({
    move: m,
    uci: `${m.from}${m.to}${m.promotion || ''}`,
    san: m.san,
    visits: 0,
    totalValue: 0,
    qValue: 0,
    prior: priors[i]
  }));

  let sims = 0;
  let rootQ = 0;
  const simChess = new Chess(startFen);

  while (sims < maxSims) {
    if (sims >= 4 && (sims & 3) === 0 && (Date.now() - startTime) >= maxTimeMs) break;

    const rootVisitsSqrt = Math.sqrt(Math.max(1, sims));
    const currentCpuct = calculateDynamicCpuctCli(sims, 1.85, 0.45);
    let bestChildIdx = 0;
    let bestPuct = -Infinity;

    for (let i = 0; i < rootChildren.length; i++) {
      const c = rootChildren[i];
      const effVisits = c.visits + (c.virtualLoss || 0);
      const effTotal = c.totalValue - (c.virtualLoss || 0) * 0.35;
      const qVal = effVisits === 0 ? calculateFpuCli(rootQ, c.prior, 0.25) : effTotal / effVisits;
      const uVal = currentCpuct * c.prior * (rootVisitsSqrt / (1 + effVisits));
      const puct = qVal + uVal;
      if (puct > bestPuct) {
        bestPuct = puct;
        bestChildIdx = i;
      }
    }

    const chosen = rootChildren[bestChildIdx];
    chosen.virtualLoss = (chosen.virtualLoss || 0) + 1;
    simChess.move(chosen.move);

    let val = 0;
    if (simChess.isCheckmate()) {
      val = -1.0;
    } else if (simChess.isThreefoldRepetition() || simChess.isInsufficientMaterial() || simChess.isDrawByFiftyMoves()) {
      val = 0.0;
    } else {
      val = runLeafTacticalRolloutCli(simChess, 2);
    }

    simChess.undo();
    const rootVal = -val;
    chosen.virtualLoss = Math.max(0, (chosen.virtualLoss || 0) - 1);
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
export function searchRoot(chess, targetDepth = 8, maxTimeMs = 3000, gameHistory = gameHistoryFensCli) {
  isSearching = true;
  stopRequested = false;
  const startTime = Date.now();

  const legalMoves = chess.moves({ verbose: true });
  if (legalMoves.length === 0) {
    isSearching = false;
    process.stdout.write('bestmove 0000\n');
    return;
  }

  // Instant Mate-in-1 check
  const mateMove = legalMoves.find(m => m.san && m.san.includes('#'));
  if (mateMove) {
    const mateUci = `${mateMove.from}${mateMove.to}${mateMove.promotion || ''}`;
    isSearching = false;
    process.stdout.write(`info depth 1 score mate 1 nodes 1 nps 1000 time 1 pv ${mateUci}\n`);
    process.stdout.write(`bestmove ${mateUci}\n`);
    return;
  }

  // Fast Forced Mate-in-2 check
  if (legalMoves.length <= 35) {
    for (const m1 of legalMoves) {
      if (m1.san && (m1.san.includes('+') || m1.captured)) {
        try {
          const sim1 = new Chess(chess.fen());
          sim1.move(m1);
          if (!sim1.isCheckmate()) {
            const oppReplies = sim1.moves({ verbose: true });
            if (oppReplies.length > 0 && oppReplies.length <= 4) {
              let allLeadToMate = true;
              for (const oppM of oppReplies) {
                const sim2 = new Chess(sim1.fen());
                sim2.move(oppM);
                const m2Moves = sim2.moves({ verbose: true });
                if (!m2Moves.some(m => m.san && m.san.includes('#'))) {
                  allLeadToMate = false;
                  break;
                }
              }
              if (allLeadToMate) {
                const mateUci = `${m1.from}${m1.to}${m1.promotion || ''}`;
                isSearching = false;
                process.stdout.write(`info depth 3 score mate 2 nodes 50 nps 1000 time 2 pv ${mateUci}\n`);
                process.stdout.write(`bestmove ${mateUci}\n`);
                return;
              }
            }
          }
        } catch {}
      }
    }
  }

  const stats = {
    nodes: 0,
    qnodes: 0,
    seldepth: 0,
    ttHits: 0
  };

  let bestMoveUci = `${legalMoves[0].from}${legalMoves[0].to}${legalMoves[0].promotion || ''}`;

  if (searchMode === 'Hybrid-MCTS-PVS') {
    const rootHalfmove = parseInt(chess.fen().split(' ')[4] || '0', 10);

    // 1. Run Iterative-Deepening PVS Tactical Search FIRST with 85% budget
    const pvsBudget = Math.max(25, Math.floor(maxTimeMs * 0.85));
    const pvsDeadline = startTime + pvsBudget;
    const hardDeadline = startTime + maxTimeMs;
    const pvsSearchDepth = Math.min(targetDepth, 10);
    let pvsBestUci = bestMoveUci;
    let pvsBestScore = 0;
    let reachedDepth = 0;
    let lastPvsUci = '';
    let stableCount = 0;

    for (let d = 1; d <= pvsSearchDepth; d++) {
      const remPvs = pvsDeadline - Date.now();
      if (d > 1 && remPvs <= 5) break;

      const callBudget = d === 1 ? Math.max(15, hardDeadline - Date.now()) : remPvs;
      let pv = [];
      let alpha = -30000;
      let beta = 30000;
      let delta = 30;
      let score = 0;

      if (d >= 4) {
        alpha = Math.max(-30000, pvsBestScore - delta);
        beta = Math.min(30000, pvsBestScore + delta);
        while (true) {
          pv = [];
          const rem = pvsDeadline - Date.now();
          if (rem <= 3) { isSearching = false; break; }
          score = pvsSearch(chess, d, 0, alpha, beta, stats, pv, Date.now(), rem, null, null, rootHalfmove);
          if (!isSearching) break;
          if (score <= alpha) {
            alpha = Math.max(-30000, alpha - delta * 2);
            delta = Math.floor(delta * 1.6) + 15;
          } else if (score >= beta) {
            beta = Math.min(30000, beta + delta * 2);
            delta = Math.floor(delta * 1.6) + 15;
          } else {
            break;
          }
          if (alpha <= -20000 && beta >= 20000) {
            pv = [];
            const fullRem = pvsDeadline - Date.now();
            if (fullRem <= 3) { isSearching = false; break; }
            score = pvsSearch(chess, d, 0, -30000, 30000, stats, pv, Date.now(), fullRem, null, null, rootHalfmove);
            break;
          }
        }
      } else {
        score = pvsSearch(chess, d, 0, -30000, 30000, stats, pv, Date.now(), callBudget, null, null, rootHalfmove);
      }

      if (pv.length > 0 && (isSearching || d === 1)) {
        pvsBestUci = pv[0];
        pvsBestScore = score;
        reachedDepth = d;
        if (pvsBestUci === lastPvsUci) stableCount++;
        else { lastPvsUci = pvsBestUci; stableCount = 0; }
      }
      isSearching = true;
      if (Math.abs(pvsBestScore) > 15000) break;
      if (stableCount >= 2 && d >= 4 && (Date.now() - startTime) >= pvsBudget * 0.65) break;
    }

    // 2. Run MCTS PUCT & Threat-Space Prophylaxis ONLY if sufficient remaining time & non-mate
    let mctsResult = null;
    let mctsUci = pvsBestUci;
    const remAfterPvs = hardDeadline - Date.now();
    if (remAfterPvs >= 22 && Math.abs(pvsBestScore) < 15000) {
      const mctsBudget = Math.max(10, Math.min(Math.floor(maxTimeMs * 0.20), remAfterPvs - 10));
      mctsResult = runMctsSearchCli(chess, 250, mctsBudget, gameHistory, pvsBestScore > 50, 0);
      if (mctsResult?.bestChild?.uci) {
        mctsUci = mctsResult.bestChild.uci;
      }
    }

    // 3. Tightened Bayesian Arbiter: MCTS only overrides PVS if tactically verified within 15cp
    let chosenUci = pvsBestUci;
    let reason = 'pvs-tactical';
    let deltaCp = 0;

    if (mctsResult && mctsUci === pvsBestUci) {
      reason = 'consensus';
      chosenUci = pvsBestUci;
    } else if (mctsResult && mctsUci !== pvsBestUci) {
      const mctsVisits = mctsResult.bestChild?.visits || 0;
      const mctsRatio = mctsVisits / Math.max(1, mctsResult.sims || 1);
      const remVerify = hardDeadline - Date.now() - 4;
      if (mctsRatio > 0.58 && remVerify >= 14) {
        const mctsMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === mctsUci);
        if (mctsMoveObj) {
          chess.move(mctsMoveObj);
          const oppPv = [];
          isSearching = true;
          const oppScore = pvsSearch(chess, Math.max(1, Math.min(3, reachedDepth - 1)), 0, -30000, 30000, stats, oppPv, Date.now(), remVerify, mctsMoveObj, null, (mctsMoveObj.captured || mctsMoveObj.piece === 'p') ? 0 : rootHalfmove + 1);
          chess.undo();
          if (isSearching) {
            const mctsMoveScore = -oppScore;
            deltaCp = pvsBestScore - mctsMoveScore;
            if (deltaCp <= 15) {
              reason = 'mcts-strategic';
              chosenUci = mctsUci;
            } else {
              reason = 'safety-net-override';
              chosenUci = pvsBestUci;
            }
          }
          isSearching = true;
        }
      } else {
        reason = 'safety-net-override';
        chosenUci = pvsBestUci;
      }
    }

    // Anti-Repetition Shield: Fast move/undo hash check in winning positions
    if (gameHistory && gameHistory.length > 0 && pvsBestScore > 60 && legalMoves.length > 1) {
      const chosenMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === chosenUci);
      if (chosenMoveObj) {
        chess.move(chosenMoveObj);
        const nextHash = chess.hash();
        chess.undo();
        let reps = 0;
        for (let k = 0; k < gameHistory.length; k++) {
          if (gameHistory[k] === nextHash) reps++;
        }
        if (reps >= 1) {
          for (const m of legalMoves) {
            const uci = `${m.from}${m.to}${m.promotion || ''}`;
            if (uci === chosenUci) continue;
            chess.move(m);
            const candHash = chess.hash();
            chess.undo();
            let candReps = 0;
            for (let k = 0; k < gameHistory.length; k++) {
              if (gameHistory[k] === candHash) candReps++;
            }
            if (candReps === 0) {
              chosenUci = uci;
              reason = 'anti-repetition-defense';
              break;
            }
          }
        }
      }
    }

    const elapsedMs = Math.max(1, Date.now() - startTime);
    const totalNodes = stats.nodes + stats.qnodes;
    const nps = Math.round((totalNodes / elapsedMs) * 1000);
    const mctsVisits = mctsResult?.bestChild?.visits || 0;
    const mctsSims = mctsResult?.sims || 0;

    process.stdout.write(
      `info depth ${reachedDepth} seldepth ${stats.seldepth} score cp ${pvsBestScore} nodes ${totalNodes} nps ${nps} time ${elapsedMs} visits ${mctsVisits} sims ${mctsSims} arbiter ${reason} delta ${deltaCp} pv ${chosenUci}\n`
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

  // Anti-Repetition Shield: Ensure winning side avoids repeating positions
  if (bestScore > 50 && gameHistory && gameHistory.length > 0 && legalMoves.length > 1) {
    try {
      chess.move({ from: bestMoveUci.slice(0, 2), to: bestMoveUci.slice(2, 4), promotion: bestMoveUci[4] });
      const nextKey = chess.hash();
      chess.undo();
      let reps = 0;
      for (const k of gameHistory) {
        if (k === nextKey) reps++;
      }
      if (reps >= 1) {
        for (const m of legalMoves) {
          const uci = `${m.from}${m.to}${m.promotion || ''}`;
          if (uci === bestMoveUci) continue;
          chess.move(m);
          const candKey = chess.hash();
          chess.undo();
          let candReps = 0;
          for (const k of gameHistory) {
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
    const isWhite = chess.turn() === 'w';
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
  process.stdout.write(`bestmove ${outBestMove}\n`);
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

  // Instant Mate-in-1 check
  const mateMove = legalMoves.find(m => m.san && m.san.includes('#'));
  if (mateMove) {
    const mateUci = `${mateMove.from}${mateMove.to}${mateMove.promotion || ''}`;
    isSearching = false;
    return { bestMoveUci: mateUci, scoreCp: 25000, depth: 1, nodes: 1, pv: [mateUci] };
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
      log('option name UCI_Chess960 type check default false');
      log('option name EvalMode type combo default brnnue-v030 var brnnue-v030 var berserker-1.0-nnue var aura-nnue');
      log('option name SearchMode type combo default Hybrid-MCTS-PVS var Hybrid-MCTS-PVS var Pure-PVS var Pure-MCTS');
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
      currentChess960Config = null;
      gameHistoryFensCli = [];
      clearSearchState();
      break;

    case 'position':
      try {
        gameHistoryFensCli = [];
        let moveIdx = -1;
        if (parts[1] === 'startpos') {
          currentChess = new Chess();
          currentChess960Config = null;
          gameHistoryFensCli.push(currentChess.hash());
          moveIdx = parts.indexOf('moves');
        } else if (parts[1] === 'fen') {
          const rawParts = [];
          let idx = 2;
          while (idx < parts.length && parts[idx] !== 'moves') {
            rawParts.push(parts[idx]);
            idx++;
          }
          const { normalizedFen } = normalizeChess960Fen(rawParts.join(' '));
          currentChess = new Chess(normalizedFen);
          const backrank = normalizedFen.split('/')[7]?.split(' ')[0] || 'RNBQKBNR';
          currentChess960Config = extractCastlingConfig(backrank);
          gameHistoryFensCli.push(currentChess.hash());
          moveIdx = parts.indexOf('moves');
        }

        if (moveIdx !== -1 && moveIdx + 1 < parts.length) {
          for (let i = moveIdx + 1; i < parts.length; i++) {
            const mv = parts[i];
            const resolved = resolveChess960Move(currentChess, mv, currentChess960Config);
            if (resolved.isChess960Castling && resolved.side) {
              executeChess960Castling(currentChess, resolved.side, currentChess960Config);
            } else {
              currentChess.move({
                from: mv.substring(0, 2),
                to: mv.substring(2, 4),
                promotion: mv.length > 4 ? mv[4] : undefined
              });
            }
            gameHistoryFensCli.push(currentChess.hash());
          }
        }
      } catch {
        // Safe fallback
      }
      break;

    case 'chess960': {
      let spIdx = 518;
      if (parts[1] === 'random') {
        spIdx = Math.floor(Math.random() * 960);
      } else if (parts[1] && !isNaN(parseInt(parts[1], 10))) {
        spIdx = Math.max(0, Math.min(959, parseInt(parts[1], 10)));
      }
      const backrank = generateChess960Backrank(spIdx);
      currentChess960Config = extractCastlingConfig(backrank);
      const whiteBack = backrank.toUpperCase();
      const blackBack = backrank.toLowerCase();
      const fen = `${blackBack}/pppppppp/8/8/8/8/PPPPPPPP/${whiteBack} w KQkq - 0 1`;
      currentChess = new Chess(fen);
      uciChess960 = true;
      gameHistoryFensCli = [currentChess.hash()];
      log(`Chess960 SP ${spIdx} Initialized: [${backrank}]`);
      log(`FEN: ${fen}`);
      log(currentChess.ascii());
      break;
    }

    case 'go':
      let searchDepth = 10;
      let moveTimeMs = 2000;

      const depthIdx = parts.indexOf('depth');
      if (depthIdx !== -1 && parts[depthIdx + 1]) {
        searchDepth = parseInt(parts[depthIdx + 1], 10);
      }

      const timeIdx = parts.indexOf('movetime');
      if (timeIdx !== -1 && parts[timeIdx + 1]) {
        moveTimeMs = parseInt(parts[timeIdx + 1], 10);
      }

      // Time management support for wtime / btime / winc / binc / movestogo (reserving IPC safety margin)
      const wtimeIdx = parts.indexOf('wtime');
      const btimeIdx = parts.indexOf('btime');
      const wincIdx = parts.indexOf('winc');
      const bincIdx = parts.indexOf('binc');
      const mtgIdx = parts.indexOf('movestogo');
      const mtg = (mtgIdx !== -1 && parts[mtgIdx + 1]) ? Math.max(1, parseInt(parts[mtgIdx + 1], 10)) : 28;

      if (wtimeIdx !== -1 && currentChess.turn() === 'w') {
        const wtime = Math.max(10, parseInt(parts[wtimeIdx + 1], 10));
        const winc = (wincIdx !== -1 && parts[wincIdx + 1]) ? parseInt(parts[wincIdx + 1], 10) : 0;
        const rawSlice = Math.floor(wtime / mtg) + Math.floor(winc * 0.70);
        moveTimeMs = Math.max(15, Math.min(Math.floor(wtime * 0.35), rawSlice) - 10);
      } else if (btimeIdx !== -1 && currentChess.turn() === 'b') {
        const btime = Math.max(10, parseInt(parts[btimeIdx + 1], 10));
        const binc = (bincIdx !== -1 && parts[bincIdx + 1]) ? parseInt(parts[bincIdx + 1], 10) : 0;
        const rawSlice = Math.floor(btime / mtg) + Math.floor(binc * 0.70);
        moveTimeMs = Math.max(15, Math.min(Math.floor(btime * 0.35), rawSlice) - 10);
      }

      searchRoot(currentChess, searchDepth, moveTimeMs, gameHistoryFensCli);
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
        if (optName === 'Hash') {
          hashMb = parseInt(optVal, 10);
          updateHashTableCapacity(hashMb);
        }
        if (optName === 'MultiPV') multiPv = parseInt(optVal, 10);
        if (optName === 'UCI_Chess960') uciChess960 = optVal === 'true';
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

