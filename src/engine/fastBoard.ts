/**
 * FastBoard: Zero-Allocation 32-Bit Pair Bitboard + Mailbox Chess Representation
 *
 * Uses Reckless-compatible piece & square encodings:
 * - Squares: LERFM (0 = a1, 1 = b1, ..., 63 = h8), sq = rank * 8 + file
 * - Pieces:  0=wP, 1=bP, 2=wN, 3=bN, 4=wB, 5=bB, 6=wR, 7=bR, 8=wQ, 9=bQ, 10=wK, 11=bK, 255=EMPTY
 * - Color:   0 = White, 1 = Black
 * - PieceType: 0=Pawn, 1=Knight, 2=Bishop, 3=Rook, 4=Queen, 5=King
 */

export const WHITE = 0;
export const BLACK = 1;

export const PT_PAWN = 0;
export const PT_KNIGHT = 1;
export const PT_BISHOP = 2;
export const PT_ROOK = 3;
export const PT_QUEEN = 4;
export const PT_KING = 5;
export const EMPTY = 255;

export const MAX_PLY = 128;
export const MAX_MOVES_PER_PLY = 256;
export const MAX_GAME_HISTORY = 1024;

// Move flags
export const FLAG_QUIET = 0;
export const FLAG_DOUBLE_PUSH = 1;
export const FLAG_KING_CASTLE = 2;
export const FLAG_QUEEN_CASTLE = 3;
export const FLAG_CAPTURE = 4;
export const FLAG_EP = 5;
export const FLAG_PROMO = 8; // combined with PT_KNIGHT(1)..PT_QUEEN(4) & optionally FLAG_CAPTURE(4)

export const SEE_PIECE_VALUES = new Int32Array([100, 320, 335, 500, 950, 20000]);

export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;

const CASTLE_MASK = new Uint8Array(64);
CASTLE_MASK.fill(15);
CASTLE_MASK[0] &= ~CASTLE_WQ;  // a1
CASTLE_MASK[4] &= ~(CASTLE_WK | CASTLE_WQ); // e1
CASTLE_MASK[7] &= ~CASTLE_WK;  // h1
CASTLE_MASK[56] &= ~CASTLE_BQ; // a8
CASTLE_MASK[60] &= ~(CASTLE_BK | CASTLE_BQ); // e8
CASTLE_MASK[63] &= ~CASTLE_BK; // h8

// Piece char maps
const CHAR_TO_PIECE: Record<string, number> = {
  P: 0, p: 1,
  N: 2, n: 3,
  B: 4, b: 5,
  R: 6, r: 7,
  Q: 8, q: 9,
  K: 10, k: 11,
};

const PIECE_TO_CHAR = ['P', 'p', 'N', 'n', 'B', 'b', 'R', 'r', 'Q', 'q', 'K', 'k'];

export function ctz32(x: number): number {
  return 31 - Math.clz32(x & -x);
}

export function msb32(x: number): number {
  return 31 - Math.clz32(x);
}

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Precomputed 64-bit bitboard tables stored as paired Uint32Arrays (lo = squares 0..31, hi = squares 32..63)
export const PAWN_ATK_LO = [new Uint32Array(64), new Uint32Array(64)];
export const PAWN_ATK_HI = [new Uint32Array(64), new Uint32Array(64)];
export const KNIGHT_ATK_LO = new Uint32Array(64);
export const KNIGHT_ATK_HI = new Uint32Array(64);
export const KING_ATK_LO = new Uint32Array(64);
export const KING_ATK_HI = new Uint32Array(64);

// 8 rays: 0=N(+8), 1=S(-8), 2=E(+1), 3=W(-1), 4=NE(+9), 5=NW(+7), 6=SE(-7), 7=SW(-9)
const DIR_DR = [1, -1, 0, 0, 1, 1, -1, -1];
const DIR_DF = [0, 0, 1, -1, 1, -1, 1, -1];
const RAY_POS = [true, false, true, false, true, true, false, false];
export const RAY_LO: Uint32Array[] = Array.from({ length: 8 }, () => new Uint32Array(64));
export const RAY_HI: Uint32Array[] = Array.from({ length: 8 }, () => new Uint32Array(64));
export const BETWEEN_LO = new Uint32Array(64 * 64);
export const BETWEEN_HI = new Uint32Array(64 * 64);
export const RAYPASS_LO = new Uint32Array(64 * 64);
export const RAYPASS_HI = new Uint32Array(64 * 64);

// Deterministic PRNG (xorshift32) for Zobrist keys
let seed = 0x9e3779b9;
function nextRand32(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
}

export const ZOBRIST_PIECE_LO = new Uint32Array(12 * 64);
export const ZOBRIST_PIECE_HI = new Uint32Array(12 * 64);
export const ZOBRIST_CASTLE_LO = new Uint32Array(16);
export const ZOBRIST_CASTLE_HI = new Uint32Array(16);
export const ZOBRIST_EP_LO = new Uint32Array(8);
export const ZOBRIST_EP_HI = new Uint32Array(8);
export const ZOBRIST_SIDE_LO = nextRand32();
export const ZOBRIST_SIDE_HI = nextRand32();

for (let i = 0; i < 12 * 64; i++) {
  ZOBRIST_PIECE_LO[i] = nextRand32();
  ZOBRIST_PIECE_HI[i] = nextRand32();
}
for (let i = 0; i < 16; i++) {
  ZOBRIST_CASTLE_LO[i] = nextRand32();
  ZOBRIST_CASTLE_HI[i] = nextRand32();
}
for (let i = 0; i < 8; i++) {
  ZOBRIST_EP_LO[i] = nextRand32();
  ZOBRIST_EP_HI[i] = nextRand32();
}

function setBit(loArr: Uint32Array, hiArr: Uint32Array, idx: number, sq: number) {
  if (sq < 32) loArr[idx] |= 1 << sq;
  else hiArr[idx] |= 1 << (sq - 32);
}

