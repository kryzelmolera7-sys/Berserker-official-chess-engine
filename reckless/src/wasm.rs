use std::sync::Arc;

use crate::{
    board::{Board, NullBoardObserver},
    nnue::{self, NETWORK_NAME, PARAMETERS_BYTES},
    search::{self, Report, SearchState},
    thread::{RootMove, SharedContext, Status},
    threadpool::ThreadPool,
    time::{Limits, TimeManager},
    types::{Color, MAX_MOVES, normalize_to_cp},
};

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn js_uci_out(ptr: *const u8, len: usize);
}

#[inline]
fn emit_line(line: &str) {
    unsafe {
        js_uci_out(line.as_ptr(), line.len());
    }
}

const CMD_BUF_SIZE: usize = 16384;
static mut CMD_BUF: [u8; CMD_BUF_SIZE] = [0u8; CMD_BUF_SIZE];

struct WasmEngineState {
    shared: Arc<SharedContext>,
    threads: ThreadPool,
    board: Board,
    frc: bool,
    multi_pv: usize,
    move_overhead: u64,
    report: Report,
    active_search: Option<SearchState>,
}

static mut ENGINE: Option<WasmEngineState> = None;

fn ensure_engine() -> &'static mut WasmEngineState {
    unsafe {
        if (*(&raw const ENGINE)).is_none() {
            crate::lookup::initialize();
            crate::nnue::initialize();
            let shared = Arc::new(SharedContext::default());
            let threads = ThreadPool::new(shared.clone());
            *(&raw mut ENGINE) = Some(WasmEngineState {
                shared,
                threads,
                board: Board::starting_position(),
                frc: false,
                multi_pv: 1,
                move_overhead: 50,
                report: Report::Full,
                active_search: None,
            });
        }
        (*(&raw mut ENGINE)).as_mut().unwrap()
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_init() {
    let _ = ensure_engine();
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_get_cmd_buf() -> *mut u8 {
    (&raw mut CMD_BUF).cast::<u8>()
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_get_cmd_buf_size() -> usize {
    CMD_BUF_SIZE
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_get_nnue_ptr() -> *mut u8 {
    nnue::params_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_get_nnue_max_bytes() -> usize {
    nnue::params_size()
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_init_nnue(byte_len: usize) -> i32 {
    if byte_len != PARAMETERS_BYTES {
        return 0;
    }
    nnue::mark_loaded();
    if let Some(eng) = unsafe { (*(&raw mut ENGINE)).as_mut() } {
        eng.threads.clear();
    }
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_is_nnue_loaded() -> i32 {
    i32::from(nnue::is_loaded())
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_stop() {
    if let Some(eng) = unsafe { (*(&raw mut ENGINE)).as_mut() } {
        eng.shared.status.set(Status::STOPPED);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_evaluate_raw_fen(len: usize) -> i32 {
    let eng = ensure_engine();
    let fen = read_cmd_slice(len);
    let board = Board::from_fen(fen).unwrap_or_else(|_| Board::starting_position());
    let td = eng.threads.main_thread();
    td.nnue.full_refresh(&board);
    td.nnue.evaluate(&board)
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_evaluate_fen(len: usize) -> i32 {
    let eng = ensure_engine();
    let fen = read_cmd_slice(len);
    let board = Board::from_fen(fen).unwrap_or_else(|_| Board::starting_position());
    let td = eng.threads.main_thread();
    td.nnue.full_refresh(&board);
    let raw = td.nnue.evaluate(&board);
    normalize_to_cp(raw, &board)
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_verify_incremental_parity(len: usize, depth: i32) -> i32 {
    let eng = ensure_engine();
    let fen = read_cmd_slice(len);
    let mut inc_board = match Board::from_fen(fen) {
        Ok(b) => b,
        Err(_) => return -1,
    };
    let max_depth = depth.clamp(1, 3);
    let td = eng.threads.main_thread();
    td.nnue.full_refresh(&inc_board);

    let mut ref_nnue = td.nnue.clone();
    let mut mismatches = 0i32;

    fn walk(
        board: &mut Board,
        inc_nnue: &mut nnue::Network,
        ref_nnue: &mut nnue::Network,
        ply_left: i32,
        mismatches: &mut i32,
    ) {
        let moves = board.generate_all_moves();
        for entry in moves.iter().take(24) {
            let mv = entry.mv;
            inc_nnue.push(mv, board);
            board.make_move(mv, inc_nnue);

            let inc_eval = inc_nnue.evaluate(board);
            ref_nnue.full_refresh(board);
            let ref_eval = ref_nnue.evaluate(board);
            if inc_eval != ref_eval {
                *mismatches += 1;
            }

            if ply_left > 1 {
                walk(board, inc_nnue, ref_nnue, ply_left - 1, mismatches);
            }

            inc_nnue.pop();
            board.undo_move(mv);
        }
    }

    walk(&mut inc_board, &mut td.nnue, &mut ref_nnue, max_depth, &mut mismatches);
    mismatches
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_perft(depth: i32) -> u64 {
    let eng = ensure_engine();
    let mut board = eng.board.clone();
    perft_rec(&mut board, depth.max(0) as usize)
}

fn perft_rec(board: &mut Board, depth: usize) -> u64 {
    if depth == 0 {
        return 1;
    }
    let moves = board.generate_all_moves();
    if depth == 1 {
        return moves.len() as u64;
    }
    let mut total = 0u64;
    for entry in moves.iter() {
        board.make_move(entry.mv, &mut NullBoardObserver);
        total += perft_rec(board, depth - 1);
        board.undo_move(entry.mv);
    }
    total
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_get_last_best_move(out_ptr: *mut u8) -> usize {
    let eng = ensure_engine();
    let td = &eng.threads[0];
    if td.root_moves.is_empty() {
        return 0;
    }
    let uci = td.root_moves[0].mv.to_uci(&eng.board);
    let bytes = uci.as_bytes();
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, bytes.len());
    }
    bytes.len()
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_get_last_score() -> i32 {
    let eng = ensure_engine();
    let td = &eng.threads[0];
    if td.root_moves.is_empty() {
        0
    } else {
        normalize_to_cp(td.root_moves[0].display_score, &eng.board)
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_get_last_depth() -> i32 {
    ensure_engine().threads[0].completed_depth
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_get_last_seldepth() -> i32 {
    let eng = ensure_engine();
    let td = &eng.threads[0];
    if td.root_moves.is_empty() {
        td.sel_depth
    } else {
        td.root_moves[0].sel_depth.max(td.sel_depth)
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_get_last_nodes() -> u64 {
    ensure_engine().shared.nodes.aggregate()
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_exec_uci(len: usize) -> i32 {
    let eng = ensure_engine();
    let line = read_cmd_slice(len).trim().to_string();
    let tokens: Vec<&str> = line.split_whitespace().collect();

    match tokens.as_slice() {
        ["uci"] => {
            emit_line(&format!("id name Reckless {}", env!("ENGINE_VERSION")));
            emit_line("id author Arseniy Surkov, Shahin M. Shahin, and Styx");
            emit_line(&format!("option name Hash type spin default {} min 1 max 262144", crate::transposition::DEFAULT_TT_SIZE));
            emit_line(&format!(
                "option name Threads type spin default 1 min 1 max {}",
                ThreadPool::available_threads()
            ));
            emit_line("option name MoveOverhead type spin default 100 min 0 max 2000");
            emit_line("option name Minimal type check default false");
            emit_line("option name Clear Hash type button");
            emit_line("option name UCI_Chess960 type check default false");
            emit_line(&format!("option name MultiPV type spin default 1 min 1 max {MAX_MOVES}"));
            emit_line(&format!("option name EvalFile type string default {NETWORK_NAME}"));
            emit_line("uciok");
            0
        }
        ["isready"] => {
            if nnue::is_loaded() {
                emit_line(&format!("info string NNUE loaded: {NETWORK_NAME} ({PARAMETERS_BYTES} bytes)"));
            }
            emit_line("readyok");
            0
        }
        ["ucinewgame"] => {
            eng.active_search = None;
            eng.threads.clear();
            eng.shared.tt.clear(1);
            for corrhist in eng.shared.history.all() {
                corrhist.pawn.clear();
                corrhist.non_pawn[Color::White].clear();
                corrhist.non_pawn[Color::Black].clear();
            }
            0
        }
        ["setoption", rest @ ..] => {
            handle_setoption(eng, rest);
            0
        }
        ["position", rest @ ..] => {
            handle_position(eng, rest);
            0
        }
        ["stop"] => {
            eng.shared.status.set(Status::STOPPED);
            0
        }
        ["eval"] => {
            let td = eng.threads.main_thread();
            td.nnue.full_refresh(&eng.board);
            let raw = td.nnue.evaluate(&eng.board);
            let cp = normalize_to_cp(raw, &eng.board);
            emit_line(&format!("info string eval {cp:+} cp (raw {raw})"));
            0
        }
        ["perft", depth_str] => {
            let d = depth_str.parse::<i32>().unwrap_or(1);
            let nodes = wasm_perft(d);
            emit_line(&format!("info string perft({d}) = {nodes}"));
            0
        }
        ["go", rest @ ..] => begin_search(eng, rest),
        _ => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_search_step() -> i32 {
    let eng = ensure_engine();
    let Some(state) = eng.active_search.as_mut() else {
        return 0;
    };

    let t1 = &mut eng.threads.vector[0];
    let mut cont = search::step_iterative_search(t1, state);

    if cont && matches!(t1.time_manager.limits(), Limits::Infinite) && eng.shared.status.get() == Status::STOPPED {
        cont = false;
    }

    if !cont {
        eng.shared.status.set(Status::STOPPED);
        search::finish_iterative_search(t1, state);
        if t1.root_moves.is_empty() {
            emit_line("bestmove (none)");
        } else {
            let mv_uci = t1.root_moves[0].mv.to_uci(&eng.board);
            emit_line(&format!("bestmove {mv_uci}"));
        }
        eng.active_search = None;
        return 0;
    }

    1
}

fn begin_search(eng: &mut WasmEngineState, tokens: &[&str]) -> i32 {
    let legal = eng.board.generate_all_moves();
    let search_moves: Option<Vec<_>> = parse_search_moves(&eng.board, &legal, tokens);

    eng.shared.tt.increment_age();
    eng.shared.nodes.reset();
    eng.shared.tb_hits.reset();
    eng.shared.root_in_tb.store(false, std::sync::atomic::Ordering::Relaxed);
    eng.shared.stop_probing_tb.store(false, std::sync::atomic::Ordering::Relaxed);
    eng.shared.soft_stop_votes.store(0, std::sync::atomic::Ordering::Release);
    eng.shared.status.set(Status::RUNNING);

    let prev_best = eng.threads.main_thread().previous_best_score;
    eng.shared.best_stats.iter().for_each(|x| {
        x.store((prev_best + 32768) as u32, std::sync::atomic::Ordering::Release);
    });

    let limits = parse_wasm_limits(eng.board.side_to_move(), tokens);
    let tm = TimeManager::new(limits, eng.board.fullmove_number(), eng.move_overhead);

    let t1 = &mut eng.threads.vector[0];
    t1.board = eng.board.clone();
    t1.root_moves = legal.iter().map(|v| RootMove { mv: v.mv, ..Default::default() }).collect();
    if let Some(ref allowed) = search_moves {
        t1.root_moves.retain(|rm| allowed.contains(&rm.mv));
    }
    t1.multi_pv = eng.multi_pv;
    t1.time_manager = tm;

    if t1.root_moves.is_empty() {
        if eng.report == Report::Full {
            t1.print_uci_info(0);
        }
        emit_line("bestmove (none)");
        eng.shared.status.set(Status::STOPPED);
        eng.active_search = None;
        return 0;
    }

    eng.active_search = Some(search::init_iterative_search(t1, eng.report, 1));
    1
}

fn handle_position(eng: &mut WasmEngineState, mut tokens: &[&str]) {
    while !tokens.is_empty() {
        match tokens {
            ["startpos", rest @ ..] => {
                eng.board = Board::starting_position();
                tokens = rest;
            }
            ["fen", rest @ ..] => {
                if let Ok(b) = Board::from_fen(&rest.join(" ")) {
                    eng.board = b;
                }
                eng.board.set_frc(eng.frc);
                tokens = rest;
            }
            ["moves", rest @ ..] => {
                for uci_move in rest {
                    let moves = eng.board.generate_all_moves();
                    if let Some(mv) = moves.iter().map(|e| e.mv).find(|m| m.to_uci(&eng.board) == *uci_move) {
                        eng.board.make_move(mv, &mut NullBoardObserver);
                    }
                }
                break;
            }
            _ => tokens = &tokens[1..],
        }
    }
}

fn handle_setoption(eng: &mut WasmEngineState, tokens: &[&str]) {
    match tokens {
        ["name", "Minimal", "value", v] => {
            eng.report = if *v == "true" { Report::Minimal } else { Report::Full };
        }
        ["name", "Clear", "Hash"] => {
            eng.shared.tt.clear(1);
        }
        ["name", "Hash", "value", v] => {
            if let Ok(mb) = v.parse::<usize>() {
                eng.shared.tt.resize(1, mb);
            }
        }
        ["name", "MoveOverhead", "value", v] => {
            if let Ok(ms) = v.parse::<u64>() {
                eng.move_overhead = ms;
            }
        }
        ["name", "UCI_Chess960", "value", v] => {
            eng.frc = v.parse().unwrap_or_default();
        }
        ["name", "MultiPV", "value", v] => {
            eng.multi_pv = v.parse::<usize>().unwrap_or(1).clamp(1, MAX_MOVES);
        }
        _ => {}
    }
}

fn parse_search_moves(board: &Board, legal: &crate::types::MoveList, tokens: &[&str]) -> Option<Vec<crate::types::Move>> {
    let index = tokens.iter().position(|&t| t == "searchmoves")?;
    let mut moves = Vec::new();
    for &token in tokens.iter().skip(index + 1).take_while(|&&t| {
        !matches!(
            t,
            "searchmoves"
                | "ponder"
                | "wtime"
                | "btime"
                | "winc"
                | "binc"
                | "movestogo"
                | "depth"
                | "nodes"
                | "mate"
                | "movetime"
                | "infinite"
        )
    }) {
        if let Some(mv) = legal.iter().map(|e| e.mv).find(|m| m.to_uci(board) == token) {
            moves.push(mv);
        }
    }
    Some(moves)
}

fn parse_wasm_limits(color: Color, tokens: &[&str]) -> Limits {
    if let ["infinite"] = tokens {
        return Limits::Infinite;
    }

    let mut depth_opt: Option<i32> = None;
    let mut time_opt: Option<u64> = None;
    let mut main = None;
    let mut inc = None;
    let mut moves = None;

    for chunk in tokens.windows(2) {
        if let [name, value] = *chunk {
            let Ok(value) = value.parse::<u64>() else {
                continue;
            };
            match name {
                "depth" if value > 0 => depth_opt = Some(value as i32),
                "movetime" if value > 0 => time_opt = Some(value),
                "nodes" if value > 0 => return Limits::Nodes(value),
                "mate" if value > 0 => return Limits::Mate(value),
                "wtime" if color == Color::White => main = Some(value),
                "btime" if color == Color::Black => main = Some(value),
                "winc" if color == Color::White => inc = Some(value),
                "binc" if color == Color::Black => inc = Some(value),
                "movestogo" => moves = Some(value),
                _ => continue,
            }
        }
    }

    match (depth_opt, time_opt) {
        (Some(d), Some(ms)) => return Limits::DepthTime(d, ms),
        (Some(d), None) => return Limits::Depth(d),
        (None, Some(ms)) => return Limits::Time(ms),
        (None, None) => {}
    }

    if main.is_none() && inc.is_none() {
        return Limits::Infinite;
    }
    let main = main.unwrap_or_default();
    let inc = inc.unwrap_or_default();
    match moves {
        Some(m) => Limits::Cyclic(main, inc, m),
        None => Limits::Fischer(main, inc),
    }
}

fn read_cmd_slice(len: usize) -> &'static str {
    let clamped = len.min(CMD_BUF_SIZE - 1);
    let slice = unsafe { std::slice::from_raw_parts((&raw const CMD_BUF).cast::<u8>(), clamped) };
    std::str::from_utf8(slice).unwrap_or("")
}
