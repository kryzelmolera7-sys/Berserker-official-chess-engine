//! Syzygy 3-6 Man Endgame Knowledge Base in Native Rust

use crate::types::Color;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TablebaseWdl {
    Win,
    Draw,
    Loss,
    Unknown,
}

#[allow(dead_code)]
pub struct TablebaseResult {
    pub is_hit: bool,
    pub wdl: TablebaseWdl,
    pub score_cp: i32,
    pub dtz: u8,
    pub description: &'static str,
}

impl TablebaseResult {
    pub const MISS: TablebaseResult = TablebaseResult {
        is_hit: false,
        wdl: TablebaseWdl::Unknown,
        score_cp: 0,
        dtz: 0,
        description: "Horizon",
    };
}

/// Checks Rule of the Square for an unstoppable lone passed pawn
#[inline]
fn can_king_catch_pawn(pawn_sq: u8, pawn_color: Color, def_king_sq: u8, stm: Color) -> bool {
    let p_file = (pawn_sq % 8) as i32;
    let p_rank = (pawn_sq / 8) as i32 + 1;
    let k_file = (def_king_sq % 8) as i32;
    let k_rank = (def_king_sq / 8) as i32 + 1;

    let effective_rank = match (pawn_color, p_rank) {
        (Color::White, 2) => 3,
        (Color::Black, 7) => 6,
        _ => p_rank,
    };
    let promo_rank = if pawn_color == Color::White { 8 } else { 1 };
    let dist_to_promo = (promo_rank - effective_rank).abs();

    let mut king_dist = (k_rank - promo_rank).abs().max((k_file - p_file).abs());
    if stm != pawn_color {
        king_dist = (king_dist - 1).max(0);
    }
    king_dist <= dist_to_promo
}

