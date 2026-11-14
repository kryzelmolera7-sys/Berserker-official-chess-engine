//! Native Bitboard-Accelerated Chess & Chess960 Board Representation

use crate::types::{
    Color, Move, PieceType, FLAG_CASTLE_K, FLAG_DOUBLE_PUSH, FLAG_EN_PASSANT,
};

#[derive(Clone, Copy)]
pub struct UndoInfo {
    #[allow(dead_code)]
    pub captured: char,
    pub captured_pt: PieceType,
    pub castling_rights: u8, // bits: 0=wK, 1=wQ, 2=bK, 3=bQ
    pub ep_sq: Option<u8>,
    pub halfmove: u16,
    pub hash: u64,
}

#[derive(Clone)]
pub struct Board {
    pub squares: [char; 64],
    pub pieces: [[u64; 6]; 2], // [Color][PieceType]
    pub occ: [u64; 2],
    pub occ_all: u64,
    pub stm: Color,
    pub castling_rights: u8,
    pub ep_sq: Option<u8>,
    pub halfmove: u16,
    pub fullmove: u16,
    pub hash: u64,
    pub is_chess960: bool,
    // Starting squares for castling rooks: [White/Black][0=Kingside, 1=Queenside]
    pub castle_rook_sq: [[Option<u8>; 2]; 2],
    pub history_hashes: Vec<u64>,
}

// Precomputed Zobrist keys (deterministic splitmix64)
struct ZobristKeys {
    piece: [[[u64; 64]; 6]; 2],
    stm: u64,
    castling: [u64; 16],
    ep_file: [u64; 8],
}

const fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

const ZOBRIST: ZobristKeys = {
    let mut seed = 0x4245525345524B37u64; // "BERSERK7"
    let mut piece = [[[0u64; 64]; 6]; 2];
    let mut c = 0;
    while c < 2 {
        let mut p = 0;
        while p < 6 {
            let mut s = 0;
            while s < 64 {
                seed = splitmix64(seed);
                piece[c][p][s] = seed;
                s += 1;
            }
            p += 1;
        }
        c += 1;
    }
    seed = splitmix64(seed);
    let stm = seed;

    let mut castling = [0u64; 16];
    let mut i = 0;
    while i < 16 {
        seed = splitmix64(seed);
        castling[i] = seed;
        i += 1;
    }

    let mut ep_file = [0u64; 8];
    let mut f = 0;
    while f < 8 {
        seed = splitmix64(seed);
        ep_file[f] = seed;
        f += 1;
    }

    ZobristKeys {
        piece,
        stm,
        castling,
        ep_file,
    }
};

// Precomputed King and Knight attack masks
pub const KING_ATTACKS: [u64; 64] = {
    let mut table = [0u64; 64];
    let mut sq = 0;
    while sq < 64 {
        let b = 1u64 << sq;
        let not_a = 0xfefefefefefefefeu64;
        let not_h = 0x7f7f7f7f7f7f7f7fu64;
        let mut atk = ((b & not_h) << 1) | ((b & not_a) >> 1);
        let horizontal = b | atk;
        atk |= (horizontal << 8) | (horizontal >> 8);
        table[sq] = atk;
        sq += 1;
    }
    table
};

pub const KNIGHT_ATTACKS: [u64; 64] = {
    let mut table = [0u64; 64];
    let mut sq = 0;
    while sq < 64 {
        let b = 1u64 << sq;
        let not_a = 0xfefefefefefefefeu64;
        let not_ab = 0xfcfcfcfcfcfcfcfcu64;
        let not_h = 0x7f7f7f7f7f7f7f7fu64;
        let not_gh = 0x3f3f3f3f3f3f3f3fu64;
        let mut atk = 0u64;
        atk |= (b & not_h) << 17;
        atk |= (b & not_a) << 15;
        atk |= (b & not_gh) << 10;
        atk |= (b & not_ab) << 6;
        atk |= (b & not_a) >> 17;
        atk |= (b & not_h) >> 15;
        atk |= (b & not_ab) >> 10;
        atk |= (b & not_gh) >> 6;
        table[sq] = atk;
        sq += 1;
    }
    table
};

// Compile-time line exclusion masks for O(1) Hyperbola Quintessence sliding attacks
const RANK_MASK_EXCL: [u64; 64] = {
    let mut t = [0u64; 64];
    let mut sq = 0;
    while sq < 64 {
        let r = sq / 8;
        t[sq] = (0xFFu64 << (r * 8)) ^ (1u64 << sq);
        sq += 1;
    }
    t
};

const FILE_MASK_EXCL: [u64; 64] = {
    let mut t = [0u64; 64];
    let mut sq = 0;
    while sq < 64 {
        let f = sq % 8;
        t[sq] = (0x0101010101010101u64 << f) ^ (1u64 << sq);
        sq += 1;
    }
    t
};

