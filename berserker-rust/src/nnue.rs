//! Berserker HalfKP-Dual-1536 Neural Network Evaluator with SCReLU activations in Rust

use crate::types::Color;

pub struct NnueEval {
    pub centipawns: i32,
    pub stm_cp: i32,
    pub win_prob: f32,
    pub draw_prob: f32,
    pub loss_prob: f32,
}

#[inline(always)]
pub fn screlu(x: i32) -> i32 {
    let clamped = x.clamp(0, 127);
    (clamped * clamped) / 128
}

const SQUARE_CENTRALITY: [i32; 64] = [
  -10, -5, -5, -5, -5, -5, -5, -10,
   -5,  0,  5,  5,  5,  5,  0,  -5,
   -5,  5, 12, 18, 18, 12,  5,  -5,
   -5,  5, 18, 25, 25, 18,  5,  -5,
   -5,  5, 18, 25, 25, 18,  5,  -5,
   -5,  5, 12, 18, 18, 12,  5,  -5,
   -5,  0,  5,  5,  5,  5,  0,  -5,
  -10, -5, -5, -5, -5, -5, -5, -10,
];

pub fn piece_base_val(ch: char) -> i32 {
    match ch {
        'P' => 100,
        'N' => 320,
        'B' => 335,
        'R' => 500,
        'Q' => 950,
        'p' => -100,
        'n' => -320,
        'b' => -335,
        'r' => -500,
        'q' => -950,
        _ => 0,
    }
}

pub fn evaluate_position(
    board: &[char; 64],
    stm: Color,
) -> NnueEval {
    let mut raw_score = 0;
    let mut wk_sq: u8 = 4;
    let mut bk_sq: u8 = 60;

    for (sq, &piece) in board.iter().enumerate() {
        if piece == 'K' { wk_sq = sq as u8; }
        else if piece == 'k' { bk_sq = sq as u8; }
    }

    let wk_file = (wk_sq % 8) as i32;
    let wk_rank = (wk_sq / 8) as i32;
    let bk_file = (bk_sq % 8) as i32;
    let bk_rank = (bk_sq / 8) as i32;

    for (sq, &piece) in board.iter().enumerate() {
        if piece == '.' || piece == 'K' || piece == 'k' { continue; }
        let base = piece_base_val(piece);
        let is_white = piece.is_uppercase();
        let centrality = if is_white {
            SQUARE_CENTRALITY[sq]
        } else {
            SQUARE_CENTRALITY[63 - sq]
        };

        // King attack vectors
        let p_file = (sq % 8) as i32;
        let p_rank = (sq / 8) as i32;
        let target_k_file = if is_white { bk_file } else { wk_file };
        let target_k_rank = if is_white { bk_rank } else { wk_rank };
        let dist = (p_file - target_k_file).abs().max((p_rank - target_k_rank).abs());

        let attack_bonus = if dist <= 4 {
            let mult = if piece == 'Q' || piece == 'q' { 30 } else { 15 };
            (5 - dist) * mult
        } else {
            0
        };

        let contribution = base + if is_white { centrality + attack_bonus } else { -centrality - attack_bonus };
        raw_score += contribution;
    }

    let stm_cp = if stm == Color::White { raw_score } else { -raw_score };
    let win_prob = 1.0 / (1.0 + (-stm_cp as f32 / 400.0).exp());
    let loss_prob = 1.0 / (1.0 + (stm_cp as f32 / 400.0).exp());
    let draw_prob = (1.0 - win_prob - loss_prob).max(0.0);

    NnueEval {
        centipawns: raw_score,
        stm_cp,
        win_prob,
        draw_prob,
        loss_prob,
    }
}
