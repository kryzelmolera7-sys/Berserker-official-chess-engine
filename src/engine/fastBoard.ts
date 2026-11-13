/**
 * Zero-Allocation Fast Board Representation, Legal Move Generator,
 * Exact X-Ray Static Exchange Evaluation (SEE), Zobrist Hashing,
 * and Tapered PeSTO + Structural Positional Evaluator.
 */

// Piece encodings
export const EMPTY = 0;
export const WP = 1;
export const WN = 2;
export const WB = 3;
export const WR = 4;
export const WQ = 5;
export const WK = 6;
export const BP = 7;
export const BN = 8;
export const BB = 9;
export const BR = 10;
export const BQ = 11;
export const BK = 12;

export const WHITE = 0;
export const BLACK = 1;

export const PT_NONE = 0;
export const PT_PAWN = 1;
export const PT_KNIGHT = 2;
export const PT_BISHOP = 3;
export const PT_ROOK = 4;
export const PT_QUEEN = 5;
export const PT_KING = 6;

export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;

// Packed move bit layout (fits cleanly in 31-bit signed positive JS SMI):
// bits 0..5:   from (0..63)
// bits 6..11:  to (0..63)
// bits 12..14: promo piece type (0=none, 2=N, 3=B, 4=R, 5=Q)
// bit 15:      isCapture
// bit 16:      isEp
// bit 17:      isCastle
// bit 18:      isDoublePush
// bits 19..22: movedPiece (1..12)
// bits 23..26: capturedPiece (0..12)
export const MV_FLAG_CAPTURE = 1 << 15;
export const MV_FLAG_EP = 1 << 16;
export const MV_FLAG_CASTLE = 1 << 17;
export const MV_FLAG_DPUSH = 1 << 18;

export const MAX_PLY = 128;

export function packMove(
  from: number,
  to: number,
  promo: number,
  flags: number,
  movedPiece: number,
  capturedPiece: number
): number {
  return (
    from |
    (to << 6) |
    (promo << 12) |
    flags |
    (movedPiece << 19) |
    (capturedPiece << 23)
  );
}

export function moveFrom(m: number): number {
  return m & 63;
}
export function moveTo(m: number): number {
  return (m >> 6) & 63;
}
export function movePromo(m: number): number {
  return (m >> 12) & 7;
}
export function moveIsCapture(m: number): boolean {
  return (m & MV_FLAG_CAPTURE) !== 0;
}
export function moveIsEp(m: number): boolean {
  return (m & MV_FLAG_EP) !== 0;
}
export function moveIsCastle(m: number): boolean {
  return (m & MV_FLAG_CASTLE) !== 0;
}
export function moveIsDoublePush(m: number): boolean {
  return (m & MV_FLAG_DPUSH) !== 0;
}
export function movePiece(m: number): number {
  return (m >> 19) & 15;
}
export function moveCaptured(m: number): number {
  return (m >> 23) & 15;
}

export function sqToCoord(sq: number): string {
  return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 3));
}

export function moveToUci(m: number): string {
  const from = m & 63;
  const to = (m >> 6) & 63;
  const promo = (m >> 12) & 7;
  const base = sqToCoord(from) + sqToCoord(to);
  if (promo === 0) return base;
  return base + (promo === PT_QUEEN ? 'q' : promo === PT_ROOK ? 'r' : promo === PT_BISHOP ? 'b' : 'n');
}

export function pieceTypeOf(p: number): number {
  return p === 0 ? 0 : p <= 6 ? p : p - 6;
}

export function pieceColorOf(p: number): number {
  return p <= 6 ? WHITE : BLACK;
}

// ============================================================================
// Precomputed Attack & Ray Tables
// ============================================================================
const KNIGHT_MOVES: Uint8Array[] = new Array(64);
const KING_MOVES: Uint8Array[] = new Array(64);
// PAWN_CAP_BY[color][sq] = squares where a pawn of `color` MUST stand to attack `sq`
// Wait: PAWN_ATTACKS_FROM[color][sq] = squares a pawn of `color` on `sq` attacks!
// Note: A pawn of `color` attacks `sq` iff a pawn of `color ^ 1` on `sq` attacks that pawn's square!
const PAWN_ATTACKS_FROM: Uint8Array[][] = [new Array(64), new Array(64)];
// 8 Rays: 0=NE, 1=NW, 2=SE, 3=SW (Diagonals), 4=N, 5=S, 6=E, 7=W (Orthogonals)
const RAY_SQUARES: Uint8Array[][] = Array.from({ length: 8 }, () => new Array(64));

const RAY_DF = [1, -1, 1, -1, 0, 0, 1, -1];
const RAY_DR = [1, 1, -1, -1, 1, -1, 0, 0];

(function initAttackTables() {
  const knightD = [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1],
  ];
  const kingD = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1],
  ];

  for (let sq = 0; sq < 64; sq++) {
    const f = sq & 7;
    const r = sq >> 3;

    const kn: number[] = [];
    for (const [dr, df] of knightD) {
      const nr = r + dr;
      const nf = f + df;
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) kn.push(nr * 8 + nf);
    }
    KNIGHT_MOVES[sq] = new Uint8Array(kn);

    const kg: number[] = [];
    for (const [dr, df] of kingD) {
      const nr = r + dr;
      const nf = f + df;
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) kg.push(nr * 8 + nf);
    }
    KING_MOVES[sq] = new Uint8Array(kg);

    const wpCaps: number[] = [];
    if (r + 1 < 8) {
      if (f - 1 >= 0) wpCaps.push((r + 1) * 8 + (f - 1));
      if (f + 1 < 8) wpCaps.push((r + 1) * 8 + (f + 1));
    }
    PAWN_ATTACKS_FROM[WHITE][sq] = new Uint8Array(wpCaps);

    const bpCaps: number[] = [];
    if (r - 1 >= 0) {
      if (f - 1 >= 0) bpCaps.push((r - 1) * 8 + (f - 1));
      if (f + 1 < 8) bpCaps.push((r - 1) * 8 + (f + 1));
    }
    PAWN_ATTACKS_FROM[BLACK][sq] = new Uint8Array(bpCaps);

    for (let d = 0; d < 8; d++) {
      const df = RAY_DF[d];
      const dr = RAY_DR[d];
      const ray: number[] = [];
      let cf = f + df;
      let cr = r + dr;
      while (cf >= 0 && cf < 8 && cr >= 0 && cr < 8) {
        ray.push(cr * 8 + cf);
        cf += df;
        cr += dr;
      }
      RAY_SQUARES[d][sq] = new Uint8Array(ray);
    }
  }
})();

// ============================================================================
// Zobrist Hashing Keys (Two 32-bit halves for 64-bit collision resistance)
// ============================================================================
const ZOB_PIECE_LO = new Uint32Array(13 * 64);
const ZOB_PIECE_HI = new Uint32Array(13 * 64);
const ZOB_CASTLE_LO = new Uint32Array(16);
const ZOB_CASTLE_HI = new Uint32Array(16);
const ZOB_EP_LO = new Uint32Array(8);
const ZOB_EP_HI = new Uint32Array(8);
let ZOB_STM_LO = 0;
let ZOB_STM_HI = 0;

// Secondary lightweight keys for CorrHist
const PAWN_ZOB = new Uint32Array(13 * 64);
const NONPAWN_ZOB = new Uint32Array(13 * 64);

(function initZobrist() {
  let s1 = 0x9e3779b9 >>> 0;
  let s2 = 0x85ebca6b >>> 0;
  function nextU32(): number {
    s1 = (s1 + 0x6d2b79f5) >>> 0;
    let z = Math.imul(s1 ^ (s1 >>> 15), 1 | s1) >>> 0;
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) >>> 0;
    s2 = (s2 ^ (s2 << 13)) >>> 0;
    s2 = (s2 ^ (s2 >>> 17)) >>> 0;
    s2 = (s2 ^ (s2 << 5)) >>> 0;
    return (z ^ (z >>> 14) ^ s2) >>> 0;
  }

  for (let p = 1; p <= 12; p++) {
    for (let sq = 0; sq < 64; sq++) {
      const idx = p * 64 + sq;
      ZOB_PIECE_LO[idx] = nextU32();
      ZOB_PIECE_HI[idx] = nextU32();
      if (p === WP || p === BP) {
        PAWN_ZOB[idx] = ZOB_PIECE_LO[idx] ^ ZOB_PIECE_HI[idx];
      } else {
        NONPAWN_ZOB[idx] = ZOB_PIECE_LO[idx] ^ ZOB_PIECE_HI[idx];
      }
    }
  }
  for (let c = 0; c < 16; c++) {
    ZOB_CASTLE_LO[c] = nextU32();
    ZOB_CASTLE_HI[c] = nextU32();
  }
  for (let f = 0; f < 8; f++) {
    ZOB_EP_LO[f] = nextU32();
    ZOB_EP_HI[f] = nextU32();
  }
  ZOB_STM_LO = nextU32();
  ZOB_STM_HI = nextU32();
})();

// ============================================================================
// PeSTO Tapered Evaluation Tables (from Berserker Rust NNUE calibration)
// ============================================================================
const MG_VAL = [0, 82, 337, 365, 477, 1025, 0];
const EG_VAL = [0, 94, 281, 297, 512, 936, 0];
export const SEE_VAL = [0, 100, 320, 330, 500, 950, 20000];
const PHASE_INC = [0, 0, 1, 1, 2, 4, 0];

const PAWN_MG = new Int16Array([
    0,   0,   0,   0,   0,   0,   0,   0,
   98, 134,  61,  95,  68, 126,  34, -11,
   -6,   7,  26,  31,  65,  56,  25, -20,
  -14,  13,   6,  21,  23,  12,  17, -23,
  -27,  -2,  -5,  12,  17,   6,  10, -25,
  -26,  -4,  -4, -10,   3,   3,  33, -12,
  -35,  -1, -20, -23, -15,  24,  38, -22,
    0,   0,   0,   0,   0,   0,   0,   0,
]);

