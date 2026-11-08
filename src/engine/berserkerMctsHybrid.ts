/**
 * Berserker NNUE + MCTS Hybrid Search Engine (v0.4.0 Grandmaster Core)
 * 
 * Enhanced Architecture:
 * 1. Deep Monte Carlo Tree Search (MCTS) with PUCT Policy Guidance
 * 2. Dynamic Entropy-Driven c_puct Scaling & Dynamic First Play Urgency (FPU)
 * 3. 2-Ply Tactical Quiescence Rollout (Q-Rollout) for Leaf Stabilization
 * 4. Subtree Reuse & Graph Transposition Grafting across consecutive turns
 * 5. BRnnue Wide-Accumulator Policy Prior Guidance
 * 6. Continuous Bayesian Dual Arbiter with Tactical Volatility Weighting
 * 7. Alpha-Beta PVS Tactical Safety Net (Horizon Blunder Guardian)
 */

import { Chess, Move } from 'chess.js';
import { evaluateBRnnueV030 } from './brnnueDualEval';
import { staticExchangeEvaluation, searchIndependentBerserker, pieceToIdx } from './berserkerIndependentSearch';

export interface MctsChild {
  move: Move;
  uci: string;
  san: string;
  visits: number;
  totalValue: number;
  qValue: number;
  prior: number;
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
  decisionReason: 'consensus' | 'mcts-strategic' | 'bayesian-blend' | 'safety-net-override';
  mctsVisits: number;
  pvsDepth: number;
  mctsTopMoves: { uci: string; san: string; visits: number; qValue: number; prior: number }[];
  safetyNetDeltaCp: number;
  timeMs: number;
  totalSimulations: number;
  treeReused: boolean;
  reusedVisits: number;
  tacticalVolatility: number;
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
}

const DEFAULT_CONFIG: Required<HybridSearchConfig> = {
  simulations: 800,
  maxTimeMs: 1500,
  cPuctBase: 1.85,
  cPuctFactor: 0.45,
  fpuReduction: 0.25,
  safetyNetDepth: 6,
  safetyNetThresholdCp: 35, // Tight safety net: if MCTS move is >35cp worse than PVS, override!
  enableSubtreeReuse: true,
  enableTacticalRollout: false // Direct Berserker NNUE evaluation avoids horizon rollout distortion
};

// Global search tree cache for Subtree Reuse & Graph Grafting
let persistentMctsRoot: MctsNode | null = null;

export function resetMctsTree(): void {
  persistentMctsRoot = null;
}

