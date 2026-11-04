import { Chess } from 'chess.js';

export interface OpeningBookEntry {
  san: string;
  uci: string;
  openingName: string;
  eco: string;
}

export interface KingSafetyMetrics {
  kingSquare: string;
  isCastled: boolean;
  castleSide: 'kingside' | 'queenside' | 'uncastled';
  shieldIntegrityPct: number;
  stormThreatIndex: number;
  netAttackBonusCp: number;
}

export interface MultiPvCandidate {
  rank: number;
  bestMove: string; // e.g. "e2e4"
  scoreCp: number;
  pv: string;
  san?: string;
}

export interface BlendedMoveResult {
  chosenMoveUci: string;
  chosenMoveSan: string;
  reason: 'book' | 'tactical-pv' | 'positional-rerank' | 'fallback';
  openingInfo?: OpeningBookEntry;
  pvRankChosen?: number;
  originalTopUci?: string;
  tacticalDeltaCp?: number;
  positionalBonusCp?: number;
}

// ============================================================================
// 1. GRANDMASTER OPENING BOOK REPERTOIRE
// ============================================================================
// Normalized position mapping (FEN piece placement + active turn) -> GM Theoretical Move
export const GM_OPENING_BOOK: Record<string, OpeningBookEntry> = {
  // Initial Position: White to move
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w': {
    san: 'e4',
    uci: 'e2e4',
    openingName: "King's Pawn Opening (Open Game)",
    eco: 'B00'
  },
  
  // 1. e4 responses for Black
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b': {
    san: 'c5',
    uci: 'c7c5',
    openingName: 'Sicilian Defense',
    eco: 'B20'
  },
  
  // 1. d4 responses for Black
  'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b': {
    san: 'Nf6',
    uci: 'g8f6',
    openingName: 'Indian Defense',
    eco: 'A45'
  },
  
  // 1. c4 responses for Black
  'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b': {
    san: 'e5',
    uci: 'e7e5',
    openingName: 'English Opening: King\'s English',
    eco: 'A20'
  },

  // 1. Nf3 responses for Black
  'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b': {
    san: 'd5',
    uci: 'd7d5',
    openingName: 'Reti Opening',
    eco: 'A06'
  },

  // 1. e4 c5 -> White 2. Nf3 (Open Sicilian)
  'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w': {
    san: 'Nf3',
    uci: 'g1f3',
    openingName: 'Sicilian Defense: Modern Open Line',
    eco: 'B27'
  },

  // 1. e4 c5 2. Nf3 -> Black 2... d6
  'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b': {
    san: 'd6',
    uci: 'd7d6',
    openingName: 'Sicilian Defense: Classical / Najdorf Prep',
    eco: 'B50'
  },

  // 1. e4 c5 2. Nf3 d6 -> White 3. d4 (Open Sicilian Center Break)
  'rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w': {
    san: 'd4',
    uci: 'd2d4',
    openingName: 'Sicilian Defense: Open Variation',
    eco: 'B54'
  },

  // 1. e4 c5 2. Nf3 d6 3. d4 -> Black 3... cxd4
  'rnbqkbnr/pp2pppp/3p4/8/3pP3/5N2/PPP2PPP/RNBQKB1R b': {
    san: 'cxd4',
    uci: 'c5d4',
    openingName: 'Sicilian Defense: Open Main Line',
    eco: 'B54'
  },

  // 1. e4 c5 2. Nf3 d6 3. d4 cxd4 -> White 4. Nxd4
  'rnbqkbnr/pp2pppp/3p4/8/3NP3/8/PPP2PPP/RNBQKB1R w': {
    san: 'Nxd4',
    uci: 'f3d4',
    openingName: 'Sicilian Defense: Open Recapture',
    eco: 'B54'
  },

  // 1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 (Sicilian Najdorf)
  'rnbqkb1r/pp2pppp/3p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R b': {
    san: 'a6',
    uci: 'a7a6',
    openingName: 'Sicilian Defense: Najdorf Variation',
    eco: 'B90'
  },

  // 1. e4 e5 (Open Game) -> White 2. Nf3
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w': {
    san: 'Nf3',
    uci: 'g1f3',
    openingName: "King's Knight Opening",
    eco: 'C40'
  },

  // 1. e4 e5 2. Nf3 -> Black 2... Nc6
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b': {
    san: 'Nc6',
    uci: 'b8c6',
    openingName: "King's Pawn Game: Normal Defense",
    eco: 'C44'
  },

  // 1. e4 e5 2. Nf3 Nc6 -> White 3. Bb5 (Ruy Lopez)
  'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w': {
    san: 'Bb5',
    uci: 'f1b5',
    openingName: 'Ruy Lopez (Spanish Opening)',
    eco: 'C60'
  },

  // 1. e4 e5 2. Nf3 Nc6 3. Bb5 -> Black 3... a6 (Morphy Defense)
  'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b': {
    san: 'a6',
    uci: 'a7a6',
    openingName: 'Ruy Lopez: Morphy Defense',
    eco: 'C68'
  },

  // 1. e4 e6 (French Defense) -> White 2. d4
  'rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w': {
    san: 'd4',
    uci: 'd2d4',
    openingName: 'French Defense: Main Center',
    eco: 'C00'
  },

  // 1. e4 c6 (Caro-Kann Defense) -> White 2. d4
  'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w': {
    san: 'd4',
    uci: 'd2d4',
    openingName: 'Caro-Kann Defense: Main Line',
    eco: 'B12'
  },

  // 1. d4 Nf6 -> White 2. c4
  'rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w': {
    san: 'c4',
    uci: 'c2c4',
    openingName: 'Indian Game: Classical Continuation',
    eco: 'A50'
  },

  // 1. d4 Nf6 2. c4 e6 -> White 3. Nc3
  'rnbqkb1r/pppp1ppp/4pn2/8/2PP4/8/PP2PPPP/RNBQKBNR w': {
    san: 'Nc3',
    uci: 'b1c3',
    openingName: 'Nimzo-Indian / Queen\'s Indian Complex',
    eco: 'E20'
  },

  // 1. d4 Nf6 2. c4 g6 -> White 3. Nc3 (King's Indian / Grünfeld)
  'rnbqkb1r/pppppp1p/5np1/8/2PP4/8/PP2PPPP/RNBQKBNR w': {
    san: 'Nc3',
    uci: 'b1c3',
    openingName: "King's Indian Defense / Grünfeld Setup",
    eco: 'E60'
  },

  // 1. d4 d5 -> White 2. c4 (Queen's Gambit)
  'rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w': {
    san: 'c4',
    uci: 'c2c4',
    openingName: "Queen's Gambit",
    eco: 'D06'
  },

  // 1. d4 d5 2. c4 e6 -> White 3. Nc3 (Queen's Gambit Declined)
  'rnbqkbnr/ppp2ppp/4p3/3p4/2PP4/8/PP2PPPP/RNBQKBNR w': {
    san: 'Nc3',
    uci: 'b1c3',
    openingName: "Queen's Gambit Declined: Classical Line",
    eco: 'D31'
  }
};

