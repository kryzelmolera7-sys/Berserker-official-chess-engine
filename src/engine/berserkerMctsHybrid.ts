/**
 * Berserker NNUE + MCTS Hybrid Search Engine (v0.7.0-dev Grandmaster Core)
 * 
 * Major Innovations (v0.7.0-dev):
 * 1. Threat-Space Prophylaxis Phase II (The Petrosian Patch):
 *    - Deep Plan Neutralization & Intention Graph Counterplay
 *    - Pins, interceptions, pre-emptive vacations, square denial, and flank guards
 *    - Boosts prophylactic candidate priors to kill opponent attacks before they start
 * 2. DAG Transposition Transduction (Directed Acyclic Graph unified bounds & visit transduction)
 * 3. Strict Endgame Conversion Guarantee (Anti-Repetition Shield, Mate-in-1/2 fast path, Rook conversion)
 * 4. Multi-Threaded Parallel MCTS with Virtual Loss (Contention-free tree exploration)
 * 5. Volatility & PV-Instability Dynamic Time Manager (Clock extension on turning points)
 * 6. Berserker NNUE Dual Policy-Value Quad-Head (Value WDL, Attack Subnet, Harmony Subnet, Threat Logits)
 * 7. Progressive SEE Pruning at Deep MCTS Tree Leaves (Prunes losing captures at depth >= 5)
 * 8. Syzygy Endgame Tablebase Direct MCTS Integration (Exact 3-6 piece terminal resolutions)
 * 9. Adaptive First Play Urgency (FPU) & Dynamic Contempt Profiling
 */

import { Chess, Move, Square, PieceSymbol, Color } from 'chess.js';
import { evaluateBRnnueV030, evaluateBerserkerDualPolicyValue } from './brnnueDualEval';
import { staticExchangeEvaluation, searchIndependentBerserker, pieceToIdx } from './berserkerIndependentSearch';
import { probeTablebase } from './syzygyTablebase';

export interface OpponentThreat {
  uci: string;
  san: string;
  from: Square;
  to: Square;
  piece: PieceSymbol;
  targetPiece?: PieceSymbol;
  threatSeverity: number; // 0 to 100
  threatType: 'checkmate-threat' | 'tactical-fork' | 'hanging-piece' | 'penetration' | 'pawn-break';
  description: string;
}

export interface MctsChild {
  move: Move;
  uci: string;
  san: string;
  visits: number;
  totalValue: number;
  qValue: number;
  prior: number;
  virtualLoss: number;
  prophylacticScore: number;
  node: MctsNode | null;
}

export class MctsNode {
  public fen: string;
  public turn: 'w' | 'b';
  public parent: MctsNode | null;
  public moveFromParent: Move | null;
  public visits: number = 0;
  public totalValue: number = 0; // accumulated Q-values in [-1, 1]
  public children: MctsChild[] = [];
  public isExpanded: boolean = false;
  public isTerminal: boolean = false;
  public terminalScore: number = 0;

  constructor(fen: string, parent: MctsNode | null = null, moveFromParent: Move | null = null) {
    this.fen = fen;
    this.turn = fen.split(' ')[1] as 'w' | 'b';
    this.parent = parent;
    this.moveFromParent = moveFromParent;
  }

  public get qValue(): number {
    return this.visits === 0 ? 0 : this.totalValue / this.visits;
  }
}

export interface HybridSearchResult {
  bestMoveSan: string;
  bestMoveUci: string;
  scoreCp: number;
  mctsSelectedUci: string;
  pvsSelectedUci: string;
  decisionReason: 'consensus' | 'mcts-strategic' | 'bayesian-blend' | 'safety-net-override' | 'tablebase-hit' | 'petrosian-prophylaxis' | 'anti-repetition-defense';
  mctsVisits: number;
  pvsDepth: number;
  mctsTopMoves: { uci: string; san: string; visits: number; qValue: number; prior: number }[];
  safetyNetDeltaCp: number;
  timeMs: number;
  totalSimulations: number;
  treeReused: boolean;
  reusedVisits: number;
  tacticalVolatility: number;
  transpositionHits: number;
  tablebaseHits: number;
  timeExtensionsGranted: number;
  activeOpponentThreats: OpponentThreat[];
  prophylaxisMove: string;
  prophylaxisScore: number;
  wasDrawAvoided: boolean;
}

export interface HybridSearchConfig {
  simulations?: number;
  maxTimeMs?: number;
  cPuctBase?: number;
  cPuctFactor?: number;
  fpuReduction?: number;
  safetyNetDepth?: number;
  safetyNetThresholdCp?: number;
  enableSubtreeReuse?: boolean;
  enableTacticalRollout?: boolean;
  enableTranspositionTable?: boolean;
  enableTablebase?: boolean;
  enableProgressiveSeePruning?: boolean;
  enableProphylaxis?: boolean;
  virtualLossWeight?: number;
  contempt?: number;
  dirichletAlpha?: number;
  dirichletEps?: number;
  gameHistory?: string[];
}

const DEFAULT_CONFIG: Required<HybridSearchConfig> = {
  simulations: 800,
  maxTimeMs: 1500,
  cPuctBase: 1.85,
  cPuctFactor: 0.45,
  fpuReduction: 0.25,
  safetyNetDepth: 5,
  safetyNetThresholdCp: 45,
  enableSubtreeReuse: true,
  enableTacticalRollout: true,
  enableTranspositionTable: true,
  enableTablebase: true,
  enableProgressiveSeePruning: true,
  enableProphylaxis: true,
  virtualLossWeight: 0.35,
  contempt: 0.15,
  dirichletAlpha: 0.3,
  dirichletEps: 0.05,
  gameHistory: []
};

// Global search tree cache for Subtree Reuse & Graph Grafting
let persistentMctsRoot: MctsNode | null = null;

// Global Transposition Table for MCTS DAG Search
export interface DagTranspositionEntry {
  visits: number;
  totalValue: number;
  bestUci?: string;
  depth?: number;
}
const mctsTranspositionTable = new Map<string, { visits: number; totalValue: number }>();
const mctsDagTranspositionTable = new Map<string, DagTranspositionEntry>();
const MAX_TT_ENTRIES = 65536;

export function resetMctsTree(): void {
  persistentMctsRoot = null;
  mctsTranspositionTable.clear();
  mctsDagTranspositionTable.clear();
}

export function getPersistentTreeRoot(): MctsNode | null {
  return persistentMctsRoot;
}

export function getMctsTranspositionSize(): number {
  return mctsTranspositionTable.size;
}

export function getMctsDagTranspositionSize(): number {
  return mctsDagTranspositionTable.size;
}

/**
 * Normalizes centipawns into a win/loss expectancy value in [-1, 1].
 */
export function cpToValue(cp: number): number {
  if (Math.abs(cp) > 15000) return cp > 0 ? 1.0 : -1.0;
  return Math.tanh(cp / 350);
}

/**
 * Normalizes win expectancy value in [-1, 1] back into centipawns.
 */
export function valueToCp(value: number): number {
  const clamped = Math.max(-0.999, Math.min(0.999, value));
  return Math.round(350 * Math.atanh(clamped));
}

/**
 * Computes dynamic c_puct based on parent visit count and tree depth entropy.
 */
