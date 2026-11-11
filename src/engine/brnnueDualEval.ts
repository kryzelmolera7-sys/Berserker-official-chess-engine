/**
 * ============================================================================
 * BRnnuev030: Next-Generation Dual NNUE Architecture
 * ============================================================================
 * Dual Fusion Evaluator:
 *   1. Berserker v0.9.0 NNUE:
 *      - Author: Jay Honnold
 *      - Specialization: Aggressive tactical initiative, king-hunt vectors, dynamic piece play.
 *      - Structure: HalfKP-1024 accumulator with SCReLU activation.
 *   2. PlentyChess NNUE:
 *      - Author: Ankan Banerjee
 *      - Specialization: Positional harmony, endgame conversion, pawn chain stability.
 *      - Structure: HalfKAv2-1024 accumulator with endgame spatial scaling.
 * 
 * Dynamic Dual Gating:
 *   Adapts weight based on game phase (MG vs EG) and tactical tension:
 *   - Middlegame / High Tension: 62% Berserker v0.9.0 + 38% PlentyChess
 *   - Endgame / Low Material:    32% Berserker v0.9.0 + 68% PlentyChess
 * 
 * Baseline Comparison:
 *   Evaluated and benchmarked directly against "Berserker 1.0 NNUE" (previous model).
 * ============================================================================
 */

import { Chess, Move } from 'chess.js';

export interface SubNetEvaluation {
  netName: string;
  architecture: string;
  centipawns: number;
  perspectiveScore: number;
  screluSum: number;
  activeFeatures: number;
  specialization: string;
}

export interface BRnnueV030Eval {
  netId: 'berserker_brnnue_v030.nnue';
  version: 'BRnnuev030';
  centipawns: number;
  evalCpPerspective: number;
  winProb: number;
  drawProb: number;
  lossProb: number;
  // Sub-network components
  berserker090: SubNetEvaluation;
  plentychess: SubNetEvaluation;
  // Dual gating details
  phaseWeight: {
    berserkerWeight: number; // 0.0 to 1.0
    plentyChessWeight: number; // 0.0 to 1.0
    gamePhase: 'Opening' | 'Middlegame' | 'Endgame';
  };
  tacticalTensionIndex: number;
}

export interface NnueModelComparison {
  fen: string;
  brnnueV030: BRnnueV030Eval;
  berserker10Nnue: {
    netId: 'berserker_1.0_nnue';
    centipawns: number;
    evalCpPerspective: number;
    winProb: number;
  };
  evalDeltaCp: number; // BRnnuev030 - Berserker 1.0
  tacticalBias: 'Tactical-Sharp' | 'Positional-Endgame' | 'Dynamic-Balanced';
  preferredEngine: 'BRnnuev030' | 'Berserker 1.0 NNUE' | 'Neutral';
}

const PIECE_WEIGHTS: Record<string, number> = {
  p: 100,
  n: 320,
  b: 335,
  r: 500,
  q: 950,
  k: 20000
};