// Initialize attack tables
(function initAttackTables() {
  for (let sq = 0; sq < 64; sq++) {
    const r = sq >> 3;
    const f = sq & 7;

    // White pawns (+1 rank, +/-1 file)
    if (r + 1 < 8) {
      if (f - 1 >= 0) setBit(PAWN_ATK_LO[WHITE], PAWN_ATK_HI[WHITE], sq, (r + 1) * 8 + (f - 1));
      if (f + 1 < 8) setBit(PAWN_ATK_LO[WHITE], PAWN_ATK_HI[WHITE], sq, (r + 1) * 8 + (f + 1));
    }
    // Black pawns (-1 rank, +/-1 file)
    if (r - 1 >= 0) {
      if (f - 1 >= 0) setBit(PAWN_ATK_LO[BLACK], PAWN_ATK_HI[BLACK], sq, (r - 1) * 8 + (f - 1));
      if (f + 1 < 8) setBit(PAWN_ATK_LO[BLACK], PAWN_ATK_HI[BLACK], sq, (r - 1) * 8 + (f + 1));
    }

    // Knight
    const kOffsets = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    for (const [dr, df] of kOffsets) {
      const nr = r + dr, nf = f + df;
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
        setBit(KNIGHT_ATK_LO, KNIGHT_ATK_HI, sq, nr * 8 + nf);
      }
    }

    // King
    for (let dr = -1; dr <= 1; dr++) {
      for (let df = -1; df <= 1; df++) {
        if (dr === 0 && df === 0) continue;
        const nr = r + dr, nf = f + df;
        if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
          setBit(KING_ATK_LO, KING_ATK_HI, sq, nr * 8 + nf);
        }
      }
    }

    // 8 Rays
    for (let d = 0; d < 8; d++) {
      let nr = r + DIR_DR[d];
      let nf = f + DIR_DF[d];
      while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
        setBit(RAY_LO[d], RAY_HI[d], sq, nr * 8 + nf);
        nr += DIR_DR[d];
        nf += DIR_DF[d];
      }
    }
  }

  // Between and Raypass tables (used by NNUE threat updates)
  for (let s1 = 0; s1 < 64; s1++) {
    const r1 = s1 >> 3, f1 = s1 & 7;
    for (let s2 = 0; s2 < 64; s2++) {
      if (s1 === s2) continue;
      const r2 = s2 >> 3, f2 = s2 & 7;
      const dr = Math.sign(r2 - r1);
      const df = Math.sign(f2 - f1);
      if (r1 !== r2 && f1 !== f2 && Math.abs(r2 - r1) !== Math.abs(f2 - f1)) continue;

      const idx = s1 * 64 + s2;
      let nr = r1 + dr, nf = f1 + df;
      let pastS2 = false;
      while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
        const cur = nr * 8 + nf;
        if (cur === s2) {
          pastS2 = true;
        } else if (!pastS2) {
          setBit(BETWEEN_LO, BETWEEN_HI, idx, cur);
        } else {
          setBit(RAYPASS_LO, RAYPASS_HI, idx, cur);
        }
        nr += dr;
        nf += df;
      }
    }
  }
})();

// Scratch return pair to avoid object allocations in hot loops
export let atkLoOut = 0;
export let atkHiOut = 0;

function rayAttackPos(dir: number, sq: number, occLo: number, occHi: number): void {
  const rLo = RAY_LO[dir][sq];
  const rHi = RAY_HI[dir][sq];
  const bLo = (rLo & occLo) >>> 0;
  if (bLo !== 0) {
    const bSq = ctz32(bLo);
    atkLoOut |= (rLo ^ RAY_LO[dir][bSq]) >>> 0;
    atkHiOut |= (rHi ^ RAY_HI[dir][bSq]) >>> 0;
    return;
  }
  const bHi = (rHi & occHi) >>> 0;
  if (bHi !== 0) {
    const bSq = 32 + ctz32(bHi);
    atkLoOut |= (rLo ^ RAY_LO[dir][bSq]) >>> 0;
    atkHiOut |= (rHi ^ RAY_HI[dir][bSq]) >>> 0;
    return;
  }
  atkLoOut |= rLo;
  atkHiOut |= rHi;
}

function rayAttackNeg(dir: number, sq: number, occLo: number, occHi: number): void {
  const rLo = RAY_LO[dir][sq];
  const rHi = RAY_HI[dir][sq];
  const bHi = (rHi & occHi) >>> 0;
  if (bHi !== 0) {
    const bSq = 32 + msb32(bHi);
    atkLoOut |= (rLo ^ RAY_LO[dir][bSq]) >>> 0;
    atkHiOut |= (rHi ^ RAY_HI[dir][bSq]) >>> 0;
    return;
  }
  const bLo = (rLo & occLo) >>> 0;
  if (bLo !== 0) {
    const bSq = msb32(bLo);
    atkLoOut |= (rLo ^ RAY_LO[dir][bSq]) >>> 0;
    atkHiOut |= (rHi ^ RAY_HI[dir][bSq]) >>> 0;
    return;
  }
  atkLoOut |= rLo;
  atkHiOut |= rHi;
}

export function computeRookAttacks(sq: number, occLo: number, occHi: number): void {
  atkLoOut = 0;
  atkHiOut = 0;
  rayAttackPos(0, sq, occLo, occHi);
  rayAttackNeg(1, sq, occLo, occHi);
  rayAttackPos(2, sq, occLo, occHi);
  rayAttackNeg(3, sq, occLo, occHi);
}

export function computeBishopAttacks(sq: number, occLo: number, occHi: number): void {
  atkLoOut = 0;
  atkHiOut = 0;
  rayAttackPos(4, sq, occLo, occHi);
  rayAttackPos(5, sq, occLo, occHi);
  rayAttackNeg(6, sq, occLo, occHi);
  rayAttackNeg(7, sq, occLo, occHi);
}

export function computeQueenAttacks(sq: number, occLo: number, occHi: number): void {
  atkLoOut = 0;
  atkHiOut = 0;
  rayAttackPos(0, sq, occLo, occHi);
  rayAttackNeg(1, sq, occLo, occHi);
  rayAttackPos(2, sq, occLo, occHi);
  rayAttackNeg(3, sq, occLo, occHi);
  rayAttackPos(4, sq, occLo, occHi);
  rayAttackPos(5, sq, occLo, occHi);
  rayAttackNeg(6, sq, occLo, occHi);
  rayAttackNeg(7, sq, occLo, occHi);
}

export function computePieceAttacks(piece: number, sq: number, occLo: number, occHi: number): void {
  const pt = piece >> 1;
  if (pt === PT_PAWN) {
    const c = piece & 1;
    atkLoOut = PAWN_ATK_LO[c][sq];
    atkHiOut = PAWN_ATK_HI[c][sq];
  } else if (pt === PT_KNIGHT) {
    atkLoOut = KNIGHT_ATK_LO[sq];
    atkHiOut = KNIGHT_ATK_HI[sq];
  } else if (pt === PT_BISHOP) {
    computeBishopAttacks(sq, occLo, occHi);
  } else if (pt === PT_ROOK) {
    computeRookAttacks(sq, occLo, occHi);
  } else if (pt === PT_QUEEN) {
    computeQueenAttacks(sq, occLo, occHi);
  } else if (pt === PT_KING) {
    atkLoOut = KING_ATK_LO[sq];
    atkHiOut = KING_ATK_HI[sq];
  } else {
    atkLoOut = 0;
    atkHiOut = 0;
  }
}

export function moveFrom(move: number): number {
  return move & 63;
}
export function moveTo(move: number): number {
  return (move >>> 6) & 63;
}
export function movePromo(move: number): number {
  return (move >>> 12) & 7;
}
export function moveFlags(move: number): number {
  return (move >>> 15) & 15;
}
export function encodeMove(from: number, to: number, promo = 0, flags = 0): number {
  return from | (to << 6) | (promo << 12) | (flags << 15);
}

export function sqToAlgebraic(sq: number): string {
  return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 3));
}

export function algebraicToSq(str: string): number {
  const f = str.charCodeAt(0) - 97;
  const r = str.charCodeAt(1) - 49;
  return (r << 3) | f;
}

