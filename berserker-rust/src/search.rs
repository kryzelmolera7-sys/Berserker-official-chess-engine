//! Berserker v0.7.0 Native Rust Search Engine
//!
//! Architecture:
//! - Bitboard-backed Principal Variation Search (PVS) with Aspiration Windows
//! - Syzygy 3-6 Man Tablebase Leaf Probing
//! - Static Exchange Evaluation (SEE) Move Ordering & Q-Search Pruning
//! - Threat-Biased & Double Singular Extensions (TB-SE)
//! - Petrosian Threat-Space Prophylaxis (opponent threat anticipation)
//! - Continuation History (1-Ply Conthist), Capture History, Countermove, Threat History & History Malus
//! - Pawn Structure Correction History (CorrHist)
//! - Null Move Pruning (NMP), ProbCut, Reverse Futility Pruning (RFP), Razoring, IIR, LMR, LMP
//! - Full Multi-PV (1..=5) & Chess960 UCI Compliance

use crate::board::{bishop_attacks, rook_attacks, Board};
use crate::nnue::{evaluate_board, piece_base_val};
use crate::tablebase::{probe_tablebase, TablebaseWdl};
use crate::types::{Color, Move, PieceType};
use std::time::Instant;

const INF: i32 = 30000;
const MATE_SCORE: i32 = 25000;
const MAX_PLY: usize = 120;

pub struct SearchStats {
    pub nodes: u64,
    pub qnodes: u64,
    pub seldepth: u8,
    pub tt_hits: u64,
    pub tb_hits: u64,
    pub aborted: bool,
    pub start_time: Instant,
    pub time_limit_ms: u128,
}

impl SearchStats {
    #[inline(always)]
    fn check_time(&mut self) -> bool {
        if self.aborted {
            return true;
        }
        if ((self.nodes + self.qnodes) & 2047) == 0 && self.start_time.elapsed().as_millis() >= self.time_limit_ms {
            self.aborted = true;
            return true;
        }
        false
    }
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

#[derive(Clone)]
pub struct MultiPvLine {
    pub rank: usize,
    pub score_cp: i32,
    pub best_move: Move,
    pub pv: Vec<Move>,
}

pub struct SearchEngine {
    pub tt: Vec<Option<TTEntry>>,
    pub tt_mask: usize,
    pub history: [[[i32; 64]; 64]; 2],
    pub threat_history: [[[i32; 64]; 64]; 2],
    pub cap_history: [[[i32; 64]; 64]; 2],
    pub conthist: Vec<i32>, // [prev_pt*64 + prev_to][curr_pt*64 + curr_to] => 768*768
    pub countermoves: [[[Move; 64]; 64]; 2],
    pub pawn_corrhist: [[i32; 4096]; 2],
    pub killers: [[Move; 2]; MAX_PLY],
    pub static_eval_stack: [i32; MAX_PLY],
    pub multi_pv: usize,
    pub uci_chess960: bool,
}

impl SearchEngine {
    pub fn new(tt_size_mb: usize) -> Self {
        let entry_size = std::mem::size_of::<Option<TTEntry>>().max(1);
        let entries = ((tt_size_mb.max(1) * 1024 * 1024) / entry_size).max(1024);
        let size = entries.next_power_of_two();
        Self {
            tt: vec![None; size],
            tt_mask: size - 1,
            history: [[[0; 64]; 64]; 2],
            threat_history: [[[0; 64]; 64]; 2],
            cap_history: [[[0; 64]; 64]; 2],
            conthist: vec![0; 768 * 768],
            countermoves: [[[Move::NULL; 64]; 64]; 2],
            pawn_corrhist: [[0; 4096]; 2],
            killers: [[Move::NULL; 2]; MAX_PLY],
            static_eval_stack: [0; MAX_PLY],
            multi_pv: 1,
            uci_chess960: false,
        }
    }

    pub fn resize_tt(&mut self, tt_size_mb: usize) {
        let entry_size = std::mem::size_of::<Option<TTEntry>>().max(1);
        let entries = ((tt_size_mb.max(1) * 1024 * 1024) / entry_size).max(1024);
        let size = entries.next_power_of_two();
        self.tt = vec![None; size];
        self.tt_mask = size - 1;
    }

    pub fn clear(&mut self) {
        self.tt.fill(None);
        self.history = [[[0; 64]; 64]; 2];
        self.threat_history = [[[0; 64]; 64]; 2];
        self.cap_history = [[[0; 64]; 64]; 2];
        self.conthist.fill(0);
        self.countermoves = [[[Move::NULL; 64]; 64]; 2];
        self.pawn_corrhist = [[0; 4096]; 2];
        self.killers = [[Move::NULL; 2]; MAX_PLY];
        self.static_eval_stack = [0; MAX_PLY];
    }