const DIAG_MASK_EXCL: [u64; 64] = {
    let mut t = [0u64; 64];
    let mut sq = 0;
    while sq < 64 {
        let r0 = (sq / 8) as i32;
        let f0 = (sq % 8) as i32;
        let diff = r0 - f0;
        let mut mask = 0u64;
        let mut s = 0;
        while s < 64 {
            let r = (s / 8) as i32;
            let f = (s % 8) as i32;
            if r - f == diff && s != sq {
                mask |= 1u64 << s;
            }
            s += 1;
        }
        t[sq] = mask;
        sq += 1;
    }
    t
};

const ANTIDIAG_MASK_EXCL: [u64; 64] = {
    let mut t = [0u64; 64];
    let mut sq = 0;
    while sq < 64 {
        let r0 = (sq / 8) as i32;
        let f0 = (sq % 8) as i32;
        let sum = r0 + f0;
        let mut mask = 0u64;
        let mut s = 0;
        while s < 64 {
            let r = (s / 8) as i32;
            let f = (s % 8) as i32;
            if r + f == sum && s != sq {
                mask |= 1u64 << s;
            }
            s += 1;
        }
        t[sq] = mask;
        sq += 1;
    }
    t
};

#[inline(always)]
fn hq_attack(sq: u8, occ: u64, mask: u64) -> u64 {
    let s = 1u64 << sq;
    let mut forward = occ & mask;
    let mut reverse = forward.reverse_bits();
    forward = forward.wrapping_sub(s);
    reverse = reverse.wrapping_sub(s.reverse_bits());
    (forward ^ reverse.reverse_bits()) & mask
}

#[derive(Clone, Copy)]
pub struct MoveList {
    pub moves: [Move; 256],
    pub len: usize,
}

impl MoveList {
    #[inline(always)]
    pub fn new() -> Self {
        Self {
            moves: [Move::NULL; 256],
            len: 0,
        }
    }

    #[inline(always)]
    pub fn push(&mut self, m: Move) {
        if self.len < 256 {
            self.moves[self.len] = m;
            self.len += 1;
        }
    }
}

#[inline(always)]
pub fn piece_char(color: Color, pt: PieceType) -> char {
    let c = match pt {
        PieceType::Pawn => 'p',
        PieceType::Knight => 'n',
        PieceType::Bishop => 'b',
        PieceType::Rook => 'r',
        PieceType::Queen => 'q',
        PieceType::King => 'k',
        PieceType::None => return '.',
    };
    if color == Color::White {
        c.to_ascii_uppercase()
    } else {
        c
    }
}

#[inline(always)]
pub fn char_to_color_pt(ch: char) -> Option<(Color, PieceType)> {
    if ch == '.' {
        return None;
    }
    let color = if ch.is_uppercase() {
        Color::White
    } else {
        Color::Black
    };
    let pt = PieceType::from_char(ch);
    if pt == PieceType::None {
        None
    } else {
        Some((color, pt))
    }
}

/// Branchless O(1) Hyperbola Quintessence sliding attack masks
#[inline(always)]
pub fn bishop_attacks(sq: u8, occ: u64) -> u64 {
    let idx = sq as usize;
    hq_attack(sq, occ, DIAG_MASK_EXCL[idx]) | hq_attack(sq, occ, ANTIDIAG_MASK_EXCL[idx])
}

#[inline(always)]
pub fn rook_attacks(sq: u8, occ: u64) -> u64 {
    let idx = sq as usize;
    hq_attack(sq, occ, RANK_MASK_EXCL[idx]) | hq_attack(sq, occ, FILE_MASK_EXCL[idx])
}