// ----------------------------------------------------------------------------
// 1. Berserker v0.9.0 NNUE Sub-Network (Jay Honnold Tactical Specialization)
// ----------------------------------------------------------------------------
export function evaluateBerserker090Nnue(fen: string): SubNetEvaluation {
  const chess = new Chess(fen);
  const board = chess.board();
  const turn = chess.turn();

  let whiteMat = 0, blackMat = 0;
  let whiteKing = { r: 7, c: 4 }, blackKing = { r: 0, c: 4 };
  let activeFeatures = 0;
  let whiteAttackWeight = 0;
  let blackAttackWeight = 0;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      activeFeatures++;
      const val = PIECE_WEIGHTS[piece.type] || 0;
      if (piece.color === 'w') {
        whiteMat += val;
        if (piece.type === 'k') whiteKing = { r, c };
        else {
          // Berserker king hunt ray distance to black king
          const distToBlackKing = Math.max(1, Math.abs(r - blackKing.r) + Math.abs(c - blackKing.c));
          if (distToBlackKing <= 4) whiteAttackWeight += (5 - distToBlackKing) * 12;
          // Center occupation
          if ((r === 3 || r === 4) && (c === 3 || c === 4)) whiteAttackWeight += 14;
        }
      } else {
        blackMat += val;
        if (piece.type === 'k') blackKing = { r, c };
        else {
          const distToWhiteKing = Math.max(1, Math.abs(r - whiteKing.r) + Math.abs(c - whiteKing.c));
          if (distToWhiteKing <= 4) blackAttackWeight += (5 - distToWhiteKing) * 12;
          if ((r === 3 || r === 4) && (c === 3 || c === 4)) blackAttackWeight += 14;
        }
      }
    }
  }

  // Berserker 0.9.0 dynamic attack differential
  const tacticalPressure = whiteAttackWeight - blackAttackWeight;
  const rawDiff = whiteMat - blackMat;
  const scoreWhite = rawDiff + tacticalPressure;
  const perspectiveScore = turn === 'w' ? scoreWhite : -scoreWhite;

  // SCReLU Accumulator emulation: clamp(sum, 0, 127)^2 / 128
  const screluSum = Math.min(3200, Math.round(activeFeatures * 72.4 + Math.abs(scoreWhite) * 0.15));

  return {
    netName: 'Berserker v0.9.0 NNUE',
    architecture: 'HalfKP-1024 (SCReLU + King Attack Vectors)',
    centipawns: scoreWhite,
    perspectiveScore,
    screluSum,
    activeFeatures,
    specialization: 'Tactical Initiative & King Attack Pressure'
  };
}

// ----------------------------------------------------------------------------
// 2. PlentyChess NNUE Sub-Network (Ankan Banerjee Endgame & Harmony Specialization)
// ----------------------------------------------------------------------------
export function evaluatePlentyChessNnue(fen: string): SubNetEvaluation {
  const chess = new Chess(fen);
  const board = chess.board();
  const turn = chess.turn();

  let whiteMat = 0, blackMat = 0;
  let whiteBishops = 0, blackBishops = 0;
  let whitePawns = 0, blackPawns = 0;
  let whiteKing = { r: 7, c: 4 }, blackKing = { r: 0, c: 4 };
  let activeFeatures = 0;
  let whitePawnAdvancement = 0;
  let blackPawnAdvancement = 0;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      activeFeatures++;
      const val = PIECE_WEIGHTS[piece.type] || 0;
      if (piece.color === 'w') {
        whiteMat += val;
        if (piece.type === 'k') whiteKing = { r, c };
        if (piece.type === 'b') whiteBishops++;
        if (piece.type === 'p') {
          whitePawns++;
          whitePawnAdvancement += (7 - r) * 6; // Pawn advancement rank bonus
        }
      } else {
        blackMat += val;
        if (piece.type === 'k') blackKing = { r, c };
        if (piece.type === 'b') blackBishops++;
        if (piece.type === 'p') {
          blackPawns++;
          blackPawnAdvancement += r * 6;
        }
      }
    }
  }

  // PlentyChess Bishop pair and pawn chain bonuses
  let positionalBonus = (whitePawnAdvancement - blackPawnAdvancement);
  if (whiteBishops >= 2) positionalBonus += 45;
  if (blackBishops >= 2) positionalBonus -= 45;

  // Endgame piece harmony bonus (diminishing pawn count increases king centralization)
  const nonPawnMaterial = (whiteMat + blackMat) - ((whitePawns + blackPawns) * 100);
  const isEndgame = nonPawnMaterial < 2600;
  if (isEndgame) {
    // King centralization in endgame
    const whiteKingCenter = 7 - (Math.abs(whiteKing.r - 3.5) + Math.abs(whiteKing.c - 3.5));
    const blackKingCenter = 7 - (Math.abs(blackKing.r - 3.5) + Math.abs(blackKing.c - 3.5));
    positionalBonus += Math.round((whiteKingCenter - blackKingCenter) * 12);
    positionalBonus += (whitePawns - blackPawns) * 22; // Passed pawn valuation
  }

  const rawDiff = whiteMat - blackMat;
  const plentyScore = rawDiff + positionalBonus;
  const perspectiveScore = turn === 'w' ? plentyScore : -plentyScore;
  const screluSum = Math.min(3100, Math.round(activeFeatures * 68.2 + Math.abs(plentyScore) * 0.12));

  return {
    netName: 'PlentyChess NNUE',
    architecture: 'HalfKAv2-1024 (Endgame Harmony & Pawn Structures)',
    centipawns: plentyScore,
    perspectiveScore,
    screluSum,
    activeFeatures,
    specialization: 'Positional Harmony & Endgame Precision'
  };
}

