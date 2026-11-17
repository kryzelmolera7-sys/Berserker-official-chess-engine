/**
 * Berserker C++20 WebAssembly Engine Web Worker
 *
 * Loads:
 *   - /berserker-engine.wasm (native C++20 SIMD Pure-PVS engine)
 *   - /nnue/v60-7f587dfb.nnue (63 MB Reckless quantized NNUE evaluation network)
 *
 * Processes UCI commands asynchronously without blocking the worker message queue
 * so `stop`, `position`, and `quit` respond immediately.
 */

/* global self, WebAssembly, TextEncoder, TextDecoder, fetch, performance */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let wasmExp = null;
let wasmMemory = null;
let cmdPtr = 0;
let cmdMax = 0;
let nnueReady = false;
let nnueBytesLoaded = 0;

let isStepping = false;
let stepTimer = null;
const commandQueue = [];
let drainingQueue = false;

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
  if (stepTimer !== null) {
    clearTimeout(stepTimer);
    stepTimer = null;
  }
  wasmExp.wasm_stop();
  try {
    // Finishes current step and emits final bestmove matching pv[0]
    wasmExp.wasm_search_step();
  } catch (err) {
    self.postMessage('info string WASM stop error: ' + String(err));
  }
  isStepping = false;
}

function scheduleNextStep() {
  if (!isStepping || !wasmExp) return;
  stepTimer = setTimeout(runStepSlice, 0);
}

function runStepSlice() {
  stepTimer = null;
  if (!isStepping || !wasmExp) return;

  const sliceStart = performance.now();
  try {
    while (isStepping) {
      const cont = wasmExp.wasm_search_step() !== 0;
      if (!cont) {
        isStepping = false;
        break;
      }
      // Run rapid shallow plies together (~4ms max) so UI gets responsive updates
      // while depth >= 5 yields back to the event loop between iterations for `stop`.
      if (performance.now() - sliceStart >= 4) {
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
      const buf = await resp.arrayBuffer();
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
  wasmExp.wasm_init();
  return wasmExp;
}

const nnueFetchPromise = (async () => {
  try {
    const resp = await fetch('/nnue/v60-7f587dfb.nnue');
    if (!resp.ok) {
      self.postMessage('info string NNUE download failed HTTP ' + resp.status + '; using fallback PST');
      return false;
    }
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  } catch (err) {
    self.postMessage('info string NNUE download unavailable: ' + String(err));
    return null;
  }
})();

const wasmBootPromise = instantiateWasm();

const fullNnueBootPromise = Promise.all([wasmBootPromise, nnueFetchPromise]).then(([, nnueBytes]) => {
  if (!wasmExp || !(nnueBytes instanceof Uint8Array)) return false;
  const maxBytes = wasmExp.wasm_get_nnue_max_bytes();
  if (nnueBytes.byteLength >= maxBytes - 32) {
    const ptr = wasmExp.wasm_get_nnue_ptr();
    const copyLen = Math.min(nnueBytes.byteLength, maxBytes);
    new Uint8Array(wasmMemory.buffer, ptr, copyLen).set(nnueBytes.subarray(0, copyLen));
    const ok = wasmExp.wasm_init_nnue(copyLen) !== 0;
    nnueReady = ok;
    nnueBytesLoaded = ok ? copyLen : 0;
    return ok;
  }
  return false;
});

async function drainCommandQueue() {
  if (drainingQueue) return;
  drainingQueue = true;

  try {
    await wasmBootPromise;

    while (commandQueue.length > 0 && !isStepping) {
      const line = commandQueue.shift();
      if (!line) continue;

      const cmd = line.split(/\s+/)[0];

      if (cmd === 'isready') {
        await fullNnueBootPromise;
        if (nnueReady) {
          self.postMessage('info string NNUE loaded: v60-7f587dfb.nnue (' + nnueBytesLoaded + ' bytes)');
        }
        const len = writeCmdToWasm('isready');
        wasmExp.wasm_exec_uci(len);
        continue;
      }

      if (cmd === 'quit') {
        stopCurrentSearchSynchronously();
        self.close();
        return;
      }

      if (cmd === 'go' || cmd === 'eval') {
        await fullNnueBootPromise;
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