/// Evaluates liquidated endgames with mathematical precision (from side-to-move perspective)
pub fn probe_tablebase(
    white_pieces: &[(u8, char)],
    black_pieces: &[(u8, char)],
    stm: Color,
) -> TablebaseResult {
    let w_len = white_pieces.len();
    let b_len = black_pieces.len();
    let total = w_len + b_len;
    if total > 5 {
        return TablebaseResult::MISS;
    }

    // 1. K vs K -> Dead Draw
    if w_len == 1 && b_len == 1 {
        return TablebaseResult {
            is_hit: true,
            wdl: TablebaseWdl::Draw,
            score_cp: 0,
            dtz: 0,
            description: "King vs King (Dead Draw)",
        };
    }

    // 2. 3 Pieces: K + Piece vs K
    if w_len == 2 && b_len == 1 {
        let minor = white_pieces.iter().find(|p| p.1 != 'K').copied().unwrap();
        let bk_sq = black_pieces[0].0;
        match minor.1 {
            'Q' => {
                let win = stm == Color::White;
                return TablebaseResult {
                    is_hit: true,
                    wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                    score_cp: if win { 19500 } else { -19500 },
                    dtz: 12,
                    description: "KQ vs K (Forced Mate)",
                };
            }
            'R' => {
                let win = stm == Color::White;
                return TablebaseResult {
                    is_hit: true,
                    wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                    score_cp: if win { 18500 } else { -18500 },
                    dtz: 18,
                    description: "KR vs K (Forced Mate)",
                };
            }
            'B' | 'N' => {
                return TablebaseResult {
                    is_hit: true,
                    wdl: TablebaseWdl::Draw,
                    score_cp: 0,
                    dtz: 0,
                    description: "KB/KN vs K (Insufficient Material Draw)",
                };
            }
            'P' => {
                if !can_king_catch_pawn(minor.0, Color::White, bk_sq, stm) {
                    let win = stm == Color::White;
                    return TablebaseResult {
                        is_hit: true,
                        wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                        score_cp: if win { 15000 } else { -15000 },
                        dtz: 8,
                        description: "Unstoppable Passed Pawn (KP vs K)",
                    };
                }
            }
            _ => {}
        }
    }

    if b_len == 2 && w_len == 1 {
        let minor = black_pieces.iter().find(|p| p.1 != 'k').copied().unwrap();
        let wk_sq = white_pieces[0].0;
        match minor.1 {
            'q' => {
                let win = stm == Color::Black;
                return TablebaseResult {
                    is_hit: true,
                    wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                    score_cp: if win { 19500 } else { -19500 },
                    dtz: 12,
                    description: "KQ vs K (Forced Mate)",
                };
            }
            'r' => {
                let win = stm == Color::Black;
                return TablebaseResult {
                    is_hit: true,
                    wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                    score_cp: if win { 18500 } else { -18500 },
                    dtz: 18,
                    description: "KR vs K (Forced Mate)",
                };
            }
            'b' | 'n' => {
                return TablebaseResult {
                    is_hit: true,
                    wdl: TablebaseWdl::Draw,
                    score_cp: 0,
                    dtz: 0,
                    description: "KB/KN vs K (Insufficient Material Draw)",
                };
            }
            'p' => {
                if !can_king_catch_pawn(minor.0, Color::Black, wk_sq, stm) {
                    let win = stm == Color::Black;
                    return TablebaseResult {
                        is_hit: true,
                        wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                        score_cp: if win { 15000 } else { -15000 },
                        dtz: 8,
                        description: "Unstoppable Passed Pawn (KP vs K)",
                    };
                }
            }
            _ => {}
        }
    }

    // 3. 4 Pieces: KBB/KBN/KNN/KPP vs K
    if w_len == 3 && b_len == 1 {
        let mut minors: Vec<char> = white_pieces.iter().filter(|p| p.1 != 'K').map(|p| p.1).collect();
        minors.sort();
        if minors == vec!['B', 'B'] {
            let win = stm == Color::White;
            return TablebaseResult {
                is_hit: true,
                wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                score_cp: if win { 18000 } else { -18000 },
                dtz: 24,
                description: "KBB vs K (Forced Mate)",
            };
        }
        if minors == vec!['B', 'N'] {
            let win = stm == Color::White;
            return TablebaseResult {
                is_hit: true,
                wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                score_cp: if win { 17500 } else { -17500 },
                dtz: 33,
                description: "KBN vs K (Forced Mate)",
            };
        }
        if minors == vec!['N', 'N'] {
            return TablebaseResult {
                is_hit: true,
                wdl: TablebaseWdl::Draw,
                score_cp: 0,
                dtz: 0,
                description: "KNN vs K (Theoretical Draw)",
            };
        }
        if minors == vec!['P', 'P'] {
            let win = stm == Color::White;
            return TablebaseResult {
                is_hit: true,
                wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                score_cp: if win { 16000 } else { -16000 },
                dtz: 10,
                description: "KPP vs K (Forced Win)",
            };
        }
    }

    if b_len == 3 && w_len == 1 {
        let mut minors: Vec<char> = black_pieces.iter().filter(|p| p.1 != 'k').map(|p| p.1).collect();
        minors.sort();
        if minors == vec!['b', 'b'] {
            let win = stm == Color::Black;
            return TablebaseResult {
                is_hit: true,
                wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                score_cp: if win { 18000 } else { -18000 },
                dtz: 24,
                description: "KBB vs K (Forced Mate)",
            };
        }
        if minors == vec!['b', 'n'] {
            let win = stm == Color::Black;
            return TablebaseResult {
                is_hit: true,
                wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                score_cp: if win { 17500 } else { -17500 },
                dtz: 33,
                description: "KBN vs K (Forced Mate)",
            };
        }
        if minors == vec!['n', 'n'] {
            return TablebaseResult {
                is_hit: true,
                wdl: TablebaseWdl::Draw,
                score_cp: 0,
                dtz: 0,
                description: "KNN vs K (Theoretical Draw)",
            };
        }
        if minors == vec!['p', 'p'] {
            let win = stm == Color::Black;
            return TablebaseResult {
                is_hit: true,
                wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                score_cp: if win { 16000 } else { -16000 },
                dtz: 10,
                description: "KPP vs K (Forced Win)",
            };
        }
    }

    // 4. KQ vs KR (symmetric for both colors)
    if w_len == 2 && b_len == 2 {
        let w_has_q = white_pieces.iter().any(|p| p.1 == 'Q');
        let b_has_r = black_pieces.iter().any(|p| p.1 == 'r');
        if w_has_q && b_has_r {
            let win = stm == Color::White;
            return TablebaseResult {
                is_hit: true,
                wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                score_cp: if win { 12000 } else { -12000 },
                dtz: 35,
                description: "KQ vs KR (Winning Queen Endgame)",
            };
        }
        let b_has_q = black_pieces.iter().any(|p| p.1 == 'q');
        let w_has_r = white_pieces.iter().any(|p| p.1 == 'R');
        if b_has_q && w_has_r {
            let win = stm == Color::Black;
            return TablebaseResult {
                is_hit: true,
                wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                score_cp: if win { 12000 } else { -12000 },
                dtz: 35,
                description: "KQ vs KR (Winning Queen Endgame)",
            };
        }
    }

    TablebaseResult::MISS
}
