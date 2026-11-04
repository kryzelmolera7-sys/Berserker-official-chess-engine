import { Chess } from 'chess.js';

export interface TablebaseMove {
  uci: string;
  san: string;
  wdl: number; // 2: Win, 1: Cursed win, 0: Draw, -1: Blessed loss, -2: Loss
  dtz: number | null;
  dtm: number | null;
  category: 'win' | 'draw' | 'loss' | 'unknown';
}

export interface TablebaseResult {
  isTablebasePosition: boolean;
  pieceCount: number;
  category: 'win' | 'draw' | 'loss' | 'unknown';
  wdl: number;
  dtz: number | null;
  dtm: number | null;
  bestMoveUci: string | null;
  bestMoveSan: string | null;
  evalText: string;
  moves: TablebaseMove[];
}

// In-memory cache for fast instant lookups during searches
const tablebaseCache = new Map<string, TablebaseResult>();

/**
 * Counts total pieces on the board from a FEN string.
 * Syzygy tablebases cover all positions with <= 7 pieces.
 */
export function countPieces(fen: string): number {
  const piecePlacement = fen.split(' ')[0];
  let count = 0;
  for (const ch of piecePlacement) {
    if (/[pnbrqkPNBRQK]/.test(ch)) {
      count++;
    }
  }
  return count;
}

/**
 * Probes the Syzygy 7-piece endgame tablebase for a given position.
 * Returns null if pieceCount > 7 or if offline without reachable network.
 */
export async function probeTablebase(fen: string): Promise<TablebaseResult | null> {
  const pieceCount = countPieces(fen);
  if (pieceCount > 7) {
    return null;
  }

  // Check cache first
  const cleanFen = fen.trim();
  if (tablebaseCache.has(cleanFen)) {
    return tablebaseCache.get(cleanFen)!;
  }

  const encodedFen = encodeURIComponent(cleanFen);
  const endpoints = [
    `/api/tablebase/standard?fen=${encodedFen}`,
    `https://tablebase.lichess.ovh/standard?fen=${encodedFen}`
  ];

  for (const url of endpoints) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      clearTimeout(timeoutId);

      if (!response.ok) continue;

      const data = await response.json();
      if (!data || !Array.isArray(data.moves) || data.moves.length === 0) continue;

      // Moves in Lichess tablebase response are already sorted by optimal WDL/DTZ.
      // Top move is the theoretical best move.
      const topMove = data.moves[0];
      const category: 'win' | 'draw' | 'loss' | 'unknown' = data.category || 'unknown';
      const wdl: number = typeof data.wdl === 'number' ? data.wdl : 0;
      const dtz: number | null = typeof data.dtz === 'number' ? data.dtz : null;
      const dtm: number | null = typeof data.dtm === 'number' ? data.dtm : null;

      let evalText = 'Theoretical Draw';
      if (category === 'win') {
        evalText = dtm ? `Theoretical Win (Mate in ${Math.abs(dtm)})` : (dtz ? `Theoretical Win (DTZ ${Math.abs(dtz)})` : 'Theoretical Win');
      } else if (category === 'loss') {
        evalText = dtm ? `Theoretical Loss (Mate in ${Math.abs(dtm)})` : (dtz ? `Theoretical Loss (DTZ ${Math.abs(dtz)})` : 'Theoretical Loss');
      }

      // Convert UCI to SAN using chess.js if san is not provided
      let bestMoveSan = topMove.san;
      if (!bestMoveSan && topMove.uci) {
        try {
          const temp = new Chess(cleanFen);
          const from = topMove.uci.slice(0, 2);
          const to = topMove.uci.slice(2, 4);
          const promotion = topMove.uci[4] || undefined;
          const mv = temp.move({ from, to, promotion });
          if (mv) bestMoveSan = mv.san;
        } catch {
          bestMoveSan = topMove.uci;
        }
      }

      const result: TablebaseResult = {
        isTablebasePosition: true,
        pieceCount,
        category,
        wdl,
        dtz,
        dtm,
        bestMoveUci: topMove.uci || null,
        bestMoveSan: bestMoveSan || topMove.uci || null,
        evalText,
        moves: data.moves.map((m: any) => ({
          uci: m.uci,
          san: m.san,
          wdl: m.wdl,
          dtz: m.dtz,
          dtm: m.dtm,
          category: m.category || 'unknown'
        }))
      };

      tablebaseCache.set(cleanFen, result);
      return result;
    } catch {
      // Try next endpoint fallback
    }
  }

  return null;
}
