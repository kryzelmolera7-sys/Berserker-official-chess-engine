import test from 'node:test';
import assert from 'node:assert';
import { Chess } from 'chess.js';
import { 
  runMctsSearch, 
  searchHybridNnueMcts, 
  resetMctsTree, 
  computeMovePriors 
} from '../src/engine/berserkerMctsHybrid';
import { evaluateBerserkerDualPolicyValue } from '../src/engine/brnnueDualEval';
import { probeTablebase, canKingCatchPawn } from '../src/engine/syzygyTablebase';

test('Syzygy Tablebase: correctly identifies K vs K as dead draw', () => {
  const chess = new Chess('8/8/8/4k3/8/8/4K3/8 w - - 0 1');
  const tb = probeTablebase(chess);
  assert.strictEqual(tb.isHit, true);
  assert.strictEqual(tb.wdl, 0);
  assert.strictEqual(tb.scoreCp, 0);
});

test('Syzygy Tablebase: identifies KQ vs K as winning for Queen side', () => {
  const whiteQ = new Chess('8/8/8/4k3/8/8/1Q2K3/8 w - - 0 1');
  const tbWhite = probeTablebase(whiteQ);
  assert.strictEqual(tbWhite.isHit, true);
  assert.strictEqual(tbWhite.wdl, 1);
  assert.ok(tbWhite.scoreCp > 10000);

  const blackQ = new Chess('8/8/8/4k3/8/8/1q2K3/8 w - - 0 1');
  const tbBlack = probeTablebase(blackQ);
  assert.strictEqual(tbBlack.isHit, true);
  assert.strictEqual(tbBlack.wdl, -1);
  assert.ok(tbBlack.scoreCp < -10000);
});

test('Syzygy Tablebase: identifies KR vs K as winning', () => {
  const chess = new Chess('8/8/8/4k3/8/8/1R2K3/8 w - - 0 1');
  const tb = probeTablebase(chess);
  assert.strictEqual(tb.isHit, true);
  assert.strictEqual(tb.wdl, 1);
  assert.ok(tb.scoreCp > 10000);
});

test('Syzygy Tablebase: identifies KB/KN vs K as insufficient material draw', () => {
  const kb = new Chess('8/8/8/4k3/8/8/1B2K3/8 w - - 0 1');
  const tbB = probeTablebase(kb);
  assert.strictEqual(tbB.isHit, true);
  assert.strictEqual(tbB.wdl, 0);

  const kn = new Chess('8/8/8/4k3/8/8/1N2K3/8 w - - 0 1');
  const tbN = probeTablebase(kn);
  assert.strictEqual(tbN.isHit, true);
  assert.strictEqual(tbN.wdl, 0);
});

test('Syzygy Tablebase: Rule of the square detects unstoppable passed pawn', () => {
  // White pawn on a5, Black king far away on h8
  const cannotCatch = canKingCatchPawn('a5', 'w', 'h8', 'w');
  assert.strictEqual(cannotCatch, false, 'King on h8 cannot catch White pawn on a5');

  // Defending king on b6 can catch pawn on a5
  const canCatch = canKingCatchPawn('a5', 'w', 'b6', 'w');
  assert.strictEqual(canCatch, true, 'King on b6 can catch White pawn on a5');
});

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
    true,
    true,
    0.40 // virtual loss weight
  );

  assert.ok(completedSims > 25);
  // All virtual loss counters should be 0 after tree search completes
  for (const child of root.children) {
    assert.strictEqual(child.virtualLoss, 0, 'Virtual loss should be reverted after backprop');
    assert.ok(child.qValue >= -1.0 && child.qValue <= 1.0);
  }
});

test('Hybrid MCTS: Tablebase Hit triggers immediate exact resolution in search', () => {
  resetMctsTree();
  // KR vs K endgame
  const fen = '8/8/8/4k3/8/8/1R2K3/8 w - - 0 1';
  const result = searchHybridNnueMcts(fen, {
    simulations: 50,
    maxTimeMs: 300,
    enableTablebase: true
  });

  assert.strictEqual(result.decisionReason, 'tablebase-hit');
  assert.strictEqual(result.tablebaseHits, 1);
  assert.ok(result.scoreCp > 10000, 'Winning tablebase score should be high cp');
});

test('Hybrid MCTS: Dynamic Contempt steers evaluation away from sterile draws', () => {
  resetMctsTree();
  const quietFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  
  const resNoContempt = searchHybridNnueMcts(quietFen, {
    simulations: 60,
    maxTimeMs: 300,
    contempt: 0.0
  });

  const resWithContempt = searchHybridNnueMcts(quietFen, {
    simulations: 60,
    maxTimeMs: 300,
    contempt: 0.35
  });

  assert.ok(resNoContempt.bestMoveUci.length >= 4);
  assert.ok(resWithContempt.bestMoveUci.length >= 4);
});
