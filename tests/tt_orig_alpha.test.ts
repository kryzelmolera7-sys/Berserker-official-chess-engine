import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import {
  searchIndependentBerserker,
  clearIndependentSearchState,
  setFixTtOrigAlpha,
} from '../src/engine/berserkerIndependentSearch';

test('TT origAlpha fix: A/B flag toggles cleanly and finds forced mate / winning tactics', () => {
  const tacticalFen = 'r1bqkb1r/pppp1ppp/2n5/4p3/2B1n3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 5';

  setFixTtOrigAlpha(false);
  clearIndependentSearchState();
  const baseRes = searchIndependentBerserker(tacticalFen, 3, 500);
  assert.equal(baseRes.bestMoveSan, 'Qxf7#');

  setFixTtOrigAlpha(true);
  clearIndependentSearchState();
  const impRes = searchIndependentBerserker(tacticalFen, 3, 500);
  assert.equal(impRes.bestMoveSan, 'Qxf7#');
});

test('TT origAlpha fix: returns legal moves across sharp middlegame & endgame FENs', () => {
  const fens = [
    'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 4',
    '3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20',
    '8/5pk1/4p1p1/7p/7P/2r2PK1/6P1/8 w - - 0 40',
  ];

  setFixTtOrigAlpha(true);
  for (const fen of fens) {
    clearIndependentSearchState();
    const res = searchIndependentBerserker(fen, 4, 800);
    const chess = new Chess(fen);
    const legalUcis = new Set(
      chess.moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion || ''}`)
    );
    assert.ok(legalUcis.has(res.bestMoveUci), `Expected legal move for ${fen}, got ${res.bestMoveUci}`);
    assert.ok(res.nodes > 0);
  }
});
