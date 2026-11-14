import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DOWNLOADS_DIR = path.resolve('public/downloads');
const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f !== 'berserker-v0.4.0-release.json');

const items = files.map(file => {
  const fullPath = path.join(DOWNLOADS_DIR, file);
  const stat = fs.statSync(fullPath);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
  
  let formattedSize = '';
  if (stat.size >= 1024 * 1024) {
    formattedSize = (stat.size / (1024 * 1024)).toFixed(1) + ' MB';
  } else {
    formattedSize = (stat.size / 1024).toFixed(1) + ' KB';
  }

  return {
    fileName: file,
    sizeBytes: stat.size,
    sizeFormatted: formattedSize,
    sha256: hash,
    downloadUrl: `/downloads/${file}`
  };
});

items.sort((a, b) => a.fileName.localeCompare(b.fileName));

const manifest = {
  release: "Berserker v0.7.1-dev",
  version: "0.7.1-dev",
  author: "Berserker Engine Team",
  date: "2026-11-14",
  status: "Official Incremental Dev Release",
  features: [
    "Zero-Allocation TypedArray Evaluation & O(1) Bitwise Passed-Pawn / Structure Imbalances",
    "O(1) Native chess.hash() Zobrist Transposition Table Keys & 50-Move Halfmove Clock Propagation",
    "O(1) Static Exchange Evaluation (SEE) via chess.attackers() Without Cloning or Undo",
    "Quiescence Checkmate & Check-Evasion Search + Root-Safe FEN Digit Chess960 Castling Parser",
    "PVS-First (85% Budget) Hybrid-MCTS-PVS Time Control with Safe 10ms IPC Margin",
    "Threat-Space Prophylaxis (The Petrosian Patch - Preemptive Opponent Threat Denial)",
    "Multi-Threaded Parallel MCTS with Virtual Loss",
    "PV-Instability & Tactical Volatility Dynamic Time Manager",
    "Berserker NNUE Dual Policy-Value Head (HalfKAv2 Logits)",
    "Progressive SEE Pruning at Deep MCTS Tree Leaves (Depth >= 5)",
    "Syzygy Endgame Tablebase Direct MCTS Probing (3-6 Man Exact Resolutions)",
    "Dynamic Contempt & Tournament Must-Win Profiling",
    "Adaptive 4-Ply Leaf Quiescence Tactical Rollout (Q-Rollout)",
    "Dynamic Entropy-Driven c_puct Scaling & First Play Urgency (FPU)",
    "Subtree Reuse & Graph Transposition Grafting across Consecutive Turns",
    "Continuous Bayesian Dual Arbiter with Tactical Volatility Weighting",
    "Tactical Horizon Alpha-Beta Guardian with Automatic Blunder Override",
    "Correction History (CorrHist) with 16,384 Pawn & Non-Pawn Buckets",
    "Singular Extensions (SE) & Double Singular Extensions (+2 plies)",
    "Multi-Ply Continuation History (Conthist, 768x768) & Capture History",
    "Static Exchange Evaluation (SEE) Pruning",
    "ProbCut (Probability Cutoff) & Multi-Cut Subtree Pruning",
    "Expanded HalfKAv2-1536x2 & 2048x2 Neural Net Architecture (45.3 MB - 68.5 MB)",
    "16-Zone Spatial King Bucketing & 50-Move Rule Conversion Decay",
    "Dynamic MoE Neural Attention Router & Progressive Geometric Aspiration Windows",
    "Multi-Platform: Windows (AVX2/Modern/ARM64), Linux (AVX2/Modern/ARM64), macOS (Apple Silicon/Intel), Android"
  ],
  downloads: items
};

fs.writeFileSync(
  path.join(DOWNLOADS_DIR, 'berserker-v0.4.0-release.json'),
  JSON.stringify(manifest, null, 2)
);

console.log(`Updated release manifest with ${items.length} files.`);
console.log(JSON.stringify(items, null, 2));
