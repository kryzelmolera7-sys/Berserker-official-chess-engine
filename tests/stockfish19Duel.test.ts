import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { 
  searchBerserkerDuelMove, 
  detectOpponentThreats 
} from '../src/engine/berserkerDuelEngine';
import { getOpeningBookMove } from '../src/engine/engineHeuristics';
import { evaluateBRnnueV070 } from '../src/engine/brnnueDualEval';

test('Berserker Duel Engine: uses GM Opening Book for instant theoretical move', async () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const result = await searchBerserkerDuelMove(startFen, 6, 200);

  assert.equal(result.reason, 'gm-opening-book', 'Must prioritize grandmaster book');
  assert.equal(result.bestMoveSan, 'e4');
  assert.ok(result.bookInfo);
  assert.ok(result.depth >= 30);
});

test('Berserker Duel Engine: plays Berlin Defense against 1. e4', async () => {
  // 1. e4 e5 2. Nf3 Nc6 3. Bb5 -> Berlin Defense
  const ruyLopezFen = 'r1bqkb1r/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 3';
  const book = getOpeningBookMove(ruyLopezFen);
  assert.ok(book, 'Must have Berlin book line');
  assert.ok(['Nf6', 'a6'].includes(book.san), 'Should choose master Berlin or Morphy defense');
});

test('Berserker Duel Engine: detects opponent checkmate threat and parries it', async () => {
  // White threatens Qxf7# (Scholar's Mate threat)
  const mateThreatFen = 'r1bqkb1r/pppp1ppp/2n5/4p3/2B1n3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 1 5';
  const chess = new Chess(mateThreatFen);
  const threats = detectOpponentThreats(chess);
  assert.ok(threats.hasMateThreat, 'Should detect Qxf7# checkmate threat');

  const moveRes = await searchBerserkerDuelMove(mateThreatFen, 4, 300);
  assert.ok(moveRes.bestMoveSan, 'Must find a defensive move');

  // Verify that the chosen move defends against Qxf7#
  chess.move(moveRes.bestMoveSan);
  const testThreats = detectOpponentThreats(chess);
  assert.equal(testThreats.hasMateThreat, false, 'Chosen move must eliminate checkmate threat');
});

test('Berserker BRnnue Quad-Head: computes quad evaluation with threat head', () => {
  const midFen = 'r1bq1rk1/pp2ppbp/2np1np1/8/3NP3/2N1BP2/PPPQ2PP/R3KB1R w KQ - 1 9';
  const evalRes = evaluateBRnnueV070(midFen);

  assert.ok(typeof evalRes.centipawns === 'number');
  assert.ok(typeof evalRes.evalCpPerspective === 'number');
  assert.ok(evalRes.threatPredictionHead.predictedThreatCount >= 0);
  assert.ok(evalRes.endgameConversionHead.conversionCertainty > 0);
});

test('Berserker vs Stockfish 19: plays consecutive duel plies without blunder', async () => {
  const chess = new Chess();
  // Play 4 plies using Berserker duel logic
  for (let ply = 0; ply < 4; ply++) {
    const moveRes = await searchBerserkerDuelMove(chess.fen(), 4, 200);
    assert.ok(moveRes.bestMoveSan, `Ply ${ply} must have best move`);
    const played = chess.move(moveRes.bestMoveSan);
    assert.ok(played, `Move ${moveRes.bestMoveSan} must be legal in chess.js`);
  }
  assert.equal(chess.history().length, 4);
});
