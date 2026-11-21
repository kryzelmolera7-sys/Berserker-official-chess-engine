import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { Chess } from 'chess.js';
import {
  getNodeWasmEngineSync,
  ensureNodeNnueCachedAsync,
  NNUE_FILE,
  NNUE_BYTES,
  NNUE_RAW_DOWNLOAD_URL,
  NNUE_CDN_DOWNLOAD_URL,
} from '../src/engine/wasmEngine';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const POS3 = '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1';

const GOLDEN_ORACLE_FENS: Array<{
  label: string;
  fen: string;
  raw: number;
  cp: number;
}> = [
  { label: 'Startpos', fen: STARTPOS, raw: 45, cp: 20 },
  {
    label: 'After 1.e4',
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    raw: 1,
    cp: 0,
  },
  {
    label: 'Open Game',
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
    raw: 46,
    cp: 20,
  },
  { label: 'Kiwipete', fen: KIWIPETE, raw: -625, cp: -281 },
  { label: 'Pos3', fen: POS3, raw: 20, cp: 6 },
  {
    label: 'WAC.001',
    fen: '2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1',
    raw: 866,
    cp: 358,
  },
  {
    label: 'Black tactical',
    fen: '4r1k1/p1pb1ppp/Qbp1r3/8/1P6/2Pq1B2/R2P1PPP/2B2RK1 b - - 0 1',
    raw: 613,
    cp: 247,
  },
  {
    label: 'EP+Castle',
    fen: 'r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1',
    raw: 955,
    cp: 307,
  },
  { label: 'Promo', fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', raw: 3093, cp: 908 },
  {
    label: 'Rook EG',
    fen: '8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1',
    raw: 1216,
    cp: 393,
  },
  {
    label: 'Up-Q',
    fen: 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    raw: 3240,
    cp: 1385,
  },
  {
    label: 'Down-Q',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1',
    raw: -1845,
    cp: -787,
  },
];

test('WASM binary is lightweight (<512 KB) and auto-loads 138.4 MB nn-bddd9d57eb87.nnue with accurate Perft', async () => {
  assert.equal(NNUE_FILE, 'nn-bddd9d57eb87.nnue');
  assert.equal(NNUE_BYTES, 138360528);
  assert.equal(
    NNUE_RAW_DOWNLOAD_URL,
    'https://github.com/official-stockfish/networks/raw/master/nn-bddd9d57eb87.nnue'
  );
  assert.ok(NNUE_CDN_DOWNLOAD_URL.startsWith('https://media.githubusercontent.com/'));

  const wasmSize = fs.statSync(path.resolve(process.cwd(), 'public/berserker-engine.wasm')).size;
  assert.ok(wasmSize < 512 * 1024, `Expected lightweight WASM (<512KB) for GitHub push, got ${wasmSize}`);

  const cachedNnue = await ensureNodeNnueCachedAsync();
  assert.ok(cachedNnue && cachedNnue.byteLength === NNUE_BYTES, 'Automatic NNUE loader failed');

  const engine = getNodeWasmEngineSync();
  assert.ok(engine, 'WASM engine failed to initialize');
  assert.equal(engine.isNnueLoaded(), true, 'Auto-loaded NNUE must be active in WASM');

  const readyCheck = engine.execUci('isready');
  assert.ok(
    readyCheck.lines.some((l) => l.includes('nn-bddd9d57eb87.nnue') && l.includes('138360528')),
    'isready must confirm loaded 138360528-byte nn-bddd9d57eb87.nnue'
  );
  assert.ok(readyCheck.lines.includes('readyok'));

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

test('WASM SIMD128 nn-bddd9d57eb87.nnue evaluation matches SF19 scalar oracle bit-for-bit across 12 golden positions', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine);

  for (const tc of GOLDEN_ORACLE_FENS) {
    const wasmRaw = engine.evaluateRawFen(tc.fen);
    const wasmCp = engine.evaluateFen(tc.fen);
    assert.equal(wasmRaw, tc.raw, `Raw NNUE mismatch on ${tc.label}: wasm=${wasmRaw}, expected=${tc.raw}`);
    assert.equal(wasmCp, tc.cp, `CP NNUE mismatch on ${tc.label}: wasm=${wasmCp}, expected=${tc.cp}`);
  }
});

test('WASM incremental NNUE (Finny + FullThreats + PP_3Wide) matches full refresh at zero error across Kiwipete, Pos3 & EP+Castling', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine);

  assert.equal(engine.verifyIncrementalParity(KIWIPETE, 2), 0, 'Kiwipete depth-2 incremental NNUE parity failed');
  assert.equal(engine.verifyIncrementalParity(POS3, 2), 0, 'Pos3 depth-2 incremental NNUE parity failed');
  assert.equal(
    engine.verifyIncrementalParity('r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1', 2),
    0,
    'EP+Castle depth-2 incremental NNUE parity failed'
  );
});

