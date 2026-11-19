/**
 * Berserker C++20 WebAssembly Engine Web Worker
 *
 * Loads:
 *   1. /berserker-engine.wasm (~120 KB C++20 SIMD128 Pure-PVS engine, no huge embedded weights)
 *   2. Automatic NNUE Loader for nn-bddd9d57eb87.nnue (138,360,528 bytes):
 *      - IndexedDB cache hit (<150ms instant reload on repeat visits)
 *      - Direct Raw Download Link: https://media.githubusercontent.com/media/official-stockfish/networks/master/nn-bddd9d57eb87.nnue
 *      - GitHub Raw Redirect:     https://github.com/official-stockfish/networks/raw/master/nn-bddd9d57eb87.nnue
 *      - Same-Origin Auto Cache:  /api/nnue/nn-bddd9d57eb87.nnue
 *
 * Uses MessageChannel zero-delay scheduling + 16ms time slices so `stop`,
 * `position`, and `quit` respond promptly without 4ms setTimeout clamping.
 */

/* global self, WebAssembly, TextEncoder, TextDecoder, fetch, performance, MessageChannel, indexedDB */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const NNUE_FILE = 'nn-bddd9d57eb87.nnue';
const NNUE_EXPECTED_BYTES = 138360528;
const NNUE_CDN_DOWNLOAD_URL =
  'https://media.githubusercontent.com/media/official-stockfish/networks/master/nn-bddd9d57eb87.nnue';
const NNUE_RAW_DOWNLOAD_URL =
  'https://github.com/official-stockfish/networks/raw/master/nn-bddd9d57eb87.nnue';
const NNUE_AUTO_SOURCES = [
  NNUE_CDN_DOWNLOAD_URL,
  NNUE_RAW_DOWNLOAD_URL,
  '/api/nnue/nn-bddd9d57eb87.nnue',
];

const IDB_NAME = 'berserker-nnue-cache';
const IDB_STORE = 'networks';

let wasmExp = null;
let wasmMemory = null;
let cmdPtr = 0;
let cmdMax = 0;
let nnuePtr = 0;
let nnueMaxBytes = 0;
let nnueReady = false;

let isStepping = false;
let stepPending = false;
const commandQueue = [];
let drainingQueue = false;

const stepChannel = new MessageChannel();
stepChannel.port1.onmessage = () => {
  stepPending = false;
  runStepSlice();
};

function openNnueCacheDb() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readCachedNnue() {
  try {
    const db = await openNnueCacheDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(NNUE_FILE);
        req.onsuccess = () => {
          const val = req.result;
          db.close();
          if (val instanceof ArrayBuffer && val.byteLength === NNUE_EXPECTED_BYTES) {
            resolve(val);
          } else {
            resolve(null);
          }
        };
        req.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        db.close();
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

async function writeCachedNnue(buffer) {
  try {
    const db = await openNnueCacheDb();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const req = store.put(buffer, NNUE_FILE);
        req.onsuccess = () => {
          db.close();
          resolve(true);
        };
        req.onerror = () => {
          db.close();
          resolve(false);
        };
      } catch {
        db.close();
        resolve(false);
      }
    });
  } catch {
    // Ignore IDB quota/privacy mode errors gracefully
  }
}

function writeCmdToWasm(text) {
  const encoded = encoder.encode(text);
  const len = Math.min(encoded.byteLength, cmdMax - 1);
  const view = new Uint8Array(wasmMemory.buffer, cmdPtr, cmdMax);
  view.set(encoded.subarray(0, len), 0);
  view[len] = 0;
  return len;
}

function stopCurrentSearchSynchronously() {
  if (!isStepping || !wasmExp) return;
  isStepping = false;
  stepPending = false;
  wasmExp.wasm_stop();
  try {
    // Finishes current step and emits final bestmove matching completed pv[0]
    wasmExp.wasm_search_step();
  } catch (err) {
    self.postMessage('info string WASM stop error: ' + String(err));
  }
}

