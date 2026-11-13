/**
 * Berserker Chess960 (Fischer Random Chess) Engine Module
 * 
 * Implements:
 * - D.V. Schwalbe & Reinhard Scharnagl 0-959 SP indexing algorithm.
 * - Standard and Shredder FEN generation & normalization.
 * - Official FRC / Chess960 castling rules:
 *   - King and Rook starting on rank 1 (White) or rank 8 (Black).
 *   - Kingside castling (O-O): King lands on g1/g8, Rook lands on f1/f8.
 *   - Queenside castling (O-O-O): King lands on c1/c8, Rook lands on d1/d8.
 *   - Transit & destination square clearance (ignoring current king/castling rook positions).
 *   - King check immunity across transit path.
 * - UCI Chess960 move translation:
 *   - Supports both King-to-Rook UCI notation (e.g. e1h1, e1a1) and target square notation (e1g1, e1c1).
 */

import { Chess } from 'chess.js';

export interface Chess960CastlingConfig {
  whiteKingFile: number;
  whiteQueenRookFile: number;
  whiteKingRookFile: number;
  blackKingFile: number;
  blackQueenRookFile: number;
  blackKingRookFile: number;
}

export interface Chess960PositionInfo {
  spIndex: number;
  backrank: string;
  fen: string;
  shredderFen: string;
  castlingConfig: Chess960CastlingConfig;
}

const KNIGHT_PAIRS: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [0, 4],
  [1, 2], [1, 3], [1, 4],
  [2, 3], [2, 4],
  [3, 4]
];

/**
 * Generates the official 8-piece backrank string for SP index 0 to 959
 * based on the Schwalbe / Scharnagl bijection.
 * SP 518 is guaranteed to be 'RNBQKBNR' (Standard Chess).
 */
