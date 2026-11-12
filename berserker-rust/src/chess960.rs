//! Chess960 (Fischer Random Chess) Implementation in Native Rust

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chess960Config {
    pub sp_index: u16,
    pub white_king_file: u8,
    pub white_queen_rook_file: u8,
    pub white_king_rook_file: u8,
    pub black_king_file: u8,
    pub black_queen_rook_file: u8,
    pub black_king_rook_file: u8,
}

const KNIGHT_PAIRS: [(u8, u8); 10] = [
    (0, 1), (0, 2), (0, 3), (0, 4),
    (1, 2), (1, 3), (1, 4),
    (2, 3), (2, 4),
    (3, 4),
];

/// Generates the standard 8-piece backrank for Scharnagl SP index 0..959
pub fn generate_chess960_backrank(index: u16) -> String {
    let mut rank: [Option<char>; 8] = [None; 8];

    // 1. Light-square bishop on b, d, f, h (indices 1, 3, 5, 7)
    let d1 = (index % 4) as usize;
    rank[2 * d1 + 1] = Some('B');
    let q1 = index / 4;

    // 2. Dark-square bishop on a, c, e, g (indices 0, 2, 4, 6)
    let d2 = (q1 % 4) as usize;
    rank[2 * d2] = Some('B');
    let q2 = q1 / 4;

    // 3. Queen in remaining 6 empty squares
    let d3 = (q2 % 6) as usize;
    let mut empty_idx = 0;
    for i in 0..8 {
        if rank[i].is_none() {
            if empty_idx == d3 {
                rank[i] = Some('Q');
                break;
            }
            empty_idx += 1;
        }
    }
    let q3 = (q2 / 6) as usize;

    // 4. Knights in remaining 5 empty squares
    let (k1, k2) = KNIGHT_PAIRS[q3];
    empty_idx = 0;
    for i in 0..8 {
        if rank[i].is_none() {
            if empty_idx == k1 as usize || empty_idx == k2 as usize {
                rank[i] = Some('N');
            }
            empty_idx += 1;
        }
    }

    // 5. Remaining 3 empty squares: R, K, R (King strictly between Rooks)
    empty_idx = 0;
    for i in 0..8 {
        if rank[i].is_none() {
            if empty_idx == 0 { rank[i] = Some('R'); }
            else if empty_idx == 1 { rank[i] = Some('K'); }
            else if empty_idx == 2 { rank[i] = Some('R'); }
            empty_idx += 1;
        }
    }

    rank.iter().map(|c| c.unwrap()).collect()
}

pub fn extract_castling_config(backrank: &str, sp_index: u16) -> Chess960Config {
    let mut king_file = 4;
    let mut queen_rook_file = 0;
    let mut king_rook_file = 7;
    let mut found_king = false;

    for (c, ch) in backrank.chars().enumerate() {
        if ch == 'R' {
            if !found_king {
                queen_rook_file = c as u8;
            } else {
                king_rook_file = c as u8;
            }
        } else if ch == 'K' {
            king_file = c as u8;
            found_king = true;
        }
    }

    Chess960Config {
        sp_index,
        white_king_file: king_file,
        white_queen_rook_file: queen_rook_file,
        white_king_rook_file: king_rook_file,
        black_king_file: king_file,
        black_queen_rook_file: queen_rook_file,
        black_king_rook_file: king_rook_file,
    }
}
