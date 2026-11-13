import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import {
  FastBoard,
  perft,
  exactSeeScore,
  seeGe,
  evaluateFast,
  packMove,
  PT_QUEEN,
  MV_FLAG_CAPTURE,
} from './fastBoard';
import { runFastSearch, clearFastSearchTables } from './fastSearch';

test('FastBoard Perft: Startpos depths 1-4 match exact legal move counts', () => {
  const b = FastBoard.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(perft(b, 1), 20);
  assert.equal(perft(b, 2), 400);
  assert.equal(perft(b, 3), 8902);
  assert.equal(perft(b, 4), 197281);
});

test('FastBoard Perft: Kiwipete (castling, EP, promotions, pins) depths 1-3 exact', () => {
  const b = FastBoard.fromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.equal(perft(b, 1), 48);
  assert.equal(perft(b, 2), 2039);
  assert.equal(perft(b, 3), 97862);
});

test('FastBoard Perft: Position 3 (EP pin, promotion, rook endgame) depths 1-4 exact', () => {
  const b = FastBoard.fromFen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
  assert.equal(perft(b, 1), 14);
  assert.equal(perft(b, 2), 191);
  assert.equal(perft(b, 3), 2812);
  assert.equal(perft(b, 4), 43238);
});

test('FastBoard Perft: Position 4 (promotions, castling, checks) depths 1-3 exact', () => {
  const b = FastBoard.fromFen('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1');
  assert.equal(perft(b, 1), 6);
  assert.equal(perft(b, 2), 264);
  assert.equal(perft(b, 3), 9467);
});

test('FastBoard Exact SEE: X-ray battery & multi-ply swap-off accuracy', () => {
  // White Rook + Queen battery on d-file vs Black Pawn defended by Bishop + Rook:
  // White Rd1 (d1=3), Qd2 (d2=11) vs Black pd5 (d5=35), Be6 (e6=44), Rd8 (d8=59)
  // Actually simpler: White Q+R on e1/e2 vs Black Re8 + pawn d6 defending e5 knight:
  // FEN: 4r1k1/8/3p4/4n3/8/8/4R3/4Q1K1 w - - 0 1
  // Move: Rxe5 (e2=12 -> e5=36, R=4 takes BN=8)
  // Exchanges: White +320 (N), Black dxe5 -500 (R), White Qxe5 +100 (P), Black Rxe5 -950 (Q) -> wait: after White Qxe5 (+100), Black Rxe5 (-950) => net 320-500+100-950 = -1030, so White would STOP after dxe5 -> net 320 - 500 = -180!
  const fen1 = '4r1k1/8/3p4/4n3/8/8/4R3/4Q1K1 w - - 0 1';
  const b1 = FastBoard.fromFen(fen1);
  const moves1 = new Int32Array(256);
  const n1 = b1.generateLegalMoves(moves1, true);
  const rxe5 = Array.from(moves1.subarray(0, n1)).find(m => (m & 63) === 12 && ((m >> 6) & 63) === 36)!;
  assert.ok(rxe5);
  assert.equal(exactSeeScore(b1, rxe5), -180);
  assert.equal(seeGe(b1, rxe5, 0), false);
  assert.equal(seeGe(b1, rxe5, -180), true);

  // Winning capture: White pawn takes undefended Black knight
  const b2 = FastBoard.fromFen('4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 1');
  const moves2 = new Int32Array(256);
  const n2 = b2.generateLegalMoves(moves2, true);
  const dxe5 = moves2[0];
  assert.equal(exactSeeScore(b2, dxe5), 320);
  assert.equal(seeGe(b2, dxe5, 320), true);
});

test('FastBoard Eval Symmetry: flipped board preserves exact negation (modulo tempo)', () => {
  function flipFenColors(fen: string): string {
    const parts = fen.split(' ');
    const rows = parts[0].split('/').reverse().map(row =>
      row.replace(/[a-zA-Z]/g, ch => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()))
    );
    const stm = parts[1] === 'w' ? 'b' : 'w';
    const castling = parts[2] === '-' ? '-' : parts[2].replace(/[KQkq]/g, ch =>
      ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()
    );
    return `${rows.join('/')} ${stm} ${castling} - ${parts[4]} ${parts[5]}`;
  }

  const testFens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 4',
    '3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20',
    '6k1/8/8/4P3/8/8/8/4R1K1 w - - 0 1',
    '8/5pk1/6p1/7p/7P/5KP1/8/8 w - - 0 45',
  ];

  for (const fen of testFens) {
    const b1 = FastBoard.fromFen(fen);
    const b2 = FastBoard.fromFen(flipFenColors(fen));
    const e1 = evaluateFast(b1, 0);
    const e2 = evaluateFast(b2, 0);
    assert.equal(e1, e2, `Symmetry failed for ${fen}: e1=${e1}, e2=${e2}`);
  }
});

test('FastSearch: Solves tactical mate-in-2 and reaches high NPS on middlegame', () => {
  clearFastSearchTables();
  // Proven Mate in 2: 1. Qxa7+ Kxa7 2. Ra1#
  const mate2Fen = 'kr6/pp6/Q7/8/8/4B3/8/3R2K1 w - - 0 1';
  const res = runFastSearch(mate2Fen, 8, 400, 1);
  assert.equal(res.bestMoveUci, 'a6a7', `Expected Qxa7+ (a6a7), got ${res.bestMoveUci} (score=${res.scoreCp}, pv=${res.pvUci.join(' ')})`);
  assert.ok(res.scoreCp > 20000, `Expected mate score > 20000, got ${res.scoreCp}`);

  // Middlegame depth & NPS check (Kiwipete)
  const midFen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  const midRes = runFastSearch(midFen, 10, 250, 1);
  assert.ok(midRes.depth >= 5, `Expected depth >= 5 in 250ms, got ${midRes.depth} (nps=${midRes.nps})`);
  assert.ok(midRes.nps > 20000, `Expected high NPS > 20k, got ${midRes.nps}`);
});
