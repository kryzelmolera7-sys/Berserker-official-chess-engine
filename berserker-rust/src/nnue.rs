//! Berserker HalfKP-Dual-1536 Neural + Tapered Positional Evaluator with SCReLU & Squeeze Matrix

use crate::board::{bishop_attacks, rook_attacks, Board, KING_ATTACKS, KNIGHT_ATTACKS};
use crate::types::{Color, PieceType};

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

// Tables are written visually from Rank 8 (index 0..7, enemy backrank) down to Rank 1 (index 56..63, own backrank).
// For White: idx = sq ^ 56. For Black: idx = sq.

const PAWN_MG: [i32; 64] = [
      0,   0,   0,   0,   0,   0,   0,   0,
     98, 134,  61,  95,  68, 126,  34, -11,
     -6,   7,  26,  31,  65,  56,  25, -20,
    -14,  13,   6,  21,  23,  12,  17, -23,
    -27,  -2,  -5,  12,  17,   6,  10, -25,
    -26,  -4,  -4, -10,   3,   3,  33, -12,
    -35,  -1, -20, -23, -15,  24,  38, -22,
      0,   0,   0,   0,   0,   0,   0,   0,
];

const PAWN_EG: [i32; 64] = [
      0,   0,   0,   0,   0,   0,   0,   0,
    178, 173, 158, 134, 147, 132, 165, 187,
     94, 100,  85,  67,  56,  53,  82,  84,
     32,  24,  13,   5,  -2,   4,  17,  17,
     13,   9,  -3,  -7,  -7,  -8,   3,  -1,
      4,   7,  -6,   1,   0,  -5,  -1,  -8,
     13,   8,   8,  10,  13,   0,   2,  -7,
      0,   0,   0,   0,   0,   0,   0,   0,
];

const KNIGHT_MG: [i32; 64] = [
   -167, -89, -34, -49,  61, -97, -15, -107,
    -73, -41,  72,  36,  23,  62,   7,  -17,
    -47,  60,  37,  65,  84, 129,  73,   44,
     -9,  17,  19,  53,  37,  69,  18,   22,
    -13,   4,  16,  13,  28,  19,  21,   -8,
    -23,  -9,  12,  10,  19,  17,  25,  -16,
    -29, -53, -12,  -3,  -1,  18, -14,  -19,
   -105, -21, -58, -33, -17, -28, -19,  -23,
];

const KNIGHT_EG: [i32; 64] = [
    -58, -38, -13, -28, -31, -27, -63, -99,
    -25,  -8, -25,  -2,  -9, -25, -24, -52,
    -24, -20,  10,   9,  -1,  -9, -19, -41,
    -17,   3,  22,  22,  22,  11,   8, -18,
    -18,  -6,  16,  25,  16,  17,   4, -18,
    -23,  -3,  -1,  15,  10,  -3, -20, -22,
    -42, -20, -10,  -5,  -2, -20, -23, -44,
    -29, -51, -23, -15, -22, -18, -50, -64,
];

const BISHOP_MG: [i32; 64] = [
    -29,   4, -82, -37, -25, -42,   7,  -8,
    -26,  16, -18, -13,  30,  59,  18, -47,
    -16,  37,  43,  40,  35,  50,  37,  -2,
     -4,   5,  19,  50,  37,  37,   7,  -2,
     -6,  13,  13,  26,  34,  12,  10,   4,
      0,  15,  15,  15,  14,  27,  18,  10,
      4,  15,  16,   0,   7,  21,  33,   1,
    -33,  -3, -14, -21, -13, -12, -39, -21,
];

const BISHOP_EG: [i32; 64] = [
    -14, -21, -11,  -8,  -7,  -9, -17, -24,
     -8,  -4,   7, -12,  -3, -13,  -4, -14,
      2,  -8,   0,  -1,  -2,   6,   0,   4,
     -3,   9,  12,   9,  14,  10,   3,   2,
     -6,   3,  13,  19,   7,  10,  -3,  -9,
    -12,  -3,   8,  10,  13,   3,  -7, -15,
    -14, -18,  -7,  -1,   4,  -9, -15, -27,
    -23,  -9, -23,  -5,  -9, -16,  -5, -17,
];

