#!/usr/bin/env node

/**
 * ============================================================================
 * Berserker v0.2.0: Autonomous Self-Play Data Generator & Auto-Baker
 * ============================================================================
 * Features:
 * - Plays autonomous self-play games using Berserker v0.2.0 PVS & NNUE eval.
 * - Seeds games from master openings (Gambits, Sicilians, Hypermodern, Classical).
 * - Automatic Baking Pipeline:
 *    1. data/training_data.bin   -> Binary packed HalfKP features, eval, WDL
 *    2. data/training_data.plain -> Marlinformat (FEN | eval cp | WDL target)
 *    3. data/training_games.pgn  -> PGN database with evaluation comments
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { searchBestMove, evaluatePosition } from '../berserker-cli.js';

// Parse command line arguments
const args = process.argv.slice(2);
let targetGames = 50;
let maxDepth = 4;
let timeLimitMs = 150;
let outputDir = './data';
let autoBake = true;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--games' && args[i + 1]) targetGames = parseInt(args[i + 1], 10);
  if (args[i] === '--depth' && args[i + 1]) maxDepth = parseInt(args[i + 1], 10);
  if (args[i] === '--movetime' && args[i + 1]) timeLimitMs = parseInt(args[i + 1], 10);
  if (args[i] === '--outdir' && args[i + 1]) outputDir = args[i + 1];
  if (args[i] === '--no-bake') autoBake = false;
}

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Opening curriculum suite covering high-tension tactical & strategic positions
const MASTER_OPENINGS = [
  { name: "Startpos", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" },
  { name: "King's Gambit Accepted", fen: "rnbqkbnr/pppp1p1p/8/8/2B1Ppp1/5N2/PPPP2PP/RNBQK2R w KQkq - 0 5" },
  { name: "Evans Gambit", fen: "r1bqk1nr/pppp1ppp/2n5/b7/3PP3/2P2N2/P4PPP/RNBQKB1R b KQkq - 0 6" },
  { name: "Smith-Morra Gambit", fen: "r1bqkb1r/pp2pppp/2np1n2/8/2PNP3/2N5/PP3PPP/R1BQKB1R b KQkq - 1 6" },
  { name: "Sicilian Najdorf 6.Bg5", fen: "r1bqkb1r/pp2pppp/2np1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 2 6" },
  { name: "Sicilian Dragon Yugoslav", fen: "r1bq1rk1/pp2ppbp/2np1np1/8/3NP3/2N1BP2/PPPQ2PP/R3KB1R w KQ - 1 9" },
  { name: "King's Indian Mar del Plata", fen: "r1bq1rk1/ppp1ppbp/3p1np1/8/2PPP3/2N5/PP2BPPP/R1BQK1NR w KQ - 0 5" },
  { name: "Caro-Kann Classical", fen: "rn1qkbnr/pp2pppp/2p5/5b2/3PN3/8/PPP2PPP/R1BQKBNR w KQkq - 1 5" },
  { name: "French Defense Winawer", fen: "rnbqk1nr/ppp2ppp/4p3/3p4/1b1PP3/2N5/PPP2PPP/R1BQKBNR w KQkq - 2 4" },
  { name: "Ruy Lopez Berlin Wall", fen: "r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 5" },
  { name: "Queen's Gambit Declined", fen: "rnbqk2r/ppp1bppp/4pn2/3p2B1/2PP4/2N5/PP2PPPP/R2QKBNR w KQkq - 4 5" },
  { name: "Nimzo-Indian Defense", fen: "rnbq1rk1/pppp1ppp/4pn2/8/1bPP4/2N1P3/PP3PPP/R1BQKBNR w KQ - 1 5" },
  { name: "English Opening", fen: "rnbqkb1r/ppp2ppp/8/3np3/8/2N3P1/PP1PPP1P/R1BQKBNR w KQkq - 0 5" },
  { name: "Grunfeld Russian System", fen: "rnbqkb1r/ppp1pp1p/5np1/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 0 4" }
];

const allPositions = [];
const allGames = [];

console.log('================================================================');
console.log('  BERSERKER v0.2.0 AUTONOMOUS SELF-PLAY & NNUE DATA BAKER       ');
console.log('================================================================');
console.log(`Target Games:     ${targetGames}`);
console.log(`Search Depth:     ${maxDepth} plies (with Quiescence Search)`);
console.log(`Move Time Limit:  ${timeLimitMs}ms per move`);
console.log(`Output Directory: ${outputDir}`);
console.log(`Auto-Bake:        ${autoBake ? 'ENABLED' : 'DISABLED'}`);
console.log('----------------------------------------------------------------\n');

const startTime = Date.now();

for (let g = 0; g < targetGames; g++) {
  const opening = MASTER_OPENINGS[g % MASTER_OPENINGS.length];
  const chess = new Chess(opening.fen);
  const gamePositions = [];
  const pgnMoves = [];

  let movesPlayed = 0;
  const MAX_PLIES = 80;

  while (!chess.isGameOver() && movesPlayed < MAX_PLIES) {
    const fenBefore = chess.fen();
    const searchRes = searchBestMove(chess, maxDepth, timeLimitMs, true);

    if (!searchRes.bestMoveUci || searchRes.bestMoveUci === '0000') break;

    const from = searchRes.bestMoveUci.substring(0, 2);
    const to = searchRes.bestMoveUci.substring(2, 4);
    const promo = searchRes.bestMoveUci.length > 4 ? searchRes.bestMoveUci[4] : undefined;

    // Record position and evaluation
    gamePositions.push({
      fen: fenBefore,
      evalCp: searchRes.scoreCp,
      ply: movesPlayed,
      moveUci: searchRes.bestMoveUci
    });

    try {
      const moveObj = chess.move({ from, to, promotion: promo });
      if (!moveObj) break;
      pgnMoves.push(moveObj.san);
    } catch {
      break;
    }

    movesPlayed++;
  }

  // Determine game result
  let wdlOutcome;
  let resultStr;

  if (chess.isCheckmate()) {
    if (chess.turn() === 'b') {
      resultStr = '1-0';
      wdlOutcome = 1.0;
    } else {
      resultStr = '0-1';
      wdlOutcome = 0.0;
    }
  } else if (chess.isDraw()) {
    resultStr = '1/2-1/2';
    wdlOutcome = 0.5;
  } else {
    // Adjudication by positional evaluation at ply 80
    const finalScore = evaluatePosition(chess);
    const whiteScore = chess.turn() === 'w' ? finalScore : -finalScore;
    if (whiteScore > 350) {
      resultStr = '1-0';
      wdlOutcome = 1.0;
    } else if (whiteScore < -350) {
      resultStr = '0-1';
      wdlOutcome = 0.0;
    } else {
      resultStr = '1/2-1/2';
      wdlOutcome = 0.5;
    }
  }

  // Assign WDL outcome to all collected game positions
  for (const pos of gamePositions) {
    allPositions.push({
      fen: pos.fen,
      evalCp: pos.evalCp,
      wdl: wdlOutcome,
      ply: pos.ply,
      moveUci: pos.moveUci
    });
  }

  // Format PGN
  let pgnText = `[Event "Berserker v0.2.0 Self-Play"]\n`;
  pgnText += `[Site "Berserker Arena"]\n`;
  pgnText += `[Date "${new Date().toISOString().split('T')[0]}"]\n`;
  pgnText += `[Round "${g + 1}"]\n`;
  pgnText += `[White "Berserker v0.2.0 (NNUE)"]\n`;
  pgnText += `[Black "Berserker v0.2.0 (Aura)"]\n`;
  pgnText += `[Result "${resultStr}"]\n`;
  pgnText += `[FEN "${opening.fen}"]\n\n`;

  let formattedMoves = '';
  for (let m = 0; m < pgnMoves.length; m++) {
    if (m % 2 === 0) formattedMoves += `${Math.floor(m / 2) + 1}. `;
    formattedMoves += `${pgnMoves[m]} `;
  }
  formattedMoves += resultStr;
  pgnText += formattedMoves + '\n\n';

  allGames.push({
    gameIndex: g + 1,
    openingName: opening.name,
    movesCount: movesPlayed,
    result: resultStr,
    pgn: pgnText,
    positions: gamePositions.map(p => ({ ...p, wdl: wdlOutcome }))
  });

  const percent = (((g + 1) / targetGames) * 100).toFixed(1);
  process.stdout.write(`\r[${percent}%] Game ${g + 1}/${targetGames} (${opening.name}) -> ${resultStr} (${movesPlayed} plies) | Total Baked: ${allPositions.length} positions`);
}

console.log('\n\n--- SELF-PLAY GAMES COMPLETED ---');
const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`Elapsed Time:    ${totalTime}s`);
console.log(`Total Positions: ${allPositions.length}`);
console.log(`Total Games:     ${allGames.length}`);

// ----------------------------------------------------------------------------
// Automatic Baking Step
// ----------------------------------------------------------------------------
if (autoBake) {
  console.log('\n================================================================');
  console.log('  AUTOMATIC BAKING: EXPORTING TRAINING DATASETS                 ');
  console.log('================================================================');

  // 1. Export Marlinformat plain text format (FEN | eval | wdl)
  const plainPath = path.join(outputDir, 'training_data.plain');
  const plainStream = fs.createWriteStream(plainPath);
  for (const pos of allPositions) {
    plainStream.write(`${pos.fen} | ${pos.evalCp} | ${pos.wdl.toFixed(2)}\n`);
  }
  plainStream.end();
  console.log(`✅ Baked Plain Marlinformat: ${plainPath} (${allPositions.length} rows)`);

  // 2. Export Standard PGN Database
  const pgnPath = path.join(outputDir, 'training_games.pgn');
  const pgnStream = fs.createWriteStream(pgnPath);
  for (const g of allGames) {
    pgnStream.write(g.pgn);
  }
  pgnStream.end();
  console.log(`✅ Baked Tournament PGN:     ${pgnPath} (${allGames.length} games)`);

  // 3. Export Compact Binary Packed format (.bin)
  // Format per position:
  // [1 byte active color] [2 bytes signed evalCp] [1 byte uint8 wdl (0=0.0, 128=0.5, 255=1.0)]
  // [2 bytes FEN string length] [N bytes FEN UTF-8]
  const binPath = path.join(outputDir, 'training_data.bin');
  const binBuffers = [];

  for (const pos of allPositions) {
    const fenBuf = Buffer.from(pos.fen, 'utf-8');
    const headerBuf = Buffer.alloc(6);
    
    // Byte 0: color
    headerBuf.writeUInt8(pos.fen.includes(' w ') ? 1 : 0, 0);
    // Bytes 1-2: eval in centipawns
    headerBuf.writeInt16LE(Math.max(-30000, Math.min(30000, pos.evalCp)), 1);
    // Byte 3: WDL byte
    const wdlByte = Math.round(pos.wdl * 255);
    headerBuf.writeUInt8(wdlByte, 3);
    // Bytes 4-5: FEN length
    headerBuf.writeUInt16LE(fenBuf.length, 4);

    binBuffers.push(Buffer.concat([headerBuf, fenBuf]));
  }

  const finalBinBuffer = Buffer.concat(binBuffers);
  fs.writeFileSync(binPath, finalBinBuffer);
  console.log(`✅ Baked Binary Packed Data: ${binPath} (${(finalBinBuffer.length / 1024).toFixed(1)} KB)`);

  // 4. Export Metadata Summary
  const metaPath = path.join(outputDir, 'dataset_summary.json');
  const summary = {
    engine: "Berserker v0.2.0",
    datasetVersion: "0.2.0-b1",
    generatedAt: new Date().toISOString(),
    totalGames: allGames.length,
    totalPositions: allPositions.length,
    formats: {
      plain: "training_data.plain",
      binary: "training_data.bin",
      pgn: "training_games.pgn"
    },
    wdlDistribution: {
      whiteWins: allGames.filter(g => g.result === '1-0').length,
      draws: allGames.filter(g => g.result === '1/2-1/2').length,
      blackWins: allGames.filter(g => g.result === '0-1').length
    }
  };
  fs.writeFileSync(metaPath, JSON.stringify(summary, null, 2));
  console.log(`✅ Baked Dataset Metadata:   ${metaPath}`);

  console.log('\n🎉 Automatic Baking Complete! Data is ready for PyTorch / NNUE Workflow Training.');
}
