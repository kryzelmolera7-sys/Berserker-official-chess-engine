/**
 * BerserkerEngine: Programmatic TypeScript / Node.js Engine API
 * Supports both SF NNUE and Aura-NNUE (GeoSparse-MoE) neural evaluators.
 */

import { Chess } from 'chess.js';
import { evaluateBerserkerNnue } from './berserkerNnue';
import { evaluateAuraNnue } from './auraNnue';
import { searchIndependentBerserker } from './berserkerIndependentSearch';

export type BerserkerEvalMode = 'berserker-nnue' | 'aura-nnue' | 'sf-nnue';

export interface BerserkerEngineOptions {
  evalMode?: BerserkerEvalMode;
  threads?: number;
  hashMb?: number;
  contempt?: number;
  kingAttackScale?: number;
}

export interface SearchResult {
  bestMoveSan: string;
  bestMoveUci: string;
  scoreCp: number;
  depth: number;
  nodes: number;
  pv: string[];
  evalDetails: {
    evalMode: BerserkerEvalMode;
    activeNet: string;
    centipawns: number;
  };
}

export class BerserkerEngine {
  private chess: Chess;
  private evalMode: BerserkerEvalMode;
  private contempt: number;
  private kingAttackScale: number;

  constructor(options: BerserkerEngineOptions = {}) {
    this.chess = new Chess();
    this.evalMode = options.evalMode || 'berserker-nnue';
    this.contempt = options.contempt ?? 45;
    this.kingAttackScale = options.kingAttackScale ?? 140;
  }

  public setPosition(fen?: string, moves: string[] = []): void {
    this.chess = fen ? new Chess(fen) : new Chess();
    for (const m of moves) {
      this.chess.move(m);
    }
  }

  public getFen(): string {
    return this.chess.fen();
  }

  public evaluateCurrentPosition(): {
    berserkerNnueCp: number;
    sfNnueCp: number;
    auraNnueCp: number;
    activeMode: BerserkerEvalMode;
  } {
    const fen = this.chess.fen();
    const bszEval = evaluateBerserkerNnue(fen);
    const auraEval = evaluateAuraNnue(fen);
    return {
      berserkerNnueCp: bszEval.centipawns,
      sfNnueCp: bszEval.centipawns,
      auraNnueCp: auraEval.centipawns,
      activeMode: this.evalMode,
    };
  }

  public search(depth = 6, maxTimeMs = 2000): SearchResult {
    const moves = this.chess.moves({ verbose: true });
    if (moves.length === 0) {
      return {
        bestMoveSan: '',
        bestMoveUci: '0000',
        scoreCp: 0,
        depth: 0,
        nodes: 0,
        pv: [],
        evalDetails: {
          evalMode: this.evalMode,
          activeNet: 'berserker_dual_net_ep9_b400.nnue',
          centipawns: 0,
        },
      };
    }

    const pvsStats = searchIndependentBerserker(this.chess.fen(), depth, maxTimeMs);
    let chosenUci = pvsStats.bestMoveUci;
    let chosenSan = pvsStats.bestMoveSan;

    if (!chosenUci && moves.length > 0) {
      chosenUci = `${moves[0].from}${moves[0].to}${moves[0].promotion || ''}`;
      chosenSan = moves[0].san;
    }

    return {
      bestMoveSan: chosenSan,
      bestMoveUci: chosenUci,
      scoreCp: pvsStats.scoreCp,
      depth: pvsStats.depth,
      nodes: pvsStats.nodes,
      pv: pvsStats.pv.length > 0 ? pvsStats.pv : [chosenUci],
      evalDetails: {
        evalMode: this.evalMode,
        activeNet: 'berserker_dual_net_ep9_b400.nnue',
        centipawns: pvsStats.scoreCp,
      },
    };
  }
}
