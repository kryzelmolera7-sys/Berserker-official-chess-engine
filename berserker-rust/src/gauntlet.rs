//! Native Rust UCI-vs-UCI Gauntlet Match Runner & Exact Elo Differential Calculator
//!
//! Plays balanced two-game opening pairs (swapped White/Black) against any external UCI engine
//! (such as Stockfish 19), adjudicates legal termination cleanly via `Board`, and computes
//! exact logistic Elo difference, 95% confidence bounds, and Likelihood of Superiority (LOS).

use crate::board::Board;
use crate::types::PieceType;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

#[derive(Clone, Debug)]
pub struct GauntletReport {
    pub opponent_name: String,
    pub games_played: u32,
    pub berserker_wins: u32,
    pub draws: u32,
    pub opponent_wins: u32,
    pub score_pct: f64,
    pub elo_diff: f64,
    pub elo_error_95: f64,
    pub los_pct: f64,
}

struct UciProc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    name: String,
}

impl UciProc {
    fn spawn(bin_path: &str, options: &[(&str, &str)]) -> Result<Self, String> {
        let mut child = Command::new(bin_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn '{}': {}", bin_path, e))?;

        let mut stdin = child.stdin.take().ok_or("Missing stdin")?;
        let stdout_raw = child.stdout.take().ok_or("Missing stdout")?;
        let mut stdout = BufReader::new(stdout_raw);

        writeln!(stdin, "uci").map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;

        let mut name = bin_path.to_string();
        let mut line = String::new();
        loop {
            line.clear();
            let n = stdout.read_line(&mut line).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            let trim = line.trim();
            if let Some(rest) = trim.strip_prefix("id name ") {
                name = rest.to_string();
            } else if trim == "uciok" {
                break;
            }
        }

        for &(k, v) in options {
            writeln!(stdin, "setoption name {} value {}", k, v).map_err(|e| e.to_string())?;
        }
        writeln!(stdin, "isready").map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        loop {
            line.clear();
            let n = stdout.read_line(&mut line).map_err(|e| e.to_string())?;
            if n == 0 || line.trim() == "readyok" {
                break;
            }
        }

        Ok(Self {
            child,
            stdin,
            stdout,
            name,
        })
    }

    fn new_game(&mut self) -> Result<(), String> {
        writeln!(self.stdin, "ucinewgame\nisready").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        loop {
            line.clear();
            let n = self.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
            if n == 0 || line.trim() == "readyok" {
                break;
            }
        }
        Ok(())
    }

    fn bestmove(&mut self, start_fen: &str, moves: &[String], movetime_ms: u64) -> Result<String, String> {
        if moves.is_empty() {
            writeln!(self.stdin, "position fen {}", start_fen).map_err(|e| e.to_string())?;
        } else {
            writeln!(self.stdin, "position fen {} moves {}", start_fen, moves.join(" "))
                .map_err(|e| e.to_string())?;
        }
        writeln!(self.stdin, "go movetime {}", movetime_ms).map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;

        let mut line = String::new();
        loop {
            line.clear();
            let n = self.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("Engine closed stdout unexpectedly".to_string());
            }
            let trim = line.trim();
            if let Some(rest) = trim.strip_prefix("bestmove ") {
                let mv = rest.split_whitespace().next().unwrap_or("0000").to_string();
                return Ok(mv);
            }
        }
    }
}

impl Drop for UciProc {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, "quit");
        let _ = self.stdin.flush();
        let _ = self.child.wait();
    }
}

const GAUNTLET_FENS: &[&str] = &[
    // Balanced Classical & Modern GM Opening Positions
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", // 1.e4 e5 2.Nf3 Nc6
    "rnbqkb1r/pp2pppp/3p1n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 0 5", // Open Sicilian
    "rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3", // French Defense
    "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", // Caro-Kann
    "rnbqkb1r/ppp1pppp/5n2/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 1 3", // Queen's Gambit Declined / Slav stem
    "rnbqkb1r/pppppp1p/5np1/8/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3", // King's Indian / Grunfeld stem
    "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3", // Ruy Lopez
    "rnbqkb1r/pp3ppp/4pn2/2pp4/2PP4/2N2N2/PP2PPPP/R1BQKB1R w KQkq - 0 5", // Tarrasch / QGD
];

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

