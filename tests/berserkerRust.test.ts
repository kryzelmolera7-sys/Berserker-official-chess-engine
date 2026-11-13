import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const binPath = path.join(process.cwd(), 'berserker-rust/target/release/berserker');

test('Native Rust Engine: Release binary exists and responds to UCI commands', () => {
  assert.ok(fs.existsSync(binPath), 'Compiled release binary must exist at berserker-rust/target/release/berserker');

  const res = spawnSync(binPath, [], {
    input: 'uci\nquit\n',
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0, 'Binary must exit with code 0');
  assert.ok(res.stdout.includes('Berserker v0.7.0 (Rust)'), 'Engine must identify as Berserker v0.7.0 (Rust)');
  assert.ok(res.stdout.includes('option name UCI_Chess960'), 'Engine must support UCI_Chess960');
  assert.ok(res.stdout.includes('option name MultiPV'), 'Engine must support MultiPV');
  assert.ok(res.stdout.includes('uciok'), 'Engine must complete UCI handshake with uciok');
});

test('Native Rust Engine: Accurate Chess960 (FRC) Backranks and King Files', () => {
  const res = spawnSync(binPath, [], {
    input: 'chess960 0\nchess960 518\nchess960 959\nquit\n',
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('SP #0: Backrank BBQNNRKR WhiteKingFile: 6'), 'SP 0 backrank must be BBQNNRKR with King on file 6');
  assert.ok(res.stdout.includes('SP #518: Backrank RNBQKBNR WhiteKingFile: 4'), 'SP 518 backrank must be RNBQKBNR with King on file 4');
  assert.ok(res.stdout.includes('SP #959: Backrank RKRNNQBB WhiteKingFile: 1'), 'SP 959 backrank must be RKRNNQBB with King on file 1');
});

test('Native Rust Engine: Startpos Perft(4) = 197,281 legal nodes', () => {
  const res = spawnSync(binPath, [], {
    input: 'position startpos\nperft 4\nquit\n',
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('perft 4 nodes 197281'), `Expected exact 197281 legal leaf nodes, got:\n${res.stdout}`);
});

test('Native Rust Engine: Multi-PV 3 & Mate-in-1 tactical solving', () => {
  const res = spawnSync(binPath, [], {
    input: [
      'setoption name MultiPV value 3',
      'position startpos',
      'go depth 6 movetime 1000',
      'setoption name MultiPV value 1',
      'position fen 6k1/5ppp/8/8/8/8/1Q6/4K3 w - - 0 1',
      'go depth 4 movetime 500',
      'quit',
      ''
    ].join('\n'),
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('multipv 1'), 'Must output multipv 1');
  assert.ok(res.stdout.includes('multipv 2'), 'Must output multipv 2');
  assert.ok(res.stdout.includes('multipv 3'), 'Must output multipv 3');
  assert.ok(res.stdout.includes('score mate 1'), `Expected mate-in-1 detection, got:\n${res.stdout}`);
  assert.ok(res.stdout.includes('bestmove '), 'Engine must output bestmove');
});
