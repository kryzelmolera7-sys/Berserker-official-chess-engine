import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { 
  generateChess960Backrank, 
  getChess960PositionInfo, 
  normalizeChess960Fen, 
  isLegalChess960Castling, 
  executeChess960Castling,
  resolveChess960Move
} from '../src/engine/chess960';
import { searchIndependentBerserker } from '../src/engine/berserkerIndependentSearch';
import { 
  generateChess960Backrank as cliGenerate960,
  normalizeChess960Fen as cliNormalizeFen
} from '../berserker-cli.js';

test('Chess960: SP 518 matches Standard Chess backrank RNBQKBNR', () => {
  const sp518 = generateChess960Backrank(518);
  assert.equal(sp518, 'RNBQKBNR', 'SP 518 must equal RNBQKBNR');
});

test('Chess960: SP 0 and SP 959 boundary positions are accurate', () => {
  const sp0 = generateChess960Backrank(0);
  const sp959 = generateChess960Backrank(959);
  assert.equal(sp0, 'BBQNNRKR', 'SP 0 must equal BBQNNRKR');
  assert.equal(sp959, 'RKRNNQBB', 'SP 959 must equal RKRNNQBB');
});

test('Chess960: All 960 positions satisfy strict Fischer Random constraints', () => {
  for (let i = 0; i < 960; i++) {
    const rank = generateChess960Backrank(i);
    assert.equal(rank.length, 8, `SP ${i} must have 8 pieces`);

    // 1. Two Bishops on opposite colors
    const bishopIndices: number[] = [];
    for (let c = 0; c < 8; c++) {
      if (rank[c] === 'B') bishopIndices.push(c);
    }
    assert.equal(bishopIndices.length, 2, `SP ${i} must have 2 bishops`);
    assert.notEqual(
      bishopIndices[0] % 2,
      bishopIndices[1] % 2,
      `SP ${i} bishops must be on opposite colors`
    );

    // 2. King strictly between Rooks
    const rookIndices: number[] = [];
    let kingIndex = -1;
    for (let c = 0; c < 8; c++) {
      if (rank[c] === 'R') rookIndices.push(c);
      if (rank[c] === 'K') kingIndex = c;
    }
    assert.equal(rookIndices.length, 2, `SP ${i} must have 2 rooks`);
    assert.ok(kingIndex !== -1, `SP ${i} must have a king`);
    assert.ok(
      rookIndices[0] < kingIndex && kingIndex < rookIndices[1],
      `SP ${i} king (${kingIndex}) must be between rooks (${rookIndices[0]}, ${rookIndices[1]})`
    );
  }
});

test('Chess960: Shredder FEN normalization converts file letters to loadable FEN', () => {
  const shredderFen = 'rnnbqkbr/pppppppp/8/8/8/8/PPPPPPPP/RNNBQKBR w HAha - 0 1';
  const { normalizedFen } = normalizeChess960Fen(shredderFen);

  // chess.js should load without error
  const chess = new Chess(normalizedFen);
  assert.ok(chess.fen().includes('w KQ'), 'Normalized FEN should have valid castling tokens');
});

test('Chess960: Castling execution places King on c1/g1 and Rook on d1/f1', () => {
  // Setup standard position for castling test
  const info = getChess960PositionInfo(518);
  const chess = new Chess(info.fen);

  // Clear e-f-g squares to allow kingside castling
  chess.load('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQK2R w KQkq - 0 1');
  const canCastleKing = isLegalChess960Castling(chess, 'kingside', info.castlingConfig);
  assert.ok(canCastleKing, 'Kingside castling should be legal');

  const afterCastlingFen = executeChess960Castling(chess, 'kingside', info.castlingConfig);
  assert.ok(afterCastlingFen.includes('1RK1'), `Rook should be on f1 and King on g1, got ${afterCastlingFen}`);
});

test('Chess960: UCI King-to-Rook move resolution', () => {
  const info = getChess960PositionInfo(518);
  const chess = new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQK2R w KQkq - 0 1');

  // e1h1 is king-to-rook castling in UCI Chess960
  const resolved = resolveChess960Move(chess, 'e1h1', info.castlingConfig);
  assert.ok(resolved.isChess960Castling, 'e1h1 should resolve as Chess960 castling');
  assert.equal(resolved.side, 'kingside', 'Should be kingside');
});

test('Search Improvement: Multi-PV Search outputs multiple candidate variations', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const stats = searchIndependentBerserker(fen, 3, 600, 3);

  assert.ok(stats.multiPvLines, 'multiPvLines should exist');
  assert.ok(stats.multiPvLines.length >= 2, `Expected at least 2 Multi-PV lines, got ${stats.multiPvLines?.length}`);
  assert.equal(stats.multiPvLines[0].rank, 1, 'First candidate rank must be 1');
  assert.equal(stats.multiPvLines[1].rank, 2, 'Second candidate rank must be 2');
  assert.notEqual(
    stats.multiPvLines[0].bestMoveUci,
    stats.multiPvLines[1].bestMoveUci,
    'Candidate lines must have different root moves'
  );
});

test('Standalone CLI: Chess960 functions match TypeScript implementation', () => {
  assert.equal(cliGenerate960(518), 'RNBQKBNR');
  assert.equal(cliGenerate960(0), 'BBQNNRKR');
  assert.equal(cliGenerate960(959), 'RKRNNQBB');

  const shredder = 'rnnbqkbr/pppppppp/8/8/8/8/PPPPPPPP/RNNBQKBR w HAha - 0 1';
  const cliNorm = cliNormalizeFen(shredder);
  assert.ok(cliNorm.normalizedFen.includes('w KQ'));
});
