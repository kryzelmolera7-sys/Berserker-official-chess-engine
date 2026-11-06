import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateBerserker090Nnue,
  evaluatePlentyChessNnue,
  evaluateBRnnueV030,
  evaluateBerserker10Nnue,
  compareBRnnueV030VsBerserker10
} from '../src/engine/brnnueDualEval';

test('evaluateBerserker090Nnue evaluates tactical attack pressure', () => {
  const startpos = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const evalStart = evaluateBerserker090Nnue(startpos);
  assert.equal(evalStart.netName, 'Berserker v0.9.0 NNUE');
  assert.ok(evalStart.activeFeatures > 0);
  assert.ok(evalStart.screluSum > 0);

  // Sharp position with active attacking pieces
  const tacticalFen = '3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20';
  const evalTactical = evaluateBerserker090Nnue(tacticalFen);
  assert.equal(typeof evalTactical.centipawns, 'number');
  assert.ok(evalTactical.screluSum > 500);
});

test('evaluatePlentyChessNnue computes endgame harmony and bishop pair bonuses', () => {
  // Position with White bishop pair
  const bishopPairFen = 'r1bqk2r/pppp1ppp/2n5/4p3/2B1P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 0 5';
  const evalPlenty = evaluatePlentyChessNnue(bishopPairFen);
  assert.equal(evalPlenty.netName, 'PlentyChess NNUE');
  assert.ok(evalPlenty.architecture.includes('HalfKAv2-1024'));

  // Endgame pawn position with valid legal squares
  const egFen = '8/5k2/8/4p3/3P4/8/5K2/8 w - - 0 45';
  const evalEg = evaluatePlentyChessNnue(egFen);
  assert.ok(evalEg.activeFeatures <= 5, 'Endgame should have minimal active pieces');
});

test('evaluateBRnnueV030 fuses Berserker 0.9.0 and PlentyChess adaptively', () => {
  const midFen = '3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20';
  const dualEval = evaluateBRnnueV030(midFen);

  assert.equal(dualEval.version, 'BRnnuev030');
  assert.equal(dualEval.netId, 'berserker_brnnue_v030.nnue');
  assert.equal(dualEval.phaseWeight.gamePhase, 'Middlegame');
  assert.ok(dualEval.phaseWeight.berserkerWeight >= 0.60, 'Middlegame prioritizes Berserker v0.9.0 tactical weight');
  assert.ok(dualEval.winProb >= 0 && dualEval.winProb <= 1);
  assert.ok(dualEval.drawProb >= 0 && dualEval.drawProb <= 1);
  assert.ok(dualEval.lossProb >= 0 && dualEval.lossProb <= 1);

  // Pure endgame with legal pawn rank
  const egFen = '8/5k2/8/8/8/4P3/4K3/8 w - - 0 50';
  const egEval = evaluateBRnnueV030(egFen);
  assert.equal(egEval.phaseWeight.gamePhase, 'Endgame');
  assert.ok(egEval.phaseWeight.plentyChessWeight >= 0.65, 'Endgame prioritizes PlentyChess endgame conversion');
});

test('compareBRnnueV030VsBerserker10 calculates delta against Berserker 1.0 NNUE', () => {
  const fen = '3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20';
  const comp = compareBRnnueV030VsBerserker10(fen);

  assert.equal(comp.berserker10Nnue.netId, 'berserker_1.0_nnue');
  assert.equal(comp.brnnueV030.version, 'BRnnuev030');
  assert.ok(typeof comp.evalDeltaCp === 'number');
  assert.ok(['BRnnuev030', 'Berserker 1.0 NNUE', 'Neutral'].includes(comp.preferredEngine));
});