    #[inline(always)]
    fn pawn_key(board: &Board) -> usize {
        let wp = board.pieces[0][PieceType::Pawn as usize];
        let bp = board.pieces[1][PieceType::Pawn as usize];
        let mixed = wp.wrapping_mul(0x9E3779B97F4A7C15) ^ bp.wrapping_mul(0xBF58476D1CE4E5B9);
        ((mixed >> 32) ^ mixed) as usize & 0xFFF
    }

    #[inline(always)]
    fn piece_idx12(color: Color, pt: PieceType) -> usize {
        (color.idx() * 6 + (pt as usize).min(5)).min(11)
    }

    /// Identifies top opponent threat target squares via a fast 1-ply threat probe
    fn detect_opponent_threat_squares(&mut self, board: &mut Board) -> u64 {
        if board.in_check() {
            return 0;
        }
        let (old_ep, old_hash) = board.make_null_move();
        let opp_captures = board.generate_legal_moves(true);
        let mut threat_mask = 0u64;
        for m in opp_captures {
            let victim_val = piece_base_val(board.squares[m.to as usize]);
            if victim_val >= 300 || board.see(m) > 50 {
                threat_mask |= (1u64 << m.to) | (1u64 << m.from);
            }
        }
        board.unmake_null_move(old_ep, old_hash);
        threat_mask
    }

    /// Scores move for alpha-beta move ordering (higher = search first)
    #[inline]
    fn score_move(
        &self,
        board: &Board,
        m: Move,
        tt_move: Move,
        ply: usize,
        prev_move: Move,
        prev_pt: PieceType,
        prophylaxis_mask: u64,
    ) -> i32 {
        if m == tt_move {
            return 2_000_000;
        }
        let us = board.stm;
        let c = us.idx();
        let to_ch = board.squares[m.to as usize];
        let is_capture = to_ch != '.' || m.is_en_passant();

        if is_capture || m.promo != PieceType::None {
            let victim_val = if m.is_en_passant() {
                100
            } else {
                piece_base_val(to_ch)
            };
            let attacker_val = piece_base_val(board.squares[m.from as usize]);
            let cap_hist = self.cap_history[c][m.from as usize][m.to as usize];
            let see_val = board.see(m);
            let mvv_lva = victim_val * 10 - attacker_val
                + if m.promo != PieceType::None { m.promo.value_cp() } else { 0 };
            if see_val >= 0 {
                return 150_000 + mvv_lva + (cap_hist / 4).clamp(-10_000, 20_000);
            } else {
                // Losing capture goes after quiet moves!
                return -50_000 + mvv_lva + (cap_hist / 4).clamp(-10_000, 10_000);
            }
        }

        // Killer moves
        if ply < MAX_PLY {
            if m == self.killers[ply][0] {
                return 60_000;
            }
            if m == self.killers[ply][1] {
                return 50_000;
            }
        }

        // Countermove
        if prev_move != Move::NULL
            && self.countermoves[c][prev_move.from as usize][prev_move.to as usize] == m
        {
            return 48_000;
        }

        // Castling priority (King safety & Chess960 rook activation)
        if m.is_castling() {
            return 45_000;
        }

        // Continuation History + Butterfly History + Dual-Perspective Threat History
        let moving_pt = PieceType::from_char(board.squares[m.from as usize]);
        let conthist_score = if prev_move != Move::NULL && prev_pt != PieceType::None {
            let prev_idx = Self::piece_idx12(us.opp(), prev_pt) * 64 + (prev_move.to as usize);
            let curr_idx = Self::piece_idx12(us, moving_pt) * 64 + (m.to as usize);
            self.conthist[prev_idx * 768 + curr_idx]
        } else {
            0
        };

        let mut quiet_score = self.history[c][m.from as usize][m.to as usize]
            + self.threat_history[c][m.from as usize][m.to as usize]
            + (conthist_score / 2);

        // Petrosian Prophylaxis bonus for moves interacting with threat corridors
        if prophylaxis_mask != 0
            && (((1u64 << m.to) & prophylaxis_mask) != 0 || ((1u64 << m.from) & prophylaxis_mask) != 0)
        {
            quiet_score += 8_000;
        }

        quiet_score.clamp(-40_000, 44_000)
    }

    #[inline]
    fn update_history_gravity(slot: &mut i32, bonus: i32) {
        let clamped = bonus.clamp(-16384, 16384);
        *slot += clamped - ((*slot) * clamped.abs()) / 16384;
    }

