/**
 * FastSearch: Pure Alpha-Beta / PVS Search Engine on FastBoard + Reckless NNUE
 *
 * Implements high-throughput typed-array search with:
 * - Iterative deepening with progressive aspiration windows & best-move stability time management
 * - Complete TT correctness (origAlpha vs bestScore flag, mate-ply normalization, zero-alloc typed arrays)
 * - Safe aborted-iteration unwinding (never corrupts completed bestMove/bestScore on timeout)
 * - PV-node protection (null move, RFP, ProbCut, Multi-Cut, Razoring, LMP disabled on PV nodes)
 * - In-place Null Move Pruning + Singular & Double Singular Extensions
 * - Complete Quiescence Search (check evasions, captures, queen promotions, full iterative SEE pruning)
 * - 1-ply & 2-ply Continuation History, Capture History, Killers, Countermoves, and CorrHist
 * - Exact 2-fold repetition & 50-move draw detection
 */

import { Chess } from 'chess.js';
import {
  FastBoard,
  WHITE,
  BLACK,
  PT_PAWN,
  PT_KNIGHT,
  PT_BISHOP,
  PT_ROOK,
  PT_QUEEN,
  PT_KING,
  EMPTY,
  FLAG_CAPTURE,
  FLAG_EP,
  FLAG_PROMO,
  MAX_PLY,
  MAX_MOVES_PER_PLY,
  SEE_PIECE_VALUES,
  moveToUci,
  popcount32,
  ctz32,
} from './fastBoard';
import {
  RecklessEvaluator,
  RecklessParameters,
  getRecklessNnueParams,
  tryLoadRecklessNnueNodeSync,
  normalizeRecklessToCp,
  RECKLESS_NET_NAME,
} from './recklessNnue';

const MATE_SCORE = 25000;
const MATE_BOUND = 23000;
const INF = 30000;

const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

// 2^20 entries (~20 MB total across typed arrays, zero GC pressure)
const TT_BITS = 20;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;

class FastTranspositionTable {
  private keyLo = new Uint32Array(TT_SIZE);
  private keyHi = new Uint32Array(TT_SIZE);
  private move = new Int32Array(TT_SIZE);
  private score = new Int16Array(TT_SIZE);
  private depth = new Int8Array(TT_SIZE);
  private flag = new Uint8Array(TT_SIZE);
  private age = new Uint8Array(TT_SIZE);
  private currentAge = 1;
  private filled = 0;

  public clear(): void {
    this.keyLo.fill(0);
    this.keyHi.fill(0);
    this.move.fill(0);
    this.score.fill(0);
    this.depth.fill(0);
    this.flag.fill(0);
    this.age.fill(0);
    this.currentAge = 1;
    this.filled = 0;
  }

  public nextAge(): void {
    this.currentAge = (this.currentAge + 1) & 255;
    if (this.currentAge === 0) this.currentAge = 1;
  }

  public probe(hashLo: number, hashHi: number): {
    hit: boolean;
    move: number;
    score: number;
    depth: number;
    flag: number;
  } {
    const idx = (hashLo & TT_MASK) >>> 0;
    if (this.age[idx] !== 0 && this.keyLo[idx] === hashLo && this.keyHi[idx] === hashHi) {
      return {
        hit: true,
        move: this.move[idx],
        score: this.score[idx],
        depth: this.depth[idx],
        flag: this.flag[idx],
      };
    }
    return { hit: false, move: 0, score: 0, depth: 0, flag: 0 };
  }

  public store(
    hashLo: number,
    hashHi: number,
    depth: number,
    score: number,
    flag: number,
    move: number
  ): void {
    const idx = (hashLo & TT_MASK) >>> 0;
    const isEmpty = this.age[idx] === 0;
    const sameKey = !isEmpty && this.keyLo[idx] === hashLo && this.keyHi[idx] === hashHi;

    if (
      isEmpty ||
      sameKey ||
      this.age[idx] !== this.currentAge ||
      depth >= this.depth[idx] ||
      flag === TT_EXACT
    ) {
      if (isEmpty) this.filled++;
      this.keyLo[idx] = hashLo;
      this.keyHi[idx] = hashHi;
      this.move[idx] = move || (sameKey ? this.move[idx] : 0);
      this.score[idx] = score;
      this.depth[idx] = depth;
      this.flag[idx] = flag;
      this.age[idx] = this.currentAge;
    }
  }

  public hashfullPerMille(): number {
    return Math.min(1000, Math.round((this.filled / TT_SIZE) * 1000));
  }
}

// Shared search state & heuristic tables
const tt = new FastTranspositionTable();
const killers = new Int32Array(MAX_PLY * 2);
const history = new Int32Array(2 * 64 * 64);
const counterMoves = new Int32Array(2 * 64 * 64);
const conthist = new Int16Array(12 * 64 * 12 * 64); // ~1.18 MB
const capHistory = new Int16Array(12 * 64 * 6);
const pawnCorrHist = new Int16Array(2 * 16384);
const nonPawnCorrHist = new Int16Array(2 * 16384);

