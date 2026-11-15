import readline from 'node:readline';
import {
  searchIndependentBerserker,
  clearIndependentSearchState,
  setFixTtOrigAlpha,
} from '../src/engine/berserkerIndependentSearch';

const fixFlag = process.env.BERSERKER_FIX_TT_FLAG !== '0';
setFixTtOrigAlpha(fixFlag);

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    if (msg.cmd === 'newgame') {
      clearIndependentSearchState();
      process.stdout.write(JSON.stringify({ ok: true }) + '\n');
    } else if (msg.cmd === 'go') {
      const res = searchIndependentBerserker(msg.fen, msg.depth ?? 8, msg.timeMs ?? 120, 1);
      process.stdout.write(
        JSON.stringify({
          uci: res.bestMoveUci,
          san: res.bestMoveSan,
          scoreCp: res.scoreCp,
          nodes: res.nodes,
          qnodes: res.qnodes,
          seldepth: res.seldepth,
          ttHits: res.ttHits,
          timeMs: res.timeMs,
          nps: res.nps,
        }) + '\n'
      );
    } else if (msg.cmd === 'quit') {
      process.exit(0);
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String(err) }) + '\n');
  }
});