export function generateChess960Backrank(index: number): string {
  if (index < 0 || index > 959) {
    throw new Error(`Invalid Chess960 index: ${index}. Must be 0 to 959.`);
  }

  const rank: (string | null)[] = new Array(8).fill(null);

  // 1. Light-square bishop on b1, d1, f1, h1 (indices 1, 3, 5, 7)
  const d1 = index % 4;
  rank[2 * d1 + 1] = 'B';
  const q1 = Math.floor(index / 4);

  // 2. Dark-square bishop on a1, c1, e1, g1 (indices 0, 2, 4, 6)
  const d2 = q1 % 4;
  rank[2 * d2] = 'B';
  const q2 = Math.floor(q1 / 4);

  // 3. Queen in remaining 6 empty squares
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

  // 4. Knights in remaining 5 empty squares
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

  // 5. Remaining 3 empty squares: R, K, R (King strictly between Rooks)
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

/**
 * Returns a random Chess960 SP index between 0 and 959.
 */
export function getRandomChess960Index(): number {
  return Math.floor(Math.random() * 960);
}

/**
 * Analyzes a backrank string and extracts King and Rook file indices.
 */
export function extractCastlingConfig(backrank: string): Chess960CastlingConfig {
  let kingFile = -1;
  let queenRookFile = -1;
  let kingRookFile = -1;

  let c = 0;
  for (let i = 0; i < backrank.length && c < 8; i++) {
    const ch = backrank[i];
    if (ch >= '1' && ch <= '8') {
      c += parseInt(ch, 10);
      continue;
    }
    const piece = ch.toUpperCase();
    if (piece === 'R') {
      if (kingFile === -1) {
        queenRookFile = c;
      } else {
        kingRookFile = c;
      }
    } else if (piece === 'K') {
      kingFile = c;
    }
    c++;
  }

  return {
    whiteKingFile: kingFile,
    whiteQueenRookFile: queenRookFile,
    whiteKingRookFile: kingRookFile,
    blackKingFile: kingFile,
    blackQueenRookFile: queenRookFile,
    blackKingRookFile: kingRookFile,
  };
}

/**
 * Returns standard and Shredder FEN for a given Chess960 SP index.
 */
export function getChess960PositionInfo(index: number): Chess960PositionInfo {
  const backrank = generateChess960Backrank(index);
  const cfg = extractCastlingConfig(backrank);

  const whiteBack = backrank.toUpperCase();
  const blackBack = backrank.toLowerCase();

  const standardFen = `${blackBack}/pppppppp/8/8/8/8/PPPPPPPP/${whiteBack} w KQkq - 0 1`;

  const qFileChar = String.fromCharCode(97 + cfg.whiteQueenRookFile);
  const kFileChar = String.fromCharCode(97 + cfg.whiteKingRookFile);
  const shredderCastling = `${kFileChar.toUpperCase()}${qFileChar.toUpperCase()}${kFileChar}${qFileChar}`;
  const shredderFen = `${blackBack}/pppppppp/8/8/8/8/PPPPPPPP/${whiteBack} w ${shredderCastling} - 0 1`;

  return {
    spIndex: index,
    backrank,
    fen: standardFen,
    shredderFen,
    castlingConfig: cfg,
  };
}

/**
 * Normalizes any Chess960 / Shredder FEN so chess.js can load it without throwing validation errors,
 * while extracting the original castling letters.
 */
export function normalizeChess960Fen(rawFen: string): {
  normalizedFen: string;
  originalCastling: string;
  isChess960: boolean;
} {
  const parts = rawFen.trim().split(/\s+/);
  if (parts.length < 4) {
    return { normalizedFen: rawFen, originalCastling: '-', isChess960: false };
  }

  const castling = parts[2];
  const isShredder = /[A-Ha-h]/.test(castling) && !/^[KQkq-]+$/.test(castling);

  // If Shredder FEN has files like 'HAha' or 'AHah', convert to 'KQkq' or valid subset
  let normalizedCastling = castling;
  if (isShredder) {
    let whiteHasCastling = /[A-H]/.test(castling);
    let blackHasCastling = /[a-h]/.test(castling);
    let mapped = '';
    if (whiteHasCastling) mapped += 'KQ';
    if (blackHasCastling) mapped += 'kq';
    normalizedCastling = mapped || '-';
  }

  parts[2] = normalizedCastling;
  return {
    normalizedFen: parts.join(' '),
    originalCastling: castling,
    isChess960: isShredder || rawFen.includes('KQkq'),
  };
}

/**
 * Checks if squares on a rank between fromCol and toCol (exclusive of endpoints unless specified)
 * are empty on the chess board.
 */
function areSquaresEmpty(board: ({ type: string; color: string } | null)[][], row: number, col1: number, col2: number, ignoreCols: number[]): boolean {
  const minC = Math.min(col1, col2);
  const maxC = Math.max(col1, col2);
  for (let c = minC; c <= maxC; c++) {
    if (ignoreCols.includes(c)) continue;
    if (board[row][c] !== null) {
      return false;
    }
  }
  return true;
}

/**
 * Accurately extracts Chess960 castling configuration from any FEN string
 * (supports both Shredder-FEN file letters and standard FEN backranks).
 */
export function extractCastlingConfigFromFen(rawFen: string): Chess960CastlingConfig {
  const parts = rawFen.trim().split(/\s+/);
  const placement = parts[0] || '';
  const castling = parts[2] || '-';
  const ranks = placement.split('/');

  let whiteKingFile = -1;
  let whiteQueenRookFile = -1;
  let whiteKingRookFile = -1;
  let blackKingFile = -1;
  let blackQueenRookFile = -1;
  let blackKingRookFile = -1;

  // 1. Check for Shredder-FEN castling file letters
  const whiteFiles = castling.match(/[A-H]/g);
  if (whiteFiles && whiteFiles.length > 0) {
    const fileNums = whiteFiles.map(ch => ch.charCodeAt(0) - 65).sort((a, b) => a - b);
    if (fileNums.length >= 2) {
      whiteQueenRookFile = fileNums[0];
      whiteKingRookFile = fileNums[fileNums.length - 1];
    } else {
      whiteKingRookFile = fileNums[0];
    }
  }

  const blackFiles = castling.match(/[a-h]/g);
  if (blackFiles && blackFiles.length > 0) {
    const fileNums = blackFiles.map(ch => ch.charCodeAt(0) - 97).sort((a, b) => a - b);
    if (fileNums.length >= 2) {
      blackQueenRookFile = fileNums[0];
      blackKingRookFile = fileNums[fileNums.length - 1];
    } else {
      blackKingRookFile = fileNums[0];
    }
  }

  // 2. Scan rank 1 (row 7) for White pieces
  const rank1 = ranks[7] || '';
  let col = 0;
  for (const ch of rank1) {
    if (/\d/.test(ch)) {
      col += parseInt(ch, 10);
    } else {
      if (ch === 'K') whiteKingFile = col;
      if (ch === 'R') {
        if (whiteQueenRookFile === -1 && (whiteKingFile === -1 || col < whiteKingFile)) {
          whiteQueenRookFile = col;
        } else if (whiteKingFile !== -1 && col > whiteKingFile) {
          whiteKingRookFile = col;
        }
      }
      col++;
    }
  }

  // 3. Scan rank 8 (row 0) for Black pieces
  const rank8 = ranks[0] || '';
  col = 0;
  for (const ch of rank8) {
    if (/\d/.test(ch)) {
      col += parseInt(ch, 10);
    } else {
      if (ch === 'k') blackKingFile = col;
      if (ch === 'r') {
        if (blackQueenRookFile === -1 && (blackKingFile === -1 || col < blackKingFile)) {
          blackQueenRookFile = col;
        } else if (blackKingFile !== -1 && col > blackKingFile) {
          blackKingRookFile = col;
        }
      }
      col++;
    }
  }

  return {
    whiteKingFile: whiteKingFile !== -1 ? whiteKingFile : 4,
    whiteQueenRookFile: whiteQueenRookFile !== -1 ? whiteQueenRookFile : 0,
    whiteKingRookFile: whiteKingRookFile !== -1 ? whiteKingRookFile : 7,
    blackKingFile: blackKingFile !== -1 ? blackKingFile : 4,
    blackQueenRookFile: blackQueenRookFile !== -1 ? blackQueenRookFile : 0,
    blackKingRookFile: blackKingRookFile !== -1 ? blackKingRookFile : 7,
  };
}

/**
 * Checks if a square is attacked by the opponent using chess.js's native isAttacked.
 */
function isSquareAttacked(chess: Chess, square: string, byColor: 'w' | 'b'): boolean {
  if (typeof (chess as any).isAttacked === 'function') {
    return (chess as any).isAttacked(square, byColor);
  }
  const moves = chess.moves({ verbose: true });
  return moves.some(m => m.to === square);
}

/**
 * Validates legal Chess960 castling according to official FIDE Fischer Random rules.
 */
export function isLegalChess960Castling(
  chess: Chess,
  side: 'kingside' | 'queenside',
  config?: Chess960CastlingConfig
): boolean {
  if (chess.inCheck()) return false;
  const effectiveConfig = config || extractCastlingConfigFromFen(chess.fen());

  const fen = chess.fen();
  const parts = fen.split(' ');
  const turn = parts[1] as 'w' | 'b';
  const castlingStr = parts[2];
  const oppColor = turn === 'w' ? 'b' : 'w';

  // Check castling right token
  const rightToken = turn === 'w' ? (side === 'kingside' ? 'K' : 'Q') : (side === 'kingside' ? 'k' : 'q');
  if (!castlingStr.includes(rightToken) && !castlingStr.includes(rightToken.toUpperCase())) {
    return false;
  }

  const board = chess.board();
  const rank = turn === 'w' ? 7 : 0; // row 7 is rank 1, row 0 is rank 8
  const rankStr = turn === 'w' ? '1' : '8';

  // Find King & Rook positions
  let kingCol = -1;
  let targetRookCol = -1;

  for (let c = 0; c < 8; c++) {
    const p = board[rank][c];
    if (p && p.color === turn) {
      if (p.type === 'k') kingCol = c;
    }
  }

  if (kingCol === -1) return false;

  if (effectiveConfig) {
    targetRookCol = turn === 'w'
      ? (side === 'kingside' ? effectiveConfig.whiteKingRookFile : effectiveConfig.whiteQueenRookFile)
      : (side === 'kingside' ? effectiveConfig.blackKingRookFile : effectiveConfig.blackQueenRookFile);
  } else {
    // Detect rooks on current rank
    if (side === 'kingside') {
      for (let c = kingCol + 1; c < 8; c++) {
        const p = board[rank][c];
        if (p && p.color === turn && p.type === 'r') {
          targetRookCol = c;
          break;
        }
      }
    } else {
      for (let c = kingCol - 1; c >= 0; c--) {
        const p = board[rank][c];
        if (p && p.color === turn && p.type === 'r') {
          targetRookCol = c;
          break;
        }
      }
    }
  }

  if (targetRookCol === -1) return false;

  // Destination squares
  // Kingside: King to g (col 6), Rook to f (col 5)
  // Queenside: King to c (col 2), Rook to d (col 3)
  const destKingCol = side === 'kingside' ? 6 : 2;
  const destRookCol = side === 'kingside' ? 5 : 3;

  // Transit squares that must be empty:
  // All squares between kingCol and destKingCol, AND between targetRookCol and destRookCol,
  // excluding the starting squares of the King and target Rook.
  const ignoreCols = [kingCol, targetRookCol];

  // 1. Check king path emptiness
  const kingMinC = Math.min(kingCol, destKingCol);
  const kingMaxC = Math.max(kingCol, destKingCol);
  for (let c = kingMinC; c <= kingMaxC; c++) {
    if (!ignoreCols.includes(c) && board[rank][c] !== null) {
      return false;
    }
  }

  // 2. Check rook path emptiness
  const rookMinC = Math.min(targetRookCol, destRookCol);
  const rookMaxC = Math.max(targetRookCol, destRookCol);
  for (let c = rookMinC; c <= rookMaxC; c++) {
    if (!ignoreCols.includes(c) && board[rank][c] !== null) {
      return false;
    }
  }

  // 3. King transit path must not be attacked
  // King cannot travel through or land on an attacked square
  for (let c = kingMinC; c <= kingMaxC; c++) {
    const sq = `${String.fromCharCode(97 + c)}${rankStr}`;
    if (isSquareAttacked(chess, sq, oppColor)) {
      return false;
    }
  }

  return true;
}

/**
 * Executes a Chess960 castling move by directly updating the board pieces
 * and updating castling rights, active color, and halfmove clock.
 * Returns the resulting FEN.
 */
export function executeChess960Castling(
  chess: Chess,
  side: 'kingside' | 'queenside',
  config?: Chess960CastlingConfig
): string {
  const fen = chess.fen();
  const parts = fen.split(' ');
  const turn = parts[1] as 'w' | 'b';
  const rank = turn === 'w' ? 7 : 0;
  const board = chess.board();

  let kingCol = -1;
  for (let c = 0; c < 8; c++) {
    const p = board[rank][c];
    if (p && p.color === turn && p.type === 'k') kingCol = c;
  }

  const effectiveConfig = config || extractCastlingConfigFromFen(chess.fen());
  let rookCol = -1;
  if (effectiveConfig) {
    rookCol = turn === 'w'
      ? (side === 'kingside' ? effectiveConfig.whiteKingRookFile : effectiveConfig.whiteQueenRookFile)
      : (side === 'kingside' ? effectiveConfig.blackKingRookFile : effectiveConfig.blackQueenRookFile);
  } else {
    if (side === 'kingside') {
      for (let c = kingCol + 1; c < 8; c++) {
        if (board[rank][c]?.type === 'r' && board[rank][c]?.color === turn) {
          rookCol = c;
          break;
        }
      }
    } else {
      for (let c = kingCol - 1; c >= 0; c--) {
        if (board[rank][c]?.type === 'r' && board[rank][c]?.color === turn) {
          rookCol = c;
          break;
        }
      }
    }
  }

  const destKingCol = side === 'kingside' ? 6 : 2;
  const destRookCol = side === 'kingside' ? 5 : 3;

  // Clear original king and rook squares
  board[rank][kingCol] = null;
  board[rank][rookCol] = null;

  // Place at destination
  const kingDestSq = `${String.fromCharCode(97 + destKingCol)}${turn === 'w' ? 1 : 8}` as any;
  const rookDestSq = `${String.fromCharCode(97 + destRookCol)}${turn === 'w' ? 1 : 8}` as any;
  board[rank][destKingCol] = { square: kingDestSq, type: 'k', color: turn };
  board[rank][destRookCol] = { square: rookDestSq, type: 'r', color: turn };

  // Rebuild placement string
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) {
    let rowStr = '';
    let emptyCount = 0;
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) {
        emptyCount++;
      } else {
        if (emptyCount > 0) {
          rowStr += emptyCount;
          emptyCount = 0;
        }
        rowStr += p.color === 'w' ? p.type.toUpperCase() : p.type.toLowerCase();
      }
    }
    if (emptyCount > 0) rowStr += emptyCount;
    rows.push(rowStr);
  }

  // Update castling rights
  let nextCastling = parts[2];
  if (turn === 'w') {
    nextCastling = nextCastling.replace(/[KQ]/g, '');
  } else {
    nextCastling = nextCastling.replace(/[kq]/g, '');
  }
  if (!nextCastling) nextCastling = '-';

  const nextTurn = turn === 'w' ? 'b' : 'w';
  const halfmove = parseInt(parts[4], 10) + 1;
  const fullmove = turn === 'b' ? parseInt(parts[5], 10) + 1 : parseInt(parts[5], 10);

  const nextFen = `${rows.join('/')} ${nextTurn} ${nextCastling} - ${halfmove} ${fullmove}`;
  chess.load(nextFen);
  return nextFen;
}