/**
 * Looks up current position in the Grandmaster Opening Book
 */
export function getOpeningBookMove(fen: string): OpeningBookEntry | null {
  const parts = fen.split(' ');
  const normalizedKey = `${parts[0]} ${parts[1]}`;
  return GM_OPENING_BOOK[normalizedKey] || null;
}

// ============================================================================
// 2. MVV-LVA (MOST VALUABLE VICTIM - LEAST VALUABLE ATTACKER) QUIESCENCE SEARCH
// ============================================================================
export const PIECE_VALUES: Record<string, number> = {
  p: 100,
  n: 320,
  b: 335,
  r: 500,
  q: 900,
  k: 20000
};

export function getMvvLvaScore(attackerPiece: string, victimPiece: string): number {
  const victimVal = PIECE_VALUES[victimPiece.toLowerCase()] || 100;
  const attackerVal = PIECE_VALUES[attackerPiece.toLowerCase()] || 100;
  // Standard chess engine MVV-LVA heuristic: (Victim * 10) - Attacker
  return (victimVal * 10) - attackerVal;
}

export function sortMovesMvvLva(moves: any[]): any[] {
  return [...moves].sort((a, b) => {
    if (a.captured && !b.captured) return -1;
    if (!a.captured && b.captured) return 1;
    if (a.captured && b.captured) {
      const scoreA = getMvvLvaScore(a.piece, a.captured);
      const scoreB = getMvvLvaScore(b.piece, b.captured);
      return scoreB - scoreA;
    }
    return 0;
  });
}

/**
 * 2-Ply Quiescence Search evaluating only tactical capture sequences
 * to eliminate horizon effect blunders in dynamic piece trades.
 */
