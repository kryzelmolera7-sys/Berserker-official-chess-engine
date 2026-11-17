/**
 * Berserker C++20 WASM Engine Bridge (Node.js & Browser)
 *
 * Instantiates public/berserker-engine.wasm + public/nnue/v60-7f587dfb.nnue
 * with zero static Node-only imports so it is completely browser-bundle safe.
 */

export interface WasmSearchResult {
  bestMoveUci: string;
  ponderMoveUci: string | null;
  scoreCp: number;
  mate: number | null;
  depth: number;
  seldepth: number;
  nodes: number;
  nps: number;
  timeMs: number;
  pv: string[];
  rawLines: string[];
}

export interface WasmEngineInstance {
  isNnueLoaded(): boolean;
  setPosition(fenOrStartpos: string, moves?: string[]): void;
  evaluateFen(fen: string): number;
  evaluateRawFen(fen: string): number;
  perft(fen: string, depth: number): number;
  search(fenOrStartpos: string, maxDepth?: number, timeLimitMs?: number, moves?: string[]): WasmSearchResult;
  execUci(cmd: string): { isSearching: boolean; lines: string[] };
  stepSearch(): { continuing: boolean; lines: string[] };
  stop(): void;
  newGame(): void;
  setMultiPv(n: number): void;
  setContempt(cp: number): void;
}