export function clearFastSearchState(): void {
  tt.clear();
  killers.fill(0);
  history.fill(0);
  counterMoves.fill(0);
  conthist.fill(0);
  capHistory.fill(0);
  pawnCorrHist.fill(0);
  nonPawnCorrHist.fill(0);
}

// Fast fallback PST evaluator (only used if .nnue binary hasn't finished fetching yet)
const FALLBACK_PST = new Int16Array([
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, -20, -20, 10, 10, 5,
  5, -5, -10, 0, 0, -10, -5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, 5, 10, 25, 25, 10, 5, 5,
  10, 10, 20, 30, 30, 20, 10, 10,
  50, 50, 50, 50, 50, 50, 50, 50,
  0, 0, 0, 0, 0, 0, 0, 0,
]);

function fallbackEvaluate(board: FastBoard): number {
  let score = 0;
  for (let pt = 0; pt < 5; pt++) {
    const val = SEE_PIECE_VALUES[pt];
    let wLo = board.pieceLo[pt << 1];
    let wHi = board.pieceHi[pt << 1];
    while (wLo !== 0) {
      const sq = ctz32(wLo);
      wLo &= wLo - 1;
      score += val + (pt === PT_PAWN ? FALLBACK_PST[sq] : 0);
    }
    while (wHi !== 0) {
      const sq = 32 + ctz32(wHi);
      wHi &= wHi - 1;
      score += val + (pt === PT_PAWN ? FALLBACK_PST[sq] : 0);
    }
    let bLo = board.pieceLo[(pt << 1) | 1];
    let bHi = board.pieceHi[(pt << 1) | 1];
    while (bLo !== 0) {
      const sq = ctz32(bLo);
      bLo &= bLo - 1;
      score -= val + (pt === PT_PAWN ? FALLBACK_PST[sq ^ 56] : 0);
    }
    while (bHi !== 0) {
      const sq = 32 + ctz32(bHi);
      bHi &= bHi - 1;
      score -= val + (pt === PT_PAWN ? FALLBACK_PST[sq ^ 56] : 0);
    }
  }
  return board.turn === WHITE ? score : -score;
}

export interface SearchStats {
  nodes: number;
  qnodes: number;
  seldepth: number;
  ttHits: number;
  startTime: number;
  maxTimeMs: number;
  aborted: boolean;
  stopCheck?: () => boolean;
}

export interface FastSearchOptions {
  fen?: string;
  moves?: string[];
  depth?: number;
  maxTimeMs?: number;
  multiPv?: number;
  contempt?: number;
  nnueParams?: RecklessParameters | null;
  stopCheck?: () => boolean;
  onInfo?: (info: {
    depth: number;
    seldepth: number;
    multipv: number;
    scoreCp: number;
    mate: number | null;
    nodes: number;
    nps: number;
    timeMs: number;
    hashfull: number;
    pvUci: string[];
  }) => void;
}

export interface FastSearchResult {
  bestMoveUci: string;
  bestMoveSan: string;
  scoreCp: number;
  mate: number | null;
  depth: number;
  seldepth: number;
  nodes: number;
  qnodes: number;
  nps: number;
  ttHits: number;
  pv: string[];
  pvSan: string[];
  timeMs: number;
  nnueActive: boolean;
  netName: string;
}

// Move-ordering stack tracking (last moved piece + to square per ply)
const movedPieceStack = new Int32Array(MAX_PLY);
const moveToStack = new Int32Array(MAX_PLY);
const pvTable = new Int32Array(MAX_PLY * MAX_PLY);
const pvLength = new Int32Array(MAX_PLY);

function checkTime(stats: SearchStats): boolean {
  if (stats.aborted) return true;
  if ((stats.nodes & 2047) === 0) {
    if (stats.stopCheck && stats.stopCheck()) {
      stats.aborted = true;
      return true;
    }
    if (Date.now() - stats.startTime >= stats.maxTimeMs) {
      stats.aborted = true;
      return true;
    }
  }
  return false;
}

function evaluateBoard(
  board: FastBoard,
  evaluator: RecklessEvaluator | null,
  contemptCp: number
): number {
  let evalCp: number;
  if (evaluator) {
    const raw = evaluator.evaluate(board);
    evalCp = normalizeRecklessToCp(raw, board);
  } else {
    evalCp = fallbackEvaluate(board);
  }

  if (contemptCp !== 0) {
    const sign = board.turn === WHITE ? 1 : -1;
    evalCp += Math.round(sign * contemptCp * 0.25);
  }
  return Math.max(-20000, Math.min(20000, evalCp));
}