    #[inline]
    fn is_direct_threat_move(board: &Board, m: Move) -> bool {
        let moving_pt = PieceType::from_char(board.squares[m.from as usize]);
        let them_occ = board.occ[board.stm.opp().idx()];
        match moving_pt {
            PieceType::Knight => false, // Fast approximation or check attack mask
            PieceType::Bishop => (bishop_attacks(m.to, board.occ_all) & them_occ) != 0,
            PieceType::Rook => (rook_attacks(m.to, board.occ_all) & them_occ) != 0,
            PieceType::Queen => {
                ((bishop_attacks(m.to, board.occ_all) | rook_attacks(m.to, board.occ_all))
                    & them_occ)
                    != 0
            }
            _ => false,
        }
    }

    /// Quiescence Search with Check Evasions, Stand-Pat Delta Pruning & SEE Pruning
    pub fn qsearch(
        &mut self,
        board: &mut Board,
        ply: usize,
        mut alpha: i32,
        beta: i32,
        stats: &mut SearchStats,
    ) -> i32 {
        if stats.check_time() {
            return 0;
        }
        stats.qnodes += 1;
        if (ply as u8) > stats.seldepth {
            stats.seldepth = ply as u8;
        }

        if ply >= MAX_PLY - 1 {
            return evaluate_board(board).stm_cp;
        }

        if board.halfmove >= 100 || board.is_repetition() {
            return 0;
        }

        let in_check = board.in_check();
        let mut stand_pat = -INF;

        if !in_check {
            stand_pat = evaluate_board(board).stm_cp;
            if stand_pat >= beta {
                return beta;
            }
            // Delta pruning: if even winning a Queen cannot lift us to alpha
            if stand_pat + 950 < alpha {
                return alpha;
            }
            if stand_pat > alpha {
                alpha = stand_pat;
            }
        }

        // If in check, MUST generate all evasions; otherwise captures/promotions only
        let mut moves = board.generate_pseudo_legal(!in_check);
        moves.sort_by_cached_key(|&m| {
            let v = if m.is_en_passant() {
                100
            } else {
                piece_base_val(board.squares[m.to as usize])
            };
            let a = piece_base_val(board.squares[m.from as usize]);
            let p = if m.promo != PieceType::None { m.promo.value_cp() } else { 0 };
            -(v * 10 - a + p)
        });

        let mut legal_count = 0;
        let mut best_score = if in_check { -INF } else { stand_pat };

        for m in moves {
            // SEE Pruning on losing captures when NOT in check
            if !in_check && m.promo == PieceType::None && board.see(m) < 0 {
                continue;
            }

            if let Some(undo) = board.make_move(m) {
                legal_count += 1;
                let score = -self.qsearch(board, ply + 1, -beta, -alpha, stats);
                board.unmake_move(m, undo);

                if stats.aborted {
                    return 0;
                }
                if score > best_score {
                    best_score = score;
                }
                if score >= beta {
                    return beta;
                }
                if score > alpha {
                    alpha = score;
                }
            }
        }

        if in_check && legal_count == 0 {
            return -MATE_SCORE + ply as i32;
        }

        alpha
    }

