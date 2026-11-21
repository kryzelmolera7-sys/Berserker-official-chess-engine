import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePentanomialStats,
  computePentanomialSprt,
  summarizePairOutcomes,
  formatRecklessReport,
} from '../src/engine/eloStats';

test('eloStats: matches OpenBench/Reckless pentanomial reference calculation [89, 2108, 4926, 2783, 100]', () => {
  const stats = computePentanomialStats([89, 2108, 4926, 2783, 100], {
    wins: 5555,
    losses: 4858,
    draws: 9599,
  });

  assert.equal(stats.games, 20012);
  assert.equal(stats.pairs, 10006);
  assert.equal(stats.elo.toFixed(2), '12.11');
  assert.equal(stats.err95.toFixed(2), '2.55');
  assert.ok(stats.los > 0.99, `Expected LOS > 0.99, got ${stats.los}`);

  const formatted = formatRecklessReport({
    stats,
    timeControl: '8.0+0.08s',
    threads: 1,
    hashMb: 16,
    referenceUrl: 'https://recklesschess.space/test/14135/',
  });

  assert.equal(
    formatted,
    [
      'Elo   | 12.11 +- 2.55 (95%)',
      'Conf  | 8.0+0.08s Threads=1 Hash=16MB',
      'Games | N: 20012 W: 5555 L: 4858 D: 9599',
      'Penta | [89, 2108, 4926, 2783, 100]',
      'https://recklesschess.space/test/14135/',
    ].join('\n')
  );
});

test('eloStats: aggregates paired game outcomes accurately into pentanomial buckets', () => {
  const stats = summarizePairOutcomes([
    { game1Score: 1, game2Score: 1 },     // WW
    { game1Score: 1, game2Score: 0.5 },   // WD
    { game1Score: 0.5, game2Score: 0.5 }, // DD
    { game1Score: 1, game2Score: 0 },     // WL
    { game1Score: 0, game2Score: 0.5 },   // LD
    { game1Score: 0, game2Score: 0 },     // LL
  ]);

  assert.equal(stats.pairs, 6);
  assert.equal(stats.games, 12);
  assert.equal(stats.wins, 4);
  assert.equal(stats.losses, 4);
  assert.equal(stats.draws, 4);
  assert.deepEqual(stats.penta, [1, 1, 2, 1, 1]);
  assert.equal(stats.elo.toFixed(2), '0.00');
});

test('eloStats: handles empty and 100% sweep outcomes without NaN', () => {
  const empty = computePentanomialStats([0, 0, 0, 0, 0]);
  assert.equal(empty.games, 0);
  assert.equal(empty.elo, 0);

  const sweep = summarizePairOutcomes([
    { game1Score: 1, game2Score: 1 },
    { game1Score: 1, game2Score: 1 },
    { game1Score: 1, game2Score: 1 },
  ]);
  assert.equal(sweep.games, 6);
  assert.ok(Number.isFinite(sweep.elo) && sweep.elo > 500);
  assert.ok(Number.isFinite(sweep.err95));
});

test('eloStats: Pentanomial SPRT passes H1 on decisive positive score and fails H0 on negative score', () => {
  const tenPairStats = computePentanomialStats([0, 0, 1, 1, 8]); // 10 pairs = 20 games
  const tenPairRunning = computePentanomialSprt(tenPairStats, { elo0: 0, elo1: 10 });
  assert.equal(tenPairRunning.status, 'RUNNING');
  assert.ok(tenPairRunning.llr > 2.0 && tenPairRunning.llr < tenPairRunning.upperBound);

  const passStats = computePentanomialStats([0, 0, 1, 1, 13]); // 15 pairs = 30 games
  const passSprt = computePentanomialSprt(passStats, { elo0: 0, elo1: 10 });
  assert.equal(passSprt.status, 'H1_ACCEPTED');
  assert.ok(passSprt.llr >= passSprt.upperBound);

  const failStats = computePentanomialStats([20, 10, 5, 1, 0]);
  const failSprt = computePentanomialSprt(failStats, { elo0: 0, elo1: 10 });
  assert.equal(failSprt.status, 'H0_ACCEPTED');
  assert.ok(failSprt.llr <= failSprt.lowerBound);
});
