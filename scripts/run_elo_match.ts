import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import {
  summarizePairOutcomes,
  computePentanomialSprt,
  formatRecklessReport,
  type PairMatchOutcome,
} from '../src/engine/eloStats';
import {
  BASELINE_V060_RELEASE_URL,
  MATCH_OPENING_BOOK,
  V070_VS_V060_RESULTS_FILE,
  formatMatchHardwareSummary,
  formatMatchResultSummary,
  formatEloGainSummary,
  tallyTerminations,
  type MatchPairDetail,
  type MatchResultPayload,
} from '../src/engine/matchConfig';
import { ensureNodeNnueCachedAsync, NNUE_FILE, NNUE_BYTES } from '../src/engine/wasmEngine';

interface IndexedOpeningEntry {
  index: number;
  name: string;
  fen: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const cpuCores = Math.max(1, os.cpus().length);
  const opts = {
    pairs: 30,
    minPairs: 10, // Minimum 20 quick games before SPRT early stopping
    sprt: true,
    elo0: 0,
    elo1: 10,
    baseMs: 2500,
    incMs: 150,
    threads: 1,
    hashMb: 64,
    workers: Math.min(2, cpuCores),
    candidatePath: 'bin/berserker-native',
    baselinePath: 'public/downloads/berserker-v0.6.0-cli.js',
    candidateMode: 'Pure-PVS',
    baselineMode: 'Pure-PVS',
    outPath: V070_VS_V060_RESULTS_FILE,
    progressFile: null as string | null,
  };

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const val = args[i + 1];
    if (!val) continue;
    if (key === '--pairs') opts.pairs = parseInt(val, 10);
    else if (key === '--min-pairs') opts.minPairs = parseInt(val, 10);
    else if (key === '--sprt') opts.sprt = val !== 'false' && val !== '0';
    else if (key === '--elo0') opts.elo0 = parseFloat(val);
    else if (key === '--elo1') opts.elo1 = parseFloat(val);
    else if (key === '--base-ms') opts.baseMs = parseInt(val, 10);
    else if (key === '--inc-ms') opts.incMs = parseInt(val, 10);
    else if (key === '--threads') opts.threads = parseInt(val, 10);
    else if (key === '--hash') opts.hashMb = parseInt(val, 10);
    else if (key === '--workers') opts.workers = parseInt(val, 10);
    else if (key === '--candidate') opts.candidatePath = val;
    else if (key === '--baseline') opts.baselinePath = val;
    else if (key === '--candidate-mode') opts.candidateMode = val;
    else if (key === '--baseline-mode') opts.baselineMode = val;
    else if (key === '--out') opts.outPath = val;
    else if (key === '--progress-file') opts.progressFile = val;
  }

  return opts;
}

