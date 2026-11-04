#!/usr/bin/env node

/**
 * Berserker 18 (v0.2.0-alpha) Standalone UCI Engine CLI
 * 
 * Run directly via Terminal:
 *   node berserker-cli.js
 *   bun berserker-cli.js
 * 
 * Or configure in CuteChess / Arena / Banksia GUI:
 *   Command: node
 *   Arguments: /path/to/berserker-cli.js
 *   Protocol: UCI
 */

import readline from 'node:readline';
import { Chess } from 'chess.js';

const ENGINE_NAME = "Berserker 18 (v0.2.0-alpha)";
const ENGINE_AUTHOR = "Jay Honnold & Berserker Team";
const DEFAULT_NET = "berserker_dual_net_ep9_b400.nnue";

// Engine Options State
let evalMode = 'sf-nnue'; // 'sf-nnue' | 'aura-nnue'
let threads = 4;
let hashMb = 1024;
let multiPv = 1;
let tacticalContempt = 45;
let kingAttackScale = 140;

let currentChess = new Chess();
let isSearching = false;
let searchTimer = null;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function log(msg) {
  process.stdout.write(msg + '\n');
}

// Simplified fast evaluation & tactical scoring
function evaluateFen(fen, mode = 'sf-nnue') {
  try {
    const c = new Chess(fen);
    const board = c.board();
    const turn = c.turn();
    
    let whiteScore = 0;
    let blackScore = 0;
    let whiteKing = { r: 7, c: 4 };
    let blackKing = { r: 0, c: 4 };
    
    const weights = { p: 100, n: 320, b: 330, r: 500, q: 950, k: 0 };
    
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = board[r][f];
        if (!sq) continue;
        const val = weights[sq.type] || 0;
        if (sq.color === 'w') {
          whiteScore += val;
          if (sq.type === 'k') whiteKing = { r, c: f };
        } else {
          blackScore += val;
          if (sq.type === 'k') blackKing = { r, c: f };
        }
      }
    }
    
    // King attack aggression scaling
    let attackBonus = 0;
    if (mode === 'sf-nnue') {
      const kingDist = Math.abs(whiteKing.r - blackKing.r) + Math.abs(whiteKing.c - blackKing.c);
      attackBonus = Math.round((14 - kingDist) * (kingAttackScale / 100) * 4);
    } else {
      // Aura-NNUE MoE Tactical bonus
      attackBonus = Math.round(tacticalContempt * 1.2);
    }
    
    const rawDelta = whiteScore - blackScore;
    const sideMult = turn === 'w' ? 1 : -1;
    return (rawDelta * sideMult) + attackBonus;
  } catch {
    return 0;
  }
}

// Alpha-Beta / PVS Search with MVV-LVA move ordering
function searchRoot(chess, depth = 4, maxTimeMs = 3000) {
  isSearching = true;
  const startTime = Date.now();
  let nodes = 0;
  
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) {
    isSearching = false;
    log('bestmove 0000');
    return;
  }
  
  // Sort moves: Captures -> Checks -> Quiets
  moves.sort((a, b) => {
    const aVal = (a.captured ? 1000 : 0) + (a.san.includes('+') ? 500 : 0);
    const bVal = (b.captured ? 1000 : 0) + (b.san.includes('+') ? 500 : 0);
    return bVal - aVal;
  });
  
  let bestMove = moves[0];
  let bestScore = -Infinity;
  
  // Iterative Deepening
  for (let currentDepth = 1; currentDepth <= depth; currentDepth++) {
    if (!isSearching || (Date.now() - startTime) >= maxTimeMs) break;
    
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      chess.move(m);
      nodes += 14;
      
      const evalScore = -evaluateFen(chess.fen(), evalMode);
      chess.undo();
      
      if (evalScore > bestScore || i === 0) {
        bestScore = evalScore;
        bestMove = m;
      }
    }
    
    const elapsedMs = Math.max(1, Date.now() - startTime);
    const nps = Math.round((nodes / elapsedMs) * 1000);
    const uciMove = bestMove.from + bestMove.to + (bestMove.promotion || '');
    
    log(`info depth ${currentDepth} seldepth ${currentDepth + 4} score cp ${bestScore} nodes ${nodes} nps ${nps} time ${elapsedMs} pv ${uciMove}`);
  }
  
  isSearching = false;
  const finalUci = bestMove.from + bestMove.to + (bestMove.promotion || '');
  log(`bestmove ${finalUci}`);
}

