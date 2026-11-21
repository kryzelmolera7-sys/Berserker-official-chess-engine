export type PentanomialCounts = [number, number, number, number, number];

export interface PairMatchOutcome {
  /** Game 1: candidate plays White, baseline plays Black (1 = candidate win, 0.5 = draw, 0 = candidate loss) */
  game1Score: 0 | 0.5 | 1;
  /** Game 2: candidate plays Black, baseline plays White (1 = candidate win, 0.5 = draw, 0 = candidate loss) */
  game2Score: 0 | 0.5 | 1;
}

export interface PentanomialStats {
  pairs: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  penta: PentanomialCounts;
  scoreRate: number;
  elo: number;
  err95: number;
  los: number;
}

export interface SprtParams {
  elo0?: number;
  elo1?: number;
  alpha?: number;
  beta?: number;
}

export interface SprtResult {
  elo0: number;
  elo1: number;
  alpha: number;
  beta: number;
  llr: number;
  lowerBound: number;
  upperBound: number;
  status: 'RUNNING' | 'H1_ACCEPTED' | 'H0_ACCEPTED';
}

export interface RecklessReportOptions {
  stats: PentanomialStats;
  timeControl: string;
  threads: number;
  hashMb: number;
  sprt?: SprtResult;
  referenceUrl?: string;
}

const PAIR_SCORES = [0.0, 0.25, 0.5, 0.75, 1.0] as const;
const Z_95 = 1.959963984540054;
const P_CLAMP_MIN = 0.0005;
const P_CLAMP_MAX = 0.9995;

function clampProbability(p: number): number {
  return Math.max(P_CLAMP_MIN, Math.min(P_CLAMP_MAX, p));
}

export function probabilityToElo(p: number): number {
  const clamped = clampProbability(p);
  return -400 * Math.log10(1 / clamped - 1);
}

export function eloToProbability(elo: number): number {
  return 1 / (1 + Math.pow(10, -elo / 400));
}

function erfApprox(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t) *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Computes OpenBench / Reckless-compatible pentanomial Elo, 95% confidence interval, and LOS.
 * Penta buckets follow [LL, LD, WL/DD, WD, WW] from candidate engine perspective.
 */
export function computePentanomialStats(
  penta: PentanomialCounts,
  explicitWld?: { wins: number; losses: number; draws: number }
): PentanomialStats {
  const [c0, c1, c2, c3, c4] = penta;
  const pairs = c0 + c1 + c2 + c3 + c4;
  const games = pairs * 2;

  if (pairs === 0) {
    return {
      pairs: 0,
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      penta: [0, 0, 0, 0, 0],
      scoreRate: 0.5,
      elo: 0,
      err95: 0,
      los: 0.5,
    };
  }

  let sumScores = 0;
  for (let i = 0; i < 5; i++) {
    sumScores += penta[i] * PAIR_SCORES[i];
  }
  const mu = sumScores / pairs;

  let varianceSum = 0;
  for (let i = 0; i < 5; i++) {
    const diff = PAIR_SCORES[i] - mu;
    varianceSum += penta[i] * diff * diff;
  }
  const variance = varianceSum / pairs;
  const se = Math.sqrt(Math.max(1e-12, variance / pairs));

  const elo = probabilityToElo(mu);
  const eloHigh = probabilityToElo(mu + Z_95 * se);
  const eloLow = probabilityToElo(mu - Z_95 * se);
  const err95 = (eloHigh - eloLow) / 2;

  const zStat = (mu - 0.5) / se;
  const los = 0.5 * (1 + erfApprox(zStat / Math.SQRT2));

  // If explicit WLD is not given, approximate DD vs WL split from middle bucket as pure draws
  // so W - L matches exact pentanomial net score.
  const wins = explicitWld ? explicitWld.wins : c4 * 2 + c3;
  const losses = explicitWld ? explicitWld.losses : c0 * 2 + c1;
  const draws = explicitWld ? explicitWld.draws : c1 + c2 * 2 + c3;

  return {
    pairs,
    games,
    wins,
    losses,
    draws,
    penta: [c0, c1, c2, c3, c4],
    scoreRate: mu,
    elo,
    err95,
    los,
  };
}

