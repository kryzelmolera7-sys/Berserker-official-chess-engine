import React, { useState, useEffect, useCallback } from 'react';
import { 
  Terminal, 
  Code2, 
  Copy, 
  Check, 
  Cpu, 
  Zap, 
  Award,
  Database,
  GitBranch,
  Play,
  ExternalLink,
  RefreshCw,
  ShieldCheck
} from 'lucide-react';
import {
  BASELINE_V060_RELEASE_URL,
  type MatchResultPayload,
} from './engine/matchConfig';
import type { PentanomialStats, SprtResult } from './engine/eloStats';

interface LiveProgressPayload {
  running: boolean;
  completedPairs: number;
  totalPairs: number;
  threads: number;
  hashMb: number;
  timeControl: string;
  hardwareSummary: string;
  resultSummary: string;
  eloSummary: string;
  stats: PentanomialStats;
  sprt?: SprtResult;
  elapsedSec: number;
}

interface MatchApiResponse {
  running: boolean;
  error: string | null;
  hardware: {
    cpuCores: number;
    totalRamMb: number;
    defaultThreads: number;
    defaultHashMb: number;
  };
  liveProgress: LiveProgressPayload | null;
  latestResult: MatchResultPayload | null;
}

export const EngineCliGuide: React.FC = () => {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [matchApi, setMatchApi] = useState<MatchApiResponse | null>(null);
  const [isLoadingMatch, setIsLoadingMatch] = useState<boolean>(true);
  const [matchError, setMatchError] = useState<string | null>(null);

  const [selectedThreads, setSelectedThreads] = useState<number>(1);
  const [selectedHashMb, setSelectedHashMb] = useState<number>(64);
  const [selectedMinPairs, setSelectedMinPairs] = useState<number>(10);
  const [startingMatch, setStartingMatch] = useState<boolean>(false);

  const fetchMatchStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/engine/match/v060');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: MatchApiResponse = await resp.json();
      setMatchApi(data);
      if (data.error) setMatchError(data.error);
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : 'Unable to fetch match status');
    } finally {
      setIsLoadingMatch(false);
    }
  }, []);

  useEffect(() => {
    fetchMatchStatus();
  }, [fetchMatchStatus]);

  useEffect(() => {
    if (!matchApi?.running) return;
    const timer = setInterval(() => {
      fetchMatchStatus();
    }, 1500);
    return () => clearInterval(timer);
  }, [matchApi?.running, fetchMatchStatus]);

  const handleStartLiveMatch = async () => {
    setStartingMatch(true);
    setMatchError(null);
    try {
      const resp = await fetch('/api/engine/match/v060', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          minPairs: selectedMinPairs,
          pairs: Math.max(selectedMinPairs, 20),
          sprt: true,
          elo0: 0,
          elo1: 10,
          threads: selectedThreads,
          hashMb: selectedHashMb,
          baseMs: 2500,
          incMs: 150,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      await fetchMatchStatus();
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : 'Failed to start match');
    } finally {
      setStartingMatch(false);
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(id);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const activeData = matchApi?.running && matchApi.liveProgress ? matchApi.liveProgress : matchApi?.latestResult;
  const activeStats = activeData?.stats;
  const activeSprt = activeData?.sprt;
  const hostCores = matchApi?.hardware?.cpuCores ?? matchApi?.latestResult?.hostCpuCores ?? 4;
  const hostRamGb = ((matchApi?.hardware?.totalRamMb ?? matchApi?.latestResult?.hostTotalRamMb ?? 12288) / 1024).toFixed(1);
  const hwThreads = activeData?.threads ?? selectedThreads;
  const hwHashMb = activeData?.hashMb ?? selectedHashMb;

  const terminalRunSnippet = `# 1. Run Berserker v0.7.0 Native C++20 Engine directly via Terminal:
./bin/berserker-native

# Or run via Node.js WASM UCI bridge:
node berserker-cli.js

# Send standard UCI commands:
uci
setoption name Threads value ${hwThreads}
setoption name Hash value ${hwHashMb}
setoption name EvalFile value storage/nn-cache/nn-bddd9d57eb87.nnue
isready
position startpos moves e2e4 e7e5
eval
go wtime 2500 btime 2500 winc 150 binc 150
quit`;

  const matchCommandSnippet = `# Run 20-Game + Pentanomial SPRT UCI Match vs Berserker v0.6.0:
npx --yes tsx scripts/run_elo_match.ts --min-pairs 10 --pairs 20 --sprt true --elo0 0 --elo1 10 --threads 1 --hash 64 --workers 2 --base-ms 2500 --inc-ms 150`;

  const reportBlock =
    matchApi?.latestResult?.reportText ||
    (activeStats
      ? [
          `Elo   | ${activeStats.elo >= 0 ? '+' : ''}${activeStats.elo.toFixed(2)} +- ${activeStats.err95.toFixed(2)} (95%)`,
          activeSprt
            ? `SPRT  | LLR ${activeSprt.llr.toFixed(2)} (${activeSprt.lowerBound.toFixed(2)}, ${activeSprt.upperBound.toFixed(2)}) [${activeSprt.elo0.toFixed(2)}, ${activeSprt.elo1.toFixed(2)}] (${activeSprt.status})`
            : null,
          `Conf  | ${activeData?.timeControl || '2.5+0.15s'} Threads=${hwThreads} Hash=${hwHashMb}MB`,
          `Games | N: ${activeStats.games} W: ${activeStats.wins} L: ${activeStats.losses} D: ${activeStats.draws}`,
          `Penta | [${activeStats.penta.join(', ')}]`,
          BASELINE_V060_RELEASE_URL,
        ]
          .filter(Boolean)
          .join('\n')
      : '# Run a match above or execute scripts/run_elo_match.ts to generate live v0.7.0 NNUE vs v0.6.0 telemetry.');

  const selfPlayBakeSnippet = `# 1. Generate autonomous self-play games and automatically bake datasets:
node scripts/generate_and_bake.js --games 100 --depth 5 --movetime 120 --outdir ./data

# Outputs generated automatically:
# - data/training_data.plain   (Marlinformat: FEN | eval | wdl)
# - data/training_data.bin     (Binary packed HalfKP features)
# - data/training_games.pgn    (Annotated tournament PGN database)
# - data/dataset_summary.json  (Game statistics & WDL breakdown)

# 2. Train HalfKP NNUE locally with PyTorch:
python scripts/train_nnue.py --data data/training_data.plain --epochs 10 --output berserker_dual_net_ep9_b400.nnue`;

  const workflowYamlSnippet = `name: Train Berserker v0.2.0 NNUE

on:
  workflow_dispatch:
    inputs:
      data_source:
        description: 'Training data source: "leela" (Leela Chess Zero MCTS self-play) or "selfplay" (Berserker autonomous games)'
        required: true
        default: 'leela'
        type: choice
        options:
          - leela
          - selfplay
      dataset_size:
        description: 'Number of positions/games to prepare (e.g. 5000, 20000, 100000)'
        required: true
        default: '10000'
        type: string
      epochs:
        description: 'Number of NNUE training epochs'
        required: true
        default: '10'
        type: string
      learning_rate:
        description: 'Optimizer learning rate'
        required: true
        default: '0.001'
        type: string
      trainer_engine:
        description: 'Training framework: "stockfish-nnue-pytorch" or "berserker-native"'
        required: true
        default: 'stockfish-nnue-pytorch'
        type: choice
        options:
          - stockfish-nnue-pytorch
          - berserker-native
      save_to_repo:
        description: 'Automatically commit and push the updated .nnue file back to GitHub'
        required: true
        default: true
        type: boolean

permissions:
  contents: write

jobs:
  train-nnue:
    name: Train Berserker NNUE (Leela / Stockfish nnue-pytorch)
    runs-on: ubuntu-latest
    timeout-minutes: 180

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4
        with:
          token: \${{ secrets.GITHUB_TOKEN }}
          fetch-depth: 1

      - name: Setup Node.js Environment
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Setup Python Environment
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install Dependencies
        run: |
          echo "📦 Installing Node dependencies..."
          npm install --no-package-lock --legacy-peer-deps || true
          
          echo "🐍 Installing PyTorch and Chess training libraries..."
          python -m pip install --upgrade pip
          pip install torch numpy chess tqdm pytorch-lightning

      - name: Prepare Training Data (Leela Lc0 or Self-Play)
        run: |
          mkdir -p data
          if [ "\${{ github.event.inputs.data_source }}" = "selfplay" ]; then
            echo "⚔️ Generating autonomous self-play games with Berserker v0.2.0..."
            node scripts/generate_and_bake.js \\
              --games 100 \\
              --depth 4 \\
              --movetime 100 \\
              --outdir ./data
          else
            echo "♟️ Downloading and formatting Leela Chess Zero (Lc0) dataset..."
            python scripts/download_leela_data.py \\
              --games \${{ github.event.inputs.dataset_size || '10000' }} \\
              --outdir ./data
          fi
          ls -lh ./data/

      - name: Train with Official Stockfish nnue-pytorch
        if: \${{ github.event.inputs.trainer_engine == 'stockfish-nnue-pytorch' }}
        run: |
          echo "⚡ Setting up Stockfish's official nnue-pytorch trainer from upstream repository..."
          git clone --depth 1 https://github.com/official-stockfish/nnue-pytorch.git stockfish_trainer
          cd stockfish_trainer
          pip install -r requirements.txt || true

          echo "🔥 Running official Stockfish train.py on HalfKP feature set..."
          python train.py \\
            ../data/training_data.bin \\
            ../data/training_data.bin \\
            --features="HalfKP" \\
            --default_net_name="berserker_dual_net" \\
            --max_epoch=\${{ github.event.inputs.epochs || '10' }} \\
            --lr=\${{ github.event.inputs.learning_rate || '0.001' }} \\
            --batch-size=4096 || (cd .. && python scripts/train_nnue.py --data data/training_data.plain --epochs \${{ github.event.inputs.epochs || '10' }} --output berserker_dual_net_ep9_b400.nnue && cd stockfish_trainer)

          echo "📦 Serializing trained model into binary .nnue format via serialize.py..."
          if [ -d "checkpoints" ] && [ $(ls -1 checkpoints/*.pt 2>/dev/null | wc -l) -gt 0 ]; then
            LATEST_CKPT=$(ls -t checkpoints/*.pt | head -n 1)
            echo "Converting checkpoint: $LATEST_CKPT"
            python serialize.py "$LATEST_CKPT" ../berserker_dual_net_ep9_b400.nnue --features="HalfKP"
          fi
          cd ..

      - name: Train with Berserker Native Trainer
        if: \${{ github.event.inputs.trainer_engine == 'berserker-native' }}
        run: |
          echo "🧠 Training with Native Berserker PyTorch trainer..."
          python scripts/train_nnue.py \\
            --data data/training_data.plain \\
            --epochs \${{ github.event.inputs.epochs || '10' }} \\
            --lr \${{ github.event.inputs.learning_rate || '0.001' }} \\
            --output berserker_dual_net_ep9_b400.nnue

      - name: Save NNUE into Berserker Engine Paths
        run: |
          echo "💾 Saving trained network into Berserker's default neural directories..."
          mkdir -p public storage
          cp -vf berserker_dual_net_ep9_b400.nnue public/berserker_dual_net_ep9_b400.nnue || true
          cp -vf berserker_dual_net_ep9_b400.nnue storage/berserker_dual_net_ep9_b400.nnue || true
          ls -lh berserker_dual_net_ep9_b400.nnue

      - name: Verify Engine UCI Evaluation with Trained Net
        run: |
          echo "🔍 Testing Berserker v0.2.0 evaluation using new .nnue file..."
          node berserker-cli.js << 'EOF'
          uci
          isready
          position startpos
          eval
          go depth 3 movetime 300
          quit
          EOF

      - name: Upload Trained NNUE as Artifact
        uses: actions/upload-artifact@v4
        with:
          name: berserker-v0.2.0-trained-nnue
          path: |
            berserker_dual_net_ep9_b400.nnue
            data/dataset_summary.json
            data/training_games.pgn
            data/training_data.bin
          retention-days: 90

      - name: Commit and Push Trained .nnue into Repository
        if: \${{ github.event.inputs.save_to_repo != 'false' }}
        run: |
          echo "🚀 Committing updated .nnue file back into Berserker repository..."
          git config --local user.name "github-actions[bot]"
          git config --local user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add berserker_dual_net_ep9_b400.nnue public/berserker_dual_net_ep9_b400.nnue data/dataset_summary.json 2>/dev/null || true
          git commit -m "chore(nnue): train from Leela games & update berserker_dual_net_ep9_b400.nnue [skip ci]" || echo "No changes to commit"
          git push origin HEAD || echo "Push step finished"`;

  const importTsSnippet = `import { searchBestMove, evaluatePosition } from './berserker-cli.js';
import { Chess } from 'chess.js';

const chess = new Chess();
const evalCp = evaluatePosition(chess);
const result = searchBestMove(chess, 10, 1500);
console.log('NNUE Eval:', evalCp, 'cp | Best:', result.bestMoveUci);`;

  const cppSnippet = `# Compile native C++20 Lazy SMP UCI binary:
npm run build:native

# Run native engine (auto-loads 138.4 MB nn-bddd9d57eb87.nnue):
./bin/berserker-native`;

  return (
    <div className="max-w-5xl mx-auto p-4 lg:p-6 space-y-6">
      {/* Top Match & Hardware Banner */}
      <div className="bg-gradient-to-r from-purple-950/70 via-slate-900 to-indigo-950/50 border border-purple-500/30 rounded-2xl p-6 shadow-2xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-md bg-purple-500/20 text-purple-300 font-mono text-xs font-bold border border-purple-500/40 uppercase">
                Berserker v0.7.0 (138.4 MB NNUE) vs v0.6.0
              </span>
              {activeSprt && (
                <span
                  className={`px-2.5 py-0.5 rounded-md font-mono text-xs font-bold border ${
                    activeSprt.status === 'H1_ACCEPTED'
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : activeSprt.status === 'H0_ACCEPTED'
                      ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                      : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                  }`}
                >
                  SPRT {activeSprt.status} • LLR {activeSprt.llr.toFixed(2)} ({activeSprt.lowerBound.toFixed(2)}, {activeSprt.upperBound.toFixed(2)})
                </span>
              )}
            </div>

            <h2 className="text-2xl font-black tracking-tight text-white">
              Pentanomial + SPRT Head-to-Head Match vs Berserker v0.6.0
            </h2>
            <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
              Live UCI match comparing <code className="text-purple-300 font-mono">Berserker v0.7.0</code> (C++20 Pure-PVS + auto-loaded <code className="text-emerald-300 font-mono">nn-bddd9d57eb87.nnue</code>) against the older{' '}
              <a
                href={BASELINE_V060_RELEASE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-300 hover:text-cyan-200 underline inline-flex items-center gap-1 font-mono text-xs"
              >
                Berserker v0.6.0 Release
                <ExternalLink className="w-3 h-3" />
              </a>
              .
            </p>
          </div>

          <button
            type="button"
            onClick={fetchMatchStatus}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono flex items-center gap-1.5 border border-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${matchApi?.running ? 'animate-spin text-amber-400' : ''}`} />
            <span>Refresh Telemetry</span>
          </button>
        </div>

        {/* Hardware, Results & Elo Gain Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-4 border-t border-slate-800/80">
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-1">
            <span className="text-[11px] text-slate-400 uppercase font-mono font-semibold block">
              Hardware Configuration
            </span>
            <span className="text-lg font-bold text-cyan-300 font-mono block" data-testid="match-hardware">
              {hwThreads} {hwThreads === 1 ? 'Thread' : 'Threads'} | {hwHashMb} MB Hash
            </span>
            <span className="text-xs text-slate-400 block">
              Host: {hostCores} vCPU Cores • {hostRamGb} GiB RAM
            </span>
            <span className="text-xs font-mono text-slate-500 mt-1 block">
              TC: {activeData?.timeControl || '2.5+0.15s'}
            </span>
          </div>

          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-1">
            <span className="text-[11px] text-slate-400 uppercase font-mono font-semibold block">
              Match Results (N | W | L | D)
            </span>
            {isLoadingMatch ? (
              <span className="text-sm font-mono text-slate-400 block">Loading match data...</span>
            ) : activeStats ? (
              <>
                <span className="text-lg font-bold text-white font-mono block" data-testid="match-results">
                  N: {activeStats.games} | W: {activeStats.wins} | L: {activeStats.losses}
                </span>
                <span className="text-xs text-slate-400 font-mono block">
                  D: {activeStats.draws} • Penta: [{activeStats.penta.join(', ')}]
                </span>
                <span className="text-xs font-mono font-bold text-emerald-400 mt-1 block">
                  Score: {(activeStats.scoreRate * 100).toFixed(1)}%
                </span>
              </>
            ) : (
              <span className="text-sm font-mono text-slate-400 block">No match recorded yet</span>
            )}
          </div>

          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-1">
            <span className="text-[11px] text-slate-400 uppercase font-mono font-semibold block">
              Elo Gain &amp; SPRT Status
            </span>
            {activeStats ? (
              <>
                <span className="text-lg font-bold text-emerald-400 font-mono block" data-testid="match-elo">
                  {activeStats.elo >= 0 ? '+' : ''}
                  {activeStats.elo.toFixed(2)} +- {activeStats.err95.toFixed(2)} Elo
                </span>
                <span className="text-xs text-slate-300 font-mono block">
                  LOS: {(activeStats.los * 100).toFixed(2)}% (95% CI)
                </span>
                <span className="text-xs font-mono text-purple-300 mt-1 block">
                  {activeSprt
                    ? `LLR ${activeSprt.llr.toFixed(2)} [${activeSprt.elo0.toFixed(0)}, ${activeSprt.elo1.toFixed(0)}] • ${activeSprt.status}`
                    : 'Fixed Pair Suite'}
                </span>
              </>
            ) : (
              <span className="text-sm font-mono text-slate-400 block">Ready to run</span>
            )}
          </div>
        </div>

        {/* Interactive 20-Game + SPRT Launcher */}
        <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5 text-slate-300 font-mono">
              <span>Min Games:</span>
              <select
                value={selectedMinPairs}
                onChange={(e) => setSelectedMinPairs(Number(e.target.value))}
                disabled={Boolean(matchApi?.running)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-white"
              >
                <option value={10}>20 games (10 pairs) + SPRT</option>
                <option value={4}>8 games (4 pairs) + SPRT</option>
                <option value={15}>30 games (15 pairs) + SPRT</option>
              </select>
            </label>

            <label className="flex items-center gap-1.5 text-slate-300 font-mono">
              <span>Threads:</span>
              <select
                value={selectedThreads}
                onChange={(e) => setSelectedThreads(Number(e.target.value))}
                disabled={Boolean(matchApi?.running)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-white"
              >
                <option value={1}>1 Thread</option>
                <option value={2}>2 Threads</option>
                <option value={4}>4 Threads</option>
                <option value={8}>8 Threads</option>
                <option value={16}>16 Threads</option>
                <option value={32}>32 Threads</option>
                <option value={64}>64 Threads</option>
                <option value={128}>128 Threads</option>
                <option value={192}>192 Threads</option>
              </select>
            </label>

            <label className="flex items-center gap-1.5 text-slate-300 font-mono">
              <span>Hash:</span>
              <select
                value={selectedHashMb}
                onChange={(e) => setSelectedHashMb(Number(e.target.value))}
                disabled={Boolean(matchApi?.running)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-white"
              >
                <option value={16}>16 MB</option>
                <option value={64}>64 MB</option>
                <option value={128}>128 MB</option>
                <option value={256}>256 MB</option>
                <option value={512}>512 MB</option>
                <option value={1024}>1024 MB (1 GB)</option>
                <option value={4096}>4096 MB (4 GB)</option>
                <option value={16384}>16384 MB (16 GB)</option>
                <option value={32768}>32768 MB (32 GB)</option>
              </select>
            </label>
          </div>

          <button
            type="button"
            onClick={handleStartLiveMatch}
            disabled={startingMatch || Boolean(matchApi?.running)}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white text-xs font-bold flex items-center gap-2 transition"
          >
            {matchApi?.running ? (
              <>
                <Zap className="w-3.5 h-3.5 animate-pulse" />
                <span>
                  Running ({matchApi.liveProgress?.stats?.games ?? 0} games played)...
                </span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>Run 20-Game + SPRT Match vs v0.6.0</span>
              </>
            )}
          </button>
        </div>

        {matchError && (
          <div className="text-xs font-mono text-rose-300 bg-rose-950/50 border border-rose-500/40 rounded-lg px-3 py-2">
            Match notice: {matchError}
          </div>
        )}
      </div>

      {/* OpenBench / Reckless Copyable Match Report */}
      <div className="bg-slate-900 border border-purple-500/40 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <h3 className="text-lg font-extrabold text-white flex items-center gap-2">
              <Award className="w-5 h-5 text-purple-400" />
              OpenBench / Reckless Pentanomial SPRT Report
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Measured results generated by <code className="text-purple-300 font-mono">scripts/run_elo_match.ts</code>
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleCopy('report', `${reportBlock}\n\n${matchCommandSnippet}`)}
            className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-mono text-xs transition flex items-center gap-2 font-bold"
          >
            {copiedSection === 'report' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copiedSection === 'report' ? 'Copied Report!' : 'Copy Match Report'}
          </button>
        </div>

        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-emerald-300 overflow-x-auto leading-relaxed">
          {reportBlock}
        </pre>

        <div className="bg-slate-950 rounded-xl border border-slate-800 p-3 font-mono text-xs text-slate-300 flex flex-wrap items-center justify-between gap-2">
          <span className="truncate">{matchCommandSnippet}</span>
          <span className="text-slate-500 flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            Pure-PVS vs v0.6.0
          </span>
        </div>
      </div>

      {/* GitHub Actions Workflow (.yaml) Code Section */}
      <div className="bg-slate-900 border border-purple-500/40 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-purple-400" />
              GitHub Actions Workflow (.github/workflows/train_nnue.yml)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Paste this into <code className="text-purple-300 font-mono">.github/workflows/train_nnue.yml</code> to run automated self-play, baking, PyTorch training, and auto-saving into Berserker's NNUE
            </p>
          </div>
          <button
            onClick={() => handleCopy('workflow', workflowYamlSnippet)}
            className="px-3.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-mono text-xs transition flex items-center gap-1.5 font-bold shadow-md shadow-purple-600/20"
          >
            {copiedSection === 'workflow' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedSection === 'workflow' ? 'Copied YAML!' : 'Copy Workflow YAML'}
          </button>
        </div>

        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-purple-300 overflow-x-auto leading-relaxed max-h-[380px]">
          {workflowYamlSnippet}
        </pre>
      </div>

      {/* Self-Play Generator & Auto-Baking Snippet */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-400" />
              Autonomous Self-Play & Auto-Baking Pipeline
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Generates self-play games from master openings and bakes plain, binary, and PGN datasets automatically
            </p>
          </div>
          <button
            onClick={() => handleCopy('selfplay', selfPlayBakeSnippet)}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-xs transition flex items-center gap-1.5 border border-slate-700"
          >
            {copiedSection === 'selfplay' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedSection === 'selfplay' ? 'Copied' : 'Copy Commands'}
          </button>
        </div>

        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-emerald-300 overflow-x-auto leading-relaxed">
          {selfPlayBakeSnippet}
        </pre>
      </div>

      {/* CLI Snippet */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Terminal className="w-4 h-4 text-purple-400" />
              Run Berserker v0.7.0 Standalone UCI Engine via CLI
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Execute Berserker directly from your terminal or hook it into CuteChess / Arena / Banksia / Fritz
            </p>
          </div>
          <button
            onClick={() => handleCopy('cli', terminalRunSnippet)}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-xs transition flex items-center gap-1.5 border border-slate-700"
          >
            {copiedSection === 'cli' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedSection === 'cli' ? 'Copied' : 'Copy Command'}
          </button>
        </div>

        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-purple-300 overflow-x-auto leading-relaxed">
          {terminalRunSnippet}
        </pre>
      </div>

      {/* Programmatic Import Snippet */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Code2 className="w-4 h-4 text-cyan-400" />
              Import Engine in Node.js / TypeScript Projects
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Call searchBestMove or evaluatePosition directly in your custom chess tools
            </p>
          </div>
          <button
            onClick={() => handleCopy('ts', importTsSnippet)}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-xs transition flex items-center gap-1.5 border border-slate-700"
          >
            {copiedSection === 'ts' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedSection === 'ts' ? 'Copied' : 'Copy Code'}
          </button>
        </div>

        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-cyan-300 overflow-x-auto leading-relaxed">
          {importTsSnippet}
        </pre>
      </div>

      {/* C++ Standalone Engine */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Cpu className="w-4 h-4 text-amber-400" />
              Compile Native C++20 Lazy SMP Engine
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Native binary built from <code className="text-amber-300">src/engine/cpp/berserker.cpp</code>
            </p>
          </div>
          <button
            onClick={() => handleCopy('cpp', cppSnippet)}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-xs transition flex items-center gap-1.5 border border-slate-700"
          >
            {copiedSection === 'cpp' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedSection === 'cpp' ? 'Copied' : 'Copy Command'}
          </button>
        </div>

        <pre className="p-4 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-amber-300 overflow-x-auto leading-relaxed">
          {cppSnippet}
        </pre>
      </div>
    </div>
  );
};
