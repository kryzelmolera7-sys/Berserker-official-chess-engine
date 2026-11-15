import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { Chess } from 'chess.js';

interface WorkerClient {
  name: string;
  send: (payload: object) => Promise<any>;
  close: () => Promise<void>;
}

function createWorker(name: string, fixTtFlag: boolean): WorkerClient {
  const proc: ChildProcessWithoutNullStreams = spawn(
    'npx',
    ['--yes', 'tsx', 'tests/ab_search_worker.ts'],
    {
      env: { ...process.env, BERSERKER_FIX_TT_FLAG: fixTtFlag ? '1' : '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  const rl = readline.createInterface({ input: proc.stdout });
  const waiters: ((line: string) => void)[] = [];

  rl.on('line', (line) => {
    const resolve = waiters.shift();
    if (resolve) resolve(line);
  });

  const send = (payload: object): Promise<any> =>
    new Promise((resolve, reject) => {
      waiters.push((line) => {
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`Invalid JSON from ${name}: ${line}`));
        }
      });
      proc.stdin.write(JSON.stringify(payload) + '\n');
    });

  const close = async () => {
    try {
      proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
    } catch {}
    proc.kill();
  };

  return { name, send, close };
}

const BENCH_POSITIONS = [
  { name: 'Italian Tactical', fen: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 4' },
  { name: 'Attack Surge M20', fen: '3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20' },
  { name: 'Rook Endgame', fen: '8/5pk1/4p1p1/7p/7P/2r2PK1/6P1/8 w - - 0 40' },
];

const OPENINGS = [
  { name: 'Startpos', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  { name: 'Sicilian Najdorf', fen: 'r1bqkb1r/1p2pppp/p1np1n2/8/3NP3/2N1B3/PPP2PPP/R2QKB1R w KQkq - 2 7' },
  { name: 'Ruy Lopez Berlin', fen: 'r1bqkb1r/pppp1ppp/2n5/1B2p3/4n3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 5' },
  { name: 'Queens Gambit', fen: 'r1bqkb1r/pppn1ppp/4pn2/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq - 2 5' },
  { name: 'Italian Evans', fen: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/1PB1P3/5N2/P1PP1PPP/RNBQK2R b KQkq - 0 5' },
  { name: 'Attack Surge M20', fen: '3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20' },
];

async function runSingleBench(op: { name: string; fen: string }) {
  const base = createWorker('Baseline(ttBug)', false);
  const imp = createWorker('Improved(origAlpha)', true);
  try {
    const [b, i] = await Promise.all([
      base.send({ cmd: 'go', fen: op.fen, depth: 4, timeMs: 25000 }),
      imp.send({ cmd: 'go', fen: op.fen, depth: 4, timeMs: 25000 }),
    ]);
    return { name: op.name, b, i };
  } finally {
    await base.close();
    await imp.close();
  }
}

async function runBench() {
  console.log('=== BENCH COMPARISON (Fixed depth=4, isolated TT per position) ===');
  const rows = await Promise.all(BENCH_POSITIONS.map(runSingleBench));
  let baseNodes = 0;
  let impNodes = 0;
  let baseTime = 0;
  let impTime = 0;
  let baseTtHits = 0;
  let impTtHits = 0;

  for (const { name, b, i } of rows) {
    baseNodes += b.nodes;
    impNodes += i.nodes;
    baseTime += b.timeMs;
    impTime += i.timeMs;
    baseTtHits += b.ttHits;
    impTtHits += i.ttHits;
    console.log(
      `${name.padEnd(18)} | Base: ${String(b.nodes).padStart(5)} nodes (${String(b.timeMs).padStart(4)}ms, ttHits=${String(b.ttHits).padStart(3)}, ${b.uci}) | Imp: ${String(i.nodes).padStart(5)} nodes (${String(i.timeMs).padStart(4)}ms, ttHits=${String(i.ttHits).padStart(3)}, ${i.uci})`
    );
  }
  const nodeDiffPct = (((impNodes - baseNodes) / Math.max(1, baseNodes)) * 100).toFixed(1);
  const timeDiffPct = (((impTime - baseTime) / Math.max(1, baseTime)) * 100).toFixed(1);
  console.log(
    `TOTAL BENCH: Base=${baseNodes} nodes (${baseTime}ms, ttHits=${baseTtHits}) vs Imp=${impNodes} nodes (${impTime}ms, ttHits=${impTtHits}) [${nodeDiffPct}% nodes, ${timeDiffPct}% time]\n`
  );
}

async function playSingleGame(
  fen: string,
  impIsWhite: boolean,
  timePerMoveMs: number
): Promise<{ result: 'imp' | 'base' | 'draw'; reason: string; plies: number }> {
  const base = createWorker('Baseline(ttBug)', false);
  const imp = createWorker('Improved(origAlpha)', true);

  try {
    const chess = new Chess(fen);
    let plies = 0;
    let highEvalCount = 0;
    let lastFavored: 'w' | 'b' | null = null;
    let drawEvalCount = 0;

    while (!chess.isGameOver() && plies < 60) {
      const turn = chess.turn();
      const isImpTurn = (turn === 'w' && impIsWhite) || (turn === 'b' && !impIsWhite);
      const engine = isImpTurn ? imp : base;

      const res = await engine.send({
        cmd: 'go',
        fen: chess.fen(),
        depth: 4,
        timeMs: timePerMoveMs,
      });

      if (!res.uci || res.uci === '0000') break;
      const from = res.uci.slice(0, 2);
      const to = res.uci.slice(2, 4);
      const promotion = res.uci.length > 4 ? res.uci[4] : undefined;

      const move = chess.move({ from, to, promotion });
      if (!move) {
        throw new Error(`Illegal move ${res.uci} by ${engine.name} on FEN ${chess.fen()}`);
      }
      plies++;

      if (Math.abs(res.scoreCp) >= 500 && Math.abs(res.scoreCp) < 19000) {
        const favored = res.scoreCp > 0 ? turn : (turn === 'w' ? 'b' : 'w');
        if (favored === lastFavored) highEvalCount++;
        else {
          lastFavored = favored;
          highEvalCount = 1;
        }
        if (highEvalCount >= 3) {
          const winner = (favored === 'w') === impIsWhite ? 'imp' : 'base';
          return { result: winner, reason: 'resign-500cp', plies };
        }
      } else {
        highEvalCount = 0;
      }

      if (plies >= 36 && Math.abs(res.scoreCp) <= 10) {
        drawEvalCount++;
        if (drawEvalCount >= 8) {
          return { result: 'draw', reason: 'adj-draw', plies };
        }
      } else {
        drawEvalCount = 0;
      }
    }

    if (chess.isCheckmate()) {
      const winnerIsWhite = chess.turn() === 'b';
      return {
        result: winnerIsWhite === impIsWhite ? 'imp' : 'base',
        reason: 'checkmate',
        plies,
      };
    }
    if (chess.isDraw()) {
      return { result: 'draw', reason: 'rule-draw', plies };
    }
    return { result: 'draw', reason: 'max-plies', plies };
  } finally {
    await base.close();
    await imp.close();
  }
}

async function runMatch(startIdx: number, count: number) {
  const timePerMoveMs = 150;
  const slice = OPENINGS.slice(startIdx, startIdx + count);
  console.log(`=== SELF-PLAY MATCH: Improved(origAlpha) vs Baseline(ttBug) | ${slice.length * 2} games (pairs ${startIdx + 1}-${startIdx + slice.length}) @ depth<=4, ${timePerMoveMs}ms/move ===`);

  let impWins = 0;
  let draws = 0;
  let baseWins = 0;
  const penta = { WW: 0, WD: 0, DD_WL: 0, LD: 0, LL: 0 };

  for (let i = 0; i < slice.length; i += 2) {
    const batch = slice.slice(i, i + 2);
    const batchResults = await Promise.all(
      batch.map(async (op, offset) => {
        const [g1, g2] = await Promise.all([
          playSingleGame(op.fen, true, timePerMoveMs),
          playSingleGame(op.fen, false, timePerMoveMs),
        ]);
        return { op, pairNum: startIdx + i + offset + 1, g1, g2 };
      })
    );

    for (const { op, pairNum, g1, g2 } of batchResults) {
      for (const g of [g1, g2]) {
        if (g.result === 'imp') impWins++;
        else if (g.result === 'base') baseWins++;
        else draws++;
      }
      const pairPts =
        (g1.result === 'imp' ? 1 : g1.result === 'draw' ? 0.5 : 0) +
        (g2.result === 'imp' ? 1 : g2.result === 'draw' ? 0.5 : 0);

      if (pairPts === 2) penta.WW++;
      else if (pairPts === 1.5) penta.WD++;
      else if (pairPts === 1) penta.DD_WL++;
      else if (pairPts === 0.5) penta.LD++;
      else penta.LL++;

      const fmt = (res: string) => (res === 'imp' ? '1' : res === 'draw' ? '=' : '0');
      console.log(
        `Pair ${String(pairNum).padStart(2)} (${op.name.padEnd(18)}): [${fmt(g1.result)}-${fmt(g2.result)}] (${g1.reason}/${g1.plies}p, ${g2.reason}/${g2.plies}p)`
      );
    }
  }

  const total = impWins + draws + baseWins;
  const score = (impWins + 0.5 * draws) / total;
  let eloStr = 'N/A';
  if (score > 0 && score < 1) {
    const elo = -400 * Math.log10(1 / score - 1);
    const seScore = Math.sqrt((score * (1 - score)) / total);
    const eloErr = (400 / Math.LN10) * (seScore / (score * (1 - score)));
    eloStr = `${elo >= 0 ? '+' : ''}${elo.toFixed(1)} ± ${eloErr.toFixed(1)} Elo`;
  } else if (score === 1) {
    eloStr = '+inf (100%)';
  } else {
    eloStr = '-inf (0%)';
  }

  console.log('\n=== MATCH SUMMARY ===');
  console.log(`Games: ${total} | W/D/L (Improved): +${impWins} =${draws} -${baseWins}`);
  console.log(`Score: ${(score * 100).toFixed(1)}% (${impWins + 0.5 * draws}/${total})`);
  console.log(`Pentanomial [WW, WD, DD/WL, LD, LL]: [${penta.WW}, ${penta.WD}, ${penta.DD_WL}, ${penta.LD}, ${penta.LL}]`);
  console.log(`Estimated Elo diff: ${eloStr}`);
}

async function main() {
  const args = process.argv.slice(2);
  const doBench = args.includes('--bench') || args.length === 0;
  const doMatch = args.includes('--match') || args.length === 0;
  const startIdx = args.includes('--start') ? parseInt(args[args.indexOf('--start') + 1] || '0', 10) : 0;
  const count = args.includes('--count') ? parseInt(args[args.indexOf('--count') + 1] || String(OPENINGS.length), 10) : OPENINGS.length;

  if (doBench) await runBench();
  if (doMatch) await runMatch(startIdx, count);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