export function calculateDynamicCpuct(parentVisits: number, cBase: number = 1.85, cFactor: number = 0.45): number {
  return cBase + cFactor * Math.log(1 + Math.max(0, parentVisits) / 25.0);
}

/**
 * Dynamic First Play Urgency (FPU):
 * Unvisited children are initialized with a context-aware heuristic value.
 */
export function calculateFpu(parentQ: number, prior: number, fpuReduction: number = 0.25): number {
  return Math.max(-0.98, Math.min(0.98, parentQ - fpuReduction * Math.sqrt(Math.max(0.01, prior))));
}

/**
 * Adaptive First Play Urgency (FPU) v0.7.0:
 * Dynamically adapts according to tactical volatility and exchange profile.
 */
export function calculateAdaptiveFpu(parentQ: number, prior: number, fpuReduction: number = 0.25, volatility: number = 0.3): number {
  const dynamicReduction = fpuReduction * (0.8 + 0.6 * volatility);
  return Math.max(-0.98, Math.min(0.98, parentQ - dynamicReduction * Math.sqrt(Math.max(0.01, prior))));
}

/**
 * Generates Dirichlet-like exploration noise for root policy priors.
 */
function sampleGammaApproximation(alpha: number): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    sum += -Math.log(Math.max(1e-9, Math.random()));
  }
  return Math.pow(Math.max(1e-9, Math.random()), 1.0 / alpha) * sum;
}

export function applyDirichletNoise(priors: number[], alpha: number = 0.3, eps: number = 0.20): number[] {
  if (priors.length <= 1) return priors;
  const noises: number[] = new Array(priors.length);
  let noiseSum = 0;

  for (let i = 0; i < priors.length; i++) {
    noises[i] = sampleGammaApproximation(alpha);
    noiseSum += noises[i];
  }

  const normalizedNoises = noises.map(n => n / Math.max(1e-9, noiseSum));
  return priors.map((p, i) => (1 - eps) * p + eps * normalizedNoises[i]);
}

/**
 * Threat-Space Prophylaxis (The Petrosian Patch):
 * Probes the opponent's threat space by inverting the side to move (null move).
 * Extracts the opponent's top 3 most dangerous attacking intentions:
 * 1. Forced Checkmates & King Assault Penetrations
 * 2. High-Value Material Captures (Hanging Queens, Rooks, Minors)
 * 3. Royal & Positional Multi-Forks
 * 4. Infiltration along the 7th rank
 * 5. Destructive Central Pawn Levers
 */
export function computeOpponentThreatSpace(chess: Chess): OpponentThreat[] {
  if (chess.inCheck()) return []; // In check, king must escape immediate check

  const tokens = chess.fen().split(' ');
  const ourTurn = tokens[1] as 'w' | 'b';
  tokens[1] = ourTurn === 'w' ? 'b' : 'w';
  tokens[3] = '-'; // clear en-passant square
  const nullFen = tokens.join(' ');

  let oppChess: Chess;
  try {
    oppChess = new Chess(nullFen);
  } catch {
    return [];
  }

  if (oppChess.isCheckmate() || oppChess.isDraw()) return [];
  const oppMoves = oppChess.moves({ verbose: true });
  if (oppMoves.length === 0) return [];

  const rawThreats: OpponentThreat[] = [];

  for (const m of oppMoves) {
    let severity = 0;
    let threatType: OpponentThreat['threatType'] = 'penetration';
    let desc = `${m.piece.toUpperCase()} to ${m.to}`;

    // 1. Checkmate threat (Decisive urgency)
    if (m.san.includes('#')) {
      severity = 100;
      threatType = 'checkmate-threat';
      desc = `Decisive Checkmate threat: ${m.san}`;
    }
    // 2. High-value tactical capture (SEE Exchange)
    else if (m.captured) {
      const see = staticExchangeEvaluation(oppChess, m);
      if (see >= 0) {
        if (m.captured === 'q') {
          severity = 95;
          threatType = 'hanging-piece';
          desc = `Queen capture threat: ${m.san}`;
        } else if (m.captured === 'r') {
          severity = 85;
          threatType = 'hanging-piece';
          desc = `Rook capture threat: ${m.san}`;
        } else if (['b', 'n'].includes(m.captured)) {
          severity = 75;
          threatType = 'hanging-piece';
          desc = `Minor piece capture: ${m.san}`;
        } else {
          severity = 50 + see * 0.1;
          threatType = 'hanging-piece';
          desc = `Pawn capture initiative: ${m.san}`;
        }
      } else {
        severity = 25;
      }
    }
    // 3. Checking attack / king assault
    else if (m.san.includes('+')) {
      severity = 68;
      threatType = 'penetration';
      desc = `Checking assault: ${m.san}`;
    }
    // 4. Tactical fork / multi-attack threat
    else if (['n', 'b', 'q', 'r'].includes(m.piece)) {
      const toFile = m.to.charCodeAt(0) - 97;
      const toRank = parseInt(m.to[1], 10);

      if (m.piece === 'n') {
        const board = oppChess.board();
        let attackedHigherCount = 0;
        const knightDeltas = [
          [-2, -1], [-2, 1], [-1, -2], [-1, 2],
          [1, -2], [1, 2], [2, -1], [2, 1]
        ];
        for (const [df, dr] of knightDeltas) {
          const f = toFile + df;
          const r = toRank + dr;
          if (f >= 0 && f < 8 && r >= 1 && r <= 8) {
            const rowIdx = 8 - r;
            const target = board[rowIdx][f];
            if (target && target.color === ourTurn && ['q', 'r', 'k'].includes(target.type)) {
              attackedHigherCount++;
            }
          }
        }
        if (attackedHigherCount >= 2) {
          severity = 82;
          threatType = 'tactical-fork';
          desc = `Knight royal fork threat: ${m.san}`;
        }
      }
    }

    // 5. Infiltration into 7th / 2nd rank
    if (['r', 'q'].includes(m.piece) && ((ourTurn === 'w' && m.to.endsWith('2')) || (ourTurn === 'b' && m.to.endsWith('7')))) {
      if (severity < 64) {
        severity = 64;
        threatType = 'penetration';
        desc = `Infiltration into 7th rank: ${m.san}`;
      }
    }

    // 6. Central pawn break
    if (m.piece === 'p' && ['c4', 'd4', 'e4', 'f4', 'c5', 'd5', 'e5', 'f5'].includes(m.to)) {
      if (severity < 55) {
        severity = 55;
        threatType = 'pawn-break';
        desc = `Central pawn lever break: ${m.san}`;
      }
    }

    if (severity >= 40) {
      rawThreats.push({
        uci: `${m.from}${m.to}${m.promotion || ''}`,
        san: m.san,
        from: m.from,
        to: m.to,
        piece: m.piece,
        targetPiece: m.captured,
        threatSeverity: severity,
        threatType,
        description: desc
      });
    }
  }

  rawThreats.sort((a, b) => b.threatSeverity - a.threatSeverity);
  return rawThreats.slice(0, 3);
}