impl Board {
    pub fn from_fen(fen: &str, is_chess960: bool) -> Self {
        let mut b = Board {
            squares: ['.'; 64],
            pieces: [[0; 6]; 2],
            occ: [0; 2],
            occ_all: 0,
            stm: Color::White,
            castling_rights: 0,
            ep_sq: None,
            halfmove: 0,
            fullmove: 1,
            hash: 0,
            is_chess960,
            castle_rook_sq: [[None; 2]; 2],
            history_hashes: Vec::with_capacity(256),
        };

        let parts: Vec<&str> = fen.split_whitespace().collect();
        let placement = parts.first().copied().unwrap_or("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR");

        let mut row: i32 = 7;
        let mut col: i32 = 0;
        for c in placement.chars() {
            if c == '/' {
                row -= 1;
                col = 0;
            } else if let Some(d) = c.to_digit(10) {
                col += d as i32;
            } else {
                if (0..8).contains(&row) && (0..8).contains(&col) {
                    let sq = (row * 8 + col) as u8;
                    if let Some((color, pt)) = char_to_color_pt(c) {
                        b.put_piece(sq, color, pt);
                    }
                }
                col += 1;
            }
        }

        b.stm = match parts.get(1).copied().unwrap_or("w") {
            "b" => Color::Black,
            _ => Color::White,
        };

        // Locate kings & parse castling rights (supporting Standard KQkq AND Shredder HAha)
        let w_king_sq = b.king_square(Color::White);
        let b_king_sq = b.king_square(Color::Black);
        let w_king_file = w_king_sq % 8;
        let b_king_file = b_king_sq % 8;

        let castling_str = parts.get(2).copied().unwrap_or("-");
        for ch in castling_str.chars() {
            match ch {
                'K' => {
                    // Rightmost white rook on rank 1
                    let mut r_sq = None;
                    for f in (w_king_file + 1)..8 {
                        if b.squares[f as usize] == 'R' {
                            r_sq = Some(f);
                        }
                    }
                    if let Some(sq) = r_sq {
                        b.castling_rights |= 1;
                        b.castle_rook_sq[0][0] = Some(sq);
                    }
                }
                'Q' => {
                    // Leftmost white rook on rank 1
                    let mut r_sq = None;
                    for f in (0..w_king_file).rev() {
                        if b.squares[f as usize] == 'R' {
                            r_sq = Some(f);
                        }
                    }
                    if let Some(sq) = r_sq {
                        b.castling_rights |= 2;
                        b.castle_rook_sq[0][1] = Some(sq);
                    }
                }
                'k' => {
                    let mut r_sq = None;
                    for f in (b_king_file + 1)..8 {
                        if b.squares[(56 + f) as usize] == 'r' {
                            r_sq = Some(56 + f);
                        }
                    }
                    if let Some(sq) = r_sq {
                        b.castling_rights |= 4;
                        b.castle_rook_sq[1][0] = Some(sq);
                    }
                }
                'q' => {
                    let mut r_sq = None;
                    for f in (0..b_king_file).rev() {
                        if b.squares[(56 + f) as usize] == 'r' {
                            r_sq = Some(56 + f);
                        }
                    }
                    if let Some(sq) = r_sq {
                        b.castling_rights |= 8;
                        b.castle_rook_sq[1][1] = Some(sq);
                    }
                }
                'A'..='H' => {
                    let file = ch as u8 - b'A';
                    let sq = file;
                    if b.squares[sq as usize] == 'R' {
                        if file > w_king_file {
                            b.castling_rights |= 1;
                            b.castle_rook_sq[0][0] = Some(sq);
                        } else if file < w_king_file {
                            b.castling_rights |= 2;
                            b.castle_rook_sq[0][1] = Some(sq);
                        }
                    }
                }
                'a'..='h' => {
                    let file = ch as u8 - b'a';
                    let sq = 56 + file;
                    if b.squares[sq as usize] == 'r' {
                        if file > b_king_file {
                            b.castling_rights |= 4;
                            b.castle_rook_sq[1][0] = Some(sq);
                        } else if file < b_king_file {
                            b.castling_rights |= 8;
                            b.castle_rook_sq[1][1] = Some(sq);
                        }
                    }
                }
                _ => {}
            }
        }

        if let Some(&ep_str) = parts.get(3) {
            if ep_str != "-" && ep_str.len() == 2 {
                let bytes = ep_str.as_bytes();
                if (b'a'..=b'h').contains(&bytes[0]) && (b'1'..=b'8').contains(&bytes[1]) {
                    let sq = (bytes[1] - b'1') * 8 + (bytes[0] - b'a');
                    b.ep_sq = Some(sq);
                }
            }
        }

        b.halfmove = parts.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
        b.fullmove = parts.get(5).and_then(|s| s.parse().ok()).unwrap_or(1);
        b.hash = b.recompute_hash();
        b.history_hashes.push(b.hash);
        b
    }

    pub fn startpos() -> Self {
        Self::from_fen(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            false,
        )
    }

    #[inline(always)]
    fn put_piece(&mut self, sq: u8, color: Color, pt: PieceType) {
        let bit = 1u64 << sq;
        self.squares[sq as usize] = piece_char(color, pt);
        self.pieces[color.idx()][pt as usize] |= bit;
        self.occ[color.idx()] |= bit;
        self.occ_all |= bit;
    }

    #[inline(always)]
    fn remove_piece(&mut self, sq: u8, color: Color, pt: PieceType) {
        let not_bit = !(1u64 << sq);
        self.squares[sq as usize] = '.';
        self.pieces[color.idx()][pt as usize] &= not_bit;
        self.occ[color.idx()] &= not_bit;
        self.occ_all &= not_bit;
    }

    pub fn recompute_hash(&self) -> u64 {
        let mut h = 0u64;
        for sq in 0..64 {
            if let Some((color, pt)) = char_to_color_pt(self.squares[sq]) {
                h ^= ZOBRIST.piece[color.idx()][pt as usize][sq];
            }
        }
        if self.stm == Color::Black {
            h ^= ZOBRIST.stm;
        }
        h ^= ZOBRIST.castling[(self.castling_rights & 0x0F) as usize];
        if let Some(ep) = self.ep_sq {
            h ^= ZOBRIST.ep_file[(ep % 8) as usize];
        }
        h
    }

