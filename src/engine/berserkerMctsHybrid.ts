/**
 * Berserker NNUE + MCTS Hybrid Search Engine
 * 
 * Combines:
 * 1. Deep Monte Carlo Tree Search (MCTS) with PUCT Policy Guidance
 * 2. BRnnue Neural Network as Value and Prior Evaluation Head
 * 3. Alpha-Beta PVS Tactical Safety Net (prevents horizon tactical traps and overrides blunders)
 * 4. Dual Arbiter: Selects MCTS strategic line when tactically sound; overrides with PVS if MCTS blunders
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
  decisionReason: 'consensus' | 'mcts-strategic' | 'safety-net-override';
  mctsVisits: number;
  pvsDepth: number;
  mctsTopMoves: { uci: string; san: string; visits: number; qValue: number; prior: number }[];
  safetyNetDeltaCp: number;
  timeMs: number;
  totalSimulations: number;
}

export interface HybridSearchConfig {
  simulations?: number;
  maxTimeMs?: number;
  cPuct?: number;
  safetyNetDepth?: number;
  safetyNetThresholdCp?: number;
  temperature?: number;
}

const DEFAULT_CONFIG: Required<HybridSearchConfig> = {
  simulations: 800,
  maxTimeMs: 1500,
  cPuct: 2.25,
  safetyNetDepth: 5,
  safetyNetThresholdCp: 140, // If MCTS move is >140cp worse than PVS, override!
  temperature: 0.1
};

/**
 * Normalizes BRnnue centipawns into a win/loss expectancy value in [-1, 1].
 */
export function cpToValue(cp: number): number {
  if (Math.abs(cp) > 15000) return cp > 0 ? 1.0 : -1.0;
  // Standard sigmoid scaling factor (400cp ~ 90% win probability)
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
 * Computes Policy Prior distribution over legal moves at a node.
 * Blends NNUE initiative, tactical SEE, capture status, and central control.
 */
function computeMovePriors(chess: Chess, moves: Move[]): number[] {
  if (moves.length === 0) return [];
  const rawScores: number[] = new Array(moves.length);

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let score = 0;

    // 1. Material & SEE Exchange Quality
    if (m.captured) {
      const see = staticExchangeEvaluation(chess, m);
      score += see >= 0 ? 180 + see * 0.5 : -150;
    }

    // 2. Promotion bonus
    if (m.promotion) {
      score += m.promotion === 'q' ? 300 : 80;
    }

    // 3. Check bonus
    if (m.san.includes('+')) {
      score += 70;
    }

    // 4. Center control (e4, d4, e5, d5, c4, f4)
    if (['e4', 'd4', 'e5', 'd5', 'c4', 'f4', 'c5', 'f5'].includes(m.to)) {
      score += 25;
    }

    // 5. Piece activity (developing minor pieces)
    if (['n', 'b'].includes(m.piece)) {
      score += 15;
    }

    // 6. King protection in opening
    if (m.san === 'O-O' || m.san === 'O-O-O') {
      score += 65;
    }

    rawScores[i] = score;
  }

  // Softmax with temperature
  const temp = 60.0;
  const maxScore = Math.max(...rawScores);
  const exps = rawScores.map(s => Math.exp((s - maxScore) / temp));
  const sumExp = exps.reduce((a, b) => a + b, 0);

  return exps.map(e => e / Math.max(1e-9, sumExp));
}

/**
 * Executes a full MCTS search guided by PUCT and BRnnue evaluation.
 */
