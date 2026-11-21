import type { PentanomialStats, SprtResult } from './eloStats';

export const BASELINE_V060_RELEASE_URL =
  'https://github.com/kryzelmolera7-sys/Berserker-official-chess-engine/releases/tag/v0.6.0';

export const V070_VS_V060_RESULTS_FILE = 'data/v070_nnue_vs_v060_match_results.json';

export interface OpeningEntry {
  name: string;
  fen: string;
}

export const MATCH_OPENING_BOOK: OpeningEntry[] = [
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
];

export interface MatchRunOptions {
  pairs: number;
  minPairs?: number;
  sprt?: boolean;
  elo0?: number;
  elo1?: number;
  threads: number;
  hashMb: number;
  baseMs: number;
  incMs: number;
}

export interface MatchPairDetail {
  pairIndex: number;
  openingName: string;
  game1Score: 0 | 0.5 | 1;
  game2Score: 0 | 0.5 | 1;
  game1Reason: string;
  game2Reason: string;
  game1Plies: number;
  game2Plies: number;
}

export interface MatchResultPayload {
  candidate: string;
  baseline: string;
  baselineUrl: string;
  nnueFile: string;
  nnueBytes: number;
  timeControl: string;
  threads: number;
  hashMb: number;
  workers: number;
  hostCpuCores: number;
  hostTotalRamMb: number;
  elapsedSec: number;
  hardwareSummary: string;
  resultSummary: string;
  eloSummary: string;
  reportText: string;
  stats: PentanomialStats;
  sprt?: SprtResult;
  terminations: Record<string, number>;
  pairs: MatchPairDetail[];
}

export function clampMatchRunOptions(
  input: Partial<MatchRunOptions>,
  maxCpuCores = 4
): MatchRunOptions {
  const pairs = Math.max(1, Math.min(30, Math.round(Number(input.pairs ?? 30)) || 30));
  const minPairs = Math.max(1, Math.min(pairs, Math.round(Number(input.minPairs ?? 10)) || 10));
  const sprt = input.sprt !== false;
  const elo0 = Number.isFinite(Number(input.elo0)) ? Number(input.elo0) : 0;
  const elo1 = Number.isFinite(Number(input.elo1)) ? Number(input.elo1) : 10;
  const threads = Math.max(1, Math.min(Math.max(1, maxCpuCores), Math.round(Number(input.threads ?? 1)) || 1));
  const hashMb = Math.max(16, Math.min(1024, Math.round(Number(input.hashMb ?? 64)) || 64));
  const baseMs = Math.max(1000, Math.min(30000, Math.round(Number(input.baseMs ?? 2500)) || 2500));
  const incMs = Math.max(50, Math.min(2000, Math.round(Number(input.incMs ?? 150)) || 150));
  return { pairs, minPairs, sprt, elo0, elo1, threads, hashMb, baseMs, incMs };
}

export function formatMatchHardwareSummary(threads: number, hashMb: number): string {
  return `${threads} ${threads === 1 ? 'Thread' : 'Threads'} | ${hashMb} MB Hash`;
}

export function formatMatchResultSummary(stats: Pick<PentanomialStats, 'games' | 'wins' | 'losses' | 'draws'>): string {
  return `N: ${stats.games} | W: ${stats.wins} | L: ${stats.losses} | D: ${stats.draws}`;
}

export function formatEloGainSummary(stats: Pick<PentanomialStats, 'elo' | 'err95' | 'los' | 'scoreRate'>): string {
  const sign = stats.elo >= 0 ? '+' : '';
  return `${sign}${stats.elo.toFixed(2)} +- ${stats.err95.toFixed(2)} Elo (95%) | Score ${(stats.scoreRate * 100).toFixed(1)}% | LOS ${(stats.los * 100).toFixed(2)}%`;
}

export function tallyTerminations(pairs: Pick<MatchPairDetail, 'game1Reason' | 'game2Reason'>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const pair of pairs) {
    counts[pair.game1Reason] = (counts[pair.game1Reason] || 0) + 1;
    counts[pair.game2Reason] = (counts[pair.game2Reason] || 0) + 1;
  }
  return counts;
}