const PAWN_EG = new Int16Array([
    0,   0,   0,   0,   0,   0,   0,   0,
  178, 173, 158, 134, 147, 132, 165, 187,
   94, 100,  85,  67,  56,  53,  82,  84,
   32,  24,  13,   5,  -2,   4,  17,  17,
   13,   9,  -3,  -7,  -7,  -8,   3,  -1,
    4,   7,  -6,   1,   0,  -5,  -1,  -8,
   13,   8,   8,  10,  13,   0,   2,  -7,
    0,   0,   0,   0,   0,   0,   0,   0,
]);

const KNIGHT_MG = new Int16Array([
  -167, -89, -34, -49,  61, -97, -15, -107,
   -73, -41,  72,  36,  23,  62,   7,  -17,
   -47,  60,  37,  65,  84, 129,  73,   44,
    -9,  17,  19,  53,  37,  69,  18,   22,
   -13,   4,  16,  13,  28,  19,  21,   -8,
   -23,  -9,  12,  10,  19,  17,  25,  -16,
   -29, -53, -12,  -3,  -1,  18, -14,  -19,
  -105, -21, -58, -33, -17, -28, -19,  -23,
]);

const KNIGHT_EG = new Int16Array([
  -58, -38, -13, -28, -31, -27, -63, -99,
  -25,  -8, -25,  -2,  -9, -25, -24, -52,
  -24, -20,  10,   9,  -1,  -9, -19, -41,
  -17,   3,  22,  22,  22,  11,   8, -18,
  -18,  -6,  16,  25,  16,  17,   4, -18,
  -23,  -3,  -1,  15,  10,  -3, -20, -22,
  -42, -20, -10,  -5,  -2, -20, -23, -44,
  -29, -51, -23, -15, -22, -18, -50, -64,
]);

const BISHOP_MG = new Int16Array([
  -29,   4, -82, -37, -25, -42,   7,  -8,
  -26,  16, -18, -13,  30,  59,  18, -47,
  -16,  37,  43,  40,  35,  50,  37,  -2,
   -4,   5,  19,  50,  37,  37,   7,  -2,
   -6,  13,  13,  26,  34,  12,  10,   4,
    0,  15,  15,  15,  14,  27,  18,  10,
    4,  15,  16,   0,   7,  21,  33,   1,
  -33,  -3, -14, -21, -13, -12, -39, -21,
]);

const BISHOP_EG = new Int16Array([
  -14, -21, -11,  -8,  -7,  -9, -17, -24,
   -8,  -4,   7, -12,  -3, -13,  -4, -14,
    2,  -8,   0,  -1,  -2,   6,   0,   4,
   -3,   9,  12,   9,  14,  10,   3,   2,
   -6,   3,  13,  19,   7,  10,  -3,  -9,
  -12,  -3,   8,  10,  13,   3,  -7, -15,
  -14, -18,  -7,  -1,   4,  -9, -15, -27,
  -23,  -9, -23,  -5,  -9, -16,  -5, -17,
]);

const ROOK_MG = new Int16Array([
   32,  42,  32,  51,  63,   9,  31,  43,
   27,  32,  58,  62,  80,  67,  26,  44,
   -5,  19,  26,  36,  17,  45,  61,  16,
  -24, -11,   7,  26,  24,  35,  -8, -20,
  -36, -26, -12,  -1,   9,  -7,   6, -23,
  -45, -25, -16, -17,   3,   0,  -5, -33,
  -44, -16, -20,  -9,  -1,  11,  -6, -71,
  -19, -13,   1,  17,  16,   7, -37, -26,
]);

const ROOK_EG = new Int16Array([
   13,  10,  18,  15,  12,  12,   8,   5,
   11,  13,  13,  11,  -3,   3,   8,   3,
    7,   7,   7,   5,   4,  -3,  -5,  -3,
    4,   3,  13,   1,   2,   1,  -1,   2,
    3,   5,   8,   4,  -5,  -6,  -8, -11,
   -4,   0,  -5,  -1,  -7, -12,  -8, -16,
   -6,  -6,   0,   2,  -9,  -9, -11,  -3,
   -9,   2,   3,  -1,  -5, -13,   4, -20,
]);

const QUEEN_MG = new Int16Array([
  -28,   0,  29,  12,  59,  44,  43,  45,
  -24, -39,  -5,   1, -16,  57,  28,  54,
  -13, -17,   7,   8,  29,  56,  47,  57,
  -27, -27, -16, -16,  -1,  17,  -2,   1,
   -9, -26,  -9, -10,  -2,  -4,   3,  -3,
  -14,   2, -11,  -2,  -5,   2,  14,   5,
  -35,  -8,  11,   2,   8,  15,  -3,   1,
   -1, -18,  -9,  10, -15, -25, -31, -50,
]);

const QUEEN_EG = new Int16Array([
   -9,  22,  22,  27,  27,  19,  10,  20,
  -17,  20,  32,  41,  58,  25,  30,   0,
  -20,   6,   9,  49,  47,  35,  19,   9,
    3,  22,  24,  45,  57,  40,  57,  36,
  -18,  28,  19,  47,  31,  34,  39,  23,
  -16, -27,  15,   6,   9,  17,  10,   5,
  -22, -23, -30, -16, -16, -23, -36, -32,
  -33, -28, -22, -43,  -5, -32, -20, -41,
]);

const KING_MG = new Int16Array([
  -65,  23,  16, -15, -56, -34,   2,  13,
   29,  -1, -20,  -7,  -8,  -4, -38, -29,
   -9,  24,   2, -16, -20,   6,  22, -22,
  -17, -20, -12, -27, -30, -25, -14, -36,
  -49,  -1, -27, -39, -46, -44, -33, -51,
  -14, -14, -22, -46, -44, -30, -15, -27,
    1,   7,  -8, -64, -43, -16,   9,   8,
  -15,  36,  12, -54,   8, -28,  24,  14,
]);

const KING_EG = new Int16Array([
  -74, -35, -18, -18, -11,  15,   4, -17,
  -12,  17,  14,  17,  17,  38,  23,  11,
   10,  17,  23,  15,  20,  45,  44,  13,
   -8,  22,  24,  27,  26,  33,  26,   3,
  -18,  -4,  21,  24,  27,  23,   9, -11,
  -19,  -3,  11,  21,  23,  16,   7,  -9,
  -27, -11,   4,  13,  14,   4,  -5, -17,
  -53, -34, -21, -11, -28, -14, -24, -43,
]);

const PST_MG = [null, PAWN_MG, KNIGHT_MG, BISHOP_MG, ROOK_MG, QUEEN_MG, KING_MG];
const PST_EG = [null, PAWN_EG, KNIGHT_EG, BISHOP_EG, ROOK_EG, QUEEN_EG, KING_EG];

const PASSED_BONUS_MG = [0, 5, 10, 18, 32, 60, 105, 0];
const PASSED_BONUS_EG = [0, 10, 18, 32, 60, 110, 185, 0];

// Scratch buffers for fast eval (no allocations per call)
const wPawnCountByFile = new Int8Array(8);
const bPawnCountByFile = new Int8Array(8);
const wPawnRanks = new Int8Array(8); // bitmask of ranks (0..7) on each file
const bPawnRanks = new Int8Array(8);
const wMinPawnRank = new Int8Array(8);
const wMaxPawnRank = new Int8Array(8);
const bMinPawnRank = new Int8Array(8);
const bMaxPawnRank = new Int8Array(8);
const pieceListSq = new Int8Array(64);
const pieceListVal = new Int8Array(64);
const wKingZoneMask = new Uint8Array(64);
const bKingZoneMask = new Uint8Array(64);

// ============================================================================
// FastBoard Class
// ============================================================================
export class FastBoard {
  public readonly squares = new Int8Array(64);
  public stm = WHITE;
  public castling = 0;
  public epSq = -1;
  public halfmove = 0;
  public fullmove = 1;
  public kingSq = new Int8Array(2);

  // Chess960 / dynamic castling coordinates
  public kingStartFile = new Int8Array([4, 4]);
  public qRookStartFile = new Int8Array([0, 0]);
  public kRookStartFile = new Int8Array([7, 7]);
  public readonly castleMask = new Uint8Array(64);

  // Incremental Zobrist hashes
  public hashLo = 0;
  public hashHi = 0;
  public pawnHash = 0;
  public nonPawnHash = new Uint32Array(2);

  // Incremental material/phase/counts
  public nonPawnMat = new Int32Array(2);
  public pieceCounts = new Int8Array(13);

  // Repetition history stack
  public readonly repHashLo = new Uint32Array(512);
  public readonly repHashHi = new Uint32Array(512);
  public repCount = 0;

  // Undo stack (indexed by ply)
  public ply = 0;
  private readonly uEp = new Int8Array(MAX_PLY);
  private readonly uCastle = new Uint8Array(MAX_PLY);
  private readonly uHalf = new Uint16Array(MAX_PLY);
  private readonly uCaptured = new Int8Array(MAX_PLY);
  private readonly uCapSq = new Int8Array(MAX_PLY);
  private readonly uHashLo = new Uint32Array(MAX_PLY);
  private readonly uHashHi = new Uint32Array(MAX_PLY);
  private readonly uPawnHash = new Uint32Array(MAX_PLY);
  private readonly uNpHashW = new Uint32Array(MAX_PLY);
  private readonly uNpHashB = new Uint32Array(MAX_PLY);
  private readonly uRookFrom = new Int8Array(MAX_PLY);
  private readonly uRookTo = new Int8Array(MAX_PLY);

  public static fromFen(fen: string): FastBoard {
    const b = new FastBoard();
    b.loadFen(fen);
    return b;
  }

