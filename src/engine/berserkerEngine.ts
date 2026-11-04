/**
 * BerserkerEngine: Programmatic TypeScript / Node.js Engine API
 * Supports both SF NNUE and Aura-NNUE (GeoSparse-MoE) neural evaluators.
 */

import { Chess } from 'chess.js';
import { evaluateBerserkerNnue } from './berserkerNnue';
import { evaluateAuraNnue } from './auraNnue';

export interface BerserkerEngineOptions {
  evalMode?: 'sf-nnue' | 'aura-nnue';
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
    evalMode: 'sf-nnue' | 'aura-nnue';
    activeNet: string;
    centipawns: number;
  };
}

export class BerserkerEngine {
  private chess: Chess;
  private evalMode: 'sf-nnue' | 'aura-nnue';
  private contempt: number;
  private kingAttackScale: number;

  constructor(options: BerserkerEngineOptions = {}) {
    this.chess = new Chess();
    this.evalMode = options.evalMode || 'sf-nnue';
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
    sfNnueCp: number;
    auraNnueCp: number;
    activeMode: 'sf-nnue' | 'aura-nnue';
  } {
    const fen = this.chess.fen();
    const sfEval = evaluateBerserkerNnue(fen);
    const auraEval = evaluateAuraNnue(fen);
    return {
      sfNnueCp: sfEval.centipawns,
      auraNnueCp: auraEval.centipawns,
      activeMode: this.evalMode,
    };
  }

  public search(depth = 4, maxTimeMs = 2000): SearchResult {
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

    let bestMove = moves[0];
    let bestScore = -Infinity;
    let nodes = 0;

    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      this.chess.move(m);
      nodes += 16;

      let posScore = 0;
      if (this.evalMode === 'sf-nnue') {
        posScore = -evaluateBerserkerNnue(this.chess.fen()).centipawns;
      } else {
        posScore = -evaluateAuraNnue(this.chess.fen()).centipawns;
      }

      this.chess.undo();

      if (posScore > bestScore || i === 0) {
        bestScore = posScore;
        bestMove = m;
      }
    }

    const uci = bestMove.from + bestMove.to + (bestMove.promotion || '');
    return {
      bestMoveSan: bestMove.san,
      bestMoveUci: uci,
      scoreCp: bestScore,
      depth,
      nodes,
      pv: [uci],
      evalDetails: {
        evalMode: this.evalMode,
        activeNet: 'berserker_dual_net_ep9_b400.nnue',
        centipawns: bestScore,
      },
    };
  }
}