export function quiescenceSearch(
  chess: Chess,
  alpha: number,
  beta: number,
  currentDepth: number = 0,
  maxQDepth: number = 2
): number {
  // Static evaluation (material balance from current side perspective)
  let staticEval = 0;
  const board = chess.board();
  for (const row of board) {
    for (const sq of row) {
      if (sq) {
        const val = PIECE_VALUES[sq.type] || 0;
        staticEval += sq.color === chess.turn() ? val : -val;
      }
    }
  }

  if (staticEval >= beta) {
    return beta; // Stand-pat beta cutoff
  }
  if (staticEval > alpha) {
    alpha = staticEval;
  }

  if (currentDepth >= maxQDepth || chess.isGameOver()) {
    return staticEval;
  }

  // Generate only tactical captures
  const captures = chess.moves({ verbose: true }).filter((m: any) => m.captured);
  const sortedCaptures = sortMovesMvvLva(captures);

  for (const cap of sortedCaptures) {
    chess.move(cap);
    const score = -quiescenceSearch(chess, -beta, -alpha, currentDepth + 1, maxQDepth);
    chess.undo();

    if (score >= beta) {
      return beta; // Beta cutoff on tactical refute
    }
    if (score > alpha) {
      alpha = score;
    }
  }

  return alpha;
}

// ============================================================================
// 3. CASTLED KING SHIELD & STORM INDEX (ATTACK VECTOR MATRIX)
// ============================================================================
export function evaluateKingSafety(chess: Chess, kingColor: 'w' | 'b'): KingSafetyMetrics {
  let kingSquare = '';
  const board = chess.board();

  // Find king position
  board.forEach((row, rIdx) => {
    row.forEach((sq, cIdx) => {
      if (sq && sq.type === 'k' && sq.color === kingColor) {
        const file = String.fromCharCode(97 + cIdx);
        const rank = 8 - rIdx;
        kingSquare = `${file}${rank}`;
      }
    });
  });

  if (!kingSquare) {
    return {
      kingSquare: 'e1',
      isCastled: false,
      castleSide: 'uncastled',
      shieldIntegrityPct: 100,
      stormThreatIndex: 0,
      netAttackBonusCp: 0
    };
  }

  const fileChar = kingSquare[0];
  const rankNum = parseInt(kingSquare[1], 10);
  const isKingside = ['g', 'h'].includes(fileChar);
  const isQueenside = ['b', 'c'].includes(fileChar);
  const castleSide: 'kingside' | 'queenside' | 'uncastled' = isKingside ? 'kingside' : isQueenside ? 'queenside' : 'uncastled';
  const isCastled = castleSide !== 'uncastled';

  // Evaluate Pawn Shield:
  // For Kingside: f, g, h files
  // For Queenside: a, b, c files
  // For Uncastled: d, e, f files
  const shieldFiles = isKingside ? ['f', 'g', 'h'] : isQueenside ? ['a', 'b', 'c'] : ['d', 'e', 'f'];
  let intactShieldPawns = 0;
  let pushedShieldPawns = 0;
  let missingShieldPawns = 0;

  shieldFiles.forEach((f) => {
    let hasFriendlyPawn = false;
    let isPushed = false;

    board.forEach((row, rIdx) => {
      row.forEach((sq, cIdx) => {
        if (!sq || sq.type !== 'p') return;
        const curFile = String.fromCharCode(97 + cIdx);
        const curRank = 8 - rIdx;
        if (curFile === f && sq.color === kingColor) {
          hasFriendlyPawn = true;
          // White pawns starting rank 2, pushed if rank >= 4
          // Black pawns starting rank 7, pushed if rank <= 5
          if (kingColor === 'w' && curRank >= 4) isPushed = true;
          if (kingColor === 'b' && curRank <= 5) isPushed = true;
        }
      });
    });

    if (hasFriendlyPawn) {
      if (isPushed) pushedShieldPawns++;
      else intactShieldPawns++;
    } else {
      missingShieldPawns++;
    }
  });

  // Calculate shield integrity (100% is untouched fortress, 0% is naked king)
  const shieldIntegrityPct = Math.max(
    0,
    Math.round(((intactShieldPawns * 1.0 + pushedShieldPawns * 0.45) / 3) * 100)
  );

  // Storm threat index: Evaluate enemy heavy pieces aligned along shield files
  const oppColor = kingColor === 'w' ? 'b' : 'w';
  let openFilesTowardsKing = 0;
  let enemyPiecesTargetingFiles = 0;

  shieldFiles.forEach((f) => {
    let pawnsOnFile = 0;
    board.forEach((row, rIdx) => {
      row.forEach((sq, cIdx) => {
        if (!sq) return;
        const curFile = String.fromCharCode(97 + cIdx);
        if (curFile === f) {
          if (sq.type === 'p') pawnsOnFile++;
          if (sq.color === oppColor && ['q', 'r', 'b'].includes(sq.type)) {
            enemyPiecesTargetingFiles++;
          }
        }
      });
    });
    if (pawnsOnFile === 0) openFilesTowardsKing++;
  });

  // Storm index (0 to 100)
  const stormThreatIndex = Math.min(
    100,
    openFilesTowardsKing * 28 + enemyPiecesTargetingFiles * 12 + missingShieldPawns * 18
  );

  // Net attack bonus (centipawns awarded to the ATTACKING side)
  // When shield integrity is low and storm threat is high, the attacking side gets a major bonus
  const netAttackBonusCp = Math.round(
    ((100 - shieldIntegrityPct) * 0.65) + (stormThreatIndex * 0.55)
  );

  return {
    kingSquare,
    isCastled,
    castleSide,
    shieldIntegrityPct,
    stormThreatIndex,
    netAttackBonusCp
  };
}