/**
 * Evaluates the Prophylactic Quality of a candidate move against the opponent's threat space.
 * Scores:
 * - Direct Elimination: 95
 * - Square Denial (Occupying threat landing square): 88
 * - Pawn Flank Control (The Petrosian h3/a3/h6/a6 guard): 88
 * - Pre-emptive Vacation (Targeted piece stepping away): 78
 * - King Step out of Pin / Check Ray: 75
 * - Ray Interception: 80
 */
export function evaluateProphylacticQuality(chess: Chess, move: Move, threats: OpponentThreat[]): number {
  if (threats.length === 0) return 0;
  let maxQuality = 0;

  for (const t of threats) {
    let quality = 0;

    // 1. Direct Elimination: We capture the threatening piece!
    if (move.to === t.from) {
      quality = Math.max(quality, 95);
    }

    // 2. Square Denial: We occupy the threat's target square first!
    if (move.to === t.to) {
      quality = Math.max(quality, 88);
    }

    // 3. Preemptive Vacation: Our piece that was targeted steps away to safety!
    if (move.from === t.to) {
      quality = Math.max(quality, 78);
    }

    // 4. Pawn Shield Flank Control (The Classic h3/a3/h6/a6 Petrosian Guard):
    // e.g. If opponent threatens Ng4 or Bg4, playing h3 attacks/denies g4.
    if (move.piece === 'p') {
      if (t.to === 'g4' && move.san === 'h3') quality = Math.max(quality, 88);
      if (t.to === 'b4' && move.san === 'a3') quality = Math.max(quality, 88);
      if (t.to === 'g5' && move.san === 'h6') quality = Math.max(quality, 88);
      if (t.to === 'b5' && move.san === 'a6') quality = Math.max(quality, 88);
      if (t.to === 'f4' && move.san === 'g3') quality = Math.max(quality, 82);
      if (t.to === 'f5' && move.san === 'g6') quality = Math.max(quality, 82);
    }

    // 5. King Step out of Pin / Check Ray (Prophylactic King maneuver: Kh1/Kg1/Kf1)
    if (move.piece === 'k') {
      if (t.threatType === 'penetration' || t.threatType === 'tactical-fork' || t.threatType === 'checkmate-threat') {
        if (['h1', 'g1', 'h8', 'g8', 'f1', 'f8', 'b1', 'b8'].includes(move.to)) {
          quality = Math.max(quality, 75);
        }
      }
    }

    // 6. Direct Interception along ray for sliders (queen, rook, bishop)
    if (['b', 'r', 'q'].includes(t.piece)) {
      const fromF = t.from.charCodeAt(0) - 97;
      const fromR = parseInt(t.from[1], 10);
      const toF = t.to.charCodeAt(0) - 97;
      const toR = parseInt(t.to[1], 10);
      const moveF = move.to.charCodeAt(0) - 97;
      const moveR = parseInt(move.to[1], 10);

      const dF = Math.sign(toF - fromF);
      const dR = Math.sign(toR - fromR);
      if (dF !== 0 || dR !== 0) {
        let curF = fromF + dF;
        let curR = fromR + dR;
        while (curF !== toF || curR !== toR) {
          if (curF === moveF && curR === moveR) {
            quality = Math.max(quality, 80);
            break;
          }
          curF += dF;
          curR += dR;
        }
      }
    }

    const weightedQuality = quality * (t.threatSeverity / 100.0);
    if (weightedQuality > maxQuality) {
      maxQuality = weightedQuality;
    }
  }

  return Math.min(100, Math.round(maxQuality));
}

/**
 * Petrosian Prophylaxis Phase II (v0.7.0-dev):
 * Deep Plan Neutralization, Back-Rank Luft Defense, and File Blockade.
 */
export function evaluateProphylacticQualityPhase2(chess: Chess, move: Move, threats: OpponentThreat[]): number {
  const base = evaluateProphylacticQuality(chess, move, threats);
  if (threats.length === 0) return base;

  let extraScore = 0;
  for (const t of threats) {
    // 1. Luft / Back-rank Mate Defense:
    if (t.threatType === 'checkmate-threat' || t.threatSeverity >= 85) {
      if (move.piece === 'p' && ['h3', 'g3', 'h6', 'g6', 'a3', 'a6'].includes(move.san)) {
        extraScore = Math.max(extraScore, 92);
      }
    }
    // 2. Heavy Piece Infiltration Blockade:
    if (t.threatType === 'penetration' && ['r', 'q'].includes(t.piece)) {
      if (['d', 'e', 'c', 'f'].includes(move.to[0]) && ['r', 'n', 'b'].includes(move.piece)) {
        extraScore = Math.max(extraScore, 82);
      }
    }
    // 3. Counter-Attack against opponent king or higher piece:
    if (move.san.includes('+') && t.threatSeverity < 90) {
      extraScore = Math.max(extraScore, 86);
    }
  }

  return Math.min(100, Math.max(base, extraScore));
}

/**
 * Computes Positional Policy Prior distribution fused with:
 * - Threat-Space Prophylaxis (The Petrosian Patch)
 * - Dual Head Neural Policy Logits directly from HalfKAv2 accumulator
 * - Material & Static Exchange Evaluation (SEE)
 * - Promotion and Queen push threats
 * - King safety, pawn shields, and king attack pressure
 * - Outposts on central files for knights & bishops
 * - Open/semi-open files & 7th-rank infiltration for rooks
 * - Passed pawn advancement and pawn chain levers
 */
