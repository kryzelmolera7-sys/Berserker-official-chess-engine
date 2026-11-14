import { parentPort, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { Chess } from 'chess.js';

class UciEngineProcess {
  constructor(scriptPath, searchMode, hashMb = 16, threads = 1) {
    this.scriptPath = scriptPath;
    this.searchMode = searchMode;
    this.hashMb = hashMb;
    this.threads = threads;
    this.proc = null;
    this.buffer = '';
    this.waiter = null;
  }

  async start() {
    this.proc = spawn('node', [this.scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      this._processLines();
    });
    this.proc.stderr.on('data', () => {
      // Ignore informational stderr
    });
    await this.sendAndWait('uci', (line) => line === 'uciok');
    this.send(`setoption name Threads value ${this.threads}`);
    this.send(`setoption name Hash value ${this.hashMb}`);
    if (this.searchMode) {
      this.send(`setoption name SearchMode value ${this.searchMode}`);
    }
    await this.sendAndWait('isready', (line) => line === 'readyok');
  }

  send(cmd) {
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.write(cmd + '\n');
    }
  }

  _processLines() {
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (this.waiter) {
        this.waiter.lines.push(line);
        if (this.waiter.predicate(line)) {
          const resolve = this.waiter.resolve;
          const lines = this.waiter.lines;
          this.waiter = null;
          resolve(lines);
        }
      }
    }
  }

  sendAndWait(cmd, predicate, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter) {
          const lines = this.waiter.lines;
          this.waiter = null;
          reject(new Error(`Timeout waiting for ${this.scriptPath} after "${cmd}". Lines: ${lines.slice(-3).join(' | ')}`));
        }
      }, timeoutMs);

      this.waiter = {
        predicate,
        lines: [],
        resolve: (lines) => {
          clearTimeout(timer);
          resolve(lines);
        }
      };
      this.send(cmd);
    });
  }

  async newGame() {
    this.send('ucinewgame');
    await this.sendAndWait('isready', (line) => line === 'readyok');
  }

  async search(fen, moveHistoryUci, wtimeMs, btimeMs, wincMs, bincMs) {
    const posCmd = moveHistoryUci.length > 0
      ? `position fen ${fen} moves ${moveHistoryUci.join(' ')}`
      : `position fen ${fen}`;
    this.send(posCmd);
    const goCmd = `go wtime ${Math.max(10, Math.round(wtimeMs))} btime ${Math.max(10, Math.round(btimeMs))} winc ${Math.round(wincMs)} binc ${Math.round(bincMs)}`;

    const t0 = performance.now();
    const lines = await this.sendAndWait(goCmd, (line) => line.startsWith('bestmove '), 15000);
    const elapsedMs = Math.max(1, Math.round(performance.now() - t0));

    let bestMoveUci = '0000';
    let lastCp = 0;

    for (const l of lines) {
      if (l.startsWith('info ')) {
        const mateMatch = l.match(/\bscore mate (-?\d+)/);
        const cpMatch = l.match(/\bscore cp (-?\d+)/);
        if (mateMatch) {
          const m = parseInt(mateMatch[1], 10);
          lastCp = m > 0 ? 25000 - Math.abs(m) : -25000 + Math.abs(m);
        } else if (cpMatch) {
          lastCp = parseInt(cpMatch[1], 10);
        }
      } else if (l.startsWith('bestmove ')) {
        bestMoveUci = l.split(/\s+/)[1] || '0000';
      }
    }

    return { bestMoveUci, scoreCp: lastCp, elapsedMs };
  }

  stop() {
    if (this.proc) {
      try {
        this.send('quit');
        setTimeout(() => {
          if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
        }, 100);
      } catch {
        // ignore
      }
    }
  }
}

