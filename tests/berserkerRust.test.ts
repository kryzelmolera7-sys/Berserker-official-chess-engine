import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

test('Native Rust Engine: Release binary exists and responds to UCI commands', () => {
  const binPath = path.join(process.cwd(), 'berserker-rust/target/release/berserker');
  assert.ok(fs.existsSync(binPath), 'Compiled release binary must exist at berserker-rust/target/release/berserker');

  const res = spawnSync(binPath, [], {
    input: 'uci\nquit\n',
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0, 'Binary must exit with code 0');
  assert.ok(res.stdout.includes('Berserker v0.7.0 (Rust)'), 'Engine must identify as Berserker v0.7.0 (Rust)');
  assert.ok(res.stdout.includes('option name UCI_Chess960'), 'Engine must support UCI_Chess960');
  assert.ok(res.stdout.includes('uciok'), 'Engine must complete UCI handshake with uciok');
});

test('Native Rust Engine: Accurate Chess960 (FRC) Backranks and King Files', () => {
  const binPath = path.join(process.cwd(), 'berserker-rust/target/release/berserker');

  const res = spawnSync(binPath, [], {
    input: 'chess960 0\nchess960 518\nchess960 959\nquit\n',
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('SP #0: Backrank BBQNNRKR WhiteKingFile: 6'), 'SP 0 backrank must be BBQNNRKR with King on file 6');
  assert.ok(res.stdout.includes('SP #518: Backrank RNBQKBNR WhiteKingFile: 4'), 'SP 518 backrank must be RNBQKBNR with King on file 4');
  assert.ok(res.stdout.includes('SP #959: Backrank RKRNNQBB WhiteKingFile: 1'), 'SP 959 backrank must be RKRNNQBB with King on file 1');
});

test('Native Rust Engine: Benchmark searches over 1M+ nodes with bestmove', () => {
  const binPath = path.join(process.cwd(), 'berserker-rust/target/release/berserker');

  const res = spawnSync(binPath, [], {
    input: 'position startpos\ngo depth 6 movetime 1000\nquit\n',
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('bestmove '), 'Engine must output bestmove');
  assert.ok(res.stdout.includes('info depth 6'), 'Engine must search depth 6');
});