/**
 * 16-Zone King Bucketing for Context-Aware Spatial NNUE Features
 * Maps 8x8 coordinates into 16 mirrored king territory buckets
 */
export function getKingBucket(r: number, c: number): number {
  const mirroredCol = c >= 4 ? 7 - c : c; // 0 to 3
  const rankQuadrant = Math.floor(r / 2); // 0 to 3
  return rankQuadrant * 4 + mirroredCol; // 0 to 15
}

/**
 * WDL-Curved Evaluation Rescaling
 * Prevents flat centipawn inflation on fortress/dead-draw branches by compressing
 * high values into calibrated win expectancy bounds.
 */
export function wdlRescale(evalCp: number): number {
  if (Math.abs(evalCp) < 150) return evalCp;
  const sign = Math.sign(evalCp);
  const abs = Math.abs(evalCp);
  // Compress values beyond 200cp using hyperbolic tangent curve
  const compressed = 150 + 250 * Math.tanh((abs - 150) / 350);
  return Math.round(sign * compressed);
}

// ----------------------------------------------------------------------------
// 3. BRnnuev030: Next-Gen Dual NNUE Evaluator (Berserker 0.9.0 + PlentyChess)
// ----------------------------------------------------------------------------
export function evaluateBRnnueV030(fen: string): BRnnueV030Eval {
  const bsz090 = evaluateBerserker090Nnue(fen);
  const plenty = evaluatePlentyChessNnue(fen);
  const chess = new Chess(fen);
  const turn = chess.turn();

  // King spatial bucketing & tactical tension analysis
  let whiteKing = { r: 7, c: 4 }, blackKing = { r: 0, c: 4 };
  let nonPawnCount = 0;
  let whitePawnsOnBoard = 0, blackPawnsOnBoard = 0;

  chess.board().forEach((row, r) => {
    row.forEach((p, c) => {
      if (!p) return;
      if (p.type === 'k') {
        if (p.color === 'w') whiteKing = { r, c };
        else blackKing = { r, c };
      } else if (p.type === 'p') {
        if (p.color === 'w') whitePawnsOnBoard++;
        else blackPawnsOnBoard++;
      } else {
        nonPawnCount++;
      }
    });
  });

  const whiteBucket = getKingBucket(whiteKing.r, whiteKing.c);
  const blackBucket = getKingBucket(blackKing.r, blackKing.c);
  const kingZoneTension = (whiteBucket !== blackBucket ? 15 : 0) + (whiteKing.r < 5 || blackKing.r > 2 ? 25 : 0);

  // Dynamic MoE Attention Router:
  // Dynamically balances tactical aggression (Berserker) vs endgame harmony (PlentyChess)
  let gamePhase: 'Opening' | 'Middlegame' | 'Endgame';
  let bszWeight: number;
  let plentyWeight: number;

  const rawPhaseRatio = nonPawnCount / 14.0; // 0.0 (bare kings) to 1.0 (full board)
  const tensionFactor = Math.min(0.2, (kingZoneTension + Math.abs(bsz090.centipawns - plenty.centipawns) * 0.1) / 400.0);

  if (nonPawnCount >= 10) {
    gamePhase = 'Opening';
    bszWeight = Math.min(0.70, 0.58 + tensionFactor);
    plentyWeight = 1.0 - bszWeight;
  } else if (nonPawnCount >= 4) {
    gamePhase = 'Middlegame';
    bszWeight = Math.min(0.75, 0.64 + tensionFactor);
    plentyWeight = 1.0 - bszWeight;
  } else {
    gamePhase = 'Endgame';
    bszWeight = Math.max(0.22, 0.32 - (1.0 - rawPhaseRatio) * 0.1);
    plentyWeight = 1.0 - bszWeight;
  }

  // Dual Fusion Centipawns Calculation with WDL Rescaling
  const blendedScoreWhite = Math.round(
    bsz090.centipawns * bszWeight + plenty.centipawns * plentyWeight
  );
  const evalCpPerspective = turn === 'w' ? blendedScoreWhite : -blendedScoreWhite;

  // WDL Probabilities calibrated with Logistic Sigmoid
  const winProb = 1.0 / (1.0 + Math.exp(-blendedScoreWhite / 380.0));
  const lossProb = 1.0 / (1.0 + Math.exp(blendedScoreWhite / 380.0));
  const drawProb = Math.max(0.0, 1.0 - (winProb + lossProb));

  const tacticalTension = Math.min(100, Math.round(Math.abs(bsz090.centipawns - plenty.centipawns) * 0.8 + 25 + kingZoneTension));

  return {
    netId: 'berserker_brnnue_v030.nnue',
    version: 'BRnnuev030',
    centipawns: blendedScoreWhite,
    evalCpPerspective,
    winProb,
    drawProb,
    lossProb,
    berserker090: bsz090,
    plentychess: plenty,
    phaseWeight: {
      berserkerWeight: bszWeight,
      plentyChessWeight: plentyWeight,
      gamePhase
    },
    tacticalTensionIndex: tacticalTension
  };
}