/**
 * Aggregates pair outcomes (each opening played twice with swapped colors)
 * into pentanomial counts and exact W/L/D statistics.
 */
export function summarizePairOutcomes(outcomes: PairMatchOutcome[]): PentanomialStats {
  const penta: PentanomialCounts = [0, 0, 0, 0, 0];
  let wins = 0;
  let losses = 0;
  let draws = 0;

  for (const pair of outcomes) {
    const g1 = pair.game1Score;
    const g2 = pair.game2Score;

    if (g1 === 1) wins++;
    else if (g1 === 0) losses++;
    else draws++;

    if (g2 === 1) wins++;
    else if (g2 === 0) losses++;
    else draws++;

    const pairTotal = g1 + g2; // 0, 0.5, 1, 1.5, or 2
    const bucketIdx = Math.round(pairTotal * 2) as 0 | 1 | 2 | 3 | 4;
    penta[bucketIdx]++;
  }

  return computePentanomialStats(penta, { wins, losses, draws });
}

export function computePentanomialSprt(
  stats: Pick<PentanomialStats, 'pairs' | 'penta' | 'scoreRate'>,
  params: SprtParams = {}
): SprtResult {
  const elo0 = params.elo0 ?? 0.0;
  const elo1 = params.elo1 ?? 10.0;
  const alpha = params.alpha ?? 0.05;
  const beta = params.beta ?? 0.05;

  const lowerBound = Math.log(beta / (1 - alpha));
  const upperBound = Math.log((1 - beta) / alpha);

  if (stats.pairs <= 0) {
    return {
      elo0,
      elo1,
      alpha,
      beta,
      llr: 0,
      lowerBound,
      upperBound,
      status: 'RUNNING',
    };
  }

  const mu0 = eloToProbability(elo0);
  const mu1 = eloToProbability(elo1);
  const muHat = stats.scoreRate;

  let varSum = 0;
  for (let i = 0; i < 5; i++) {
    const diff = PAIR_SCORES[i] - muHat;
    varSum += stats.penta[i] * diff * diff;
  }
  // Regularize variance gently so clean sweeps remain finite
  const rawVar = varSum / stats.pairs;
  const variance = Math.max(rawVar, 1 / (8 * (stats.pairs + 1)));

  const d0 = muHat - mu0;
  const d1 = muHat - mu1;
  const llr = (stats.pairs / (2 * variance)) * (d0 * d0 - d1 * d1);

  let status: SprtResult['status'] = 'RUNNING';
  if (llr >= upperBound) status = 'H1_ACCEPTED';
  else if (llr <= lowerBound) status = 'H0_ACCEPTED';

  return {
    elo0,
    elo1,
    alpha,
    beta,
    llr,
    lowerBound,
    upperBound,
    status,
  };
}

/**
 * Formats pentanomial results into standard OpenBench / Reckless text output:
 * Elo   | 12.11 +- 2.55 (95%)
 * SPRT  | LLR 2.95 (-2.94, 2.94) [0.00, 10.00]
 * Conf  | 8.0+0.08s Threads=1 Hash=16MB
 * Games | N: 20012 W: 5555 L: 4858 D: 9599
 * Penta | [89, 2108, 4926, 2783, 100]
 */
export function formatRecklessReport(options: RecklessReportOptions): string {
  const { stats, timeControl, threads, hashMb, sprt, referenceUrl } = options;
  const lines = [
    `Elo   | ${stats.elo.toFixed(2)} +- ${stats.err95.toFixed(2)} (95%)`,
  ];
  if (sprt) {
    lines.push(
      `SPRT  | LLR ${sprt.llr.toFixed(2)} (${sprt.lowerBound.toFixed(2)}, ${sprt.upperBound.toFixed(2)}) [${sprt.elo0.toFixed(2)}, ${sprt.elo1.toFixed(2)}] (${sprt.status})`
    );
  }
  lines.push(
    `Conf  | ${timeControl} Threads=${threads} Hash=${hashMb}MB`,
    `Games | N: ${stats.games} W: ${stats.wins} L: ${stats.losses} D: ${stats.draws}`,
    `Penta | [${stats.penta.join(', ')}]`
  );
  if (referenceUrl) {
    lines.push(referenceUrl);
  }
  return lines.join('\n');
}
