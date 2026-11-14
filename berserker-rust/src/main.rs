//! Berserker v0.7.0 Native Rust Engine - UCI Command Loop & CLI Runner

mod board;
mod book;
mod chess960;
mod epd;
mod gauntlet;
mod mcts;
mod nnue;
mod pawnhash;
mod search;
mod selfplay;
mod smp;
mod tablebase;
mod tuner;
mod types;

#[cfg(test)]
mod tests;

use board::Board;
use chess960::{extract_castling_config, generate_chess960_backrank, generate_chess960_fen};
use epd::run_tactical_suite;
use gauntlet::run_uci_gauntlet;
use mcts::{measure_opponent_threat_pressure, run_puct_verification};
use nnue::evaluate_board;
use search::SearchEngine;
use selfplay::run_selfplay_batch;
use std::io::{self, BufRead};
use std::time::Instant;
use tuner::run_texel_tempo_tune;
use types::Color;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "gauntlet" {
        let opp_bin = args
            .get(2)
            .map(|s| s.as_str())
            .unwrap_or("/tmp/sf19/stockfish/stockfish-linux-x86-64-universal");
        let pairs = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(4);
        let movetime_ms = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(100);
        let threads = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(4);
        let elo_cap = args.get(6).and_then(|s| s.parse::<u32>().ok());
        let self_bin = args[0].as_str();
        match run_uci_gauntlet(self_bin, opp_bin, pairs, movetime_ms, elo_cap, threads) {
            Ok(rep) => {
                println!(
                    "GAUNTLET opponent=\"{}\" games={} w={} d={} l={} score={:.2}% elo_diff={:+.1} err95=+-{:.1} los={:.1}%",
                    rep.opponent_name,
                    rep.games_played,
                    rep.berserker_wins,
                    rep.draws,
                    rep.opponent_wins,
                    rep.score_pct,
                    rep.elo_diff,
                    rep.elo_error_95,
                    rep.los_pct
                );
            }
            Err(e) => {
                eprintln!("GAUNTLET_ERROR {}", e);
                std::process::exit(1);
            }
        }
        return;
    }

    println!("Berserker v0.7.0 (Native Rust Edition)");
    let mut engine = SearchEngine::new(32);
    let mut board = Board::startpos();

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l.trim().to_string(),
            Err(_) => break,
        };

        if line.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let cmd = tokens[0];

        match cmd {
            "uci" => {
                println!("id name Berserker v0.7.0 (Rust)");
                println!("id author Berserker Engine Team");
                println!("option name UCI_Chess960 type check default false");
                println!("option name MultiPV type spin default 1 min 1 max 5");
                println!("option name Hash type spin default 32 min 1 max 1024");
                println!("option name Threads type spin default 1 min 1 max 64");
                println!("option name OwnBook type check default false");
                println!("option name SearchMode type combo default PVS var PVS var Hybrid-MCTS-PVS");
                println!("uciok");
            }
            "setoption" => {
                if let Some(name_pos) = tokens.iter().position(|&t| t.eq_ignore_ascii_case("name")) {
                    let val_pos = tokens.iter().position(|&t| t.eq_ignore_ascii_case("value"));
                    let name_end = val_pos.unwrap_or(tokens.len());
                    if name_pos + 1 < name_end {
                        let opt_name = tokens[name_pos + 1..name_end].join(" ").to_ascii_lowercase();
                        let opt_val = val_pos
                            .and_then(|vp| {
                                if vp + 1 < tokens.len() {
                                    Some(tokens[vp + 1..].join(" "))
                                } else {
                                    None
                                }
                            })
                            .unwrap_or_default();

                        match opt_name.as_str() {
                            "uci_chess960" => {
                                let enabled = opt_val.eq_ignore_ascii_case("true");
                                engine.uci_chess960 = enabled;
                                board.is_chess960 = enabled;
                            }
                            "multipv" => {
                                if let Ok(v) = opt_val.parse::<usize>() {
                                    engine.multi_pv = v.clamp(1, 5);
                                }
                            }
                            "hash" => {
                                if let Ok(mb) = opt_val.parse::<usize>() {
                                    engine.resize_tt(mb.clamp(1, 1024));
                                }
                            }
                            "threads" => {
                                if let Ok(t) = opt_val.parse::<usize>() {
                                    engine.threads = t.clamp(1, 64);
                                }
                            }
                            "ownbook" => {
                                engine.own_book = opt_val.eq_ignore_ascii_case("true");
                            }
                            "searchmode" => {
                                engine.hybrid_mcts = opt_val.eq_ignore_ascii_case("hybrid-mcts-pvs");
                            }
                            _ => {}
                        }
                    }
                }
            }
            "isready" => {
                println!("readyok");
            }
            "ucinewgame" => {
                engine.clear();
                board = Board::startpos();
                board.is_chess960 = engine.uci_chess960;
            }
            "position" => {
                if tokens.len() > 1 {
                    if tokens[1] == "startpos" {
                        board = Board::startpos();
                        board.is_chess960 = engine.uci_chess960;
                        if let Some(pos) = tokens.iter().position(|&t| t == "moves") {
                            for &mv in &tokens[pos + 1..] {
                                if let Some(m) = board.parse_uci_move(mv) {
                                    board.make_move(m);
                                }
                            }
                        }
                    } else if tokens[1] == "fen" {
                        let fen_tokens: Vec<&str> = tokens
                            .iter()
                            .skip(2)
                            .take_while(|&&t| t != "moves")
                            .copied()
                            .collect();
                        let fen_str = fen_tokens.join(" ");
                        board = Board::from_fen(&fen_str, engine.uci_chess960);
                        if let Some(pos) = tokens.iter().position(|&t| t == "moves") {
                            for &mv in &tokens[pos + 1..] {
                                if let Some(m) = board.parse_uci_move(mv) {
                                    board.make_move(m);
                                }
                            }
                        }
                    }
                }
            }
            "go" => {
                let mut depth: Option<u8> = None;
                let mut movetime: Option<u128> = None;
                let mut wtime: Option<u128> = None;
                let mut btime: Option<u128> = None;
                let mut winc: u128 = 0;
                let mut binc: u128 = 0;
                let mut movestogo: u128 = 24;
                let mut infinite = false;

                let mut i = 1;
                while i < tokens.len() {
                    match tokens[i] {
                        "depth" if i + 1 < tokens.len() => {
                            depth = tokens[i + 1].parse::<u8>().ok();
                            i += 1;
                        }
                        "movetime" if i + 1 < tokens.len() => {
                            movetime = tokens[i + 1].parse::<u128>().ok();
                            i += 1;
                        }
                        "wtime" if i + 1 < tokens.len() => {
                            wtime = tokens[i + 1].parse::<u128>().ok();
                            i += 1;
                        }
                        "btime" if i + 1 < tokens.len() => {
                            btime = tokens[i + 1].parse::<u128>().ok();
                            i += 1;
                        }
                        "winc" if i + 1 < tokens.len() => {
                            winc = tokens[i + 1].parse::<u128>().unwrap_or(0);
                            i += 1;
                        }
                        "binc" if i + 1 < tokens.len() => {
                            binc = tokens[i + 1].parse::<u128>().unwrap_or(0);
                            i += 1;
                        }
                        "movestogo" if i + 1 < tokens.len() => {
                            movestogo = tokens[i + 1].parse::<u128>().unwrap_or(24).max(1);
                            i += 1;
                        }
                        "infinite" => {
                            infinite = true;
                        }
                        _ => {}
                    }
                    i += 1;
                }

                let max_depth = depth.unwrap_or(if infinite { 32 } else { 18 }).clamp(1, 64);
                let time_limit_ms = if let Some(mt) = movetime {
                    mt.max(10)
                } else if wtime.is_some() || btime.is_some() {
                    let (rem, inc) = if board.stm == Color::White {
                        (wtime.unwrap_or(10_000), winc)
                    } else {
                        (btime.unwrap_or(10_000), binc)
                    };
                    let alloc = (rem / movestogo.max(20)) + (inc * 3 / 4);
                    alloc.clamp(25, (rem / 3).max(25))
                } else if infinite {
                    30_000
                } else if depth.is_some() {
                    20_000
                } else {
                    2_000
                };

                let (best_move, _, _) = engine.search(&mut board, max_depth, time_limit_ms, true);
                println!("bestmove {}", best_move.to_uci(engine.uci_chess960));
            }
            "mcts" => {
                let sims: u32 = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(128).clamp(8, 2048);
                let threat = measure_opponent_threat_pressure(&mut board);
                if let Some((mv, est_cp, visits)) = run_puct_verification(&mut board, sims) {
                    println!(
                        "info string mcts best {} visits {} est_cp {} threat_pressure {}",
                        mv.to_uci(engine.uci_chess960),
                        visits,
                        est_cp,
                        threat
                    );
                } else {
                    println!("info string mcts none");
                }
            }
            "selfplay" => {
                let games: u32 = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(2).clamp(1, 64);
                let chess960 = tokens.get(2).map(|s| *s == "960").unwrap_or(false);
                let sum = run_selfplay_batch(games, 4, 80, chess960);
                println!(
                    "info string selfplay games={} w={} d={} l={} positions={} texel_mse={:.5} time={}ms pgn={} sample={}",
                    sum.games, sum.white_wins, sum.draws, sum.black_wins, sum.total_positions, sum.texel_mse, sum.elapsed_ms, sum.sample_pgn, sum.sample_fen
                );
            }
            "suite" => {
                let mt: u128 = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(150).clamp(20, 3000);
                let res = run_tactical_suite(mt, engine.threads);
                println!(
                    "info string tactical_suite solved={}/{} time={}ms",
                    res.solved, res.total, res.elapsed_ms
                );
            }
            "tune" => {
                let games: u32 = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(4).clamp(1, 32);
                let (best_tempo, mse, samples) = run_texel_tempo_tune(games);
                println!(
                    "info string texel_tune optimal_tempo={}cp mse={:.6} samples={}",
                    best_tempo, mse, samples
                );
            }
            "chess960" => {
                let sp: u16 = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(518).min(959);
                let backrank = generate_chess960_backrank(sp);
                let cfg = extract_castling_config(&backrank, sp);
                let fen = generate_chess960_fen(sp, true);
                engine.uci_chess960 = true;
                board = Board::from_fen(&fen, true);
                println!(
                    "info string Chess960 SP #{}: Backrank {} WhiteKingFile: {}",
                    sp, backrank, cfg.white_king_file
                );
                println!("info string FEN {}", fen);
            }
            "perft" => {
                let d: u8 = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(4).min(7);
                let start = Instant::now();
                let nodes = board.perft(d);
                let elapsed = start.elapsed().as_millis().max(1);
                let nps = (nodes as u128 * 1000) / elapsed;
                println!("perft {} nodes {} time {} nps {}", d, nodes, elapsed, nps);
            }
            "eval" => {
                let ev = evaluate_board(&board);
                println!(
                    "info string eval white_cp {} stm_cp {} wdl {:.1}%/{:.1}%/{:.1}%",
                    ev.centipawns,
                    ev.stm_cp,
                    ev.win_prob * 100.0,
                    ev.draw_prob * 100.0,
                    ev.loss_prob * 100.0
                );
            }
            "bench" => {
                println!("Running Berserker Native Rust Benchmark...");
                let fens = [
                    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
                    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
                ];
                let start = Instant::now();
                let mut last_move = types::Move::NULL;
                let mut last_score = 0;
                for f in &fens {
                    let mut b = Board::from_fen(f, false);
                    let (m, score, _) = engine.search(&mut b, 7, 1500, false);
                    last_move = m;
                    last_score = score;
                }
                println!(
                    "Benchmark completed in {}ms. Best move: {} Score: {}cp",
                    start.elapsed().as_millis(),
                    last_move.to_uci(false),
                    last_score
                );
            }
            "quit" => {
                break;
            }
            _ => {}
        }
    }
}
