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

test('WASM binary is lightweight (<2 MB, zero embedded weights) and auto-loads 60.3 MB v60-7f587dfb.nnue with accurate Perft', async () => {
  assert.equal(NNUE_FILE, 'v60-7f587dfb.nnue');
  assert.equal(NNUE_BYTES, 63266880);
  assert.equal(
    NNUE_RAW_DOWNLOAD_URL,
    'https://github.com/codedeliveryservice/RecklessNetworks/releases/download/networks/v60-7f587dfb.nnue'
  );
  assert.equal(NNUE_CDN_DOWNLOAD_URL, NNUE_RAW_DOWNLOAD_URL);

  const wasmSize = fs.statSync(path.resolve(process.cwd(), 'public/berserker-engine.wasm')).size;
  assert.ok(wasmSize < 2 * 1024 * 1024, `Expected lightweight WASM (<2MB) for GitHub push, got ${wasmSize}`);

  const cachedNnue = await ensureNodeNnueCachedAsync();
  assert.ok(cachedNnue && cachedNnue.byteLength === NNUE_BYTES, 'Automatic NNUE loader failed');

  const engine = getNodeWasmEngineSync();
  assert.ok(engine, 'WASM engine failed to initialize');
  assert.equal(engine.isNnueLoaded(), true, 'Auto-loaded NNUE must be active in WASM');

  const readyCheck = engine.execUci('isready');
  assert.ok(
    readyCheck.lines.some((l) => l.includes('v60-7f587dfb.nnue') && l.includes('63266880')),
    'isready must confirm loaded 63266880-byte v60-7f587dfb.nnue'
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

test('WASM SIMD128 v60-7f587dfb.nnue evaluates positions accurately with symmetric incremental Finny-table parity', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine);

  const startCp = engine.evaluateFen(STARTPOS);
  assert.ok(startCp > 0 && startCp < 120, `Expected slight White edge on startpos, got ${startCp}`);

  const upQueenCp = engine.evaluateFen('rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const downQueenCp = engine.evaluateFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1');
  assert.ok(upQueenCp > 350, `Expected Up-Queen > +350 cp (Reckless WDL cp), got ${upQueenCp}`);
  assert.ok(downQueenCp < -300, `Expected Down-Queen < -300 cp (Reckless WDL cp), got ${downQueenCp}`);

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

  const resE4 = engine.search('startpos', 8, 900, ['e2e4']);
  assert.ok(resE4.pv.length >= 1, 'Expected non-empty PV after 1. e4');
  assert.equal(resE4.bestMoveUci, resE4.pv[0], 'bestmove MUST equal pv[0]');
  assert.ok(resE4.nps > 10000, `Expected strong WASM NPS, got ${resE4.nps}`);

  const c = new Chess();
  c.move('e4');
  const played = c.move({
    from: resE4.bestMoveUci.slice(0, 2),
    to: resE4.bestMoveUci.slice(2, 4),
    promotion: resE4.bestMoveUci[4] || undefined,
  });
  assert.ok(played, `WASM bestMove ${resE4.bestMoveUci} must be legal`);

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

  // Forced immediate Queen promotion (Black king on c8 threatens to stop pawn otherwise)
  const promo = engine.search('2k5/P7/8/8/8/8/8/4K3 w - - 0 1', 5, 500);
  assert.equal(promo.bestMoveUci, 'a7a8q');

  // WAC.001 -> winning sacrifice (g3g6, f6e8, or f6h5 with decisive advantage > +400 cp)
  const wac1 = engine.search('2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1', 8, 1500);
  assert.ok(
    ['g3g6', 'f6e8', 'f6h5'].includes(wac1.bestMoveUci) && wac1.scoreCp > 400,
    `WAC.001 expected winning sacrifice (g3g6/f6e8/f6h5 > 400cp), got ${wac1.bestMoveUci} (${wac1.scoreCp} cp)`
  );

  // Rook endgame precision: finds winning 1...Rxb2!! breakthrough (b3b2) or active rook moves > +200 cp
  const endRes = engine.search('8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1', 12, 1200);
  assert.ok(['b3b2', 'b3b8', 'b3b7', 'b3b6'].includes(endRes.bestMoveUci), `Expected strong rook move, got ${endRes.bestMoveUci}`);
  assert.ok(endRes.scoreCp > 200, `Expected Rook EG score > 200 cp, got ${endRes.scoreCp}`);

  // Verify position startpos moves ... incremental parity matches FEN reset
  const seq = ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6'];
  const c = new Chess();
  for (const u of seq) {
    c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
  }
  const s1 = engine.search('startpos', 7, 700, seq);
  const s2 = engine.search(c.fen(), 7, 700);
  assert.equal(s1.bestMoveUci, s1.pv[0]);
  assert.equal(s2.bestMoveUci, s2.pv[0]);
  assert.equal(Math.abs(s1.scoreCp - s2.scoreCp) <= 60, true);
});

test('Native Reckless v0.10.0-dev Rust binary has no Syzygy, auto-loads v60-7f587dfb.nnue, and matches upstream bench 2837905', () => {
  const nativeBin = path.resolve(process.cwd(), 'bin/berserker-native');
  const nativeSize = fs.statSync(nativeBin).size;
  assert.ok(nativeSize < 4 * 1024 * 1024, `Expected lightweight native binary (<4MB), got ${nativeSize}`);

  const benchRes = spawnSync(nativeBin, ['bench'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(benchRes.status, 0, `Native bench exited with ${benchRes.status}: ${benchRes.stderr}`);
  assert.ok(
    benchRes.stdout.includes('Bench: 2837905 nodes'),
    `Expected upstream Reckless v0.10.0-dev bench 2837905 nodes, got:\n${benchRes.stdout}`
  );

  const cachePath = path.resolve(process.cwd(), 'storage/nn-cache', NNUE_FILE);
  const script = [
    'uci',
    'setoption name Threads value 4',
    'setoption name Hash value 64',
    `setoption name EvalFile value ${cachePath}`,
    'isready',
    'position startpos moves e2e4',
    'go depth 8',
    'quit',
  ].join('\n') + '\n';

  const res = spawnSync(nativeBin, [], {
    input: script,
    encoding: 'utf8',
    timeout: 20000,
  });

  assert.equal(res.status, 0, `Native binary exited with ${res.status}: ${res.stderr}`);
  assert.ok(res.stdout.includes('Reckless 0.10.0-dev'), 'Must report Reckless 0.10.0-dev');
  assert.ok(!res.stdout.includes('SyzygyPath'), 'Syzygy must be completely removed');
  assert.ok(res.stdout.includes('NNUE loaded: v60-7f587dfb.nnue (63266880 bytes)'));
  assert.ok(res.stdout.includes('readyok'));

  const pvMatch = res.stdout.match(/info depth 8 [^\n]* pv (\S+)/);
  const bmMatch = res.stdout.match(/bestmove (\S+)/);
  assert.ok(pvMatch && bmMatch, 'Expected depth 8 info pv and bestmove from native binary');
  assert.equal(bmMatch[1], pvMatch[1], 'Native Lazy SMP bestmove must equal pv[0]');
});

test('WASM Pure-PVS converts Black winning advantage cleanly and solves <=7-piece endgames autonomously without Syzygy', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine);

  // 1. Black up a clean extra pawn converts cleanly without throwing away advantage
  engine.newGame();
  const blackAdvFen = '2r3k1/pp3ppp/2p1bn2/8/3N4/4B3/PP3PPP/2R3K1 b - - 0 20';
  const convRes = engine.search(blackAdvFen, 16, 1200);
  assert.equal(convRes.bestMoveUci, convRes.pv[0], 'bestmove must equal pv[0]');
  assert.ok(convRes.depth >= 7, `Expected deep search >= 7 on conversion pos, got d${convRes.depth}`);
  assert.ok(convRes.scoreCp >= 50, `Expected Black to retain winning advantage (>= +50 cp), got ${convRes.scoreCp}`);

  // 2. 4-piece KR vs K endgame solved autonomously without Syzygy
  engine.newGame();
  const krkRes = engine.search('8/8/8/4k3/8/8/1R2K3/8 w - - 0 1', 16, 900);
  assert.equal(krkRes.bestMoveUci, krkRes.pv[0]);
  assert.ok(krkRes.depth >= 9, `Expected deep autonomous KR vs K search, got d${krkRes.depth}`);
  assert.ok(krkRes.scoreCp >= 300, `Expected decisive KR vs K score >= 300 cp (Reckless WDL cp), got ${krkRes.scoreCp}`);

  // 3. Non-rushing search after 1.e4
  engine.newGame();
  const e4Res = engine.search('startpos', 16, 1200, ['e2e4']);
  assert.equal(e4Res.bestMoveUci, e4Res.pv[0]);
  assert.ok(e4Res.depth >= 7, `Expected depth >= 7 on 1200ms budget (no premature rush), got d${e4Res.depth}`);
  assert.ok(e4Res.pv.length >= 3, `Expected meaningful PV line (>= 3 plies), got ${e4Res.pv.join(' ')}`);
});

test('WASM & Native reject dubious opening moves (never f4/e3 after 1.d4 d6), enforce MultiPV monotonicity, and allow >=192 Threads & >=32768 MB Hash', () => {
  const engine = getNodeWasmEngineSync();
  assert.ok(engine);
  engine.newGame();

  // 1. WASM on 1. d4 d6 -> must play main theory (e2e4, c2c4, g1f3, or b1c3), never f2f4 or e2e3
  const d4d6Res = engine.search('startpos', 12, 1500, ['d2d4', 'd7d6']);
  assert.equal(d4d6Res.bestMoveUci, d4d6Res.pv[0]);
  assert.ok(
    ['e2e4', 'c2c4', 'g1f3', 'b1c3'].includes(d4d6Res.bestMoveUci),
    `Expected strong GM response to 1.d4 d6 in WASM, got ${d4d6Res.bestMoveUci} (${d4d6Res.scoreCp} cp)`
  );

  // 2. Native UCI advertises Threads >= 192, Hash >= 32768, accepts T=192 + Hash=32768, plays strong 1.d4 d6, and monotonic MultiPV 5
  const nativeBin = path.resolve(process.cwd(), 'bin/berserker-native');
  const cachePath = path.resolve(process.cwd(), 'storage/nn-cache', NNUE_FILE);
  const script = [
    'uci',
    `setoption name EvalFile value ${cachePath}`,
    'setoption name Threads value 4',
    'setoption name Hash value 64',
    'isready',
    'ucinewgame',
    'position startpos',
    'go depth 11',
    'ucinewgame',
    'position startpos moves d2d4 d7d6',
    'go depth 11',
    'setoption name MultiPV value 5',
    'go depth 9',
    'setoption name MultiPV value 1',
    'setoption name Threads value 192',
    'setoption name Hash value 32768',
    'isready',
    'quit',
  ].join('\n') + '\n';

  const res = spawnSync(nativeBin, [], {
    input: script,
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(res.status, 0, `Native binary exited with ${res.status}: ${res.stderr}`);
  const threadsMatch = res.stdout.match(/option name Threads type spin default \d+ min 1 max (\d+)/);
  assert.ok(threadsMatch && parseInt(threadsMatch[1], 10) >= 192, 'Native UCI must advertise Threads max >= 192');
  const hashMatch = res.stdout.match(/option name Hash type spin default \d+ min 1 max (\d+)/);
  assert.ok(hashMatch && parseInt(hashMatch[1], 10) >= 32768, 'Native UCI must advertise Hash max >= 32768');

  const bestMoves = Array.from(res.stdout.matchAll(/^bestmove (\S+)/gm)).map((m) => m[1]);
  assert.equal(bestMoves.length, 3, `Expected 3 bestmove lines, got ${bestMoves.length}`);
  assert.ok(
    ['e2e4', 'd2d4', 'c2c4', 'g1f3', 'b1c3'].includes(bestMoves[0]),
    `Native startpos T=4 expected sound opening move, got ${bestMoves[0]}`
  );
  assert.ok(
    ['e2e4', 'c2c4', 'g1f3', 'b1c3'].includes(bestMoves[1]),
    `Native 1.d4 d6 T=4 expected sound continuation, got ${bestMoves[1]}`
  );
  assert.notEqual(bestMoves[1], 'f2f4');
  assert.notEqual(bestMoves[2], 'f2f4');

  // Verify MultiPV 5 depth-9 scores are ordered top-to-bottom within aspiration/fail-soft tolerance
  const mpvScores: number[] = [];
  for (let idx = 1; idx <= 5; idx++) {
    const matches = Array.from(
      res.stdout.matchAll(new RegExp(`info depth 9 [^\\n]*multipv ${idx} score cp (-?\\d+)`, 'g'))
    );
    const m = matches.pop();
    assert.ok(m, `Expected MultiPV ${idx} score at depth 9`);
    mpvScores.push(parseInt(m[1], 10));
  }
  assert.ok(mpvScores[0] >= mpvScores[4], `Expected pv1 (${mpvScores[0]}) >= pv5 (${mpvScores[4]})`);
  for (let i = 1; i < mpvScores.length; i++) {
    assert.ok(
      mpvScores[i - 1] + 10 >= mpvScores[i],
      `MultiPV ordering out of tolerance: pv${i}=${mpvScores[i - 1]} vs pv${i + 1}=${mpvScores[i]}`
    );
  }
  assert.ok(res.stdout.includes('set Threads to 192'));
  assert.ok(res.stdout.includes('set Hash to 32768 MB'));
  assert.ok(res.stdout.endsWith('readyok\n') || res.stdout.includes('readyok'));
});