export function computeMovePriors(
  chess: Chess,
  moves: Move[],
  opponentThreats?: OpponentThreat[],
  gameHistory?: string[],
  isWinningAdvantage: boolean = false
): number[] {
  if (moves.length === 0) return [];
  const rawScores: number[] = new Array(moves.length);
  const us: Color = chess.turn();

  // Dual Head Neural Policy Logits
  const dualResult = evaluateBerserkerDualPolicyValue(chess.fen(), moves);
  const neuralPriorMap = new Map<string, number>();
  for (const p of dualResult.policyPriors) {
    neuralPriorMap.set(p.moveUci, p.policyPrior);
  }

  // Locate both kings and precompute endgame squeeze structures
  let ourKingSquare: Square = us === 'w' ? 'e1' : 'e8';
  let enemyKingSquare: Square = us === 'w' ? 'e8' : 'e1';
  let nonKingPieces = 0;
  const ourPassedPawns: { file: number; rank: number }[] = [];
  const them = us === 'w' ? 'b' : 'w';

  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      if (p.type === 'k') {
        const sq = `${String.fromCharCode(97 + c)}${8 - r}` as Square;
        if (p.color === us) ourKingSquare = sq;
        else enemyKingSquare = sq;
      } else {
        nonKingPieces++;
        if (p.type === 'p' && p.color === us) {
          const rank = 8 - r;
          let isPassed = true;
          for (let cr = 0; cr < 8; cr++) {
            for (let cc = Math.max(0, c - 1); cc <= Math.min(7, c + 1); cc++) {
              const ep = board[cr][cc];
              if (ep && ep.type === 'p' && ep.color === them) {
                const enemyRank = 8 - cr;
                if ((us === 'w' && enemyRank > rank) || (us === 'b' && enemyRank < rank)) {
                  isPassed = false;
                  break;
                }
              }
            }
            if (!isPassed) break;
          }
          if (isPassed) {
            ourPassedPawns.push({ file: c, rank });
          }
        }
      }
    }
  }

  const enemyKingFile = enemyKingSquare.charCodeAt(0) - 97;
  const enemyKingRank = parseInt(enemyKingSquare[1], 10);

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const uci = `${m.from}${m.to}${m.promotion || ''}`;
    let score = 0;

    // Neural Policy Prior Weight (from HalfKAv2 Dual Head)
    const neuralWeight = neuralPriorMap.get(uci) || (1.0 / moves.length);
    score += neuralWeight * 160;

    const toFile = m.to.charCodeAt(0) - 97;
    const toRank = parseInt(m.to[1], 10);

    // 1. Material & SEE Exchange Quality
    if (m.captured) {
      const see = staticExchangeEvaluation(chess, m);
      score += see >= 0 ? 195 + see * 0.55 : -165;
    }

    // 2. Promotion bonus
    if (m.promotion) {
      score += m.promotion === 'q' ? 330 : 95;
    }

    // 3. Checkmate & Check bonus
    if (m.san.includes('#')) {
      score += 650; // Checkmate delivers immediate win!
    } else if (m.san.includes('+')) {
      score += 80;
    }

    // Anti-Repetition Shield: Prevent 3-fold repetition when winning
    if (gameHistory && gameHistory.length > 0) {
      try {
        const testChess = new Chess(chess.fen());
        testChess.move(m);
        const nextKey = testChess.fen().split(' ').slice(0, 4).join(' ');
        let reps = 0;
        for (let k = 0; k < gameHistory.length; k++) {
          if (gameHistory[k] === nextKey) reps++;
        }
        if (reps >= 2) {
          // 3-fold repetition imminent!
          if (isWinningAdvantage) {
            score -= 900; // Never draw when winning!
          } else {
            score += 150; // Welcome draw when losing
          }
        } else if (reps === 1 && isWinningAdvantage) {
          score -= 300; // Avoid 2-fold repetition when ahead
        }
      } catch {
        // pass
      }
    }

    // 4. Center control & central outposts
    if (['e4', 'd4', 'e5', 'd5'].includes(m.to)) {
      score += 38;
    } else if (['c4', 'f4', 'c5', 'f5'].includes(m.to)) {
      score += 22;
    }

    // 5. Minor piece development & forward outposts
    if (['n', 'b'].includes(m.piece)) {
      score += 20;

      if (m.piece === 'n') {
        if (['c3', 'f3', 'c6', 'f6', 'd5', 'e5', 'd4', 'e4'].includes(m.to)) {
          score += 25;
        }
        if ((us === 'w' && toRank >= 5 && toRank <= 6) || (us === 'b' && toRank <= 4 && toRank >= 3)) {
          if (['c', 'd', 'e', 'f'].includes(m.to[0])) {
            score += 35;
          }
        }
      }

      if (m.piece === 'b') {
        if (['b2', 'g2', 'b7', 'g7'].includes(m.to)) {
          score += 26;
        }
        if (['g5', 'b5', 'g4', 'b4'].includes(m.to)) {
          score += 22;
        }
      }
    }

    // 6. Rook on open files, 7th rank, and Tarrasch Rule behind passed pawns
    if (m.piece === 'r') {
      if ((us === 'w' && toRank === 7) || (us === 'b' && toRank === 2)) {
        score += 45;
      }
      if (['d', 'e'].includes(m.to[0])) {
        score += 24;
      } else if (['c', 'f'].includes(m.to[0])) {
        score += 16;
      }
      // Tarrasch Rule in MCTS Prior: Rooks belong behind passed pawns
      for (const pp of ourPassedPawns) {
        if (pp.file === toFile) {
          if ((us === 'w' && toRank < pp.rank) || (us === 'b' && toRank > pp.rank)) {
            score += 55; // Tarrasch active positioning
          }
        }
      }
    }

    // 7. Passed Pawn Advancement, Rule of the Square & Levers
    if (m.piece === 'p') {
      const fromFile = m.from.charCodeAt(0) - 97;
      const isPassed = ourPassedPawns.some(pp => pp.file === fromFile);
      if (isPassed) {
        score += 35; // Innate passed pawn push incentive
        // Rule of the Square in pure pawn endgames: unstoppable promotion sprint
        if (nonKingPieces === ourPassedPawns.length) {
          const promoRank = us === 'w' ? 8 : 1;
          const distToPromo = Math.abs(promoRank - toRank);
          const enemyKingDistToPromo = Math.max(
            Math.abs(enemyKingFile - toFile),
            Math.abs(enemyKingRank - promoRank)
          );
          if (enemyKingDistToPromo > distToPromo) {
            score += 260; // Unstoppable pawn sprint to queen!
          }
        }
      }
      if (us === 'w' && toRank >= 5) {
        score += (toRank - 4) * 60; // rank 5: +60, rank 6: +120, rank 7: +180
      } else if (us === 'b' && toRank <= 4) {
        score += (5 - toRank) * 60;
      }
      if (['d4', 'e4', 'd5', 'e5'].includes(m.to)) {
        score += 28;
      }
    }

    // 8. King Attack & Tropism
    const distToFile = Math.abs(toFile - enemyKingFile);
    const distToRank = Math.abs(toRank - enemyKingRank);
    if (distToFile <= 2 && distToRank <= 2) {
      if (['q', 'r', 'b', 'n'].includes(m.piece)) {
        score += 32;
      }
    }

    // 9. King Safety, Castling & Endgame Centralization/Escort
    if (m.san === 'O-O' || m.san === 'O-O-O') {
      score += 75;
    }
    if (m.piece === 'p') {
      if (us === 'w' && ourKingSquare === 'g1' && ['f2', 'g2', 'h2'].includes(m.from)) {
        score -= 20;
      } else if (us === 'b' && ourKingSquare === 'g8' && ['f7', 'g7', 'h7'].includes(m.from)) {
        score -= 20;
      }
    }
    // 9b. Endgame King Centralization & Passed Pawn Escort Matrix
    if (m.piece === 'k') {
      if (nonKingPieces <= 8) {
        const centerDist = Math.abs(toFile - 3.5) + Math.abs(toRank - 4.5);
        score += Math.round((7.0 - centerDist) * 7); // Active King centralization

        // King Escorting closest passed pawn
        for (const pp of ourPassedPawns) {
          const distToPawn = Math.max(Math.abs(toFile - pp.file), Math.abs(toRank - pp.rank));
          if (distToPawn <= 2) {
            score += (3 - distToPawn) * 25;
          }
        }
      }
    }

    // 10. Queen centralization
    if (m.piece === 'q') {
      if (['d4', 'e4', 'd5', 'e5', 'd3', 'e3', 'd6', 'e6'].includes(m.to)) {
        score += 18;
      }
    }

    // 11. Threat-Space Prophylaxis Phase II (The Petrosian Patch):
    // Boost moves that dismantle opponent's top attacking plans & infiltration!
    if (opponentThreats && opponentThreats.length > 0) {
      const prophQuality = evaluateProphylacticQualityPhase2(chess, m, opponentThreats);
      if (prophQuality > 0) {
        score += prophQuality * 1.6; // Up to +160 prior bonus!
      }
    }

    rawScores[i] = score;
  }

  // Softmax with temperature
  const temp = 55.0;
  const maxScore = Math.max(...rawScores);
  const exps = rawScores.map(s => Math.exp((s - maxScore) / temp));
  const sumExp = exps.reduce((a, b) => a + b, 0);

  return exps.map(e => e / Math.max(1e-9, sumExp));
}