  public loadFen(fen: string): void {
    this.squares.fill(EMPTY);
    this.pieceCounts.fill(0);
    this.nonPawnMat.fill(0);
    this.kingSq[WHITE] = 4;
    this.kingSq[BLACK] = 60;
    this.ply = 0;
    this.repCount = 0;
    this.hashLo = 0;
    this.hashHi = 0;
    this.pawnHash = 0;
    this.nonPawnHash[0] = 0;
    this.nonPawnHash[1] = 0;

    const parts = fen.trim().split(/\s+/);
    const rows = parts[0].split('/');

    for (let fenRow = 0; fenRow < 8; fenRow++) {
      const rank = 7 - fenRow;
      let file = 0;
      const rowStr = rows[fenRow] || '';
      for (let i = 0; i < rowStr.length; i++) {
        const ch = rowStr[i];
        const code = ch.charCodeAt(0);
        if (code >= 49 && code <= 56) {
          file += code - 48;
        } else {
          const sq = rank * 8 + file;
          let p = EMPTY;
          switch (ch) {
            case 'P': p = WP; break;
            case 'N': p = WN; break;
            case 'B': p = WB; break;
            case 'R': p = WR; break;
            case 'Q': p = WQ; break;
            case 'K': p = WK; this.kingSq[WHITE] = sq; break;
            case 'p': p = BP; break;
            case 'n': p = BN; break;
            case 'b': p = BB; break;
            case 'r': p = BR; break;
            case 'q': p = BQ; break;
            case 'k': p = BK; this.kingSq[BLACK] = sq; break;
          }
          if (p !== EMPTY) {
            this.putPiece(sq, p);
          }
          file++;
        }
      }
    }

    this.stm = parts[1] === 'b' ? BLACK : WHITE;
    if (this.stm === BLACK) {
      this.hashLo = (this.hashLo ^ ZOB_STM_LO) >>> 0;
      this.hashHi = (this.hashHi ^ ZOB_STM_HI) >>> 0;
    }

    // Castling (supports standard KQkq AND Shredder A-Ha-h AND Chess960 with non-standard rook files)
    const wkFile = this.kingSq[WHITE] & 7;
    const bkFile = this.kingSq[BLACK] & 7;
    this.kingStartFile[WHITE] = wkFile;
    this.kingStartFile[BLACK] = bkFile;
    this.qRookStartFile[WHITE] = 0;
    this.kRookStartFile[WHITE] = 7;
    this.qRookStartFile[BLACK] = 0;
    this.kRookStartFile[BLACK] = 7;

    this.castling = 0;
    const cStr = parts[2] || '-';
    if (cStr !== '-') {
      for (let i = 0; i < cStr.length; i++) {
        const ch = cStr[i];
        if (ch === 'K') {
          this.castling |= CASTLE_WK;
          for (let f = 7; f > wkFile; f--) {
            if (this.squares[f] === WR) { this.kRookStartFile[WHITE] = f; break; }
          }
        } else if (ch === 'Q') {
          this.castling |= CASTLE_WQ;
          for (let f = 0; f < wkFile; f++) {
            if (this.squares[f] === WR) { this.qRookStartFile[WHITE] = f; break; }
          }
        } else if (ch === 'k') {
          this.castling |= CASTLE_BK;
          for (let f = 7; f > bkFile; f--) {
            if (this.squares[56 + f] === BR) { this.kRookStartFile[BLACK] = f; break; }
          }
        } else if (ch === 'q') {
          this.castling |= CASTLE_BQ;
          for (let f = 0; f < bkFile; f++) {
            if (this.squares[56 + f] === BR) { this.qRookStartFile[BLACK] = f; break; }
          }
        } else if (ch >= 'A' && ch <= 'H') {
          const rf = ch.charCodeAt(0) - 65;
          if (rf > wkFile) {
            this.castling |= CASTLE_WK;
            this.kRookStartFile[WHITE] = rf;
          } else {
            this.castling |= CASTLE_WQ;
            this.qRookStartFile[WHITE] = rf;
          }
        } else if (ch >= 'a' && ch <= 'h') {
          const rf = ch.charCodeAt(0) - 97;
          if (rf > bkFile) {
            this.castling |= CASTLE_BK;
            this.kRookStartFile[BLACK] = rf;
          } else {
            this.castling |= CASTLE_BQ;
            this.qRookStartFile[BLACK] = rf;
          }
        }
      }
    }

    // Build castleMask[64]
    this.castleMask.fill(15);
    this.castleMask[this.kingSq[WHITE]] &= ~(CASTLE_WK | CASTLE_WQ);
    this.castleMask[this.qRookStartFile[WHITE]] &= ~CASTLE_WQ;
    this.castleMask[this.kRookStartFile[WHITE]] &= ~CASTLE_WK;
    this.castleMask[this.kingSq[BLACK]] &= ~(CASTLE_BK | CASTLE_BQ);
    this.castleMask[56 + this.qRookStartFile[BLACK]] &= ~CASTLE_BQ;
    this.castleMask[56 + this.kRookStartFile[BLACK]] &= ~CASTLE_BK;

    this.hashLo = (this.hashLo ^ ZOB_CASTLE_LO[this.castling]) >>> 0;
    this.hashHi = (this.hashHi ^ ZOB_CASTLE_HI[this.castling]) >>> 0;

    // En passant
    const epStr = parts[3] || '-';
    if (epStr !== '-' && epStr.length === 2) {
      const f = epStr.charCodeAt(0) - 97;
      const r = epStr.charCodeAt(1) - 49;
      this.epSq = r * 8 + f;
      if (this.hasAdjacentEnemyPawnForEp(this.epSq, this.stm)) {
        this.hashLo = (this.hashLo ^ ZOB_EP_LO[f]) >>> 0;
        this.hashHi = (this.hashHi ^ ZOB_EP_HI[f]) >>> 0;
      }
    } else {
      this.epSq = -1;
    }

    this.halfmove = parts[4] ? parseInt(parts[4], 10) || 0 : 0;
    this.fullmove = parts[5] ? parseInt(parts[5], 10) || 1 : 1;

    this.repHashLo[0] = this.hashLo;
    this.repHashHi[0] = this.hashHi;
    this.repCount = 1;
  }

  private hasAdjacentEnemyPawnForEp(epSq: number, stm: number): boolean {
    const f = epSq & 7;
    const capturePawn = stm === WHITE ? WP : BP;
    const pawnRank = stm === WHITE ? 4 : 3;
    const base = pawnRank * 8;
    if (f > 0 && this.squares[base + f - 1] === capturePawn) return true;
    if (f < 7 && this.squares[base + f + 1] === capturePawn) return true;
    return false;
  }

  private putPiece(sq: number, p: number): void {
    this.squares[sq] = p;
    this.pieceCounts[p]++;
    const idx = p * 64 + sq;
    this.hashLo = (this.hashLo ^ ZOB_PIECE_LO[idx]) >>> 0;
    this.hashHi = (this.hashHi ^ ZOB_PIECE_HI[idx]) >>> 0;
    const pt = p <= 6 ? p : p - 6;
    const color = p <= 6 ? WHITE : BLACK;
    if (pt === PT_PAWN) {
      this.pawnHash = (this.pawnHash ^ PAWN_ZOB[idx]) >>> 0;
    } else {
      this.nonPawnHash[color] = (this.nonPawnHash[color] ^ NONPAWN_ZOB[idx]) >>> 0;
      if (pt !== PT_KING) {
        this.nonPawnMat[color] += SEE_VAL[pt];
      }
    }
  }

  private removePiece(sq: number): number {
    const p = this.squares[sq];
    this.squares[sq] = EMPTY;
    this.pieceCounts[p]--;
    const idx = p * 64 + sq;
    this.hashLo = (this.hashLo ^ ZOB_PIECE_LO[idx]) >>> 0;
    this.hashHi = (this.hashHi ^ ZOB_PIECE_HI[idx]) >>> 0;
    const pt = p <= 6 ? p : p - 6;
    const color = p <= 6 ? WHITE : BLACK;
    if (pt === PT_PAWN) {
      this.pawnHash = (this.pawnHash ^ PAWN_ZOB[idx]) >>> 0;
    } else {
      this.nonPawnHash[color] = (this.nonPawnHash[color] ^ NONPAWN_ZOB[idx]) >>> 0;
      if (pt !== PT_KING) {
        this.nonPawnMat[color] -= SEE_VAL[pt];
      }
    }
    return p;
  }

  private movePiece(from: number, to: number, p: number): void {
    this.squares[from] = EMPTY;
    this.squares[to] = p;
    const idxFrom = p * 64 + from;
    const idxTo = p * 64 + to;
    this.hashLo = (this.hashLo ^ ZOB_PIECE_LO[idxFrom] ^ ZOB_PIECE_LO[idxTo]) >>> 0;
    this.hashHi = (this.hashHi ^ ZOB_PIECE_HI[idxFrom] ^ ZOB_PIECE_HI[idxTo]) >>> 0;
    const pt = p <= 6 ? p : p - 6;
    const color = p <= 6 ? WHITE : BLACK;
    if (pt === PT_PAWN) {
      this.pawnHash = (this.pawnHash ^ PAWN_ZOB[idxFrom] ^ PAWN_ZOB[idxTo]) >>> 0;
    } else {
      this.nonPawnHash[color] = (this.nonPawnHash[color] ^ NONPAWN_ZOB[idxFrom] ^ NONPAWN_ZOB[idxTo]) >>> 0;
    }
  }

  public isSquareAttacked(sq: number, byColor: number): boolean {
    const sqs = this.squares;

    // 1. Pawn attacks (lookup squares from `sq` as if `byColor^1` pawn were on `sq`)
    const pawnCheckColor = byColor ^ 1;
    const enemyPawn = byColor === WHITE ? WP : BP;
    const pCaps = PAWN_ATTACKS_FROM[pawnCheckColor][sq];
    for (let i = 0; i < pCaps.length; i++) {
      if (sqs[pCaps[i]] === enemyPawn) return true;
    }

    // 2. Knight attacks
    const enemyKnight = byColor === WHITE ? WN : BN;
    const kn = KNIGHT_MOVES[sq];
    for (let i = 0; i < kn.length; i++) {
      if (sqs[kn[i]] === enemyKnight) return true;
    }

    // 3. King attacks
    const enemyKing = byColor === WHITE ? WK : BK;
    const kg = KING_MOVES[sq];
    for (let i = 0; i < kg.length; i++) {
      if (sqs[kg[i]] === enemyKing) return true;
    }

    // 4. Diagonal rays (B or Q)
    const enemyB = byColor === WHITE ? WB : BB;
    const enemyQ = byColor === WHITE ? WQ : BQ;
    for (let d = 0; d < 4; d++) {
      const ray = RAY_SQUARES[d][sq];
      for (let i = 0; i < ray.length; i++) {
        const p = sqs[ray[i]];
        if (p !== EMPTY) {
          if (p === enemyB || p === enemyQ) return true;
          break;
        }
      }
    }

    // 5. Orthogonal rays (R or Q)
    const enemyR = byColor === WHITE ? WR : BR;
    for (let d = 4; d < 8; d++) {
      const ray = RAY_SQUARES[d][sq];
      for (let i = 0; i < ray.length; i++) {
        const p = sqs[ray[i]];
        if (p !== EMPTY) {
          if (p === enemyR || p === enemyQ) return true;
          break;
        }
      }
    }

    return false;
  }

