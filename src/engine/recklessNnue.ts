/**
 * Reckless NNUE Evaluator (v60-7f587dfb.nnue — Reckless 0.10.0-dev Real Quantized Network)
 *
 * Implements the exact Reckless threat-input + PSQ NNUE architecture:
 * - Feature Transformer:
 *     - PSQ Features: 10 king buckets x 12 piece types x 64 squares (int16)
 *     - Threat Features: 66,864 piece-interaction attack pairs (int8)
 * - Accumulator: 2 x 768 int16 (White / Black perspectives)
 * - Pairwise Activation: clamp(left, 0, 255) * clamp(right, 0, 255) >> 9 -> uint8[768]
 * - Output Head (8 material buckets):
 *     - L1: 768 (sparse NNZ 4-byte chunks) -> 16 float32 (ClippedReLU [0, 1])
 *     - L2: 16 -> 32 float32 (ClippedReLU [0, 1])
 *     - L3: 32 -> 1 float32 * NETWORK_SCALE (380)
 */

import {
  FastBoard,
  BoardObserver,
  WHITE,
  BLACK,
  PT_PAWN,
  PT_KNIGHT,
  PT_BISHOP,
  PT_ROOK,
  PT_QUEEN,
  PT_KING,
  EMPTY,
  FLAG_KING_CASTLE,
  FLAG_QUEEN_CASTLE,
  FLAG_EP,
  PAWN_ATK_LO,
  PAWN_ATK_HI,
  KNIGHT_ATK_LO,
  KNIGHT_ATK_HI,
  KING_ATK_LO,
  KING_ATK_HI,
  BETWEEN_LO,
  BETWEEN_HI,
  RAYPASS_LO,
  RAYPASS_HI,
  computeRookAttacks,
  computeBishopAttacks,
  computePieceAttacks,
  atkLoOut,
  atkHiOut,
  ctz32,
  popcount32,
} from './fastBoard';

export const RECKLESS_NET_NAME = 'v60-7f587dfb.nnue';
export const RECKLESS_NET_URL = '/nnue/v60-7f587dfb.nnue';
export const EXPECTED_NNUE_BYTES = 63266880;

const NETWORK_SCALE = 380;
const INPUT_BUCKETS = 10;
const OUTPUT_BUCKETS = 8;
const L1_SIZE = 768;
const L2_SIZE = 16;
const L3_SIZE = 32;
const FT_QUANT = 255;
const L1_QUANT = 64;
const FT_SHIFT = 9;
const DEQUANT_MULTIPLIER = (1 << FT_SHIFT) / (FT_QUANT * FT_QUANT * L1_QUANT);
const NUM_THREAT_FEATURES = 66864;

const INPUT_BUCKETS_LAYOUT = new Uint8Array([
  0, 1, 2, 3, 3, 2, 1, 0,
  4, 5, 6, 7, 7, 6, 5, 4,
  8, 8, 8, 8, 8, 8, 8, 8,
  9, 9, 9, 9, 9, 9, 9, 9,
  9, 9, 9, 9, 9, 9, 9, 9,
  9, 9, 9, 9, 9, 9, 9, 9,
  9, 9, 9, 9, 9, 9, 9, 9,
  9, 9, 9, 9, 9, 9, 9, 9,
]);

const OUTPUT_BUCKETS_LAYOUT = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1,
  2, 2, 2, 2,
  3, 3, 3,
  4, 4, 4,
  5, 5, 5,
  6, 6, 6,
  7, 7, 7, 7,
]);

// ----------------------------------------------------------------------------
// Precomputed Threat Index Tables (exact Reckless threat_index.rs port)
// ----------------------------------------------------------------------------
const PIECE_PAIR_LOOKUP = new Uint32Array(12 * 12);
const PIECE_OFFSET_LOOKUP = new Int32Array(12 * 64);
const ATTACK_INDEX_LOOKUP = new Uint8Array(12 * 64 * 64);

(function initThreatIndexTables() {
  const PIECE_INTERACTION_MAP = [
    [0, 1, -1, 2, -1, -1],
    [0, 1, 2, 3, 4, -1],
    [0, 1, 2, 3, -1, -1],
    [0, 1, 2, 3, -1, -1],
    [0, 1, 2, 3, 4, -1],
    [0, 1, 2, 3, -1, -1],
  ];
  const PIECE_TARGET_COUNT = [6, 10, 8, 8, 10, 8];

  let offset = 0;
  const pieceOffset = new Int32Array(12);
  const offsetTable = new Int32Array(12);

  for (let color = 0; color < 2; color++) {
    for (let pt = 0; pt < 6; pt++) {
      const piece = (pt << 1) | color;
      let count = 0;
      for (let sq = 0; sq < 64; sq++) {
        PIECE_OFFSET_LOOKUP[piece * 64 + sq] = count;
        if (pt !== PT_PAWN || (sq >= 8 && sq < 56)) {
          computePieceAttacks(piece, sq, 0, 0);
          count += popcount32(atkLoOut) + popcount32(atkHiOut);
        }
      }
      pieceOffset[piece] = count;
      offsetTable[piece] = offset;
      offset += PIECE_TARGET_COUNT[pt] * count;
    }
  }

  for (let attacking = 0; attacking < 12; attacking++) {
    const atkPt = attacking >> 1;
    const atkCol = attacking & 1;
    for (let attacked = 0; attacked < 12; attacked++) {
      const defPt = attacked >> 1;
      const defCol = attacked & 1;
      const map = PIECE_INTERACTION_MAP[atkPt][defPt];
      const base =
        offsetTable[attacking] +
        (defCol * (PIECE_TARGET_COUNT[atkPt] >> 1) + map) * pieceOffset[attacking];
      const enemy = atkCol !== defCol;
      const semiExcluded = atkPt === defPt && (enemy || atkPt !== PT_PAWN);
      const excluded = map < 0;

      const inner =
        (((semiExcluded && !excluded ? 1 : 0) << 30) |
          ((excluded ? 1 : 0) << 31) |
          (base & 0x3fffffff)) >>>
        0;
      PIECE_PAIR_LOOKUP[attacking * 12 + attacked] = inner;
    }
  }

  for (let piece = 0; piece < 12; piece++) {
    for (let from = 0; from < 64; from++) {
      computePieceAttacks(piece, from, 0, 0);
      const baseIdx = (piece * 64 + from) * 64;
      for (let to = 0; to < 64; to++) {
        if (to < 32) {
          const maskLo = to === 0 ? 0 : (((1 << to) - 1) >>> 0);
          ATTACK_INDEX_LOOKUP[baseIdx + to] = popcount32(atkLoOut & maskLo);
        } else {
          const shift = to - 32;
          const maskHi = shift === 0 ? 0 : (((1 << shift) - 1) >>> 0);
          ATTACK_INDEX_LOOKUP[baseIdx + to] = popcount32(atkLoOut) + popcount32(atkHiOut & maskHi);
        }
      }
    }
  }
})();

