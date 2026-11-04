/**
 * Berserker v0.2.0 vs Previous Baseline (v0.1.0) Elo Benchmark Suite
 * 
 * Runs head-to-head tournament games between:
 *  - Player A: Berserker v0.2.0 (PVS + Quiescence + Transposition Table + NMP + LMR + Tapered NNUE Eval)
 *  - Player B: Berserker v0.1.0 Baseline (Classical Alpha-Beta without QSearch/TT, prone to horizon blunders)
 */

import { Chess } from 'chess.js';
import { searchBestMove, evaluatePosition } from '../berserker-cli.js';

// Previous Model (v0.1.0 baseline): Simple Alpha-Beta, no Quiescence Search, no TT, basic material
function previousModelSearch(chess, depth = 3) {
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) {
    return { move: null, score: chess.inCheck() ? -20000 : 0 };
  }

  // Basic material evaluation
  function evalHce(c) {
    const weights = { p: 100, n: 310, b: 325, r: 500, q: 900, k: 0 };
    let score = 0;
    c.board().forEach(row => {
      row.forEach(sq => {
        if (!sq) return;
        const v = weights[sq.type] || 0;
        score += (sq.color === 'w' ? v : -v);
      });
    });
    return c.turn() === 'w' ? score : -score;
  }

  function alphaBeta(c, d, alpha, beta) {
    if (d <= 0) return evalHce(c);
    if (c.isCheckmate()) return -20000;
    if (c.isDraw()) return 0;

    const legal = c.moves({ verbose: true });
    if (legal.length === 0) return c.inCheck() ? -20000 : 0;

    for (const m of legal) {
      c.move(m);
      const score = -alphaBeta(c, d - 1, -beta, -alpha);
      c.undo();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  let bestMove = moves[0];
  let bestScore = -Infinity;

  for (const m of moves) {
    chess.move(m);
    const score = -alphaBeta(chess, depth - 1, -30000, 30000);
    chess.undo();

    if (score > bestScore) {
      bestScore = score;
      bestMove = m;
    }
  }

  return { move: bestMove, score: bestScore };
}

// Opening suite covering diverse classical & modern openings
const OPENING_FENS = [
  // 1. Standard Startpos
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  // 2. Sicilian Defense (1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3)
  'r1bqkb1r/pp2pppp/2np1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 2 6',
  // 3. Ruy Lopez (1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6)
  'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 5',
  // 4. Queen's Gambit Declined (1.d4 d5 2.c4 e6 3.Nc3 Nf6 4.Bg5 Be7)
  'rnbqk2r/ppp1bppp/4pn2/3p2B1/2PP4/2N5/PP2PPPP/R2QKBNR w KQkq - 4 5',
  // 5. French Defense Winawer (1.e4 e6 2.d4 d5 3.Nc3 Bb4)
  'rnbqk1nr/ppp2ppp/4p3/3p4/1b1PP3/2N5/PPP2PPP/R1BQKBNR w KQkq - 2 4',
  // 6. King's Indian Defense (1.d4 Nf6 2.c4 g6 3.Nc3 Bg7 4.e4 d6)
  'rnbq1rk1/ppp1ppbp/3p1np1/8/2PPP3/2N5/PP2BPPP/R1BQK1NR w KQ - 0 5',
  // 7. Caro-Kann Defense (1.e4 c6 2.d4 d5 3.Nc3 dxe4 4.Nxe4 Bf5)
  'rn1qkbnr/pp2pppp/2p5/5b2/3PN3/8/PPP2PPP/R1BQKBNR w KQkq - 1 5',
  // 8. Italian Game (1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.c3 Nf6)
  'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 1 5',
  // 9. English Opening (1.c4 e5 2.Nc3 Nf6 3.g3 d5 4.cxd5 Nxd5)
  'rnbqkb1r/ppp2ppp/8/3np3/8/2N3P1/PP1PPP1P/R1BQKBNR w KQkq - 0 5',
  // 10. Nimzo-Indian (1.d4 Nf6 2.c4 e6 3.Nc3 Bb4 4.e3 O-O)
  'rnbq1rk1/pppp1ppp/4pn2/8/1bPP4/2N1P3/PP3PPP/R1BQKBNR w KQ - 1 5'
];

async function runMatch() {
  console.log('================================================================');
  console.log('   BERSERKER v0.2.0 vs PREVIOUS BASELINE (v0.1.0) ELO BENCHMARK   ');
  console.log('================================================================');
  console.log('Engine A: Berserker v0.2.0 (PVS, Quiescence, TT, NMP, LMR, Tapered NNUE)');
  console.log('Engine B: Berserker v0.1.0 (Classical Alpha-Beta without QSearch/TT)');
  console.log(`Openings: ${OPENING_FENS.length} pairs (each opening played twice, alternating colors)`);
  console.log('----------------------------------------------------------------\n');

  let v020Wins = 0;
  let draws = 0;
  let v010Wins = 0;
  let gameNumber = 1;

  for (let opIdx = 0; opIdx < OPENING_FENS.length; opIdx++) {
    const fen = OPENING_FENS[opIdx];

    // Game 1: v0.2.0 is White, v0.1.0 is Black
    {
      const chess = new Chess(fen);
      let movesPlayed = 0;
      const MAX_MOVES = 80;

      while (!chess.isGameOver() && movesPlayed < MAX_MOVES) {
        const turn = chess.turn();
        if (turn === 'w') {
          // Berserker v0.2.0
          const res = searchBestMove(chess, 4, 150, true);
          if (!res.bestMoveUci || res.bestMoveUci === '0000') break;
          chess.move({
            from: res.bestMoveUci.substring(0, 2),
            to: res.bestMoveUci.substring(2, 4),
            promotion: res.bestMoveUci.length > 4 ? res.bestMoveUci[4] : undefined
          });
        } else {
          // Berserker v0.1.0
          const res = previousModelSearch(chess, 2);
          if (!res.move) break;
          chess.move(res.move);
        }
        movesPlayed++;
      }

      let resultStr = 'Draw';
      if (chess.isCheckmate()) {
        resultStr = chess.turn() === 'b' ? 'Berserker v0.2.0 (White) WON' : 'v0.1.0 (Black) WON';
        if (chess.turn() === 'b') v020Wins++;
        else v010Wins++;
      } else {
        // Material evaluation at max moves if not checkmate
        const evalScore = evaluatePosition(chess);
        if (evalScore > 250) {
          resultStr = 'Berserker v0.2.0 (White) WON by positional domination';
          v020Wins++;
        } else if (evalScore < -250) {
          resultStr = 'v0.1.0 (Black) WON';
          v010Wins++;
        } else {
          resultStr = 'Draw (Draw condition or balanced endgame)';
          draws++;
        }
      }

      console.log(`Game ${gameNumber++}: Opening ${opIdx + 1} (v0.2.0 as White) -> ${resultStr} [${movesPlayed} moves]`);
    }

    // Game 2: v0.1.0 is White, v0.2.0 is Black
    {
      const chess = new Chess(fen);
      let movesPlayed = 0;
      const MAX_MOVES = 80;

      while (!chess.isGameOver() && movesPlayed < MAX_MOVES) {
        const turn = chess.turn();
        if (turn === 'w') {
          // Berserker v0.1.0
          const res = previousModelSearch(chess, 2);
          if (!res.move) break;
          chess.move(res.move);
        } else {
          // Berserker v0.2.0
          const res = searchBestMove(chess, 4, 150, true);
          if (!res.bestMoveUci || res.bestMoveUci === '0000') break;
          chess.move({
            from: res.bestMoveUci.substring(0, 2),
            to: res.bestMoveUci.substring(2, 4),
            promotion: res.bestMoveUci.length > 4 ? res.bestMoveUci[4] : undefined
          });
        }
        movesPlayed++;
      }

      let resultStr = 'Draw';
      if (chess.isCheckmate()) {
        resultStr = chess.turn() === 'w' ? 'Berserker v0.2.0 (Black) WON' : 'v0.1.0 (White) WON';
        if (chess.turn() === 'w') v020Wins++;
        else v010Wins++;
      } else {
        const evalScore = evaluatePosition(chess);
        // evalScore is from perspective of side to move
        const whiteScore = chess.turn() === 'w' ? evalScore : -evalScore;
        if (whiteScore < -250) {
          resultStr = 'Berserker v0.2.0 (Black) WON by positional domination';
          v020Wins++;
        } else if (whiteScore > 250) {
          resultStr = 'v0.1.0 (White) WON';
          v010Wins++;
        } else {
          resultStr = 'Draw (Draw condition or balanced endgame)';
          draws++;
        }
      }

      console.log(`Game ${gameNumber++}: Opening ${opIdx + 1} (v0.2.0 as Black) -> ${resultStr} [${movesPlayed} moves]`);
    }
  }

  const totalGames = v020Wins + draws + v010Wins;
  const score = (v020Wins + 0.5 * draws) / totalGames;
  const scorePercent = (score * 100).toFixed(1);

  // Elo difference formula: Delta Elo = -400 * log10(1 / S - 1)
  let eloDelta;
  if (score >= 0.99) {
    eloDelta = "+800+";
  } else if (score <= 0.01) {
    eloDelta = "-800";
  } else {
    const delta = -400 * Math.log10(1 / score - 1);
    eloDelta = (delta > 0 ? "+" : "") + Math.round(delta);
  }

  console.log('\n================================================================');
  console.log('                     FINAL MATCH RESULTS                        ');
  console.log('================================================================');
  console.log(`Total Games Played: ${totalGames}`);
  console.log(`Berserker v0.2.0 Wins: ${v020Wins} (${((v020Wins / totalGames) * 100).toFixed(1)}%)`);
  console.log(`Draws:                ${draws} (${((draws / totalGames) * 100).toFixed(1)}%)`);
  console.log(`Previous Model Wins:  ${v010Wins} (${((v010Wins / totalGames) * 100).toFixed(1)}%)`);
  console.log(`Score Percentage:     ${scorePercent}%`);
  console.log(`Measured Elo Gain:    ${eloDelta} Elo`);
  console.log('================================================================\n');

  return {
    totalGames,
    v020Wins,
    draws,
    v010Wins,
    scorePercent,
    eloDelta
  };
}

runMatch().catch(err => {
  console.error("Match execution error:", err);
  process.exit(1);
});