  public isInCheck(): boolean {
    return this.isSquareAttacked(this.kingSq[this.stm], this.stm ^ 1);
  }

  public hasNonPawnMaterial(color: number): boolean {
    return this.nonPawnMat[color] > 0;
  }

  public isRepetition(): boolean {
    if (this.halfmove < 4) return false;
    const start = Math.max(0, this.repCount - 1 - this.halfmove);
    const lo = this.hashLo;
    const hi = this.hashHi;
    // Check 2-fold inside search (1 previous occurrence at or after root) or 3-fold in history
    let hits = 0;
    for (let i = this.repCount - 3; i >= start; i -= 2) {
      if (this.repHashLo[i] === lo && this.repHashHi[i] === hi) {
        hits++;
        // If within the active search tree, 1 prior match is enough to return draw score
        if (i >= this.repCount - 1 - this.ply || hits >= 2) return true;
      }
    }
    return false;
  }

  public isInsufficientMaterial(): boolean {
    if (
      this.pieceCounts[WP] > 0 || this.pieceCounts[BP] > 0 ||
      this.pieceCounts[WR] > 0 || this.pieceCounts[BR] > 0 ||
      this.pieceCounts[WQ] > 0 || this.pieceCounts[BQ] > 0
    ) {
      return false;
    }
    const wMinors = this.pieceCounts[WN] + this.pieceCounts[WB];
    const bMinors = this.pieceCounts[BN] + this.pieceCounts[BB];
    if (wMinors <= 1 && bMinors === 0) return true;
    if (bMinors <= 1 && wMinors === 0) return true;
    if (wMinors === 1 && bMinors === 1 && this.pieceCounts[WB] === 1 && this.pieceCounts[BB] === 1) {
      // Same-colored KB vs KB is draw (or even K+minor vs K+minor except rare cases; keep exact on KB vs KB same color)
      return false;
    }
    return false;
  }

  public makeMove(m: number): boolean {
    const p = this.ply;
    const from = m & 63;
    const to = (m >> 6) & 63;
    const promo = (m >> 12) & 7;
    const moved = (m >> 19) & 15;
    const captured = (m >> 23) & 15;
    const us = this.stm;
    const them = us ^ 1;

    this.uEp[p] = this.epSq;
    this.uCastle[p] = this.castling;
    this.uHalf[p] = this.halfmove;
    this.uCaptured[p] = captured;
    this.uHashLo[p] = this.hashLo;
    this.uHashHi[p] = this.hashHi;
    this.uPawnHash[p] = this.pawnHash;
    this.uNpHashW[p] = this.nonPawnHash[0];
    this.uNpHashB[p] = this.nonPawnHash[1];
    this.uRookFrom[p] = -1;
    this.uRookTo[p] = -1;

    // Clear old EP hash if it was hashed
    if (this.epSq !== -1 && this.hasAdjacentEnemyPawnForEp(this.epSq, us)) {
      const f = this.epSq & 7;
      this.hashLo = (this.hashLo ^ ZOB_EP_LO[f]) >>> 0;
      this.hashHi = (this.hashHi ^ ZOB_EP_HI[f]) >>> 0;
    }
    this.epSq = -1;

    // Update castling rights hash
    const newCastling = this.castling & this.castleMask[from] & this.castleMask[to];
    if (newCastling !== this.castling) {
      this.hashLo = (this.hashLo ^ ZOB_CASTLE_LO[this.castling] ^ ZOB_CASTLE_LO[newCastling]) >>> 0;
      this.hashHi = (this.hashHi ^ ZOB_CASTLE_HI[this.castling] ^ ZOB_CASTLE_HI[newCastling]) >>> 0;
      this.castling = newCastling;
    }

    const movedPt = moved <= 6 ? moved : moved - 6;

    if ((m & MV_FLAG_CASTLE) !== 0) {
      const backRank = us === WHITE ? 0 : 56;
      const isKingside = (to & 7) === 6;
      const rookFrom = backRank + (isKingside ? this.kRookStartFile[us] : this.qRookStartFile[us]);
      const rookTo = backRank + (isKingside ? 5 : 3);
      const rookPiece = us === WHITE ? WR : BR;
      this.uRookFrom[p] = rookFrom;
      this.uRookTo[p] = rookTo;

      // Remove king and rook first (Chess960 safe!)
      this.removePiece(from);
      this.removePiece(rookFrom);
      this.putPiece(to, moved);
      this.putPiece(rookTo, rookPiece);
      this.kingSq[us] = to;
      this.halfmove++;
    } else {
      if ((m & MV_FLAG_EP) !== 0) {
        const capSq = us === WHITE ? to - 8 : to + 8;
        this.uCapSq[p] = capSq;
        this.removePiece(capSq);
      } else if (captured !== EMPTY) {
        this.uCapSq[p] = to;
        this.removePiece(to);
      }

      if (promo !== 0) {
        this.removePiece(from);
        this.putPiece(to, us === WHITE ? promo : promo + 6);
      } else {
        this.movePiece(from, to, moved);
        if (movedPt === PT_KING) {
          this.kingSq[us] = to;
        }
      }

      if ((m & MV_FLAG_DPUSH) !== 0) {
        const newEp = (from + to) >> 1;
        this.epSq = newEp;
        if (this.hasAdjacentEnemyPawnForEp(newEp, them)) {
          const f = newEp & 7;
          this.hashLo = (this.hashLo ^ ZOB_EP_LO[f]) >>> 0;
          this.hashHi = (this.hashHi ^ ZOB_EP_HI[f]) >>> 0;
        }
      }

      if (movedPt === PT_PAWN || captured !== EMPTY) {
        this.halfmove = 0;
      } else {
        this.halfmove++;
      }
    }

    this.stm = them;
    this.hashLo = (this.hashLo ^ ZOB_STM_LO) >>> 0;
    this.hashHi = (this.hashHi ^ ZOB_STM_HI) >>> 0;
    this.ply++;

    // Legality check: cannot leave own king in check
    if (this.isSquareAttacked(this.kingSq[us], them)) {
      this.unmakeMove(m);
      return false;
    }

    this.repHashLo[this.repCount] = this.hashLo;
    this.repHashHi[this.repCount] = this.hashHi;
    this.repCount++;
    return true;
  }

  public unmakeMove(m: number): void {
    this.ply--;
    const p = this.ply;
    const from = m & 63;
    const to = (m >> 6) & 63;
    const promo = (m >> 12) & 7;
    const moved = (m >> 19) & 15;
    const captured = this.uCaptured[p];
    const us = this.stm ^ 1;

    // Decrement repCount only if makeMove succeeded (if called from failed legality check, repCount wasn't incremented!)
    // So caller tracks or we decrement in unmakeLegalMove vs unmakeMove. Wait: let's handle cleanly!
    // Actually: only increment repCount AFTER legality passes, and only decrement here when called after legal makeMove!
    // Wait: if makeMove calls unmakeMove on illegal move, repCount hasn't been incremented yet!
    // So let's NOT mutate repCount inside unmakeMove; expose unmakeLegalMove or decrement repCount cleanly!
    // Even simpler: save `repCount` or do `unmakeMoveInternal` inside failed makeMove!
    this.stm = us;
    const movedPt = moved <= 6 ? moved : moved - 6;

    if ((m & MV_FLAG_CASTLE) !== 0) {
      const rookFrom = this.uRookFrom[p];
      const rookTo = this.uRookTo[p];
      const rookPiece = us === WHITE ? WR : BR;
      this.squares[to] = EMPTY;
      this.squares[rookTo] = EMPTY;
      this.squares[from] = moved;
      this.squares[rookFrom] = rookPiece;
      this.kingSq[us] = from;
    } else {
      if (promo !== 0) {
        const promoPiece = us === WHITE ? promo : promo + 6;
        this.pieceCounts[promoPiece]--;
        this.nonPawnMat[us] -= SEE_VAL[promo];
        this.squares[to] = EMPTY;
        this.squares[from] = moved;
        this.pieceCounts[moved]++;
      } else {
        this.squares[to] = EMPTY;
        this.squares[from] = moved;
        if (movedPt === PT_KING) {
          this.kingSq[us] = from;
        }
      }

      if (captured !== EMPTY) {
        const capSq = (m & MV_FLAG_EP) !== 0 ? this.uCapSq[p] : to;
        this.squares[capSq] = captured;
        this.pieceCounts[captured]++;
        const capPt = captured <= 6 ? captured : captured - 6;
        if (capPt !== PT_PAWN && capPt !== PT_KING) {
          this.nonPawnMat[us ^ 1] += SEE_VAL[capPt];
        }
      }
    }

    this.epSq = this.uEp[p];
    this.castling = this.uCastle[p];
    this.halfmove = this.uHalf[p];
    this.hashLo = this.uHashLo[p];
    this.hashHi = this.uHashHi[p];
    this.pawnHash = this.uPawnHash[p];
    this.nonPawnHash[0] = this.uNpHashW[p];
    this.nonPawnHash[1] = this.uNpHashB[p];
  }

  public unmakeLegalMove(m: number): void {
    this.repCount--;
    this.unmakeMove(m);
  }