interface RawExports {
  memory: WebAssembly.Memory;
  wasm_get_nnue_ptr(): number;
  wasm_get_nnue_max_bytes(): number;
  wasm_init_nnue(byteLen: number): number;
  wasm_is_nnue_loaded(): number;
  wasm_init(): void;
  wasm_get_cmd_buf(): number;
  wasm_get_cmd_buf_size(): number;
  wasm_stop(): void;
  wasm_evaluate_fen(len: number): number;
  wasm_evaluate_raw_fen(len: number): number;
  wasm_perft(depth: number): bigint;
  wasm_exec_uci(len: number): number;
  wasm_search_step(): number;
  wasm_get_last_best_move(ptr: number): number;
  wasm_get_last_score(): number;
  wasm_get_last_depth(): number;
  wasm_get_last_nodes(): bigint;
  wasm_get_last_seldepth(): number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function createWrapper(
  wasmModule: WebAssembly.Module,
  nnueBytes: Uint8Array | null
): WasmEngineInstance {
  let activeLines: string[] = [];
  let memoryRef: WebAssembly.Memory | null = null;

  const instance = new WebAssembly.Instance(wasmModule, {
    env: {
      js_uci_out(ptr: number, len: number) {
        if (!memoryRef || len <= 0) return;
        const slice = new Uint8Array(memoryRef.buffer, ptr, len);
        activeLines.push(textDecoder.decode(slice));
      },
      js_now_ms() {
        return performance.now();
      },
    },
  });

  const exp = instance.exports as unknown as RawExports;
  memoryRef = exp.memory;
  exp.wasm_init();

  if (nnueBytes && nnueBytes.byteLength >= exp.wasm_get_nnue_max_bytes() - 32) {
    const ptr = exp.wasm_get_nnue_ptr();
    const maxBytes = exp.wasm_get_nnue_max_bytes();
    const copyLen = Math.min(nnueBytes.byteLength, maxBytes);
    new Uint8Array(exp.memory.buffer, ptr, copyLen).set(nnueBytes.subarray(0, copyLen));
    exp.wasm_init_nnue(copyLen);
  }

  const cmdPtr = exp.wasm_get_cmd_buf();
  const cmdMax = exp.wasm_get_cmd_buf_size();

  function writeCmd(text: string): number {
    const encoded = textEncoder.encode(text);
    const len = Math.min(encoded.byteLength, cmdMax - 1);
    const view = new Uint8Array(exp.memory.buffer, cmdPtr, cmdMax);
    view.set(encoded.subarray(0, len), 0);
    view[len] = 0;
    return len;
  }

  function execUci(cmd: string): { isSearching: boolean; lines: string[] } {
    activeLines = [];
    const len = writeCmd(cmd);
    const searching = exp.wasm_exec_uci(len) !== 0;
    const lines = activeLines;
    activeLines = [];
    return { isSearching: searching, lines };
  }

  function stepSearch(): { continuing: boolean; lines: string[] } {
    activeLines = [];
    const cont = exp.wasm_search_step() !== 0;
    const lines = activeLines;
    activeLines = [];
    return { continuing: cont, lines };
  }

  function setPosition(fenOrStartpos: string, moves: string[] = []): void {
    const posCmd =
      fenOrStartpos === 'startpos'
        ? 'position startpos'
        : `position fen ${fenOrStartpos}`;
    const fullCmd = moves.length > 0 ? `${posCmd} moves ${moves.join(' ')}` : posCmd;
    execUci(fullCmd);
  }

  return {
    isNnueLoaded(): boolean {
      return exp.wasm_is_nnue_loaded() !== 0;
    },
    setPosition,
    evaluateFen(fen: string): number {
      const len = writeCmd(fen);
      return exp.wasm_evaluate_fen(len);
    },
    evaluateRawFen(fen: string): number {
      const len = writeCmd(fen);
      return exp.wasm_evaluate_raw_fen(len);
    },
    perft(fen: string, depth: number): number {
      setPosition(fen);
      return Number(exp.wasm_perft(depth));
    },
    execUci,
    stepSearch,
    stop(): void {
      exp.wasm_stop();
    },
    newGame(): void {
      execUci('ucinewgame');
    },
    setMultiPv(n: number): void {
      execUci(`setoption name MultiPV value ${n}`);
    },
    setContempt(cp: number): void {
      execUci(`setoption name TacticalContempt value ${cp}`);
    },
    search(
      fenOrStartpos: string,
      maxDepth = 12,
      timeLimitMs = 1500,
      moves: string[] = []
    ): WasmSearchResult {
      setPosition(fenOrStartpos, moves);
      const t0 = performance.now();
      const collected: string[] = [];

      const goRes = execUci(`go depth ${maxDepth} movetime ${timeLimitMs}`);
      collected.push(...goRes.lines);
      if (goRes.isSearching) {
        while (true) {
          const step = stepSearch();
          collected.push(...step.lines);
          if (!step.continuing) break;
        }
      }

      const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
      let bestMoveUci = '0000';
      let ponderMoveUci: string | null = null;
      let scoreCp = exp.wasm_get_last_score();
      let mate: number | null = null;
      let depth = exp.wasm_get_last_depth();
      let seldepth = exp.wasm_get_last_seldepth();
      let nodes = Number(exp.wasm_get_last_nodes());
      let nps = Math.round((nodes * 1000) / Math.max(1, elapsedMs));
      let pv: string[] = [];

      for (const line of collected) {
        if (line.startsWith('info ') && line.includes(' multipv 1 ')) {
          const dm = line.match(/\bdepth (\d+)/);
          const sdm = line.match(/\bseldepth (\d+)/);
          const cm = line.match(/\bscore cp (-?\d+)/);
          const mm = line.match(/\bscore mate (-?\d+)/);
          const nm = line.match(/\bnodes (\d+)/);
          const npsm = line.match(/\bnps (\d+)/);
          const pvIdx = line.indexOf(' pv ');
          if (dm) depth = parseInt(dm[1], 10);
          if (sdm) seldepth = parseInt(sdm[1], 10);
          if (mm) {
            mate = parseInt(mm[1], 10);
            scoreCp = mate > 0 ? 25000 - mate * 10 : -25000 - mate * 10;
          } else if (cm) {
            mate = null;
            scoreCp = parseInt(cm[1], 10);
          }
          if (nm) nodes = parseInt(nm[1], 10);
          if (npsm) nps = parseInt(npsm[1], 10);
          if (pvIdx !== -1) {
            pv = line.slice(pvIdx + 4).trim().split(/\s+/);
          }
        } else if (line.startsWith('bestmove ')) {
          const parts = line.split(/\s+/);
          bestMoveUci = parts[1] || '0000';
          const pidx = parts.indexOf('ponder');
          if (pidx !== -1 && parts[pidx + 1]) ponderMoveUci = parts[pidx + 1];
        }
      }

      if (bestMoveUci === '0000') {
        const len = exp.wasm_get_last_best_move(cmdPtr);
        if (len >= 4) {
          bestMoveUci = textDecoder.decode(new Uint8Array(exp.memory.buffer, cmdPtr, len));
        }
      }

      return {
        bestMoveUci,
        ponderMoveUci,
        scoreCp,
        mate,
        depth,
        seldepth,
        nodes,
        nps,
        timeMs: elapsedMs,
        pv: pv.length > 0 ? pv : bestMoveUci !== '0000' ? [bestMoveUci] : [],
        rawLines: collected,
      };
    },
  };
}

let cachedNodeEngine: WasmEngineInstance | null = null;
let cachedAsyncEngine: WasmEngineInstance | null = null;
let asyncInitPromise: Promise<WasmEngineInstance | null> | null = null;

/**
 * Returns the already-instantiated WASM+NNUE engine if available in either Node or Browser.
 */
export function getCachedWasmEngine(): WasmEngineInstance | null {
  return cachedAsyncEngine ?? cachedNodeEngine;
}

/**
 * Synchronous Node.js WASM + NNUE loader (safe in browser bundles via process.getBuiltinModule).
 */
export function getNodeWasmEngineSync(): WasmEngineInstance | null {
  if (cachedNodeEngine) return cachedNodeEngine;
  try {
    const proc =
      typeof process !== 'undefined'
        ? (process as unknown as {
            getBuiltinModule?: (id: string) => unknown;
            cwd?: () => string;
          })
        : null;
    if (!proc || typeof proc.getBuiltinModule !== 'function') return null;

    const fs = proc.getBuiltinModule('node:fs') as {
      existsSync: (p: string) => boolean;
      readFileSync: (p: string) => Uint8Array;
    };
    const path = proc.getBuiltinModule('node:path') as {
      resolve: (...parts: string[]) => string;
    };
    if (!fs || !path) return null;

    const cwd = typeof proc.cwd === 'function' ? proc.cwd() : '.';
    const wasmCandidates = [
      path.resolve(cwd, 'public/berserker-engine.wasm'),
      path.resolve(cwd, 'berserker-engine.wasm'),
    ];
    let wasmBytes: Uint8Array | null = null;
    for (const c of wasmCandidates) {
      if (fs.existsSync(c)) {
        wasmBytes = fs.readFileSync(c);
        break;
      }
    }
    if (!wasmBytes) return null;

    const nnueCandidates = [
      path.resolve(cwd, 'public/nnue/v60-7f587dfb.nnue'),
      path.resolve(cwd, 'nnue/v60-7f587dfb.nnue'),
    ];
    let nnueBytes: Uint8Array | null = null;
    for (const c of nnueCandidates) {
      if (fs.existsSync(c)) {
        nnueBytes = fs.readFileSync(c);
        break;
      }
    }

    const wasmModule = new WebAssembly.Module(wasmBytes as BufferSource);
    cachedNodeEngine = createWrapper(wasmModule, nnueBytes);
    cachedAsyncEngine = cachedNodeEngine;
    return cachedNodeEngine;
  } catch {
    return null;
  }
}

export function createNodeWasmEngineFresh(): WasmEngineInstance | null {
  try {
    const proc =
      typeof process !== 'undefined'
        ? (process as unknown as {
            getBuiltinModule?: (id: string) => unknown;
            cwd?: () => string;
          })
        : null;
    if (!proc || typeof proc.getBuiltinModule !== 'function') return null;

    const fs = proc.getBuiltinModule('node:fs') as {
      existsSync: (p: string) => boolean;
      readFileSync: (p: string) => Uint8Array;
    };
    const path = proc.getBuiltinModule('node:path') as {
      resolve: (...parts: string[]) => string;
    };
    const cwd = typeof proc.cwd === 'function' ? proc.cwd() : '.';
    const wasmPath = path.resolve(cwd, 'public/berserker-engine.wasm');
    if (!fs.existsSync(wasmPath)) return null;
    const wasmBytes = fs.readFileSync(wasmPath);

    const nnuePath = path.resolve(cwd, 'public/nnue/v60-7f587dfb.nnue');
    const nnueBytes = fs.existsSync(nnuePath) ? fs.readFileSync(nnuePath) : null;

    const wasmModule = new WebAssembly.Module(wasmBytes as BufferSource);
    return createWrapper(wasmModule, nnueBytes);
  } catch {
    return null;
  }
}

export async function initWasmEngine(
  wasmUrl = '/berserker-engine.wasm',
  nnueUrl = '/nnue/v60-7f587dfb.nnue'
): Promise<WasmEngineInstance | null> {
  if (cachedAsyncEngine) return cachedAsyncEngine;
  const sync = getNodeWasmEngineSync();
  if (sync) return sync;

  if (asyncInitPromise) return asyncInitPromise;
  asyncInitPromise = (async () => {
    try {
      const [wasmRes, nnueRes] = await Promise.all([
        fetch(wasmUrl),
        fetch(nnueUrl).catch(() => null),
      ]);
      if (!wasmRes.ok) return null;
      const wasmBuf = await wasmRes.arrayBuffer();
      const wasmModule = await WebAssembly.compile(wasmBuf);
      let nnueBytes: Uint8Array | null = null;
      if (nnueRes && nnueRes.ok) {
        nnueBytes = new Uint8Array(await nnueRes.arrayBuffer());
      }
      cachedAsyncEngine = createWrapper(wasmModule, nnueBytes);
      return cachedAsyncEngine;
    } catch {
      return null;
    }
  })();
  return asyncInitPromise;
}
