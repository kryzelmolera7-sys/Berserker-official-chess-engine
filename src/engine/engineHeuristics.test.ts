import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import {
  getOpeningBookMove,
  getMvvLvaScore,
  sortMovesMvvLva,
  quiescenceSearch,
  evaluateKingSafety,
  calculateContemptBonus,
  blendMultiPvCandidates
} from './engineHeuristics';

test('1. GM Opening Book: detects initial position and theoretical responses', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const startMove = getOpeningBookMove(startFen);
  assert.ok(startMove !== null);
  assert.equal(startMove?.san, 'e4');
  assert.equal(startMove?.uci, 'e2e4');

  const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const sicilianReply = getOpeningBookMove(afterE4);
  assert.ok(sicilianReply !== null);
  assert.equal(sicilianReply?.san, 'c5');
  assert.equal(sicilianReply?.openingName, 'Sicilian Defense');

  // Random arbitrary position should gracefully return null
  const arbitraryFen = '8/8/8/4k3/4K3/8/8/8 w - - 0 1';
  assert.equal(getOpeningBookMove(arbitraryFen), null);
});

test('2. MVV-LVA Capture Scoring & Quiescence Search: orders captures correctly', () => {
  // P takes Q should be vastly higher priority than Q takes P
  const pTakesQ = getMvvLvaScore('p', 'q');
  const qTakesP = getMvvLvaScore('q', 'p');
  assert.ok(pTakesQ > qTakesP, `Expected ${pTakesQ} > ${qTakesP}`);
  assert.equal(pTakesQ, 900 * 10 - 100); // 8900
  assert.equal(qTakesP, 100 * 10 - 900); // 100

  // Verify sortMovesMvvLva orders captures ahead of quiet moves
  const fakeMoves = [
    { from: 'e2', to: 'e4', piece: 'p' },
    { from: 'e1', to: 'e2', piece: 'k', captured: 'p' },
    { from: 'd1', to: 'd8', piece: 'q', captured: 'q' }
  ];
  const sorted = sortMovesMvvLva(fakeMoves);
  assert.ok(sorted[0].captured);
  assert.equal(sorted[0].captured, 'q'); // QxQ is top capture

  // Verify quiescence search runs on standard position
  const chess = new Chess();
  const qScore = quiescenceSearch(chess, -10000, 10000, 0, 2);
  assert.equal(typeof qScore, 'number');
  assert.equal(qScore, 0); // Balanced start
});

test('3. King Safety & Storm Matrix: detects intact shields vs broken shelters', () => {
  const chess = new Chess();
  const whiteSafety = evaluateKingSafety(chess, 'w');
  assert.equal(whiteSafety.isCastled, false);
  assert.equal(whiteSafety.shieldIntegrityPct, 100); // Pawns intact on starting ranks
  assert.ok(whiteSafety.stormThreatIndex < 50);

  // Expose White's king with pushed/missing pawns
  const exposedChess = new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPP4/RNBQKBNR w KQkq - 0 1');
  const brokenSafety = evaluateKingSafety(exposedChess, 'w');
  // f, g, h pawns missing
  assert.ok(brokenSafety.shieldIntegrityPct < 50, `Expected broken shield < 50%, got ${brokenSafety.shieldIntegrityPct}%`);
  assert.ok(brokenSafety.netAttackBonusCp > 20, 'Expected high attack bonus for exposing king');
});

test('4. Dynamic Contempt: penalizes sterile queen trades and draw acceptances', () => {
  const chess = new Chess('rnb1kbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  const normalMove = chess.moves({ verbose: true }).find(m => m.san === 'Nf3');
  assert.ok(normalMove);
  const normalBonus = calculateContemptBonus(chess, normalMove, 45);
  assert.equal(normalBonus, 0);

  // Fake queen trade move
  const queenTradeMove = { ...normalMove, piece: 'q', captured: 'q' };
  const tradePenalty = calculateContemptBonus(chess, queenTradeMove, 50);
  assert.equal(tradePenalty, -50);
});

test('5. Multi-PV Hybrid Blending: reranks within tactical threshold based on positional squeeze', () => {
  const chess = new Chess();
  const candidates = [
    { rank: 1, bestMove: 'g1f3', scoreCp: 25, pv: 'g1f3 d7d5' },
    { rank: 2, bestMove: 'e2e4', scoreCp: 18, pv: 'e2e4 e7e5' }, // Delta is 7cp (within 42cp threshold)
    { rank: 3, bestMove: 'h2h4', scoreCp: -90, pv: 'h2h4 d7d5' }
  ];

  // Positional scorer strongly prefers central expansion e2e4 (+50cp) over quiet Nf3 (+10cp)
  const positionalScorer = (uci: string) => (uci === 'e2e4' ? 50 : uci === 'g1f3' ? 10 : -20);

  const result = blendMultiPvCandidates(candidates, chess, positionalScorer, 40);
  assert.equal(result.chosenMoveUci, 'e2e4');
  assert.equal(result.reason, 'positional-rerank');
  assert.equal(result.pvRankChosen, 2);
  assert.equal(result.originalTopUci, 'g1f3');
});