async function main() {
  const opts = parseArgs();
  const cpuCores = Math.max(1, os.cpus().length);
  const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
  const candidateAbs = path.resolve(opts.candidatePath);
  const baselineAbs = path.resolve(opts.baselinePath);

  if (!fs.existsSync(candidateAbs)) {
    throw new Error(`Candidate engine not found at ${candidateAbs}`);
  }
  if (!fs.existsSync(baselineAbs)) {
    throw new Error(`Baseline engine v0.6.0 not found at ${baselineAbs}`);
  }

  // Ensure NNUE binary is downloaded locally and pass its STRING FILE PATH (not raw Buffer!)
  await ensureNodeNnueCachedAsync();
  const nnuePath = path.resolve('storage/nn-cache', NNUE_FILE);
  if (!fs.existsSync(nnuePath) || fs.statSync(nnuePath).size !== NNUE_BYTES) {
    throw new Error(`Cached NNUE binary invalid at ${nnuePath}`);
  }

  const effectiveWorkers = Math.max(
    1,
    Math.min(opts.workers, opts.pairs, Math.max(1, Math.floor(cpuCores / Math.max(1, opts.threads))))
  );
  const minPairs = Math.max(1, Math.min(opts.pairs, opts.minPairs));

  const pairQueue: IndexedOpeningEntry[] = [];
  for (let i = 0; i < opts.pairs; i++) {
    const entry = MATCH_OPENING_BOOK[i % MATCH_OPENING_BOOK.length];
    pairQueue.push({ index: i, name: entry.name, fen: entry.fen });
  }

  const timeControlLabel = `${(opts.baseMs / 1000).toFixed(1)}+${(opts.incMs / 1000).toFixed(2)}s`;
  const hardwareSummary = formatMatchHardwareSummary(opts.threads, opts.hashMb);

  console.log(`Starting Berserker v0.7.0 (138.4MB NNUE) vs Berserker v0.6.0 Match`);
  console.log(`Hardware | ${hardwareSummary} (Host: ${cpuCores} Threads, ${(totalRamMb / 1024).toFixed(1)} GiB RAM)`);
  console.log(
    `Conf     | ${timeControlLabel} | Min=${minPairs * 2} games (${minPairs} pairs), SPRT [${opts.elo0.toFixed(2)}, ${opts.elo1.toFixed(2)}] up to ${opts.pairs * 2} games | Workers=${effectiveWorkers}`
  );
  console.log(`Base Ref | ${BASELINE_V060_RELEASE_URL}\n`);

  const tStart = Date.now();
  const pairResults: MatchPairDetail[] = [];
  const outcomes: PairMatchOutcome[] = [];
  let nextPairCursor = 0;
  let sprtStopped = false;

  const writeProgress = (running: boolean) => {
    if (!opts.progressFile) return;
    const liveStats = summarizePairOutcomes(outcomes);
    const liveSprt = opts.sprt
      ? computePentanomialSprt(liveStats, { elo0: opts.elo0, elo1: opts.elo1 })
      : undefined;
    const livePayload = {
      running,
      completedPairs: outcomes.length,
      totalPairs: opts.pairs,
      threads: opts.threads,
      hashMb: opts.hashMb,
      timeControl: timeControlLabel,
      hardwareSummary,
      resultSummary: formatMatchResultSummary(liveStats),
      eloSummary: formatEloGainSummary(liveStats),
      stats: liveStats,
      sprt: liveSprt,
      elapsedSec: parseFloat(((Date.now() - tStart) / 1000).toFixed(1)),
    };
    try {
      fs.mkdirSync(path.dirname(path.resolve(opts.progressFile)), { recursive: true });
      fs.writeFileSync(path.resolve(opts.progressFile), JSON.stringify(livePayload, null, 2));
    } catch {
      // ignore non-fatal progress write errors
    }
  };

  writeProgress(true);

  await new Promise<void>((resolveAll, rejectAll) => {
    const workers: Worker[] = [];
    let exitedCount = 0;
    let failed = false;

    const dispatchOrShutdown = (worker: Worker) => {
      if (sprtStopped || nextPairCursor >= pairQueue.length) {
        worker.postMessage({ type: 'shutdown' });
        return;
      }
      const pair = pairQueue[nextPairCursor++];
      worker.postMessage({ type: 'run-pair', pair });
    };

    for (let w = 0; w < effectiveWorkers; w++) {
      const worker = new Worker(path.resolve('scripts/match_worker.mjs'), {
        workerData: {
          candidatePath: candidateAbs,
          baselinePath: baselineAbs,
          candidateSearchMode: opts.candidateMode,
          baselineSearchMode: opts.baselineMode,
          candidateEvalFile: nnuePath,
          hashMb: opts.hashMb,
          threads: opts.threads,
          baseMs: opts.baseMs,
          incMs: opts.incMs,
        },
      });
      workers.push(worker);

      worker.on('message', (msg) => {
        if (failed) return;
        if (msg.type === 'ready') {
          dispatchOrShutdown(worker);
        } else if (msg.type === 'pair-complete') {
          pairResults.push({
            pairIndex: msg.pairIndex,
            openingName: msg.openingName,
            game1Score: msg.game1Score,
            game2Score: msg.game2Score,
            game1Reason: msg.game1Reason,
            game2Reason: msg.game2Reason,
            game1Plies: msg.game1Plies,
            game2Plies: msg.game2Plies,
          });
          outcomes.push({ game1Score: msg.game1Score, game2Score: msg.game2Score });

          const liveStats = summarizePairOutcomes(outcomes);
          const liveSprt = opts.sprt
            ? computePentanomialSprt(liveStats, { elo0: opts.elo0, elo1: opts.elo1 })
            : undefined;

          if (
            opts.sprt &&
            liveSprt &&
            outcomes.length >= minPairs &&
            liveSprt.status !== 'RUNNING'
          ) {
            sprtStopped = true;
          }

          writeProgress(!sprtStopped && outcomes.length < pairQueue.length);

          console.log(
            `[Pair ${outcomes.length} | N:${liveStats.games} W:${liveStats.wins} L:${liveStats.losses} D:${liveStats.draws}] Elo ${liveStats.elo >= 0 ? '+' : ''}${liveStats.elo.toFixed(2)} +- ${liveStats.err95.toFixed(2)}${
              liveSprt ? ` | LLR ${liveSprt.llr.toFixed(2)} (${liveSprt.status})` : ''
            }`
          );

          dispatchOrShutdown(worker);
        } else if (msg.type === 'error') {
          failed = true;
          for (const wk of workers) wk.terminate();
          rejectAll(new Error(msg.message));
        }
      });

      worker.on('error', (err) => {
        if (failed) return;
        failed = true;
        for (const wk of workers) wk.terminate();
        rejectAll(err);
      });

      worker.on('exit', (code) => {
        exitedCount++;
        if (code !== 0 && !failed) {
          failed = true;
          for (const wk of workers) wk.terminate();
          rejectAll(new Error(`Worker exited with code ${code}`));
          return;
        }
        if (exitedCount === workers.length && !failed) {
          resolveAll();
        }
      });
    }
  });

  const stats = summarizePairOutcomes(outcomes);
  const sprt = opts.sprt
    ? computePentanomialSprt(stats, { elo0: opts.elo0, elo1: opts.elo1 })
    : undefined;
  const reportText = formatRecklessReport({
    stats,
    timeControl: timeControlLabel,
    threads: opts.threads,
    hashMb: opts.hashMb,
    sprt,
    referenceUrl: BASELINE_V060_RELEASE_URL,
  });

  const elapsedSec = parseFloat(((Date.now() - tStart) / 1000).toFixed(1));
  const resultSummary = formatMatchResultSummary(stats);
  const eloSummary = formatEloGainSummary(stats);
  const terminations = tallyTerminations(pairResults);

  writeProgress(false);

  console.log('\n==================== FINAL TESTED MATCH RESULT ====================');
  console.log(`HW    | ${hardwareSummary} (Host: ${cpuCores} Threads, ${(totalRamMb / 1024).toFixed(1)} GiB RAM)`);
  console.log(reportText);
  console.log(
    `LOS   | ${(stats.los * 100).toFixed(2)}% | Score: ${(stats.scoreRate * 100).toFixed(2)}% | Elapsed: ${elapsedSec}s`
  );
  console.log(`Terms | ${Object.entries(terminations).map(([k, v]) => `${k}=${v}`).join(' | ')}`);
  console.log('===================================================================\n');

  const payload: MatchResultPayload = {
    candidate: 'Berserker v0.7.0 (C++20 Pure-PVS + 138.4MB NNUE)',
    baseline: 'Berserker v0.6.0',
    baselineUrl: BASELINE_V060_RELEASE_URL,
    nnueFile: NNUE_FILE,
    nnueBytes: NNUE_BYTES,
    timeControl: timeControlLabel,
    threads: opts.threads,
    hashMb: opts.hashMb,
    workers: effectiveWorkers,
    hostCpuCores: cpuCores,
    hostTotalRamMb: totalRamMb,
    elapsedSec,
    hardwareSummary,
    resultSummary,
    eloSummary,
    reportText,
    stats,
    sprt,
    terminations,
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