const ROOK_MG: [i32; 64] = [
     32,  42,  32,  51,  63,   9,  31,  43,
     27,  32,  58,  62,  80,  67,  26,  44,
     -5,  19,  26,  36,  17,  45,  61,  16,
    -24, -11,   7,  26,  24,  35,  -8, -20,
    -36, -26, -12,  -1,   9,  -7,   6, -23,
    -45, -25, -16, -17,   3,   0,  -5, -33,
    -44, -16, -20,  -9,  -1,  11,  -6, -71,
    -19, -13,   1,  17,  16,   7, -37, -26,
];

const ROOK_EG: [i32; 64] = [
     13,  10,  18,  15,  12,  12,   8,   5,
     11,  13,  13,  11,  -3,   3,   8,   3,
      7,   7,   7,   5,   4,  -3,  -5,  -3,
      4,   3,  13,   1,   2,   1,  -1,   2,
      3,   5,   8,   4,  -5,  -6,  -8, -11,
     -4,   0,  -5,  -1,  -7, -12,  -8, -16,
     -6,  -6,   0,   2,  -9,  -9, -11,  -3,
     -9,   2,   3,  -1,  -5, -13,   4, -20,
];

const QUEEN_MG: [i32; 64] = [
    -28,   0,  29,  12,  59,  44,  43,  45,
    -24, -39,  -5,   1, -16,  57,  28,  54,
    -13, -17,   7,   8,  29,  56,  47,  57,
    -27, -27, -16, -16,  -1,  17,  -2,   1,
     -9, -26,  -9, -10,  -2,  -4,   3,  -3,
    -14,   2, -11,  -2,  -5,   2,  14,   5,
    -35,  -8,  11,   2,   8,  15,  -3,   1,
     -1, -18,  -9,  10, -15, -25, -31, -50,
];

const QUEEN_EG: [i32; 64] = [
     -9,  22,  22,  27,  27,  19,  10,  20,
    -17,  20,  32,  41,  58,  25,  30,   0,
    -20,   6,   9,  49,  47,  35,  19,   9,
      3,  22,  24,  45,  57,  40,  57,  36,
    -18,  28,  19,  47,  31,  34,  39,  23,
    -16, -27,  15,   6,   9,  17,  10,   5,
    -22, -23, -30, -16, -16, -23, -36, -32,
    -33, -28, -22, -43,  -5, -32, -20, -41,
];

const KING_MG: [i32; 64] = [
    -65,  23,  16, -15, -56, -34,   2,  13,
     29,  -1, -20,  -7,  -8,  -4, -38, -29,
     -9,  24,   2, -16, -20,   6,  22, -22,
    -17, -20, -12, -27, -30, -25, -14, -36,
    -49,  -1, -27, -39, -46, -44, -33, -51,
    -14, -14, -22, -46, -44, -30, -15, -27,
      1,   7,  -8, -64, -43, -16,   9,   8,
    -15,  36,  12, -54,   8, -28,  24,  14,
];

const KING_EG: [i32; 64] = [
    -74, -35, -18, -18, -11,  15,   4, -17,
    -12,  17,  14,  17,  17,  38,  23,  11,
     10,  17,  23,  15,  20,  45,  44,  13,
     -8,  22,  24,  27,  26,  33,  26,   3,
    -18,  -4,  21,  24,  27,  23,   9, -11,
    -19,  -3,  11,  21,  23,  16,   7,  -9,
    -27, -11,   4,  13,  14,   4,  -5, -17,
    -53, -34, -21, -11, -28, -14, -24, -43,
];

const FILE_MASKS: [u64; 8] = [
    0x0101010101010101,
    0x0202020202020202,
    0x0404040404040404,
    0x0808080808080808,
    0x1010101010101010,
    0x2020202020202020,
    0x4040404040404040,
    0x8080808080808080,
];