    /// Principal Variation Search (PVS) with Full Selectivity & TB-SE
    #[allow(clippy::too_many_arguments)]
    pub fn pvs(
        &mut self,
        board: &mut Board,
        mut depth: i32,
        ply: usize,
        mut alpha: i32,
        beta: i32,
        stats: &mut SearchStats,
        pv_out: &mut Vec<Move>,
        prev_move: Move,
        prev_pt: PieceType,
        excluded_root_moves: Option<&[Move]>,
        allow_null: bool,
    ) -> i32 {
        pv_out.clear();
        if stats.check_time() {
            return 0;
        }

        let is_root = ply == 0;
        let is_pv = beta - alpha > 1;

        // 50-move & Repetition draws (never override root check before verifying moves)
        if !is_root && (board.halfmove >= 100 || board.is_repetition()) {
            return 0;
        }

        if ply >= MAX_PLY - 1 {
            return evaluate_board(board).stm_cp;
        }

        let in_check = board.in_check();
        // Check extension: extend 1 ply when king is under check
        if in_check {
            depth += 1;
        }

        if depth <= 0 {
            return self.qsearch(board, ply, alpha, beta, stats);
        }

        stats.nodes += 1;
        if (ply as u8) > stats.seldepth {
            stats.seldepth = ply as u8;
        }

        // Syzygy 3-5 Man Tablebase Leaf Probe
        if !is_root && board.occ_all.count_ones() <= 5 && board.castling_rights == 0 {
            let (wp, bp) = board.collect_pieces();
            let tb = probe_tablebase(&wp, &bp, board.stm);
            if tb.is_hit && tb.wdl != TablebaseWdl::Unknown {
                stats.tb_hits += 1;
                return match tb.wdl {
                    TablebaseWdl::Win => tb.score_cp - ply as i32,
                    TablebaseWdl::Loss => tb.score_cp + ply as i32,
                    TablebaseWdl::Draw => 0,
                    TablebaseWdl::Unknown => 0,
                };
            }
        }

        // Mate Distance Pruning
        if !is_root {
            alpha = alpha.max(-MATE_SCORE + ply as i32);
            let mate_beta = beta.min(MATE_SCORE - ply as i32 - 1);
            if alpha >= mate_beta {
                return alpha;
            }
        }

        // Transposition Table Probe
        let hash = board.hash;
        let tt_idx = (hash as usize) & self.tt_mask;
        let mut tt_move = Move::NULL;
        let mut tt_score = 0;
        let mut tt_hit_valid = false;
        let mut tt_entry_depth = 0;
        let mut tt_flag = TTFlag::Upperbound;

        if excluded_root_moves.is_none() {
            if let Some(entry) = self.tt[tt_idx] {
                if entry.key == hash {
                    stats.tt_hits += 1;
                    tt_move = entry.best_move;
                    tt_score = entry.score;
                    tt_hit_valid = true;
                    tt_entry_depth = entry.depth as i32;
                    tt_flag = entry.flag;
                    if !is_root && !is_pv && entry.depth as i32 >= depth {
                        match entry.flag {
                            TTFlag::Exact => return entry.score,
                            TTFlag::Lowerbound if entry.score >= beta => return entry.score,
                            TTFlag::Upperbound if entry.score <= alpha => return entry.score,
                            _ => {}
                        }
                    }
                }
            }
        }

        // Static Evaluation + Pawn Correction History
        let raw_eval = if in_check {
            -INF
        } else {
            evaluate_board(board).stm_cp
        };
        let p_key = Self::pawn_key(board);
        let corr = if in_check {
            0
        } else {
            self.pawn_corrhist[board.stm.idx()][p_key] / 64
        };
        let static_eval = if in_check {
            -INF
        } else {
            (raw_eval + corr).clamp(-24000, 24000)
        };
        self.static_eval_stack[ply] = static_eval;
        let improving = !in_check && ply >= 2 && static_eval > self.static_eval_stack[ply - 2];

        // 1. Reverse Futility Pruning (RFP / Static Null Move Pruning)
        if !is_pv && !in_check && depth <= 6 && beta.abs() < 9000 {
            let margin = depth * if improving { 75 } else { 60 };
            if static_eval - margin >= beta {
                return static_eval;
            }
        }

        // 2. Razoring (Depth 1..=3)
        if !is_pv && !in_check && depth <= 3 && alpha.abs() < 9000 {
            let razor_margin = 260 + depth * 85;
            if static_eval + razor_margin <= alpha {
                let q = self.qsearch(board, ply, alpha, alpha + 1, stats);
                if q <= alpha {
                    return q;
                }
            }
        }

        // 3. Null Move Pruning (NMP)
        if allow_null
            && !is_pv
            && !in_check
            && depth >= 3
            && static_eval >= beta
            && beta.abs() < 9000
            && board.has_non_pawn_material(board.stm)
        {
            let r = 3 + depth / 6;
            let (old_ep, old_hash) = board.make_null_move();
            let mut null_pv = Vec::new();
            let null_score = -self.pvs(
                board,
                depth - 1 - r,
                ply + 1,
                -beta,
                -beta + 1,
                stats,
                &mut null_pv,
                Move::NULL,
                PieceType::None,
                None,
                false,
            );
            board.unmake_null_move(old_ep, old_hash);
            if stats.aborted {
                return 0;
            }
            if null_score >= beta {
                return if null_score >= 20000 { beta } else { null_score };
            }
        }

        // 4. Internal Iterative Reductions (IIR) when no TT move is present
        if depth >= 4 && tt_move == Move::NULL && !in_check {
            depth -= 1;
        }

        // 5. Generate & Score Pseudo-Legal Moves (with Petrosian Prophylaxis at Root)
        let prophylaxis_mask = if is_root {
            self.detect_opponent_threat_squares(board)
        } else {
            0
        };

        let mut moves = board.generate_pseudo_legal(false);
        moves.sort_by_cached_key(|&m| {
            -self.score_move(board, m, tt_move, ply, prev_move, prev_pt, prophylaxis_mask)
        });

        // 6. ProbCut at depth >= 5 for tactical beta-cutoffs
        let probcut_beta = beta + 185;
        if !is_pv && !in_check && depth >= 5 && beta.abs() < 9000 && static_eval >= probcut_beta - 80 {
            for &m in &moves {
                if board.squares[m.to as usize] == '.' && m.promo == PieceType::None {
                    continue;
                }
                if board.see(m) < 100 {
                    continue;
                }
                if let Some(undo) = board.make_move(m) {
                    let mut p_pv = Vec::new();
                    let p_score = -self.pvs(
                        board,
                        depth - 4,
                        ply + 1,
                        -probcut_beta,
                        -probcut_beta + 1,
                        stats,
                        &mut p_pv,
                        m,
                        PieceType::from_char(board.squares[m.to as usize]),
                        None,
                        true,
                    );
                    board.unmake_move(m, undo);
                    if stats.aborted {
                        return 0;
                    }
                    if p_score >= probcut_beta {
                        return p_score;
                    }
                }
            }
        }

        // 7. Threat-Biased Singular & Double Singular Extensions
        let mut singular_ext = 0;
        if !is_root
            && depth >= 6
            && tt_hit_valid
            && tt_move != Move::NULL
            && tt_entry_depth >= depth - 3
            && tt_flag != TTFlag::Upperbound
            && tt_score.abs() < 15000
        {
            let singular_margin = depth * 3;
            let singular_beta = tt_score - singular_margin;
            let singular_depth = (depth - 1) / 2;
            let mut multi_cut_count = 0;
            let mut is_singular = true;

            for &alt in moves.iter().take(8) {
                if alt == tt_move {
                    continue;
                }
                let moving_pt = PieceType::from_char(board.squares[alt.from as usize]);
                if let Some(undo) = board.make_move(alt) {
                    let mut s_pv = Vec::new();
                    let s = -self.pvs(
                        board,
                        singular_depth,
                        ply + 1,
                        -singular_beta,
                        -singular_beta + 1,
                        stats,
                        &mut s_pv,
                        alt,
                        moving_pt,
                        None,
                        true,
                    );
                    board.unmake_move(alt, undo);
                    if stats.aborted {
                        return 0;
                    }
                    if s >= singular_beta {
                        is_singular = false;
                        if !is_pv && singular_beta >= beta {
                            multi_cut_count += 1;
                            if multi_cut_count >= 2 {
                                return singular_beta; // Singular Multi-Cut!
                            }
                        }
                        break;
                    }
                }
            }

            if is_singular {
                // Double Singular Check
                let double_beta = singular_beta - singular_margin;
                let mut is_double = true;
                for &alt in moves.iter().take(5) {
                    if alt == tt_move {
                        continue;
                    }
                    let moving_pt = PieceType::from_char(board.squares[alt.from as usize]);
                    if let Some(undo) = board.make_move(alt) {
                        let mut s_pv = Vec::new();
                        let s = -self.pvs(
                            board,
                            singular_depth,
                            ply + 1,
                            -double_beta,
                            -double_beta + 1,
                            stats,
                            &mut s_pv,
                            alt,
                            moving_pt,
                            None,
                            true,
                        );
                        board.unmake_move(alt, undo);
                        if s >= double_beta {
                            is_double = false;
                            break;
                        }
                    }
                }
                singular_ext = if is_double { 2 } else { 1 };
            }
        }

        let orig_alpha = alpha;
        let mut best_score = -INF;
        let mut best_move = Move::NULL;
        let mut legal_moves_searched = 0usize;
        let mut quiets_searched: Vec<(Move, PieceType)> = Vec::with_capacity(32);
        let mut captures_searched: Vec<Move> = Vec::with_capacity(16);

        for m in moves {
            if let Some(excl) = excluded_root_moves {
                if excl.contains(&m) {
                    continue;
                }
            }

            let is_capture = board.squares[m.to as usize] != '.' || m.is_en_passant();
            let is_promo = m.promo != PieceType::None;
            let moving_pt = PieceType::from_char(board.squares[m.from as usize]);

            // 8. Late Move Pruning (LMP) — shield castling, captures, promos, checks
            if !is_root && !is_pv && !in_check && depth <= 4 {
                let lmp_limit = (3 + depth * depth) / if improving { 1 } else { 2 };
                if legal_moves_searched as i32 >= lmp_limit
                    && !is_capture
                    && !is_promo
                    && !m.is_castling()
                {
                    continue;
                }
            }

            // 9. Futility Pruning at shallow depths
            if !is_root
                && !is_pv
                && !in_check
                && depth <= 2
                && alpha.abs() < 9000
                && !is_capture
                && !is_promo
                && !m.is_castling()
                && static_eval + 135 * depth <= alpha
            {
                continue;
            }

            let is_threat = !is_capture && Self::is_direct_threat_move(board, m);

            let undo = match board.make_move(m) {
                Some(u) => u,
                None => continue, // Illegal move (leaves king in check)
            };

            let gives_check = board.in_check();
            legal_moves_searched += 1;

            // Passed pawn 7th rank extension
            let to_rank = m.to / 8;
            let pawn_push_ext = if moving_pt == PieceType::Pawn
                && ((board.stm == Color::Black && to_rank == 6)
                    || (board.stm == Color::White && to_rank == 1))
            {
                1
            } else {
                0
            };

            let ext = if legal_moves_searched == 1 && m == tt_move {
                singular_ext.max(pawn_push_ext)
            } else {
                pawn_push_ext
            };

            let new_depth = depth - 1 + ext;
            let mut child_pv = Vec::new();

            let score = if legal_moves_searched == 1 {
                -self.pvs(
                    board,
                    new_depth,
                    ply + 1,
                    -beta,
                    -alpha,
                    stats,
                    &mut child_pv,
                    m,
                    moving_pt,
                    None,
                    true,
                )
            } else {
                // 10. Dynamic Late Move Reductions (LMR) with History Dampening & Threat Shield
                let mut r = 0;
                if depth >= 3
                    && legal_moves_searched >= 3
                    && !is_capture
                    && !is_promo
                    && !m.is_castling()
                    && !in_check
                    && !gives_check
                {
                    let d_f = (depth as f32).ln();
                    let m_f = (legal_moves_searched as f32).ln();
                    r = (0.75 + d_f * m_f / 2.2) as i32;
                    if !is_pv {
                        r += 1;
                    }
                    if !improving {
                        r += 1;
                    }

                    let hist = self.history[board.stm.opp().idx()][m.from as usize][m.to as usize]
                        + self.threat_history[board.stm.opp().idx()][m.from as usize][m.to as usize];
                    if hist > 10_000 {
                        r -= 2;
                    } else if hist > 3_500 {
                        r -= 1;
                    } else if hist < -4_000 {
                        r += 1;
                    }
                    if is_threat {
                        r -= 1;
                    }
                    r = r.clamp(0, new_depth - 1);
                }

                // PVS Zero-Window Search
                let mut s = -self.pvs(
                    board,
                    new_depth - r,
                    ply + 1,
                    -alpha - 1,
                    -alpha,
                    stats,
                    &mut child_pv,
                    m,
                    moving_pt,
                    None,
                    true,
                );

                // Re-search at full depth if LMR failed high
                if s > alpha && r > 0 {
                    child_pv.clear();
                    s = -self.pvs(
                        board,
                        new_depth,
                        ply + 1,
                        -alpha - 1,
                        -alpha,
                        stats,
                        &mut child_pv,
                        m,
                        moving_pt,
                        None,
                        true,
                    );
                }

                // Full-window PV re-search if still beating alpha
                if s > alpha && s < beta {
                    child_pv.clear();
                    s = -self.pvs(
                        board,
                        new_depth,
                        ply + 1,
                        -beta,
                        -alpha,
                        stats,
                        &mut child_pv,
                        m,
                        moving_pt,
                        None,
                        true,
                    );
                }
                s
            };

            board.unmake_move(m, undo);

            if stats.aborted {
                return 0;
            }

            if score > best_score {
                best_score = score;
                best_move = m;
                if score > alpha {
                    alpha = score;
                    pv_out.clear();
                    pv_out.push(m);
                    pv_out.extend_from_slice(&child_pv);
                }
            }

            if score >= beta {
                let c = board.stm.idx();
                let bonus = (depth * depth * 32).min(16384);
                if !is_capture && !is_promo {
                    if ply < MAX_PLY {
                        if self.killers[ply][0] != m {
                            self.killers[ply][1] = self.killers[ply][0];
                            self.killers[ply][0] = m;
                        }
                    }
                    if prev_move != Move::NULL {
                        self.countermoves[c][prev_move.from as usize][prev_move.to as usize] = m;
                    }
                    Self::update_history_gravity(
                        &mut self.history[c][m.from as usize][m.to as usize],
                        bonus,
                    );
                    if is_threat || gives_check || (((1u64 << m.to) & prophylaxis_mask) != 0) {
                        Self::update_history_gravity(
                            &mut self.threat_history[c][m.from as usize][m.to as usize],
                            bonus,
                        );
                    }
                    if prev_move != Move::NULL && prev_pt != PieceType::None {
                        let prev_idx =
                            Self::piece_idx12(board.stm.opp(), prev_pt) * 64 + (prev_move.to as usize);
                        let curr_idx = Self::piece_idx12(board.stm, moving_pt) * 64 + (m.to as usize);
                        Self::update_history_gravity(
                            &mut self.conthist[prev_idx * 768 + curr_idx],
                            bonus,
                        );
                    }

                    // History Malus on previously searched quiet moves that failed to cut off
                    for &(qm, qpt) in &quiets_searched {
                        Self::update_history_gravity(
                            &mut self.history[c][qm.from as usize][qm.to as usize],
                            -(bonus / 2),
                        );
                        if prev_move != Move::NULL && prev_pt != PieceType::None {
                            let prev_idx = Self::piece_idx12(board.stm.opp(), prev_pt) * 64
                                + (prev_move.to as usize);
                            let curr_idx = Self::piece_idx12(board.stm, qpt) * 64 + (qm.to as usize);
                            Self::update_history_gravity(
                                &mut self.conthist[prev_idx * 768 + curr_idx],
                                -(bonus / 2),
                            );
                        }
                    }
                } else {
                    Self::update_history_gravity(
                        &mut self.cap_history[c][m.from as usize][m.to as usize],
                        bonus,
                    );
                    for &cm in &captures_searched {
                        Self::update_history_gravity(
                            &mut self.cap_history[c][cm.from as usize][cm.to as usize],
                            -(bonus / 2),
                        );
                    }
                }
                break;
            }

            if !is_capture && !is_promo {
                quiets_searched.push((m, moving_pt));
            } else {
                captures_searched.push(m);
            }
        }

        // Handle terminal Checkmate vs Stalemate!
        if legal_moves_searched == 0 {
            return if excluded_root_moves.is_some() {
                -INF
            } else if in_check {
                -MATE_SCORE + ply as i32
            } else {
                0
            };
        }

        // Update Correction History
        if !in_check
            && best_score.abs() < 15000
            && (best_move == Move::NULL
                || (board.squares[best_move.to as usize] == '.' && !best_move.is_en_passant()))
        {
            let diff = ((best_score - static_eval) * depth.min(8)).clamp(-1024, 1024);
            let slot = &mut self.pawn_corrhist[board.stm.idx()][p_key];
            *slot = ((*slot * 15) + diff) / 16;
            *slot = (*slot).clamp(-8192, 8192);
        }

        // Store in Transposition Table (only for normal un-excluded searches)
        if excluded_root_moves.is_none() && best_move != Move::NULL {
            let flag = if best_score <= orig_alpha {
                TTFlag::Upperbound
            } else if best_score >= beta {
                TTFlag::Lowerbound
            } else {
                TTFlag::Exact
            };

            self.tt[tt_idx] = Some(TTEntry {
                key: hash,
                depth: depth.clamp(0, 127) as u8,
                score: best_score,
                flag,
                best_move,
            });
        }

        best_score
    }

