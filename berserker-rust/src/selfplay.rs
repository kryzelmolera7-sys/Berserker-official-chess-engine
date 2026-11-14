//! Pure Rust Self-Play Game Generator & Sigmoid Evaluation Loss Analyzer
//!
//! Runs multi-threaded or rapid fixed-depth/fixed-time self-play games natively in Rust,
//! emits PGN / FEN training samples, and computes genuine evaluation Texel MSE loss
//! against actual game outcomes.

use crate::board::Board;
use crate::book::probe_book;
use crate::chess960::generate_chess960_fen;
use crate::nnue::evaluate_board;
use crate::search::SearchEngine;
use crate::types::{Color, Move, PieceType};
use std::time::Instant;

pub struct SelfPlaySummary {
    pub games: u32,
    pub white_wins: u32,
    pub draws: u32,
    pub black_wins: u32,
    pub total_positions: u64,
    pub texel_mse: f64,
    pub elapsed_ms: u128,
    pub sample_pgn: String,
    pub sample_fen: String,
}

#[inline]
fn has_insufficient_material(board: &Board) -> bool {
    let total = board.occ_all.count_ones();
    if total <= 2 {
        return true;
    }
    if total == 3 {
        let minors = board.pieces[0][PieceType::Knight as usize].count_ones()
            + board.pieces[0][PieceType::Bishop as usize].count_ones()
            + board.pieces[1][PieceType::Knight as usize].count_ones()
            + board.pieces[1][PieceType::Bishop as usize].count_ones();
        return minors == 1;
    }
    false
}

/// Runs `num_games` genuine self-play games natively inside Rust using SearchEngine + Opening Book.
pub fn run_selfplay_batch(num_games: u32, depth: u8, time_ms: u128, chess960: bool) -> SelfPlaySummary {
    let start = Instant::now();
    let mut white_engine = SearchEngine::new(16);
    let mut black_engine = SearchEngine::new(16);
    white_engine.uci_chess960 = chess960;
    black_engine.uci_chess960 = chess960;

    let mut white_wins = 0u32;
    let mut draws = 0u32;
    let mut black_wins = 0u32;
    let mut total_positions = 0u64;
    let mut mse_sum = 0.0f64;
    let mut mse_count = 0u64;
    let mut last_pgn = String::new();
    let mut last_fen = String::new();

    for g in 0..num_games.max(1) {
        white_engine.clear();
        black_engine.clear();

        let mut board = if chess960 {
            let sp = ((g as u16) * 137 + 19) % 960;
            Board::from_fen(&generate_chess960_fen(sp, true), true)
        } else {
            Board::startpos()
        };

        let mut uci_moves: Vec<String> = Vec::with_capacity(120);
        let mut quiet_evals_white_pov: Vec<i32> = Vec::with_capacity(64);
        let game_result: f64;

        loop {
            let legal = board.generate_legal_moves(false);
            if legal.is_empty() {
                if board.in_check() {
                    if board.stm == Color::Black {
                        white_wins += 1;
                        game_result = 1.0;
                    } else {
                        black_wins += 1;
                        game_result = 0.0;
                    }
                } else {
                    draws += 1;
                    game_result = 0.5;
                }
                break;
            }
            if board.halfmove >= 100 || board.is_repetition() || has_insufficient_material(&board) || uci_moves.len() >= 180 {
                draws += 1;
                game_result = 0.5;
                break;
            }

            let book_mv = if !chess960 {
                probe_book(&mut board, (g as u64).wrapping_mul(17) + (uci_moves.len() as u64))
            } else {
                None
            };

            let (chosen, eval_score) = if let Some(bm) = book_mv {
                (bm, evaluate_board(&board).centipawns)
            } else if board.stm == Color::White {
                let (m, s, _) = white_engine.search(&mut board, depth, time_ms, false);
                let w_cp = if board.stm == Color::White { s } else { -s };
                (m, w_cp)
            } else {
                let (m, s, _) = black_engine.search(&mut board, depth, time_ms, false);
                let w_cp = if board.stm == Color::White { s } else { -s };
                (m, w_cp)
            };

            if chosen == Move::NULL {
                draws += 1;
                game_result = 0.5;
                break;
            }

            if !board.in_check() && eval_score.abs() < 15000 && uci_moves.len() >= 10 {
                quiet_evals_white_pov.push(eval_score);
            }
            if uci_moves.len() == 24 {
                last_fen = format!("{} moves {}", if chess960 { "chess960" } else { "startpos" }, uci_moves.join(" "));
            }

            uci_moves.push(chosen.to_uci(chess960));
            if board.make_move(chosen).is_none() {
                draws += 1;
                game_result = 0.5;
                break;
            }
            total_positions += 1;
        }

        for cp in quiet_evals_white_pov {
            let pred = 1.0 / (1.0 + (-(cp as f64) / 400.0).exp());
            let err = game_result - pred;
            mse_sum += err * err;
            mse_count += 1;
        }

        last_pgn = uci_moves.iter().take(24).cloned().collect::<Vec<_>>().join(" ");
        if last_fen.is_empty() {
            last_fen = format!("startpos moves {}", uci_moves.iter().take(12).cloned().collect::<Vec<_>>().join(" "));
        }
    }

    let texel_mse = if mse_count > 0 {
        mse_sum / mse_count as f64
    } else {
        0.0
    };

    SelfPlaySummary {
        games: num_games.max(1),
        white_wins,
        draws,
        black_wins,
        total_positions,
        texel_mse,
        elapsed_ms: start.elapsed().as_millis(),
        sample_pgn: last_pgn,
        sample_fen: last_fen,
    }
}
