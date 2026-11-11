import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { computeEndgameSqueezeBonus, evaluateBRnnueV070 } from '../src/engine/brnnueDualEval';
import { computeMovePriors, searchHybridNnueMcts } from '../src/engine/berserkerMctsHybrid';
import { searchIndependentBerserker } from '../src/engine/berserkerIndependentSearch';
import { computeEndgameSqueezeBonus as cliSqueezeBonus, evaluatePosition as cliEvaluate } from '../berserker-cli.js';

test('Centipawn Squeeze Matrix: Rule of the square awards massive bonus for unstoppable pawn', () => {
  // White pawn on a5, Black king on h8, White king on a1.
  // Pawn on a5 is 3 steps from promo (a8). Black king on h8 is 7 squares away from a8.
  // Unstoppable pawn!
  const fen = '7k/8/8/P7/8/8/8/K7 w - - 0 1';
  const chess = new Chess(fen);
  const bonus = computeEndgameSqueezeBonus(chess);

  assert.ok(bonus >= 650, `Expected unstoppable pawn bonus >= 650, got ${bonus}`);
});

test('Centipawn Squeeze Matrix: Tarrasch Rule awards bonus for rook behind passed pawn', () => {
  // White pawn on e5, White rook on e1 (behind pawn on same file)
  const fenWithRookBehind = '6k1/8/8/4P3/8/8/8/4R1K1 w - - 0 1';
  const chessBehind = new Chess(fenWithRookBehind);
  const bonusBehind = computeEndgameSqueezeBonus(chessBehind);

  // White pawn on e5, White rook on a1 (not behind pawn)
  const fenWithRookAway = '6k1/8/8/4P3/8/8/8/R5K1 w - - 0 1';
  const chessAway = new Chess(fenWithRookAway);
  const bonusAway = computeEndgameSqueezeBonus(chessAway);

  assert.ok(
    bonusBehind > bonusAway,
    `Rook behind passed pawn (${bonusBehind}) should exceed rook away (${bonusAway})`
  );
  assert.ok(
    bonusBehind - bonusAway >= 55,
    `Tarrasch rook delta should be at least +55cp, got ${bonusBehind - bonusAway}`
  );
});

test('Centipawn Squeeze Matrix: King centralization & opposition drive', () => {
  // Centralized king (d4) vs king in corner (h1)
  const fenCentral = '8/8/8/4k3/3K4/8/8/8 w - - 0 1';
  const chessCentral = new Chess(fenCentral);
  const bonusCentral = computeEndgameSqueezeBonus(chessCentral);

  const fenCorner = '8/8/8/4k3/8/8/8/7K w - - 0 1';
  const chessCorner = new Chess(fenCorner);
  const bonusCorner = computeEndgameSqueezeBonus(chessCorner);

  assert.ok(
    bonusCentral > bonusCorner,
    `Centralized king (${bonusCentral}) should score higher than cornered king (${bonusCorner})`
  );
});

test('MCTS Move Priors: Tarrasch rook move receives prior boost', () => {
  // White has passed pawn on e6, rook on a1.
  // Moving rook to e1 (Re1 behind passed pawn) vs Ra2 (sideways)
  const fen = '6k1/8/4P3/8/8/8/8/R5K1 w - - 0 1';
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });

  const priors = computeMovePriors(chess, moves);
  const re1Idx = moves.findIndex(m => m.from === 'a1' && m.to === 'e1');
  const ra2Idx = moves.findIndex(m => m.from === 'a1' && m.to === 'a2');

  assert.ok(re1Idx !== -1, 'Re1 should be legal');
  assert.ok(ra2Idx !== -1, 'Ra2 should be legal');
  assert.ok(
    priors[re1Idx] > priors[ra2Idx],
    `Tarrasch move Re1 prior (${priors[re1Idx]}) should exceed sideways Ra2 prior (${priors[ra2Idx]})`
  );
});

test('MCTS Move Priors: King centralization move receives prior boost in endgame', () => {
  // King on e2 can move to e3 (toward center) or e1 (retreating to back rank)
  const fen = '8/8/8/4k3/8/8/4K3/8 w - - 0 1';
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });

  const priors = computeMovePriors(chess, moves);
  const ke3Idx = moves.findIndex(m => m.from === 'e2' && m.to === 'e3');
  const ke1Idx = moves.findIndex(m => m.from === 'e2' && m.to === 'e1');

  assert.ok(ke3Idx !== -1, 'Ke3 should be legal');
  assert.ok(ke1Idx !== -1, 'Ke1 should be legal');
  assert.ok(
    priors[ke3Idx] > priors[ke1Idx],
    `Centering Ke3 prior (${priors[ke3Idx]}) should exceed retreating Ke1 prior (${priors[ke1Idx]})`
  );
});

test('Independent PVS Search: Integrates evaluateBRnnueV070 and finds decisive winning move', () => {
  // White has mate in 1: Qxf7#
  const fen = 'r1bqkb1r/pppp1ppp/2n5/4p3/2B1n3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 1';
  const stats = searchIndependentBerserker(fen, 4);

  assert.equal(stats.bestMoveSan, 'Qxf7#', `Expected Qxf7#, got ${stats.bestMoveSan}`);
  assert.ok(stats.scoreCp > 15000, `Expected mate score, got ${stats.scoreCp}`);
});

test('Standalone CLI Engine: computeEndgameSqueezeBonus matches TypeScript implementation', () => {
  const fen = '7k/8/8/P7/8/8/8/K7 w - - 0 1';
  const chessTs = new Chess(fen);
  const tsBonus = computeEndgameSqueezeBonus(chessTs);
  const cliBonus = cliSqueezeBonus(chessTs);

  assert.equal(tsBonus, cliBonus, `TS bonus (${tsBonus}) should match CLI bonus (${cliBonus})`);
  assert.ok(cliBonus >= 650, 'CLI bonus should detect unstoppable pawn');
});