function scheduleNextStep() {
  if (!isStepping || !wasmExp || stepPending) return;
  stepPending = true;
  stepChannel.port2.postMessage(null);
}

function runStepSlice() {
  if (!isStepping || !wasmExp) return;

  const sliceStart = performance.now();
  try {
    while (isStepping) {
      const cont = wasmExp.wasm_search_step() !== 0;
      if (!cont) {
        isStepping = false;
        break;
      }
      // Run iterative slices for ~16ms before yielding to process `stop` messages
      if (performance.now() - sliceStart >= 16) {
        break;
      }
    }
  } catch (err) {
    isStepping = false;
    self.postMessage('info string WASM search fault: ' + String(err));
    self.postMessage('bestmove 0000');
  }

  if (isStepping) {
    scheduleNextStep();
  } else {
    drainCommandQueue();
  }
}

async function instantiateWasm() {
  const imports = {
    env: {
      js_uci_out(ptr, len) {
        if (!wasmMemory || len <= 0) return;
        const slice = new Uint8Array(wasmMemory.buffer, ptr, len);
        self.postMessage(decoder.decode(slice));
      },
      js_now_ms() {
        return performance.now();
      },
    },
  };

  let instance;
  try {
    if (typeof WebAssembly.instantiateStreaming === 'function') {
      const resp = fetch('/berserker-engine.wasm');
      try {
        const streamed = await WebAssembly.instantiateStreaming(resp, imports);
        instance = streamed.instance;
      } catch {
        const fallbackResp = await fetch('/berserker-engine.wasm');
        if (!fallbackResp.ok) throw new Error('HTTP ' + fallbackResp.status + ' loading /berserker-engine.wasm');
        const buf = await fallbackResp.arrayBuffer();
        const result = await WebAssembly.instantiate(buf, imports);
        instance = result.instance;
      }
    } else {
      const resp = await fetch('/berserker-engine.wasm');
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' loading /berserker-engine.wasm');
      const buf = await fallbackResp.arrayBuffer();
      const result = await WebAssembly.instantiate(buf, imports);
      instance = result.instance;
    }
  } catch (err) {
    self.postMessage('info string Failed to load /berserker-engine.wasm: ' + String(err));
    throw err;
  }

  wasmExp = instance.exports;
  wasmMemory = wasmExp.memory;
  cmdPtr = wasmExp.wasm_get_cmd_buf();
  cmdMax = wasmExp.wasm_get_cmd_buf_size();
  nnuePtr = wasmExp.wasm_get_nnue_ptr();
  nnueMaxBytes = wasmExp.wasm_get_nnue_max_bytes();
  wasmExp.wasm_init();
  return wasmExp;
}

const wasmBootPromise = instantiateWasm();

