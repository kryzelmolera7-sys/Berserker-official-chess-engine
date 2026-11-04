import React, { useState, useEffect } from 'react';
import { 
  X, 
  Cloud, 
  Copy, 
  Check, 
  RotateCw, 
  Trophy, 
  Cpu, 
  User, 
  Clock, 
  FileText,
  ExternalLink,
  ShieldCheck,
  Flame
} from 'lucide-react';
import { GameCloudRecord, fetchRecentGames } from './firebaseService';

interface CloudGamesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadGameFen?: (fen: string) => void;
}

export const CloudGamesModal: React.FC<CloudGamesModalProps> = ({
  isOpen,
  onClose,
  onLoadGameFen
}) => {
  const [games, setGames] = useState<GameCloudRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedGame, setSelectedGame] = useState<GameCloudRecord | null>(null);

  const loadGames = async () => {
    setIsLoading(true);
    try {
      const records = await fetchRecentGames(30);
      setGames(records);
    } catch (e) {
      console.warn('Failed to fetch recent cloud games', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadGames();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCopyPgn = (gameId: string, pgn: string) => {
    navigator.clipboard.writeText(pgn);
    setCopiedId(gameId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-4xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <Cloud className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-white">Berserker Cloud Game Archive</h3>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                  LEVEL 2 CLOUD PERSISTENCE
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Synchronized PGN records from Berserker 18 matches stored in Firestore
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={loadGames}
              disabled={isLoading}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition border border-slate-700 disabled:opacity-50"
              title="Refresh cloud archive"
            >
              <RotateCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-amber-400' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition border border-slate-700"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {isLoading && games.length === 0 ? (
            <div className="py-16 text-center space-y-3">
              <RotateCw className="w-8 h-8 text-amber-400 animate-spin mx-auto" />
              <p className="text-sm text-slate-400 font-mono">Fetching saved games from Cloud Firestore...</p>
            </div>
          ) : games.length === 0 ? (
            <div className="py-16 text-center space-y-3 bg-slate-950/40 rounded-xl border border-slate-800/80 p-8">
              <Cloud className="w-10 h-10 text-slate-600 mx-auto" />
              <h4 className="text-base font-semibold text-slate-200">No cloud games saved yet</h4>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Play a game in <span className="text-amber-400 font-medium">Play vs Berserker</span> or run a match in <span className="text-amber-400 font-medium">Sandbox Duel</span>. When any match concludes, its full PGN and parameters are automatically archived here!
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {games.map((g, idx) => {
                const isSelected = selectedGame?.id === g.id;
                const formattedDate = g.createdAt 
                  ? new Date(g.createdAt).toLocaleString(undefined, { 
                      month: 'short', 
                      day: 'numeric', 
                      hour: '2-digit', 
                      minute: '2-digit' 
                    })
                  : 'Recent Game';

                return (
                  <div
                    key={g.id || idx}
                    className={`bg-slate-950/80 border rounded-xl p-4 transition-all space-y-3 ${
                      isSelected 
                        ? 'border-amber-500/60 shadow-lg shadow-amber-500/10' 
                        : 'border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    {/* Top Row: Mode & Result */}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 flex items-center gap-1.5">
                        {g.gameMode === 'PlayVsEngine' ? <User className="w-3 h-3 text-cyan-400" /> : <Cpu className="w-3 h-3 text-purple-400" />}
                        {g.gameMode}
                      </span>
                      
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-mono font-extrabold px-2 py-0.5 rounded ${
                          g.result === '1-0' 
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : g.result === '0-1'
                            ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                            : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                        }`}>
                          {g.result}
                        </span>
                        <span className="text-[10px] text-slate-500 font-mono">
                          {formattedDate}
                        </span>
                      </div>
                    </div>

                    {/* Matchup Description */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs font-medium">
                        <span className="text-slate-200 flex items-center gap-1.5 truncate">
                          <span className="w-2.5 h-2.5 rounded-full bg-slate-100 border border-slate-400 shrink-0" />
                          <span className="truncate">{g.whiteEngine}</span>
                        </span>
                        <span className="text-[11px] text-slate-400 shrink-0">vs</span>
                        <span className="text-slate-200 flex items-center gap-1.5 truncate">
                          <span className="w-2.5 h-2.5 rounded-full bg-slate-800 border border-slate-600 shrink-0" />
                          <span className="truncate">{g.blackEngine}</span>
                        </span>
                      </div>
                      {g.reason && (
                        <p className="text-[11px] text-slate-400 italic truncate">
                          {g.reason} ({g.movesCount} plies)
                        </p>
                      )}
                    </div>

                    {/* PGN Snippet Preview */}
                    <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800 text-[11px] font-mono text-slate-400 line-clamp-2 select-all overflow-hidden">
                      {g.pgn || '1. e4 e5 ...'}
                    </div>

                    {/* Action Bar */}
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-[10px] text-slate-500 font-mono">
                        {g.movesCount} total moves
                      </span>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleCopyPgn(g.id || `${idx}`, g.pgn)}
                          className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 flex items-center gap-1.5 border border-slate-700 transition"
                        >
                          {copiedId === (g.id || `${idx}`) ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span className="text-emerald-400">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3 text-slate-400" />
                              <span>Copy PGN</span>
                            </>
                          )}
                        </button>
                        
                        {onLoadGameFen && g.fen && (
                          <button
                            onClick={() => {
                              onLoadGameFen(g.fen);
                              onClose();
                            }}
                            className="px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 text-xs font-medium border border-amber-500/30 transition flex items-center gap-1"
                          >
                            <ExternalLink className="w-3 h-3" />
                            Load FEN
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Connected to Firebase Firestore ({games.length} games archived)</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-medium transition"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
};