// ============================================================================
// 4. DYNAMIC CONTEMPT & ANTI-DRAW BIAS
// ============================================================================
/**
 * Dynamic Contempt penalizes moves that force repetitive or sterile draws when equal or better.
 */
export function calculateContemptBonus(
  chess: Chess,
  move: any,
  contemptCp: number = 45,
  isWhitePerspective: boolean = true
): number {
  let contemptAdjustment = 0;

  // 1. Detect Queen trades when not behind
  if (move.piece === 'q' && move.captured === 'q') {
    // Discourage sterile early queen trades to keep positional tension alive
    contemptAdjustment -= contemptCp;
  }

  // 2. Repetition avoidance: Test if move creates a repeat of previous position
  chess.move(move);
  if (chess.isDraw()) {
    // Severe contempt penalty for accepting a draw
    contemptAdjustment -= 140;
  }
  chess.undo();

  return contemptAdjustment;
}

// ============================================================================
// 5. MULTI-PV CANDIDATE TACTICAL-POSITIONAL HYBRID BLENDING
// ============================================================================
/**
 * Reranks top tactical candidate moves from Stockfish 19 WASM using Berserker + Lc0 heuristics.
 * If candidate moves are tactically within maxDeltaCp (e.g. 40cp) of the top move,
 * the engine chooses the candidate with superior positional squeeze, king pressure,
 * or color complex dominance.
 */
export function blendMultiPvCandidates(
  candidates: MultiPvCandidate[],
  chess: Chess,
  positionalScorer: (candidateUci: string) => number,
  maxDeltaCp: number = 42
): BlendedMoveResult {
  if (candidates.length === 0) {
    const legal = chess.moves({ verbose: true });
    const fallback = legal[0] || { from: 'e2', to: 'e4', san: 'e4' };
    return {
      chosenMoveUci: `${fallback.from}${fallback.to}`,
      chosenMoveSan: fallback.san,
      reason: 'fallback'
    };
  }

  const topCandidate = candidates[0];
  const eligibleCandidates = candidates.filter(
    (c) => Math.abs(c.scoreCp - topCandidate.scoreCp) <= maxDeltaCp
  );

  if (eligibleCandidates.length <= 1) {
    // Only 1 tactically clear candidate
    return {
      chosenMoveUci: topCandidate.bestMove,
      chosenMoveSan: topCandidate.san || topCandidate.bestMove,
      reason: 'tactical-pv',
      pvRankChosen: 1,
      originalTopUci: topCandidate.bestMove,
      tacticalDeltaCp: 0,
      positionalBonusCp: 0
    };
  }

  // Score each eligible tactical candidate with Berserker/Lc0 positional heuristics
  let bestBlendedUci = topCandidate.bestMove;
  let bestBlendedSan = topCandidate.san || topCandidate.bestMove;
  let bestTotalScore = -Infinity;
  let chosenRank = 1;
  let appliedBonus = 0;

  for (const cand of eligibleCandidates) {
    const posBonus = positionalScorer(cand.bestMove);
    const combinedScore = cand.scoreCp + posBonus;
    if (combinedScore > bestTotalScore) {
      bestTotalScore = combinedScore;
      bestBlendedUci = cand.bestMove;
      bestBlendedSan = cand.san || cand.bestMove;
      chosenRank = cand.rank;
      appliedBonus = posBonus;
    }
  }

  const switched = bestBlendedUci !== topCandidate.bestMove;

  return {
    chosenMoveUci: bestBlendedUci,
    chosenMoveSan: bestBlendedSan,
    reason: switched ? 'positional-rerank' : 'tactical-pv',
    pvRankChosen: chosenRank,
    originalTopUci: topCandidate.bestMove,
    tacticalDeltaCp: topCandidate.scoreCp - (candidates.find(c => c.bestMove === bestBlendedUci)?.scoreCp || topCandidate.scoreCp),
    positionalBonusCp: appliedBonus
  };
}
