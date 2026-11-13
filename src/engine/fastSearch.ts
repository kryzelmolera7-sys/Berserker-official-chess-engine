/**
 * Ultra-Fast PVS Alpha-Beta Search Core (Zero-Allocation TypedArray Engine)
 *
 * Implements:
 * - Packed 262k+ TypedArray Transposition Table with mate-ply normalization & generation aging
 * - Aspiration Windows with dynamic widening
 * - Principal Variation Search (PVS) with proper PV/Non-PV separation
 * - Reverse Futility Pruning (RFP), Razoring, Null Move Pruning (R=3..5 + verification)
 * - SEE-gated ProbCut, Singular Extensions + Multi-Cut + Negative Extensions
 * - Late Move Pruning (LMP), Futility Pruning, Quiet/Capture SEE Pruning
 * - Precomputed LMR with Improving, Check, PV, History dampening
 * - History Gravity, 1-ply & 2-ply Continuation History, Capture History, Countermove, Killers
 * - Pawn & Non-Pawn Correction History (CorrHist)
 * - Strictly enforced in-search microsecond/millisecond time management
 */

import {
  FastBoard,
  EMPTY,
  WHITE,
  PT_PAWN,
  PT_KING,
  MAX_PLY,
  MV_FLAG_CAPTURE,
  MV_FLAG_CASTLE,
  moveFrom,
  moveTo,
  movePromo,
  moveIsCapture,
  movePiece,
  moveCaptured,
  moveToUci,
  pieceTypeOf,
  seeGe,
  evaluateFast,
  SEE_VAL,
} from './fastBoard';

export const MATE_SCORE = 25000;
export const MATE_IN_MAX = MATE_SCORE - MAX_PLY;
const INF = 30000;

const BOUND_NONE = 0;
const BOUND_UPPER = 1;
const BOUND_LOWER = 2;
const BOUND_EXACT = 3;

// ============================================================================
// Transposition Table (262,144 slots = ~4.7 MB flat TypedArrays)
// ============================================================================
const TT_BITS = 18;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;

const ttKeyLo = new Uint32Array(TT_SIZE);
const ttKeyHi = new Uint32Array(TT_SIZE);
const ttMove = new Int32Array(TT_SIZE);
const ttScore = new Int16Array(TT_SIZE);
const ttEval = new Int16Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttBound = new Uint8Array(TT_SIZE);
const ttAge = new Uint8Array(TT_SIZE);
let currentSearchAge = 1;

// ============================================================================
// History & Heuristic Tables (Preallocated)
// ============================================================================
// Main quiet history: [stm 0..1][from 0..63][to 0..63] -> 8192 entries
const mainHistory = new Int16Array(2 * 64 * 64);
// Capture history: [movedPiece 0..12][toSq 0..63][capturedPt 0..6] -> 5824 entries
const capHistory = new Int16Array(13 * 64 * 7);
// 1-ply & 2-ply Continuation History: [prevPiece*64 + prevTo][currPiece*64 + currTo] (832 x 832)
const contHist1 = new Int16Array(832 * 832);
const contHist2 = new Int16Array(832 * 832);
// Countermoves: [prevPiece*64 + prevTo]
const counterMoves = new Int32Array(832);
// Killers: [ply][2]
const killers = new Int32Array(MAX_PLY * 2);

// Correction History: [stm 0..1][16384]
const pawnCorrHist = new Int16Array(2 * 16384);
const nonPawnCorrHistW = new Int16Array(2 * 16384);
const nonPawnCorrHistB = new Int16Array(2 * 16384);

// Search stacks (per-ply preallocated)
const moveStack: Int32Array[] = Array.from({ length: MAX_PLY }, () => new Int32Array(256));
const scoreStack: Int32Array[] = Array.from({ length: MAX_PLY }, () => new Int32Array(256));
const quietTried: Int32Array[] = Array.from({ length: MAX_PLY }, () => new Int32Array(256));
const capTried: Int32Array[] = Array.from({ length: MAX_PLY }, () => new Int32Array(128));
const staticEvalStack = new Int32Array(MAX_PLY);
const inCheckStack = new Uint8Array(MAX_PLY);
const movedPieceStack = new Int16Array(MAX_PLY);
const movedToStack = new Int16Array(MAX_PLY);
const pvTable: Int32Array[] = Array.from({ length: MAX_PLY }, () => new Int32Array(MAX_PLY));
const pvLen = new Int32Array(MAX_PLY);

// Precomputed LMR reduction table [depth 0..63][moveIdx 0..63]
const LMR_TABLE: Int8Array[] = Array.from({ length: 64 }, () => new Int8Array(64));
(function initLmrTable() {
  for (let d = 1; d < 64; d++) {
    for (let m = 1; m < 64; m++) {
      LMR_TABLE[d][m] = Math.max(0, Math.floor(0.75 + (Math.log(d) * Math.log(m)) / 2.25));
    }
  }
})();

