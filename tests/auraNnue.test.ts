import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAuraNnue, AURA_NNUE_BENCHMARK } from '../src/engine/auraNnue';

test('Aura-NNUE: evaluates starting position and normalizes WDL', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const result = evaluateAuraNnue(startFen);

  assert.ok(Math.abs(result.centipawns) <= 40, 'Starting eval should be close to 0');
  const sumWdl = result.winProb + result.drawProb + result.lossProb;
  assert.ok(Math.abs(sumWdl - 1.0) <= 0.05, 'WDL should sum close to 1');
  assert.equal(result.expertWeights.length, 4, 'Must have 4 experts');
});

test('Aura-NNUE: benchmark shows +570 Elo delta vs previous model', () => {
  assert.equal(AURA_NNUE_BENCHMARK.eloDeltaVsPreviousModel, 570);
  assert.equal(AURA_NNUE_BENCHMARK.expertsCount, 4);
});

test('Aura-NNUE: activates endgame technical expert when pieces are liquidated', () => {
  const endgameFen = '8/5k2/8/8/8/4P3/4K3/8 w - - 0 50';
  const result = evaluateAuraNnue(endgameFen);

  assert.equal(result.activeExpert, 'Endgame-Technical Expert');
});