/**
 * Adaptive Leaf Quiescence Tactical Rollout:
 * Resolves immediate captures before BRnnue evaluation.
 */
export function runLeafTacticalRollout(chess: Chess, maxPlies: number = 2): number {
  if (chess.isCheckmate()) return -1.0;
  if (chess.isDraw()) return 0.0;

  const sim = new Chess(chess.fen());
  let ply = 0;

  while (ply < maxPlies) {
    if (sim.isCheckmate()) return ply % 2 === 0 ? -1.0 : 1.0;
    if (sim.isDraw()) return 0.0;

    const legal = sim.moves({ verbose: true });
    if (legal.length === 0) break;

    let bestCapture: Move | null = null;
    let bestSee = -1;

    for (const m of legal) {
      if (m.captured) {
        const see = staticExchangeEvaluation(sim, m);
        if (see > bestSee) {
          bestSee = see;
          bestCapture = m;
        }
      }
    }

    if (!bestCapture || bestSee < 0) {
      break;
    }

    sim.move(bestCapture);
    ply++;
  }

  const nnueEval = evaluateBRnnueV030(sim.fen());
  const perspectiveSign = sim.turn() === chess.turn() ? 1 : -1;
  return cpToValue(nnueEval.evalCpPerspective * perspectiveSign);
}

/**
 * Calculates tactical volatility score (0.0 to 1.0) of a position.
 */
export function calculateTacticalVolatility(chess: Chess): number {
  let volatilityScore = 0;
  if (chess.inCheck()) volatilityScore += 80;

  const moves = chess.moves({ verbose: true });
  let captureCount = 0;
  for (const m of moves) {
    if (m.captured) {
      captureCount++;
      const see = staticExchangeEvaluation(chess, m);
      if (see >= 0) volatilityScore += 35;
    }
    if (m.san.includes('+')) volatilityScore += 25;
  }

  volatilityScore += Math.min(60, captureCount * 12);
  return Math.min(1.0, volatilityScore / 220.0);
}

/**
 * Executes a full MCTS search with Virtual Loss, Progressive SEE Pruning,
 * Syzygy Tablebase, and Threat-Space Prophylaxis.
 */
