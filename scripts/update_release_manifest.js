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
  release: "Berserker v0.4.0",
  version: "0.4.0",
  author: "Berserker Engine Team",
  date: "2026-11-06",
  status: "Official Stable Multi-Platform Release",
  features: [
    "Hybrid MCTS-PVS Dual Arbiter (PUCT Policy Guidance + Tactical Safety Net)",
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
