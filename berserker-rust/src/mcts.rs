//! Hybrid MCTS-PUCT & Petrosian Threat-Space Prophylaxis Oracle in Native Rust

use crate::board::Board;
use crate::nnue::evaluate_board;
use crate::types::Move;

pub struct MctsChild {
    pub mv: Move,
    pub prior: f32,
    pub visits: u32,
    pub value_sum: f32,
}

/// Computes tactical policy priors for legal moves based on SEE, promotions, center control, and checks
fn compute_priors(board: &mut Board, moves: &[Move]) -> Vec<f32> {
    let mut logits = Vec::with_capacity(moves.len());
    for &m in moves {
        let mut s = 0.2f32;
        if board.squares[m.to as usize] != '.' || m.is_en_passant() {
            let see = board.see(m);
            s += if see >= 0 { 2.4 + (see as f32 / 350.0).min(2.5) } else { -0.8 };
        }
        if m.promo != crate::types::PieceType::None {
            s += 2.2;
        }
        if m.is_castling() {
            s += 1.4;
        }
        let tf = (m.to % 8) as i32;
        let tr = (m.to / 8) as i32;
        if (2..=5).contains(&tf) && (2..=5).contains(&tr) {
            s += 0.45;
        }
        if let Some(undo) = board.make_move(m) {
            if board.in_check() {
                s += 1.1;
            }
            board.unmake_move(m, undo);
        }
        logits.push(s.max(0.05));
    }

    let max_l = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut exp_sum = 0.0f32;
    let mut probs = Vec::with_capacity(moves.len());
    for l in logits {
        let e = (l - max_l).exp();
        exp_sum += e;
        probs.push(e);
    }
    if exp_sum > 0.0 {
        for p in &mut probs {
            *p /= exp_sum;
        }
    }
    probs
}

/// Evaluates Petrosian Threat-Space Prophylaxis (opponent's strongest immediate reply pressure)
pub fn measure_opponent_threat_pressure(board: &mut Board) -> i32 {
    if board.in_check() {
        return 0;
    }
    let (old_ep, old_hash) = board.make_null_move();
    let opp_moves = board.generate_legal_moves(true);
    let mut max_see = 0;
    for om in opp_moves {
        let s = board.see(om);
        if s > max_see {
            max_see = s;
        }
    }
    board.unmake_null_move(old_ep, old_hash);
    max_see
}

/// Runs a 1-ply / shallow PUCT MCTS verification across root candidate moves
pub fn run_puct_verification(board: &mut Board, simulations: u32) -> Option<(Move, i32, u32)> {
    let legal = board.generate_legal_moves(false);
    if legal.is_empty() {
        return None;
    }
    let priors = compute_priors(board, &legal);
    let mut children: Vec<MctsChild> = legal
        .into_iter()
        .zip(priors)
        .map(|(mv, prior)| MctsChild {
            mv,
            prior,
            visits: 0,
            value_sum: 0.0,
        })
        .collect();

    let total_sims = simulations.max(children.len() as u32);
    for sim in 0..total_sims {
        let sqrt_n = ((sim + 1) as f32).sqrt();
        let mut best_idx = 0;
        let mut best_u = f32::NEG_INFINITY;
        for (idx, ch) in children.iter().enumerate() {
            let q = if ch.visits > 0 { ch.value_sum / ch.visits as f32 } else { 0.0 };
            let cpuct = 1.45 * ch.prior * sqrt_n / (1.0 + ch.visits as f32);
            let score = q + cpuct;
            if score > best_u {
                best_u = score;
                best_idx = idx;
            }
        }

        let mv = children[best_idx].mv;
        let v = if let Some(undo) = board.make_move(mv) {
            let ev = evaluate_board(board);
            // From root STM perspective: negate opponent's stm_cp
            let threat = measure_opponent_threat_pressure(board);
            let adj_cp = -ev.stm_cp - (threat / 6);
            board.unmake_move(mv, undo);
            (adj_cp as f32 / 400.0).tanh()
        } else {
            -1.0
        };

        children[best_idx].visits += 1;
        children[best_idx].value_sum += v;
    }

    children.sort_by(|a, b| b.visits.cmp(&a.visits));
    let top = &children[0];
    let avg_v = if top.visits > 0 { top.value_sum / top.visits as f32 } else { 0.0 };
    let est_cp = (avg_v.clamp(-0.99, 0.99).atanh() * 400.0) as i32;
    Some((top.mv, est_cp, top.visits))
}