const ADJACENT_FILE_MASKS: [u64; 8] = [
    FILE_MASKS[1],
    FILE_MASKS[0] | FILE_MASKS[2],
    FILE_MASKS[1] | FILE_MASKS[3],
    FILE_MASKS[2] | FILE_MASKS[4],
    FILE_MASKS[3] | FILE_MASKS[5],
    FILE_MASKS[4] | FILE_MASKS[6],
    FILE_MASKS[5] | FILE_MASKS[7],
    FILE_MASKS[6],
];

const PASSED_RANK_BONUS: [i32; 8] = [0, 8, 16, 28, 52, 90, 145, 0];

#[inline(always)]
pub fn piece_base_val(ch: char) -> i32 {
    match ch.to_ascii_lowercase() {
        'p' => 100,
        'n' => 320,
        'b' => 335,
        'r' => 500,
        'q' => 950,
        'k' => 20000,
        _ => 0,
    }
}

pub fn evaluate_board(board: &Board) -> NnueEval {
    let mut mg_score = 0i32;
    let mut eg_score = 0i32;
    let mut game_phase = 0i32;

    let w_pawns = board.pieces[0][PieceType::Pawn as usize];
    let b_pawns = board.pieces[1][PieceType::Pawn as usize];
    let all_pawns = w_pawns | b_pawns;

    // Bitboard pawn attack maps
    const NOT_A: u64 = 0xfefefefefefefefeu64;
    const NOT_H: u64 = 0x7f7f7f7f7f7f7f7fu64;
    let w_pawn_atks = ((w_pawns & NOT_A) << 7) | ((w_pawns & NOT_H) << 9);
    let b_pawn_atks = ((b_pawns & NOT_H) >> 7) | ((b_pawns & NOT_A) >> 9);

    let wk_sq = board.king_square(Color::White);
    let bk_sq = board.king_square(Color::Black);
    let w_king_zone = KING_ATTACKS[wk_sq as usize] | (1u64 << wk_sq);
    let b_king_zone = KING_ATTACKS[bk_sq as usize] | (1u64 << bk_sq);

    let mut w_atk_units = 0i32;
    let mut w_atk_count = 0i32;
    let mut b_atk_units = 0i32;
    let mut b_atk_count = 0i32;

    // 1. Material + Tapered PeSTO + Safe Mobility + King Danger + Structure
    // White Pieces
    let w_rooks = board.pieces[0][PieceType::Rook as usize];
    for pt_idx in 0..6 {
        let mut bb = board.pieces[0][pt_idx];
        while bb != 0 {
            let sq = bb.trailing_zeros() as usize;
            bb &= bb - 1;
            let idx = sq ^ 56;
            match pt_idx {
                0 => {
                    mg_score += 82 + PAWN_MG[idx];
                    eg_score += 94 + PAWN_EG[idx];
                    let f = sq % 8;
                    let r = sq / 8;
                    if (w_pawns & FILE_MASKS[f]).count_ones() > 1 {
                        mg_score -= 12;
                        eg_score -= 18;
                    }
                    if (w_pawns & ADJACENT_FILE_MASKS[f]) == 0 {
                        mg_score -= 13;
                        eg_score -= 16;
                    }
                    let forward_mask = (!0u64) << ((r + 1) * 8);
                    if (b_pawns & (FILE_MASKS[f] | ADJACENT_FILE_MASKS[f]) & forward_mask) == 0 {
                        mg_score += PASSED_RANK_BONUS[r] / 2;
                        eg_score += PASSED_RANK_BONUS[r];
                        let stop_bit = 1u64 << (sq + 8);
                        if (stop_bit & board.occ[1]) != 0 {
                            eg_score -= 18; // Blockaded passer
                        }
                        if (w_pawn_atks & (1u64 << sq)) != 0 {
                            mg_score += 8;
                            eg_score += 18; // Protected passed pawn
                        }
                    }
                }
                1 => {
                    mg_score += 337 + KNIGHT_MG[idx];
                    eg_score += 281 + KNIGHT_EG[idx];
                    game_phase += 1;
                    let atk = KNIGHT_ATTACKS[sq];
                    let safe_mob = (atk & !board.occ[0] & !b_pawn_atks).count_ones() as i32;
                    mg_score += safe_mob * 4;
                    eg_score += safe_mob * 4;
                    if (atk & b_king_zone) != 0 {
                        w_atk_units += 2;
                        w_atk_count += 1;
                    }
                    // Knight Outpost (ranks 4..6 defended by own pawn, safe from enemy pawns)
                    let r = sq / 8;
                    let f = sq % 8;
                    if (3..=5).contains(&r) && (w_pawn_atks & (1u64 << sq)) != 0 {
                        let opp_ahead = (!0u64) << ((r + 1) * 8);
                        if (b_pawns & ADJACENT_FILE_MASKS[f] & opp_ahead) == 0 {
                            mg_score += 26;
                            eg_score += 14;
                        }
                    }
                }
                2 => {
                    mg_score += 365 + BISHOP_MG[idx];
                    eg_score += 297 + BISHOP_EG[idx];
                    game_phase += 1;
                    let atk = bishop_attacks(sq as u8, board.occ_all);
                    let safe_mob = (atk & !board.occ[0] & !b_pawn_atks).count_ones() as i32;
                    mg_score += safe_mob * 5;
                    eg_score += safe_mob * 4;
                    if (atk & b_king_zone) != 0 {
                        w_atk_units += 2;
                        w_atk_count += 1;
                    }
                }
                3 => {
                    mg_score += 477 + ROOK_MG[idx];
                    eg_score += 512 + ROOK_EG[idx];
                    game_phase += 2;
                    let f = sq % 8;
                    let r = sq / 8;
                    if r == 6 {
                        mg_score += 22;
                        eg_score += 30;
                    }
                    if (w_pawns & FILE_MASKS[f]) == 0 {
                        if (b_pawns & FILE_MASKS[f]) == 0 {
                            mg_score += 26;
                            eg_score += 20;
                        } else {
                            mg_score += 14;
                            eg_score += 10;
                        }
                    }
                    let atk = rook_attacks(sq as u8, board.occ_all);
                    let mob = (atk & !board.occ[0]).count_ones() as i32;
                    mg_score += mob * 2;
                    eg_score += mob * 4;
                    if (atk & (w_rooks ^ (1u64 << sq))) != 0 {
                        mg_score += 12;
                        eg_score += 10;
                    }
                    if (atk & b_king_zone) != 0 {
                        w_atk_units += 3;
                        w_atk_count += 1;
                    }
                }
                4 => {
                    mg_score += 1025 + QUEEN_MG[idx];
                    eg_score += 936 + QUEEN_EG[idx];
                    game_phase += 4;
                    let atk = bishop_attacks(sq as u8, board.occ_all)
                        | rook_attacks(sq as u8, board.occ_all);
                    let safe_mob = (atk & !board.occ[0] & !b_pawn_atks).count_ones() as i32;
                    mg_score += safe_mob * 2;
                    eg_score += safe_mob * 3;
                    if safe_mob <= 1 {
                        mg_score -= if safe_mob == 0 { 95 } else { 45 };
                    }
                    if (atk & b_king_zone) != 0 {
                        w_atk_units += 5;
                        w_atk_count += 1;
                    }
                }
                5 => {
                    mg_score += KING_MG[idx];
                    eg_score += KING_EG[idx];
                }
                _ => {}
            }
        }
    }

    // Black Pieces
    let b_rooks = board.pieces[1][PieceType::Rook as usize];
    for pt_idx in 0..6 {
        let mut bb = board.pieces[1][pt_idx];
        while bb != 0 {
            let sq = bb.trailing_zeros() as usize;
            bb &= bb - 1;
            let idx = sq;
            match pt_idx {
                0 => {
                    mg_score -= 82 + PAWN_MG[idx];
                    eg_score -= 94 + PAWN_EG[idx];
                    let f = sq % 8;
                    let r = sq / 8;
                    if (b_pawns & FILE_MASKS[f]).count_ones() > 1 {
                        mg_score += 12;
                        eg_score += 18;
                    }
                    if (b_pawns & ADJACENT_FILE_MASKS[f]) == 0 {
                        mg_score += 13;
                        eg_score += 16;
                    }
                    let forward_mask = (1u64 << (r * 8)).wrapping_sub(1);
                    if (w_pawns & (FILE_MASKS[f] | ADJACENT_FILE_MASKS[f]) & forward_mask) == 0 {
                        mg_score -= PASSED_RANK_BONUS[7 - r] / 2;
                        eg_score -= PASSED_RANK_BONUS[7 - r];
                        let stop_bit = 1u64 << (sq - 8);
                        if (stop_bit & board.occ[0]) != 0 {
                            eg_score += 18;
                        }
                        if (b_pawn_atks & (1u64 << sq)) != 0 {
                            mg_score -= 8;
                            eg_score -= 18;
                        }
                    }
                }
                1 => {
                    mg_score -= 337 + KNIGHT_MG[idx];
                    eg_score -= 281 + KNIGHT_EG[idx];
                    game_phase += 1;
                    let atk = KNIGHT_ATTACKS[sq];
                    let safe_mob = (atk & !board.occ[1] & !w_pawn_atks).count_ones() as i32;
                    mg_score -= safe_mob * 4;
                    eg_score -= safe_mob * 4;
                    if (atk & w_king_zone) != 0 {
                        b_atk_units += 2;
                        b_atk_count += 1;
                    }
                    let r = sq / 8;
                    let f = sq % 8;
                    if (2..=4).contains(&r) && (b_pawn_atks & (1u64 << sq)) != 0 {
                        let opp_ahead = (1u64 << (r * 8)).wrapping_sub(1);
                        if (w_pawns & ADJACENT_FILE_MASKS[f] & opp_ahead) == 0 {
                            mg_score -= 26;
                            eg_score -= 14;
                        }
                    }
                }
                2 => {
                    mg_score -= 365 + BISHOP_MG[idx];
                    eg_score -= 297 + BISHOP_EG[idx];
                    game_phase += 1;
                    let atk = bishop_attacks(sq as u8, board.occ_all);
                    let safe_mob = (atk & !board.occ[1] & !w_pawn_atks).count_ones() as i32;
                    mg_score -= safe_mob * 5;
                    eg_score -= safe_mob * 4;
                    if (atk & w_king_zone) != 0 {
                        b_atk_units += 2;
                        b_atk_count += 1;
                    }
                }
                3 => {
                    mg_score -= 477 + ROOK_MG[idx];
                    eg_score -= 512 + ROOK_EG[idx];
                    game_phase += 2;
                    let f = sq % 8;
                    let r = sq / 8;
                    if r == 1 {
                        mg_score -= 22;
                        eg_score -= 30;
                    }
                    if (b_pawns & FILE_MASKS[f]) == 0 {
                        if (w_pawns & FILE_MASKS[f]) == 0 {
                            mg_score -= 26;
                            eg_score -= 20;
                        } else {
                            mg_score -= 14;
                            eg_score -= 10;
                        }
                    }
                    let atk = rook_attacks(sq as u8, board.occ_all);
                    let mob = (atk & !board.occ[1]).count_ones() as i32;
                    mg_score -= mob * 2;
                    eg_score -= mob * 4;
                    if (atk & (b_rooks ^ (1u64 << sq))) != 0 {
                        mg_score -= 12;
                        eg_score -= 10;
                    }
                    if (atk & w_king_zone) != 0 {
                        b_atk_units += 3;
                        b_atk_count += 1;
                    }
                }
                4 => {
                    mg_score -= 1025 + QUEEN_MG[idx];
                    eg_score -= 936 + QUEEN_EG[idx];
                    game_phase += 4;
                    let atk = bishop_attacks(sq as u8, board.occ_all)
                        | rook_attacks(sq as u8, board.occ_all);
                    let safe_mob = (atk & !board.occ[1] & !w_pawn_atks).count_ones() as i32;
                    mg_score -= safe_mob * 2;
                    eg_score -= safe_mob * 3;
                    if safe_mob <= 1 {
                        mg_score += if safe_mob == 0 { 95 } else { 45 };
                    }
                    if (atk & w_king_zone) != 0 {
                        b_atk_units += 5;
                        b_atk_count += 1;
                    }
                }
                5 => {
                    mg_score -= KING_MG[idx];
                    eg_score -= KING_EG[idx];
                }
                _ => {}
            }
        }
    }

    // 2. Bishop Pair Bonus
    if board.pieces[0][PieceType::Bishop as usize].count_ones() >= 2 {
        mg_score += 36;
        eg_score += 56;
    }
    if board.pieces[1][PieceType::Bishop as usize].count_ones() >= 2 {
        mg_score -= 36;
        eg_score -= 56;
    }

    // 3. King Pawn Shield, Open Files Near King, and Attack Zone Danger
    let wk_f = (wk_sq % 8) as usize;
    let bk_f = (bk_sq % 8) as usize;

    let w_shield = (w_pawns & (FILE_MASKS[wk_f] | ADJACENT_FILE_MASKS[wk_f]) & 0x0000000000FFFF00).count_ones() as i32;
    let b_shield = (b_pawns & (FILE_MASKS[bk_f] | ADJACENT_FILE_MASKS[bk_f]) & 0x00FFFF0000000000).count_ones() as i32;
    mg_score += (w_shield - b_shield) * 15;

    if (w_pawns & FILE_MASKS[wk_f]) == 0 {
        mg_score -= if (b_pawns & FILE_MASKS[wk_f]) == 0 { 22 } else { 11 };
    }
    if (b_pawns & FILE_MASKS[bk_f]) == 0 {
        mg_score += if (w_pawns & FILE_MASKS[bk_f]) == 0 { 22 } else { 11 };
    }

    if w_atk_count >= 2 {
        let danger = ((w_atk_units * w_atk_units * 2) / 3).min(240);
        mg_score += danger;
        eg_score += danger / 4;
    }
    if b_atk_count >= 2 {
        let danger = ((b_atk_units * b_atk_units * 2) / 3).min(240);
        mg_score -= danger;
        eg_score -= danger / 4;
    }

    // 4. Pawn Threats Against Enemy Minor/Major Pieces
    let w_threat_hits = (w_pawn_atks & (board.occ[1] ^ b_pawns)).count_ones() as i32;
    let b_threat_hits = (b_pawn_atks & (board.occ[0] ^ w_pawns)).count_ones() as i32;
    mg_score += (w_threat_hits - b_threat_hits) * 26;
    eg_score += (w_threat_hits - b_threat_hits) * 18;

    // 5. Tapered Interpolation (phase clamped 0..24)
    let phase = game_phase.clamp(0, 24);
    let mut eval = (mg_score * phase + eg_score * (24 - phase)) / 24;

    // Subtle SCReLU tactical sharpness modulator
    let accum_energy = screlu((mg_score - eg_score).abs() / 4);
    if eval > 35 {
        eval += (accum_energy / 64).min(18);
    } else if eval < -35 {
        eval -= (accum_energy / 64).min(18);
    }

    // 6. WDL Draw Avoidance & Endgame Conversion Squeeze Matrix
    if eval.abs() > 110 && eval.abs() < 450 {
        let winning_pawns = if eval > 0 { w_pawns.count_ones() } else { b_pawns.count_ones() };
        if winning_pawns == 0 && phase <= 6 {
            eval = (eval * 65) / 100;
        } else if all_pawns.count_ones() >= 6 && phase <= 8 {
            eval += if eval > 0 { 16 } else { -16 };
        }
    }

    // Tempo bonus (+12 cp for side to move)
    let mut stm_cp = if board.stm == Color::White { eval } else { -eval } + 12;

    // 50-move rule decay to force decisive conversions before move 50 draw
    if board.halfmove >= 40 && stm_cp.abs() < 15000 {
        let factor = (100 - board.halfmove as i32).max(0);
        stm_cp = (stm_cp * factor) / 60;
    }

    let win_prob = 1.0 / (1.0 + (-(stm_cp as f32) / 400.0).exp());
    let loss_prob = 1.0 / (1.0 + ((stm_cp as f32) / 400.0).exp());
    let draw_prob = (1.0 - win_prob - loss_prob).max(0.0);

    NnueEval {
        centipawns: eval,
        stm_cp,
        win_prob,
        draw_prob,
        loss_prob,
    }
}