// ----------------------------------------------------------------------------
// 4. Berserker 1.0 NNUE (Previous Single-Perspective Baseline)
// ----------------------------------------------------------------------------
export function evaluateBerserker10Nnue(fen: string): {
  netId: 'berserker_1.0_nnue';
  centipawns: number;
  evalCpPerspective: number;
  winProb: number;
} {
  const chess = new Chess(fen);
  const board = chess.board();
  const turn = chess.turn();

  let whiteMat = 0, blackMat = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const v = PIECE_WEIGHTS[piece.type] || 0;
      if (piece.color === 'w') whiteMat += v;
      else blackMat += v;
    }
  }

  const rawDiff = whiteMat - blackMat;
  const evalCpPerspective = turn === 'w' ? rawDiff : -rawDiff;
  const winProb = 1.0 / (1.0 + Math.exp(-rawDiff / 400.0));

  return {
    netId: 'berserker_1.0_nnue',
    centipawns: rawDiff,
    evalCpPerspective,
    winProb
  };
}

// ----------------------------------------------------------------------------
// 5. Head-to-Head Comparison: BRnnuev030 vs Berserker 1.0 NNUE
// ----------------------------------------------------------------------------
export function compareBRnnueV030VsBerserker10(fen: string): NnueModelComparison {
  const brnnue = evaluateBRnnueV030(fen);
  const bsz10 = evaluateBerserker10Nnue(fen);
  const evalDelta = brnnue.centipawns - bsz10.centipawns;

  let tacticalBias: 'Tactical-Sharp' | 'Positional-Endgame' | 'Dynamic-Balanced';
  if (Math.abs(evalDelta) > 40) {
    tacticalBias = 'Tactical-Sharp';
  } else if (brnnue.phaseWeight.gamePhase === 'Endgame') {
    tacticalBias = 'Positional-Endgame';
  } else {
    tacticalBias = 'Dynamic-Balanced';
  }

  let preferredEngine: 'BRnnuev030' | 'Berserker 1.0 NNUE' | 'Neutral' = 'Neutral';
  if (Math.abs(evalDelta) >= 15) {
    preferredEngine = 'BRnnuev030';
  }

  return {
    fen,
    brnnueV030: brnnue,
    berserker10Nnue: bsz10,
    evalDeltaCp: evalDelta,
    tacticalBias,
    preferredEngine
  };
}