export function clearFastSearchTables(): void {
  ttKeyLo.fill(0);
  ttKeyHi.fill(0);
  ttMove.fill(0);
  ttScore.fill(0);
  ttEval.fill(0);
  ttDepth.fill(0);
  ttBound.fill(0);
  ttAge.fill(0);
  mainHistory.fill(0);
  capHistory.fill(0);
  contHist1.fill(0);
  contHist2.fill(0);
  counterMoves.fill(0);
  killers.fill(0);
  pawnCorrHist.fill(0);
  nonPawnCorrHistW.fill(0);
  nonPawnCorrHistB.fill(0);
  currentSearchAge = 1;
}

export function getFastTTUsagePermill(): number {
  let used = 0;
  for (let i = 0; i < 1000; i++) {
    if (ttBound[i] !== BOUND_NONE && ttAge[i] === currentSearchAge) used++;
  }
  return used;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function scoreToTT(score: number, ply: number): number {
  if (score >= MATE_IN_MAX) return score + ply;
  if (score <= -MATE_IN_MAX) return score - ply;
  return score;
}

function scoreFromTT(score: number, ply: number): number {
  if (score >= MATE_IN_MAX) return score - ply;
  if (score <= -MATE_IN_MAX) return score + ply;
  return score;
}

function storeTT(
  hashLo: number,
  hashHi: number,
  move: number,
  score: number,
  rawEval: number,
  depth: number,
  bound: number
): void {
  const idx = hashLo & TT_MASK;
  const sameKey = ttKeyLo[idx] === hashLo && ttKeyHi[idx] === hashHi;
  if (
    ttBound[idx] === BOUND_NONE ||
    ttAge[idx] !== currentSearchAge ||
    bound === BOUND_EXACT ||
    depth + 2 >= ttDepth[idx] ||
    sameKey
  ) {
    ttKeyLo[idx] = hashLo;
    ttKeyHi[idx] = hashHi;
    if (move !== 0 || !sameKey) {
      ttMove[idx] = move;
    }
    ttScore[idx] = score;
    ttEval[idx] = clamp(rawEval, -30000, 30000);
    ttDepth[idx] = depth;
    ttBound[idx] = bound;
    ttAge[idx] = currentSearchAge;
  }
}

function updateMainHistory(stm: number, from: number, to: number, bonus: number): void {
  const idx = (stm << 12) | (from << 6) | to;
  const cur = mainHistory[idx];
  mainHistory[idx] = clamp(cur + bonus - Math.trunc((cur * Math.abs(bonus)) / 16384), -16384, 16384);
}

function updateCapHistory(piece: number, to: number, capPt: number, bonus: number): void {
  const idx = (piece * 64 + to) * 7 + capPt;
  const cur = capHistory[idx];
  capHistory[idx] = clamp(cur + bonus - Math.trunc((cur * Math.abs(bonus)) / 16384), -16384, 16384);
}

function updateContHist(
  table: Int16Array,
  prevIdx: number,
  currPiece: number,
  currTo: number,
  bonus: number
): void {
  const idx = prevIdx * 832 + currPiece * 64 + currTo;
  const cur = table[idx];
  table[idx] = clamp(cur + bonus - Math.trunc((cur * Math.abs(bonus)) / 16384), -16384, 16384);
}

function scoreMovesForPly(
  board: FastBoard,
  moves: Int32Array,
  scores: Int32Array,
  count: number,
  ttMoveVal: number,
  ply: number,
  capturesOnly: boolean
): void {
  const stm = board.stm;
  const k1 = killers[ply * 2];
  const k2 = killers[ply * 2 + 1];
  const prev1Idx = ply >= 1 && movedPieceStack[ply - 1] > 0
    ? movedPieceStack[ply - 1] * 64 + movedToStack[ply - 1]
    : -1;
  const prev2Idx = ply >= 2 && movedPieceStack[ply - 2] > 0
    ? movedPieceStack[ply - 2] * 64 + movedToStack[ply - 2]
    : -1;
  const cmMove = prev1Idx >= 0 ? counterMoves[prev1Idx] : 0;

  for (let i = 0; i < count; i++) {
    const m = moves[i];
    if (m === ttMoveVal) {
      scores[i] = 10_000_000;
      continue;
    }

    const promo = movePromo(m);
    const isCap = (m & MV_FLAG_CAPTURE) !== 0;

    if (isCap || promo === 5) {
      const capPt = isCap ? pieceTypeOf(moveCaptured(m)) : 0;
      const movedP = movePiece(m);
      const movedPt = pieceTypeOf(movedP);
      const mvvLva = SEE_VAL[capPt] * 16 - SEE_VAL[movedPt] + (promo === 5 ? 9000 : 0);
      const ch = capHistory[(movedP * 64 + moveTo(m)) * 7 + capPt];
      if (capturesOnly) {
        scores[i] = 1_000_000 + mvvLva + ch;
      } else if (seeGe(board, m, 0)) {
        scores[i] = 2_000_000 + mvvLva + ch;
      } else {
        scores[i] = -200_000 + mvvLva + ch;
      }
      continue;
    }

    if (m === k1) {
      scores[i] = 900_000;
      continue;
    }
    if (m === k2) {
      scores[i] = 800_000;
      continue;
    }
    if (m === cmMove) {
      scores[i] = 700_000;
      continue;
    }

    const from = moveFrom(m);
    const to = moveTo(m);
    const movedP = movePiece(m);
    let score = mainHistory[(stm << 12) | (from << 6) | to];
    if (prev1Idx >= 0) {
      score += contHist1[prev1Idx * 832 + movedP * 64 + to];
    }
    if (prev2Idx >= 0) {
      score += contHist2[prev2Idx * 832 + movedP * 64 + to];
    }
    if ((m & MV_FLAG_CASTLE) !== 0) {
      score += 12000;
    }
    scores[i] = score;
  }
}

function pickBestMove(moves: Int32Array, scores: Int32Array, start: number, count: number): void {
  let bestIdx = start;
  let bestScore = scores[start];
  for (let i = start + 1; i < count; i++) {
    if (scores[i] > bestScore) {
      bestScore = scores[i];
      bestIdx = i;
    }
  }
  if (bestIdx !== start) {
    const tm = moves[start];
    moves[start] = moves[bestIdx];
    moves[bestIdx] = tm;
    const ts = scores[start];
    scores[start] = scores[bestIdx];
    scores[bestIdx] = ts;
  }
}

interface InternalSearchCtx {
  nodes: number;
  qnodes: number;
  seldepth: number;
  ttHits: number;
  deadlineMs: number;
  aborted: boolean;
  contemptCp: number;
  excludedRootMoves: Set<number> | null;
}

function qsearch(
  board: FastBoard,
  ply: number,
  alpha: number,
  beta: number,
  ctx: InternalSearchCtx
): number {
  ctx.nodes++;
  ctx.qnodes++;
  if (ply > ctx.seldepth) ctx.seldepth = ply;

  if ((ctx.nodes & 1023) === 0 && performance.now() >= ctx.deadlineMs) {
    ctx.aborted = true;
    return 0;
  }

  if (ply >= MAX_PLY - 2) {
    return evaluateFast(board, ctx.contemptCp);
  }

  if (board.isRepetition() || board.isInsufficientMaterial()) {
    return 0;
  }

  const inCheck = board.isInCheck();

  // TT Probe in Quiescence Search
  const ttIdx = board.hashLo & TT_MASK;
  const ttHit = ttKeyLo[ttIdx] === board.hashLo && ttKeyHi[ttIdx] === board.hashHi && ttBound[ttIdx] !== BOUND_NONE;
  let ttMoveVal = 0;
  let rawStaticEval = 0;
  let hasEval = false;

  if (ttHit) {
    ctx.ttHits++;
    ttMoveVal = ttMove[ttIdx];
    rawStaticEval = ttEval[ttIdx];
    hasEval = true;
    if (beta - alpha <= 1) {
      const s = scoreFromTT(ttScore[ttIdx], ply);
      const b = ttBound[ttIdx];
      if (b === BOUND_EXACT) return s;
      if (b === BOUND_LOWER && s >= beta) return s;
      if (b === BOUND_UPPER && s <= alpha) return s;
    }
  }

  let bestScore = -INF;
  const origAlpha = alpha;

  if (!inCheck) {
    if (!hasEval) {
      rawStaticEval = evaluateFast(board, ctx.contemptCp);
    }
    bestScore = rawStaticEval;
    if (bestScore >= beta) {
      return bestScore;
    }
    if (bestScore > alpha) {
      alpha = bestScore;
    }
    // Delta pruning
    if (bestScore + 1050 < alpha) {
      return bestScore;
    }
  }

  const moves = moveStack[ply];
  const scores = scoreStack[ply];
  const count = board.generatePseudoLegalMoves(moves, !inCheck);
  scoreMovesForPly(board, moves, scores, count, ttMoveVal, ply, !inCheck);

  let legalCount = 0;
  let bestMove = 0;

  for (let i = 0; i < count; i++) {
    pickBestMove(moves, scores, i, count);
    const m = moves[i];

    // SEE pruning in QSearch when not in check
    if (!inCheck && legalCount > 0 && movePromo(m) === 0 && !seeGe(board, m, 0)) {
      continue;
    }

    if (!board.makeMove(m)) continue;
    legalCount++;
    movedPieceStack[ply] = movePiece(m);
    movedToStack[ply] = moveTo(m);

    const score = -qsearch(board, ply + 1, -beta, -alpha, ctx);
    board.unmakeLegalMove(m);

    if (ctx.aborted) return 0;

    if (score > bestScore) {
      bestScore = score;
      bestMove = m;
      if (score > alpha) {
        alpha = score;
        if (score >= beta) {
          storeTT(board.hashLo, board.hashHi, bestMove, scoreToTT(bestScore, ply), rawStaticEval, 0, BOUND_LOWER);
          return bestScore;
        }
      }
    }
  }

  if (inCheck && legalCount === 0) {
    return -MATE_SCORE + ply;
  }

  const bound = bestScore <= origAlpha ? BOUND_UPPER : BOUND_EXACT;
  storeTT(board.hashLo, board.hashHi, bestMove, scoreToTT(bestScore, ply), rawStaticEval, 0, bound);
  return bestScore;
}

function pvs(
  board: FastBoard,
  depth: number,
  ply: number,
  alpha: number,
  beta: number,
  nullUsed: boolean,
  excludedMove: number,
  ctx: InternalSearchCtx
): number {
  pvLen[ply] = 0;

  if ((ctx.nodes & 1023) === 0 && performance.now() >= ctx.deadlineMs) {
    ctx.aborted = true;
    return 0;
  }

  const isRoot = ply === 0;
  const isPv = beta - alpha > 1;

  if (!isRoot) {
    if (board.halfmove >= 100 || board.isRepetition() || board.isInsufficientMaterial()) {
      return 0;
    }
    if (ply >= MAX_PLY - 2) {
      return evaluateFast(board, ctx.contemptCp);
    }
    // Mate distance pruning
    alpha = Math.max(alpha, -MATE_SCORE + ply);
    beta = Math.min(beta, MATE_SCORE - ply - 1);
    if (alpha >= beta) return alpha;
  }

  const inCheck = board.isInCheck();
  inCheckStack[ply] = inCheck ? 1 : 0;

  if (inCheck && ply < MAX_PLY - 4) {
    depth++;
  }

  if (depth <= 0) {
    return qsearch(board, ply, alpha, beta, ctx);
  }

  ctx.nodes++;
  if (ply > ctx.seldepth) ctx.seldepth = ply;

  // Transposition Table Probe
  const ttIdx = board.hashLo & TT_MASK;
  let ttHit = false;
  let ttMoveVal = 0;
  let ttScoreVal = 0;
  let ttDepthVal = -1;
  let ttBoundVal = BOUND_NONE;
  let ttRawEval = 0;

  if (excludedMove === 0) {
    ttHit = ttKeyLo[ttIdx] === board.hashLo && ttKeyHi[ttIdx] === board.hashHi && ttBound[ttIdx] !== BOUND_NONE;
    if (ttHit) {
      ttMoveVal = ttMove[ttIdx];
      ttScoreVal = scoreFromTT(ttScore[ttIdx], ply);
      ttDepthVal = ttDepth[ttIdx];
      ttBoundVal = ttBound[ttIdx];
      ttRawEval = ttEval[ttIdx];

      if (!isPv && !isRoot && ttDepthVal >= depth) {
        ctx.ttHits++;
        if (ttBoundVal === BOUND_EXACT) return ttScoreVal;
        if (ttBoundVal === BOUND_LOWER && ttScoreVal >= beta) return ttScoreVal;
        if (ttBoundVal === BOUND_UPPER && ttScoreVal <= alpha) return ttScoreVal;
      }
    }
  }

  // Internal Iterative Reduction (IIR)
  if (depth >= 4 && ttMoveVal === 0 && excludedMove === 0) {
    depth--;
  }

  // Static Evaluation + Correction History
  let rawStaticEval = 0;
  let staticEval = 0;
  let improving = false;
  const stm = board.stm;
  const pCorrIdx = (stm << 14) | (board.pawnHash & 0x3fff);
  const npCorrIdxW = (stm << 14) | (board.nonPawnHash[0] & 0x3fff);
  const npCorrIdxB = (stm << 14) | (board.nonPawnHash[1] & 0x3fff);

  if (!inCheck) {
    rawStaticEval = ttHit ? ttRawEval : evaluateFast(board, ctx.contemptCp);
    const corr =
      (pawnCorrHist[pCorrIdx] * 2 + nonPawnCorrHistW[npCorrIdxW] + nonPawnCorrHistB[npCorrIdxB]) >> 7;
    staticEval = clamp(rawStaticEval + corr, -MATE_IN_MAX + 1, MATE_IN_MAX - 1);
    staticEvalStack[ply] = staticEval;
    improving = ply >= 2 && inCheckStack[ply - 2] === 0 && staticEval > staticEvalStack[ply - 2];
  } else {
    staticEval = -MATE_SCORE + ply;
    staticEvalStack[ply] = staticEval;
  }

  // Clear child killers
  if (ply + 1 < MAX_PLY) {
    killers[(ply + 1) * 2] = 0;
    killers[(ply + 1) * 2 + 1] = 0;
  }

  // 1. Reverse Futility Pruning (RFP)
  if (!isPv && !inCheck && excludedMove === 0 && depth <= 7 && Math.abs(beta) < MATE_IN_MAX) {
    const rfpMargin = depth * (improving ? 65 : 85);
    if (staticEval - rfpMargin >= beta) {
      return staticEval;
    }
  }

  // 2. Razoring
  if (!isPv && !inCheck && excludedMove === 0 && depth <= 3 && Math.abs(alpha) < MATE_IN_MAX) {
    if (staticEval + 250 + 120 * depth <= alpha) {
      const qScore = qsearch(board, ply, alpha, alpha + 1, ctx);
      if (ctx.aborted) return 0;
      if (qScore <= alpha) return qScore;
    }
  }

  // 3. Null Move Pruning (NMP) with dynamic R and endgame verification
  if (
    !isPv &&
    !inCheck &&
    excludedMove === 0 &&
    !nullUsed &&
    depth >= 3 &&
    staticEval >= beta &&
    Math.abs(beta) < MATE_IN_MAX &&
    board.hasNonPawnMaterial(stm)
  ) {
    const R = 3 + (depth >> 2) + Math.min(3, Math.trunc((staticEval - beta) / 200));
    board.makeNullMove();
    movedPieceStack[ply] = 0;
    movedToStack[ply] = -1;
    const nullScore = -pvs(board, depth - R, ply + 1, -beta, -beta + 1, true, 0, ctx);
    board.unmakeNullMove();

    if (ctx.aborted) return 0;

    if (nullScore >= beta) {
      const clampedNull = nullScore >= MATE_IN_MAX ? beta : nullScore;
      if (depth < 12 && board.nonPawnMat[stm] >= 400) {
        return clampedNull;
      }
      // Verification search against zugzwang in low-material / deep NMP
      const verifScore = pvs(board, depth - R, ply, beta - 1, beta, true, 0, ctx);
      if (ctx.aborted) return 0;
      if (verifScore >= beta) {
        return clampedNull;
      }
    }
  }

  // 4. SEE-Gated ProbCut
  if (!isPv && !inCheck && excludedMove === 0 && depth >= 5 && Math.abs(beta) < MATE_IN_MAX) {
    const pcBeta = beta + 180;
    const pcThresh = pcBeta - staticEval;
    const pcMoves = moveStack[ply];
    const pcScores = scoreStack[ply];
    const pcCount = board.generatePseudoLegalMoves(pcMoves, true);
    scoreMovesForPly(board, pcMoves, pcScores, pcCount, ttMoveVal, ply, true);

    for (let i = 0; i < pcCount; i++) {
      pickBestMove(pcMoves, pcScores, i, pcCount);
      const m = pcMoves[i];
      if (!seeGe(board, m, pcThresh)) continue;
      if (!board.makeMove(m)) continue;

      movedPieceStack[ply] = movePiece(m);
      movedToStack[ply] = moveTo(m);
      let pcScore = -qsearch(board, ply + 1, -pcBeta, -pcBeta + 1, ctx);
      if (!ctx.aborted && pcScore >= pcBeta) {
        pcScore = -pvs(board, depth - 4, ply + 1, -pcBeta, -pcBeta + 1, false, 0, ctx);
      }
      board.unmakeLegalMove(m);

      if (ctx.aborted) return 0;
      if (pcScore >= pcBeta) {
        storeTT(board.hashLo, board.hashHi, m, scoreToTT(pcScore, ply), rawStaticEval, depth - 3, BOUND_LOWER);
        return pcScore;
      }
    }
  }

  // 5. Generate & Score All Moves
  const moves = moveStack[ply];
  const scores = scoreStack[ply];
  const count = board.generatePseudoLegalMoves(moves, false);
  scoreMovesForPly(board, moves, scores, count, ttMoveVal, ply, false);

  const quiets = quietTried[ply];
  const caps = capTried[ply];
  let qCount = 0;
  let cCount = 0;

  let legalCount = 0;
  let bestScore = -INF;
  let bestMove = 0;
  const origAlpha = alpha;

  const prev1Idx = ply >= 1 && movedPieceStack[ply - 1] > 0
    ? movedPieceStack[ply - 1] * 64 + movedToStack[ply - 1]
    : -1;
  const prev2Idx = ply >= 2 && movedPieceStack[ply - 2] > 0
    ? movedPieceStack[ply - 2] * 64 + movedToStack[ply - 2]
    : -1;

  for (let i = 0; i < count; i++) {
    pickBestMove(moves, scores, i, count);
    const m = moves[i];
    if (m === excludedMove) continue;
    if (isRoot && ctx.excludedRootMoves && ctx.excludedRootMoves.has(m)) continue;

    const isQuiet = (m & MV_FLAG_CAPTURE) === 0 && movePromo(m) === 0;
    const isCastle = (m & MV_FLAG_CASTLE) !== 0;
    const mFrom = moveFrom(m);
    const mTo = moveTo(m);
    const mPiece = movePiece(m);

    // Move-loop pruning at non-root when we already have a non-mate move
    if (!isRoot && bestScore > -MATE_IN_MAX) {
      if (isQuiet) {
        // LMP (Late Move Pruning)
        if (!isPv && !inCheck && depth <= 5) {
          const lmpLimit = improving ? 3 + depth * depth : ((3 + depth * depth) >> 1) + 1;
          if (qCount >= lmpLimit) continue;
        }
        // Futility Pruning
        if (!isPv && !inCheck && depth <= 6 && !isCastle && Math.abs(alpha) < MATE_IN_MAX) {
          if (staticEval + 90 + 75 * depth <= alpha && !board.givesCheck(m)) {
            continue;
          }
        }
        // Quiet SEE Pruning
        if (depth <= 6 && !seeGe(board, m, -20 * depth * depth)) {
          continue;
        }
      } else {
        // Capture SEE Pruning
        if (!isPv && depth <= 5 && !seeGe(board, m, -90 * depth) && !board.givesCheck(m)) {
          continue;
        }
      }
    }

    // Singular Extension check on TT move
    let extension = 0;
    if (
      !isRoot &&
      excludedMove === 0 &&
      depth >= 7 &&
      m === ttMoveVal &&
      ttDepthVal >= depth - 3 &&
      (ttBoundVal === BOUND_LOWER || ttBoundVal === BOUND_EXACT) &&
      Math.abs(ttScoreVal) < MATE_IN_MAX &&
      ply < depth * 2
    ) {
      const sBeta = ttScoreVal - depth * 2;
      const sScore = pvs(board, (depth - 1) >> 1, ply, sBeta - 1, sBeta, false, m, ctx);
      if (ctx.aborted) return 0;

      if (sScore < sBeta) {
        extension = !isPv && sScore < sBeta - depth * 3 ? 2 : 1;
      } else if (sBeta >= beta) {
        return sBeta; // Multi-Cut!
      } else if (ttScoreVal >= beta) {
        extension = -1; // Negative extension when non-singular
      }
    } else if (
      pieceTypeOf(mPiece) === PT_PAWN &&
      ((stm === WHITE && (mTo >> 3) === 6) || (stm !== WHITE && (mTo >> 3) === 1))
    ) {
      extension = 1; // 7th rank passed/advancing pawn extension
    }

    if (!board.makeMove(m)) continue;
    legalCount++;
    movedPieceStack[ply] = mPiece;
    movedToStack[ply] = mTo;

    const childGivesCheck = board.isInCheck();
    const newDepth = depth - 1 + extension;
    let score = 0;

    if (legalCount === 1) {
      score = -pvs(board, newDepth, ply + 1, -beta, -alpha, false, 0, ctx);
    } else {
      // Late Move Reduction (LMR)
      let r = 0;
      if (depth >= 3 && legalCount >= 3 && (isQuiet || !seeGe(board, m, 0))) {
        const dIdx = depth < 64 ? depth : 63;
        const mIdx = legalCount < 64 ? legalCount : 63;
        r = LMR_TABLE[dIdx][mIdx];
        if (isPv) r--;
        if (!improving) r++;
        if (childGivesCheck) r--;
        if (m === killers[ply * 2] || m === killers[ply * 2 + 1]) r--;
        if (isQuiet) {
          let h = mainHistory[(stm << 12) | (mFrom << 6) | mTo];
          if (prev1Idx >= 0) h += contHist1[prev1Idx * 832 + mPiece * 64 + mTo];
          if (prev2Idx >= 0) h += contHist2[prev2Idx * 832 + mPiece * 64 + mTo];
          r -= Math.round(h / 10000);
        }
        r = clamp(r, 0, Math.max(0, newDepth - 1));
      }

      // Null-window reduced search
      score = -pvs(board, newDepth - r, ply + 1, -alpha - 1, -alpha, false, 0, ctx);

      // Re-search full depth if reduced search beat alpha
      if (!ctx.aborted && score > alpha && r > 0) {
        score = -pvs(board, newDepth, ply + 1, -alpha - 1, -alpha, false, 0, ctx);
      }

      // Re-search full window at PV nodes
      if (!ctx.aborted && score > alpha && score < beta) {
        score = -pvs(board, newDepth, ply + 1, -beta, -alpha, false, 0, ctx);
      }
    }

    board.unmakeLegalMove(m);
    if (ctx.aborted) return 0;

    if (score > bestScore) {
      bestScore = score;
      bestMove = m;

      if (score > alpha) {
        alpha = score;

        // Copy PV
        pvTable[ply][0] = m;
        const childLen = ply + 1 < MAX_PLY ? pvLen[ply + 1] : 0;
        for (let j = 0; j < childLen; j++) {
          pvTable[ply][j + 1] = pvTable[ply + 1][j];
        }
        pvLen[ply] = 1 + childLen;

        if (score >= beta) {
          const bonus = Math.min(2000, depth * depth * 32);
          if (isQuiet) {
            if (killers[ply * 2] !== m) {
              killers[ply * 2 + 1] = killers[ply * 2];
              killers[ply * 2] = m;
            }
            if (prev1Idx >= 0) {
              counterMoves[prev1Idx] = m;
              updateContHist(contHist1, prev1Idx, mPiece, mTo, bonus);
            }
            if (prev2Idx >= 0) {
              updateContHist(contHist2, prev2Idx, mPiece, mTo, bonus);
            }
            updateMainHistory(stm, mFrom, mTo, bonus);

            // Malus to prior failed-low quiets
            for (let qi = 0; qi < qCount; qi++) {
              const qm = quiets[qi];
              const qf = moveFrom(qm);
              const qt = moveTo(qm);
              const qp = movePiece(qm);
              updateMainHistory(stm, qf, qt, -bonus);
              if (prev1Idx >= 0) updateContHist(contHist1, prev1Idx, qp, qt, -bonus);
              if (prev2Idx >= 0) updateContHist(contHist2, prev2Idx, qp, qt, -bonus);
            }
          } else {
            const capPt = moveIsCapture(m) ? pieceTypeOf(moveCaptured(m)) : 0;
            updateCapHistory(mPiece, mTo, capPt, bonus);
          }

          // Malus to prior failed-low captures
          for (let ci = 0; ci < cCount; ci++) {
            const cm = caps[ci];
            const cpPt = moveIsCapture(cm) ? pieceTypeOf(moveCaptured(cm)) : 0;
            updateCapHistory(movePiece(cm), moveTo(cm), cpPt, -bonus);
          }

          break;
        }
      }
    }

    if (isQuiet && qCount < 256) {
      quiets[qCount++] = m;
    } else if (!isQuiet && cCount < 128) {
      caps[cCount++] = m;
    }
  }

  if (legalCount === 0) {
    if (excludedMove !== 0) return alpha;
    return inCheck ? -MATE_SCORE + ply : 0;
  }

  const bound = bestScore >= beta ? BOUND_LOWER : bestScore <= origAlpha ? BOUND_UPPER : BOUND_EXACT;

  // Update Correction History
  if (
    !inCheck &&
    excludedMove === 0 &&
    bestMove !== 0 &&
    Math.abs(bestScore) < MATE_IN_MAX &&
    (bound === BOUND_EXACT ||
      (bound === BOUND_LOWER && bestScore > staticEval) ||
      (bound === BOUND_UPPER && bestScore < staticEval))
  ) {
    const err = clamp((bestScore - rawStaticEval) * 32, -1024, 1024);
    const weight = Math.min(depth + 1, 16);
    const pOld = pawnCorrHist[pCorrIdx];
    pawnCorrHist[pCorrIdx] = clamp(Math.round((pOld * (256 - weight) + err * weight) / 256), -1024, 1024);
    const nwOld = nonPawnCorrHistW[npCorrIdxW];
    nonPawnCorrHistW[npCorrIdxW] = clamp(Math.round((nwOld * (256 - weight) + err * weight) / 256), -1024, 1024);
    const nbOld = nonPawnCorrHistB[npCorrIdxB];
    nonPawnCorrHistB[npCorrIdxB] = clamp(Math.round((nbOld * (256 - weight) + err * weight) / 256), -1024, 1024);
  }

  if (excludedMove === 0) {
    storeTT(board.hashLo, board.hashHi, bestMove, scoreToTT(bestScore, ply), rawStaticEval, depth, bound);
  }

  return bestScore;
}

export interface FastSearchCandidate {
  rank: number;
  scoreCp: number;
  bestMoveInt: number;
  bestMoveUci: string;
  pvUci: string[];
}

export interface FastSearchResult {
  nodes: number;
  qnodes: number;
  depth: number;
  seldepth: number;
  timeMs: number;
  nps: number;
  scoreCp: number;
  bestMoveInt: number;
  bestMoveUci: string;
  pvUci: string[];
  ttHits: number;
  multiPv: FastSearchCandidate[];
}

/**
 * Iterative Deepening + Aspiration Window + Multi-PV Root Search Driver
 */
export function runFastSearch(
  fen: string,
  maxDepth = 12,
  timeLimitMs = 800,
  multiPvCount = 1,
  gameHistoryFens?: string[],
  contemptCp = 12
): FastSearchResult {
  const startTime = performance.now();
  const board = FastBoard.fromFen(fen);

  // Seed game history hashes if provided (enables repetition detection across game history!)
  if (gameHistoryFens && gameHistoryFens.length > 0) {
    const startIdx = Math.max(0, gameHistoryFens.length - 60);
    let hCount = 0;
    const tmp = new FastBoard();
    for (let i = startIdx; i < gameHistoryFens.length && hCount < 400; i++) {
      const f = gameHistoryFens[i];
      if (!f) continue;
      // Ensure valid 6-field FEN for loadFen
      const fullFen = f.split(/\s+/).length >= 4 ? f : `${f} w - - 0 1`;
      const norm = fullFen.split(/\s+/).length === 4 ? `${fullFen} 0 1` : fullFen;
      try {
        tmp.loadFen(norm);
        board.repHashLo[hCount] = tmp.hashLo;
        board.repHashHi[hCount] = tmp.hashHi;
        hCount++;
      } catch {
        // skip malformed entry
      }
    }
    board.repHashLo[hCount] = board.hashLo;
    board.repHashHi[hCount] = board.hashHi;
    board.repCount = hCount + 1;
  }

  const legalMoves = new Int32Array(256);
  const numLegal = board.generateLegalMoves(legalMoves, false);

  if (numLegal === 0) {
    return {
      nodes: 1,
      qnodes: 0,
      depth: 0,
      seldepth: 0,
      timeMs: 1,
      nps: 1000,
      scoreCp: board.isInCheck() ? -MATE_SCORE : 0,
      bestMoveInt: 0,
      bestMoveUci: '0000',
      pvUci: [],
      ttHits: 0,
      multiPv: [],
    };
  }

  // Only 1 legal move: return instantly after depth-1 eval
  if (numLegal === 1) {
    const onlyM = legalMoves[0];
    const uci = moveToUci(onlyM);
    board.makeMove(onlyM);
    const sc = -evaluateFast(board, contemptCp);
    board.unmakeLegalMove(onlyM);
    return {
      nodes: 1,
      qnodes: 0,
      depth: 1,
      seldepth: 1,
      timeMs: 1,
      nps: 1000,
      scoreCp: sc,
      bestMoveInt: onlyM,
      bestMoveUci: uci,
      pvUci: [uci],
      ttHits: 0,
      multiPv: [{ rank: 1, scoreCp: sc, bestMoveInt: onlyM, bestMoveUci: uci, pvUci: [uci] }],
    };
  }

  currentSearchAge = (currentSearchAge % 254) + 1;
  killers.fill(0);

  const clampedMultiPv = Math.min(Math.max(1, multiPvCount), numLegal);
  const hardDeadline = startTime + Math.max(10, timeLimitMs * 0.96);

  const ctx: InternalSearchCtx = {
    nodes: 0,
    qnodes: 0,
    seldepth: 0,
    ttHits: 0,
    deadlineMs: hardDeadline,
    aborted: false,
    contemptCp,
    excludedRootMoves: clampedMultiPv > 1 ? new Set<number>() : null,
  };

  let bestMoveInt = legalMoves[0];
  let bestScore = 0;
  let completedDepth = 0;
  let bestPvInts: number[] = [legalMoves[0]];
  let multiPvResults: FastSearchCandidate[] = [];

  let lastBestMoveInt = 0;
  let stableIters = 0;
  let moveFlips = 0;

  for (let d = 1; d <= maxDepth; d++) {
    if (d > 1 && performance.now() >= hardDeadline) break;

    const iterCandidates: FastSearchCandidate[] = [];
    if (ctx.excludedRootMoves) ctx.excludedRootMoves.clear();
    let iterAborted = false;

    for (let pvIdx = 0; pvIdx < clampedMultiPv; pvIdx++) {
      let alpha = -INF;
      let beta = INF;
      let delta = 22;
      let score = 0;

      if (d >= 4 && pvIdx === 0 && Math.abs(bestScore) < MATE_IN_MAX) {
        alpha = Math.max(-INF, bestScore - delta);
        beta = Math.min(INF, bestScore + delta);
      }

      while (true) {
        ctx.aborted = false;
        score = pvs(board, d, 0, alpha, beta, false, 0, ctx);

        if (ctx.aborted) {
          iterAborted = true;
          break;
        }

        if (score <= alpha) {
          beta = Math.trunc((alpha + beta) / 2);
          alpha = Math.max(-INF, alpha - delta);
          delta = Math.trunc(delta * 1.5) + 10;
          if (pvIdx === 0) moveFlips++;
        } else if (score >= beta) {
          beta = Math.min(INF, beta + delta);
          delta = Math.trunc(delta * 1.5) + 10;
        } else {
          break;
        }

        if (delta > 1200) {
          alpha = -INF;
          beta = INF;
        }
      }

      if (iterAborted) break;

      const len = pvLen[0];
      const pvInts: number[] = [];
      for (let j = 0; j < len; j++) {
        pvInts.push(pvTable[0][j]);
      }
      const chosenInt = pvInts[0] || legalMoves[0];
      const pvUci = pvInts.map(moveToUci);

      iterCandidates.push({
        rank: pvIdx + 1,
        scoreCp: score,
        bestMoveInt: chosenInt,
        bestMoveUci: moveToUci(chosenInt),
        pvUci,
      });

      if (ctx.excludedRootMoves) {
        ctx.excludedRootMoves.add(chosenInt);
      }

      if (pvIdx === 0) {
        bestMoveInt = chosenInt;
        bestScore = score;
        bestPvInts = pvInts;
      }
    }

    if (iterAborted) {
      // If depth 1 aborted (tiny budget), keep whatever TT or first move found
      if (completedDepth === 0 && pvLen[0] > 0) {
        bestMoveInt = pvTable[0][0];
        bestPvInts = [bestMoveInt];
        completedDepth = 1;
      }
      break;
    }

    completedDepth = d;
    if (iterCandidates.length > 0) {
      multiPvResults = iterCandidates;
    }

    // Immediate mate found at short depth -> if mate-in-1/2 stop early once proved
    if (bestScore >= MATE_SCORE - d && d >= 3) {
      break;
    }

    const elapsed = performance.now() - startTime;
    if (bestMoveInt === lastBestMoveInt) {
      stableIters++;
      if (stableIters >= 3 && d >= 5 && elapsed >= timeLimitMs * 0.50 && moveFlips === 0) {
        break;
      }
    } else {
      lastBestMoveInt = bestMoveInt;
      stableIters = 0;
      moveFlips++;
    }

    // Don't start another iteration if we've used > 60% of budget (unless unstable)
    const softCeiling = moveFlips >= 2 ? timeLimitMs * 0.85 : timeLimitMs * 0.58;
    if (elapsed >= softCeiling && d >= 2) {
      break;
    }
  }

  const bestMoveUci = moveToUci(bestMoveInt);
  const pvUci = bestPvInts.map(moveToUci);
  if (multiPvResults.length === 0) {
    multiPvResults = [
      {
        rank: 1,
        scoreCp: bestScore,
        bestMoveInt,
        bestMoveUci,
        pvUci,
      },
    ];
  }

  const elapsedMs = Math.max(1, performance.now() - startTime);
  const nps = Math.round((ctx.nodes / elapsedMs) * 1000);

  return {
    nodes: ctx.nodes,
    qnodes: ctx.qnodes,
    depth: Math.max(1, completedDepth),
    seldepth: ctx.seldepth,
    timeMs: Math.round(elapsedMs),
    nps,
    scoreCp: bestScore,
    bestMoveInt,
    bestMoveUci,
    pvUci,
    ttHits: ctx.ttHits,
    multiPv: multiPvResults,
  };
}