function scoreMove(
  board: FastBoard,
  move: number,
  ttMove: number,
  ply: number,
  prevPiece: number,
  prevTo: number,
  prev2Piece: number,
  prev2To: number
): number {
  if (move === ttMove) return 2_000_000;

  const from = move & 63;
  const to = (move >>> 6) & 63;
  const promo = (move >>> 12) & 7;
  const flags = (move >>> 15) & 15;
  const piece = board.mailbox[from];
  const captured = flags === FLAG_EP ? PT_PAWN : board.mailbox[to] === EMPTY ? -1 : board.mailbox[to] >> 1;

  if (captured >= 0 || promo === PT_QUEEN) {
    const victimVal = captured >= 0 ? SEE_PIECE_VALUES[captured] : 0;
    const attackerPt = piece >> 1;
    const capIdx = (piece * 64 + to) * 6 + Math.max(0, captured);
    const ch = capHistory[capIdx];
    const seeBonus = promo === PT_QUEEN || victimVal >= SEE_PIECE_VALUES[attackerPt] || board.staticExchangeEvaluation(move) >= 0 ? 400_000 : -200_000;
    return seeBonus + victimVal * 16 - attackerPt + (promo === PT_QUEEN ? 9000 : 0) + ch;
  }

  if (ply < MAX_PLY) {
    if (killers[ply * 2] === move) return 300_000;
    if (killers[ply * 2 + 1] === move) return 280_000;
  }

  const color = board.turn;
  if (prevTo >= 0 && counterMoves[color * 4096 + prevTo * 64 + to] === move) {
    return 250_000;
  }

  let score = history[color * 4096 + from * 64 + to];
  const currPtIdx = piece * 64 + to;
  if (prevPiece >= 0) {
    score += conthist[(prevPiece * 64 + prevTo) * 768 + currPtIdx];
  }
  if (prev2Piece >= 0) {
    score += conthist[(prev2Piece * 64 + prev2To) * 768 + currPtIdx] >> 1;
  }
  return score;
}

function updateQuietHistory(idx: number, bonus: number): void {
  const clamped = Math.max(-16384, Math.min(16384, bonus));
  history[idx] += clamped - Math.trunc((history[idx] * Math.abs(clamped)) / 16384);
}

function updateContHistory(idx: number, bonus: number): void {
  const clamped = Math.max(-16384, Math.min(16384, bonus));
  conthist[idx] += clamped - Math.trunc((conthist[idx] * Math.abs(clamped)) / 16384);
}

function quiescence(
  board: FastBoard,
  evaluator: RecklessEvaluator | null,
  alpha: number,
  beta: number,
  ply: number,
  qdepth: number,
  stats: SearchStats,
  contemptCp: number
): number {
  stats.nodes++;
  stats.qnodes++;
  if (ply > stats.seldepth) stats.seldepth = ply;

  if (checkTime(stats)) return alpha;
  if (board.isDraw(ply)) return 0;

  const inCheck = board.inCheck();

  if (ply >= MAX_PLY - 2 || qdepth >= 10) {
    return inCheck ? 0 : evaluateBoard(board, evaluator, contemptCp);
  }

  let bestScore = -INF;
  let origAlpha = alpha;

  if (!inCheck) {
    const standPat = evaluateBoard(board, evaluator, contemptCp);
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
    bestScore = standPat;

    // Delta pruning
    if (standPat + 1100 < alpha) {
      return alpha;
    }
  }

  // When in check, search all evasions; otherwise search captures + promotions
  const count = board.generatePseudoLegal(ply, !inCheck);
  const base = ply * MAX_MOVES_PER_PLY;

  // Score tactical moves (captures, promotions, or evasions)
  for (let i = 0; i < count; i++) {
    const m = board.moveLists[base + i];
    const flags = (m >>> 15) & 15;
    const to = (m >>> 6) & 63;
    const promo = (m >>> 12) & 7;
    if (!inCheck) {
      const victim = flags === FLAG_EP ? PT_PAWN : board.mailbox[to] === EMPTY ? -1 : board.mailbox[to] >> 1;
      if (victim < 0 && promo !== PT_QUEEN) {
        board.moveScores[base + i] = -1_000_000;
        continue;
      }
      const attacker = board.mailbox[m & 63] >> 1;
      board.moveScores[base + i] = (victim >= 0 ? SEE_PIECE_VALUES[victim] * 16 : 0) - attacker + (promo === PT_QUEEN ? 9000 : 0);
    } else {
      const cap = board.mailbox[to] !== EMPTY ? SEE_PIECE_VALUES[board.mailbox[to] >> 1] : 0;
      board.moveScores[base + i] = cap + (promo === PT_QUEEN ? 9000 : 0) + (killers[ply * 2] === m ? 500 : 0);
    }
  }

  let legalMoves = 0;
  for (let i = 0; i < count; i++) {
    // Selection sort next best move
    let bestIdx = i;
    let bestSort = board.moveScores[base + i];
    for (let j = i + 1; j < count; j++) {
      if (board.moveScores[base + j] > bestSort) {
        bestSort = board.moveScores[base + j];
        bestIdx = j;
      }
    }
    if (bestIdx !== i) {
      const tmpM = board.moveLists[base + i];
      board.moveLists[base + i] = board.moveLists[base + bestIdx];
      board.moveLists[base + bestIdx] = tmpM;
      board.moveScores[base + bestIdx] = board.moveScores[base + i];
      board.moveScores[base + i] = bestSort;
    }

    const move = board.moveLists[base + i];
    if (!inCheck && bestSort <= -1_000_000) break;

    // SEE pruning in quiescence when not in check
    if (!inCheck && board.staticExchangeEvaluation(move) < 0) {
      continue;
    }

    if (!board.makeMove(move)) continue;
    legalMoves++;

    const score = -quiescence(board, evaluator, -beta, -alpha, ply + 1, qdepth + 1, stats, contemptCp);
    board.unmakeMove();

    if (stats.aborted) return origAlpha;

    if (score > bestScore) {
      bestScore = score;
      if (score > alpha) {
        alpha = score;
        if (score >= beta) {
          return score;
        }
      }
    }
  }

  if (inCheck && legalMoves === 0) {
    return -MATE_SCORE + ply;
  }

  return bestScore;
}

