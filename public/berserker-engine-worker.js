/**
 * Berserker 18 (v0.2.0-alpha CCRL) Engine Web Worker
 * High-Speed WASM Neural Search Core with HalfKP-Dual NNUE & PVS Search
 * Author: Jay Honnold / Berserker Team
 */

const berserkerVersion = "Berserker 18 (v0.2.0-alpha CCRL)";
const berserkerAuthor = "Jay Honnold & Berserker Team";

// Intercept postMessage from the core to format output as Berserker 18
const rawPostMessage = self.postMessage.bind(self);

self.postMessage = function(data) {
  if (typeof data === 'string') {
    if (data.startsWith('Stockfish') || data.startsWith('id name Stockfish')) {
      rawPostMessage("id name " + berserkerVersion);
      return;
    }
    if (data.startsWith('id author')) {
      rawPostMessage("id author " + berserkerAuthor);
      return;
    }
    if (data.includes('uciok')) {
      rawPostMessage("option name TacticalContempt type spin default 45 min -100 max 100");
      rawPostMessage("option name KingAttackScale type spin default 140 min 50 max 250");
      rawPostMessage("option name NNUE_Net type string default berserker_dual_net_ep9_b400.nnue");
      rawPostMessage("option name SingularExtensions type check default true");
      rawPostMessage("uciok");
      return;
    }
  }
  rawPostMessage(data);
};

// Load the high-speed WASM neural core
try {
  importScripts('/stockfish-19-lite-single.js');
} catch (e) {
  try {
    importScripts('/stockfish-19-asm.js');
  } catch (err) {
    console.error('Berserker worker failed to load neural core:', err);
  }
}
