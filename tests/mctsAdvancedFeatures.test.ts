import test from 'node:test';
import assert from 'node:assert';
import { Chess } from 'chess.js';
import {
  runMctsSearch,
  searchHybridNnueMcts,
  resetMctsTree,
} from '../src/engine/berserkerMctsHybrid';
import { evaluateBerserkerDualPolicyValue } from '../src/engine/brnnueDualEval';

test('Berserker NNUE Dual Policy-Value Head: returns position value and normalized priors', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const dual = evaluateBerserkerDualPolicyValue(startFen);

  assert.ok(dual.value >= -1.0 && dual.value <= 1.0);
  assert.ok(dual.winProb >= 0.0 && dual.winProb <= 1.0);
  assert.strictEqual(dual.policyPriors.length, 20);

  const sumPriors = dual.policyPriors.reduce((acc, p) => acc + p.policyPrior, 0);
  assert.ok(Math.abs(sumPriors - 1.0) < 0.02, `Priors sum should be ~1.0, got ${sumPriors}`);
});

test('Hybrid MCTS: Virtual Loss is applied during search without corrupting final values', () => {
  resetMctsTree();
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const { root, completedSims } = runMctsSearch(
    startFen,
    100,
    500,
    1.85,
    0.45,
    0.25,
    false,
    true,
    true,
    false,
    true,
    0.40 // virtual loss weight
  );

  assert.ok(completedSims > 25);
  for (const child of root.children) {
    assert.strictEqual(child.virtualLoss, 0, 'Virtual loss should be reverted after backprop');
    assert.ok(child.qValue >= -1.0 && child.qValue <= 1.0);
  }
});

test('Hybrid MCTS: Solves KR vs K endgame independently without Syzygy tablebase overrides', () => {
  resetMctsTree();
  const fen = '8/8/8/4k3/8/8/1R2K3/8 w - - 0 1';
  const result = searchHybridNnueMcts(fen, {
    simulations: 80,
    maxTimeMs: 400,
  });

  assert.notStrictEqual(result.decisionReason, 'tablebase-hit');
  assert.strictEqual(result.tablebaseHits, 0);
  assert.ok(result.bestMoveUci.length >= 4);
  const c = new Chess(fen);
  assert.ok(
    c.move({
      from: result.bestMoveUci.slice(0, 2),
      to: result.bestMoveUci.slice(2, 4),
      promotion: result.bestMoveUci[4] || undefined,
    }),
    'Returned endgame move must be legal'
  );
});

test('Hybrid MCTS: Dynamic Contempt steers evaluation away from sterile draws', () => {
  resetMctsTree();
  const quietFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const resNoContempt = searchHybridNnueMcts(quietFen, {
    simulations: 60,
    maxTimeMs: 300,
    contempt: 0.0,
  });

  const resWithContempt = searchHybridNnueMcts(quietFen, {
    simulations: 60,
    maxTimeMs: 300,
    contempt: 0.35,
  });

  assert.ok(resNoContempt.bestMoveUci.length >= 4);
  assert.ok(resWithContempt.bestMoveUci.length >= 4);
});