/// Computes exact logistic Elo difference, 95% confidence margin, and LOS% from W/D/L
pub fn compute_elo_stats(wins: u32, draws: u32, losses: u32) -> (f64, f64, f64, f64) {
    let n = (wins + draws + losses) as f64;
    if n <= 0.0 {
        return (50.0, 0.0, 0.0, 50.0);
    }
    let w = wins as f64 / n;
    let d = draws as f64 / n;
    let score = (w + 0.5 * d).clamp(0.01, 0.99);
    let elo_diff = -400.0 * ((1.0 / score) - 1.0).log10();

    // Variance of game score (1, 0.5, 0)
    let mean = score;
    let var = (w * (1.0 - mean).powi(2) + d * (0.5 - mean).powi(2) + (losses as f64 / n) * (0.0 - mean).powi(2)) / n;
    let stddev = var.sqrt().max(1e-6);
    let s_min = (score - 1.96 * stddev).clamp(0.005, 0.995);
    let s_max = (score + 1.96 * stddev).clamp(0.005, 0.995);
    let elo_low = -400.0 * ((1.0 / s_min) - 1.0).log10();
    let elo_high = -400.0 * ((1.0 / s_max) - 1.0).log10();
    let elo_err = (elo_high - elo_low) * 0.5;

    // Normal approximation LOS
    let z = (score - 0.5) / stddev;
    let los = 0.5 * (1.0 + erf_approx(z / std::f64::consts::SQRT_2));

    (score * 100.0, elo_diff, elo_err, los * 100.0)
}

fn erf_approx(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let ax = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * ax);
    let y = 1.0
        - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
            + 0.254829592)
            * t
            * (-ax * ax).exp();
    sign * y
}

/// Runs a balanced UCI match: `self_bin` (Berserker) vs `opp_bin` (e.g. Stockfish 19)
pub fn run_uci_gauntlet(
    self_bin: &str,
    opp_bin: &str,
    pairs: u32,
    movetime_ms: u64,
    opp_elo_cap: Option<u32>,
    berserker_threads: u32,
) -> Result<GauntletReport, String> {
    let b_threads_str = berserker_threads.clamp(1, 16).to_string();
    let mut berserker = UciProc::spawn(
        self_bin,
        &[("Threads", &b_threads_str), ("Hash", "64"), ("OwnBook", "true")],
    )?;

    let elo_str;
    let mut opp_opts: Vec<(&str, &str)> = vec![("Threads", "1"), ("Hash", "32")];
    if let Some(cap) = opp_elo_cap {
        elo_str = cap.clamp(1320, 3190).to_string();
        opp_opts.push(("UCI_LimitStrength", "true"));
        opp_opts.push(("UCI_Elo", &elo_str));
    }
    let mut opp = UciProc::spawn(opp_bin, &opp_opts)?;

    let mut b_wins = 0u32;
    let mut draws = 0u32;
    let mut o_wins = 0u32;

    for pair_idx in 0..pairs.max(1) {
        let start_fen = GAUNTLET_FENS[(pair_idx as usize) % GAUNTLET_FENS.len()];
        for swap in 0..2 {
            let berserker_is_white = swap == 0;
            berserker.new_game()?;
            opp.new_game()?;

            let mut board = Board::from_fen(start_fen, false);
            let mut moves: Vec<String> = Vec::with_capacity(160);

            loop {
                let legal = board.generate_legal_moves(false);
                if legal.is_empty() {
                    if board.in_check() {
                        let white_won = board.stm == crate::types::Color::Black;
                        if white_won == berserker_is_white {
                            b_wins += 1;
                        } else {
                            o_wins += 1;
                        }
                    } else {
                        draws += 1;
                    }
                    break;
                }
                if board.halfmove >= 100 || board.is_repetition() || has_insufficient_material(&board) || moves.len() >= 220 {
                    draws += 1;
                    break;
                }

                let is_white_turn = board.stm == crate::types::Color::White;
                let berserker_to_move = is_white_turn == berserker_is_white;

                let mv_uci = if berserker_to_move {
                    berserker.bestmove(start_fen, &moves, movetime_ms)?
                } else {
                    opp.bestmove(start_fen, &moves, movetime_ms)?
                };

                if let Some(m) = board.parse_uci_move(&mv_uci) {
                    board.make_move(m);
                    moves.push(mv_uci);
                } else {
                    // Forfeit on illegal move
                    if berserker_to_move {
                        o_wins += 1;
                    } else {
                        b_wins += 1;
                    }
                    break;
                }
            }
        }
    }

    let (score_pct, elo_diff, elo_error_95, los_pct) = compute_elo_stats(b_wins, draws, o_wins);
    Ok(GauntletReport {
        opponent_name: opp.name.clone(),
        games_played: b_wins + draws + o_wins,
        berserker_wins: b_wins,
        draws,
        opponent_wins: o_wins,
        score_pct,
        elo_diff,
        elo_error_95,
        los_pct,
    })
}
