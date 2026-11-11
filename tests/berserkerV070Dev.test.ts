import { test } from 'node:test';
import assert from 'node:assert';
import { Chess } from 'chess.js';
import { 
  evaluateBRnnueV070, 
  evaluateBerserkerDualPolicyValue 
} from '../src/engine/brnnueDualEval';
import { 
  searchHybridNnueMcts, 
  resetMctsTree, 
  calculateAdaptiveFpu, 
  evaluateProphylacticQualityPhase2,
  computeOpponentThreatSpace,
  getMctsDagTranspositionSize
} from '../src/engine/berserkerMctsHybrid';

test('Berserker v0.7.0 Quad-Head Neural Evaluation: extracts all 4 heads cleanly', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const quadEval = evaluateBRnnueV070(startFen);

  assert.strictEqual(quadEval.netId, 'berserker_brnnue_v070.nnue');
  assert.strictEqual(quadEval.version, 'BRnnuev070');
  assert.ok(typeof quadEval.centipawns === 'number');
  assert.ok(quadEval.winProb >= 0 && quadEval.winProb <= 1);
  assert.ok(quadEval.berserkerAttackSubnet);
  assert.ok(quadEval.berserkerHarmonySubnet);
  assert.ok(quadEval.threatPredictionHead);
  assert.ok(quadEval.endgameConversionHead);
  assert.ok(typeof quadEval.endgameConversionHead.conversionCertainty === 'number');
});

test('Berserker v0.7.0 Neural Policy Prior: awards massive priority to checkmate moves (#)', () => {
  // Move 57 from user game: White has Rbg7#
  const mateFen = '5rk1/1R5R/8/2r4p/7P/6P1/5PK1/8 w - - 5 57';
  const chess = new Chess(mateFen);
  const moves = chess.moves({ verbose: true });
  const result = evaluateBerserkerDualPolicyValue(mateFen, moves);

  const mateMove = result.policyPriors.find(p => p.moveUci === 'b7g7');
  assert.ok(mateMove, 'Expected b7g7 move to be found');
  assert.ok(mateMove.policyPrior > 0.80, `Expected mate move to have overwhelming prior > 0.80, got ${mateMove.policyPrior}`);
});

test('Berserker v0.7.0 Petrosian Prophylaxis Phase II: scores Luft and Back-Rank defense', () => {
  // Black threatens back-rank mate: ... Rd1#
  const threatFen = '6k1/5ppp/8/8/8/8/5PPP/3r2K1 w - - 0 1';
  // Before mate: King on g1, rooks threatening 1st rank
  const preThreatFen = '4r1k1/5ppp/8/8/8/8/5PPP/4R1K1 b - - 0 1';
  const oppChess = new Chess(preThreatFen);
  const threats = computeOpponentThreatSpace(new Chess('4r1k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1'));
  
  const testChess = new Chess('4r1k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1');
  const h3Move = testChess.moves({ verbose: true }).find(m => m.san === 'h3');
  assert.ok(h3Move);

  const phase2Score = evaluateProphylacticQualityPhase2(testChess, h3Move, [
    {
      uci: 'e8e1',
      san: 'Re1#',
      from: 'e8',
      to: 'e1',
      piece: 'r',
      threatSeverity: 100,
      threatType: 'checkmate-threat',
      description: 'Back-rank mate'
    }
  ]);

  assert.ok(phase2Score >= 90, `Expected Phase II Luft score >= 90, got ${phase2Score}`);
});

test('Berserker v0.7.0 Adaptive FPU: adjusts reduction based on tactical volatility', () => {
  const quietFpu = calculateAdaptiveFpu(0.2, 0.1, 0.25, 0.05);
  const volatileFpu = calculateAdaptiveFpu(0.2, 0.1, 0.25, 0.90);

  assert.ok(quietFpu > volatileFpu, 'Quiet positions should have higher (less penalized) FPU than volatile positions');
});

test('Berserker v0.7.0 DAG Transposition Transduction: caches DAG entries across searches', () => {
  resetMctsTree();
  assert.strictEqual(getMctsDagTranspositionSize(), 0);

  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
  searchHybridNnueMcts(fen, { simulations: 80, maxTimeMs: 400 });

  assert.ok(getMctsDagTranspositionSize() > 0, 'Expected DAG Transposition Table to accumulate entries');
});

test('Berserker v0.7.0 Instant Mate-in-1: immediately returns decisive mate move (Rbg7#)', () => {
  resetMctsTree();
  const mateFen = '5rk1/1R5R/8/2r4p/7P/6P1/5PK1/8 w - - 5 57';
  const res = searchHybridNnueMcts(mateFen, { maxTimeMs: 200 });

  assert.strictEqual(res.bestMoveUci, 'b7g7');
  assert.strictEqual(res.bestMoveSan, 'Rbg7#');
  assert.strictEqual(res.scoreCp, 25000);
});

test('Berserker v0.7.0 Anti-Repetition Shield: strictly avoids perpetual check draw in won rook endgame', () => {
  resetMctsTree();
  // Move 52 position from user game:
  // 4r1k1/1R3R2/4p1p1/2r4p/7P/6P1/5PK1/8 w - - 1 52
  // If Rh7+ had occurred in history, White MUST NOT play Rh7+ or repeat, but rather play Rxg6+!
  const fen52 = '4r1k1/1R3R2/4p1p1/2r4p/7P/6P1/5PK1/8 w - - 1 52';
  
  // Simulate the history where 52. Rh7+ Kg8 53. Rhg7+ Kh8 had already occurred
  const rh7Chess = new Chess(fen52);
  rh7Chess.move({ from: 'f7', to: 'h7' }); // Rh7+
  const rh7FenKey = rh7Chess.fen().split(' ').slice(0, 4).join(' ');

  const rg7Chess = new Chess(fen52);
  rg7Chess.move({ from: 'f7', to: 'g7' }); // Rg7+
  const rg7FenKey = rg7Chess.fen().split(' ').slice(0, 4).join(' ');

  // Pass history containing both check repetitions
  const gameHistory = [
    rh7FenKey,
    rg7FenKey,
    rh7FenKey,
    rg7FenKey
  ];

  const res = searchHybridNnueMcts(fen52, {
    simulations: 350,
    maxTimeMs: 800,
    gameHistory
  });

  // White MUST NOT play Rh7+ (f7h7) or Rg7+ (f7g7) which repeats into a draw!
  assert.notStrictEqual(res.bestMoveUci, 'f7h7', 'Engine must not repeat f7h7 (Rh7+) when winning');
  assert.notStrictEqual(res.bestMoveUci, 'f7g7', 'Engine must not repeat f7g7 (Rg7+) when winning');
  assert.ok(
    !['f7h7', 'f7g7'].includes(res.bestMoveUci),
    `Engine must not play any repeating moves, chosen: ${res.bestMoveUci} (${res.bestMoveSan})`
  );
  assert.strictEqual(res.wasDrawAvoided, true);
});
