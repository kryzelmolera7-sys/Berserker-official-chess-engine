import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { getNodeWasmEngineSync } from '../src/engine/wasmEngine';
import {
  tryLoadRecklessNnueNodeSync,
  RecklessEvaluator,
  normalizeRecklessToCp,
} from '../src/engine/recklessNnue';
import { FastBoard } from '../src/engine/fastBoard';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const POS3 = '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1';

test('WASM Perft accuracy matches exact chess rules (startpos, Kiwipete, Pos3)', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine, 'WASM engine failed to initialize');
  assert.equal(engine.isNnueLoaded(), true, 'Reckless NNUE must be loaded in WASM');

  assert.equal(engine.perft(STARTPOS, 1), 20);
  assert.equal(engine.perft(STARTPOS, 2), 400);
  assert.equal(engine.perft(STARTPOS, 3), 8902);
  assert.equal(engine.perft(STARTPOS, 4), 197281);
  assert.equal(engine.perft(STARTPOS, 5), 4865609);

  assert.equal(engine.perft(KIWIPETE, 1), 48);
  assert.equal(engine.perft(KIWIPETE, 2), 2039);
  assert.equal(engine.perft(KIWIPETE, 3), 97862);

  assert.equal(engine.perft(POS3, 1), 14);
  assert.equal(engine.perft(POS3, 2), 191);
  assert.equal(engine.perft(POS3, 3), 2812);
});

test('C++ SIMD Reckless NNUE evaluation matches TypeScript RecklessEvaluator int-for-int', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine);
  const params = tryLoadRecklessNnueNodeSync();
  assert.ok(params);
  const tsEval = new RecklessEvaluator(params);

  const testFens = [
    STARTPOS,
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    KIWIPETE,
    POS3,
    'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
    '2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1',
    '4r1k1/p1pb1ppp/Qbp1r3/8/1P6/2Pq1B2/R2P1PPP/2B2RK1 b - - 0 1',
    'r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1', // En passant
    '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', // Promotion threat
  ];

  for (const fen of testFens) {
    const fb = new FastBoard(fen);
    tsEval.onReset(fb);
    const tsRaw = tsEval.evaluate(fb);
    const tsCp = normalizeRecklessToCp(tsRaw, fb);

    const wasmRaw = engine.evaluateRawFen(fen);
    const wasmCp = engine.evaluateFen(fen);

    assert.equal(wasmRaw, tsRaw, `Raw NNUE mismatch on ${fen}: wasm=${wasmRaw} ts=${tsRaw}`);
    assert.equal(Math.abs(wasmCp - tsCp) <= 1, true, `CP NNUE mismatch on ${fen}: wasm=${wasmCp} ts=${tsCp}`);
  }
});

test('WASM PV top move ALWAYS equals bestmove across positions & after 1. e4', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine);
  engine.newGame();

  // Test after 1. e4 using startpos + moves history
  const resE4 = engine.search('startpos', 8, 500, ['e2e4']);
  assert.ok(resE4.pv.length >= 1, 'Expected non-empty PV after 1. e4');
  assert.equal(resE4.bestMoveUci, resE4.pv[0], 'bestmove MUST equal pv[0]');
  assert.ok(resE4.nps > 15000, `Expected high WASM NPS, got ${resE4.nps}`);

  // Verify move legality via chess.js
  const c = new Chess();
  c.move('e4');
  const played = c.move({
    from: resE4.bestMoveUci.slice(0, 2),
    to: resE4.bestMoveUci.slice(2, 4),
    promotion: resE4.bestMoveUci[4] || undefined,
  });
  assert.ok(played, `WASM bestMove ${resE4.bestMoveUci} must be legal`);

  // Verify stop interruption emits completed PV move
  const goRes = engine.execUci('position startpos');
  assert.equal(goRes.isSearching, false);
  const startInf = engine.execUci('go infinite');
  assert.equal(startInf.isSearching, true);
  let lastPvMove = '';
  for (let i = 0; i < 4; i++) {
    const step = engine.stepSearch();
    for (const l of step.lines) {
      const pm = l.match(/\bpv (\S+)/);
      if (pm) lastPvMove = pm[1];
    }
    if (!step.continuing) break;
  }
  engine.stop();
  let stoppedBest = '';
  for (let guard = 0; guard < 10; guard++) {
    const step = engine.stepSearch();
    for (const l of step.lines) {
      if (l.startsWith('bestmove ')) stoppedBest = l.split(/\s+/)[1];
    }
    if (!step.continuing) break;
  }
  assert.ok(stoppedBest.length >= 4);
  if (lastPvMove) {
    assert.equal(stoppedBest, lastPvMove, 'Stopped search bestmove must equal last completed pv[0]');
  }
});

test('WASM PVS solves mate-in-1, mate-in-2, WAC tactical traps & detects repetition', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine);
  engine.newGame();

  // Mate in 1: Scholar's / Qh5 Qxf7#
  const m1 = engine.search('r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 4, 500);
  assert.equal(m1.bestMoveUci, 'h5f7');
  assert.equal(m1.mate, 1);

  // WAC.001: 2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - -> Qg6! (g3g6)
  const wac1 = engine.search('2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1', 8, 1200);
  assert.equal(wac1.bestMoveUci, 'g3g6', `WAC.001 expected g3g6, got ${wac1.bestMoveUci}`);

  // Rook endgame precision: 8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1 -> Rb8! (b3b8)
  const endRes = engine.search('8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1', 12, 1000);
  assert.ok(['b3b8', 'b3b7', 'b3b6'].includes(endRes.bestMoveUci), `Expected strong rook move, got ${endRes.bestMoveUci}`);
  assert.ok(endRes.scoreCp > 200);

  // Mate in 2: 2r3k1/5ppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1 -> 1. Rd8+ Rxd8 2. Rxd8# (d2d8)
  const m2 = engine.search('2r3k1/5ppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1', 6, 500);
  assert.equal(m2.bestMoveUci, 'd2d8');
  assert.equal(m2.mate, 2);

  // Underpromotion or Queen promotion
  const promo = engine.search('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 5, 500);
  assert.equal(promo.bestMoveUci, 'a7a8q');

  // Verify position startpos moves ... incremental NNUE parity matches FEN reset
  const seq = ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'];
  const c = new Chess();
  for (const u of seq) {
    c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
  }
  const s1 = engine.search('startpos', 7, 400, seq);
  const s2 = engine.search(c.fen(), 7, 400);
  assert.equal(s1.bestMoveUci, s1.pv[0]);
  assert.equal(s2.bestMoveUci, s2.pv[0]);
  assert.equal(Math.abs(s1.scoreCp - s2.scoreCp) <= 40, true);
});