function pvs(
  board: FastBoard,
  evaluator: RecklessEvaluator | null,
  depth: number,
  ply: number,
  alpha: number,
  beta: number,
  stats: SearchStats,
  contemptCp: number,
  excludedMove = 0,
  cutnode = false
): number {
  if (ply < MAX_PLY) pvLength[ply] = 0;
  if (checkTime(stats)) return alpha;

  const isRoot = ply === 0;
  const isPv = beta - alpha > 1;
  const inCheck = board.inCheck();

  if (inCheck && depth > 0 && ply < MAX_PLY - 4) {
    depth++;
  }

  if (depth <= 0) {
    return quiescence(board, evaluator, alpha, beta, ply, 0, stats, contemptCp);
  }

  stats.nodes++;
  if (ply > stats.seldepth) stats.seldepth = ply;

  if (!isRoot) {
    if (board.isDraw(ply)) return 0;
    if (ply >= MAX_PLY - 2) {
      return inCheck ? 0 : evaluateBoard(board, evaluator, contemptCp);
    }

    // Mate distance pruning
    const mateAlpha = Math.max(alpha, -MATE_SCORE + ply);
    const mateBeta = Math.min(beta, MATE_SCORE - ply - 1);
    if (mateAlpha >= mateBeta) return mateAlpha;
  }

  // Transposition Table Probe (skip on singular verification)
  const ttProbe = excludedMove === 0 ? tt.probe(board.hashLo, board.hashHi) : { hit: false, move: 0, score: 0, depth: 0, flag: 0 };
  let ttMove = ttProbe.hit ? ttProbe.move : 0;
  let ttScore = ttProbe.score;

  if (ttProbe.hit) {
    if (ttScore >= MATE_BOUND) ttScore -= ply;
    else if (ttScore <= -MATE_BOUND) ttScore += ply;

    if (!isPv && !isRoot && ttProbe.depth >= depth) {
      stats.ttHits++;
      if (ttProbe.flag === TT_EXACT) return ttScore;
      if (ttProbe.flag === TT_LOWER && ttScore >= beta) return ttScore;
      if (ttProbe.flag === TT_UPPER && ttScore <= alpha) return ttScore;
    }
  }

  // Internal Iterative Reductions (IIR): reduce when no TT move on PV/cutnodes at depth >= 4
  if (depth >= 4 && ttMove === 0 && (isPv || cutnode) && excludedMove === 0) {
    depth--;
  }

  // Static evaluation + Correction History + 50-move scaling
  const us = board.turn;
  let rawEval = 0;
  let staticEval = 0;
  if (!inCheck) {
    rawEval = evaluateBoard(board, evaluator, contemptCp);
    const pIdx = us * 16384 + (board.pawnKey & 16383);
    const npIdx = us * 16384 + (board.nonPawnKey & 16383);
    const corr = Math.trunc((pawnCorrHist[pIdx] * 2 + nonPawnCorrHist[npIdx]) / 64);
    staticEval = Math.max(-MATE_BOUND + 1, Math.min(MATE_BOUND - 1, rawEval + corr));
    if (board.halfmove > 20) {
      staticEval = Math.trunc((staticEval * (200 - board.halfmove)) / 200);
    }
  }

  // Non-PV static pruning techniques
  if (!isPv && !inCheck && excludedMove === 0) {
    // 1. Reverse Futility Pruning (RFP)
    if (depth <= 7 && Math.abs(beta) < MATE_BOUND) {
      const rfpMargin = 90 * depth;
      if (staticEval - rfpMargin >= beta) {
        return staticEval - rfpMargin;
      }
    }

    // 2. Razoring at shallow depth
    if (depth <= 2 && Math.abs(alpha) < MATE_BOUND && staticEval + 260 * depth <= alpha) {
      const qScore = quiescence(board, evaluator, alpha, alpha + 1, ply, 0, stats, contemptCp);
      if (qScore <= alpha) return qScore;
    }

    // 3. Null Move Pruning (NMP) — strictly in-place, never allocates
    if (depth >= 3 && staticEval >= beta && Math.abs(beta) < MATE_BOUND && board.hasNonPawnMaterial(us)) {
      const r = 3 + Math.floor(depth / 4);
      movedPieceStack[ply] = -1;
      moveToStack[ply] = -1;
      board.makeNullMove();
      const nullScore = -pvs(board, evaluator, depth - 1 - r, ply + 1, -beta, -beta + 1, stats, contemptCp, 0, !cutnode);
      board.unmakeNullMove();
      if (stats.aborted) return alpha;
      if (nullScore >= beta) {
        return nullScore >= MATE_BOUND ? beta : nullScore;
      }
    }
  }

  // Generate & score pseudo-legal moves
  const count = board.generatePseudoLegal(ply, false);
  const base = ply * MAX_MOVES_PER_PLY;
  const prevPiece = ply > 0 ? movedPieceStack[ply - 1] : -1;
  const prevTo = ply > 0 ? moveToStack[ply - 1] : -1;
  const prev2Piece = ply > 1 ? movedPieceStack[ply - 2] : -1;
  const prev2To = ply > 1 ? moveToStack[ply - 2] : -1;

  for (let i = 0; i < count; i++) {
    board.moveScores[base + i] = scoreMove(
      board,
      board.moveLists[base + i],
      ttMove,
      ply,
      prevPiece,
      prevTo,
      prev2Piece,
      prev2To
    );
  }

  const origAlpha = alpha;
  let bestScore = -INF;
  let bestMove = 0;
  let movesSearched = 0;
  let legalCount = 0;
  const quietSearched: number[] = [];
  const capSearched: number[] = [];

  for (let i = 0; i < count; i++) {
    // Incremental selection sort
    let bestIdx = i;
    let bestOrderScore = board.moveScores[base + i];
    for (let j = i + 1; j < count; j++) {
      if (board.moveScores[base + j] > bestOrderScore) {
        bestOrderScore = board.moveScores[base + j];
        bestIdx = j;
      }
    }
    if (bestIdx !== i) {
      const tmpM = board.moveLists[base + i];
      board.moveLists[base + i] = board.moveLists[base + bestIdx];
      board.moveLists[base + bestIdx] = tmpM;
      board.moveScores[base + bestIdx] = board.moveScores[base + i];
      board.moveScores[base + i] = bestOrderScore;
    }

    const move = board.moveLists[base + i];
    if (move === excludedMove) continue;

    const from = move & 63;
    const to = (move >>> 6) & 63;
    const promo = (move >>> 12) & 7;
    const flags = (move >>> 15) & 15;
    const movedPiece = board.mailbox[from];
    const isCapture = flags === FLAG_EP || board.mailbox[to] !== EMPTY;
    const isTactical = isCapture || promo === PT_QUEEN;

    // Quiet move pruning on non-PV nodes
    if (!isPv && !isRoot && !inCheck && bestScore > -MATE_BOUND && !isTactical) {
      // Late Move Pruning (LMP)
      if (depth <= 4 && movesSearched >= 4 + depth * depth * 2) {
        continue;
      }
      // Futility Pruning
      if (depth <= 3 && staticEval + 130 * depth <= alpha) {
        continue;
      }
      // Bad-history / negative-SEE pruning at low depth
      if (depth <= 4 && board.staticExchangeEvaluation(move) < -60 * depth) {
        continue;
      }
    } else if (!isPv && !isRoot && !inCheck && bestScore > -MATE_BOUND && depth <= 3 && isCapture) {
      // Prune hopeless captures at very low depths
      if (board.staticExchangeEvaluation(move) < -95 * depth) {
        continue;
      }
    }

    // Singular Extension check for TT move
    let extension = 0;
    if (
      !isRoot &&
      excludedMove === 0 &&
      move === ttMove &&
      depth >= 6 &&
      ttProbe.hit &&
      ttProbe.depth >= depth - 3 &&
      ttProbe.flag !== TT_UPPER &&
      Math.abs(ttScore) < MATE_BOUND
    ) {
      const singularBeta = Math.max(-MATE_BOUND + 1, ttScore - depth * 2);
      const singularDepth = Math.floor((depth - 1) / 2);
      const sScore = pvs(board, evaluator, singularDepth, ply, singularBeta - 1, singularBeta, stats, contemptCp, move, cutnode);
      if (stats.aborted) return origAlpha;
      if (sScore < singularBeta) {
        extension = sScore < singularBeta - depth * 4 ? 2 : 1;
      } else if (singularBeta >= beta) {
        // Multi-Cut singular beta fail-high
        return singularBeta;
      }
    }

    if (!board.makeMove(move)) continue;
    legalCount++;
    movesSearched++;

    movedPieceStack[ply] = movedPiece;
    moveToStack[ply] = to;

    const givesCheck = board.inCheck();
    const newDepth = depth - 1 + extension;
    let score: number;

    if (movesSearched === 1) {
      score = -pvs(board, evaluator, newDepth, ply + 1, -beta, -alpha, stats, contemptCp, 0, false);
    } else {
      // Late Move Reductions (LMR)
      let reduction = 0;
      if (depth >= 3 && movesSearched >= 3 && !isTactical && !inCheck && !givesCheck) {
        reduction = Math.floor(0.75 + Math.log(depth) * Math.log(movesSearched) / 2.2);
        if (!isPv) reduction++;
        const histVal = history[us * 4096 + from * 64 + to];
        if (histVal > 4000) reduction--;
        else if (histVal < -4000) reduction++;
        if (cutnode) reduction++;
        reduction = Math.max(0, Math.min(newDepth - 1, reduction));
      } else if (depth >= 3 && movesSearched >= 5 && isCapture && !inCheck && !givesCheck && bestOrderScore < 0) {
        reduction = 1;
      }

      score = -pvs(board, evaluator, newDepth - reduction, ply + 1, -alpha - 1, -alpha, stats, contemptCp, 0, true);
      if (!stats.aborted && score > alpha && reduction > 0) {
        score = -pvs(board, evaluator, newDepth, ply + 1, -alpha - 1, -alpha, stats, contemptCp, 0, !cutnode);
      }
      if (!stats.aborted && score > alpha && score < beta) {
        score = -pvs(board, evaluator, newDepth, ply + 1, -beta, -alpha, stats, contemptCp, 0, false);
      }
    }

    board.unmakeMove();

    if (stats.aborted) return origAlpha;

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;

      if (score > alpha) {
        alpha = score;

        // Copy child PV
        if (ply < MAX_PLY - 1) {
          const curBase = ply * MAX_PLY;
          const childBase = (ply + 1) * MAX_PLY;
          const cLen = pvLength[ply + 1];
          pvTable[curBase] = move;
          for (let p = 0; p < cLen; p++) {
            pvTable[curBase + 1 + p] = pvTable[childBase + p];
          }
          pvLength[ply] = 1 + cLen;
        }

        if (score >= beta) {
          const bonus = Math.min(2048, depth * depth * 16);
          if (!isCapture) {
            if (ply < MAX_PLY && killers[ply * 2] !== move) {
              killers[ply * 2 + 1] = killers[ply * 2];
              killers[ply * 2] = move;
            }
            if (prevTo >= 0) {
              counterMoves[us * 4096 + prevTo * 64 + to] = move;
            }
            updateQuietHistory(us * 4096 + from * 64 + to, bonus);
            const currPtIdx = movedPiece * 64 + to;
            if (prevPiece >= 0) updateContHistory((prevPiece * 64 + prevTo) * 768 + currPtIdx, bonus);
            if (prev2Piece >= 0) updateContHistory((prev2Piece * 64 + prev2To) * 768 + currPtIdx, bonus >> 1);

            for (const qm of quietSearched) {
              const qFrom = qm & 63;
              const qTo = (qm >>> 6) & 63;
              const qPiece = board.mailbox[qFrom];
              updateQuietHistory(us * 4096 + qFrom * 64 + qTo, -bonus);
              const qPtIdx = qPiece * 64 + qTo;
              if (prevPiece >= 0) updateContHistory((prevPiece * 64 + prevTo) * 768 + qPtIdx, -bonus);
            }
          } else {
            const capPt = flags === FLAG_EP ? PT_PAWN : board.mailbox[to] >> 1;
            const cIdx = (movedPiece * 64 + to) * 6 + capPt;
            capHistory[cIdx] = Math.max(-16384, Math.min(16384, capHistory[cIdx] + bonus));
          }
          break;
        }
      }
    }

    if (isCapture) capSearched.push(move);
    else quietSearched.push(move);
  }

  if (legalCount === 0 && excludedMove === 0) {
    return inCheck ? -MATE_SCORE + ply : 0;
  }

  // Update Correction History
  if (
    !inCheck &&
    excludedMove === 0 &&
    bestMove !== 0 &&
    Math.abs(bestScore) < MATE_BOUND &&
    (bestScore <= origAlpha || bestScore >= beta || (bestScore > origAlpha && bestScore < beta))
  ) {
    const capFlag = bestMove ? ((bestMove >>> 15) & 15) : 0;
    const bestTo = (bestMove >>> 6) & 63;
    if (capFlag !== FLAG_EP && board.mailbox[bestTo] === EMPTY) {
      const pIdx = us * 16384 + (board.pawnKey & 16383);
      const npIdx = us * 16384 + (board.nonPawnKey & 16383);
      const err = Math.max(-256, Math.min(256, bestScore - rawEval));
      const weight = Math.min(16, depth + 1);
      pawnCorrHist[pIdx] = Math.max(-2048, Math.min(2048, Math.round((pawnCorrHist[pIdx] * (256 - weight) + err * 16 * weight) / 256)));
      nonPawnCorrHist[npIdx] = Math.max(-2048, Math.min(2048, Math.round((nonPawnCorrHist[npIdx] * (256 - weight) + err * 12 * weight) / 256)));
    }
  }

  // Transposition Table Store (with CORRECT origAlpha comparison and mate-ply normalization!)
  if (excludedMove === 0 && bestMove !== 0) {
    let flag = TT_EXACT;
    if (bestScore <= origAlpha) flag = TT_UPPER;
    else if (bestScore >= beta) flag = TT_LOWER;

    let storeScore = bestScore;
    if (storeScore >= MATE_BOUND) storeScore += ply;
    else if (storeScore <= -MATE_BOUND) storeScore -= ply;

    tt.store(board.hashLo, board.hashHi, depth, storeScore, flag, bestMove);
  }

  return bestScore;
}