export function getPersistentTreeRoot(): MctsNode | null {
  return persistentMctsRoot;
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
 * Starts sharp and focused on tactical candidates (c_puct ~ 1.85)
 * then gradually expands broad positional awareness (c_puct ~ 2.6 - 3.2).
 */
export function calculateDynamicCpuct(parentVisits: number, cBase: number = 1.85, cFactor: number = 0.45): number {
  return cBase + cFactor * Math.log(1 + Math.max(0, parentVisits) / 25.0);
}

/**
 * Dynamic First Play Urgency (FPU):
 * Unvisited children are initialized with a context-aware heuristic value
 * instead of a flat 0.0.
 */
export function calculateFpu(parentQ: number, prior: number, fpuReduction: number = 0.25): number {
  return Math.max(-0.98, Math.min(0.98, parentQ - fpuReduction * Math.sqrt(Math.max(0.01, prior))));
}

/**
 * Computes Policy Prior distribution over legal moves at a node.
 * Features:
 * - SEE Tactical material exchanges
 * - Promotion and queen push threats
 * - King attack and check initiative
 * - Central squares hegemony (d4, e4, d5, e5, c4, f4)
 * - Minor piece development and outpost control
 * - Castling king safety
 */
export function computeMovePriors(chess: Chess, moves: Move[]): number[] {
  if (moves.length === 0) return [];
  const rawScores: number[] = new Array(moves.length);

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let score = 0;

    // 1. Material & SEE Exchange Quality: only reward winning captures (SEE > 0). Equal trades get 0. Losing trades heavily penalized.
    if (m.captured) {
      const see = staticExchangeEvaluation(chess, m);
      score += see > 0 ? 120 + see * 0.3 : (see === 0 ? 0 : -200);
    }

    // 2. Promotion bonus
    if (m.promotion) {
      score += m.promotion === 'q' ? 320 : 90;
    }

    // 3. Check bonus
    if (m.san.includes('+')) {
      score += 75;
    }

    // 4. Center control & central outposts
    if (['e4', 'd4', 'e5', 'd5'].includes(m.to)) {
      score += 45;
    } else if (['c4', 'f4', 'c5', 'f5'].includes(m.to)) {
      score += 25;
    }

    // 5. Piece activity (developing knights and bishops)
    if (['n', 'b'].includes(m.piece)) {
      score += 40;
      // Bonus for forward knight outposts
      if (m.piece === 'n' && ['c3', 'f3', 'c6', 'f6', 'd5', 'e5', 'd4', 'e4'].includes(m.to)) {
        score += 30;
      }
    }

    // 6. Rook on open files or 7th rank
    if (m.piece === 'r') {
      if (m.to.endsWith('7') || m.to.endsWith('2')) score += 30;
      if (['d', 'e'].includes(m.to[0])) score += 15;
    }

    // 7. King protection in opening (Castling is top priority)
    if (m.san === 'O-O' || m.san === 'O-O-O') {
      score += 140;
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
 * 2-Ply Leaf Quiescence Tactical Rollout:
 * Stabilizes tactical leaf nodes by resolving immediate captures before BRnnue evaluation.
 * Prevents mid-tactic horizon distortion where one side has sacrificed material
 * but hasn't yet executed the forced recapture.
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

    // Look for winning or equal tactical captures
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

    // If no positive or neutral capture exists, position is tactically quiescent
    if (!bestCapture || bestSee < 0) {
      break;
    }

    sim.move(bestCapture);
    ply++;
  }

  const nnueEval = evaluateBRnnueV030(sim.fen());
  // Adjust perspective relative to side to move at starting chess position
  const perspectiveSign = sim.turn() === chess.turn() ? 1 : -1;
  return cpToValue(nnueEval.evalCpPerspective * perspectiveSign);
}

/**
 * Calculates tactical volatility score (0.0 to 1.0) of a position.
 * Measures capture tension, checks, and piece exposure.
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
 * Executes a full MCTS search with:
 * - Dynamic c_puct scaling
 * - Dynamic First Play Urgency (FPU)
 * - 2-Ply Leaf Quiescence Tactical Rollout
 * - Subtree Reuse & Graph Grafting
 */
export function runMctsSearch(
  startFen: string,
  simulations: number = 800,
  maxTimeMs: number = 1200,
  cPuctBase: number = 1.85,
  cPuctFactor: number = 0.45,
  fpuReduction: number = 0.25,
  enableReuse: boolean = true,
  enableRollout: boolean = false
): { root: MctsNode; completedSims: number; timeMs: number; reused: boolean; reusedVisits: number } {
  const startTime = performance.now();
  let root: MctsNode | null = null;
  let reused = false;
  let reusedVisits = 0;

  // 1. Subtree Reuse & Graph Grafting: Check if persistent tree root has this node
  if (enableReuse && persistentMctsRoot) {
    if (persistentMctsRoot.fen === startFen) {
      root = persistentMctsRoot;
      reused = true;
      reusedVisits = root.visits;
    } else {
      // Check immediate children
      for (const child of persistentMctsRoot.children) {
        if (child.node && child.node.fen === startFen) {
          root = child.node;
          root.parent = null;
          reused = true;
          reusedVisits = root.visits;
          break;
        }
        // Check grandchildren (two plies down: our move + opponent move)
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

  if (!root) {
    root = new MctsNode(startFen);
  }

  const rootChess = new Chess(startFen);

  // Expand root node if not already expanded
  if (!root.isExpanded) {
    const rootMoves = rootChess.moves({ verbose: true });
    if (rootMoves.length === 0) {
      root.isTerminal = true;
      root.terminalScore = rootChess.inCheck() ? -1.0 : 0.0;
      persistentMctsRoot = root;
      return { root, completedSims: 0, timeMs: 0, reused: false, reusedVisits: 0 };
    }

    const rootPriors = computeMovePriors(rootChess, rootMoves);
    root.children = rootMoves.map((m, idx) => ({
      move: m,
      uci: `${m.from}${m.to}${m.promotion || ''}`,
      san: m.san,
      visits: 0,
      totalValue: 0,
      qValue: 0,
      prior: rootPriors[idx],
      node: null
    }));
    root.isExpanded = true;
  }

  let simCount = 0;
  const targetSims = reused ? Math.max(simulations / 2, simulations - reusedVisits) : simulations;

  while (simCount < targetSims) {
    if (simCount % 32 === 0 && (performance.now() - startTime) >= maxTimeMs) {
      break;
    }

    const path: { node: MctsNode; childIndex: number }[] = [];
    let current = root;
    const simChess = new Chess(startFen);

    // 1. Selection: Traverse down using Dynamic PUCT & First Play Urgency (FPU)
    while (current.isExpanded && !current.isTerminal) {
      const parentVisitsSqrt = Math.sqrt(Math.max(1, current.visits));
      const currentCpuct = calculateDynamicCpuct(current.visits, cPuctBase, cPuctFactor);
      let bestPuct = -Infinity;
      let bestIndex = 0;

      for (let i = 0; i < current.children.length; i++) {
        const child = current.children[i];
        // Action value: if unvisited, use Dynamic First Play Urgency (FPU)
        const qVal = child.visits === 0
          ? calculateFpu(current.qValue, child.prior, fpuReduction)
          : child.totalValue / child.visits;

        const uVal = currentCpuct * child.prior * (parentVisitsSqrt / (1 + child.visits));
        const puct = qVal + uVal;

        if (puct > bestPuct) {
          bestPuct = puct;
          bestIndex = i;
        }
      }

      path.push({ node: current, childIndex: bestIndex });
      const chosenChild = current.children[bestIndex];
      simChess.move(chosenChild.move);

      if (!chosenChild.node) {
        chosenChild.node = new MctsNode(simChess.fen(), current, chosenChild.move);
      }
      current = chosenChild.node;
    }

    // 2. Leaf Expansion & Evaluation with Tactical Quiescence Rollout
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
      if (enableRollout) {
        // Stabilize leaf evaluation using 2-ply Quiescence Rollout
        leafValue = runLeafTacticalRollout(simChess, 2);
      } else {
        const nnueEval = evaluateBRnnueV030(simChess.fen());
        leafValue = cpToValue(nnueEval.evalCpPerspective);
      }

      // Expand leaf if it has legal moves and visits threshold reached
      const legalMoves = simChess.moves({ verbose: true });
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
          node: null
        }));
        current.isExpanded = true;
      }
    }

    // 3. Backpropagation: Alternating sign backpropagation up the tree
    let value = leafValue;
    current.visits++;
    current.totalValue += value;

    for (let i = path.length - 1; i >= 0; i--) {
      const step = path[i];
      value = -value; // Flip perspective for opponent
      step.node.visits++;
      step.node.totalValue += value;

      const child = step.node.children[step.childIndex];
      child.visits++;
      child.totalValue += value;
      child.qValue = child.totalValue / child.visits;
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
    reusedVisits
  };
}