  public makeNullMove(): void {
    const p = this.ply;
    this.uEp[p] = this.epSq;
    this.uHalf[p] = this.halfmove;
    this.uHashLo[p] = this.hashLo;
    this.uHashHi[p] = this.hashHi;

    if (this.epSq !== -1 && this.hasAdjacentEnemyPawnForEp(this.epSq, this.stm)) {
      const f = this.epSq & 7;
      this.hashLo = (this.hashLo ^ ZOB_EP_LO[f]) >>> 0;
      this.hashHi = (this.hashHi ^ ZOB_EP_HI[f]) >>> 0;
    }
    this.epSq = -1;
    this.halfmove++;
    this.stm ^= 1;
    this.hashLo = (this.hashLo ^ ZOB_STM_LO) >>> 0;
    this.hashHi = (this.hashHi ^ ZOB_STM_HI) >>> 0;
    this.ply++;

    this.repHashLo[this.repCount] = this.hashLo;
    this.repHashHi[this.repCount] = this.hashHi;
    this.repCount++;
  }

  public unmakeNullMove(): void {
    this.repCount--;
    this.ply--;
    const p = this.ply;
    this.stm ^= 1;
    this.epSq = this.uEp[p];
    this.halfmove = this.uHalf[p];
    this.hashLo = this.uHashLo[p];
    this.hashHi = this.uHashHi[p];
  }

  /**
   * Generate pseudo-legal moves into preallocated Int32Array `outMoves`.
   * Returns number of moves generated.
   */
  public generatePseudoLegalMoves(outMoves: Int32Array, capturesOnly: boolean): number {
    const sqs = this.squares;
    const us = this.stm;
    const them = us ^ 1;
    const isWhite = us === WHITE;
    const ownMin = isWhite ? WP : BP;
    const ownMax = isWhite ? WK : BK;
    const oppMin = isWhite ? BP : WP;
    const oppMax = isWhite ? BK : PK_MAX_FOR(them);
    let count = 0;

    for (let sq = 0; sq < 64; sq++) {
      const p = sqs[sq];
      if (p < ownMin || p > ownMax) continue;
      const pt = isWhite ? p : p - 6;

      if (pt === PT_PAWN) {
        const rank = sq >> 3;
        const file = sq & 7;
        const forward = isWhite ? 8 : -8;
        const promoRank = isWhite ? 6 : 1;
        const startRank = isWhite ? 1 : 6;
        const isPromo = rank === promoRank;

        // Forward pushes
        const oneSq = sq + forward;
        if (sqs[oneSq] === EMPTY) {
          if (isPromo) {
            outMoves[count++] = packMove(sq, oneSq, PT_QUEEN, 0, p, 0);
            if (!capturesOnly) {
              outMoves[count++] = packMove(sq, oneSq, PT_KNIGHT, 0, p, 0);
              outMoves[count++] = packMove(sq, oneSq, PT_ROOK, 0, p, 0);
              outMoves[count++] = packMove(sq, oneSq, PT_BISHOP, 0, p, 0);
            }
          } else if (!capturesOnly) {
            outMoves[count++] = packMove(sq, oneSq, 0, 0, p, 0);
            if (rank === startRank) {
              const twoSq = oneSq + forward;
              if (sqs[twoSq] === EMPTY) {
                outMoves[count++] = packMove(sq, twoSq, 0, MV_FLAG_DPUSH, p, 0);
              }
            }
          }
        }

        // Captures (diagonal left / right)
        if (file > 0) {
          const capSq = oneSq - 1;
          const target = sqs[capSq];
          if (target >= oppMin && target <= oppMax) {
            if (isPromo) {
              outMoves[count++] = packMove(sq, capSq, PT_QUEEN, MV_FLAG_CAPTURE, p, target);
              outMoves[count++] = packMove(sq, capSq, PT_KNIGHT, MV_FLAG_CAPTURE, p, target);
              outMoves[count++] = packMove(sq, capSq, PT_ROOK, MV_FLAG_CAPTURE, p, target);
              outMoves[count++] = packMove(sq, capSq, PT_BISHOP, MV_FLAG_CAPTURE, p, target);
            } else {
              outMoves[count++] = packMove(sq, capSq, 0, MV_FLAG_CAPTURE, p, target);
            }
          } else if (capSq === this.epSq) {
            outMoves[count++] = packMove(sq, capSq, 0, MV_FLAG_CAPTURE | MV_FLAG_EP, p, isWhite ? BP : WP);
          }
        }
        if (file < 7) {
          const capSq = oneSq + 1;
          const target = sqs[capSq];
          if (target >= oppMin && target <= oppMax) {
            if (isPromo) {
              outMoves[count++] = packMove(sq, capSq, PT_QUEEN, MV_FLAG_CAPTURE, p, target);
              outMoves[count++] = packMove(sq, capSq, PT_KNIGHT, MV_FLAG_CAPTURE, p, target);
              outMoves[count++] = packMove(sq, capSq, PT_ROOK, MV_FLAG_CAPTURE, p, target);
              outMoves[count++] = packMove(sq, capSq, PT_BISHOP, MV_FLAG_CAPTURE, p, target);
            } else {
              outMoves[count++] = packMove(sq, capSq, 0, MV_FLAG_CAPTURE, p, target);
            }
          } else if (capSq === this.epSq) {
            outMoves[count++] = packMove(sq, capSq, 0, MV_FLAG_CAPTURE | MV_FLAG_EP, p, isWhite ? BP : WP);
          }
        }
      } else if (pt === PT_KNIGHT) {
        const targets = KNIGHT_MOVES[sq];
        for (let i = 0; i < targets.length; i++) {
          const to = targets[i];
          const target = sqs[to];
          if (target === EMPTY) {
            if (!capturesOnly) outMoves[count++] = packMove(sq, to, 0, 0, p, 0);
          } else if (target >= oppMin && target <= oppMax) {
            outMoves[count++] = packMove(sq, to, 0, MV_FLAG_CAPTURE, p, target);
          }
        }
      } else if (pt === PT_KING) {
        const targets = KING_MOVES[sq];
        for (let i = 0; i < targets.length; i++) {
          const to = targets[i];
          const target = sqs[to];
          if (target === EMPTY) {
            if (!capturesOnly) outMoves[count++] = packMove(sq, to, 0, 0, p, 0);
          } else if (target >= oppMin && target <= oppMax) {
            outMoves[count++] = packMove(sq, to, 0, MV_FLAG_CAPTURE, p, target);
          }
        }
        // Castling (only when not capturesOnly)
        if (!capturesOnly) {
          const kBit = isWhite ? CASTLE_WK : CASTLE_BK;
          const qBit = isWhite ? CASTLE_WQ : CASTLE_BQ;
          if ((this.castling & (kBit | qBit)) !== 0 && !this.isSquareAttacked(sq, them)) {
            const backRank = isWhite ? 0 : 56;
            const kingFile = sq & 7;
            if ((this.castling & kBit) !== 0) {
              const rf = this.kRookStartFile[us];
              const rookSq = backRank + rf;
              if (sqs[rookSq] === (isWhite ? WR : BR)) {
                const kDest = backRank + 6;
                const rDest = backRank + 5;
                if (this.canCastleClearAndSafe(backRank, kingFile, 6, rf, 5, sq, rookSq, them)) {
                  outMoves[count++] = packMove(sq, kDest, 0, MV_FLAG_CASTLE, p, 0);
                }
              }
            }
            if ((this.castling & qBit) !== 0) {
              const rf = this.qRookStartFile[us];
              const rookSq = backRank + rf;
              if (sqs[rookSq] === (isWhite ? WR : BR)) {
                const kDest = backRank + 2;
                if (this.canCastleClearAndSafe(backRank, kingFile, 2, rf, 3, sq, rookSq, them)) {
                  outMoves[count++] = packMove(sq, kDest, 0, MV_FLAG_CASTLE, p, 0);
                }
              }
            }
          }
        }
      } else {
        // Sliding pieces: B (0..3), R (4..7), Q (0..7)
        const dirStart = pt === PT_ROOK ? 4 : 0;
        const dirEnd = pt === PT_BISHOP ? 4 : 8;
        for (let d = dirStart; d < dirEnd; d++) {
          const ray = RAY_SQUARES[d][sq];
          for (let i = 0; i < ray.length; i++) {
            const to = ray[i];
            const target = sqs[to];
            if (target === EMPTY) {
              if (!capturesOnly) outMoves[count++] = packMove(sq, to, 0, 0, p, 0);
            } else {
              if (target >= oppMin && target <= oppMax) {
                outMoves[count++] = packMove(sq, to, 0, MV_FLAG_CAPTURE, p, target);
              }
              break;
            }
          }
        }
      }
    }

    return count;
  }

  private canCastleClearAndSafe(
    backRank: number,
    kingFile: number,
    kDestFile: number,
    rookFile: number,
    rDestFile: number,
    kingSq: number,
    rookSq: number,
    them: number
  ): boolean {
    const sqs = this.squares;
    const minK = kingFile < kDestFile ? kingFile : kDestFile;
    const maxK = kingFile > kDestFile ? kingFile : kDestFile;
    for (let f = minK; f <= maxK; f++) {
      const s = backRank + f;
      if (s !== kingSq && s !== rookSq && sqs[s] !== EMPTY) return false;
      if (f !== kingFile && this.isSquareAttacked(s, them)) return false;
    }
    const minR = rookFile < rDestFile ? rookFile : rDestFile;
    const maxR = rookFile > rDestFile ? rookFile : rDestFile;
    for (let f = minR; f <= maxR; f++) {
      const s = backRank + f;
      if (s !== kingSq && s !== rookSq && sqs[s] !== EMPTY) return false;
    }
    return true;
  }

  public generateLegalMoves(outMoves: Int32Array, capturesOnly = false): number {
    const temp = new Int32Array(256);
    const n = this.generatePseudoLegalMoves(temp, capturesOnly);
    let legal = 0;
    for (let i = 0; i < n; i++) {
      const m = temp[i];
      if (this.makeMove(m)) {
        outMoves[legal++] = m;
        this.unmakeLegalMove(m);
      }
    }
    return legal;
  }

  /**
   * True if legal move `m` delivers check to the enemy king.
   * Fast: uses makeMove / isInCheck / unmakeLegalMove or quick check.
   */
  public givesCheck(m: number): boolean {
    if (!this.makeMove(m)) return false;
    const chk = this.isInCheck();
    this.unmakeLegalMove(m);
    return chk;
  }