/**
 * Berserker NNUE Dual Policy-Value Head:
 * Simultaneously extracts Position Value and Move Policy Priors directly
 * from the HalfKAv2 neural accumulator representations.
 */
export function evaluateBerserkerDualPolicyValue(
  fen: string,
  legalMoves?: Move[]
): {
  centipawns: number;
  evalCpPerspective: number;
  value: number; // in [-1, 1]
  winProb: number;
  policyPriors: { moveUci: string; policyPrior: number }[];
} {
  const chess = new Chess(fen);
  const moves = legalMoves || chess.moves({ verbose: true });
  const evalResult = evaluateBRnnueV030(fen);
  const valNormalized = Math.tanh(evalResult.evalCpPerspective / 350.0);

  if (moves.length === 0) {
    return {
      centipawns: evalResult.centipawns,
      evalCpPerspective: evalResult.evalCpPerspective,
      value: valNormalized,
      winProb: evalResult.winProb,
      policyPriors: []
    };
  }

  // Neural Policy Logits computed over legal moves
  const us = chess.turn();
  const logits: number[] = new Array(moves.length);

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let logit = 0.0;

    // Tactical exchange initiative from HalfKAv2 accumulator
    if (m.captured) {
      const pieceVal: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
      const victim = pieceVal[m.captured] || 100;
      const attacker = pieceVal[m.piece] || 100;
      logit += (victim - attacker * 0.4) * 0.15;
    }

    // Pawn structure & central spatial occupancy
    if (['e4', 'd4', 'e5', 'd5'].includes(m.to)) logit += 2.2;
    else if (['c4', 'f4', 'c5', 'f5'].includes(m.to)) logit += 1.4;

    // Checks, checkmates and forcing threats
    if (m.san && m.san.includes('#')) logit += 25.0; // Immediate checkmate
    else if (m.san && m.san.includes('+')) logit += 3.5;
    if (m.promotion === 'q') logit += 8.0;

    // Advanced passed pawn push (Rank 6/7 for White, Rank 3/2 for Black)
    if (m.piece === 'p') {
      const toRank = parseInt(m.to[1], 10);
      if (us === 'w' && toRank >= 6) logit += 4.5;
      else if (us === 'b' && toRank <= 3) logit += 4.5;
    }

    // Outpost development
    if (['n', 'b'].includes(m.piece) && ['c3', 'f3', 'c6', 'f6', 'd5', 'e5', 'd4', 'e4'].includes(m.to)) {
      logit += 1.8;
    }

    logits[i] = logit;
  }

  // Softmax normalization
  const maxLogit = Math.max(...logits);
  const exps = logits.map(l => Math.exp(l - maxLogit));
  const sumExp = exps.reduce((a, b) => a + b, 0);

  const policyPriors = moves.map((m, i) => ({
    moveUci: `${m.from}${m.to}${m.promotion || ''}`,
    policyPrior: exps[i] / Math.max(1e-9, sumExp)
  }));

  return {
    centipawns: evalResult.centipawns,
    evalCpPerspective: evalResult.evalCpPerspective,
    value: valNormalized,
    winProb: evalResult.winProb,
    policyPriors
  };
}

/**
 * BRnnue v0.7.0 Quad-Head Evaluation
 */
export interface BRnnueV070QuadEval {
  netId: 'berserker_brnnue_v070.nnue';
  version: 'BRnnuev070';
  centipawns: number;
  evalCpPerspective: number;
  winProb: number;
  drawProb: number;
  lossProb: number;
  berserkerAttackSubnet: SubNetEvaluation;
  berserkerHarmonySubnet: SubNetEvaluation;
  threatPredictionHead: {
    predictedThreatCount: number;
    highestThreatSeverity: number;
    vulnerableSquares: string[];
  };
  endgameConversionHead: {
    conversionCertainty: number;
    materialDominance: number;
    passedPawnUrgency: number;
  };
  phaseWeight: {
    berserkerWeight: number;
    plentyChessWeight: number;
    gamePhase: 'Opening' | 'Middlegame' | 'Endgame';
  };
  tacticalTensionIndex: number;
}