    #[inline(always)]
    pub fn king_square(&self, color: Color) -> u8 {
        let kbb = self.pieces[color.idx()][PieceType::King as usize];
        if kbb == 0 {
            if color == Color::White { 4 } else { 60 }
        } else {
            kbb.trailing_zeros() as u8
        }
    }

    #[inline]
    pub fn is_square_attacked(&self, sq: u8, by: Color) -> bool {
        let c = by.idx();
        let bit = 1u64 << sq;

        // 1. Pawns attacking sq
        let pawns = self.pieces[c][PieceType::Pawn as usize];
        if pawns != 0 {
            let not_a = 0xfefefefefefefefeu64;
            let not_h = 0x7f7f7f7f7f7f7f7fu64;
            let pawn_attacks = if by == Color::White {
                // White pawns attack +7 (up-left) and +9 (up-right), so sq is attacked by pawns at sq-7 or sq-9
                ((bit & not_h) >> 7) | ((bit & not_a) >> 9)
            } else {
                // Black pawns attack -7 (down-right) and -9 (down-left)
                ((bit & not_a) << 7) | ((bit & not_h) << 9)
            };
            if (pawns & pawn_attacks) != 0 {
                return true;
            }
        }

        // 2. Knights
        if (KNIGHT_ATTACKS[sq as usize] & self.pieces[c][PieceType::Knight as usize]) != 0 {
            return true;
        }

        // 3. Kings
        if (KING_ATTACKS[sq as usize] & self.pieces[c][PieceType::King as usize]) != 0 {
            return true;
        }

        // 4. Bishops / Queens
        let diag = self.pieces[c][PieceType::Bishop as usize] | self.pieces[c][PieceType::Queen as usize];
        if diag != 0 && (bishop_attacks(sq, self.occ_all) & diag) != 0 {
            return true;
        }

        // 5. Rooks / Queens
        let ortho = self.pieces[c][PieceType::Rook as usize] | self.pieces[c][PieceType::Queen as usize];
        if ortho != 0 && (rook_attacks(sq, self.occ_all) & ortho) != 0 {
            return true;
        }

        false
    }

    #[inline(always)]
    pub fn in_check(&self) -> bool {
        self.is_square_attacked(self.king_square(self.stm), self.stm.opp())
    }

    #[inline(always)]
    pub fn has_non_pawn_material(&self, color: Color) -> bool {
        let c = color.idx();
        (self.pieces[c][PieceType::Knight as usize]
            | self.pieces[c][PieceType::Bishop as usize]
            | self.pieces[c][PieceType::Rook as usize]
            | self.pieces[c][PieceType::Queen as usize])
            != 0
    }

    pub fn is_repetition(&self) -> bool {
        if self.halfmove < 4 || self.history_hashes.len() < 5 {
            return false;
        }
        let cur = self.hash;
        let lookback = (self.halfmove as usize).min(self.history_hashes.len() - 1);
        let len = self.history_hashes.len();
        let mut i = 2;
        while i <= lookback {
            if self.history_hashes[len - 1 - i] == cur {
                return true;
            }
            i += 2;
        }
        false
    }

    /// Generates all pseudo-legal moves (filtered cleanly to legal via make_move)
    pub fn generate_pseudo_legal(&self, captures_only: bool) -> Vec<Move> {
        let mut list = MoveList::new();
        self.generate_pseudo_legal_into(captures_only, &mut list);
        list.moves[..list.len].to_vec()
    }