export function threatIndex(
  piece: number,
  from: number,
  attacked: number,
  to: number,
  mirrored: boolean,
  pov: number
): number {
  const flip = (mirrored ? 7 : 0) ^ (56 * pov);
  const f = from ^ flip;
  const t = to ^ flip;
  const atk = piece ^ pov;
  const def = attacked ^ pov;

  const inner = PIECE_PAIR_LOOKUP[atk * 12 + def];
  const below = f < t ? 1 : 0;
  const baseSigned = (((inner + ((below << 30) >>> 0)) >>> 0) & 0x80ffffff) | 0;
  if (baseSigned < 0) return -1;

  return (
    baseSigned +
    PIECE_OFFSET_LOOKUP[atk * 64 + f] +
    ATTACK_INDEX_LOOKUP[(atk * 64 + f) * 64 + t]
  );
}

export function pstIndex(
  color: number,
  pieceType: number,
  sq: number,
  kingSq: number,
  pov: number
): number {
  const kingIsKingside = (kingSq & 7) >= 4 ? 1 : 0;
  const flip = (7 * kingIsKingside) ^ (56 * pov);
  const bucket = INPUT_BUCKETS_LAYOUT[kingSq ^ flip];
  return (
    bucket * 768 +
    (color !== pov ? 384 : 0) +
    pieceType * 64 +
    (sq ^ flip)
  );
}

// ----------------------------------------------------------------------------
// Network Parameter Views (Zero-Copy ArrayBuffer Mapping)
// ----------------------------------------------------------------------------
export interface RecklessParameters {
  buffer: ArrayBuffer;
  ftThreatWeights: Int8Array; // [66864 * 768]
  ftPieceWeights: Int16Array; // [10 * 768 * 768]
  ftBiases: Int16Array; // [768]
  l1Weights: Int8Array; // [8 * 16 * 768]
  l1Biases: Float32Array; // [8 * 16]
  l2Weights: Float32Array; // [8 * 16 * 32]
  l2Biases: Float32Array; // [8 * 32]
  l3Weights: Float32Array; // [8 * 32]
  l3Biases: Float32Array; // [8]
}

let loadedParams: RecklessParameters | null = null;
let loadPromise: Promise<RecklessParameters | null> | null = null;

export function isRecklessNnueLoaded(): boolean {
  return loadedParams !== null;
}

export function getRecklessNnueParams(): RecklessParameters | null {
  return loadedParams;
}

export function loadRecklessNnueFromBuffer(buffer: ArrayBuffer): RecklessParameters {
  if (buffer.byteLength < EXPECTED_NNUE_BYTES - 32) {
    throw new Error(
      `Invalid Reckless NNUE buffer size: expected >= ${EXPECTED_NNUE_BYTES - 32} bytes, got ${buffer.byteLength}`
    );
  }
  const params: RecklessParameters = {
    buffer,
    ftThreatWeights: new Int8Array(buffer, 0, NUM_THREAT_FEATURES * L1_SIZE),
    ftPieceWeights: new Int16Array(buffer, 51351552, INPUT_BUCKETS * 768 * L1_SIZE),
    ftBiases: new Int16Array(buffer, 63148032, L1_SIZE),
    l1Weights: new Int8Array(buffer, 63149568, OUTPUT_BUCKETS * L2_SIZE * L1_SIZE),
    l1Biases: new Float32Array(buffer, 63247872, OUTPUT_BUCKETS * L2_SIZE),
    l2Weights: new Float32Array(buffer, 63248384, OUTPUT_BUCKETS * L2_SIZE * L3_SIZE),
    l2Biases: new Float32Array(buffer, 63264768, OUTPUT_BUCKETS * L3_SIZE),
    l3Weights: new Float32Array(buffer, 63265792, OUTPUT_BUCKETS * L3_SIZE),
    l3Biases: new Float32Array(buffer, 63266816, OUTPUT_BUCKETS),
  };
  loadedParams = params;
  return params;
}

/**
 * Synchronous Node.js loader using process.getBuiltinModule (works cleanly without static fs import in browser bundles).
 */