/**
 * Translates a UCI move (e.g. 'e1h1' or 'e1g1') into Chess960 castling intent if applicable.
 */
export function resolveChess960Move(
  chess: Chess,
  uciMove: string,
  config?: Chess960CastlingConfig
): {
  isChess960Castling: boolean;
  side?: 'kingside' | 'queenside';
  standardUci: string;
} {
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

  // 1. King to own Rook square (UCI Chess960 standard)
  const pieceTo = board[row][toFile];
  if (pieceTo && pieceTo.type === 'r' && pieceTo.color === turn) {
    const side: 'kingside' | 'queenside' = toFile > fromFile ? 'kingside' : 'queenside';
    if (isLegalChess960Castling(chess, side, config)) {
      const destKingSq = side === 'kingside' ? `g${expectedRank}` : `c${expectedRank}`;
      return { isChess960Castling: true, side, standardUci: `${from}${destKingSq}` };
    }
  }

  // 2. Standard destination castling (e.g. e1g1 or e1c1)
  if (sideMatchesTarget(sideName(toFile), toFile)) {
    const side = toFile === 6 ? 'kingside' : toFile === 2 ? 'queenside' : null;
    if (side && isLegalChess960Castling(chess, side, config)) {
      return { isChess960Castling: true, side, standardUci: uciMove };
    }
  }

  return { isChess960Castling: false, standardUci: uciMove };
}