async function playSingleGame({ whiteEngine, blackEngine, startFen, baseMs, incMs }) {
  await whiteEngine.newGame();
  await blackEngine.newGame();

  const chess = new Chess(startFen);
  const moveHistoryUci = [];
  let wtime = baseMs;
  let btime = baseMs;
  let plies = 0;
  let winAdjWhiteCount = 0;
  let winAdjBlackCount = 0;
  let drawAdjCount = 0;

  while (plies < 220) {
    if (chess.isCheckmate()) {
      return { whiteScore: chess.turn() === 'w' ? 0 : 1, reason: 'checkmate', plies };
    }
    if (chess.isDraw()) {
      return { whiteScore: 0.5, reason: 'draw-rule', plies };
    }

    const turn = chess.turn();
    const active = turn === 'w' ? whiteEngine : blackEngine;
    const res = await active.search(startFen, moveHistoryUci, wtime, btime, incMs, incMs);

    if (turn === 'w') {
      wtime = wtime - res.elapsedMs;
      if (wtime <= 0) {
        return { whiteScore: 0, reason: 'white-time-forfeit', plies };
      }
      wtime += incMs;
    } else {
      btime = btime - res.elapsedMs;
      if (btime <= 0) {
        return { whiteScore: 1, reason: 'black-time-forfeit', plies };
      }
      btime += incMs;
    }

    const uci = res.bestMoveUci;
    if (!uci || uci === '0000' || uci.length < 4) {
      return { whiteScore: turn === 'w' ? 0 : 1, reason: 'resign-nomove', plies };
    }

    let applied = null;
    try {
      applied = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || undefined
      });
    } catch {
      applied = null;
    }

    if (!applied) {
      return { whiteScore: turn === 'w' ? 0 : 1, reason: `illegal-${uci}`, plies };
    }

    moveHistoryUci.push(uci);
    plies++;

    // Sound White-perspective score for adjudication
    const whitePerspectiveCp = turn === 'w' ? res.scoreCp : -res.scoreCp;

    if (plies >= 40) {
      if (whitePerspectiveCp >= 650) {
        winAdjWhiteCount++;
        winAdjBlackCount = 0;
      } else if (whitePerspectiveCp <= -650) {
        winAdjBlackCount++;
        winAdjWhiteCount = 0;
      } else {
        winAdjWhiteCount = 0;
        winAdjBlackCount = 0;
      }

      if (winAdjWhiteCount >= 5) {
        return { whiteScore: 1, reason: 'win-adjudication', plies };
      }
      if (winAdjBlackCount >= 5) {
        return { whiteScore: 0, reason: 'win-adjudication', plies };
      }
    }

    if (plies >= 110 && Math.abs(whitePerspectiveCp) <= 15) {
      drawAdjCount++;
      if (drawAdjCount >= 10) {
        return { whiteScore: 0.5, reason: 'draw-adjudication', plies };
      }
    } else {
      drawAdjCount = 0;
    }
  }

  return { whiteScore: 0.5, reason: 'max-plies-draw', plies };
}

async function runWorker() {
  const {
    candidatePath,
    baselinePath,
    candidateSearchMode,
    baselineSearchMode,
    hashMb,
    threads,
    baseMs,
    incMs,
    assignedPairs
  } = workerData;

  const candidate = new UciEngineProcess(candidatePath, candidateSearchMode, hashMb, threads);
  const baseline = new UciEngineProcess(baselinePath, baselineSearchMode, hashMb, threads);

  await candidate.start();
  await baseline.start();

  try {
    for (const pair of assignedPairs) {
      // Game 1: Candidate White vs Baseline Black
      const g1 = await playSingleGame({
        whiteEngine: candidate,
        blackEngine: baseline,
        startFen: pair.fen,
        baseMs,
        incMs
      });

      // Game 2: Baseline White vs Candidate Black (reversed colors, same opening)
      const g2 = await playSingleGame({
        whiteEngine: baseline,
        blackEngine: candidate,
        startFen: pair.fen,
        baseMs,
        incMs
      });

      const candG1 = g1.whiteScore;
      const candG2 = 1 - g2.whiteScore;

      parentPort.postMessage({
        type: 'pair-complete',
        pairIndex: pair.index,
        openingName: pair.name,
        game1Score: candG1,
        game2Score: candG2,
        game1Reason: g1.reason,
        game2Reason: g2.reason,
        game1Plies: g1.plies,
        game2Plies: g2.plies
      });
    }
  } finally {
    candidate.stop();
    baseline.stop();
  }
}

runWorker().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.stack || err.message });
  process.exit(1);
});