export function tryLoadRecklessNnueNodeSync(): RecklessParameters | null {
  if (loadedParams) return loadedParams;
  try {
    const proc = typeof process !== 'undefined' ? (process as unknown as { getBuiltinModule?: (id: string) => unknown; cwd?: () => string }) : null;
    if (!proc || typeof proc.getBuiltinModule !== 'function') return null;

    const fs = proc.getBuiltinModule('node:fs') as {
      existsSync: (p: string) => boolean;
      readFileSync: (p: string) => Uint8Array;
    };
    const path = proc.getBuiltinModule('node:path') as {
      resolve: (...parts: string[]) => string;
    };
    if (!fs || !path) return null;

    const cwd = typeof proc.cwd === 'function' ? proc.cwd() : '.';
    const candidates = [
      path.resolve(cwd, 'public/nnue', RECKLESS_NET_NAME),
      path.resolve(cwd, 'nnue', RECKLESS_NET_NAME),
      path.resolve(cwd, RECKLESS_NET_NAME),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate);
        const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
        return loadRecklessNnueFromBuffer(ab);
      }
    }
  } catch {
    // Ignore in non-Node runtimes
  }
  return null;
}

/**
 * Universal initializer (Node.js disk or Browser/WebWorker fetch).
 */
export async function initRecklessNnue(url = RECKLESS_NET_URL): Promise<RecklessParameters | null> {
  if (loadedParams) return loadedParams;
  const sync = tryLoadRecklessNnueNodeSync();
  if (sync) return sync;

  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      if (typeof fetch !== 'function') return null;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const ab = await resp.arrayBuffer();
      return loadRecklessNnueFromBuffer(ab);
    } catch {
      return null;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

// Automatically try synchronous Node load when imported on server/CLI/tests
tryLoadRecklessNnueNodeSync();

// ----------------------------------------------------------------------------
// Lazy Incremental Accumulator Stack + Full Refresh Evaluator
// ----------------------------------------------------------------------------
const ACC_STACK_SIZE = 132;
const MAX_DELTAS_PER_PLY = 96;

export class RecklessEvaluator implements BoardObserver {
  private params: RecklessParameters;

  // Per-ply accumulators: [ply][pov (0/1)] flattened into Int16Array(ACC_STACK_SIZE * 2 * 768)
  private pstValues = new Int16Array(ACC_STACK_SIZE * 2 * L1_SIZE);
  private threatValues = new Int16Array(ACC_STACK_SIZE * 2 * L1_SIZE);
  private ply = 0;

  // Lazy validity & dirty delta stacks
  private pstValid = new Uint8Array(ACC_STACK_SIZE * 2);
  private threatValid = new Uint8Array(ACC_STACK_SIZE * 2);
  private pstRefresh = new Uint8Array(ACC_STACK_SIZE * 2);
  private threatRefresh = new Uint8Array(ACC_STACK_SIZE * 2);

  // Per-ply PSQ delta indices: [add1, add2, sub1, sub2] per [ply][pov] (-1 = none)
  private pstAdd1 = new Int32Array(ACC_STACK_SIZE * 2);
  private pstAdd2 = new Int32Array(ACC_STACK_SIZE * 2);
  private pstSub1 = new Int32Array(ACC_STACK_SIZE * 2);
  private pstSub2 = new Int32Array(ACC_STACK_SIZE * 2);

  // Per-ply threat delta indices: [(ply*2 + pov) * MAX_DELTAS_PER_PLY]
  private threatAddIdx = new Int32Array(ACC_STACK_SIZE * 2 * MAX_DELTAS_PER_PLY);
  private threatSubIdx = new Int32Array(ACC_STACK_SIZE * 2 * MAX_DELTAS_PER_PLY);
  private threatAddCnt = new Int16Array(ACC_STACK_SIZE * 2);
  private threatSubCnt = new Int16Array(ACC_STACK_SIZE * 2);

  // Scratch buffers for forward pass (zero allocation)
  private ftOut = new Uint8Array(L1_SIZE);
  private l1Pre = new Int32Array(L2_SIZE);
  private l1Out = new Float32Array(L2_SIZE);
  private l2Out = new Float32Array(L3_SIZE);

  constructor(params: RecklessParameters) {
    this.params = params;
  }

  public onReset(board: FastBoard): void {
    this.ply = 0;
    this.pstValid.fill(0);
    this.threatValid.fill(0);
    this.refreshPstPov(board, WHITE, 0);
    this.refreshPstPov(board, BLACK, 0);
    this.refreshThreatsPov(board, WHITE, 0);
    this.refreshThreatsPov(board, BLACK, 0);
  }

  private refreshPstPov(board: FastBoard, pov: number, targetPly: number): void {
    const off = (targetPly * 2 + pov) * L1_SIZE;
    this.pstValues.set(this.params.ftBiases, off);
    const kingSq = board.kingSq[pov];
    const ftPiece = this.params.ftPieceWeights;

    for (let piece = 0; piece < 12; piece++) {
      const c = piece & 1;
      const pt = piece >> 1;
      let lo = board.pieceLo[piece];
      let hi = board.pieceHi[piece];
      while (lo !== 0) {
        const sq = ctz32(lo);
        lo &= lo - 1;
        const wOff = pstIndex(c, pt, sq, kingSq, pov) * L1_SIZE;
        for (let i = 0; i < L1_SIZE; i++) {
          this.pstValues[off + i] += ftPiece[wOff + i];
        }
      }
      while (hi !== 0) {
        const sq = 32 + ctz32(hi);
        hi &= hi - 1;
        const wOff = pstIndex(c, pt, sq, kingSq, pov) * L1_SIZE;
        for (let i = 0; i < L1_SIZE; i++) {
          this.pstValues[off + i] += ftPiece[wOff + i];
        }
      }
    }
    this.pstValid[targetPly * 2 + pov] = 1;
    this.pstRefresh[targetPly * 2 + pov] = 0;
  }

  private refreshThreatsPov(board: FastBoard, pov: number, targetPly: number): void {
    const off = (targetPly * 2 + pov) * L1_SIZE;
    this.threatValues.fill(0, off, off + L1_SIZE);
    const kingSq = board.kingSq[pov];
    const mirrored = (kingSq & 7) >= 4;
    const ftThreat = this.params.ftThreatWeights;
    const occLo = board.occLo;
    const occHi = board.occHi;

    let pLo = occLo;
    let pHi = occHi;
    while (pLo !== 0) {
      const sq = ctz32(pLo);
      pLo &= pLo - 1;
      const piece = board.mailbox[sq];
      computePieceAttacks(piece, sq, occLo, occHi);
      let tLo = atkLoOut & occLo;
      let tHi = atkHiOut & occHi;
      while (tLo !== 0) {
        const target = ctz32(tLo);
        tLo &= tLo - 1;
        const idx = threatIndex(piece, sq, board.mailbox[target], target, mirrored, pov);
        if (idx >= 0) {
          const wOff = idx * L1_SIZE;
          for (let i = 0; i < L1_SIZE; i++) {
            this.threatValues[off + i] += ftThreat[wOff + i];
          }
        }
      }
      while (tHi !== 0) {
        const target = 32 + ctz32(tHi);
        tHi &= tHi - 1;
        const idx = threatIndex(piece, sq, board.mailbox[target], target, mirrored, pov);
        if (idx >= 0) {
          const wOff = idx * L1_SIZE;
          for (let i = 0; i < L1_SIZE; i++) {
            this.threatValues[off + i] += ftThreat[wOff + i];
          }
        }
      }
    }
    while (pHi !== 0) {
      const sq = 32 + ctz32(pHi);
      pHi &= pHi - 1;
      const piece = board.mailbox[sq];
      computePieceAttacks(piece, sq, occLo, occHi);
      let tLo = atkLoOut & occLo;
      let tHi = atkHiOut & occHi;
      while (tLo !== 0) {
        const target = ctz32(tLo);
        tLo &= tLo - 1;
        const idx = threatIndex(piece, sq, board.mailbox[target], target, mirrored, pov);
        if (idx >= 0) {
          const wOff = idx * L1_SIZE;
          for (let i = 0; i < L1_SIZE; i++) {
            this.threatValues[off + i] += ftThreat[wOff + i];
          }
        }
      }
      while (tHi !== 0) {
        const target = 32 + ctz32(tHi);
        tHi &= tHi - 1;
        const idx = threatIndex(piece, sq, board.mailbox[target], target, mirrored, pov);
        if (idx >= 0) {
          const wOff = idx * L1_SIZE;
          for (let i = 0; i < L1_SIZE; i++) {
            this.threatValues[off + i] += ftThreat[wOff + i];
          }
        }
      }
    }
    this.threatValid[targetPly * 2 + pov] = 1;
    this.threatRefresh[targetPly * 2 + pov] = 0;
  }

  private pushThreatDelta(
    targetPly: number,
    piece: number,
    from: number,
    attacked: number,
    to: number,
    add: boolean,
    wKingSq: number,
    bKingSq: number
  ): void {
    const idxW = threatIndex(piece, from, attacked, to, (wKingSq & 7) >= 4, WHITE);
    if (idxW >= 0) {
      const slot = targetPly * 2 + WHITE;
      if (add) {
        const c = this.threatAddCnt[slot];
        if (c < MAX_DELTAS_PER_PLY) {
          this.threatAddIdx[slot * MAX_DELTAS_PER_PLY + c] = idxW;
          this.threatAddCnt[slot] = c + 1;
        } else {
          this.threatRefresh[slot] = 1;
        }
      } else {
        const c = this.threatSubCnt[slot];
        if (c < MAX_DELTAS_PER_PLY) {
          this.threatSubIdx[slot * MAX_DELTAS_PER_PLY + c] = idxW;
          this.threatSubCnt[slot] = c + 1;
        } else {
          this.threatRefresh[slot] = 1;
        }
      }
    }
    const idxB = threatIndex(piece, from, attacked, to, (bKingSq & 7) >= 4, BLACK);
    if (idxB >= 0) {
      const slot = targetPly * 2 + BLACK;
      if (add) {
        const c = this.threatAddCnt[slot];
        if (c < MAX_DELTAS_PER_PLY) {
          this.threatAddIdx[slot * MAX_DELTAS_PER_PLY + c] = idxB;
          this.threatAddCnt[slot] = c + 1;
        } else {
          this.threatRefresh[slot] = 1;
        }
      } else {
        const c = this.threatSubCnt[slot];
        if (c < MAX_DELTAS_PER_PLY) {
          this.threatSubIdx[slot * MAX_DELTAS_PER_PLY + c] = idxB;
          this.threatSubCnt[slot] = c + 1;
        } else {
          this.threatRefresh[slot] = 1;
        }
      }
    }
  }

  private pushThreatsSingle(
    targetPly: number,
    board: FastBoard,
    occLo: number,
    occHi: number,
    piece: number,
    sq: number,
    add: boolean,
    wKingSq: number,
    bKingSq: number
  ): void {
    computePieceAttacks(piece, sq, occLo, occHi);
    let tLo = atkLoOut & occLo;
    let tHi = atkHiOut & occHi;
    while (tLo !== 0) {
      const target = ctz32(tLo);
      tLo &= tLo - 1;
      this.pushThreatDelta(targetPly, piece, sq, board.mailbox[target], target, add, wKingSq, bKingSq);
    }
    while (tHi !== 0) {
      const target = 32 + ctz32(tHi);
      tHi &= tHi - 1;
      this.pushThreatDelta(targetPly, piece, sq, board.mailbox[target], target, add, wKingSq, bKingSq);
    }

    const diagLo = board.pieceLo[4] | board.pieceLo[5] | board.pieceLo[8] | board.pieceLo[9];
    const diagHi = board.pieceHi[4] | board.pieceHi[5] | board.pieceHi[8] | board.pieceHi[9];
    const orthoLo = board.pieceLo[6] | board.pieceLo[7] | board.pieceLo[8] | board.pieceLo[9];
    const orthoHi = board.pieceHi[6] | board.pieceHi[7] | board.pieceHi[8] | board.pieceHi[9];

    computeRookAttacks(sq, occLo, occHi);
    const rookAtkLo = atkLoOut;
    const rookAtkHi = atkHiOut;
    computeBishopAttacks(sq, occLo, occHi);
    const bishAtkLo = atkLoOut;
    const bishAtkHi = atkHiOut;

    const qAtkLo = rookAtkLo | bishAtkLo;
    const qAtkHi = rookAtkHi | bishAtkHi;

    let sliderLo = ((bishAtkLo & diagLo) | (rookAtkLo & orthoLo)) & occLo;
    let sliderHi = ((bishAtkHi & diagHi) | (rookAtkHi & orthoHi)) & occHi;

    while (sliderLo !== 0) {
      const from = ctz32(sliderLo);
      sliderLo &= sliderLo - 1;
      const slidingPiece = board.mailbox[from];
      const rpIdx = from * 64 + sq;
      const thrLo = RAYPASS_LO[rpIdx] & occLo & qAtkLo;
      const thrHi = RAYPASS_HI[rpIdx] & occHi & qAtkHi;
      if (thrLo !== 0) {
        const to = ctz32(thrLo);
        this.pushThreatDelta(targetPly, slidingPiece, from, board.mailbox[to], to, !add, wKingSq, bKingSq);
      } else if (thrHi !== 0) {
        const to = 32 + ctz32(thrHi);
        this.pushThreatDelta(targetPly, slidingPiece, from, board.mailbox[to], to, !add, wKingSq, bKingSq);
      }
      this.pushThreatDelta(targetPly, slidingPiece, from, piece, sq, add, wKingSq, bKingSq);
    }
    while (sliderHi !== 0) {
      const from = 32 + ctz32(sliderHi);
      sliderHi &= sliderHi - 1;
      const slidingPiece = board.mailbox[from];
      const rpIdx = from * 64 + sq;
      const thrLo = RAYPASS_LO[rpIdx] & occLo & qAtkLo;
      const thrHi = RAYPASS_HI[rpIdx] & occHi & qAtkHi;
      if (thrLo !== 0) {
        const to = ctz32(thrLo);
        this.pushThreatDelta(targetPly, slidingPiece, from, board.mailbox[to], to, !add, wKingSq, bKingSq);
      } else if (thrHi !== 0) {
        const to = 32 + ctz32(thrHi);
        this.pushThreatDelta(targetPly, slidingPiece, from, board.mailbox[to], to, !add, wKingSq, bKingSq);
      }
      this.pushThreatDelta(targetPly, slidingPiece, from, piece, sq, add, wKingSq, bKingSq);
    }

    let nonSliderLo =
      ((board.pieceLo[1] & PAWN_ATK_LO[WHITE][sq]) |
        (board.pieceLo[0] & PAWN_ATK_LO[BLACK][sq]) |
        ((board.pieceLo[2] | board.pieceLo[3]) & KNIGHT_ATK_LO[sq]) |
        ((board.pieceLo[10] | board.pieceLo[11]) & KING_ATK_LO[sq])) &
      occLo;
    let nonSliderHi =
      ((board.pieceHi[1] & PAWN_ATK_HI[WHITE][sq]) |
        (board.pieceHi[0] & PAWN_ATK_HI[BLACK][sq]) |
        ((board.pieceHi[2] | board.pieceHi[3]) & KNIGHT_ATK_HI[sq]) |
        ((board.pieceHi[10] | board.pieceHi[11]) & KING_ATK_HI[sq])) &
      occHi;

    while (nonSliderLo !== 0) {
      const from = ctz32(nonSliderLo);
      nonSliderLo &= nonSliderLo - 1;
      this.pushThreatDelta(targetPly, board.mailbox[from], from, piece, sq, add, wKingSq, bKingSq);
    }
    while (nonSliderHi !== 0) {
      const from = 32 + ctz32(nonSliderHi);
      nonSliderHi &= nonSliderHi - 1;
      this.pushThreatDelta(targetPly, board.mailbox[from], from, piece, sq, add, wKingSq, bKingSq);
    }
  }

  public onMove(board: FastBoard, move: number, movedPiece: number, capturedPiece: number): void {
    this.ply++;
    if (this.ply >= ACC_STACK_SIZE) return;

    const p = this.ply;
    this.pstValid[p * 2] = 0;
    this.pstValid[p * 2 + 1] = 0;
    this.threatValid[p * 2] = 0;
    this.threatValid[p * 2 + 1] = 0;

    const from = move & 63;
    const to = (move >>> 6) & 63;
    const promo = (move >>> 12) & 7;
    const flags = (move >>> 15) & 15;
    const us = board.turn;
    const them = us ^ 1;
    const pt = movedPiece >> 1;

    const oldKingSq = board.kingSq[us];
    const newKingSq = pt === PT_KING ? to : oldKingSq;
    const enemyKingSq = board.kingSq[them];

    const pstOldFlipped = (oldKingSq & 7) >= 4;
    const pstNewFlipped = (newKingSq & 7) >= 4;
    const oldBucket = INPUT_BUCKETS_LAYOUT[oldKingSq ^ ((pstOldFlipped ? 7 : 0) ^ (56 * us))];
    const newBucket = INPUT_BUCKETS_LAYOUT[newKingSq ^ ((pstNewFlipped ? 7 : 0) ^ (56 * us))];
    const kingNeedsRefresh = pt === PT_KING && (pstOldFlipped !== pstNewFlipped || oldBucket !== newBucket);
    const resultingPt = promo > 0 ? promo : pt;

    for (let pov = 0; pov < 2; pov++) {
      const slot = p * 2 + pov;
      if (pov === us && kingNeedsRefresh) {
        this.pstRefresh[slot] = 1;
      } else {
        this.pstRefresh[slot] = 0;
        const povKingSq = pov === us ? newKingSq : enemyKingSq;
        this.pstAdd1[slot] = pstIndex(us, resultingPt, to, povKingSq, pov);
        this.pstSub1[slot] = pstIndex(us, pt, from, povKingSq, pov);
        if (flags === FLAG_KING_CASTLE || flags === FLAG_QUEEN_CASTLE) {
          const rFrom = flags === FLAG_KING_CASTLE ? (us === WHITE ? 7 : 63) : (us === WHITE ? 0 : 56);
          const rTo = flags === FLAG_KING_CASTLE ? (us === WHITE ? 5 : 61) : (us === WHITE ? 3 : 59);
          this.pstAdd2[slot] = pstIndex(us, PT_ROOK, rTo, povKingSq, pov);
          this.pstSub2[slot] = pstIndex(us, PT_ROOK, rFrom, povKingSq, pov);
        } else if (flags === FLAG_EP) {
          const epSq = us === WHITE ? to - 8 : to + 8;
          this.pstAdd2[slot] = -1;
          this.pstSub2[slot] = pstIndex(them, PT_PAWN, epSq, povKingSq, pov);
        } else if (capturedPiece !== EMPTY) {
          this.pstAdd2[slot] = -1;
          this.pstSub2[slot] = pstIndex(them, capturedPiece >> 1, to, povKingSq, pov);
        } else {
          this.pstAdd2[slot] = -1;
          this.pstSub2[slot] = -1;
        }
      }
    }

    // Store threat delta indices (skipping special moves where refresh is simpler)
    const wKing = us === WHITE ? newKingSq : enemyKingSq;
    const bKing = us === BLACK ? newKingSq : enemyKingSq;

    this.threatAddCnt[p * 2] = 0;
    this.threatSubCnt[p * 2] = 0;
    this.threatAddCnt[p * 2 + 1] = 0;
    this.threatSubCnt[p * 2 + 1] = 0;

    if (flags === FLAG_KING_CASTLE || flags === FLAG_QUEEN_CASTLE || flags === FLAG_EP || promo > 0) {
      this.threatRefresh[p * 2] = 1;
      this.threatRefresh[p * 2 + 1] = 1;
      return;
    }

    this.threatRefresh[p * 2] = 0;
    this.threatRefresh[p * 2 + 1] = 0;
    if (pt === PT_KING && pstOldFlipped !== pstNewFlipped) {
      this.threatRefresh[p * 2 + us] = 1;
    }

    if (capturedPiece !== EMPTY) {
      this.pushThreatsSingle(p, board, board.occLo, board.occHi, capturedPiece, to, false, wKing, bKing);
    }

    let occNoFromNoToLo = board.occLo;
    let occNoFromNoToHi = board.occHi;
    if (from < 32) occNoFromNoToLo &= ~(1 << from);
    else occNoFromNoToHi &= ~(1 << (from - 32));
    if (to < 32) occNoFromNoToLo &= ~(1 << to);
    else occNoFromNoToHi &= ~(1 << (to - 32));

    this.pushThreatsSingle(p, board, occNoFromNoToLo, occNoFromNoToHi, movedPiece, from, false, wKing, bKing);
    this.pushThreatsSingle(p, board, occNoFromNoToLo, occNoFromNoToHi, movedPiece, to, true, wKing, bKing);
  }

  public onUnmove(): void {
    if (this.ply > 0) this.ply--;
  }

  public onNullMove(): void {
    this.ply++;
    if (this.ply >= ACC_STACK_SIZE) return;
    const p = this.ply;
    for (let pov = 0; pov < 2; pov++) {
      const slot = p * 2 + pov;
      this.pstValid[slot] = 0;
      this.pstRefresh[slot] = 0;
      this.pstAdd1[slot] = -1;
      this.pstAdd2[slot] = -1;
      this.pstSub1[slot] = -1;
      this.pstSub2[slot] = -1;
      this.threatValid[slot] = 0;
      this.threatRefresh[slot] = 0;
      this.threatAddCnt[slot] = 0;
      this.threatSubCnt[slot] = 0;
    }
  }

  public onUnnullMove(): void {
    if (this.ply > 0) this.ply--;
  }

  private ensurePst(board: FastBoard, pov: number): void {
    const targetPly = this.ply;
    if (this.pstValid[targetPly * 2 + pov]) return;

    let anc = targetPly;
    while (anc > 0 && !this.pstValid[anc * 2 + pov] && !this.pstRefresh[anc * 2 + pov]) {
      anc--;
    }

    if (!this.pstValid[anc * 2 + pov] || targetPly - anc > 4) {
      this.refreshPstPov(board, pov, targetPly);
      return;
    }

    const ftPiece = this.params.ftPieceWeights;
    const pst = this.pstValues;

    for (let p = anc + 1; p <= targetPly; p++) {
      const slot = p * 2 + pov;
      const prevOff = ((p - 1) * 2 + pov) * L1_SIZE;
      const curOff = slot * L1_SIZE;

      const a1 = this.pstAdd1[slot];
      const s1 = this.pstSub1[slot];
      if (a1 < 0) {
        pst.copyWithin(curOff, prevOff, prevOff + L1_SIZE);
      } else {
        const a2 = this.pstAdd2[slot];
        const s2 = this.pstSub2[slot];
        const a1Off = a1 * L1_SIZE;
        const s1Off = s1 * L1_SIZE;
        if (a2 >= 0) {
          const a2Off = a2 * L1_SIZE;
          const s2Off = s2 * L1_SIZE;
          for (let i = 0; i < L1_SIZE; i++) {
            pst[curOff + i] = pst[prevOff + i] + ftPiece[a1Off + i] + ftPiece[a2Off + i] - ftPiece[s1Off + i] - ftPiece[s2Off + i];
          }
        } else if (s2 >= 0) {
          const s2Off = s2 * L1_SIZE;
          for (let i = 0; i < L1_SIZE; i++) {
            pst[curOff + i] = pst[prevOff + i] + ftPiece[a1Off + i] - ftPiece[s1Off + i] - ftPiece[s2Off + i];
          }
        } else {
          for (let i = 0; i < L1_SIZE; i++) {
            pst[curOff + i] = pst[prevOff + i] + ftPiece[a1Off + i] - ftPiece[s1Off + i];
          }
        }
      }
      this.pstValid[slot] = 1;
    }
  }

  private ensureThreats(board: FastBoard, pov: number): void {
    const targetPly = this.ply;
    if (this.threatValid[targetPly * 2 + pov]) return;

    let anc = targetPly;
    while (anc > 0 && !this.threatValid[anc * 2 + pov] && !this.threatRefresh[anc * 2 + pov]) {
      anc--;
    }

    if (!this.threatValid[anc * 2 + pov] || targetPly - anc > 3) {
      this.refreshThreatsPov(board, pov, targetPly);
      return;
    }

    const ftThreat = this.params.ftThreatWeights;
    const thr = this.threatValues;

    for (let p = anc + 1; p <= targetPly; p++) {
      const slot = p * 2 + pov;
      const prevOff = ((p - 1) * 2 + pov) * L1_SIZE;
      const curOff = slot * L1_SIZE;
      thr.copyWithin(curOff, prevOff, prevOff + L1_SIZE);

      const addCnt = this.threatAddCnt[slot];
      const subCnt = this.threatSubCnt[slot];
      const base = slot * MAX_DELTAS_PER_PLY;

      let a = 0;
      let s = 0;
      while (a < addCnt && s < subCnt) {
        const aOff = this.threatAddIdx[base + a] * L1_SIZE;
        const sOff = this.threatSubIdx[base + s] * L1_SIZE;
        for (let i = 0; i < L1_SIZE; i++) {
          thr[curOff + i] += ftThreat[aOff + i] - ftThreat[sOff + i];
        }
        a++;
        s++;
      }
      while (a < addCnt) {
        const aOff = this.threatAddIdx[base + a] * L1_SIZE;
        for (let i = 0; i < L1_SIZE; i++) {
          thr[curOff + i] += ftThreat[aOff + i];
        }
        a++;
      }
      while (s < subCnt) {
        const sOff = this.threatSubIdx[base + s] * L1_SIZE;
        for (let i = 0; i < L1_SIZE; i++) {
          thr[curOff + i] -= ftThreat[sOff + i];
        }
        s++;
      }
      this.threatValid[slot] = 1;
    }
  }

  public evaluate(board: FastBoard): number {
    this.ensurePst(board, WHITE);
    this.ensurePst(board, BLACK);
    this.ensureThreats(board, WHITE);
    this.ensureThreats(board, BLACK);
    return this.forwardPass(board);
  }

  public evaluateFullRefresh(board: FastBoard): number {
    this.refreshPstPov(board, WHITE, this.ply);
    this.refreshPstPov(board, BLACK, this.ply);
    this.refreshThreatsPov(board, WHITE, this.ply);
    this.refreshThreatsPov(board, BLACK, this.ply);
    return this.forwardPass(board);
  }

  private forwardPass(board: FastBoard): number {
    const stm = board.turn;
    const pst = this.pstValues;
    const thr = this.threatValues;
    const ftOut = this.ftOut;

    const stmOff = (this.ply * 2 + stm) * L1_SIZE;
    const oppOff = (this.ply * 2 + (stm ^ 1)) * L1_SIZE;
    const half = L1_SIZE >> 1; // 384

    for (let i = 0; i < half; i++) {
      let l = pst[stmOff + i] + thr[stmOff + i];
      if (l < 0) l = 0;
      else if (l > FT_QUANT) l = FT_QUANT;
      let r = pst[stmOff + i + half] + thr[stmOff + i + half];
      if (r < 0) r = 0;
      else if (r > FT_QUANT) r = FT_QUANT;
      ftOut[i] = (l * r) >> FT_SHIFT;
    }

    for (let i = 0; i < half; i++) {
      let l = pst[oppOff + i] + thr[oppOff + i];
      if (l < 0) l = 0;
      else if (l > FT_QUANT) l = FT_QUANT;
      let r = pst[oppOff + i + half] + thr[oppOff + i + half];
      if (r < 0) r = 0;
      else if (r > FT_QUANT) r = FT_QUANT;
      ftOut[half + i] = (l * r) >> FT_SHIFT;
    }

    const bucket = OUTPUT_BUCKETS_LAYOUT[board.pieceCount()];
    const { l1Weights, l1Biases, l2Weights, l2Biases, l3Weights, l3Biases } = this.params;

    const l1Pre = this.l1Pre;
    l1Pre.fill(0);
    const l1BucketBase = bucket * L2_SIZE * L1_SIZE;

    for (let idx = 0; idx < 192; idx++) {
      const f0 = ftOut[idx * 4];
      const f1 = ftOut[idx * 4 + 1];
      const f2 = ftOut[idx * 4 + 2];
      const f3 = ftOut[idx * 4 + 3];
      if ((f0 | f1 | f2 | f3) === 0) continue;

      const wBase = l1BucketBase + idx * (L2_SIZE * 4);
      for (let j = 0; j < L2_SIZE; j++) {
        const jOff = wBase + j * 4;
        l1Pre[j] +=
          f0 * l1Weights[jOff] +
          f1 * l1Weights[jOff + 1] +
          f2 * l1Weights[jOff + 2] +
          f3 * l1Weights[jOff + 3];
      }
    }

    const l1Out = this.l1Out;
    const l1BiasBase = bucket * L2_SIZE;
    for (let i = 0; i < L2_SIZE; i++) {
      let v = l1Pre[i] * DEQUANT_MULTIPLIER + l1Biases[l1BiasBase + i];
      if (v < 0) v = 0;
      else if (v > 1) v = 1;
      l1Out[i] = v;
    }

    const l2Out = this.l2Out;
    const l2BiasBase = bucket * L3_SIZE;
    for (let j = 0; j < L3_SIZE; j++) {
      l2Out[j] = l2Biases[l2BiasBase + j];
    }
    const l2WBase = bucket * L2_SIZE * L3_SIZE;
    for (let i = 0; i < L2_SIZE; i++) {
      const a = l1Out[i];
      const rowBase = l2WBase + i * L3_SIZE;
      for (let j = 0; j < L3_SIZE; j++) {
        l2Out[j] += l2Weights[rowBase + j] * a;
      }
    }
    for (let j = 0; j < L3_SIZE; j++) {
      const v = l2Out[j];
      if (v < 0) l2Out[j] = 0;
      else if (v > 1) l2Out[j] = 1;
    }

    const l3WBase = bucket * L3_SIZE;
    let sum = l3Biases[bucket];
    for (let i = 0; i < L3_SIZE; i++) {
      sum += l3Weights[l3WBase + i] * l2Out[i];
    }

    return Math.trunc(sum * NETWORK_SCALE);
  }
}

/**
 * Exact Reckless WDL-to-centipawn normalization (src/types/score.rs):
 * Maps internal NNUE scores to calibrated centipawns where +100 cp ≈ 50% win expectancy vs draw.
 */
export function normalizeRecklessToCp(score: number, board: FastBoard): number {
  if (Math.abs(score) > 20000) return score;
  const pawns = popcount32(board.pieceLo[0] | board.pieceLo[1]) + popcount32(board.pieceHi[0] | board.pieceHi[1]);
  const knights = popcount32(board.pieceLo[2] | board.pieceLo[3]) + popcount32(board.pieceHi[2] | board.pieceHi[3]);
  const bishops = popcount32(board.pieceLo[4] | board.pieceLo[5]) + popcount32(board.pieceHi[4] | board.pieceHi[5]);
  const rooks = popcount32(board.pieceLo[6] | board.pieceLo[7]) + popcount32(board.pieceHi[6] | board.pieceHi[7]);
  const queens = popcount32(board.pieceLo[8] | board.pieceLo[9]) + popcount32(board.pieceHi[8] | board.pieceHi[9]);

  const material = pawns + 3 * knights + 3 * bishops + 5 * rooks + 9 * queens;
  const clamped = Math.max(16, Math.min(78, material));
  const v = clamped / 58.0;
  const normalization = -285.1 * v * v * v + 642.5 * v * v - 455.5 * v + 464.8;
  return Math.round((100.0 * score) / normalization);
}

/**
 * Convenience FEN evaluator using loaded Reckless NNUE weights.
 * Returns normalized side-to-move centipawn score (or null if weights are not loaded).
 */
export function evaluateRecklessNnueFen(fen: string, normalizeCp = true): number | null {
  const params = loadedParams ?? tryLoadRecklessNnueNodeSync();
  if (!params) return null;
  const board = new FastBoard(fen);
  const evaluator = new RecklessEvaluator(params);
  evaluator.onReset(board);
  const raw = evaluator.evaluate(board);
  return normalizeCp ? normalizeRecklessToCp(raw, board) : raw;
}