/**
 * Hybrid MCTS + PVS Search with Continuous Bayesian Dual Arbiter
 * and Alpha-Beta Tactical Safety Net.
 */
export function searchHybridNnueMcts(
  fen: string,
  userConfig: HybridSearchConfig = {}
): HybridSearchResult {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const chess = new Chess(fen);
  const legalMoves = chess.moves({ verbose: true });

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
      tacticalVolatility: 0
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
      tacticalVolatility: 0
    };
  }

  const startTime = performance.now();
  const tacticalVolatility = calculateTacticalVolatility(chess);

  // 1. Run MCTS with Subtree Reuse, Dynamic PUCT, FPU, and Q-Rollouts
  const { root, completedSims, timeMs: mctsTime, reused, reusedVisits } = runMctsSearch(
    fen,
    config.simulations,
    config.maxTimeMs * 0.70,
    config.cPuctBase,
    config.cPuctFactor,
    config.fpuReduction,
    config.enableSubtreeReuse,
    config.enableTacticalRollout
  );

  // Sort MCTS moves by visit count
  const sortedChildren = [...root.children].sort((a, b) => b.visits - a.visits);
  const mctsBest = sortedChildren[0];
  const mctsUci = mctsBest ? mctsBest.uci : `${legalMoves[0].from}${legalMoves[0].to}`;

  // 2. Run PVS Tactical Safety Net Search
  const remainingTime = Math.max(100, config.maxTimeMs - mctsTime);
  const pvsResult = searchIndependentBerserker(fen, config.safetyNetDepth, remainingTime);
  const pvsUci = pvsResult.bestMoveUci;
  const pvsScoreCp = pvsResult.scoreCp;

  // 3. Continuous Bayesian Dual Arbiter
  let chosenUci = mctsUci;
  let chosenSan = mctsBest?.san || legalMoves[0].san;
  let reason: 'consensus' | 'mcts-strategic' | 'bayesian-blend' | 'safety-net-override' = 'mcts-strategic';
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
        // Opponent's best reply to MCTS move via PVS
        const oppReply = searchIndependentBerserker(testChess.fen(), Math.max(2, config.safetyNetDepth - 1), 160);
        const mctsMovePvsScore = -oppReply.scoreCp;
        safetyNetDeltaCp = pvsScoreCp - mctsMovePvsScore;

        if (safetyNetDeltaCp > config.safetyNetThresholdCp || safetyNetDeltaCp > 25) {
          // Tactical blunder guardian: Safety Net immediately overrides to the solid PVS line!
          reason = 'safety-net-override';
          chosenUci = pvsUci;
          const pvsMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === pvsUci);
          chosenSan = pvsMoveObj ? pvsMoveObj.san : pvsResult.bestMoveSan;
        } else {
          // Bayesian Soft Blending:
          const lambda = 0.15 + 0.55 * tacticalVolatility;
          const mctsNormalizedVisits = mctsBest ? (mctsBest.visits / Math.max(1, root.visits)) : 0;
          const mctsScoreCp = valueToCp(mctsBest.qValue);

          // If MCTS visit confidence is dominant (>55%) and tactical delta is benign (<20cp), strategic line triumphs
          if (mctsNormalizedVisits > 0.55 && safetyNetDeltaCp < 20) {
            reason = 'mcts-strategic';
            chosenUci = mctsUci;
            chosenSan = mctsBest.san;
          } else if (safetyNetDeltaCp > 15) {
            // Bias towards tactical safety
            reason = 'safety-net-override';
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
    tacticalVolatility: Math.round(tacticalVolatility * 100) / 100
  };
}