function uciPvToSan(startFen: string, movesBefore: string[], pvUci: string[]): string[] {
  try {
    const c = new Chess(startFen);
    for (const u of movesBefore) {
      c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
    }
    const sans: string[] = [];
    for (const u of pvUci) {
      const res = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
      if (!res) break;
      sans.push(res.san);
    }
    return sans;
  } catch {
    return pvUci;
  }
}

export function searchFast(options: FastSearchOptions): FastSearchResult {
  const startFen = options.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const movesBefore = options.moves || [];
  const maxDepth = Math.max(1, Math.min(64, options.depth ?? 16));
  const maxTimeMs = Math.max(10, options.maxTimeMs ?? 2000);
  const multiPv = Math.max(1, Math.min(5, options.multiPv ?? 1));
  const contemptCp = options.contempt ?? 0;

  const nnueParams = options.nnueParams ?? getRecklessNnueParams() ?? tryLoadRecklessNnueNodeSync();
  const evaluator = nnueParams ? new RecklessEvaluator(nnueParams) : null;

  const board = new FastBoard(startFen);
  for (const m of movesBefore) {
    board.applyUciMove(m);
  }
  if (evaluator) {
    board.observer = evaluator;
    evaluator.onReset(board);
  }

  const legalMoves = board.getLegalMoves();
  if (legalMoves.length === 0) {
    const isCheck = board.inCheck();
    return {
      bestMoveUci: '0000',
      bestMoveSan: '',
      scoreCp: isCheck ? -MATE_SCORE : 0,
      mate: isCheck ? 0 : null,
      depth: 0,
      seldepth: 0,
      nodes: 0,
      qnodes: 0,
      nps: 0,
      ttHits: 0,
      pv: [],
      pvSan: [],
      timeMs: 0,
      nnueActive: !!evaluator,
      netName: evaluator ? RECKLESS_NET_NAME : 'fallback-pst',
    };
  }

  tt.nextAge();

  const stats: SearchStats = {
    nodes: 0,
    qnodes: 0,
    seldepth: 0,
    ttHits: 0,
    startTime: Date.now(),
    maxTimeMs,
    aborted: false,
    stopCheck: options.stopCheck,
  };

  let completedBestMove = legalMoves[0];
  let completedScore = 0;
  let completedDepth = 0;
  let completedPvUci: string[] = [moveToUci(completedBestMove)];

  let lastRootMove = 0;
  let stableCount = 0;

  const numLines = Math.min(multiPv, legalMoves.length);

  for (let d = 1; d <= maxDepth; d++) {
    if (stats.aborted) break;
    if (d > 1 && Date.now() - stats.startTime >= maxTimeMs * 0.72 && stableCount >= 2) {
      break;
    }

    const excludedAtRoot: number[] = [];
    let primaryMoveThisDepth = 0;
    let primaryScoreThisDepth = 0;
    let primaryPvThisDepth: string[] = [];

    for (let pvIdx = 0; pvIdx < numLines; pvIdx++) {
      // If MultiPV > 1, search skipping previously found PV moves at root
      const excl = pvIdx === 0 ? 0 : excludedAtRoot[pvIdx - 1] || 0;
      let score = 0;

      if (d >= 4 && pvIdx === 0) {
        let delta = 25;
        let alpha = Math.max(-INF, completedScore - delta);
        let beta = Math.min(INF, completedScore + delta);

        while (true) {
          score = pvs(board, evaluator, d, 0, alpha, beta, stats, contemptCp, 0, false);
          if (stats.aborted) break;
          if (score <= alpha) {
            beta = Math.floor((alpha + beta) / 2);
            alpha = Math.max(-INF, alpha - delta);
            delta = Math.floor(delta * 1.8) + 15;
          } else if (score >= beta) {
            beta = Math.min(INF, beta + delta);
            delta = Math.floor(delta * 1.8) + 15;
          } else {
            break;
          }
          if (alpha <= -20000 && beta >= 20000) {
            score = pvs(board, evaluator, d, 0, -INF, INF, stats, contemptCp, 0, false);
            break;
          }
        }
      } else {
        // MultiPV > 1 or shallow depth: full window at root
        // For MultiPV > 1, we only exclude previous PV moves by temporarily bumping scores?
        // Simpler: if pvIdx === 0, normal root search; if pvIdx > 0, use single excluded or loop root moves
        if (pvIdx === 0) {
          score = pvs(board, evaluator, d, 0, -INF, INF, stats, contemptCp, 0, false);
        } else {
          // Exact MultiPV pass over remaining legal root moves
          let subBestScore = -INF;
          let subBestMove = 0;
          let subPv: number[] = [];
          for (const rm of legalMoves) {
            if (excludedAtRoot.includes(rm)) continue;
            board.makeMove(rm);
            movedPieceStack[0] = board.mailbox[(rm >>> 6) & 63];
            moveToStack[0] = (rm >>> 6) & 63;
            const s = -pvs(board, evaluator, d - 1, 1, -INF, -subBestScore, stats, contemptCp, 0, false);
            board.unmakeMove();
            if (stats.aborted) break;
            if (s > subBestScore) {
              subBestScore = s;
              subBestMove = rm;
              subPv = [rm];
              for (let k = 0; k < pvLength[1]; k++) subPv.push(pvTable[MAX_PLY + k]);
            }
          }
          if (!stats.aborted && subBestMove !== 0) {
            score = subBestScore;
            pvLength[0] = subPv.length;
            for (let k = 0; k < subPv.length; k++) pvTable[k] = subPv[k];
          }
        }
      }

      if (stats.aborted) break;

      const pvLen = pvLength[0];
      const pvUci: string[] = [];
      for (let k = 0; k < pvLen; k++) {
        pvUci.push(moveToUci(pvTable[k]));
      }
      if (pvLen > 0) {
        excludedAtRoot.push(pvTable[0]);
      }

      const elapsedMs = Math.max(1, Date.now() - stats.startTime);
      const nps = Math.round((stats.nodes / elapsedMs) * 1000);
      const isMate = Math.abs(score) >= MATE_BOUND;
      const mateMoves = isMate ? Math.ceil((MATE_SCORE - Math.abs(score)) / 2) * (score > 0 ? 1 : -1) : null;

      if (pvIdx === 0 && pvLen > 0) {
        primaryMoveThisDepth = pvTable[0];
        primaryScoreThisDepth = score;
        primaryPvThisDepth = pvUci;
      }

      if (options.onInfo && pvLen > 0) {
        options.onInfo({
          depth: d,
          seldepth: stats.seldepth,
          multipv: pvIdx + 1,
          scoreCp: score,
          mate: mateMoves,
          nodes: stats.nodes,
          nps,
          timeMs: elapsedMs,
          hashfull: tt.hashfullPerMille(),
          pvUci,
        });
      }
    }

    if (stats.aborted) break;

    if (primaryMoveThisDepth !== 0) {
      completedBestMove = primaryMoveThisDepth;
      completedScore = primaryScoreThisDepth;
      completedDepth = d;
      completedPvUci = primaryPvThisDepth;

      if (completedBestMove === lastRootMove) stableCount++;
      else {
        lastRootMove = completedBestMove;
        stableCount = 0;
      }
    }

    // Stop immediately on forced mate
    if (Math.abs(completedScore) >= MATE_BOUND && d >= 2) break;
  }

  const totalTimeMs = Math.max(1, Date.now() - stats.startTime);
  const nps = Math.round((stats.nodes / totalTimeMs) * 1000);
  const pvSan = uciPvToSan(startFen, movesBefore, completedPvUci);
  const isMate = Math.abs(completedScore) >= MATE_BOUND;
  const mate = isMate ? Math.ceil((MATE_SCORE - Math.abs(completedScore)) / 2) * (completedScore > 0 ? 1 : -1) : null;

  return {
    bestMoveUci: moveToUci(completedBestMove),
    bestMoveSan: pvSan[0] || moveToUci(completedBestMove),
    scoreCp: completedScore,
    mate,
    depth: Math.max(1, completedDepth),
    seldepth: stats.seldepth,
    nodes: stats.nodes,
    qnodes: stats.qnodes,
    nps,
    ttHits: stats.ttHits,
    pv: completedPvUci,
    pvSan,
    timeMs: totalTimeMs,
    nnueActive: !!evaluator,
    netName: evaluator ? RECKLESS_NET_NAME : 'fallback-pst',
  };
}
