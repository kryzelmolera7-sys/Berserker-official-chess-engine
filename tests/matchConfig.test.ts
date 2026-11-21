import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASELINE_V060_RELEASE_URL,
  MATCH_OPENING_BOOK,
  clampMatchRunOptions,
  formatMatchHardwareSummary,
  formatMatchResultSummary,
  formatEloGainSummary,
  tallyTerminations,
} from '../src/engine/matchConfig';
import { summarizePairOutcomes } from '../src/engine/eloStats';

test('matchConfig: formats hardware, N|W|L|D results, and Elo gain cleanly', () => {
  assert.equal(formatMatchHardwareSummary(1, 64), '1 Thread | 64 MB Hash');
  assert.equal(formatMatchHardwareSummary(4, 128), '4 Threads | 128 MB Hash');

  const stats = summarizePairOutcomes([
    { game1Score: 1, game2Score: 1 },
    { game1Score: 1, game2Score: 0.5 },
    { game1Score: 1, game2Score: 1 },
  ]);

  assert.equal(formatMatchResultSummary(stats), 'N: 6 | W: 5 | L: 0 | D: 1');
  const eloLine = formatEloGainSummary(stats);
  assert.ok(eloLine.startsWith('+'), `Expected positive Elo summary, got: ${eloLine}`);
  assert.ok(eloLine.includes('Elo (95%)'));
  assert.ok(eloLine.includes('LOS'));
});

test('matchConfig: clamps match options and tallies game terminations accurately', () => {
  const clamped = clampMatchRunOptions({ pairs: 99, threads: 16, hashMb: 4, baseMs: 200, incMs: 5000 }, 4);
  assert.equal(clamped.pairs, 30);
  assert.equal(clamped.threads, 4);
  assert.equal(clamped.hashMb, 16);
  assert.equal(clamped.baseMs, 1000);
  assert.equal(clamped.incMs, 2000);

  const terms = tallyTerminations([
    { game1Reason: 'checkmate', game2Reason: 'win-adjudication' },
    { game1Reason: 'checkmate', game2Reason: 'draw-rule' },
  ]);
  assert.deepEqual(terms, { checkmate: 2, 'win-adjudication': 1, 'draw-rule': 1 });
  assert.ok(MATCH_OPENING_BOOK.length >= 20);
  assert.equal(
    BASELINE_V060_RELEASE_URL,
    'https://github.com/kryzelmolera7-sys/Berserker-official-chess-engine/releases/tag/v0.6.0'
  );
});