export function moveToUci(move: number): string {
  if (move === 0) return '0000';
  const f = sqToAlgebraic(move & 63);
  const t = sqToAlgebraic((move >>> 6) & 63);
  const p = (move >>> 12) & 7;
  if (p === 0) return f + t;
  const pChars = ['', 'n', 'b', 'r', 'q'];
  return f + t + (pChars[p] || '');
}

const PROMO_CHAR_MAP: Record<string, number> = {
  n: PT_KNIGHT,
  b: PT_BISHOP,
  r: PT_ROOK,
  q: PT_QUEEN,
};

export interface BoardObserver {
  onReset(board: FastBoard): void;
  onMove(board: FastBoard, move: number, movedPiece: number, capturedPiece: number): void;
  onUnmove(): void;
  onNullMove(): void;
  onUnnullMove(): void;
}

export class FastBoard {
  public mailbox = new Uint8Array(64);
  public pieceLo = new Uint32Array(12);
  public pieceHi = new Uint32Array(12);
  public colorLo = new Uint32Array(2);
  public colorHi = new Uint32Array(2);
  public occLo = 0;
  public occHi = 0;

  public turn = WHITE;
  public castling = 15;
  public epSquare = -1;
  public halfmove = 0;
  public fullmove = 1;
  public kingSq = new Uint8Array([4, 60]);

  public hashLo = 0;
  public hashHi = 0;
  public pawnKey = 0;
  public nonPawnKey = 0;

  // Undo stack (8 ints per ply)
  private undoStack = new Int32Array(MAX_GAME_HISTORY * 8);
  private undoTop = 0;

  // Game/search Zobrist history for repetition detection
  public repHashLo = new Uint32Array(MAX_GAME_HISTORY);
  public repHashHi = new Uint32Array(MAX_GAME_HISTORY);
  public repLen = 0;

  // Pre-allocated move lists per ply for zero-GC search
  public moveLists = new Int32Array(MAX_PLY * MAX_MOVES_PER_PLY);
  public moveScores = new Int32Array(MAX_PLY * MAX_MOVES_PER_PLY);

  public observer: BoardObserver | null = null;

  constructor(fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') {
    this.setFen(fen);
  }

  public setFen(fen: string): void {
    this.mailbox.fill(EMPTY);
    this.pieceLo.fill(0);
    this.pieceHi.fill(0);
    this.colorLo.fill(0);
    this.colorHi.fill(0);
    this.occLo = 0;
    this.occHi = 0;
    this.hashLo = 0;
    this.hashHi = 0;
    this.pawnKey = 0;
    this.nonPawnKey = 0;
    this.undoTop = 0;
    this.repLen = 0;

    const parts = fen.trim().split(/\s+/);
    const rows = (parts[0] || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR').split('/');
    for (let fenR = 0; fenR < 8; fenR++) {
      const rank = 7 - fenR;
      const row = rows[fenR] || '';
      let file = 0;
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        const code = ch.charCodeAt(0);
        if (code >= 49 && code <= 56) {
          file += code - 48;
        } else {
          const piece = CHAR_TO_PIECE[ch];
          if (piece !== undefined && file < 8) {
            const sq = (rank << 3) | file;
            this.putPiece(piece, sq);
            if ((piece >> 1) === PT_KING) {
              this.kingSq[piece & 1] = sq;
            }
          }
          file++;
        }
      }
    }

    this.turn = parts[1] === 'b' ? BLACK : WHITE;
    if (this.turn === BLACK) {
      this.hashLo = (this.hashLo ^ ZOBRIST_SIDE_LO) >>> 0;
      this.hashHi = (this.hashHi ^ ZOBRIST_SIDE_HI) >>> 0;
    }

    const castleStr = parts[2] || '-';
    this.castling = 0;
    if (castleStr.includes('K')) this.castling |= CASTLE_WK;
    if (castleStr.includes('Q')) this.castling |= CASTLE_WQ;
    if (castleStr.includes('k')) this.castling |= CASTLE_BK;
    if (castleStr.includes('q')) this.castling |= CASTLE_BQ;
    this.hashLo = (this.hashLo ^ ZOBRIST_CASTLE_LO[this.castling]) >>> 0;
    this.hashHi = (this.hashHi ^ ZOBRIST_CASTLE_HI[this.castling]) >>> 0;

    const epStr = parts[3] || '-';
    if (epStr !== '-' && epStr.length === 2) {
      this.epSquare = algebraicToSq(epStr);
      this.hashLo = (this.hashLo ^ ZOBRIST_EP_LO[this.epSquare & 7]) >>> 0;
      this.hashHi = (this.hashHi ^ ZOBRIST_EP_HI[this.epSquare & 7]) >>> 0;
    } else {
      this.epSquare = -1;
    }

    this.halfmove = parts[4] ? Math.max(0, parseInt(parts[4], 10) || 0) : 0;
    this.fullmove = parts[5] ? Math.max(1, parseInt(parts[5], 10) || 1) : 1;

    this.repHashLo[0] = this.hashLo;
    this.repHashHi[0] = this.hashHi;
    this.repLen = 1;

    if (this.observer) this.observer.onReset(this);
  }

  public toFen(): string {
    let boardStr = '';
    for (let rank = 7; rank >= 0; rank--) {
      let emptyCount = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.mailbox[(rank << 3) | file];
        if (p === EMPTY) {
          emptyCount++;
        } else {
          if (emptyCount > 0) {
            boardStr += String(emptyCount);
            emptyCount = 0;
          }
          boardStr += PIECE_TO_CHAR[p];
        }
      }
      if (emptyCount > 0) boardStr += String(emptyCount);
      if (rank > 0) boardStr += '/';
    }

    let cStr = '';
    if (this.castling & CASTLE_WK) cStr += 'K';
    if (this.castling & CASTLE_WQ) cStr += 'Q';
    if (this.castling & CASTLE_BK) cStr += 'k';
    if (this.castling & CASTLE_BQ) cStr += 'q';
    if (!cStr) cStr = '-';