  public toFen(): string {
    let fen = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.squares[r * 8 + f];
        if (p === EMPTY) {
          empty++;
        } else {
          if (empty > 0) { fen += empty; empty = 0; }
          fen += ' PNBRQKpnbrqk'[p];
        }
      }
      if (empty > 0) fen += empty;
      if (r > 0) fen += '/';
    }
    fen += this.stm === WHITE ? ' w ' : ' b ';
    let c = '';
    if (this.castling & CASTLE_WK) c += 'K';
    if (this.castling & CASTLE_WQ) c += 'Q';
    if (this.castling & CASTLE_BK) c += 'k';
    if (this.castling & CASTLE_BQ) c += 'q';
    fen += c || '-';
    fen += ' ' + (this.epSq === -1 ? '-' : sqToCoord(this.epSq));
    fen += ` ${this.halfmove} ${this.fullmove}`;
    return fen;
  }
}

function PK_MAX_FOR(color: number): number {
  return color === WHITE ? WK : BK;
}

// ============================================================================
// Perft Verification Helper
// ============================================================================
export function perft(board: FastBoard, depth: number): number {
  if (depth === 0) return 1;
  const moves = new Int32Array(256);
  const n = board.generatePseudoLegalMoves(moves, false);
  if (depth === 1) {
    let nodes = 0;
    for (let i = 0; i < n; i++) {
      if (board.makeMove(moves[i])) {
        nodes++;
        board.unmakeLegalMove(moves[i]);
      }
    }
    return nodes;
  }
  let nodes = 0;
  for (let i = 0; i < n; i++) {
    const m = moves[i];
    if (board.makeMove(m)) {
      nodes += perft(board, depth - 1);
      board.unmakeLegalMove(m);
    }
  }
  return nodes;
}

// ============================================================================
// Exact Multi-Ply X-Ray Static Exchange Evaluation (SEE)
// ============================================================================
const removedMask = new Uint8Array(64);

function findLeastValuableAttacker(
  sqs: Int8Array,
  toSq: number,
  side: number
): { sq: number; pt: number } {
  const isW = side === WHITE;
  const pPawn = isW ? WP : BP;
  const pKnight = isW ? WN : BN;
  const pBishop = isW ? WB : BB;
  const pRook = isW ? WR : BR;
  const pQueen = isW ? WQ : BQ;
  const pKing = isW ? WK : BK;

  // 1. Pawns
  const pCaps = PAWN_ATTACKS_FROM[side ^ 1][toSq];
  for (let i = 0; i < pCaps.length; i++) {
    const s = pCaps[i];
    if (removedMask[s] === 0 && sqs[s] === pPawn) {
      return { sq: s, pt: PT_PAWN };
    }
  }

  // 2. Knights
  const kn = KNIGHT_MOVES[toSq];
  for (let i = 0; i < kn.length; i++) {
    const s = kn[i];
    if (removedMask[s] === 0 && sqs[s] === pKnight) {
      return { sq: s, pt: PT_KNIGHT };
    }
  }

  // 3. Bishops (and remember Queen if found on diagonal)
  let queenSq = -1;
  for (let d = 0; d < 4; d++) {
    const ray = RAY_SQUARES[d][toSq];
    for (let i = 0; i < ray.length; i++) {
      const s = ray[i];
      if (removedMask[s] !== 0) continue;
      const p = sqs[s];
      if (p !== EMPTY) {
        if (p === pBishop) return { sq: s, pt: PT_BISHOP };
        if (p === pQueen && queenSq === -1) queenSq = s;
        break;
      }
    }
  }

  // 4. Rooks (and remember Queen on orthogonal)
  for (let d = 4; d < 8; d++) {
    const ray = RAY_SQUARES[d][toSq];
    for (let i = 0; i < ray.length; i++) {
      const s = ray[i];
      if (removedMask[s] !== 0) continue;
      const p = sqs[s];
      if (p !== EMPTY) {
        if (p === pRook) return { sq: s, pt: PT_ROOK };
        if (p === pQueen && queenSq === -1) queenSq = s;
        break;
      }
    }
  }

  // 5. Queen
  if (queenSq !== -1) {
    return { sq: queenSq, pt: PT_QUEEN };
  }

  // 6. King
  const kg = KING_MOVES[toSq];
  for (let i = 0; i < kg.length; i++) {
    const s = kg[i];
    if (removedMask[s] === 0 && sqs[s] === pKing) {
      return { sq: s, pt: PT_KING };
    }
  }

  return { sq: -1, pt: 0 };
}

/**
 * Returns true if the Static Exchange Evaluation of `move` on `board` is >= `threshold`.
 * Zero-allocation exact swap-off with X-ray sliding discovery.
 */
const seeGain = new Int32Array(32);

export function exactSeeScore(board: FastBoard, move: number): number {
  if ((move & MV_FLAG_CASTLE) !== 0) return 0;

  const from = move & 63;
  const to = (move >> 6) & 63;
  const promo = (move >> 12) & 7;
  const captured = (move >> 23) & 15;
  const capPt = captured === EMPTY ? 0 : captured <= 6 ? captured : captured - 6;
  const movedPiece = (move >> 19) & 15;
  const movedPt = movedPiece <= 6 ? movedPiece : movedPiece - 6;

  // Fast path: quiet non-promo to undefended square
  const initialGain = SEE_VAL[capPt] + (promo !== 0 ? SEE_VAL[promo] - SEE_VAL[PT_PAWN] : 0);
  const nextVal = SEE_VAL[promo !== 0 ? promo : movedPt];
  if (capPt === 0 && promo === 0 && !board.isSquareAttacked(to, board.stm ^ 1)) {
    return 0;
  }

  removedMask.fill(0);
  removedMask[from] = 1;
  if ((move & MV_FLAG_EP) !== 0) {
    const epCapSq = board.stm === WHITE ? to - 8 : to + 8;
    removedMask[epCapSq] = 1;
  }

  seeGain[0] = initialGain;
  let d = 0;
  let stm = board.stm ^ 1;
  let pieceOnSqVal = nextVal;
  const sqs = board.squares;

  while (d < 30) {
    const att = findLeastValuableAttacker(sqs, to, stm);
    if (att.sq === -1) break;

    d++;
    seeGain[d] = pieceOnSqVal - seeGain[d - 1];
    removedMask[att.sq] = 1;
    pieceOnSqVal = SEE_VAL[att.pt];
    stm ^= 1;
  }

  while (d > 0) {
    seeGain[d - 1] = -Math.max(-seeGain[d - 1], seeGain[d]);
    d--;
  }

  return seeGain[0];
}

/**
 * Returns true if the Static Exchange Evaluation of `move` on `board` is >= `threshold`.
 * Zero-allocation exact swap-off with X-ray sliding discovery.
 */
export function seeGe(board: FastBoard, move: number, threshold: number): boolean {
  if ((move & MV_FLAG_CASTLE) !== 0) return threshold <= 0;
  const promo = (move >> 12) & 7;
  const captured = (move >> 23) & 15;
  const capPt = captured === EMPTY ? 0 : captured <= 6 ? captured : captured - 6;
  const movedPiece = (move >> 19) & 15;
  const movedPt = movedPiece <= 6 ? movedPiece : movedPiece - 6;

  const initialGain = SEE_VAL[capPt] + (promo !== 0 ? SEE_VAL[promo] - SEE_VAL[PT_PAWN] : 0);
  if (initialGain < threshold) return false;
  const nextVal = SEE_VAL[promo !== 0 ? promo : movedPt];
  if (initialGain - nextVal >= threshold) return true;

  return exactSeeScore(board, move) >= threshold;
}