    pub fn generate_pseudo_legal_into(&self, captures_only: bool, moves: &mut MoveList) {
        moves.len = 0;
        let us = self.stm;
        let them = us.opp();
        let us_idx = us.idx();
        let them_occ = self.occ[them.idx()];
        let empty = !self.occ_all;

        // 1. Pawns
        let mut pawns = self.pieces[us_idx][PieceType::Pawn as usize];
        while pawns != 0 {
            let from = pawns.trailing_zeros() as u8;
            pawns &= pawns - 1;
            let f_col = from % 8;
            let f_row = from / 8;

            // Quiet pushes
            if !captures_only {
                let to = if us == Color::White { from + 8 } else { from - 8 };
                if ((1u64 << to) & empty) != 0 {
                    let t_row = to / 8;
                    if t_row == 7 || t_row == 0 {
                        moves.push(Move::new_promo(from, to, PieceType::Queen));
                        moves.push(Move::new_promo(from, to, PieceType::Rook));
                        moves.push(Move::new_promo(from, to, PieceType::Bishop));
                        moves.push(Move::new_promo(from, to, PieceType::Knight));
                    } else {
                        moves.push(Move::new(from, to));
                        if (us == Color::White && f_row == 1) || (us == Color::Black && f_row == 6) {
                            let to2 = if us == Color::White { from + 16 } else { from - 16 };
                            if ((1u64 << to2) & empty) != 0 {
                                moves.push(Move::with_flags(from, to2, FLAG_DOUBLE_PUSH));
                            }
                        }
                    }
                }
            } else {
                // In Q-search, generate quiet Queen promotions
                let to = if us == Color::White { from + 8 } else { from - 8 };
                let t_row = to / 8;
                if (t_row == 7 || t_row == 0) && ((1u64 << to) & empty) != 0 {
                    moves.push(Move::new_promo(from, to, PieceType::Queen));
                }
            }

            // Captures (left & right)
            for df in [-1i32, 1i32] {
                let tc = f_col as i32 + df;
                if !(0..8).contains(&tc) {
                    continue;
                }
                let to = if us == Color::White {
                    (from as i32 + 8 + df) as u8
                } else {
                    (from as i32 - 8 + df) as u8
                };
                if ((1u64 << to) & them_occ) != 0 {
                    let t_row = to / 8;
                    if t_row == 7 || t_row == 0 {
                        moves.push(Move::new_promo(from, to, PieceType::Queen));
                        moves.push(Move::new_promo(from, to, PieceType::Rook));
                        moves.push(Move::new_promo(from, to, PieceType::Bishop));
                        moves.push(Move::new_promo(from, to, PieceType::Knight));
                    } else {
                        moves.push(Move::new(from, to));
                    }
                } else if self.ep_sq == Some(to) {
                    moves.push(Move::with_flags(from, to, FLAG_EN_PASSANT));
                }
            }
        }

        let target_mask = if captures_only {
            them_occ
        } else {
            !self.occ[us_idx]
        };

        // 2. Knights
        let mut knights = self.pieces[us_idx][PieceType::Knight as usize];
        while knights != 0 {
            let from = knights.trailing_zeros() as u8;
            knights &= knights - 1;
            let mut atk = KNIGHT_ATTACKS[from as usize] & target_mask;
            while atk != 0 {
                let to = atk.trailing_zeros() as u8;
                atk &= atk - 1;
                moves.push(Move::new(from, to));
            }
        }

        // 3. Bishops
        let mut bishops = self.pieces[us_idx][PieceType::Bishop as usize];
        while bishops != 0 {
            let from = bishops.trailing_zeros() as u8;
            bishops &= bishops - 1;
            let mut atk = bishop_attacks(from, self.occ_all) & target_mask;
            while atk != 0 {
                let to = atk.trailing_zeros() as u8;
                atk &= atk - 1;
                moves.push(Move::new(from, to));
            }
        }

        // 4. Rooks
        let mut rooks = self.pieces[us_idx][PieceType::Rook as usize];
        while rooks != 0 {
            let from = rooks.trailing_zeros() as u8;
            rooks &= rooks - 1;
            let mut atk = rook_attacks(from, self.occ_all) & target_mask;
            while atk != 0 {
                let to = atk.trailing_zeros() as u8;
                atk &= atk - 1;
                moves.push(Move::new(from, to));
            }
        }

        // 5. Queens
        let mut queens = self.pieces[us_idx][PieceType::Queen as usize];
        while queens != 0 {
            let from = queens.trailing_zeros() as u8;
            queens &= queens - 1;
            let mut atk = (bishop_attacks(from, self.occ_all) | rook_attacks(from, self.occ_all))
                & target_mask;
            while atk != 0 {
                let to = atk.trailing_zeros() as u8;
                atk &= atk - 1;
                moves.push(Move::new(from, to));
            }
        }

        // 6. King
        let k_from = self.king_square(us);
        let mut k_atk = KING_ATTACKS[k_from as usize] & target_mask;
        while k_atk != 0 {
            let to = k_atk.trailing_zeros() as u8;
            k_atk &= k_atk - 1;
            moves.push(Move::new(k_from, to));
        }

        // 7. Castling (Standard & Chess960 / FIDE FRC compliant!)
        if !captures_only && !self.in_check() {
            let rank_base: u8 = if us == Color::White { 0 } else { 56 };
            let ks_right = if us == Color::White { 1 } else { 4 };
            let qs_right = if us == Color::White { 2 } else { 8 };

            // Kingside castling
            if (self.castling_rights & ks_right) != 0 {
                if let Some(rook_sq) = self.castle_rook_sq[us_idx][0] {
                    let dest_k = rank_base + 6; // g1 / g8
                    let dest_r = rank_base + 5; // f1 / f8
                    if self.can_castle_path(k_from, dest_k, rook_sq, dest_r, them) {
                        moves.push(Move::new_castle(k_from, dest_k, rook_sq, true));
                    }
                }
            }

            // Queenside castling
            if (self.castling_rights & qs_right) != 0 {
                if let Some(rook_sq) = self.castle_rook_sq[us_idx][1] {
                    let dest_k = rank_base + 2; // c1 / c8
                    let dest_r = rank_base + 3; // d1 / d8
                    if self.can_castle_path(k_from, dest_k, rook_sq, dest_r, them) {
                        moves.push(Move::new_castle(k_from, dest_k, rook_sq, false));
                    }
                }
            }
        }
    }

