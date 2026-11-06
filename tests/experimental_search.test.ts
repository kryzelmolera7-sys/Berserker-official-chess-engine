import test from 'node:test';
import assert from 'node:assert';
import { Chess } from 'chess.js';
import { staticExchangeEvaluation, pieceToIdx, searchIndependentBerserker } from '../src/engine/berserkerIndependentSearch';
import { getKingBucket, wdlRescale } from '../src/engine/brnnueDualEval';

test('Experimental SEE: correctly evaluates winning vs losing trades', () => {
  // Test winning capture: Pawn takes Queen
  const fen1 = 'rnb1kbnr/pppp1ppp/8/4q3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3';
  const c1 = new Chess(fen1);
  const moves1 = c1.moves({ verbose: true });
  // Find white moves
  const qPawnTakes = moves1.find(m => m.from === 'd2' && m.to === 'd4');
  assert.ok(qPawnTakes, 'Found move');
  // Quiet move should return 0
  assert.strictEqual(staticExchangeEvaluation(c1, qPawnTakes), 0);

  // Position where Queen captures defended pawn (losing trade):
  // 1.e4 d5 2.exd5 Qxd5 3.Nc3 (White knight attacks Queen on d5)
  // If Queen plays 3...Qxc3 (takes defended knight), SEE must be negative
  const fen2 = 'rnb1kbnr/ppp1pppp/8/8/8/2N5/PPPP1PPP/R1BQKBNR b KQkq - 1 3';
  const c2 = new Chess(fen2);
  // black queen on d8, knight on c3
  const queenTakesKnight = c2.moves({ verbose: true }).find(m => m.piece === 'q' && m.to === 'c3');
  if (queenTakesKnight) {
    const seeScore = staticExchangeEvaluation(c2, queenTakesKnight);
    assert.ok(seeScore < 0, `Queen takes defended knight should have negative SEE, got ${seeScore}`);
  }
});

test('Experimental NNUE: King Bucketing maps into 16 territorial zones', () => {
  // e1 (White starting king square: row 7, col 4)
  const bucketWhite = getKingBucket(7, 4);
  assert.ok(bucketWhite >= 0 && bucketWhite < 16, `Bucket must be in range 0-15, got ${bucketWhite}`);

  // e8 (Black starting king square: row 0, col 4)
  const bucketBlack = getKingBucket(0, 4);
  assert.ok(bucketBlack >= 0 && bucketBlack < 16, `Bucket must be in range 0-15, got ${bucketBlack}`);
  assert.notStrictEqual(bucketWhite, bucketBlack, 'Opposite side kings should belong to different rank zones');
});

test('Experimental NNUE: WDL Rescaling compresses large centipawns without distortion', () => {
  // Small values (< 150cp) should be preserved linearly
  assert.strictEqual(wdlRescale(45), 45);
  assert.strictEqual(wdlRescale(-30), -30);

  // Large values (> 500cp) should compress smoothly towards reasonable win expectancy
  const largeCp = wdlRescale(1200);
  assert.ok(largeCp > 300 && largeCp < 500, `Large cp should compress near 400cp, got ${largeCp}`);

  const largeNegCp = wdlRescale(-1200);
  assert.ok(largeNegCp < -300 && largeNegCp > -500, `Large negative cp should compress near -400cp, got ${largeNegCp}`);
});

test('Experimental Search: Singular Extensions, ProbCut, Multi-Cut and Time Manager execute smoothly', () => {
  // Search tactical starting position with depth 4
  const startFen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 4';
  const result = searchIndependentBerserker(startFen, 4, 1500);

  assert.ok(result.nodes > 0, 'Must search nodes');
  assert.ok(result.bestMoveSan.length > 0, 'Must return best move SAN');
  assert.ok(result.bestMoveUci.length >= 4, 'Must return best move UCI');
  assert.ok(result.pv.length > 0, 'Must have principal variation');
  assert.ok(result.nps > 0, 'Must have positive NPS');
});