// ============================================================================
// Fast Tapered PeSTO + Structural + King Safety + Endgame Evaluation
// ============================================================================
export function evaluateFast(board: FastBoard, contemptCp = 12): number {
  const sqs = board.squares;

  wPawnCountByFile.fill(0);
  bPawnCountByFile.fill(0);
  wPawnRanks.fill(0);
  bPawnRanks.fill(0);
  wMinPawnRank.fill(7);
  wMaxPawnRank.fill(0);
  bMinPawnRank.fill(7);
  bMaxPawnRank.fill(0);

  let mgScore = 0;
  let egScore = 0;
  let gamePhase = 0;
  let wBishops = 0;
  let bBishops = 0;
  let wBishopLight = 0;
  let wBishopDark = 0;
  let bBishopLight = 0;
  let bBishopDark = 0;
  let wPawnsTotal = 0;
  let bPawnsTotal = 0;
  let nonKingCount = 0;

  let pieceCount = 0;

  // Pass 1: Material, PST, Pawn file/rank summaries, collect non-pawn piece squares
  for (let sq = 0; sq < 64; sq++) {
    const p = sqs[sq];
    if (p === EMPTY) continue;

    const isWhite = p <= 6;
    const pt = isWhite ? p : p - 6;
    const tblIdx = isWhite ? (sq ^ 56) : sq;
    const f = sq & 7;
    const r = sq >> 3;

    if (pt !== PT_KING) nonKingCount++;

    const mg = MG_VAL[pt] + PST_MG[pt]![tblIdx];
    const eg = EG_VAL[pt] + PST_EG[pt]![tblIdx];
    if (isWhite) {
      mgScore += mg;
      egScore += eg;
    } else {
      mgScore -= mg;
      egScore -= eg;
    }
    gamePhase += PHASE_INC[pt];

    if (pt === PT_PAWN) {
      if (isWhite) {
        wPawnsTotal++;
        wPawnCountByFile[f]++;
        wPawnRanks[f] |= (1 << r);
        if (r < wMinPawnRank[f]) wMinPawnRank[f] = r;
        if (r > wMaxPawnRank[f]) wMaxPawnRank[f] = r;
      } else {
        bPawnsTotal++;
        bPawnCountByFile[f]++;
        bPawnRanks[f] |= (1 << r);
        if (r < bMinPawnRank[f]) bMinPawnRank[f] = r;
        if (r > bMaxPawnRank[f]) bMaxPawnRank[f] = r;
      }
    } else if (pt !== PT_KING) {
      pieceListSq[pieceCount] = sq;
      pieceListVal[pieceCount] = p;
      pieceCount++;
      if (pt === PT_BISHOP) {
        const isLight = ((r + f) & 1) === 1;
        if (isWhite) {
          wBishops++;
          if (isLight) wBishopLight++; else wBishopDark++;
        } else {
          bBishops++;
          if (isLight) bBishopLight++; else bBishopDark++;
        }
      }
    }
  }

  // Bishop pair
  if (wBishops >= 2) { mgScore += 34; egScore += 54; }
  if (bBishops >= 2) { mgScore -= 34; egScore -= 54; }

  const wkSq = board.kingSq[WHITE];
  const bkSq = board.kingSq[BLACK];
  const wkF = wkSq & 7;
  const wkR = wkSq >> 3;
  const bkF = bkSq & 7;
  const bkR = bkSq >> 3;

  // King zone squares for attacker danger (only in middlegame when non-pawn material is non-trivial)
  const computeKingSafety = gamePhase >= 6;
  let wKingAttackUnits = 0;
  let wKingAttackers = 0;
  let bKingAttackUnits = 0;
  let bKingAttackers = 0;

  if (computeKingSafety) {
    wKingZoneMask.fill(0);
    bKingZoneMask.fill(0);
    wKingZoneMask[wkSq] = 1;
    bKingZoneMask[bkSq] = 1;
    const wkRing = KING_MOVES[wkSq];
    for (let i = 0; i < wkRing.length; i++) wKingZoneMask[wkRing[i]] = 1;
    const bkRing = KING_MOVES[bkSq];
    for (let i = 0; i < bkRing.length; i++) bKingZoneMask[bkRing[i]] = 1;
    if (wkSq + 16 < 64) wKingZoneMask[wkSq + 16] = 1;
    if (bkSq - 16 >= 0) bKingZoneMask[bkSq - 16] = 1;
  }

  // Pass 2: Pawn Structure, Passed Pawns, Doubled/Isolated/Backward/Connected + Rule of the Square
  let wPassersCount = 0;
  let bPassersCount = 0;
  let wBestPasserSq = -1;
  let bBestPasserSq = -1;

  for (let f = 0; f < 8; f++) {
    // Doubled pawns
    if (wPawnCountByFile[f] > 1) {
      const extra = wPawnCountByFile[f] - 1;
      mgScore -= extra * 11;
      egScore -= extra * 18;
    }
    if (bPawnCountByFile[f] > 1) {
      const extra = bPawnCountByFile[f] - 1;
      mgScore += extra * 11;
      egScore += extra * 18;
    }

    // White pawns on file f
    let wMask = wPawnRanks[f];
    if (wMask !== 0) {
      const leftF = f > 0 ? wPawnRanks[f - 1] : 0;
      const rightF = f < 7 ? wPawnRanks[f + 1] : 0;
      const adjMask = leftF | rightF;
      const isIsolated = adjMask === 0;

      for (let r = 1; r <= 6; r++) {
        if ((wMask & (1 << r)) === 0) continue;
        const sq = r * 8 + f;

        if (isIsolated) {
          mgScore -= 13;
          egScore -= 16;
        } else {
          // Phalanx / Supported pawn
          const sameOrBehind = ((1 << r) | (1 << (r - 1)));
          if ((adjMask & sameOrBehind) !== 0) {
            mgScore += 8 + r * 2;
            egScore += 10 + r * 3;
          } else {
            // Backward pawn check: no friendly pawn behind on adjacent files AND stop square attacked by black pawn
            const behindMask = ((1 << r) - 1);
            if ((adjMask & behindMask) === 0) {
              const stopSq = sq + 8;
              const enemyAttackStop =
                (f > 0 && stopSq + 7 < 64 && sqs[stopSq + 7] === BP) ||
                (f < 7 && stopSq + 9 < 64 && sqs[stopSq + 9] === BP);
              if (enemyAttackStop) {
                mgScore -= 10;
                egScore -= 12;
              }
            }
          }
        }

        // Passed pawn check (no black pawns ahead on files f-1, f, f+1)
        const aheadMask = ~((1 << (r + 1)) - 1);
        const enemyBlockers =
          (bPawnRanks[f] & aheadMask) |
          (f > 0 ? bPawnRanks[f - 1] & aheadMask : 0) |
          (f < 7 ? bPawnRanks[f + 1] & aheadMask : 0);

        if (enemyBlockers === 0) {
          wPassersCount++;
          if (wBestPasserSq === -1 || r > (wBestPasserSq >> 3)) wBestPasserSq = sq;
          let passMg = PASSED_BONUS_MG[r];
          let passEg = PASSED_BONUS_EG[r];

          // Blocked passer penalty
          if (sqs[sq + 8] !== EMPTY) {
            passMg = (passMg * 2) >> 2;
            passEg = (passEg * 3) >> 2;
          }
          // Connected passer
          if ((adjMask & ((1 << r) | (1 << (r - 1)) | (1 << (r + 1)))) !== 0 && r >= 4) {
            passEg += 25;
          }
          // Endgame king escort / enemy king distance
          if (nonKingCount <= 10) {
            const ownDist = Math.max(Math.abs(wkF - f), Math.abs(wkR - r));
            const oppDist = Math.max(Math.abs(bkF - f), Math.abs(bkR - r));
            passEg += (oppDist - ownDist) * 6;
            if (ownDist <= 2) passEg += (3 - ownDist) * 16;

            // Rule of the Square in pure pawn endgames
            if (nonKingCount === wPawnsTotal + bPawnsTotal) {
              const distToPromo = 7 - r;
              const bkDistPromo = Math.max(Math.abs(bkF - f), 7 - bkR);
              const effDist = board.stm === BLACK ? bkDistPromo - 1 : bkDistPromo;
              if (effDist > distToPromo) {
                passEg += 650;
              }
            }
          }
          mgScore += passMg;
          egScore += passEg;
        }
      }
    }

    // Black pawns on file f
    let bMask = bPawnRanks[f];
    if (bMask !== 0) {
      const leftF = f > 0 ? bPawnRanks[f - 1] : 0;
      const rightF = f < 7 ? bPawnRanks[f + 1] : 0;
      const adjMask = leftF | rightF;
      const isIsolated = adjMask === 0;

      for (let r = 6; r >= 1; r--) {
        if ((bMask & (1 << r)) === 0) continue;
        const sq = r * 8 + f;
        const relR = 7 - r;

        if (isIsolated) {
          mgScore += 13;
          egScore += 16;
        } else {
          const sameOrBehind = ((1 << r) | (1 << (r + 1)));
          if ((adjMask & sameOrBehind) !== 0) {
            mgScore -= 8 + relR * 2;
            egScore -= 10 + relR * 3;
          } else {
            const behindMask = ~((1 << (r + 1)) - 1);
            if ((adjMask & behindMask) === 0) {
              const stopSq = sq - 8;
              const enemyAttackStop =
                (f > 0 && stopSq - 9 >= 0 && sqs[stopSq - 9] === WP) ||
                (f < 7 && stopSq - 7 >= 0 && sqs[stopSq - 7] === WP);
              if (enemyAttackStop) {
                mgScore += 10;
                egScore += 12;
              }
            }
          }
        }

        const aheadMask = (1 << r) - 1;
        const enemyBlockers =
          (wPawnRanks[f] & aheadMask) |
          (f > 0 ? wPawnRanks[f - 1] & aheadMask : 0) |
          (f < 7 ? wPawnRanks[f + 1] & aheadMask : 0);

        if (enemyBlockers === 0) {
          bPassersCount++;
          if (bBestPasserSq === -1 || r < (bBestPasserSq >> 3)) bBestPasserSq = sq;
          let passMg = PASSED_BONUS_MG[relR];
          let passEg = PASSED_BONUS_EG[relR];

          if (sqs[sq - 8] !== EMPTY) {
            passMg = (passMg * 2) >> 2;
            passEg = (passEg * 3) >> 2;
          }
          if ((adjMask & ((1 << r) | (1 << (r - 1)) | (1 << (r + 1)))) !== 0 && relR >= 4) {
            passEg += 25;
          }
          if (nonKingCount <= 10) {
            const ownDist = Math.max(Math.abs(bkF - f), Math.abs(bkR - r));
            const oppDist = Math.max(Math.abs(wkF - f), Math.abs(wkR - r));
            passEg += (oppDist - ownDist) * 6;
            if (ownDist <= 2) passEg += (3 - ownDist) * 16;

            if (nonKingCount === wPawnsTotal + bPawnsTotal) {
              const distToPromo = r;
              const wkDistPromo = Math.max(Math.abs(wkF - f), wkR);
              const effDist = board.stm === WHITE ? wkDistPromo - 1 : wkDistPromo;
              if (effDist > distToPromo) {
                passEg += 650;
              }
            }
          }
          mgScore -= passMg;
          egScore -= passEg;
        }
      }
    }
  }

  // Pass 3: Piece Mobility, Open Files, 7th Rank, Outposts, Tarrasch Rook, King Zone Pressure & Pawn Threats
  for (let i = 0; i < pieceCount; i++) {
    const sq = pieceListSq[i];
    const p = pieceListVal[i];
    const isWhite = p <= 6;
    const pt = isWhite ? p : p - 6;
    const sign = isWhite ? 1 : -1;
    const f = sq & 7;
    const r = sq >> 3;
    const relR = isWhite ? r : 7 - r;
    const ownMin = isWhite ? WP : BP;
    const ownMax = isWhite ? WK : BK;
    const enemyPawn = isWhite ? BP : WP;

    // Threat: is this piece currently attacked by an enemy pawn?
    const pCaps = PAWN_ATTACKS_FROM[isWhite ? WHITE : BLACK][sq];
    for (let k = 0; k < pCaps.length; k++) {
      if (sqs[pCaps[k]] === enemyPawn) {
        const threatPen = pt === PT_QUEEN ? 55 : pt === PT_ROOK ? 45 : 30;
        mgScore -= sign * threatPen;
        egScore -= sign * (threatPen >> 1);
        break;
      }
    }

    if (pt === PT_KNIGHT) {
      const targets = KNIGHT_MOVES[sq];
      let mob = 0;
      let kzHits = 0;
      for (let k = 0; k < targets.length; k++) {
        const to = targets[k];
        const tp = sqs[to];
        if (tp < ownMin || tp > ownMax) {
          mob++;
          if (computeKingSafety) {
            if (isWhite && bKingZoneMask[to]) kzHits++;
            else if (!isWhite && wKingZoneMask[to]) kzHits++;
          }
        }
      }
      mgScore += sign * (mob - 4) * 4;
      egScore += sign * (mob - 4) * 3;
      if (kzHits > 0) {
        if (isWhite) { bKingAttackers++; bKingAttackUnits += kzHits * 8; }
        else { wKingAttackers++; wKingAttackUnits += kzHits * 8; }
      }

      // Knight outpost: on ranks 4-6 (relR 3..5), supported by own pawn, no enemy pawns ahead on adjacent files
      if (relR >= 3 && relR <= 5) {
        const supLeft = isWhite ? (f > 0 && sq - 9 >= 0 && sqs[sq - 9] === WP) : (f > 0 && sq + 7 < 64 && sqs[sq + 7] === BP);
        const supRight = isWhite ? (f < 7 && sq - 7 >= 0 && sqs[sq - 7] === WP) : (f < 7 && sq + 9 < 64 && sqs[sq + 9] === BP);
        if (supLeft || supRight) {
          const oppAdjPawns = isWhite
            ? ((f > 0 ? bPawnRanks[f - 1] : 0) | (f < 7 ? bPawnRanks[f + 1] : 0)) & (~((1 << (r + 1)) - 1))
            : ((f > 0 ? wPawnRanks[f - 1] : 0) | (f < 7 ? wPawnRanks[f + 1] : 0)) & ((1 << r) - 1);
          if (oppAdjPawns === 0) {
            mgScore += sign * 28;
            egScore += sign * 18;
          }
        }
      }
    } else if (pt === PT_BISHOP) {
      let mob = 0;
      let kzHits = 0;
      for (let d = 0; d < 4; d++) {
        const ray = RAY_SQUARES[d][sq];
        for (let k = 0; k < ray.length; k++) {
          const to = ray[k];
          const tp = sqs[to];
          if (tp === EMPTY) {
            mob++;
            if (computeKingSafety) {
              if (isWhite && bKingZoneMask[to]) kzHits++;
              else if (!isWhite && wKingZoneMask[to]) kzHits++;
            }
          } else {
            if (tp < ownMin || tp > ownMax) {
              mob++;
              if (computeKingSafety) {
                if (isWhite && bKingZoneMask[to]) kzHits++;
                else if (!isWhite && wKingZoneMask[to]) kzHits++;
              }
            }
            break;
          }
        }
      }
      mgScore += sign * (mob - 6) * 5;
      egScore += sign * (mob - 6) * 4;
      if (kzHits > 0) {
        if (isWhite) { bKingAttackers++; bKingAttackUnits += kzHits * 7; }
        else { wKingAttackers++; wKingAttackUnits += kzHits * 7; }
      }
    } else if (pt === PT_ROOK) {
      // Open / semi-open file
      const ownPawnsOnFile = isWhite ? wPawnCountByFile[f] : bPawnCountByFile[f];
      const oppPawnsOnFile = isWhite ? bPawnCountByFile[f] : wPawnCountByFile[f];
      if (ownPawnsOnFile === 0) {
        if (oppPawnsOnFile === 0) {
          mgScore += sign * 26;
          egScore += sign * 18;
        } else {
          mgScore += sign * 14;
          egScore += sign * 9;
        }
      }
      // 7th rank rook
      if (relR === 6) {
        mgScore += sign * 22;
        egScore += sign * 30;
      }
      // Tarrasch rule: rook behind own passed pawn
      if (isWhite && wBestPasserSq !== -1 && (wBestPasserSq & 7) === f && r < (wBestPasserSq >> 3)) {
        egScore += 45;
      } else if (!isWhite && bBestPasserSq !== -1 && (bBestPasserSq & 7) === f && r > (bBestPasserSq >> 3)) {
        egScore -= 45;
      }

      let mob = 0;
      let kzHits = 0;
      for (let d = 4; d < 8; d++) {
        const ray = RAY_SQUARES[d][sq];
        for (let k = 0; k < ray.length; k++) {
          const to = ray[k];
          const tp = sqs[to];
          if (tp === EMPTY) {
            mob++;
            if (computeKingSafety) {
              if (isWhite && bKingZoneMask[to]) kzHits++;
              else if (!isWhite && wKingZoneMask[to]) kzHits++;
            }
          } else {
            if (tp < ownMin || tp > ownMax) {
              mob++;
              if (computeKingSafety) {
                if (isWhite && bKingZoneMask[to]) kzHits++;
                else if (!isWhite && wKingZoneMask[to]) kzHits++;
              }
            }
            break;
          }
        }
      }
      mgScore += sign * (mob - 7) * 3;
      egScore += sign * (mob - 7) * 4;
      if (kzHits > 0) {
        if (isWhite) { bKingAttackers++; bKingAttackUnits += kzHits * 11; }
        else { wKingAttackers++; wKingAttackUnits += kzHits * 11; }
      }
    } else if (pt === PT_QUEEN) {
      let mob = 0;
      let kzHits = 0;
      for (let d = 0; d < 8; d++) {
        const ray = RAY_SQUARES[d][sq];
        for (let k = 0; k < ray.length; k++) {
          const to = ray[k];
          const tp = sqs[to];
          if (tp === EMPTY) {
            mob++;
            if (computeKingSafety) {
              if (isWhite && bKingZoneMask[to]) kzHits++;
              else if (!isWhite && wKingZoneMask[to]) kzHits++;
            }
          } else {
            if (tp < ownMin || tp > ownMax) {
              mob++;
              if (computeKingSafety) {
                if (isWhite && bKingZoneMask[to]) kzHits++;
                else if (!isWhite && wKingZoneMask[to]) kzHits++;
              }
            }
            break;
          }
        }
      }
      mgScore += sign * (mob - 14) * 1;
      egScore += sign * (mob - 14) * 2;
      if (kzHits > 0) {
        if (isWhite) { bKingAttackers++; bKingAttackUnits += kzHits * 14; }
        else { wKingAttackers++; wKingAttackUnits += kzHits * 14; }
      }
    }
  }

  // Pass 4: King Safety (Pawn Shield + Open Files Near King + Quadratic Attacker Pressure)
  if (computeKingSafety) {
    let wShield = 0;
    let bShield = 0;
    const wMinF = wkF > 0 ? wkF - 1 : 0;
    const wMaxF = wkF < 7 ? wkF + 1 : 7;
    for (let f = wMinF; f <= wMaxF; f++) {
      const m = wPawnRanks[f];
      if ((m & 2) !== 0) wShield += 16; // rank 2
      else if ((m & 4) !== 0) wShield += 9; // rank 3
      else wShield -= 16; // missing pawn shield
      if (bPawnRanks[f] === 0 && m === 0) wShield -= 14; // open file near king
    }

    const bMinF = bkF > 0 ? bkF - 1 : 0;
    const bMaxF = bkF < 7 ? bkF + 1 : 7;
    for (let f = bMinF; f <= bMaxF; f++) {
      const m = bPawnRanks[f];
      if ((m & 64) !== 0) bShield += 16; // rank 7
      else if ((m & 32) !== 0) bShield += 9; // rank 6
      else bShield -= 16;
      if (wPawnRanks[f] === 0 && m === 0) bShield -= 14;
    }

    mgScore += (wShield - bShield);

    // Quadratic attacker scaling
    const wDanger = wKingAttackers >= 2 ? (wKingAttackUnits * wKingAttackers) >> 1 : wKingAttackUnits >> 2;
    const bDanger = bKingAttackers >= 2 ? (bKingAttackUnits * bKingAttackers) >> 1 : bKingAttackUnits >> 2;
    mgScore += Math.min(350, bDanger) - Math.min(350, wDanger);
  }

  // Pass 5: Endgame King Centralization, Opposition & Mop-Up
  if (nonKingCount <= 8) {
    const wCenterDist = Math.abs(wkF - 3.5) + Math.abs(wkR - 3.5);
    const bCenterDist = Math.abs(bkF - 3.5) + Math.abs(bkR - 3.5);
    egScore += Math.round((bCenterDist - wCenterDist) * 8);

    // Direct opposition in pawn endgames
    if (nonKingCount === wPawnsTotal + bPawnsTotal) {
      const df = Math.abs(wkF - bkF);
      const dr = Math.abs(wkR - bkR);
      if ((df === 0 && dr === 2) || (dr === 0 && df === 2)) {
        // Side NOT to move has the opposition!
        egScore += board.stm === BLACK ? 18 : -18;
      }
    }

    // Mop-up when one side has clear material advantage & few/no pawns
    if (Math.abs(egScore) > 250) {
      const kingDist = Math.abs(wkF - bkF) + Math.abs(wkR - bkR);
      if (egScore > 0 && board.nonPawnMat[BLACK] <= 330) {
        egScore += Math.round(bCenterDist * 10 + (14 - kingDist) * 5);
      } else if (egScore < 0 && board.nonPawnMat[WHITE] <= 330) {
        egScore -= Math.round(wCenterDist * 10 + (14 - kingDist) * 5);
      }
    }
  }

  // Tapered Interpolation
  const phase = gamePhase > 24 ? 24 : gamePhase;
  let evalWhite = Math.trunc((mgScore * phase + egScore * (24 - phase)) / 24);

  // Opposite-colored bishop endgame draw scaling
  if (
    phase <= 4 &&
    wBishops === 1 &&
    bBishops === 1 &&
    wBishopLight !== bBishopLight &&
    board.nonPawnMat[WHITE] < 500 &&
    board.nonPawnMat[BLACK] < 500
  ) {
    evalWhite = Math.trunc((evalWhite * 72) / 100);
  }

  // Side-to-move perspective + tempo bonus
  let stmEval = (board.stm === WHITE ? evalWhite : -evalWhite) + contemptCp;

  // 50-move drawishness decay
  if (board.halfmove >= 40 && Math.abs(stmEval) < 15000) {
    const factor = Math.max(0, 100 - board.halfmove);
    stmEval = Math.trunc((stmEval * factor) / 60);
  }

  return stmEval;
}
