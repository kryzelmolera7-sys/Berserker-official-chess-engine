//! Pawn Structure & Passed-Pawn Hash Cache for NNUE / Positional Evaluation
//!
//! Keyed directly by `board.pawn_hash` (incremental Zobrist) with bitboard evaluation
//! of phalanx/connected chains, doubled, isolated, backward, and passed pawns.

use crate::board::Board;
use crate::types::PieceType;

const NOT_A: u64 = 0xfefe_fefe_fefe_fefeu64;
const NOT_H: u64 = 0x7f7f_7f7f_7f7f_7f7fu64;

pub const FILE_MASKS: [u64; 8] = [
    0x0101010101010101,
    0x0202020202020202,
    0x0404040404040404,
    0x0808080808080808,
    0x1010101010101010,
    0x2020202020202020,
    0x4040404040404040,
    0x8080808080808080,
];

pub const ADJ_MASKS: [u64; 8] = [
    FILE_MASKS[1],
    FILE_MASKS[0] | FILE_MASKS[2],
    FILE_MASKS[1] | FILE_MASKS[3],
    FILE_MASKS[2] | FILE_MASKS[4],
    FILE_MASKS[3] | FILE_MASKS[5],
    FILE_MASKS[4] | FILE_MASKS[6],
    FILE_MASKS[5] | FILE_MASKS[7],
    FILE_MASKS[6],
];

const PASSED_BONUS_MG: [i32; 8] = [0, 5, 10, 20, 40, 75, 125, 0];
const PASSED_BONUS_EG: [i32; 8] = [0, 12, 22, 38, 72, 120, 185, 0];

#[derive(Clone, Copy)]
pub struct PawnEvalEntry {
    pub key: u64,
    pub mg_score: i32,
    pub eg_score: i32,
    pub w_passed: u64,
    pub b_passed: u64,
    pub w_semi_open_files: u8,
    pub b_semi_open_files: u8,
}

impl Default for PawnEvalEntry {
    fn default() -> Self {
        Self {
            key: 0,
            mg_score: 0,
            eg_score: 0,
            w_passed: 0,
            b_passed: 0,
            w_semi_open_files: 0,
            b_semi_open_files: 0,
        }
    }
}

pub struct PawnHashTable {
    entries: Vec<PawnEvalEntry>,
    mask: usize,
}

impl PawnHashTable {
    pub fn new(num_entries_pow2: usize) -> Self {
        let size = num_entries_pow2.max(1024).next_power_of_two();
        Self {
            entries: vec![PawnEvalEntry::default(); size],
            mask: size - 1,
        }
    }

    #[inline(always)]
    pub fn compute_pawn_key(w_pawns: u64, b_pawns: u64) -> u64 {
        w_pawns.wrapping_mul(0x9E37_79B9_7F4A_7C15)
            ^ b_pawns.wrapping_mul(0xBF58_476D_1CE4_E5B9)
            ^ (w_pawns.rotate_left(17) ^ b_pawns.rotate_right(13))
    }

