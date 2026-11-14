import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { summarizePairOutcomes, formatRecklessReport, type PairMatchOutcome } from '../src/engine/eloStats';

interface OpeningEntry {
  index: number;
  name: string;
  fen: string;
}

const OPENING_BOOK: { name: string; fen: string }[] = [
  { name: 'Ruy Lopez Closed', fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4' },
  { name: 'Italian Giuoco Piano', fen: 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4' },
  { name: 'Sicilian Najdorf', fen: 'rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6' },
  { name: 'Sicilian Dragon', fen: 'rnbqkb1r/pp2pp1p/3p1np1/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6' },
  { name: 'Sicilian Classical', fen: 'r1bqkb1r/pp1p1ppp/2n1pn2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 2 6' },
  { name: 'French Winawer', fen: 'rnbqk1nr/ppp2ppp/4p3/3p4/1b1PP3/2N5/PPP2PPP/R1BQKBNR w KQkq - 2 4' },
  { name: 'Caro-Kann Classical', fen: 'rn1qkbnr/pp2pppp/2p5/5b2/3PN3/8/PPP2PPP/R1BQKBNR w KQkq - 1 5' },
  { name: 'Queens Gambit Declined', fen: 'rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 2 4' },
  { name: 'Slav Defense', fen: 'rnbqkb1r/pp2pppp/2p2n2/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq - 2 4' },
  { name: 'Nimzo-Indian Rubinstein', fen: 'rnbqk2r/pppp1ppp/4pn2/8/1bPP4/2N1P3/PP3PPP/R1BQKBNR w KQkq - 2 4' },
  { name: 'Kings Indian Classical', fen: 'rnbq1rk1/ppp1ppbp/3p1np1/8/2PPP3/2N2N2/PP2BPPP/R1BQK2R w KQ - 4 6' },
  { name: 'Grunfeld Exchange', fen: 'rnbqkb1r/ppp1pp1p/5np1/3P4/3P4/2N5/PP2PPPP/R1BQKBNR b KQkq - 0 4' },
  { name: 'English Reversed Sicilian', fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2P5/2N3P1/PP1PPP1P/R1BQKBNR w KQkq - 1 3' },
  { name: 'Catalan Closed', fen: 'rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/6P1/PP2PPBP/RNBQK1NR w KQkq - 0 4' },
  { name: 'Scotch Classical', fen: 'r1bqkbnr/pppp1ppp/2n5/8/3NP3/8/PPP2PPP/R1BQKB1R b KQkq - 0 4' },
  { name: 'Petroff Defense', fen: 'rnbqkb1r/ppp2ppp/8/3pN3/4P3/8/PPPP1PPP/RNBQKB1R w KQkq - 0 4' },
  { name: 'Scandinavian Qa5', fen: 'rnb1kbnr/ppp1pppp/8/q7/3P4/2N5/PPP2PPP/R1BQKBNR w KQkq - 2 4' },
  { name: 'Pirc Classical', fen: 'rnbqkb1r/ppp1pp1p/3p1np1/8/3PP3/2N2N2/PPP2PPP/R1BQKB1R w KQkq - 0 5' },
  { name: 'Alekhine Four Pawns', fen: 'rnbqkb1r/ppp1pppp/3p4/3nP3/2PP4/8/PP3PPP/RNBQKBNR b KQkq - 0 4' },
  { name: 'Dutch Leningrad', fen: 'rnbqkbnr/ppppp1pp/8/5p2/2PP4/6P1/PP2PP1P/RNBQKBNR b KQkq - 0 2' },
  { name: 'Benoni Modern', fen: 'rnbqkb1r/pp1p1ppp/4pn2/2pP4/2P5/2N5/PP2PPPP/R1BQKBNR w KQkq - 0 5' },
  { name: 'Vienna Falkbeer', fen: 'rnbqkb1r/pppp1ppp/5n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R b KQkq - 3 3' },
  { name: 'Two Knights Defense', fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4' },
  { name: 'Evans Gambit Declined', fen: 'r1bqk1nr/pppp1ppp/2n5/2b1p3/1PB1P3/5N2/P1PP1PPP/RNBQK2R b KQkq - 0 4' },
  { name: 'London System', fen: 'rnbqkb1r/ppp1pppp/5n2/3p4/3P1B2/5N2/PPP1PPPP/RN1QKB1R b KQkq - 3 3' },
  { name: 'Reti Kingside', fen: 'rnbqkb1r/ppp1pppp/5n2/3p4/2P5/5NP1/PP1PPP1P/RNBQKB1R b KQkq - 0 3' },
  { name: 'Sicilian Alapin', fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/2P5/PP1P1PPP/RNBQKBNR b KQkq - 0 2' },
  { name: 'Philidor Exchange', fen: 'rnbqkbnr/ppp2ppp/3p4/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R w KQkq - 0 3' },
  { name: 'Queens Indian', fen: 'rnbqkb1r/p1pp1ppp/1p2pn2/8/2PP4/5N2/PP2PPPP/RNBQKB1R w KQkq - 0 4' },
  { name: 'Trompowsky Attack', fen: 'rnbqkb1r/pppppppp/5n2/6B1/3P4/8/PPP1PPPP/RN1QKBNR b KQkq - 2 2' },
  { name: 'Sicilian Rossolimo', fen: 'r1bqkbnr/pp1ppppp/2n5/1Bp5/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3' },
  { name: 'French Tarrasch', fen: 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPPN1PPP/R1BQKBNR b KQkq - 1 3' },
  { name: 'Bogo-Indian', fen: 'rnbqk2r/pppp1ppp/4pn2/8/1bPP4/5N2/PP2PPPP/RNBQKB1R w KQkq - 2 4' },
  { name: 'Symmetrical English', fen: 'rnbqkbnr/pp1ppppp/8/2p5/2P5/2N5/PP1PPPPP/R1BQKBNR w KQkq - 0 2' },
  { name: 'Semi-Slav', fen: 'rnbqkb1r/pp3ppp/2p1pn2/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq - 0 5' },
  { name: 'Three Knights', fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R b KQkq - 3 3' },
  { name: 'Scotch Four Knights', fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/3PP3/2N2N2/PPP2PPP/R1BQKB1R w KQkq - 1 4' },
  { name: 'Ruy Lopez Berlin', fen: 'r1bqkb1r/pppp1ppp/2n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4' },
  { name: 'Benko Gambit', fen: 'rnbqkb1r/p2ppppp/5n2/1ppP4/2P5/8/PP2PPPP/RNBQKBNR w KQkq - 0 4' },
  { name: 'Kings Gambit Declined', fen: 'rnbqk1nr/pppp1ppp/8/2b1p3/4PP2/8/PPPP2PP/RNBQKBNR w KQkq - 1 3' }
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    pairs: 30,
    baseMs: 2000,
    incMs: 60,
    threads: 1,
    hashMb: 16,
    workers: Math.min(4, Math.max(1, os.cpus().length)),
    candidateMode: 'Hybrid-MCTS-PVS',
    baselineMode: 'Pure-PVS',
    outPath: 'data/v071_vs_v060_match_results.json',
  };

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const val = args[i + 1];
    if (!val) continue;
    if (key === '--pairs') opts.pairs = parseInt(val, 10);
    else if (key === '--base-ms') opts.baseMs = parseInt(val, 10);
    else if (key === '--inc-ms') opts.incMs = parseInt(val, 10);
    else if (key === '--threads') opts.threads = parseInt(val, 10);
    else if (key === '--hash') opts.hashMb = parseInt(val, 10);
    else if (key === '--workers') opts.workers = parseInt(val, 10);
    else if (key === '--candidate-mode') opts.candidateMode = val;
    else if (key === '--baseline-mode') opts.baselineMode = val;
    else if (key === '--out') opts.outPath = val;
  }

  return opts;
}

async function main() {
  const opts = parseArgs();
  const pairsList: OpeningEntry[] = [];
  for (let i = 0; i < opts.pairs; i++) {
    const entry = OPENING_BOOK[i % OPENING_BOOK.length];
    pairsList.push({ index: i, name: entry.name, fen: entry.fen });
  }

  const timeControlLabel = `${(opts.baseMs / 1000).toFixed(1)}+${(opts.incMs / 1000).toFixed(2)}s`;
  console.log(`Starting Berserker v0.7.1-dev vs v0.6.0 Head-to-Head Match`);
  console.log(`Conf  | ${timeControlLabel} Threads=${opts.threads} Hash=${opts.hashMb}MB | Pairs=${opts.pairs} (${opts.pairs * 2} games) | Workers=${opts.workers}`);
  console.log(`Modes | v0.7.1-dev (${opts.candidateMode}) vs v0.6.0 (${opts.baselineMode})\n`);

  const workerBuckets: OpeningEntry[][] = Array.from({ length: opts.workers }, () => []);
  pairsList.forEach((p, idx) => {
    workerBuckets[idx % opts.workers].push(p);
  });

  const tStart = Date.now();
  const pairResults: any[] = [];
  const outcomes: PairMatchOutcome[] = [];

  await Promise.all(
    workerBuckets
      .filter((bucket) => bucket.length > 0)
      .map(
        (assignedPairs) =>
          new Promise<void>((resolve, reject) => {
            const worker = new Worker(path.resolve('scripts/match_worker.mjs'), {
              workerData: {
                candidatePath: path.resolve('berserker-cli.js'),
                baselinePath: path.resolve('public/downloads/berserker-v0.6.0-cli.js'),
                candidateSearchMode: opts.candidateMode,
                baselineSearchMode: opts.baselineMode,
                hashMb: opts.hashMb,
                threads: opts.threads,
                baseMs: opts.baseMs,
                incMs: opts.incMs,
                assignedPairs,
              },
            });

            worker.on('message', (msg) => {
              if (msg.type === 'pair-complete') {
                pairResults.push(msg);
                outcomes.push({ game1Score: msg.game1Score, game2Score: msg.game2Score });
                const liveStats = summarizePairOutcomes(outcomes);
                if (outcomes.length % 4 === 0 || outcomes.length === opts.pairs) {
                  console.log(
                    `[Pair ${outcomes.length}/${opts.pairs}] N=${liveStats.games} +${liveStats.wins} -${liveStats.losses} =${liveStats.draws} | Elo ${liveStats.elo.toFixed(2)} +- ${liveStats.err95.toFixed(2)} | Penta [${liveStats.penta.join(', ')}]`
                  );
                }
              } else if (msg.type === 'error') {
                reject(new Error(msg.message));
              }
            });

            worker.on('error', reject);
            worker.on('exit', (code) => {
              if (code === 0) resolve();
              else reject(new Error(`Worker exited with code ${code}`));
            });
          })
      )
  );

  const stats = summarizePairOutcomes(outcomes);
  const reportText = formatRecklessReport({
    stats,
    timeControl: timeControlLabel,
    threads: opts.threads,
    hashMb: opts.hashMb,
  });

  const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log('\n==================== FINAL TESTED MATCH RESULT ====================');
  console.log(reportText);
  console.log(`LOS   | ${(stats.los * 100).toFixed(2)}% | Score: ${(stats.scoreRate * 100).toFixed(2)}% | Elapsed: ${elapsedSec}s`);
  console.log('===================================================================\n');

  const payload = {
    candidate: 'Berserker v0.7.1-dev',
    baseline: 'Berserker v0.6.0',
    candidateMode: opts.candidateMode,
    baselineMode: opts.baselineMode,
    timeControl: timeControlLabel,
    threads: opts.threads,
    hashMb: opts.hashMb,
    elapsedSec: parseFloat(elapsedSec),
    reportText,
    stats,
    pairs: pairResults.sort((a, b) => a.pairIndex - b.pairIndex),
  };

  fs.mkdirSync(path.dirname(path.resolve(opts.outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(opts.outPath), JSON.stringify(payload, null, 2));
  console.log(`Saved match results to ${opts.outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