    #[inline]
    fn can_castle_path(
        &self,
        k_from: u8,
        k_to: u8,
        r_from: u8,
        r_to: u8,
        them: Color,
    ) -> bool {
        // Ensure rook is actually still on r_from
        let expected_rook = if them == Color::Black { 'R' } else { 'r' };
        if self.squares[r_from as usize] != expected_rook {
            return false;
        }

        let k_min = k_from.min(k_to);
        let k_max = k_from.max(k_to);
        let r_min = r_from.min(r_to);
        let r_max = r_from.max(r_to);

        // 1. All transit/destination squares for king & rook must be empty (excluding k_from and r_from)
        for sq in k_min..=k_max {
            if sq != k_from && sq != r_from && self.squares[sq as usize] != '.' {
                return false;
            }
        }
        for sq in r_min..=r_max {
            if sq != k_from && sq != r_from && self.squares[sq as usize] != '.' {
                return false;
            }
        }

        // 2. King transit squares must not be under attack (note: k_from was already verified via !in_check)
        for sq in k_min..=k_max {
            if sq != k_from && self.is_square_attacked(sq, them) {
                return false;
            }
        }

        true
    }

    pub fn generate_legal_moves(&mut self, captures_only: bool) -> Vec<Move> {
        let pseudo = self.generate_pseudo_legal(captures_only);
        let mut legal = Vec::with_capacity(pseudo.len());
        for m in pseudo {
            if let Some(undo) = self.make_move(m) {
                legal.push(m);
                self.unmake_move(m, undo);
            }
        }
        legal
    }

    /// Executes a move; returns None and leaves board unchanged if it leaves own king in check
    pub fn make_move(&mut self, m: Move) -> Option<UndoInfo> {
        let us = self.stm;
        let them = us.opp();
        let us_idx = us.idx();
        let them_idx = them.idx();

        let undo = UndoInfo {
            captured: self.squares[m.to as usize],
            captured_pt: PieceType::from_char(self.squares[m.to as usize]),
            castling_rights: self.castling_rights,
            ep_sq: self.ep_sq,
            halfmove: self.halfmove,
            hash: self.hash,
        };

        // XOR out old castling & ep
        let mut h = self.hash;
        h ^= ZOBRIST.castling[(self.castling_rights & 0x0F) as usize];
        if let Some(ep) = self.ep_sq {
            h ^= ZOBRIST.ep_file[(ep % 8) as usize];
        }
        self.ep_sq = None;

        if m.is_castling() {
            let r_from = m.rook_from;
            let r_to = if m.flags == FLAG_CASTLE_K {
                if us == Color::White { 5 } else { 61 }
            } else {
                if us == Color::White { 3 } else { 59 }
            };

            self.remove_piece(m.from, us, PieceType::King);
            h ^= ZOBRIST.piece[us_idx][PieceType::King as usize][m.from as usize];
            self.remove_piece(r_from, us, PieceType::Rook);
            h ^= ZOBRIST.piece[us_idx][PieceType::Rook as usize][r_from as usize];

            self.put_piece(m.to, us, PieceType::King);
            h ^= ZOBRIST.piece[us_idx][PieceType::King as usize][m.to as usize];
            self.put_piece(r_to, us, PieceType::Rook);
            h ^= ZOBRIST.piece[us_idx][PieceType::Rook as usize][r_to as usize];

            // Clear castling rights for this side
            if us == Color::White {
                self.castling_rights &= !0b0011;
            } else {
                self.castling_rights &= !0b1100;
            }
            self.halfmove += 1;
        } else {
            let moving_pt = PieceType::from_char(self.squares[m.from as usize]);

            // Handle capture
            if m.is_en_passant() {
                let cap_sq = if us == Color::White { m.to - 8 } else { m.to + 8 };
                self.remove_piece(cap_sq, them, PieceType::Pawn);
                h ^= ZOBRIST.piece[them_idx][PieceType::Pawn as usize][cap_sq as usize];
            } else if undo.captured_pt != PieceType::None {
                self.remove_piece(m.to, them, undo.captured_pt);
                h ^= ZOBRIST.piece[them_idx][undo.captured_pt as usize][m.to as usize];

                // Revoke opponent castling rights if capturing their rook on initial rook square
                if undo.captured_pt == PieceType::Rook {
                    if self.castle_rook_sq[them_idx][0] == Some(m.to) {
                        self.castling_rights &= if them == Color::White { !1 } else { !4 };
                    } else if self.castle_rook_sq[them_idx][1] == Some(m.to) {
                        self.castling_rights &= if them == Color::White { !2 } else { !8 };
                    }
                }
            }

            // Move piece
            self.remove_piece(m.from, us, moving_pt);
            h ^= ZOBRIST.piece[us_idx][moving_pt as usize][m.from as usize];
            let placed_pt = if m.promo != PieceType::None {
                m.promo
            } else {
                moving_pt
            };
            self.put_piece(m.to, us, placed_pt);
            h ^= ZOBRIST.piece[us_idx][placed_pt as usize][m.to as usize];

            // Revoke our castling rights if King or Rook moved
            if moving_pt == PieceType::King {
                self.castling_rights &= if us == Color::White { !0b0011 } else { !0b1100 };
            } else if moving_pt == PieceType::Rook {
                if self.castle_rook_sq[us_idx][0] == Some(m.from) {
                    self.castling_rights &= if us == Color::White { !1 } else { !4 };
                } else if self.castle_rook_sq[us_idx][1] == Some(m.from) {
                    self.castling_rights &= if us == Color::White { !2 } else { !8 };
                }
            }

            // Set EP square on double push
            if m.flags == FLAG_DOUBLE_PUSH {
                let ep = (m.from + m.to) / 2;
                self.ep_sq = Some(ep);
                h ^= ZOBRIST.ep_file[(ep % 8) as usize];
            }

            if moving_pt == PieceType::Pawn || undo.captured_pt != PieceType::None || m.is_en_passant() {
                self.halfmove = 0;
            } else {
                self.halfmove += 1;
            }
        }

        h ^= ZOBRIST.castling[(self.castling_rights & 0x0F) as usize];
        h ^= ZOBRIST.stm;
        self.hash = h;
        if us == Color::Black {
            self.fullmove += 1;
        }
        self.stm = them;

        // Check legality: our king must not be left in check!
        if self.is_square_attacked(self.king_square(us), them) {
            self.unmake_move(m, undo);
            return None;
        }

        self.history_hashes.push(self.hash);
        Some(undo)
    }