    #[inline]
    pub fn probe_or_eval(&mut self, board: &Board) -> PawnEvalEntry {
        let wp = board.pieces[0][PieceType::Pawn as usize];
        let bp = board.pieces[1][PieceType::Pawn as usize];
        let key = if board.pawn_hash != 0 {
            board.pawn_hash
        } else {
            Self::compute_pawn_key(wp, bp)
        };
        let idx = (key as usize) & self.mask;

        let cached = self.entries[idx];
        if cached.key == key && key != 0 {
            return cached;
        }

        let mut mg = 0i32;
        let mut eg = 0i32;
        let mut w_passed = 0u64;
        let mut b_passed = 0u64;
        let mut w_semi = 0u8;
        let mut b_semi = 0u8;

        for f in 0..8 {
            if (wp & FILE_MASKS[f]) == 0 {
                w_semi |= 1 << f;
            }
            if (bp & FILE_MASKS[f]) == 0 {
                b_semi |= 1 << f;
            }
        }

        let w_atk = ((wp & NOT_A) << 7) | ((wp & NOT_H) << 9);
        let b_atk = ((bp & NOT_H) >> 7) | ((bp & NOT_A) >> 9);

        // Phalanx (horizontal pairs) + supported chains
        let w_phalanx = ((((wp & NOT_A) >> 1) | ((wp & NOT_H) << 1)) & wp).count_ones() as i32;
        let b_phalanx = ((((bp & NOT_A) >> 1) | ((bp & NOT_H) << 1)) & bp).count_ones() as i32;
        mg += (w_phalanx - b_phalanx) * 7;
        eg += (w_phalanx - b_phalanx) * 6;

        let w_supported = (w_atk & wp).count_ones() as i32;
        let b_supported = (b_atk & bp).count_ones() as i32;
        mg += (w_supported - b_supported) * 9;
        eg += (w_supported - b_supported) * 7;

        let mut bb = wp;
        while bb != 0 {
            let sq = bb.trailing_zeros() as usize;
            bb &= bb - 1;
            let f = sq % 8;
            let r = sq / 8;
            let open_ahead = (bp & FILE_MASKS[f] & (!0u64).checked_shl(((r + 1) * 8) as u32).unwrap_or(0)) == 0;

            if (wp & FILE_MASKS[f]).count_ones() > 1 {
                mg -= if open_ahead { 8 } else { 13 };
                eg -= if open_ahead { 14 } else { 20 };
            }
            if (wp & ADJ_MASKS[f]) == 0 {
                mg -= if open_ahead { 18 } else { 11 };
                eg -= if open_ahead { 20 } else { 14 };
            } else {
                // Backward pawn: no friendly pawn adjacent behind or level, and stop square attacked by enemy pawn
                let behind_or_level = 1u64
                    .checked_shl(((r + 1) * 8) as u32)
                    .map(|v| v.wrapping_sub(1))
                    .unwrap_or(!0u64);
                if (wp & ADJ_MASKS[f] & behind_or_level) == 0 && (b_atk & (1u64 << (sq + 8))) != 0 {
                    mg -= 13;
                    eg -= 11;
                }
            }

            let fwd = (!0u64).checked_shl(((r + 1) * 8) as u32).unwrap_or(0);
            if (bp & (FILE_MASKS[f] | ADJ_MASKS[f]) & fwd) == 0 {
                w_passed |= 1u64 << sq;
                mg += PASSED_BONUS_MG[r];
                eg += PASSED_BONUS_EG[r];
            }
        }

        let mut bb2 = bp;
        while bb2 != 0 {
            let sq = bb2.trailing_zeros() as usize;
            bb2 &= bb2 - 1;
            let f = sq % 8;
            let r = sq / 8;
            let fwd_b = 1u64
                .checked_shl((r * 8) as u32)
                .map(|v| v.wrapping_sub(1))
                .unwrap_or(!0u64);
            let open_ahead = (wp & FILE_MASKS[f] & fwd_b) == 0;

            if (bp & FILE_MASKS[f]).count_ones() > 1 {
                mg += if open_ahead { 8 } else { 13 };
                eg += if open_ahead { 14 } else { 20 };
            }
            if (bp & ADJ_MASKS[f]) == 0 {
                mg += if open_ahead { 18 } else { 11 };
                eg += if open_ahead { 20 } else { 14 };
            } else {
                let behind_or_level = (!0u64).checked_shl((r * 8) as u32).unwrap_or(0);
                if (bp & ADJ_MASKS[f] & behind_or_level) == 0 && sq >= 8 && (w_atk & (1u64 << (sq - 8))) != 0 {
                    mg += 13;
                    eg += 11;
                }
            }

            if (wp & (FILE_MASKS[f] | ADJ_MASKS[f]) & fwd_b) == 0 {
                b_passed |= 1u64 << sq;
                mg -= PASSED_BONUS_MG[7 - r];
                eg -= PASSED_BONUS_EG[7 - r];
            }
        }

        let entry = PawnEvalEntry {
            key,
            mg_score: mg,
            eg_score: eg,
            w_passed,
            b_passed,
            w_semi_open_files: w_semi,
            b_semi_open_files: b_semi,
        };
        if key != 0 {
            self.entries[idx] = entry;
        }
        entry
    }
}
