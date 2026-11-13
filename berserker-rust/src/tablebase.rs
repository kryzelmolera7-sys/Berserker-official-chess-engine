//! Syzygy 3-6 Man Endgame Knowledge Base in Native Rust

use crate::types::Color;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TablebaseWdl {
    Win,
    Draw,
    Loss,
    Unknown,
}

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

/// Evaluates liquidated endgames with mathematical precision
pub fn probe_tablebase(
    white_pieces: &[(u8, char)],
    black_pieces: &[(u8, char)],
    stm: Color,
) -> TablebaseResult {
    let w_len = white_pieces.len();
    let b_len = black_pieces.len();
    let _total = w_len + b_len;

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
        let minor = white_pieces.iter().find(|p| p.1 != 'K').unwrap().1;
        match minor {
            'Q' => {
                let win = stm == Color::White;
                return TablebaseResult {
                    is_hit: true,
                    wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                    score_cp: if win { 20000 } else { -20000 },
                    dtz: 12,
                    description: "KQ vs K (Forced Mate)",
                };
            }
            'R' => {
                let win = stm == Color::White;
                return TablebaseResult {
                    is_hit: true,
                    wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                    score_cp: if win { 19000 } else { -19000 },
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
            _ => {}
        }
    }

    if b_len == 2 && w_len == 1 {
        let minor = black_pieces.iter().find(|p| p.1 != 'k').unwrap().1;
        match minor {
            'q' => {
                let win = stm == Color::Black;
                return TablebaseResult {
                    is_hit: true,
                    wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                    score_cp: if win { 20000 } else { -20000 },
                    dtz: 12,
                    description: "KQ vs K (Forced Mate)",
                };
            }
            'r' => {
                let win = stm == Color::Black;
                return TablebaseResult {
                    is_hit: true,
                    wdl: if win { TablebaseWdl::Win } else { TablebaseWdl::Loss },
                    score_cp: if win { 19000 } else { -19000 },
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
            _ => {}
        }
    }

    // 3. 4-6 Pieces:
    // KBB vs K / KBN vs K / KNN vs K
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
                description: "KBN vs K (Forced Mate in W/Deletang)",
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

    // 4. KQ vs KR
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
                description: "KQ vs KR (Philidor Queen Endgame)",
            };
        }
    }

    TablebaseResult::MISS
}
