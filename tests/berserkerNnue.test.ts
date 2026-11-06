import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  evaluateBerserkerNnue, 
  screlu, 
  compareNnueNets, 
  BERSERKER_NNUE_CONFIG,
  parseBoardForNnue 
} from '../src/engine/berserkerNnue.js';

test('Berserker NNUE: parses board and extracts features', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const { turn, whiteKingSq, blackKingSq, pieces } = parseBoardForNnue(startFen);

  assert.equal(turn, 'w');
  assert.equal(whiteKingSq, 4); // e1
  assert.equal(blackKingSq, 60); // e8
  assert.equal(pieces.length, 30); // 32 pieces - 2 kings
});

test('Berserker NNUE: SCReLU activation is mathematically correct', () => {
  assert.equal(screlu(0), 0);
  assert.equal(screlu(-50), 0);
  // clamp(127, 0, 127)^2 / 128 = 16129 / 128 = 126.0078125
  assert.ok(Math.abs(screlu(127) - (127 * 127 / 128)) < 0.001);
  // clamping at 127
  assert.equal(screlu(200), screlu(127));
});

test('Berserker NNUE: evaluates starting position with equal material balance', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const evalResult = evaluateBerserkerNnue(startFen);

  assert.equal(evalResult.activeFeaturesCount, 30);
  assert.equal(evalResult.netId, BERSERKER_NNUE_CONFIG.netId);
  // Symmetrical starting position eval should be close to 0 (within standard tempo margin)
  assert.ok(Math.abs(evalResult.centipawns) <= 40, `Start eval should be near 0, got ${evalResult.centipawns}`);
  // WDL probabilities should sum close to 1.0
  const wdlSum = evalResult.winProb + evalResult.drawProb + evalResult.lossProb;
  assert.ok(Math.abs(wdlSum - 1.0) <= 0.02);
});

test('Berserker NNUE: tactical aggressive bias rewards king attack pressure', () => {
  // Move 19 tactical blast from Berserker vs Reckless
  const tacticalFen = '3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20';
  const evalResult = evaluateBerserkerNnue(tacticalFen);

  assert.ok(evalResult.kingAttackPressure > 0, 'Should detect heavy tactical pressure');
  assert.ok(evalResult.tacticalAggressionBonus > 0, 'Berserker should award tactical aggression bonus');
});

test('Berserker NNUE: compares with Berserker 1.0 NNUE baseline and Turbo NNUE', () => {
  const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 4';
  const comparison = compareNnueNets(fen);

  assert.ok(typeof comparison.berserkerNnue.centipawns === 'number');
  assert.ok(typeof comparison.baselineNnueCp === 'number');
  assert.ok(typeof comparison.berserkerSpeedNnueCp === 'number');
  assert.ok(comparison.tacticalBias);
});