    const epStr = this.epSquare >= 0 ? sqToAlgebraic(this.epSquare) : '-';
    return `${boardStr} ${this.turn === WHITE ? 'w' : 'b'} ${cStr} ${epStr} ${this.halfmove} ${this.fullmove}`;
  }

  private putPiece(piece: number, sq: number): void {
    this.mailbox[sq] = piece;
    const c = piece & 1;
    if (sq < 32) {
      const bit = 1 << sq;
      this.pieceLo[piece] |= bit;
      this.colorLo[c] |= bit;
      this.occLo |= bit;
    } else {
      const bit = 1 << (sq - 32);
      this.pieceHi[piece] |= bit;
      this.colorHi[c] |= bit;
      this.occHi |= bit;
    }
    const zIdx = piece * 64 + sq;
    this.hashLo = (this.hashLo ^ ZOBRIST_PIECE_LO[zIdx]) >>> 0;
    this.hashHi = (this.hashHi ^ ZOBRIST_PIECE_HI[zIdx]) >>> 0;
    if ((piece >> 1) === PT_PAWN) {
      this.pawnKey = (this.pawnKey ^ ZOBRIST_PIECE_LO[zIdx]) >>> 0;
    } else if ((piece >> 1) !== PT_KING) {
      this.nonPawnKey = (this.nonPawnKey ^ ZOBRIST_PIECE_LO[zIdx]) >>> 0;
    }
  }

  private removePiece(piece: number, sq: number): void {
    this.mailbox[sq] = EMPTY;
    const c = piece & 1;
    if (sq < 32) {
      const mask = ~(1 << sq);
      this.pieceLo[piece] &= mask;
      this.colorLo[c] &= mask;
      this.occLo &= mask;
    } else {
      const mask = ~(1 << (sq - 32));
      this.pieceHi[piece] &= mask;
      this.colorHi[c] &= mask;
      this.occHi &= mask;
    }
    const zIdx = piece * 64 + sq;
    this.hashLo = (this.hashLo ^ ZOBRIST_PIECE_LO[zIdx]) >>> 0;
    this.hashHi = (this.hashHi ^ ZOBRIST_PIECE_HI[zIdx]) >>> 0;
    if ((piece >> 1) === PT_PAWN) {
      this.pawnKey = (this.pawnKey ^ ZOBRIST_PIECE_LO[zIdx]) >>> 0;
    } else if ((piece >> 1) !== PT_KING) {
      this.nonPawnKey = (this.nonPawnKey ^ ZOBRIST_PIECE_LO[zIdx]) >>> 0;
    }
  }

  private movePiece(piece: number, from: number, to: number): void {
    this.mailbox[from] = EMPTY;
    this.mailbox[to] = piece;
    const c = piece & 1;
    if (from < 32) {
      const mask = ~(1 << from);
      this.pieceLo[piece] &= mask;
      this.colorLo[c] &= mask;
      this.occLo &= mask;
    } else {
      const mask = ~(1 << (from - 32));
      this.pieceHi[piece] &= mask;
      this.colorHi[c] &= mask;
      this.occHi &= mask;
    }
    if (to < 32) {
      const bit = 1 << to;
      this.pieceLo[piece] |= bit;
      this.colorLo[c] |= bit;
      this.occLo |= bit;
    } else {
      const bit = 1 << (to - 32);
      this.pieceHi[piece] |= bit;
      this.colorHi[c] |= bit;
      this.occHi |= bit;
    }
    const zFrom = piece * 64 + from;
    const zTo = piece * 64 + to;
    this.hashLo = (this.hashLo ^ ZOBRIST_PIECE_LO[zFrom] ^ ZOBRIST_PIECE_LO[zTo]) >>> 0;
    this.hashHi = (this.hashHi ^ ZOBRIST_PIECE_HI[zFrom] ^ ZOBRIST_PIECE_HI[zTo]) >>> 0;
    if ((piece >> 1) === PT_PAWN) {
      this.pawnKey = (this.pawnKey ^ ZOBRIST_PIECE_LO[zFrom] ^ ZOBRIST_PIECE_LO[zTo]) >>> 0;
    } else if ((piece >> 1) !== PT_KING) {
      this.nonPawnKey = (this.nonPawnKey ^ ZOBRIST_PIECE_LO[zFrom] ^ ZOBRIST_PIECE_LO[zTo]) >>> 0;
    }
  }

  public isSquareAttacked(sq: number, byColor: number): boolean {
    const pawnIdx = byColor;
    // Pawns: check if enemy pawn stands on squares that attack `sq` (which is PAWN_ATK[oppColor][sq])
    const oppColor = byColor ^ 1;
    if (
      (PAWN_ATK_LO[oppColor][sq] & this.pieceLo[pawnIdx]) !== 0 ||
      (PAWN_ATK_HI[oppColor][sq] & this.pieceHi[pawnIdx]) !== 0
    ) {
      return true;
    }

    const knightIdx = (PT_KNIGHT << 1) | byColor;
    if (
      (KNIGHT_ATK_LO[sq] & this.pieceLo[knightIdx]) !== 0 ||
      (KNIGHT_ATK_HI[sq] & this.pieceHi[knightIdx]) !== 0
    ) {
      return true;
    }

    const kingIdx = (PT_KING << 1) | byColor;
    if (
      (KING_ATK_LO[sq] & this.pieceLo[kingIdx]) !== 0 ||
      (KING_ATK_HI[sq] & this.pieceHi[kingIdx]) !== 0
    ) {
      return true;
    }

    const rookQ_Lo = this.pieceLo[(PT_ROOK << 1) | byColor] | this.pieceLo[(PT_QUEEN << 1) | byColor];
    const rookQ_Hi = this.pieceHi[(PT_ROOK << 1) | byColor] | this.pieceHi[(PT_QUEEN << 1) | byColor];
    if (rookQ_Lo !== 0 || rookQ_Hi !== 0) {
      computeRookAttacks(sq, this.occLo, this.occHi);
      if ((atkLoOut & rookQ_Lo) !== 0 || (atkHiOut & rookQ_Hi) !== 0) return true;
    }

    const bishQ_Lo = this.pieceLo[(PT_BISHOP << 1) | byColor] | this.pieceLo[(PT_QUEEN << 1) | byColor];
    const bishQ_Hi = this.pieceHi[(PT_BISHOP << 1) | byColor] | this.pieceHi[(PT_QUEEN << 1) | byColor];
    if (bishQ_Lo !== 0 || bishQ_Hi !== 0) {
      computeBishopAttacks(sq, this.occLo, this.occHi);
      if ((atkLoOut & bishQ_Lo) !== 0 || (atkHiOut & bishQ_Hi) !== 0) return true;
    }

    return false;
  }

  public inCheck(color = this.turn): boolean {
    return this.isSquareAttacked(this.kingSq[color], color ^ 1);
  }

  public hasNonPawnMaterial(color = this.turn): boolean {
    return (
      (this.pieceLo[(PT_KNIGHT << 1) | color] |
        this.pieceHi[(PT_KNIGHT << 1) | color] |
        this.pieceLo[(PT_BISHOP << 1) | color] |
        this.pieceHi[(PT_BISHOP << 1) | color] |
        this.pieceLo[(PT_ROOK << 1) | color] |
        this.pieceHi[(PT_ROOK << 1) | color] |
        this.pieceLo[(PT_QUEEN << 1) | color] |
        this.pieceHi[(PT_QUEEN << 1) | color]) !== 0
    );
  }

  public pieceCount(): number {
    return popcount32(this.occLo) + popcount32(this.occHi);
  }

  public makeMove(move: number): boolean {
    const from = move & 63;
    const to = (move >>> 6) & 63;
    const promo = (move >>> 12) & 7;
    const flags = (move >>> 15) & 15;
    const movedPiece = this.mailbox[from];
    const us = this.turn;
    const them = us ^ 1;

    let capturedPiece = EMPTY;
    if (flags === FLAG_EP) {
      const capSq = us === WHITE ? to - 8 : to + 8;
      capturedPiece = this.mailbox[capSq];
    } else if (this.mailbox[to] !== EMPTY) {
      capturedPiece = this.mailbox[to];
    }

    if (this.observer) {
      this.observer.onMove(this, move, movedPiece, capturedPiece);
    }

    // Save undo state
    const base = this.undoTop;
    this.undoStack[base] = move;
    this.undoStack[base + 1] = capturedPiece;
    this.undoStack[base + 2] = this.castling;
    this.undoStack[base + 3] = this.epSquare;
    this.undoStack[base + 4] = this.halfmove;
    this.undoStack[base + 5] = this.hashLo;
    this.undoStack[base + 6] = this.hashHi;
    this.undoStack[base + 7] = movedPiece;
    this.undoTop += 8;

    // Clear old ep hash
    if (this.epSquare >= 0) {
      this.hashLo = (this.hashLo ^ ZOBRIST_EP_LO[this.epSquare & 7]) >>> 0;
      this.hashHi = (this.hashHi ^ ZOBRIST_EP_HI[this.epSquare & 7]) >>> 0;
      this.epSquare = -1;
    }

    // Halfmove update
    if ((movedPiece >> 1) === PT_PAWN || capturedPiece !== EMPTY) {
      this.halfmove = 0;
    } else {
      this.halfmove++;
    }

    // Remove captured piece
    if (flags === FLAG_EP) {
      const capSq = us === WHITE ? to - 8 : to + 8;
      this.removePiece(capturedPiece, capSq);
    } else if (capturedPiece !== EMPTY) {
      this.removePiece(capturedPiece, to);
    }

    // Move piece (or promote)
    if (promo > 0) {
      this.removePiece(movedPiece, from);
      this.putPiece((promo << 1) | us, to);
    } else {
      this.movePiece(movedPiece, from, to);
      if ((movedPiece >> 1) === PT_KING) {
        this.kingSq[us] = to;
      }
    }

    // Special flags: double push & castling
    if (flags === FLAG_DOUBLE_PUSH) {
      const epSq = us === WHITE ? to - 8 : to + 8;
      // Only set EP hash if enemy pawn can capture it (standard Polyglot/Zobrist convention or always—be consistent!)
      this.epSquare = epSq;
      this.hashLo = (this.hashLo ^ ZOBRIST_EP_LO[epSq & 7]) >>> 0;
      this.hashHi = (this.hashHi ^ ZOBRIST_EP_HI[epSq & 7]) >>> 0;
    } else if (flags === FLAG_KING_CASTLE) {
      const rFrom = us === WHITE ? 7 : 63;
      const rTo = us === WHITE ? 5 : 61;
      this.movePiece((PT_ROOK << 1) | us, rFrom, rTo);
    } else if (flags === FLAG_QUEEN_CASTLE) {
      const rFrom = us === WHITE ? 0 : 56;
      const rTo = us === WHITE ? 3 : 59;
      this.movePiece((PT_ROOK << 1) | us, rFrom, rTo);
    }

    // Update castling rights
    const oldCast = this.castling;
    const newCast = oldCast & CASTLE_MASK[from] & CASTLE_MASK[to];
    if (newCast !== oldCast) {
      this.hashLo = (this.hashLo ^ ZOBRIST_CASTLE_LO[oldCast] ^ ZOBRIST_CASTLE_LO[newCast]) >>> 0;
      this.hashHi = (this.hashHi ^ ZOBRIST_CASTLE_HI[oldCast] ^ ZOBRIST_CASTLE_HI[newCast]) >>> 0;
      this.castling = newCast;
    }

    // Toggle turn
    this.turn = them;
    this.hashLo = (this.hashLo ^ ZOBRIST_SIDE_LO) >>> 0;
    this.hashHi = (this.hashHi ^ ZOBRIST_SIDE_HI) >>> 0;
    if (us === BLACK) this.fullmove++;

    // Legality check: our king must not be in check
    if (this.isSquareAttacked(this.kingSq[us], them)) {
      this.unmakeMove(false);
      return false;
    }

    // Record history hash
    if (this.repLen < MAX_GAME_HISTORY) {
      this.repHashLo[this.repLen] = this.hashLo;
      this.repHashHi[this.repLen] = this.hashHi;
      this.repLen++;
    }
    return true;
  }

  public unmakeMove(popRep = true): void {
    if (this.observer) this.observer.onUnmove();

    if (popRep && this.repLen > 0) this.repLen--;

    this.undoTop -= 8;
    const base = this.undoTop;
    const move = this.undoStack[base];
    const capturedPiece = this.undoStack[base + 1];
    const oldCastling = this.undoStack[base + 2];
    const oldEp = this.undoStack[base + 3];
    const oldHalfmove = this.undoStack[base + 4];
    const oldHashLo = this.undoStack[base + 5] >>> 0;
    const oldHashHi = this.undoStack[base + 6] >>> 0;
    const movedPiece = this.undoStack[base + 7];

    const from = move & 63;
    const to = (move >>> 6) & 63;
    const promo = (move >>> 12) & 7;
    const flags = (move >>> 15) & 15;

    const them = this.turn;
    const us = them ^ 1;
    this.turn = us;
    if (us === BLACK) this.fullmove--;

    if (flags === FLAG_KING_CASTLE) {
      const rFrom = us === WHITE ? 7 : 63;
      const rTo = us === WHITE ? 5 : 61;
      this.movePiece((PT_ROOK << 1) | us, rTo, rFrom);
    } else if (flags === FLAG_QUEEN_CASTLE) {
      const rFrom = us === WHITE ? 0 : 56;
      const rTo = us === WHITE ? 3 : 59;
      this.movePiece((PT_ROOK << 1) | us, rTo, rFrom);
    }

    if (promo > 0) {
      this.removePiece((promo << 1) | us, to);
      this.putPiece(movedPiece, from);
    } else {
      this.movePiece(movedPiece, to, from);
      if ((movedPiece >> 1) === PT_KING) {
        this.kingSq[us] = from;
      }
    }

    if (flags === FLAG_EP) {
      const capSq = us === WHITE ? to - 8 : to + 8;
      this.putPiece(capturedPiece, capSq);
    } else if (capturedPiece !== EMPTY) {
      this.putPiece(capturedPiece, to);
    }

    this.castling = oldCastling;
    this.epSquare = oldEp;
    this.halfmove = oldHalfmove;
    this.hashLo = oldHashLo;
    this.hashHi = oldHashHi;
  }

  public makeNullMove(): void {
    if (this.observer) this.observer.onNullMove();
    const base = this.undoTop;
    this.undoStack[base] = 0;
    this.undoStack[base + 1] = EMPTY;
    this.undoStack[base + 2] = this.castling;
    this.undoStack[base + 3] = this.epSquare;
    this.undoStack[base + 4] = this.halfmove;
    this.undoStack[base + 5] = this.hashLo;
    this.undoStack[base + 6] = this.hashHi;
    this.undoStack[base + 7] = EMPTY;
    this.undoTop += 8;

    if (this.epSquare >= 0) {
      this.hashLo = (this.hashLo ^ ZOBRIST_EP_LO[this.epSquare & 7]) >>> 0;
      this.hashHi = (this.hashHi ^ ZOBRIST_EP_HI[this.epSquare & 7]) >>> 0;
      this.epSquare = -1;
    }

    this.turn ^= 1;
    this.halfmove++;
    this.hashLo = (this.hashLo ^ ZOBRIST_SIDE_LO) >>> 0;
    this.hashHi = (this.hashHi ^ ZOBRIST_SIDE_HI) >>> 0;

    if (this.repLen < MAX_GAME_HISTORY) {
      this.repHashLo[this.repLen] = this.hashLo;
      this.repHashHi[this.repLen] = this.hashHi;
      this.repLen++;
    }
  }

  public unmakeNullMove(): void {
    if (this.observer) this.observer.onUnnullMove();
    if (this.repLen > 0) this.repLen--;
    this.undoTop -= 8;
    const base = this.undoTop;
    this.epSquare = this.undoStack[base + 3];
    this.halfmove = this.undoStack[base + 4];
    this.hashLo = this.undoStack[base + 5] >>> 0;
    this.hashHi = this.undoStack[base + 6] >>> 0;
    this.turn ^= 1;
  }

  /**
   * Repetition & Draw Detection:
   * Inside search (`ply > 0`), any repeat within the irreversible halfmove window counts as draw (2-fold).
   * At root or game state, checks 3-fold repetition & 50-move rule & insufficient material.
   */
  public isRepetition(ply: number): boolean {
    if (this.halfmove < 4 || this.repLen < 3) return false;
    const lookback = Math.min(this.halfmove, this.repLen - 1);
    const curLo = this.hashLo;
    const curHi = this.hashHi;
    const startIdx = this.repLen - 1;
    let hits = 0;

    for (let dist = 2; dist <= lookback; dist += 2) {
      const idx = startIdx - dist;
      if (this.repHashLo[idx] === curLo && this.repHashHi[idx] === curHi) {
        if (ply > 0) return true; // 2-fold inside search
        hits++;
        if (hits >= 2) return true; // 3-fold at root
      }
    }
    return false;
  }

  public isInsufficientMaterial(): boolean {
    // Any pawn, rook, or queen on board -> sufficient
    if (
      (this.pieceLo[0] | this.pieceHi[0] | this.pieceLo[1] | this.pieceHi[1] |
       this.pieceLo[6] | this.pieceHi[6] | this.pieceLo[7] | this.pieceHi[7] |
       this.pieceLo[8] | this.pieceHi[8] | this.pieceLo[9] | this.pieceHi[9]) !== 0
    ) {
      return false;
    }
    const wMinors = popcount32(this.pieceLo[2] | this.pieceLo[4]) + popcount32(this.pieceHi[2] | this.pieceHi[4]);
    const bMinors = popcount32(this.pieceLo[3] | this.pieceLo[5]) + popcount32(this.pieceHi[3] | this.pieceHi[5]);
    return wMinors <= 1 && bMinors <= 1;
  }

  public isDraw(ply: number): boolean {
    if (this.halfmove >= 100) return true;
    if (this.isRepetition(ply)) return true;
    if (this.isInsufficientMaterial()) return true;
    return false;
  }

  /**
   * Generate pseudo-legal moves into pre-allocated `this.moveLists[ply * MAX_MOVES_PER_PLY ...]`.
   * Returns total number of pseudo-legal moves generated at `ply`.
   */
  public generatePseudoLegal(ply: number, capturesOnly = false): number {
    const base = ply * MAX_MOVES_PER_PLY;
    let count = 0;
    const us = this.turn;
    const them = us ^ 1;
    const theirLo = this.colorLo[them];
    const theirHi = this.colorHi[them];
    const emptyLo = ~this.occLo;
    const emptyHi = ~this.occHi;
    const notUsLo = ~this.colorLo[us];
    const notUsHi = ~this.colorHi[us];

    const targetLo = capturesOnly ? theirLo : notUsLo;
    const targetHi = capturesOnly ? theirHi : notUsHi;

    // 1. Pawns
    const pawnPiece = (PT_PAWN << 1) | us;
    let pLo = this.pieceLo[pawnPiece];
    let pHi = this.pieceHi[pawnPiece];
    const up = us === WHITE ? 8 : -8;
    const promoRank = us === WHITE ? 6 : 1;
    const startRank = us === WHITE ? 1 : 6;

    const pushPawnBit = (sq: number) => {
      const rank = sq >> 3;
      const to = sq + up;
      const isEmptyTo = this.mailbox[to] === EMPTY;
      if (rank === promoRank) {
        if (isEmptyTo) {
          this.moveLists[base + count++] = encodeMove(sq, to, PT_QUEEN, FLAG_PROMO);
          if (!capturesOnly) {
            this.moveLists[base + count++] = encodeMove(sq, to, PT_ROOK, FLAG_PROMO);
            this.moveLists[base + count++] = encodeMove(sq, to, PT_BISHOP, FLAG_PROMO);
            this.moveLists[base + count++] = encodeMove(sq, to, PT_KNIGHT, FLAG_PROMO);
          }
        }
      } else if (!capturesOnly && isEmptyTo) {
        this.moveLists[base + count++] = encodeMove(sq, to, 0, FLAG_QUIET);
        if (rank === startRank) {
          const to2 = to + up;
          if (this.mailbox[to2] === EMPTY) {
            this.moveLists[base + count++] = encodeMove(sq, to2, 0, FLAG_DOUBLE_PUSH);
          }
        }
      }

      // Pawn captures (and en passant)
      let cLo = PAWN_ATK_LO[us][sq] & theirLo;
      let cHi = PAWN_ATK_HI[us][sq] & theirHi;
      while (cLo !== 0) {
        const capSq = ctz32(cLo);
        cLo &= cLo - 1;
        if (rank === promoRank) {
          this.moveLists[base + count++] = encodeMove(sq, capSq, PT_QUEEN, FLAG_PROMO | FLAG_CAPTURE);
          this.moveLists[base + count++] = encodeMove(sq, capSq, PT_ROOK, FLAG_PROMO | FLAG_CAPTURE);
          this.moveLists[base + count++] = encodeMove(sq, capSq, PT_BISHOP, FLAG_PROMO | FLAG_CAPTURE);
          this.moveLists[base + count++] = encodeMove(sq, capSq, PT_KNIGHT, FLAG_PROMO | FLAG_CAPTURE);
        } else {
          this.moveLists[base + count++] = encodeMove(sq, capSq, 0, FLAG_CAPTURE);
        }
      }
      while (cHi !== 0) {
        const capSq = 32 + ctz32(cHi);
        cHi &= cHi - 1;
        if (rank === promoRank) {
          this.moveLists[base + count++] = encodeMove(sq, capSq, PT_QUEEN, FLAG_PROMO | FLAG_CAPTURE);
          this.moveLists[base + count++] = encodeMove(sq, capSq, PT_ROOK, FLAG_PROMO | FLAG_CAPTURE);
          this.moveLists[base + count++] = encodeMove(sq, capSq, PT_BISHOP, FLAG_PROMO | FLAG_CAPTURE);
          this.moveLists[base + count++] = encodeMove(sq, capSq, PT_KNIGHT, FLAG_PROMO | FLAG_CAPTURE);
        } else {
          this.moveLists[base + count++] = encodeMove(sq, capSq, 0, FLAG_CAPTURE);
        }
      }

      if (this.epSquare >= 0) {
        const epSq = this.epSquare;
        const epHit = epSq < 32 ? (PAWN_ATK_LO[us][sq] & (1 << epSq)) : (PAWN_ATK_HI[us][sq] & (1 << (epSq - 32)));
        if (epHit !== 0) {
          this.moveLists[base + count++] = encodeMove(sq, epSq, 0, FLAG_EP);
        }
      }
    };

    while (pLo !== 0) {
      const sq = ctz32(pLo);
      pLo &= pLo - 1;
      pushPawnBit(sq);
    }
    while (pHi !== 0) {
      const sq = 32 + ctz32(pHi);
      pHi &= pHi - 1;
      pushPawnBit(sq);
    }

    // 2. Knights
    const nPiece = (PT_KNIGHT << 1) | us;
    const emitTargets = (sq: number, aLo: number, aHi: number) => {
      let tLo = aLo & targetLo;
      let tHi = aHi & targetHi;
      while (tLo !== 0) {
        const to = ctz32(tLo);
        tLo &= tLo - 1;
        const isCap = (theirLo & (1 << to)) !== 0 ? FLAG_CAPTURE : FLAG_QUIET;
        this.moveLists[base + count++] = encodeMove(sq, to, 0, isCap);
      }
      while (tHi !== 0) {
        const to = 32 + ctz32(tHi);
        tHi &= tHi - 1;
        const isCap = (theirHi & (1 << (to - 32))) !== 0 ? FLAG_CAPTURE : FLAG_QUIET;
        this.moveLists[base + count++] = encodeMove(sq, to, 0, isCap);
      }
    };

    let lo = this.pieceLo[nPiece];
    let hi = this.pieceHi[nPiece];
    while (lo !== 0) {
      const sq = ctz32(lo);
      lo &= lo - 1;
      emitTargets(sq, KNIGHT_ATK_LO[sq], KNIGHT_ATK_HI[sq]);
    }
    while (hi !== 0) {
      const sq = 32 + ctz32(hi);
      hi &= hi - 1;
      emitTargets(sq, KNIGHT_ATK_LO[sq], KNIGHT_ATK_HI[sq]);
    }

    // 3. Bishops
    const bPiece = (PT_BISHOP << 1) | us;
    lo = this.pieceLo[bPiece];
    hi = this.pieceHi[bPiece];
    while (lo !== 0) {
      const sq = ctz32(lo);
      lo &= lo - 1;
      computeBishopAttacks(sq, this.occLo, this.occHi);
      emitTargets(sq, atkLoOut, atkHiOut);
    }
    while (hi !== 0) {
      const sq = 32 + ctz32(hi);
      hi &= hi - 1;
      computeBishopAttacks(sq, this.occLo, this.occHi);
      emitTargets(sq, atkLoOut, atkHiOut);
    }

    // 4. Rooks
    const rPiece = (PT_ROOK << 1) | us;
    lo = this.pieceLo[rPiece];
    hi = this.pieceHi[rPiece];
    while (lo !== 0) {
      const sq = ctz32(lo);
      lo &= lo - 1;
      computeRookAttacks(sq, this.occLo, this.occHi);
      emitTargets(sq, atkLoOut, atkHiOut);
    }
    while (hi !== 0) {
      const sq = 32 + ctz32(hi);
      hi &= hi - 1;
      computeRookAttacks(sq, this.occLo, this.occHi);
      emitTargets(sq, atkLoOut, atkHiOut);
    }

    // 5. Queens
    const qPiece = (PT_QUEEN << 1) | us;
    lo = this.pieceLo[qPiece];
    hi = this.pieceHi[qPiece];
    while (lo !== 0) {
      const sq = ctz32(lo);
      lo &= lo - 1;
      computeQueenAttacks(sq, this.occLo, this.occHi);
      emitTargets(sq, atkLoOut, atkHiOut);
    }
    while (hi !== 0) {
      const sq = 32 + ctz32(hi);
      hi &= hi - 1;
      computeQueenAttacks(sq, this.occLo, this.occHi);
      emitTargets(sq, atkLoOut, atkHiOut);
    }

    // 6. King + Castling
    const kSq = this.kingSq[us];
    emitTargets(kSq, KING_ATK_LO[kSq], KING_ATK_HI[kSq]);

    if (!capturesOnly) {
      if (us === WHITE && kSq === 4) {
        if ((this.castling & CASTLE_WK) !== 0 && (emptyLo & ((1 << 5) | (1 << 6))) === ((1 << 5) | (1 << 6))) {
          if (!this.isSquareAttacked(4, BLACK) && !this.isSquareAttacked(5, BLACK) && !this.isSquareAttacked(6, BLACK)) {
            this.moveLists[base + count++] = encodeMove(4, 6, 0, FLAG_KING_CASTLE);
          }
        }
        if ((this.castling & CASTLE_WQ) !== 0 && (emptyLo & ((1 << 1) | (1 << 2) | (1 << 3))) === ((1 << 1) | (1 << 2) | (1 << 3))) {
          if (!this.isSquareAttacked(4, BLACK) && !this.isSquareAttacked(3, BLACK) && !this.isSquareAttacked(2, BLACK)) {
            this.moveLists[base + count++] = encodeMove(4, 2, 0, FLAG_QUEEN_CASTLE);
          }
        }
      } else if (us === BLACK && kSq === 60) {
        if ((this.castling & CASTLE_BK) !== 0 && (emptyHi & ((1 << 29) | (1 << 30))) === ((1 << 29) | (1 << 30))) {
          if (!this.isSquareAttacked(60, WHITE) && !this.isSquareAttacked(61, WHITE) && !this.isSquareAttacked(62, WHITE)) {
            this.moveLists[base + count++] = encodeMove(60, 62, 0, FLAG_KING_CASTLE);
          }
        }
        if ((this.castling & CASTLE_BQ) !== 0 && (emptyHi & ((1 << 25) | (1 << 26) | (1 << 27))) === ((1 << 25) | (1 << 26) | (1 << 27))) {
          if (!this.isSquareAttacked(60, WHITE) && !this.isSquareAttacked(59, WHITE) && !this.isSquareAttacked(58, WHITE)) {
            this.moveLists[base + count++] = encodeMove(60, 58, 0, FLAG_QUEEN_CASTLE);
          }
        }
      }
    }

    return count;
  }

  public getLegalMoves(): number[] {
    const count = this.generatePseudoLegal(0, false);
    const legal: number[] = [];
    for (let i = 0; i < count; i++) {
      const m = this.moveLists[i];
      if (this.makeMove(m)) {
        legal.push(m);
        this.unmakeMove();
      }
    }
    return legal;
  }

  public applyUciMove(uci: string): boolean {
    if (uci.length < 4) return false;
    const from = algebraicToSq(uci.slice(0, 2));
    const to = algebraicToSq(uci.slice(2, 4));
    const promo = uci.length > 4 ? (PROMO_CHAR_MAP[uci[4].toLowerCase()] || 0) : 0;

    const count = this.generatePseudoLegal(0, false);
    for (let i = 0; i < count; i++) {
      const m = this.moveLists[i];
      if ((m & 63) === from && ((m >>> 6) & 63) === to && ((m >>> 12) & 7) === promo) {
        if (this.makeMove(m)) return true;
      }
    }
    return false;
  }

  /**
   * True Static Exchange Evaluation (SEE):
   * Simulates the full iterative capture-recapture sequence on `to` using
   * least-valuable attackers and X-ray slider discovery.
   * Returns net centipawn swap score relative to moving side.
   */
  public staticExchangeEvaluation(move: number): number {
    const from = move & 63;
    const to = (move >>> 6) & 63;
    const promo = (move >>> 12) & 7;
    const flags = (move >>> 15) & 15;

    const movedPiece = this.mailbox[from];
    if (movedPiece === EMPTY) return 0;

    let capPiece = this.mailbox[to];
    let gain = 0;
    if (flags === FLAG_EP) {
      gain = SEE_PIECE_VALUES[PT_PAWN];
    } else if (capPiece !== EMPTY) {
      gain = SEE_PIECE_VALUES[capPiece >> 1];
    }
    if (promo > 0) {
      gain += SEE_PIECE_VALUES[promo] - SEE_PIECE_VALUES[PT_PAWN];
    }

    // Immediate cutoff check: if initial victim is worth less? No, only skip if no capture/promo
    if (gain === 0 && flags !== FLAG_EP && promo === 0) return 0;

    let attackerPt = promo > 0 ? promo : (movedPiece >> 1);
    let nextVictimVal = SEE_PIECE_VALUES[attackerPt];

    // Copy occupancy and remove initial `from` piece (plus EP captured pawn)
    let occLo = this.occLo;
    let occHi = this.occHi;
    if (from < 32) occLo ^= 1 << from;
    else occHi ^= 1 << (from - 32);

    if (flags === FLAG_EP) {
      const epCapSq = this.turn === WHITE ? to - 8 : to + 8;
      if (epCapSq < 32) occLo ^= 1 << epCapSq;
      else occHi ^= 1 << (epCapSq - 32);
    }

    // Build swap stack (max 32 captures)
    const swap = new Int32Array(32);
    let d = 0;
    swap[0] = gain;

    let stm = this.turn ^ 1;
    // Compute initial all-attackers to `to`
    const pawnsW_Lo = this.pieceLo[0], pawnsW_Hi = this.pieceHi[0];
    const pawnsB_Lo = this.pieceLo[1], pawnsB_Hi = this.pieceHi[1];
    const knightsLo = this.pieceLo[2] | this.pieceLo[3], knightsHi = this.pieceHi[2] | this.pieceHi[3];
    const bishopsLo = this.pieceLo[4] | this.pieceLo[5], bishopsHi = this.pieceHi[4] | this.pieceHi[5];
    const rooksLo = this.pieceLo[6] | this.pieceLo[7], rooksHi = this.pieceHi[6] | this.pieceHi[7];
    const queensLo = this.pieceLo[8] | this.pieceLo[9], queensHi = this.pieceHi[8] | this.pieceHi[9];
    const kingsLo = this.pieceLo[10] | this.pieceLo[11], kingsHi = this.pieceHi[10] | this.pieceHi[11];
    const diagSlidersLo = bishopsLo | queensLo, diagSlidersHi = bishopsHi | queensHi;
    const orthoSlidersLo = rooksLo | queensLo, orthoSlidersHi = rooksHi | queensHi;

    let attackersLo =
      (PAWN_ATK_LO[BLACK][to] & pawnsW_Lo) |
      (PAWN_ATK_LO[WHITE][to] & pawnsB_Lo) |
      (KNIGHT_ATK_LO[to] & knightsLo) |
      (KING_ATK_LO[to] & kingsLo);
    let attackersHi =
      (PAWN_ATK_HI[BLACK][to] & pawnsW_Hi) |
      (PAWN_ATK_HI[WHITE][to] & pawnsB_Hi) |
      (KNIGHT_ATK_HI[to] & knightsHi) |
      (KING_ATK_HI[to] & kingsHi);

    computeBishopAttacks(to, occLo, occHi);
    attackersLo |= atkLoOut & diagSlidersLo;
    attackersHi |= atkHiOut & diagSlidersHi;
    computeRookAttacks(to, occLo, occHi);
    attackersLo |= atkLoOut & orthoSlidersLo;
    attackersHi |= atkHiOut & orthoSlidersHi;

    attackersLo &= occLo;
    attackersHi &= occHi;

    while (d < 31) {
      const stmLo = attackersLo & this.colorLo[stm];
      const stmHi = attackersHi & this.colorHi[stm];
      if (stmLo === 0 && stmHi === 0) break;

      // Pick least-valuable attacker for `stm`
      let pickedSq = -1;
      let pickedPt = PT_KING;

      for (let pt = PT_PAWN; pt <= PT_KING; pt++) {
        const pIdx = (pt << 1) | stm;
        const hitLo = stmLo & this.pieceLo[pIdx];
        if (hitLo !== 0) {
          pickedSq = ctz32(hitLo);
          pickedPt = pt;
          break;
        }
        const hitHi = stmHi & this.pieceHi[pIdx];
        if (hitHi !== 0) {
          pickedSq = 32 + ctz32(hitHi);
          pickedPt = pt;
          break;
        }
      }

      if (pickedSq < 0) break;

      d++;
      swap[d] = nextVictimVal - swap[d - 1];
      if (Math.max(-swap[d - 1], swap[d]) < 0 && pickedPt !== PT_KING) {
        // Cutoff still valid only after resolving negamax, keep going
      }

      // Remove pickedSq from occ & attackers
      if (pickedSq < 32) {
        const mask = ~(1 << pickedSq);
        occLo &= mask;
        attackersLo &= mask;
      } else {
        const mask = ~(1 << (pickedSq - 32));
        occHi &= mask;
        attackersHi &= mask;
      }

      // X-ray discovery when pawn, bishop, rook, or queen moves
      if (pickedPt === PT_PAWN || pickedPt === PT_BISHOP || pickedPt === PT_QUEEN) {
        computeBishopAttacks(to, occLo, occHi);
        attackersLo |= atkLoOut & diagSlidersLo & occLo;
        attackersHi |= atkHiOut & diagSlidersHi & occHi;
      }
      if (pickedPt === PT_ROOK || pickedPt === PT_QUEEN) {
        computeRookAttacks(to, occLo, occHi);
        attackersLo |= atkLoOut & orthoSlidersLo & occLo;
        attackersHi |= atkHiOut & orthoSlidersHi & occHi;
      }

      nextVictimVal = SEE_PIECE_VALUES[pickedPt];
      // Promotion on capture
      if (pickedPt === PT_PAWN && ((to >> 3) === 0 || (to >> 3) === 7)) {
        swap[d] += SEE_PIECE_VALUES[PT_QUEEN] - SEE_PIECE_VALUES[PT_PAWN];
        nextVictimVal = SEE_PIECE_VALUES[PT_QUEEN];
      }
      stm ^= 1;
    }

    // Negamax propagation back down the swap chain
    while (d > 0) {
      swap[d - 1] = -Math.max(-swap[d - 1], swap[d]);
      d--;
    }
    return swap[0];
  }
}