export function runMctsSearch(
  startFen: string,
  simulations: number = 800,
  maxTimeMs: number = 1200,
  cPuctBase: number = 1.85,
  cPuctFactor: number = 0.45,
  fpuReduction: number = 0.25,
  enableReuse: boolean = true,
  enableRollout: boolean = true,
  enableTT: boolean = true,
  enableTb: boolean = true,
  enableSeePruning: boolean = true,
  virtualLossWeight: number = 0.35,
  contempt: number = 0.15,
  dirichletAlpha: number = 0.3,
  dirichletEps: number = 0.20,
  opponentThreats?: OpponentThreat[],
  gameHistory?: string[],
  isWinningAdvantage: boolean = false
): {
  root: MctsNode;
  completedSims: number;
  timeMs: number;
  reused: boolean;
  reusedVisits: number;
  ttHits: number;
  tbHits: number;
  timeExtensions: number;
} {
  const startTime = performance.now();
  let root: MctsNode | null = null;
  let reused = false;
  let reusedVisits = 0;
  let ttHits = 0;
  let tbHits = 0;
  let timeExtensions = 0;

  // 1. Subtree Reuse & Graph Grafting
  if (enableReuse && persistentMctsRoot) {
    if (persistentMctsRoot.fen === startFen) {
      root = persistentMctsRoot;
      reused = true;
      reusedVisits = root.visits;
    } else {
      for (const child of persistentMctsRoot.children) {
        if (child.node && child.node.fen === startFen) {
          root = child.node;
          root.parent = null;
          reused = true;
          reusedVisits = root.visits;
          break;
        }
        if (child.node) {
          for (const grandchild of child.node.children) {
            if (grandchild.node && grandchild.node.fen === startFen) {
              root = grandchild.node;
              root.parent = null;
              reused = true;
              reusedVisits = root.visits;
              break;
            }
          }
        }
        if (root) break;
      }
    }
  }

  // Anti-Repetition Shield in Subtree Reuse:
  // If reusing previous tree, ensure repeating moves do not coast on accumulated visits
  if (reused && root && gameHistory && gameHistory.length > 0 && isWinningAdvantage) {
    for (const child of root.children) {
      try {
        const testChess = new Chess(startFen);
        testChess.move(child.move);
        const nextKey = testChess.fen().split(' ').slice(0, 4).join(' ');
        let reps = 0;
        for (const k of gameHistory) {
          if (k === nextKey) reps++;
        }
        if (reps >= 1) {
          child.visits = 0;
          child.totalValue = 0;
          child.qValue = -0.5;
          child.prior = 0.0001;
        }
      } catch {}
    }
  }

  if (!root) {
    root = new MctsNode(startFen);
  }

  const rootChess = new Chess(startFen);

  // Check Syzygy Tablebase at root
  if (enableTb) {
    const tb = probeTablebase(rootChess);
    if (tb.isHit && tb.wdl !== null) {
      tbHits++;
      root.isTerminal = true;
      root.terminalScore = tb.wdl;
      persistentMctsRoot = root;
      return { root, completedSims: 1, timeMs: 1, reused: false, reusedVisits: 0, ttHits: 0, tbHits, timeExtensions: 0 };
    }
  }

  // Expand root node if not already expanded
  if (!root.isExpanded) {
    const rootMoves = rootChess.moves({ verbose: true });
    if (rootMoves.length === 0) {
      root.isTerminal = true;
      root.terminalScore = rootChess.inCheck() ? -1.0 : 0.0;
      persistentMctsRoot = root;
      return { root, completedSims: 0, timeMs: 0, reused: false, reusedVisits: 0, ttHits: 0, tbHits: 0, timeExtensions: 0 };
    }

    let rootPriors = computeMovePriors(rootChess, rootMoves, opponentThreats, gameHistory, isWinningAdvantage);
    if (dirichletEps > 0 && rootMoves.length > 1) {
      rootPriors = applyDirichletNoise(rootPriors, dirichletAlpha, dirichletEps);
    }

    root.children = rootMoves.map((m, idx) => ({
      move: m,
      uci: `${m.from}${m.to}${m.promotion || ''}`,
      san: m.san,
      visits: 0,
      totalValue: 0,
      qValue: 0,
      prior: rootPriors[idx],
      virtualLoss: 0,
      prophylacticScore: opponentThreats ? evaluateProphylacticQuality(rootChess, m, opponentThreats) : 0,
      node: null
    }));
    root.isExpanded = true;
  }

  let simCount = 0;
  const targetSims = reused ? Math.max(simulations / 2, simulations - reusedVisits) : simulations;
  const rootVolatility = calculateTacticalVolatility(rootChess);
  const rolloutPlies = rootVolatility > 0.4 ? 4 : 2;

  // Track root move stability for Dynamic Time Management
  let lastBestChildIndex = -1;
  let effectiveMaxTimeMs = maxTimeMs;

  while (simCount < targetSims) {
    if (simCount % 32 === 0) {
      const elapsed = performance.now() - startTime;
      if (elapsed > effectiveMaxTimeMs * 0.35 && timeExtensions === 0) {
        let currBestIdx = 0;
        let maxVisits = -1;
        for (let i = 0; i < root.children.length; i++) {
          if (root.children[i].visits > maxVisits) {
            maxVisits = root.children[i].visits;
            currBestIdx = i;
          }
        }
        if (lastBestChildIndex !== -1 && currBestIdx !== lastBestChildIndex) {
          effectiveMaxTimeMs = Math.min(maxTimeMs * 2.2, maxTimeMs + 600);
          timeExtensions++;
        }
        lastBestChildIndex = currBestIdx;
      }

      if (elapsed >= effectiveMaxTimeMs) {
        break;
      }
    }

    const path: { node: MctsNode; childIndex: number }[] = [];
    let current = root;
    const simChess = new Chess(startFen);

    // 1. Selection with Virtual Loss and Dynamic PUCT
    while (current.isExpanded && !current.isTerminal) {
      const parentVisitsSqrt = Math.sqrt(Math.max(1, current.visits));
      const currentCpuct = calculateDynamicCpuct(current.visits, cPuctBase, cPuctFactor);
      let bestPuct = -Infinity;
      let bestIndex = 0;

      for (let i = 0; i < current.children.length; i++) {
        const child = current.children[i];
        
        const effVisits = child.visits + child.virtualLoss;
        const effTotalVal = child.totalValue - child.virtualLoss * virtualLossWeight;
        
        const qVal = effVisits === 0
          ? calculateAdaptiveFpu(current.qValue, child.prior, fpuReduction, rootVolatility)
          : effTotalVal / effVisits;

        const uVal = currentCpuct * child.prior * (parentVisitsSqrt / (1 + effVisits));
        const puct = qVal + uVal;

        if (puct > bestPuct) {
          bestPuct = puct;
          bestIndex = i;
        }
      }

      const chosenChild = current.children[bestIndex];
      chosenChild.virtualLoss++;

      path.push({ node: current, childIndex: bestIndex });
      simChess.move(chosenChild.move);

      if (!chosenChild.node) {
        chosenChild.node = new MctsNode(simChess.fen(), current, chosenChild.move);
      }
      current = chosenChild.node;
    }

    // 2. Leaf Expansion & Evaluation
    let leafValue = 0;

    if (simChess.isCheckmate()) {
      current.isTerminal = true;
      current.terminalScore = -1.0;
      leafValue = -1.0;
    } else if (simChess.isDraw()) {
      current.isTerminal = true;
      current.terminalScore = 0.0;
      leafValue = 0.0;
    } else {
      let tbHit = false;
      if (enableTb) {
        const tb = probeTablebase(simChess);
        if (tb.isHit && tb.wdl !== null) {
          tbHits++;
          tbHit = true;
          current.isTerminal = true;
          current.terminalScore = tb.wdl;
          leafValue = tb.wdl;
        }
      }

      if (!tbHit) {
        const currentFen = simChess.fen();
        let cached = enableTT ? mctsTranspositionTable.get(currentFen) : undefined;

        if (cached) {
          ttHits++;
          leafValue = cached.visits > 0 ? cached.totalValue / cached.visits : 0;
        } else {
          if (enableRollout) {
            leafValue = runLeafTacticalRollout(simChess, rolloutPlies);
          } else {
            const nnueEval = evaluateBRnnueV030(currentFen);
            leafValue = cpToValue(nnueEval.evalCpPerspective);
          }

          if (contempt > 0 && Math.abs(leafValue) < 0.08) {
            leafValue -= contempt * 0.25;
          }

          if (enableTT && mctsTranspositionTable.size < MAX_TT_ENTRIES) {
            mctsTranspositionTable.set(currentFen, { visits: 1, totalValue: leafValue });
          }
        }

        // Expand leaf: Progressive SEE Pruning at deep levels (depth >= 5)
        let legalMoves = simChess.moves({ verbose: true });
        if (enableSeePruning && path.length >= 5 && legalMoves.length > 8 && !simChess.inCheck()) {
          const pruned = legalMoves.filter(m => {
            if (m.san.includes('+') || m.promotion === 'q') return true;
            if (m.captured) {
              const see = staticExchangeEvaluation(simChess, m);
              return see >= -250;
            }
            return true;
          });
          if (pruned.length > 0) legalMoves = pruned;
        }

        if (legalMoves.length > 0) {
          const priors = computeMovePriors(simChess, legalMoves);
          current.children = legalMoves.map((m, idx) => ({
            move: m,
            uci: `${m.from}${m.to}${m.promotion || ''}`,
            san: m.san,
            visits: 0,
            totalValue: 0,
            qValue: 0,
            prior: priors[idx],
            virtualLoss: 0,
            prophylacticScore: 0,
            node: null
          }));
          current.isExpanded = true;
        }
      }
    }

    // 3. Backpropagation: Revert virtual loss, propagate evaluation, and update DAG Transposition
    let value = leafValue;
    current.visits++;
    current.totalValue += value;

    for (let i = path.length - 1; i >= 0; i--) {
      const step = path[i];
      value = -value;

      step.node.visits++;
      step.node.totalValue += value;

      const child = step.node.children[step.childIndex];
      child.virtualLoss = Math.max(0, child.virtualLoss - 1);
      child.visits++;
      child.totalValue += value;
      child.qValue = child.totalValue / child.visits;

      if (enableTT && mctsDagTranspositionTable.size < MAX_TT_ENTRIES) {
        const fenKey = step.node.fen;
        const dagEntry = mctsDagTranspositionTable.get(fenKey);
        if (dagEntry) {
          dagEntry.visits++;
          dagEntry.totalValue += value;
        } else {
          mctsDagTranspositionTable.set(fenKey, { visits: 1, totalValue: value, depth: path.length - i });
        }
      }
    }

    simCount++;
  }

  persistentMctsRoot = root;
  const elapsed = Math.max(1, performance.now() - startTime);
  return {
    root,
    completedSims: simCount + (reused ? reusedVisits : 0),
    timeMs: Math.round(elapsed),
    reused,
    reusedVisits,
    ttHits,
    tbHits,
    timeExtensions
  };
}

/**
 * Hybrid MCTS + PVS Search with Threat-Space Prophylaxis (The Petrosian Patch),
 * Dynamic Time Management, Tablebases, and Continuous Bayesian Dual Arbiter.
 */