export function runMctsSearch(
  startFen: string,
  simulations: number = 800,
  maxTimeMs: number = 1200,
  cPuct: number = 2.25
): { root: MctsNode; completedSims: number; timeMs: number } {
  const root = new MctsNode(startFen);
  const startTime = performance.now();
  const rootChess = new Chess(startFen);

  // Expand root node
  const rootMoves = rootChess.moves({ verbose: true });
  if (rootMoves.length === 0) {
    root.isTerminal = true;
    root.terminalScore = rootChess.inCheck() ? -1.0 : 0.0;
    return { root, completedSims: 0, timeMs: 0 };
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

  let simCount = 0;

  while (simCount < simulations) {
    if (simCount % 64 === 0 && (performance.now() - startTime) >= maxTimeMs) {
      break;
    }

    const path: { node: MctsNode; childIndex: number }[] = [];
    let current = root;
    const simChess = new Chess(startFen);

    // 1. Selection: traverse down the tree using PUCT formula
    while (current.isExpanded && !current.isTerminal) {
      const parentVisitsSqrt = Math.sqrt(Math.max(1, current.visits));
      let bestPuct = -Infinity;
      let bestIndex = 0;

      for (let i = 0; i < current.children.length; i++) {
        const child = current.children[i];
        // Action value: from perspective of side to move at current node
        const qVal = child.visits === 0 ? 0 : child.totalValue / child.visits;
        const uVal = cPuct * child.prior * (parentVisitsSqrt / (1 + child.visits));
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

    // 2. Expansion & Leaf Evaluation
    let leafValue = 0;

    if (simChess.isCheckmate()) {
      current.isTerminal = true;
      current.terminalScore = -1.0; // Checkmated side loses
      leafValue = -1.0;
    } else if (simChess.isDraw()) {
      current.isTerminal = true;
      current.terminalScore = 0.0;
      leafValue = 0.0;
    } else {
      // Evaluate leaf position using BRnnue
      const nnueEval = evaluateBRnnueV030(simChess.fen());
      // nnueEval.evalCpPerspective is positive if side-to-move is winning
      leafValue = cpToValue(nnueEval.evalCpPerspective);

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

    // 3. Backpropagation: backpropagate negated values up the alternating tree
    let value = leafValue;
    current.visits++;
    current.totalValue += value;

    for (let i = path.length - 1; i >= 0; i--) {
      const step = path[i];
      value = -value; // Flip perspective for opponent turn
      step.node.visits++;
      step.node.totalValue += value;

      const child = step.node.children[step.childIndex];
      child.visits++;
      child.totalValue += value;
      child.qValue = child.totalValue / child.visits;
    }

    simCount++;
  }

  const elapsed = Math.max(1, performance.now() - startTime);
  return { root, completedSims: simCount, timeMs: Math.round(elapsed) };
}

/**
 * Hybrid MCTS + PVS Search with Tactical Safety Net.
 * 
 * Flow:
 * 1. MCTS runs PUCT simulations with BRnnue guidance to understand deep positional themes.
 * 2. High-speed PVS Alpha-Beta search runs concurrently as the Tactical Safety Net.
 * 3. Arbiter compares MCTS candidate move against PVS tactical move:
 *    - If MCTS move blunders into a tactical trap or checkmate (fails low), PVS safety net OVERRIDES!
 *    - If MCTS move is sound, MCTS strategic choice is selected.
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
      totalSimulations: 0
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
      totalSimulations: 1
    };
  }

  const startTime = performance.now();

  // 1. Run MCTS Search with BRnnue
  const { root, completedSims, timeMs: mctsTime } = runMctsSearch(
    fen,
    config.simulations,
    config.maxTimeMs * 0.70,
    config.cPuct
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

  // 3. Dual Arbiter Evaluation
  // Evaluate what happens if MCTS move is played through the PVS safety net lens
  let chosenUci = mctsUci;
  let chosenSan = mctsBest?.san || legalMoves[0].san;
  let reason: 'consensus' | 'mcts-strategic' | 'safety-net-override' = 'mcts-strategic';
  let safetyNetDeltaCp = 0;

  if (mctsUci === pvsUci) {
    // Perfect consensus: Both MCTS positional exploration and PVS tactical calculation agree!
    reason = 'consensus';
    chosenUci = mctsUci;
    chosenSan = mctsBest.san;
  } else {
    // Test if MCTS move is tactically safe
    try {
      const testChess = new Chess(fen);
      const mctsMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === mctsUci);
      if (mctsMoveObj) {
        testChess.move(mctsMoveObj);
        // Opponent's best reply to MCTS move
        const oppReply = searchIndependentBerserker(testChess.fen(), Math.max(2, config.safetyNetDepth - 1), 150);
        // Score of MCTS move from our perspective = -oppReply.scoreCp
        const mctsMovePvsScore = -oppReply.scoreCp;
        safetyNetDeltaCp = pvsScoreCp - mctsMovePvsScore;

        if (safetyNetDeltaCp > config.safetyNetThresholdCp) {
          // MCTS move blunders tactically! Safety Net overrides MCTS.
          reason = 'safety-net-override';
          chosenUci = pvsUci;
          const pvsMoveObj = legalMoves.find(m => `${m.from}${m.to}${m.promotion || ''}` === pvsUci);
          chosenSan = pvsMoveObj ? pvsMoveObj.san : pvsResult.bestMoveSan;
        } else {
          // MCTS move is tactically sound: Keep MCTS strategic line!
          reason = 'mcts-strategic';
          chosenUci = mctsUci;
          chosenSan = mctsBest.san;
        }
      }
    } catch {
      // Fallback to PVS if move validation fails
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
    totalSimulations: completedSims
  };
}