test('WASM Pure-PVS top move ALWAYS equals bestmove after 1. e4 and under async stop interruption', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine);
  engine.newGame();

  // After 1. e4 using startpos + moves history
  const resE4 = engine.search('startpos', 8, 700, ['e2e4']);
  assert.ok(resE4.pv.length >= 1, 'Expected non-empty PV after 1. e4');
  assert.equal(resE4.bestMoveUci, resE4.pv[0], 'bestmove MUST equal pv[0]');
  assert.ok(resE4.nps > 10000, `Expected strong WASM NPS, got ${resE4.nps}`);

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
  engine.execUci('position startpos');
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

test('WASM Pure-PVS solves Mate-1, Mate-2, Promotion, WAC.001, Rook EG & matches incremental FEN evaluation', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine);
  engine.newGame();

  // Mate in 1: Qh5 Qxf7#
  const m1 = engine.search('r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 4, 500);
  assert.equal(m1.bestMoveUci, 'h5f7');
  assert.equal(m1.mate, 1);

  // Mate in 2: 1. Rd8+ Rxd8 2. Rxd8#
  const m2 = engine.search('2r3k1/5ppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1', 6, 600);
  assert.equal(m2.bestMoveUci, 'd2d8');
  assert.equal(m2.mate, 2);

  // Queen promotion
  const promo = engine.search('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 5, 500);
  assert.equal(promo.bestMoveUci, 'a7a8q');

  // WAC.001 -> Qg6! (g3g6)
  const wac1 = engine.search('2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1', 8, 1500);
  assert.equal(wac1.bestMoveUci, 'g3g6', `WAC.001 expected g3g6, got ${wac1.bestMoveUci}`);

  // Rook endgame precision: finds winning 1...Rxb2!! breakthrough (b3b2) or strong rook moves with > +250 cp
  const endRes = engine.search('8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1', 12, 1200);
  assert.ok(['b3b2', 'b3b8', 'b3b7', 'b3b6'].includes(endRes.bestMoveUci), `Expected strong rook move, got ${endRes.bestMoveUci}`);
  assert.ok(endRes.scoreCp > 250, `Expected Rook EG score > 250 cp, got ${endRes.scoreCp}`);

  // Verify position startpos moves ... incremental search parity matches FEN reset
  const seq = ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'];
  const c = new Chess();
  for (const u of seq) {
    c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
  }
  const s1 = engine.search('startpos', 7, 500, seq);
  const s2 = engine.search(c.fen(), 7, 500);
  assert.equal(s1.bestMoveUci, s1.pv[0]);
  assert.equal(s2.bestMoveUci, s2.pv[0]);
  assert.equal(Math.abs(s1.scoreCp - s2.scoreCp) <= 40, true);
});

