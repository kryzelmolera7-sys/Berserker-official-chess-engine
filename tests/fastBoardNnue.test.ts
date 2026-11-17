import test from 'node:test';
import assert from 'node:assert/strict';
import { FastBoard, moveToUci, PT_QUEEN, encodeMove, FLAG_CAPTURE, algebraicToSq } from '../src/engine/fastBoard';
import {
  initRecklessNnue,
  RecklessEvaluator,
  evaluateRecklessNnueFen,
  RECKLESS_NET_NAME,
} from '../src/engine/recklessNnue';

function perft(board: FastBoard, depth: number, ply = 0): number {
  if (depth === 0) return 1;
  const count = board.generatePseudoLegal(ply, false);
  let nodes = 0;
  for (let i = 0; i < count; i++) {
    const move = board.moveLists[ply * 256 + i];
    if (board.makeMove(move)) {
      nodes += perft(board, depth - 1, ply + 1);
      board.unmakeMove();
    }
  }
  return nodes;
}

test('FastBoard perft matches standard chess move generation counts', () => {
  const startBoard = new FastBoard();
  assert.equal(perft(startBoard, 1), 20);
  assert.equal(perft(startBoard, 2), 400);
  assert.equal(perft(startBoard, 3), 8902);
  assert.equal(perft(startBoard, 4), 197281);

  // Kiwipete (castling, en passant, promotions, pins)
  const kiwiBoard = new FastBoard('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.equal(perft(kiwiBoard, 1), 48);
  assert.equal(perft(kiwiBoard, 2), 2039);
  assert.equal(perft(kiwiBoard, 3), 97862);

  // En passant & promotion edge cases (Position 3)
  const pos3 = new FastBoard('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
  assert.equal(perft(pos3, 1), 14);
  assert.equal(perft(pos3, 2), 191);
  assert.equal(perft(pos3, 3), 2812);
});

test('FastBoard Zobrist repetition detection detects 2-fold in search & 3-fold at root', () => {
  const board = new FastBoard();
  // Repeat Nf3 Nf6 Ng1 Ng8 twice
  const seq = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  for (const m of seq) {
    assert.equal(board.applyUciMove(m), true);
  }
  assert.equal(board.isRepetition(0), true);
  assert.equal(board.isDraw(0), true);
});

test('FastBoard full iterative SEE handles defended pieces and X-ray batteries', () => {
  // White rook on e1 can take rook on e4, defended by rook on e8 and queen on d5, backed by White queen on e2? Wait:
  // Let's test: White Re1 takes bRe4 defended by bPd5 => net loss: 500 - 500 = 0 (Wait: Re1xe4 takes rook 500, d5xe4 takes rook 500 -> 0!)
  const seeBoard1 = new FastBoard('4k3/8/8/3p4/4r3/8/4R3/4R1K1 w - - 0 1');
  // Re2xe4 (500), d5xe4 (500), Re1xe4 (100) => +100 net gain (discovered X-ray battery!)
  const capMove = encodeMove(algebraicToSq('e2'), algebraicToSq('e4'), 0, FLAG_CAPTURE);
  const seeVal = seeBoard1.staticExchangeEvaluation(capMove);
  assert.equal(seeVal, 100);

  // Undefended Queen capture vs Queen sacrifice onto defended pawn: Qxd5 defended by c6 pawn -> 100 - 950 = -850
  const seeBoard2 = new FastBoard('4k3/8/2p5/3p4/8/8/3Q4/4K3 w - - 0 1');
  const badCap = encodeMove(algebraicToSq('d2'), algebraicToSq('d5'), 0, FLAG_CAPTURE);
  assert.equal(seeBoard2.staticExchangeEvaluation(badCap), -850);
});

test(`Reckless ${RECKLESS_NET_NAME} loads actual binary weights and evaluates positions accurately`, async () => {
  const params = await initRecklessNnue();
  assert.ok(params, 'Expected Reckless NNUE binary file to load cleanly');

  const startEval = evaluateRecklessNnueFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.ok(startEval !== null && startEval > 5 && startEval < 55, `Unexpected startpos eval: ${startEval}`);

  // White up a Queen should evaluate strongly positive
  const upQueen = evaluateRecklessNnueFen('rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.ok(upQueen !== null && upQueen > 350, `Expected up-Queen eval > 350 cp, got ${upQueen}`);

  // White down a Queen should evaluate strongly negative
  const downQueen = evaluateRecklessNnueFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1');
  assert.ok(downQueen !== null && downQueen < -250, `Expected down-Queen eval < -250 cp, got ${downQueen}`);
});

test('Reckless incremental accumulator matches full refresh bit-for-bit across tactical trees', async () => {
  const params = await initRecklessNnue();
  assert.ok(params);

  const fens = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    'r1bqkb1r/pppp1ppp/2n5/4p3/2B1n3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 5',
  ];

  const board = new FastBoard();
  const evaluator = new RecklessEvaluator(params);
  board.observer = evaluator;

  const refBoard = new FastBoard();
  const refEval = new RecklessEvaluator(params);

  for (const fen of fens) {
    board.setFen(fen);
    const legal = board.getLegalMoves().slice(0, 20);
    for (const m1 of legal) {
      assert.equal(board.makeMove(m1), true);
      const inc1 = evaluator.evaluate(board);
      refBoard.setFen(board.toFen());
      refEval.onReset(refBoard);
      const full1 = refEval.evaluateFullRefresh(refBoard);
      assert.equal(
        inc1,
        full1,
        `Mismatch after move ${moveToUci(m1)} from ${fen}: inc=${inc1} vs full=${full1}`
      );

      const replies = board.getLegalMoves().slice(0, 8);
      for (const m2 of replies) {
        assert.equal(board.makeMove(m2), true);
        const inc2 = evaluator.evaluate(board);
        refBoard.setFen(board.toFen());
        refEval.onReset(refBoard);
        const full2 = refEval.evaluateFullRefresh(refBoard);
        assert.equal(
          inc2,
          full2,
          `Mismatch after reply ${moveToUci(m1)} ${moveToUci(m2)}: inc=${inc2} vs full=${full2}`
        );
        board.unmakeMove();
      }
      board.unmakeMove();
    }
  }
});
