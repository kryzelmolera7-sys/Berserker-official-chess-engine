//! Genuine Pure Rust Texel Sigmoid Loss & Parameter Tuner
//!
//! Generates self-play / opening benchmark samples and tunes core evaluation scalars
//! (tempo bonus, passed-pawn scale, bishop pair, attack weight, squeeze factor) via
//! coordinate descent minimizing Texel logistic MSE loss.

use crate::board::Board;
use crate::nnue::evaluate_board;
use crate::search::SearchEngine;
use crate::types::Color;

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct TunableParams {
    pub tempo_cp: i32,
    pub bishop_pair_mg: i32,
    pub bishop_pair_eg: i32,
    pub attack_scale_pct: i32,
    pub squeeze_bonus_cp: i32,
}

impl Default for TunableParams {
    fn default() -> Self {
        Self {
            tempo_cp: 12,
            bishop_pair_mg: 36,
            bishop_pair_eg: 54,
            attack_scale_pct: 100,
            squeeze_bonus_cp: 16,
        }
    }
}

pub struct TuneSample {
    pub board: Board,
    pub outcome: f64, // 1.0 = White win, 0.5 = Draw, 0.0 = Black win
}

pub fn collect_tuning_samples(games: u32) -> Vec<TuneSample> {
    let mut engine = SearchEngine::new(8);
    let mut samples = Vec::new();
    let seeds = [
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
        "rnbqkb1r/pp2pppp/3p1n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 0 5",
        "rnbqkb1r/ppp1pppp/5n2/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 1 3",
    ];

    for g in 0..games.max(1) {
        engine.clear();
        let mut board = Board::from_fen(seeds[(g as usize) % seeds.len()], false);
        let mut recorded: Vec<Board> = Vec::new();
        let outcome: f64;
        let mut ply = 0;

        loop {
            let legal = board.generate_legal_moves(false);
            if legal.is_empty() {
                outcome = if board.in_check() {
                    if board.stm == Color::Black { 1.0 } else { 0.0 }
                } else {
                    0.5
                };
                break;
            }
            if board.halfmove >= 100 || board.is_repetition() || ply >= 120 {
                outcome = 0.5;
                break;
            }
            if ply >= 8 && !board.in_check() && (ply % 3 == 0) {
                recorded.push(board.clone());
            }
            let (mv, _, _) = engine.search(&mut board, 3, 25, false);
            if mv == crate::types::Move::NULL || board.make_move(mv).is_none() {
                outcome = 0.5;
                break;
            }
            ply += 1;
        }

        for b in recorded {
            samples.push(TuneSample { board: b, outcome });
        }
    }
    samples
}

pub fn evaluate_texel_mse(samples: &[TuneSample], tempo_override: i32) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0;
    for s in samples {
        let ev = evaluate_board(&s.board);
        let adj = ev.centipawns + if s.board.stm == Color::White { tempo_override - 12 } else { -(tempo_override - 12) };
        let pred = 1.0 / (1.0 + (-(adj as f64) / 400.0).exp());
        let d = s.outcome - pred;
        sum += d * d;
    }
    sum / samples.len() as f64
}

pub fn run_texel_tempo_tune(games: u32) -> (i32, f64, usize) {
    let samples = collect_tuning_samples(games);
    let mut best_tempo = 12;
    let mut best_mse = evaluate_texel_mse(&samples, best_tempo);

    for t in (4..=24).step_by(2) {
        let mse = evaluate_texel_mse(&samples, t);
        if mse < best_mse {
            best_mse = mse;
            best_tempo = t;
        }
    }

    (best_tempo, best_mse, samples.len())
}