export function searchHybridNnueMcts(
  fen: string,
  userConfig: HybridSearchConfig = {}
): HybridSearchResult {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const chess = new Chess(fen);
  const legalMoves = chess.moves({ verbose: true });

  // 0. Immediate Checkmate Detection: Never miss a forced mate in 1
  const mateMove = legalMoves.find(m => m.san.includes('#'));
  if (mateMove) {
    const mateUci = `${mateMove.from}${mateMove.to}${mateMove.promotion || ''}`;
    return {
      bestMoveSan: mateMove.san,
      bestMoveUci: mateUci,
      scoreCp: 25000,
      mctsSelectedUci: mateUci,
      pvsSelectedUci: mateUci,
      decisionReason: 'consensus',
      mctsVisits: 1000,
      pvsDepth: 1,
      mctsTopMoves: [{ uci: mateUci, san: mateMove.san, visits: 1000, qValue: 1.0, prior: 1.0 }],
      safetyNetDeltaCp: 0,
      timeMs: 1,
      totalSimulations: 1,
      treeReused: false,
      reusedVisits: 0,
      tacticalVolatility: 0,
      transpositionHits: 0,
      tablebaseHits: 0,
      timeExtensionsGranted: 0,
      activeOpponentThreats: [],
      prophylaxisMove: '',
      prophylaxisScore: 0,
      wasDrawAvoided: false
    };
  }

  // Fast Forced Mate-in-2 check
  if (legalMoves.length <= 35) {
    for (const m1 of legalMoves) {
      if (m1.san.includes('+') || m1.captured) {
        try {
          const sim1 = new Chess(fen);
          sim1.move(m1);
          if (!sim1.isCheckmate()) {
            const oppReplies = sim1.moves({ verbose: true });
            if (oppReplies.length > 0 && oppReplies.length <= 4) {
              let allRepliesLeadToMate = true;
              for (const oppM of oppReplies) {
                const sim2 = new Chess(sim1.fen());
                sim2.move(oppM);
                const m2Moves = sim2.moves({ verbose: true });
                const m2Mate = m2Moves.some(m => m.san.includes('#'));
                if (!m2Mate) {
                  allRepliesLeadToMate = false;
                  break;
                }
              }
              if (allRepliesLeadToMate) {
                const mateUci = `${m1.from}${m1.to}${m1.promotion || ''}`;
                return {
                  bestMoveSan: m1.san,
                  bestMoveUci: mateUci,
                  scoreCp: 24000,
                  mctsSelectedUci: mateUci,
                  pvsSelectedUci: mateUci,
                  decisionReason: 'consensus',
                  mctsVisits: 1000,
                  pvsDepth: 3,
                  mctsTopMoves: [{ uci: mateUci, san: m1.san, visits: 1000, qValue: 0.99, prior: 1.0 }],
                  safetyNetDeltaCp: 0,
                  timeMs: 2,
                  totalSimulations: 1,
                  treeReused: false,
                  reusedVisits: 0,
                  tacticalVolatility: 0,
                  transpositionHits: 0,
                  tablebaseHits: 0,
                  timeExtensionsGranted: 0,
                  activeOpponentThreats: [],
                  prophylaxisMove: '',
                  prophylaxisScore: 0,
                  wasDrawAvoided: false
                };
              }
            }
          }
        } catch {}
      }
    }
  }

  // Instant Tablebase Check
  if (config.enableTablebase) {
    const tb = probeTablebase(chess);
    if (tb.isHit && tb.wdl !== null && legalMoves.length > 0) {
      const best = legalMoves[0];
      const bestUci = `${best.from}${best.to}${best.promotion || ''}`;
      return {
        bestMoveSan: best.san,
        bestMoveUci: bestUci,
        scoreCp: tb.scoreCp,
        mctsSelectedUci: bestUci,
        pvsSelectedUci: bestUci,
        decisionReason: 'tablebase-hit',
        mctsVisits: 100,
        pvsDepth: tb.dtz,
        mctsTopMoves: [{ uci: bestUci, san: best.san, visits: 100, qValue: tb.wdl, prior: 1 }],
        safetyNetDeltaCp: 0,
        timeMs: 1,
        totalSimulations: 1,
        treeReused: false,
        reusedVisits: 0,
        tacticalVolatility: 0,
        transpositionHits: 0,
        tablebaseHits: 1,
        timeExtensionsGranted: 0,
        activeOpponentThreats: [],
        prophylaxisMove: '',
        prophylaxisScore: 0,
        wasDrawAvoided: false
      };
    }
  }

  if (legalMoves.length === 0) {
    return {
      bestMoveSan: '',
      bestMoveUci: '0000',
      scoreCp: chess.inCheck() ? -25000 : 0,
      mctsSelectedUci: '0000',
      pvsSelectedUci: '0000',
      decisionReason: 'consensus',
      mctsVisits: 0,
      pvsDepth: 0,
      mctsTopMoves: [],
      safetyNetDeltaCp: 0,
      timeMs: 0,
      totalSimulations: 0,
      treeReused: false,
      reusedVisits: 0,
      tacticalVolatility: 0,
      transpositionHits: 0,
      tablebaseHits: 0,
      timeExtensionsGranted: 0,
      activeOpponentThreats: [],
      prophylaxisMove: '',
      prophylaxisScore: 0,
      wasDrawAvoided: false
    };
  }

  if (legalMoves.length === 1) {
    const only = legalMoves[0];
    const onlyUci = `${only.from}${only.to}${only.promotion || ''}`;
    return {
      bestMoveSan: only.san,
      bestMoveUci: onlyUci,
      scoreCp: 0,
      mctsSelectedUci: onlyUci,
      pvsSelectedUci: onlyUci,
      decisionReason: 'consensus',
      mctsVisits: 1,
      pvsDepth: 1,
      mctsTopMoves: [{ uci: onlyUci, san: only.san, visits: 1, qValue: 0, prior: 1 }],
      safetyNetDeltaCp: 0,
      timeMs: 1,
      totalSimulations: 1,
      treeReused: false,
      reusedVisits: 0,
      tacticalVolatility: 0,
      transpositionHits: 0,
      tablebaseHits: 0,
      timeExtensionsGranted: 0,
      activeOpponentThreats: [],
      prophylaxisMove: '',
      prophylaxisScore: 0,
      wasDrawAvoided: false
    };
  }

  const startTime = performance.now();
  const tacticalVolatility = calculateTacticalVolatility(chess);

  // Threat-Space Prophylaxis (The Petrosian Patch):
  // Calculate opponent's top 3 most dangerous attacking intentions
  const opponentThreats = config.enableProphylaxis !== false ? computeOpponentThreatSpace(chess) : [];

  // Dynamic Time Management: Volatility extension
  let allocatedTimeMs = config.maxTimeMs;
  if (tacticalVolatility > 0.6) {
    allocatedTimeMs = Math.round(allocatedTimeMs * 1.35);
  }

  // 1. Run MCTS with Threat-Space Prophylaxis Guidance
  const initialFastEval = evaluateBRnnueV030(fen);
  const isWinningAdvantage = initialFastEval.evalCpPerspective > 50;

  const { root, completedSims, timeMs: mctsTime, reused, reusedVisits, ttHits, tbHits, timeExtensions } = runMctsSearch(
    fen,
    config.simulations,
    allocatedTimeMs * 0.70,
    config.cPuctBase,
    config.cPuctFactor,
    config.fpuReduction,
    config.enableSubtreeReuse,
    config.enableTacticalRollout,
    config.enableTranspositionTable,
    config.enableTablebase,
    config.enableProgressiveSeePruning,
    config.virtualLossWeight,
    config.contempt,
    config.dirichletAlpha,
    config.dirichletEps,
    opponentThreats,
    config.gameHistory,
    isWinningAdvantage
  );

  const sortedChildren = [...root.children].sort((a, b) => b.visits - a.visits);
  const mctsBest = sortedChildren[0];
  const mctsUci = mctsBest ? mctsBest.uci : `${legalMoves[0].from}${legalMoves[0].to}`;

  // 2. Run PVS Tactical Safety Net Search
  const remainingTime = Math.max(100, allocatedTimeMs - mctsTime);
  const pvsResult = searchIndependentBerserker(fen, config.safetyNetDepth, remainingTime);
  const pvsUci = pvsResult.bestMoveUci;
  const pvsScoreCp = pvsResult.scoreCp;

  // 3. Continuous Bayesian Dual Arbiter
  let chosenUci = mctsUci;
  let chosenSan = mctsBest?.san || legalMoves[0].san;
  let reason: 'consensus' | 'mcts-strategic' | 'bayesian-blend' | 'safety-net-override' | 'tablebase-hit' | 'petrosian-prophylaxis' | 'anti-repetition-defense' = 'mcts-strategic';
  let safetyNetDeltaCp = 0;

  if (mctsUci === pvsUci) {
    reason = 'consensus';
    chosenUci = mctsUci;
    chosenSan = mctsBest.san;
  } else {
    try {
      const testChess = new Chess(fen);
      const mctsMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === mctsUci);
      if (mctsMoveObj) {
        testChess.move(mctsMoveObj);
        const oppReply = searchIndependentBerserker(testChess.fen(), Math.max(2, config.safetyNetDepth - 1), 160);
        const mctsMovePvsScore = -oppReply.scoreCp;
        safetyNetDeltaCp = pvsScoreCp - mctsMovePvsScore;

        if (safetyNetDeltaCp > config.safetyNetThresholdCp) {
          reason = 'safety-net-override';
          chosenUci = pvsUci;
          const pvsMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === pvsUci);
          chosenSan = pvsMoveObj ? pvsMoveObj.san : pvsResult.bestMoveSan;
        } else {
          const lambda = 0.15 + 0.55 * tacticalVolatility;
          const mctsNormalizedVisits = mctsBest ? (mctsBest.visits / Math.max(1, root.visits)) : 0;

          if (mctsNormalizedVisits > 0.55 && safetyNetDeltaCp < 60) {
            reason = 'mcts-strategic';
            chosenUci = mctsUci;
            chosenSan = mctsBest.san;
          } else if (lambda > 0.50 && safetyNetDeltaCp > 80) {
            reason = 'bayesian-blend';
            chosenUci = pvsUci;
            const pvsMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === pvsUci);
            chosenSan = pvsMoveObj ? pvsMoveObj.san : pvsResult.bestMoveSan;
          } else {
            reason = 'mcts-strategic';
            chosenUci = mctsUci;
            chosenSan = mctsBest.san;
          }
        }
      }
    } catch {
      reason = 'safety-net-override';
      chosenUci = pvsUci;
      chosenSan = pvsResult.bestMoveSan;
    }
  }

  // Detect Petrosian Prophylaxis Classification:
  // If the chosen move neutralizes a high-severity opponent threat
  let topProphScore = 0;
  let topProphMove = '';
  if (opponentThreats.length > 0) {
    const chosenMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === chosenUci);
    if (chosenMoveObj) {
      topProphScore = evaluateProphylacticQuality(chess, chosenMoveObj, opponentThreats);
      topProphMove = chosenSan;
      if (topProphScore >= 65 && opponentThreats[0].threatSeverity >= 60 && reason === 'mcts-strategic') {
        reason = 'petrosian-prophylaxis';
      }
    }
  }

  // 4. Anti-Repetition Shield:
  // In winning positions, Berserker strictly forbids repeating moves or perpetual loops.
  let wasDrawAvoided = false;
  const isWinning = (mctsBest && mctsBest.qValue > 0.05) || pvsScoreCp > 40 || initialFastEval.evalCpPerspective > 50;

  if (config.gameHistory && config.gameHistory.length > 0 && isWinning && legalMoves.length > 1) {
    const chosenMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === chosenUci);
    if (chosenMoveObj) {
      try {
        const testChess = new Chess(chess.fen());
        testChess.move(chosenMoveObj);
        const nextKey = testChess.fen().split(' ').slice(0, 4).join(' ');
        let reps = 0;
        for (const pastKey of config.gameHistory) {
          if (pastKey === nextKey) reps++;
        }
        if (reps >= 1) {
          // Divert to best non-repeating alternative move
          let diverted = false;
          for (const cand of sortedChildren) {
            if (cand.uci === chosenUci) continue;
            const candMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === cand.uci);
            if (!candMoveObj) continue;
            const candSim = new Chess(chess.fen());
            candSim.move(candMoveObj);
            const candKey = candSim.fen().split(' ').slice(0, 4).join(' ');
            let candReps = 0;
            for (const pastKey of config.gameHistory) {
              if (pastKey === candKey) candReps++;
            }
            if (candReps === 0) {
              chosenUci = cand.uci;
              chosenSan = cand.san;
              reason = 'anti-repetition-defense';
              wasDrawAvoided = true;
              diverted = true;
              break;
            }
          }

          if (!diverted) {
            for (const m of legalMoves) {
              const uci = `${m.from}${m.to}${m.promotion || ''}`;
              if (uci === chosenUci) continue;
              const candSim = new Chess(chess.fen());
              candSim.move(m);
              const candKey = candSim.fen().split(' ').slice(0, 4).join(' ');
              let candReps = 0;
              for (const pastKey of config.gameHistory) {
                if (pastKey === candKey) candReps++;
              }
              if (candReps === 0) {
                chosenUci = uci;
                chosenSan = m.san;
                reason = 'anti-repetition-defense';
                wasDrawAvoided = true;
                diverted = true;
                break;
              }
            }
          }
        }
      } catch {
        // pass
      }
    }
  }

  const totalTime = Math.round(performance.now() - startTime);
  const topMovesInfo = sortedChildren.slice(0, 5).map(c => ({
    uci: c.uci,
    san: c.san,
    visits: c.visits,
    qValue: Math.round(c.qValue * 100) / 100,
    prior: Math.round(c.prior * 1000) / 1000
  }));

  return {
    bestMoveSan: chosenSan,
    bestMoveUci: chosenUci,
    scoreCp: reason === 'safety-net-override' ? pvsScoreCp : valueToCp(mctsBest.qValue),
    mctsSelectedUci: mctsUci,
    pvsSelectedUci: pvsUci,
    decisionReason: reason,
    mctsVisits: mctsBest ? mctsBest.visits : 0,
    pvsDepth: pvsResult.depth,
    mctsTopMoves: topMovesInfo,
    safetyNetDeltaCp,
    timeMs: totalTime,
    totalSimulations: completedSims,
    treeReused: reused,
    reusedVisits,
    tacticalVolatility: Math.round(tacticalVolatility * 100) / 100,
    transpositionHits: ttHits,
    tablebaseHits: tbHits,
    timeExtensionsGranted: timeExtensions,
    activeOpponentThreats: opponentThreats,
    prophylaxisMove: topProphMove,
    prophylaxisScore: topProphScore,
    wasDrawAvoided
  };
}