async function autoLoadNnue() {
  await wasmBootPromise;
  if (wasmExp.wasm_is_nnue_loaded() !== 0) {
    nnueReady = true;
    return true;
  }

  // 1. Fast IndexedDB cache check
  const cached = await readCachedNnue();
  if (cached && cached.byteLength === NNUE_EXPECTED_BYTES && nnueMaxBytes >= NNUE_EXPECTED_BYTES) {
    new Uint8Array(wasmMemory.buffer, nnuePtr, NNUE_EXPECTED_BYTES).set(new Uint8Array(cached));
    if (wasmExp.wasm_init_nnue(NNUE_EXPECTED_BYTES) === 1) {
      nnueReady = true;
      self.postMessage('info string NNUE download: 100% (132.0/132.0 MB cached)');
      self.postMessage(`info string NNUE loaded: ${NNUE_FILE} (${NNUE_EXPECTED_BYTES} bytes cached)`);
      return true;
    }
  }

  // 2. Automatic streaming download from direct raw URLs -> local cache fallback
  for (const url of NNUE_AUTO_SOURCES) {
    try {
      self.postMessage(`info string NNUE auto-loader fetching: ${url}`);
      const resp = await fetch(url);
      if (!resp.ok || !resp.body) {
        self.postMessage(`info string NNUE source HTTP ${resp.status}, trying fallback...`);
        continue;
      }

      const clHeader = resp.headers.get('content-length');
      if (clHeader) {
        const expectedLen = parseInt(clHeader, 10);
        if (expectedLen > 0 && expectedLen !== NNUE_EXPECTED_BYTES) {
          self.postMessage(`info string NNUE size mismatch (${expectedLen}), trying fallback...`);
          continue;
        }
      }

      const reader = resp.body.getReader();
      let offset = 0;
      let lastPct = -1;
      const totalMb = (NNUE_EXPECTED_BYTES / (1024 * 1024)).toFixed(1);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (offset + value.byteLength > nnueMaxBytes) {
          throw new Error('NNUE download overflowed WASM buffer');
        }
        new Uint8Array(wasmMemory.buffer, nnuePtr, NNUE_EXPECTED_BYTES).set(value, offset);
        offset += value.byteLength;

        const pct = Math.min(100, Math.floor((offset * 100) / NNUE_EXPECTED_BYTES));
        if (pct >= lastPct + 5 || pct === 100) {
          lastPct = pct;
          const loadedMb = (offset / (1024 * 1024)).toFixed(1);
          self.postMessage(`info string NNUE download: ${pct}% (${loadedMb}/${totalMb} MB)`);
        }
      }

      if (offset !== NNUE_EXPECTED_BYTES) {
        self.postMessage(`info string Incomplete NNUE download (${offset}/${NNUE_EXPECTED_BYTES} bytes), retrying fallback...`);
        continue;
      }

      if (wasmExp.wasm_init_nnue(NNUE_EXPECTED_BYTES) === 1) {
        nnueReady = true;
        self.postMessage(`info string NNUE loaded: ${NNUE_FILE} (${NNUE_EXPECTED_BYTES} bytes auto-loaded)`);
        // Persist in IndexedDB asynchronously for instant future reloads
        const copyForCache = new Uint8Array(wasmMemory.buffer, nnuePtr, NNUE_EXPECTED_BYTES).slice().buffer;
        writeCachedNnue(copyForCache);
        return true;
      }
    } catch (err) {
      self.postMessage(`info string NNUE fetch warning (${url}): ${String(err)}`);
    }
  }

  self.postMessage('info string ERROR: Automatic NNUE loader failed from all raw sources');
  return false;
}

const nnueBootPromise = autoLoadNnue();

async function drainCommandQueue() {
  if (drainingQueue) return;
  drainingQueue = true;

  try {
    await wasmBootPromise;

    while (commandQueue.length > 0 && !isStepping) {
      const line = commandQueue.shift();
      if (!line) continue;

      const cmd = line.split(/\s+/)[0];

      if (cmd === 'quit') {
        stopCurrentSearchSynchronously();
        self.close();
        return;
      }

      // Ensure automatic NNUE weights are loaded before isready / eval / go / bench
      if (!nnueReady && cmd !== 'uci' && cmd !== 'setoption') {
        await nnueBootPromise;
      }

      const len = writeCmdToWasm(line);
      const startedSearch = wasmExp.wasm_exec_uci(len) !== 0;
      if (startedSearch) {
        isStepping = true;
        runStepSlice();
        if (isStepping) break;
      }
    }
  } finally {
    drainingQueue = false;
  }
}

self.onmessage = function (event) {
  const line = (typeof event.data === 'string' ? event.data : '').trim();
  if (!line) return;

  const cmd = line.split(/\s+/)[0];

  if (cmd === 'stop') {
    if (isStepping) {
      stopCurrentSearchSynchronously();
      drainCommandQueue();
    } else if (wasmExp) {
      wasmExp.wasm_stop();
    }
    return;
  }

  if (cmd === 'quit') {
    commandQueue.length = 0;
    stopCurrentSearchSynchronously();
    self.close();
    return;
  }

  // If a new `position` or `go` arrives while still stepping, abort cleanly first
  if (isStepping && (cmd === 'position' || cmd === 'go' || cmd === 'ucinewgame')) {
    stopCurrentSearchSynchronously();
  }

  commandQueue.push(line);
  drainCommandQueue();
};