function sideName(col: number): 'kingside' | 'queenside' | null {
  if (col === 6) return 'kingside';
  if (col === 2) return 'queenside';
  return null;
}

function sideMatchesTarget(side: 'kingside' | 'queenside' | null, col: number): boolean {
  if (!side) return false;
  return (side === 'kingside' && col === 6) || (side === 'queenside' && col === 2);
}

/**
 * Returns all legal moves for a Chess960 (or standard) position.
 * When isChess960 is active, filters out any invalid standard chess.js castling moves
 * and injects authentic FRC castling moves (King on c1/g1, Rook on d1/f1).
 */
export function getChess960LegalMoves(
  chess: Chess,
  isChess960: boolean,
  config?: Chess960CastlingConfig
): any[] {
  const rawMoves = chess.moves({ verbose: true });
  if (!isChess960) return rawMoves;

  // Filter out chess.js's built-in standard castling which assumes King is on e1/e8 and Rooks on a1/h1
  const filtered = rawMoves.filter(m => !m.flags.includes('k') && !m.flags.includes('q'));
  const turn = chess.turn();
  const board = chess.board();
  const row = turn === 'w' ? 7 : 0;
  const rankStr = turn === 'w' ? '1' : '8';

  let kingCol = -1;
  for (let c = 0; c < 8; c++) {
    const p = board[row][c];
    if (p && p.type === 'k' && p.color === turn) {
      kingCol = c;
      break;
    }
  }

  if (kingCol === -1) return filtered;

  const kingSq = `${String.fromCharCode(97 + kingCol)}${rankStr}`;

  // Kingside castling (O-O) -> King to g1/g8, Rook to f1/f8
  if (isLegalChess960Castling(chess, 'kingside', config)) {
    const destKingSq = `g${rankStr}`;
    filtered.push({
      color: turn,
      from: kingSq as any,
      to: destKingSq as any,
      piece: 'k',
      captured: undefined,
      promotion: undefined,
      flags: 'k',
      san: 'O-O',
      lan: `${kingSq}${destKingSq}`,
      before: chess.fen(),
      after: '',
      isChess960Castling: true,
      castlingSide: 'kingside',
    } as any);
  }

  // Queenside castling (O-O-O) -> King to c1/c8, Rook to d1/d8
  if (isLegalChess960Castling(chess, 'queenside', config)) {
    const destKingSq = `c${rankStr}`;
    filtered.push({
      color: turn,
      from: kingSq as any,
      to: destKingSq as any,
      piece: 'k',
      captured: undefined,
      promotion: undefined,
      flags: 'q',
      san: 'O-O-O',
      lan: `${kingSq}${destKingSq}`,
      before: chess.fen(),
      after: '',
      isChess960Castling: true,
      castlingSide: 'queenside',
    } as any);
  }

  return filtered;
}

/**
 * Executes a move on the board, handling Chess960 castling correctly.
 * Returns an undo record for unmakeChess960Move.
 */
export function makeChess960Move(
  chess: Chess,
  move: any,
  config?: Chess960CastlingConfig
): { undoFen: string | null } {
  if (move.isChess960Castling && move.castlingSide) {
    const undoFen = chess.fen();
    executeChess960Castling(chess, move.castlingSide, config);
    return { undoFen };
  }
  chess.move(move);
  return { undoFen: null };
}

/**
 * Restores previous board state after makeChess960Move.
 */
export function unmakeChess960Move(
  chess: Chess,
  undoRecord: { undoFen: string | null }
): void {
  if (undoRecord.undoFen) {
    chess.load(undoRecord.undoFen);
  } else {
    chess.undo();
  }
}