    pub fn unmake_move(&mut self, m: Move, undo: UndoInfo) {
        if self.history_hashes.last().copied() == Some(self.hash) && self.hash != undo.hash {
            self.history_hashes.pop();
        }
        let them = self.stm; // color that DIDN'T make the move
        let us = them.opp();

        self.stm = us;
        if us == Color::Black {
            self.fullmove -= 1;
        }
        self.castling_rights = undo.castling_rights;
        self.ep_sq = undo.ep_sq;
        self.halfmove = undo.halfmove;
        self.hash = undo.hash;

        if m.is_castling() {
            let r_from = m.rook_from;
            let r_to = if m.flags == FLAG_CASTLE_K {
                if us == Color::White { 5 } else { 61 }
            } else {
                if us == Color::White { 3 } else { 59 }
            };
            self.remove_piece(m.to, us, PieceType::King);
            self.remove_piece(r_to, us, PieceType::Rook);
            self.put_piece(m.from, us, PieceType::King);
            self.put_piece(r_from, us, PieceType::Rook);
        } else {
            let placed_pt = PieceType::from_char(self.squares[m.to as usize]);
            let orig_pt = if m.promo != PieceType::None {
                PieceType::Pawn
            } else {
                placed_pt
            };

            self.remove_piece(m.to, us, placed_pt);
            self.put_piece(m.from, us, orig_pt);

            if m.is_en_passant() {
                let cap_sq = if us == Color::White { m.to - 8 } else { m.to + 8 };
                self.put_piece(cap_sq, them, PieceType::Pawn);
            } else if undo.captured_pt != PieceType::None {
                self.put_piece(m.to, them, undo.captured_pt);
            }
        }
    }

    /// Null Move for Null Move Pruning (NMP)
    pub fn make_null_move(&mut self) -> (Option<u8>, u64) {
        let old_ep = self.ep_sq;
        let old_hash = self.hash;
        if let Some(ep) = old_ep {
            self.hash ^= ZOBRIST.ep_file[(ep % 8) as usize];
        }
        self.ep_sq = None;
        self.stm = self.stm.opp();
        self.hash ^= ZOBRIST.stm;
        (old_ep, old_hash)
    }

    pub fn unmake_null_move(&mut self, old_ep: Option<u8>, old_hash: u64) {
        self.ep_sq = old_ep;
        self.stm = self.stm.opp();
        self.hash = old_hash;
    }

