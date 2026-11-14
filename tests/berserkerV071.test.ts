import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Chess } from 'chess.js';
import {
  ENGINE_NAME,
  ENGINE_VERSION,
  evaluatePosition,
  staticExchangeEvaluation,
  evaluateBRnnueCli,
  searchBestMove,
} from '../berserker-cli.js';
import { searchIndependentBerserker } from '../src/engine/berserkerIndependentSearch';

function runCliWithStdin(inputText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['berserker-cli.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`UCI process timed out. stdout=${stdout} stderr=${stderr}`));
    }, 8000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`UCI exited with code ${code}: ${stderr}\nstdout=${stdout}`));
      } else {
        resolve(stdout);
      }
    });
    child.stdin.write(inputText);
    child.stdin.end();
  });
}

test('Berserker v0.7.1-dev: metadata and exported bridge functions', () => {
  assert.equal(ENGINE_NAME, 'Berserker v0.7.1-dev');
  assert.equal(ENGINE_VERSION, '0.7.1-dev');

  const res = evaluateBRnnueCli('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  assert.equal(typeof res.centipawns, 'number');
  assert.equal(res.centipawns, res.evalCpPerspective);
});

test('Berserker v0.7.1-dev: evaluatePosition is color-symmetric and includes positional imbalances', () => {
  // Symmetric position mirrored for White vs Black to move
  const whiteToMove = new Chess('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 4');
  const blackToMove = new Chess('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R b KQkq - 4 4');

  const ew = evaluatePosition(whiteToMove);
  const eb = evaluatePosition(blackToMove);
  assert.equal(ew, eb, `Expected symmetric perspective eval (${ew}) === (${eb})`);

  // Bishop pair beats Bishop + Knight in open board test
  const pairChess = new Chess('4k3/8/8/8/8/8/8/2B2BK1 w - - 0 1');
  const bnChess = new Chess('4k3/8/8/8/8/8/8/2B2NK1 w - - 0 1');
  assert.ok(
    evaluatePosition(pairChess) > evaluatePosition(bnChess),
    `Expected Bishop pair (${evaluatePosition(pairChess)}) > B+N (${evaluatePosition(bnChess)})`
  );

  // Pawn on 6th rank scores strictly higher than pawn on 2nd rank (fixed PST orientation)
  const pawn2nd = new Chess('6k1/8/8/8/8/8/4P3/6K1 w - - 0 1');
  const pawn6th = new Chess('6k1/8/4P3/8/8/8/8/6K1 w - - 0 1');
  assert.ok(
    evaluatePosition(pawn6th) > evaluatePosition(pawn2nd) + 80,
    `Expected advanced pawn on e6 (${evaluatePosition(pawn6th)}) to score higher than e2 (${evaluatePosition(pawn2nd)})`
  );
});

test('Berserker v0.7.1-dev: staticExchangeEvaluation identifies winning vs losing captures', () => {
  const scandi = new Chess('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  const exd5 = scandi.moves({ verbose: true }).find((m) => m.from === 'e4' && m.to === 'd5');
  assert.ok(exd5);
  assert.ok(staticExchangeEvaluation(scandi, exd5) >= 100);

  const badCapturePos = new Chess('rnbqkbnr/pppp1ppp/4p3/7Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 0 1');
  const qxf7 = badCapturePos.moves({ verbose: true }).find((m) => m.from === 'h5' && m.to === 'f7');
  assert.ok(qxf7);
  assert.ok(
    staticExchangeEvaluation(badCapturePos, qxf7) < 0,
    `Expected Qxf7 defended by Kxf7 to have negative SEE, got ${staticExchangeEvaluation(badCapturePos, qxf7)}`
  );
});

test('Berserker v0.7.1-dev: finds forced tactical win and executes Hybrid-MCTS-PVS UCI cleanly', async () => {
  const mateFen = 'r1bqkb1r/pppp1ppp/2n5/4p3/2B1n3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 1';
  const res = searchBestMove(new Chess(mateFen), 4, 400, true);
  assert.equal(res.bestMoveUci, 'f3f7');

  const tsRes = searchIndependentBerserker(mateFen, 4, 400, 1);
  assert.equal(tsRes.bestMoveUci, 'f3f7');

  const uciInput = [
    'uci',
    'setoption name Threads value 1',
    'setoption name Hash value 16',
    'isready',
    'ucinewgame',
    'position startpos moves e2e4 d7d5',
    'go depth 4 movetime 180',
    'position fen r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4 moves d2d3',
    'eval',
    'quit',
    '',
  ].join('\n');

  const stdout = await runCliWithStdin(uciInput);

  assert.match(stdout, /id name Berserker v0\.7\.1-dev/);
  assert.match(stdout, /uciok/);
  assert.match(stdout, /readyok/);
  assert.match(stdout, /bestmove [a-h][1-8][a-h][1-8]/);
  assert.match(stdout, /Turn: Black/, 'position fen with digits on 1st rank must apply moves d2d3 and flip turn to Black');
});

test('Berserker v0.7.1-dev: quiescenceSearch detects checkmate on search horizon (depth 2 back-rank mate)', () => {
  // After 1. Rxe8#? Wait: White has Rook on a1 vs Black Rook on e8; if White plays 1. Qa7? Black plays 1...Re1#!
  // Position where only luft (h3/g3) or defending e1 avoids 1...Re1#: White Q on b6, R on c1? Wait:
  // Simpler exact test: Black R on e8, Black K on g8 with pawns f7/g7/h7; White K on g1 with pawns f2/g2/h2 and White Q on b7.
  //Wait: 1. Qb8?? allows 1...Rxb8, or 1. Qa8?? allows 1...Rxa8; better: White has extra Knight on c3, Black R on e8, White's pawn h2 can play h3 or Kf1, while greedy 1. Qxa7 allows 1...Re1# (checkmate!).
  const backRankTrapFen = '4r1k1/p4ppp/8/8/8/2N5/QP3PPP/6K1 w - - 0 1';
  const resCli = searchBestMove(new Chess(backRankTrapFen), 2, 400, true);
  assert.notEqual(resCli.bestMoveUci, 'a2a7', 'CLI depth-2 search must see Qxa7 allows Re1# in QSearch');
  assert.notEqual(resCli.bestMoveUci, 'a2f7', 'CLI depth-2 search must see Qxf7+ Kxf7 allows Re1#');

  const resTs = searchIndependentBerserker(backRankTrapFen, 2, 400, 1);
  assert.notEqual(resTs.bestMoveUci, 'a2a7', 'TS depth-2 search must see Qxa7 allows Re1# in QSearch');
});