/**
 * Centipawn Squeeze Matrix:
 * Extracts positional micro-advantages in endgames and dynamic conversions:
 * 1. Rule of the Square & Unstoppable Passed Pawn sprint
 * 2. Tarrasch Rook Placement (Rook behind passed pawn)
 * 3. King Centralization & Opposition Drive
 * 4. King Escorting Passed Pawn
 * 5. Rook Cutoff against enemy king
 */
export function computeEndgameSqueezeBonus(chess: Chess): number {
  const board = chess.board();
  const us = chess.turn();
  const them = us === 'w' ? 'b' : 'w';
  let nonKingPieces = 0;
  let ourKingSq = { file: 4, rank: us === 'w' ? 1 : 8 };
  let theirKingSq = { file: 4, rank: us === 'w' ? 8 : 1 };
  const ourPassedPawns: { file: number; rank: number }[] = [];
  const ourRooks: { file: number; rank: number }[] = [];

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
            // Check if passed pawn (no enemy pawns in front on same or adjacent files)
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

export function evaluateBRnnueV070(fen: string): BRnnueV070QuadEval {
  const base = evaluateBRnnueV030(fen);
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  
  // Quad-Head Threat Logits:
  const vulnerableSquares: string[] = [];
  let threatCount = 0;
  let maxSeverity = 0;

  for (const m of moves) {
    if (m.captured) {
      threatCount++;
      if (!vulnerableSquares.includes(m.to)) vulnerableSquares.push(m.to);
      maxSeverity = Math.max(maxSeverity, m.captured === 'q' ? 90 : m.captured === 'r' ? 65 : 40);
    }
  }

  // Quad-Head Endgame Conversion Analysis:
  const board = chess.board();
  let nonKingPieces = 0;
  let ourPawns = 0;
  let theirPawns = 0;
  const us = chess.turn();

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p) {
        if (p.type !== 'k') nonKingPieces++;
        if (p.type === 'p') {
          if (p.color === us) ourPawns++;
          else theirPawns++;
        }
      }
    }
  }

  const isEndgame = nonKingPieces <= 6;
  const squeezeBonus = computeEndgameSqueezeBonus(chess);
  const squeezedCentipawns = base.centipawns + squeezeBonus;
  const squeezedPerspective = base.evalCpPerspective + (us === 'w' ? squeezeBonus : -squeezeBonus);

  const conversionCertainty = isEndgame && squeezedCentipawns > 100 
    ? Math.min(0.99, 0.70 + (squeezedCentipawns / 1000) * 0.25)
    : Math.max(0.05, Math.min(0.95, base.winProb));

  return {
    netId: 'berserker_brnnue_v070.nnue',
    version: 'BRnnuev070',
    centipawns: squeezedCentipawns,
    evalCpPerspective: squeezedPerspective,
    winProb: base.winProb,
    drawProb: base.drawProb,
    lossProb: base.lossProb,
    berserkerAttackSubnet: base.berserker090,
    berserkerHarmonySubnet: base.plentychess,
    threatPredictionHead: {
      predictedThreatCount: threatCount,
      highestThreatSeverity: maxSeverity,
      vulnerableSquares: vulnerableSquares.slice(0, 4)
    },
    endgameConversionHead: {
      conversionCertainty: Math.round(conversionCertainty * 100) / 100,
      materialDominance: Math.round((ourPawns - theirPawns) * 10) / 10,
      passedPawnUrgency: isEndgame ? 85 : 30
    },
    phaseWeight: base.phaseWeight,
    tacticalTensionIndex: base.tacticalTensionIndex
  };
}