    /// Static Exchange Evaluation (SEE) — exact swap-off calculation on square `to`
    pub fn see(&self, m: Move) -> i32 {
        if m.is_en_passant() {
            return 100;
        }
        let target_pt = PieceType::from_char(self.squares[m.to as usize]);
        let promo_gain = if m.promo != PieceType::None {
            m.promo.value_cp() - 100
        } else {
            0
        };
        if target_pt == PieceType::None && promo_gain == 0 {
            return 0;
        }

        let mut gain = [0i32; 32];
        let mut d = 0usize;
        gain[0] = target_pt.value_cp() + promo_gain;

        let mut occ = self.occ_all ^ (1u64 << m.from);
        let mut stm = self.stm.opp();
        let mut attacker_pt = if m.promo != PieceType::None {
            m.promo
        } else {
            PieceType::from_char(self.squares[m.from as usize])
        };

        let sq = m.to;
        let not_a = 0xfefefefefefefefeu64;
        let not_h = 0x7f7f7f7f7f7f7f7fu64;
        let bit = 1u64 << sq;

        loop {
            d += 1;
            if d >= 32 {
                break;
            }
            gain[d] = attacker_pt.value_cp() - gain[d - 1];

            let c = stm.idx();
            // Find least valuable attacker of sq by `stm` among `occ`
            let mut next_attacker = PieceType::None;
            let mut next_sq = 64u8;

            // 1. Pawns
            let pawn_mask = if stm == Color::White {
                ((bit & not_h) >> 7) | ((bit & not_a) >> 9)
            } else {
                ((bit & not_a) << 7) | ((bit & not_h) << 9)
            };
            let p_bb = self.pieces[c][PieceType::Pawn as usize] & occ & pawn_mask;
            if p_bb != 0 {
                next_attacker = PieceType::Pawn;
                next_sq = p_bb.trailing_zeros() as u8;
            } else {
                // 2. Knights
                let n_bb = self.pieces[c][PieceType::Knight as usize] & occ & KNIGHT_ATTACKS[sq as usize];
                if n_bb != 0 {
                    next_attacker = PieceType::Knight;
                    next_sq = n_bb.trailing_zeros() as u8;
                } else {
                    // 3. Bishops
                    let diag_atk = bishop_attacks(sq, occ);
                    let b_bb = self.pieces[c][PieceType::Bishop as usize] & occ & diag_atk;
                    if b_bb != 0 {
                        next_attacker = PieceType::Bishop;
                        next_sq = b_bb.trailing_zeros() as u8;
                    } else {
                        // 4. Rooks
                        let ortho_atk = rook_attacks(sq, occ);
                        let r_bb = self.pieces[c][PieceType::Rook as usize] & occ & ortho_atk;
                        if r_bb != 0 {
                            next_attacker = PieceType::Rook;
                            next_sq = r_bb.trailing_zeros() as u8;
                        } else {
                            // 5. Queens
                            let q_bb = self.pieces[c][PieceType::Queen as usize] & occ & (diag_atk | ortho_atk);
                            if q_bb != 0 {
                                next_attacker = PieceType::Queen;
                                next_sq = q_bb.trailing_zeros() as u8;
                            } else {
                                // 6. King
                                let k_bb = self.pieces[c][PieceType::King as usize] & occ & KING_ATTACKS[sq as usize];
                                if k_bb != 0 {
                                    next_attacker = PieceType::King;
                                    next_sq = k_bb.trailing_zeros() as u8;
                                }
                            }
                        }
                    }
                }
            }

            if next_attacker == PieceType::None {
                break;
            }
            occ ^= 1u64 << next_sq;
            attacker_pt = next_attacker;
            stm = stm.opp();
        }

        while d > 1 {
            d -= 1;
            gain[d - 1] = -((-gain[d - 1]).max(gain[d]));
        }
        gain[0]
    }

    /// Parses a UCI move string (standard or Chess960 castling format) and matches it to a legal move
    pub fn parse_uci_move(&mut self, uci: &str) -> Option<Move> {
        let trim = uci.trim();
        if trim.len() < 4 {
            return None;
        }
        let bytes = trim.as_bytes();
        let f_col = bytes[0].checked_sub(b'a')?;
        let f_row = bytes[1].checked_sub(b'1')?;
        let t_col = bytes[2].checked_sub(b'a')?;
        let t_row = bytes[3].checked_sub(b'1')?;
        if f_col >= 8 || f_row >= 8 || t_col >= 8 || t_row >= 8 {
            return None;
        }
        let from = f_row * 8 + f_col;
        let to = t_row * 8 + t_col;
        let promo = if trim.len() >= 5 {
            PieceType::from_char(bytes[4] as char)
        } else {
            PieceType::None
        };

        let legal = self.generate_legal_moves(false);
        for m in legal {
            if m.from == from && m.promo == promo {
                if m.to == to || (m.is_castling() && m.rook_from == to) {
                    return Some(m);
                }
            }
        }
        None
    }

    /// Legal move tree leaf-node counter for mathematically verifying move generation
    pub fn perft(&mut self, depth: u8) -> u64 {
        if depth == 0 {
            return 1;
        }
        let moves = self.generate_legal_moves(false);
        if depth == 1 {
            return moves.len() as u64;
        }
        let mut nodes = 0u64;
        for m in moves {
            if let Some(undo) = self.make_move(m) {
                nodes += self.perft(depth - 1);
                self.unmake_move(m, undo);
            }
        }
        nodes
    }

    /// Collects pieces for Tablebase probing
    pub fn collect_pieces(&self) -> (Vec<(u8, char)>, Vec<(u8, char)>) {
        let mut wp = Vec::with_capacity(16);
        let mut bp = Vec::with_capacity(16);
        for (sq, &ch) in self.squares.iter().enumerate() {
            if ch != '.' {
                if ch.is_uppercase() {
                    wp.push((sq as u8, ch));
                } else {
                    bp.push((sq as u8, ch));
                }
            }
        }
        (wp, bp)
    }
}