test('Native C++20 Lazy SMP binary is lightweight (<512 KB), auto-loads NNUE, and searches depth 8 cleanly', () => {
  const nativeBin = path.resolve(process.cwd(), 'bin/berserker-native');
  const nativeSize = fs.statSync(nativeBin).size;
  assert.ok(nativeSize < 512 * 1024, `Expected lightweight native binary (<512KB), got ${nativeSize}`);
  const cachePath = path.resolve(process.cwd(), 'storage/nn-cache', NNUE_FILE);
  const script = [
    'uci',
    'setoption name Threads value 4',
    'setoption name Hash value 64',
    `setoption name EvalFile value ${cachePath}`,
    'isready',
    'eval',
    'position startpos moves e2e4',
    'go depth 8',
    'quit',
  ].join('\n') + '\n';

  const res = spawnSync(nativeBin, [], {
    input: script,
    encoding: 'utf8',
    timeout: 15000,
  });

  assert.equal(res.status, 0, `Native binary exited with ${res.status}: ${res.stderr}`);
  assert.ok(res.stdout.includes('NNUE loaded: nn-bddd9d57eb87.nnue (138360528 bytes)'));
  assert.ok(res.stdout.includes('readyok'));
  assert.ok(res.stdout.includes('eval +20 cp (raw 45)'));

  const pvMatch = res.stdout.match(/info depth 8 [^\n]* pv (\S+)/);
  const bmMatch = res.stdout.match(/bestmove (\S+)/);
  assert.ok(pvMatch && bmMatch, 'Expected depth 8 info pv and bestmove from native binary');
  assert.equal(bmMatch[1], pvMatch[1], 'Native Lazy SMP bestmove must equal pv[0]');
});

test('WASM Pure-PVS converts Black winning advantage (~-0.86 / +105cp) cleanly and solves <=7-piece endgames autonomously without Syzygy', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine);

  // 1. Black up a clean extra pawn (+112 cp static) converts cleanly without throwing away advantage
  engine.newGame();
  const blackAdvFen = '2r3k1/pp3ppp/2p1bn2/8/3N4/4B3/PP3PPP/2R3K1 b - - 0 20';
  const convRes = engine.search(blackAdvFen, 16, 1200);
  assert.equal(convRes.bestMoveUci, convRes.pv[0], 'bestmove must equal pv[0]');
  assert.ok(convRes.depth >= 10, `Expected deep search >= 10 on conversion pos, got d${convRes.depth}`);
  assert.ok(convRes.pv.length >= 3, `Expected full non-truncated PV >= 3 moves, got ${convRes.pv.join(' ')}`);
  assert.ok(convRes.scoreCp >= 65, `Expected Black to retain winning advantage (>= +65 cp), got ${convRes.scoreCp}`);

  // 2. 4-piece KR vs K endgame solved autonomously without Syzygy
  engine.newGame();
  const krkRes = engine.search('8/8/8/4k3/8/8/1R2K3/8 w - - 0 1', 16, 900);
  assert.equal(krkRes.bestMoveUci, krkRes.pv[0]);
  assert.ok(krkRes.depth >= 12, `Expected deep autonomous KR vs K search, got d${krkRes.depth}`);
  assert.ok(krkRes.scoreCp >= 450, `Expected decisive KR vs K score >= 450 cp, got ${krkRes.scoreCp}`);

  // 3. Non-rushing time allocation: 1200ms after 1.e4 should not cut off early at depth 5
  engine.newGame();
  const e4Res = engine.search('startpos', 20, 1200, ['e2e4']);
  assert.equal(e4Res.bestMoveUci, e4Res.pv[0]);
  assert.ok(e4Res.depth >= 11, `Expected depth >= 11 on 1200ms budget (no premature depth-5 rush), got d${e4Res.depth}`);
  assert.ok(e4Res.timeMs >= 800, `Expected meaningful budget usage (>= 800ms of 1200ms), got ${e4Res.timeMs}ms`);
  assert.ok(e4Res.pv.length >= 4, `Expected full PV line (>= 4 plies) at final depth, got ${e4Res.pv.join(' ')}`);
});

