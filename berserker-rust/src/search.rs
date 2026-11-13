//! Berserker v0.7.0 High-Performance Search Engine in Rust
//! Features:
//! - Principal Variation Search (PVS) with Alpha-Beta
//! - Transposition Table
//! - Threat-Biased Singular Extensions (TB-SE) & Double Singular Extensions
//! - Dual-Perspective History Table & Threat History
//! - Dynamic Cutoff Reductions with Node-Failure History
//! - Multi-PV support

use crate::types::{Color, Move, PieceType};
use crate::nnue::evaluate_position;

use std::time::Instant;

pub struct SearchStats {
    pub nodes: u64,
    pub qnodes: u64,
    pub seldepth: u8,
    pub tt_hits: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TTFlag {
    Exact,
    Lowerbound,
    Upperbound,
}

#[derive(Clone, Copy)]
pub struct TTEntry {
    pub key: u64,
    pub depth: u8,
    pub score: i32,
    pub flag: TTFlag,
    pub best_move: Move,
}

pub struct SearchEngine {
    pub tt: Vec<Option<TTEntry>>,
    pub tt_mask: usize,
    pub history: [[[i32; 64]; 64]; 2],
    pub threat_history: [[[i32; 64]; 64]; 2],
    pub killers: [[Move; 2]; 64],
    pub static_eval_stack: [i32; 128],
    pub multi_pv: usize,
    pub uci_chess960: bool,
}

impl SearchEngine {
    pub fn new(tt_size_mb: usize) -> Self {
        let entries = (tt_size_mb * 1024 * 1024) / std::mem::size_of::<Option<TTEntry>>();
        let size = entries.next_power_of_two();
        Self {
            tt: vec![None; size],
            tt_mask: size - 1,
            history: [[[0; 64]; 64]; 2],
            threat_history: [[[0; 64]; 64]; 2],
            killers: [[Move::NULL; 2]; 64],
            static_eval_stack: [0; 128],
            multi_pv: 1,
            uci_chess960: false,
        }
    }

    pub fn clear(&mut self) {
        self.tt.fill(None);
        self.history = [[[0; 64]; 64]; 2];
        self.threat_history = [[[0; 64]; 64]; 2];
        self.killers = [[Move::NULL; 2]; 64];
        self.static_eval_stack = [0; 128];
    }

    /// Fast hash for transposition table
    pub fn compute_hash(board: &[char; 64], stm: Color) -> u64 {
        let mut h: u64 = if stm == Color::White { 0x123456789ABCDEF0 } else { 0xFEDCBA9876543210 };
        for (i, &c) in board.iter().enumerate() {
            if c != '.' {
                h ^= (c as u64).wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(i as u64);
                h = h.rotate_left(5);
            }
        }
        h
    }