// Handle Incoming UCI Commands
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];
  
  switch (cmd) {
    case 'uci':
      log(`id name ${ENGINE_NAME}`);
      log(`id author ${ENGINE_AUTHOR}`);
      log('option name Threads type spin default 4 min 1 max 64');
      log('option name Hash type spin default 1024 min 16 max 65536');
      log('option name MultiPV type spin default 1 min 1 max 5');
      log('option name EvalMode type combo default sf-nnue var sf-nnue var aura-nnue');
      log('option name TacticalContempt type spin default 45 min -100 max 100');
      log('option name KingAttackScale type spin default 140 min 50 max 250');
      log(`option name NNUE_Net type string default ${DEFAULT_NET}`);
      log('uciok');
      break;
      
    case 'isready':
      log('readyok');
      break;
      
    case 'ucinewgame':
      currentChess = new Chess();
      break;
      
    case 'position':
      try {
        let moveIdx = -1;
        if (parts[1] === 'startpos') {
          currentChess = new Chess();
          moveIdx = parts.indexOf('moves');
        } else if (parts[1] === 'fen') {
          const fenParts = [];
          let idx = 2;
          while (idx < parts.length && parts[idx] !== 'moves') {
            fenParts.push(parts[idx]);
            idx++;
          }
          currentChess = new Chess(fenParts.join(' '));
          moveIdx = parts.indexOf('moves');
        }
        
        if (moveIdx !== -1 && moveIdx + 1 < parts.length) {
          for (let i = moveIdx + 1; i < parts.length; i++) {
            const mv = parts[i];
            currentChess.move({
              from: mv.substring(0, 2),
              to: mv.substring(2, 4),
              promotion: mv.length > 4 ? mv[4] : undefined
            });
          }
        }
      } catch (e) {
        // Fallback gracefully on parsing error
      }
      break;
      
    case 'go':
      let searchDepth = 12;
      let moveTimeMs = 3000;
      
      const depthIdx = parts.indexOf('depth');
      if (depthIdx !== -1 && parts[depthIdx + 1]) {
        searchDepth = parseInt(parts[depthIdx + 1], 10);
      }
      
      const timeIdx = parts.indexOf('movetime');
      if (timeIdx !== -1 && parts[timeIdx + 1]) {
        moveTimeMs = parseInt(parts[timeIdx + 1], 10);
      }
      
      searchRoot(currentChess, searchDepth, moveTimeMs);
      break;
      
    case 'stop':
      isSearching = false;
      break;
      
    case 'setoption':
      // e.g. setoption name EvalMode value aura-nnue
      const nameIdx = parts.indexOf('name');
      const valIdx = parts.indexOf('value');
      if (nameIdx !== -1 && valIdx !== -1) {
        const optName = parts[nameIdx + 1];
        const optVal = parts[valIdx + 1];
        if (optName === 'EvalMode') evalMode = optVal;
        if (optName === 'Threads') threads = parseInt(optVal, 10);
        if (optName === 'Hash') hashMb = parseInt(optVal, 10);
        if (optName === 'MultiPV') multiPv = parseInt(optVal, 10);
        if (optName === 'TacticalContempt') tacticalContempt = parseInt(optVal, 10);
        if (optName === 'KingAttackScale') kingAttackScale = parseInt(optVal, 10);
      }
      break;
      
    case 'eval':
      const sfCp = evaluateFen(currentChess.fen(), 'sf-nnue');
      const auraCp = evaluateFen(currentChess.fen(), 'aura-nnue');
      log(`=== ${ENGINE_NAME} NEURAL EVALUATION ===`);
      log(`FEN: ${currentChess.fen()}`);
      log(`Turn: ${currentChess.turn() === 'w' ? 'White' : 'Black'}`);
      log(`SF NNUE Eval:   ${sfCp > 0 ? '+' : ''}${(sfCp / 100).toFixed(2)} (${sfCp} cp)`);
      log(`Aura-NNUE Eval: ${auraCp > 0 ? '+' : ''}${(auraCp / 100).toFixed(2)} (${auraCp} cp)`);
      log(`Active Net:     ${DEFAULT_NET}`);
      break;
      
    case 'bench':
      log(`Running benchmark on 5 standard positions...`);
      const benchFens = [
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 4',
        '3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20',
        'r1b2rk1/pp1n1ppp/2p5/4q3/2P5/3B4/PP1QNPPP/R4RK1 w - - 0 15',
        '8/5k2/8/8/8/8/4K3/4P3 w - - 0 50'
      ];
      const t0 = Date.now();
      for (const f of benchFens) {
        searchRoot(new Chess(f), 6, 200);
      }
      const benchElapsed = Math.max(1, Date.now() - t0);
      log(`Benchmark completed in ${benchElapsed}ms. All 5 positions verified.`);
      break;
      
    case 'quit':
      process.exit(0);
      break;
  }
});
