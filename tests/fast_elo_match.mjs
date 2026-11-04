/**
 * Fast Elo Match Runner for Berserker v0.2.0 vs v0.1.0 Baseline
 */

import { Chess } from 'chess.js';
import { searchBestMove, evaluatePosition } from '../berserker-cli.js';

function baselineSearch(chess, depth = 2) {
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return { move: null };

  const weights = { p: 100, n: 310, b: 320, r: 500, q: 900, k: 0 };
  function evalHce(c) {
    let s = 0;
    c.board().forEach(r => r.forEach(p => {
      if (p) s += (p.color === 'w' ? weights[p.type] : -weights[p.type]);
    }));
    return c.turn() === 'w' ? s : -s;
  }

  function ab(c, d, alpha, beta) {
    if (d <= 0) return evalHce(c);
    const leg = c.moves({ verbose: true });
    if (leg.length === 0) return c.inCheck() ? -20000 : 0;
    for (const m of leg) {
      c.move(m);
      const score = -ab(c, d - 1, -beta, -alpha);
      c.undo();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    chess.move(m);
    const score = -ab(chess, depth - 1, -30000, 30000);
    chess.undo();
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return { move: best };
}

const openings = [
  { name: "Startpos", fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  { name: "Sicilian Defense", fen: 'r1bqkb1r/pp2pppp/2np1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 2 6' },
  { name: "Ruy Lopez", fen: 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 5' },
  { name: "French Defense", fen: 'rnbqk1nr/ppp2ppp/4p3/3p4/1b1PP3/2N5/PPP2PPP/R1BQKBNR w KQkq - 2 4' },
  { name: "Queen's Gambit", fen: 'rnbqk2r/ppp1bppp/4pn2/3p2B1/2PP4/2N5/PP2PPPP/R2QKBNR w KQkq - 4 5' },
  { name: "King's Indian", fen: 'rnbq1rk1/ppp1ppbp/3p1np1/8/2PPP3/2N5/PP2BPPP/R1BQK1NR w KQ - 0 5' }
];

let v020Wins = 0, draws = 0, v010Wins = 0;
console.log('--- STARTING 6-GAME RAPID BENCHMARK ---');

for (let i = 0; i < openings.length; i++) {
  const op = openings[i];
  const chess = new Chess(op.fen);
  let moves = 0;

  // Alternate colors: Even = v0.2.0 as White; Odd = v0.2.0 as Black
  const v020Color = (i % 2 === 0) ? 'w' : 'b';

  while (!chess.isGameOver() && moves < 40) {
    const isV020Turn = chess.turn() === v020Color;
    if (isV020Turn) {
      const res = searchBestMove(chess, 4, 100, true);
      if (!res.bestMoveUci || res.bestMoveUci === '0000') break;
      chess.move({
        from: res.bestMoveUci.substring(0, 2),
        to: res.bestMoveUci.substring(2, 4),
        promotion: res.bestMoveUci.length > 4 ? res.bestMoveUci[4] : undefined
      });
    } else {
      const bRes = baselineSearch(chess, 2);
      if (!bRes.move) break;
      chess.move(bRes.move);
    }
    moves++;
  }

  let winner = 'draw';
  if (chess.isCheckmate()) {
    winner = chess.turn() === v020Color ? 'v0.1.0' : 'v0.2.0';
  } else {
    const ev = evaluatePosition(chess);
    const v020Score = (chess.turn() === v020Color) ? ev : -ev;
    if (v020Score > 200) winner = 'v0.2.0';
    else if (v020Score < -200) winner = 'v0.1.0';
    else winner = 'draw';
  }

  if (winner === 'v0.2.0') v020Wins++;
  else if (winner === 'v0.1.0') v010Wins++;
  else draws++;

  console.log(`Game ${i + 1} (${op.name}, v0.2.0 as ${v020Color === 'w' ? 'White' : 'Black'}): Result -> ${winner.toUpperCase()} (${moves} moves)`);
}

const total = v020Wins + draws + v010Wins;
const score = (v020Wins + 0.5 * draws) / total;
const elo = Math.round(-400 * Math.log10(1 / score - 1));

console.log('--- RAPID BENCHMARK COMPLETE ---');
console.log(`Berserker v0.2.0: ${v020Wins}W / ${draws}D / ${v010Wins}L (${(score * 100).toFixed(1)}%) -> +${elo} Elo`);