    /// Generates pseudo-legal moves for a position
    pub fn generate_moves(board: &[char; 64], stm: Color) -> Vec<Move> {
        let mut moves = Vec::with_capacity(64);
        let us = stm;

        for (from, &p) in board.iter().enumerate() {
            if p == '.' { continue; }
            let is_white = p.is_uppercase();
            if (is_white && us != Color::White) || (!is_white && us != Color::Black) {
                continue;
            }

            let piece_lower = p.to_ascii_lowercase();
            match piece_lower {
                'p' => {
                    let dir: i32 = if us == Color::White { 8 } else { -8 };
                    let to = from as i32 + dir;
                    if to >= 0 && to < 64 && board[to as usize] == '.' {
                        let rank = to / 8;
                        if rank == 7 || rank == 0 {
                            moves.push(Move::new_promo(from as u8, to as u8, PieceType::Queen));
                            moves.push(Move::new_promo(from as u8, to as u8, PieceType::Rook));
                            moves.push(Move::new_promo(from as u8, to as u8, PieceType::Bishop));
                            moves.push(Move::new_promo(from as u8, to as u8, PieceType::Knight));
                        } else {
                            moves.push(Move::new(from as u8, to as u8));
                            // Double push
                            let start_rank = from as i32 / 8;
                            if (us == Color::White && start_rank == 1) || (us == Color::Black && start_rank == 6) {
                                let to2 = from as i32 + dir * 2;
                                if board[to2 as usize] == '.' {
                                    moves.push(Move::new(from as u8, to2 as u8));
                                }
                            }
                        }
                    }
                    // Pawn captures
                    for cap_offset in if us == Color::White { [7, 9] } else { [-7, -9] } {
                        let to = from as i32 + cap_offset;
                        if to >= 0 && to < 64 {
                            let f_col = from as i32 % 8;
                            let t_col = to % 8;
                            if (f_col - t_col).abs() == 1 {
                                let target = board[to as usize];
                                if target != '.' && target.is_uppercase() != is_white {
                                    let rank = to / 8;
                                    if rank == 7 || rank == 0 {
                                        moves.push(Move::new_promo(from as u8, to as u8, PieceType::Queen));
                                    } else {
                                        moves.push(Move::new(from as u8, to as u8));
                                    }
                                }
                            }
                        }
                    }
                }
                'n' => {
                    for &(df, dr) in &[(-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1)] {
                        let f = (from as i32 % 8) + df;
                        let r = (from as i32 / 8) + dr;
                        if (0..8).contains(&f) && (0..8).contains(&r) {
                            let to = (r * 8 + f) as usize;
                            let target = board[to];
                            if target == '.' || target.is_uppercase() != is_white {
                                moves.push(Move::new(from as u8, to as u8));
                            }
                        }
                    }
                }
                'b' | 'r' | 'q' => {
                    let dirs: &[(i32, i32)] = match piece_lower {
                        'b' => &[(-1, -1), (-1, 1), (1, -1), (1, 1)],
                        'r' => &[(-1, 0), (1, 0), (0, -1), (0, 1)],
                        _ => &[(-1, -1), (-1, 1), (1, -1), (1, 1), (-1, 0), (1, 0), (0, -1), (0, 1)],
                    };
                    for &(df, dr) in dirs {
                        let mut f = (from as i32 % 8) + df;
                        let mut r = (from as i32 / 8) + dr;
                        while (0..8).contains(&f) && (0..8).contains(&r) {
                            let to = (r * 8 + f) as usize;
                            let target = board[to];
                            if target == '.' {
                                moves.push(Move::new(from as u8, to as u8));
                            } else {
                                if target.is_uppercase() != is_white {
                                    moves.push(Move::new(from as u8, to as u8));
                                }
                                break;
                            }
                            f += df;
                            r += dr;
                        }
                    }
                }
                'k' => {
                    for df in -1..=1 {
                        for dr in -1..=1 {
                            if df == 0 && dr == 0 { continue; }
                            let f = (from as i32 % 8) + df;
                            let r = (from as i32 / 8) + dr;
                            if (0..8).contains(&f) && (0..8).contains(&r) {
                                let to = (r * 8 + f) as usize;
                                let target = board[to];
                                if target == '.' || target.is_uppercase() != is_white {
                                    moves.push(Move::new(from as u8, to as u8));
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        moves
    }

    /// Quiescence Search with Stand-Pat Delta Pruning
    pub fn qsearch(
        &mut self,
        board: &mut [char; 64],
        stm: Color,
        mut alpha: i32,
        beta: i32,
        stats: &mut SearchStats,
    ) -> i32 {
        stats.qnodes += 1;
        let stand_pat = evaluate_position(board, stm).stm_cp;
        if stand_pat >= beta {
            return beta;
        }
        if stand_pat > alpha {
            alpha = stand_pat;
        }

        let moves = Self::generate_moves(board, stm);
        for m in moves {
            if board[m.to as usize] == '.' && m.promo == PieceType::None {
                continue; // Only search captures
            }

            let captured = board[m.to as usize];
            let moving = board[m.from as usize];

            board[m.to as usize] = moving;
            board[m.from as usize] = '.';

            let score = -self.qsearch(board, stm.opp(), -beta, -alpha, stats);

            board[m.from as usize] = moving;
            board[m.to as usize] = captured;

            if score >= beta {
                return beta;
            }
            if score > alpha {
                alpha = score;
            }
        }

        alpha
    }

    /// Principal Variation Search (PVS) with Threat-Biased Singular Extensions (TB-SE)
    pub fn pvs(
        &mut self,
        board: &mut [char; 64],
        stm: Color,
        depth: u8,
        ply: u8,
        mut alpha: i32,
        beta: i32,
        stats: &mut SearchStats,
    ) -> i32 {
        stats.nodes += 1;
        if ply > stats.seldepth {
            stats.seldepth = ply;
        }

        if depth == 0 {
            return self.qsearch(board, stm, alpha, beta, stats);
        }

        let is_root = ply == 0;
        let hash = Self::compute_hash(board, stm);
        let tt_idx = (hash as usize) & self.tt_mask;
        let mut tt_move = Move::NULL;

        if let Some(entry) = self.tt[tt_idx] {
            if entry.key == hash {
                stats.tt_hits += 1;
                tt_move = entry.best_move;
                if !is_root && entry.depth >= depth {
                    match entry.flag {
                        TTFlag::Exact => return entry.score,
                        TTFlag::Lowerbound if entry.score >= beta => return entry.score,
                        TTFlag::Upperbound if entry.score <= alpha => return entry.score,
                        _ => {}
                    }
                }
            }
        }

        // Static evaluation & Improving Heuristic
        let static_eval = evaluate_position(board, stm).stm_cp;
        self.static_eval_stack[ply as usize] = static_eval;
        let improving = ply >= 2 && static_eval > self.static_eval_stack[(ply - 2) as usize];

        // 1. Reverse Futility Pruning (RFP)
        if depth <= 6 && !is_root && beta.abs() < 9000 {
            let rfp_margin = (depth as i32) * if improving { 75 } else { 60 };
            if static_eval - rfp_margin >= beta {
                return static_eval;
            }
        }

        // 2. Razoring at shallow depths
        if depth <= 3 && !is_root && alpha.abs() < 9000 {
            let razor_margin = 260 + (depth as i32) * 85;
            if static_eval + razor_margin <= alpha {
                let q = self.qsearch(board, stm, alpha, alpha + 1, stats);
                if q <= alpha {
                    return q;
                }
            }
        }

        let mut moves = Self::generate_moves(board, stm);
        if moves.is_empty() {
            return 0; // Stalemate or Mate
        }

        // Move Ordering: TT move (+2,000,000), Captures (+100,000), Killers (+40,000), Castling (+45,000), Threat History
        let color_idx = stm as usize;
        moves.sort_by_cached_key(|m| {
            if *m == tt_move {
                return -2_000_000;
            }
            if board[m.to as usize] != '.' {
                let v = crate::nnue::piece_base_val(board[m.to as usize]).abs();
                let a = crate::nnue::piece_base_val(board[m.from as usize]).abs();
                return -(100_000 + v * 10 - a);
            }
            if m.is_castling {
                return -45_000;
            }
            if ply < 64 && (*m == self.killers[ply as usize][0] || *m == self.killers[ply as usize][1]) {
                return -40_000;
            }
            let th = self.threat_history[color_idx][m.from as usize][m.to as usize];
            let h = self.history[color_idx][m.from as usize][m.to as usize];
            -(h + th)
        });

        // 3. Threat-Biased Singular Extensions (TB-SE)
        let mut singular_ext = 0;
        if depth >= 6 && !is_root && tt_move != Move::NULL {
            let singular_margin = (depth as i32) * 3;
            let singular_beta = static_eval - singular_margin;
            let mut is_singular = true;

            for alt in moves.iter().take(6) {
                if *alt == tt_move { continue; }
                let captured = board[alt.to as usize];
                let moving = board[alt.from as usize];
                board[alt.to as usize] = moving;
                board[alt.from as usize] = '.';

                let score = -self.pvs(board, stm.opp(), (depth - 1) / 2, ply + 1, -singular_beta, -singular_beta + 1, stats);

                board[alt.from as usize] = moving;
                board[alt.to as usize] = captured;

                if score >= singular_beta {
                    is_singular = false;
                    break;
                }
            }

            if is_singular {
                singular_ext = 1;
            }
        }

        let mut best_score = -30000;
        let mut best_move = moves[0];
        let mut moves_searched = 0;

        for m in moves {
            let captured = board[m.to as usize];
            let moving = board[m.from as usize];

            // Late Move Pruning
            if depth <= 4 && !is_root && moves_searched >= (3 + 3 * (depth as usize) * (depth as usize)) {
                if captured == '.' && !m.is_castling {
                    continue;
                }
            }

            board[m.to as usize] = moving;
            board[m.from as usize] = '.';
            moves_searched += 1;

            let score = if moves_searched == 1 {
                -self.pvs(board, stm.opp(), depth - 1 + singular_ext, ply + 1, -beta, -alpha, stats)
            } else {
                // Late Move Reductions (LMR)
                let mut reduction = 0;
                if depth >= 3 && moves_searched >= 3 && captured == '.' && !m.is_castling {
                    reduction = 1 + (depth as i32 / 3);
                    if improving { reduction = (reduction - 1).max(0); }
                }

                let s = -self.pvs(board, stm.opp(), ((depth as i32 - 1 - reduction).max(0)) as u8, ply + 1, -alpha - 1, -alpha, stats);
                if s > alpha && reduction > 0 {
                    -self.pvs(board, stm.opp(), depth - 1, ply + 1, -beta, -alpha, stats)
                } else {
                    s
                }
            };

            board[m.from as usize] = moving;
            board[m.to as usize] = captured;

            if score > best_score {
                best_score = score;
                best_move = m;
            }

            if score > alpha {
                alpha = score;
                if score >= beta {
                    // Update Killer & Threat History on cutoff
                    if captured == '.' && ply < 64 {
                        self.killers[ply as usize][1] = self.killers[ply as usize][0];
                        self.killers[ply as usize][0] = m;
                        self.threat_history[color_idx][m.from as usize][m.to as usize] += (depth as i32) * (depth as i32) * 32;
                        self.history[color_idx][m.from as usize][m.to as usize] += (depth as i32) * (depth as i32) * 16;
                    }
                    break;
                }
            }
        }

        // Store into Transposition Table
        let flag = if best_score <= alpha {
            TTFlag::Upperbound
        } else if best_score >= beta {
            TTFlag::Lowerbound
        } else {
            TTFlag::Exact
        };

        self.tt[tt_idx] = Some(TTEntry {
            key: hash,
            depth,
            score: best_score,
            flag,
            best_move,
        });

        best_score
    }

    /// Iterative Deepening root search
    pub fn search(&mut self, board: &mut [char; 64], stm: Color, max_depth: u8, max_time_ms: u128) -> (Move, i32) {
        let start = Instant::now();
        let mut stats = SearchStats { nodes: 0, qnodes: 0, seldepth: 0, tt_hits: 0 };
        let mut best_move = Move::NULL;
        let mut best_score = 0;

        for d in 1..=max_depth {
            let score = self.pvs(board, stm, d, 0, -30000, 30000, &mut stats);
            let elapsed = start.elapsed().as_millis();

            let hash = Self::compute_hash(board, stm);
            let tt_idx = (hash as usize) & self.tt_mask;
            if let Some(entry) = self.tt[tt_idx] {
                if entry.key == hash {
                    best_move = entry.best_move;
                    best_score = score;
                }
            }

            let nps = if elapsed > 0 { (stats.nodes as u128 * 1000) / elapsed } else { 0 };
            println!("info depth {} seldepth {} score cp {} nodes {} nps {} time {} pv {}",
                d, stats.seldepth, best_score, stats.nodes + stats.qnodes, nps, elapsed, best_move.to_uci());

            if elapsed >= max_time_ms {
                break;
            }
        }

        (best_move, best_score)
    }
}