    /// Formats score in UCI cp or mate N notation
    pub fn format_uci_score(score: i32) -> String {
        if score.abs() >= MATE_SCORE - 500 {
            let plies = MATE_SCORE - score.abs();
            let moves = ((plies + 1) / 2).max(1);
            if score > 0 {
                format!("mate {}", moves)
            } else {
                format!("mate -{}", moves)
            }
        } else {
            format!("score cp {}", score)
        }
    }

    /// Iterative Deepening Root Search with Aspiration Windows & Multi-PV
    pub fn search(
        &mut self,
        board: &mut Board,
        max_depth: u8,
        max_time_ms: u128,
        emit_uci: bool,
    ) -> (Move, i32, Vec<MultiPvLine>) {
        let start = Instant::now();
        let mut stats = SearchStats {
            nodes: 0,
            qnodes: 0,
            seldepth: 0,
            tt_hits: 0,
            tb_hits: 0,
            aborted: false,
            start_time: start,
            time_limit_ms: max_time_ms.max(10),
        };

        let legal_root = board.generate_legal_moves(false);
        if legal_root.is_empty() {
            return (Move::NULL, if board.in_check() { -MATE_SCORE } else { 0 }, vec![]);
        }

        let mut best_move = legal_root[0];
        let mut best_score = 0;
        let mut final_lines: Vec<MultiPvLine> = Vec::new();
        let pv_count = self.multi_pv.min(legal_root.len()).max(1);
        let mut stable_iters = 0;

        for d in 1..=(max_depth.max(1) as i32) {
            let mut iter_lines: Vec<MultiPvLine> = Vec::with_capacity(pv_count);
            let mut excluded: Vec<Move> = Vec::with_capacity(pv_count);

            for rank in 1..=pv_count {
                let mut pv = Vec::new();
                let excl_slice = if excluded.is_empty() {
                    None
                } else {
                    Some(excluded.as_slice())
                };

                // Aspiration Window for Rank 1 on depth >= 4
                let mut score;
                if rank == 1 && d >= 4 {
                    let mut delta = 35;
                    let mut alpha = (best_score - delta).max(-INF);
                    let mut beta = (best_score + delta).min(INF);

                    loop {
                        pv.clear();
                        score = self.pvs(
                            board,
                            d,
                            0,
                            alpha,
                            beta,
                            &mut stats,
                            &mut pv,
                            Move::NULL,
                            PieceType::None,
                            excl_slice,
                            true,
                        );
                        if stats.aborted {
                            break;
                        }
                        if score <= alpha {
                            alpha = (alpha - delta * 2).max(-INF);
                            delta = delta * 2 + 15;
                        } else if score >= beta {
                            beta = (beta + delta * 2).min(INF);
                            delta = delta * 2 + 15;
                        } else {
                            break;
                        }
                        if alpha <= -20000 && beta >= 20000 {
                            pv.clear();
                            score = self.pvs(
                                board,
                                d,
                                0,
                                -INF,
                                INF,
                                &mut stats,
                                &mut pv,
                                Move::NULL,
                                PieceType::None,
                                excl_slice,
                                true,
                            );
                            break;
                        }
                    }
                } else {
                    score = self.pvs(
                        board,
                        d,
                        0,
                        -INF,
                        INF,
                        &mut stats,
                        &mut pv,
                        Move::NULL,
                        PieceType::None,
                        excl_slice,
                        true,
                    );
                }

                if stats.aborted {
                    break;
                }

                if let Some(&mv) = pv.first() {
                    excluded.push(mv);
                    iter_lines.push(MultiPvLine {
                        rank,
                        score_cp: score,
                        best_move: mv,
                        pv,
                    });
                }
            }

            if stats.aborted {
                break;
            }

            if iter_lines.len() > 1 {
                iter_lines.sort_by(|a, b| b.score_cp.cmp(&a.score_cp));
                for (idx, line) in iter_lines.iter_mut().enumerate() {
                    line.rank = idx + 1;
                }
            }

            if let Some(top) = iter_lines.first() {
                if top.best_move == best_move {
                    stable_iters += 1;
                } else {
                    stable_iters = 0;
                }
                best_move = top.best_move;
                best_score = top.score_cp;
                final_lines = iter_lines.clone();
            }

            let elapsed = start.elapsed().as_millis();
            let total_nodes = stats.nodes + stats.qnodes;
            let nps = if elapsed > 0 {
                (total_nodes as u128 * 1000) / elapsed
            } else {
                total_nodes as u128 * 1000
            };

            if emit_uci {
                for line in &iter_lines {
                    let pv_str: Vec<String> = line
                        .pv
                        .iter()
                        .map(|m| m.to_uci(self.uci_chess960))
                        .collect();
                    let score_token = if line.score_cp.abs() >= MATE_SCORE - 500 {
                        format!("score {}", Self::format_uci_score(line.score_cp))
                    } else {
                        Self::format_uci_score(line.score_cp)
                    };
                    if pv_count > 1 {
                        println!(
                            "info depth {} seldepth {} multipv {} {} nodes {} nps {} tbhits {} time {} pv {}",
                            d,
                            stats.seldepth,
                            line.rank,
                            score_token,
                            total_nodes,
                            nps,
                            stats.tb_hits,
                            elapsed,
                            pv_str.join(" ")
                        );
                    } else {
                        println!(
                            "info depth {} seldepth {} {} nodes {} nps {} tbhits {} time {} pv {}",
                            d,
                            stats.seldepth,
                            score_token,
                            total_nodes,
                            nps,
                            stats.tb_hits,
                            elapsed,
                            pv_str.join(" ")
                        );
                    }
                }
            }

            // Forced mate found -> no need to waste extra seconds unless shallow
            if best_score.abs() >= MATE_SCORE - 500 && d >= 4 {
                break;
            }
            // Early stability exit (save clock on obvious moves)
            if stable_iters >= 3 && d >= 6 && elapsed * 100 >= max_time_ms * 55 {
                break;
            }
            if elapsed * 100 >= max_time_ms * 85 {
                break;
            }
        }

        (best_move, best_score, final_lines)
    }
}
