//! Core Chess types for Berserker v0.7.0 Native Rust Engine

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Color {
    White = 0,
    Black = 1,
}

impl Color {
    #[inline(always)]
    pub fn opp(self) -> Self {
        match self {
            Color::White => Color::Black,
            Color::Black => Color::White,
        }
    }

    #[inline(always)]
    pub fn idx(self) -> usize {
        self as usize
    }
}

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum PieceType {
    Pawn = 0,
    Knight = 1,
    Bishop = 2,
    Rook = 3,
    Queen = 4,
    King = 5,
    None = 6,
}

impl PieceType {
    #[inline(always)]
    pub fn from_char(c: char) -> Self {
        match c.to_ascii_lowercase() {
            'p' => PieceType::Pawn,
            'n' => PieceType::Knight,
            'b' => PieceType::Bishop,
            'r' => PieceType::Rook,
            'q' => PieceType::Queen,
            'k' => PieceType::King,
            _ => PieceType::None,
        }
    }

    #[inline(always)]
    pub fn value_cp(self) -> i32 {
        match self {
            PieceType::Pawn => 100,
            PieceType::Knight => 320,
            PieceType::Bishop => 335,
            PieceType::Rook => 500,
            PieceType::Queen => 950,
            PieceType::King => 20000,
            PieceType::None => 0,
        }
    }
}

pub const FLAG_NONE: u8 = 0;
pub const FLAG_DOUBLE_PUSH: u8 = 1;
pub const FLAG_EN_PASSANT: u8 = 2;
pub const FLAG_CASTLE_K: u8 = 3;
pub const FLAG_CASTLE_Q: u8 = 4;

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct Move {
    pub from: u8,
    pub to: u8, // For castling: destination square of the king (g1/c1/g8/c8)
    pub promo: PieceType,
    pub flags: u8,
    pub rook_from: u8, // Starting square of the rook for castling (supports Chess960!)
}

impl Move {
    pub const NULL: Move = Move {
        from: 0,
        to: 0,
        promo: PieceType::None,
        flags: FLAG_NONE,
        rook_from: 0,
    };

    #[inline(always)]
    pub fn new(from: u8, to: u8) -> Self {
        Self {
            from,
            to,
            promo: PieceType::None,
            flags: FLAG_NONE,
            rook_from: 0,
        }
    }

    #[inline(always)]
    pub fn with_flags(from: u8, to: u8, flags: u8) -> Self {
        Self {
            from,
            to,
            promo: PieceType::None,
            flags,
            rook_from: 0,
        }
    }

    #[inline(always)]
    pub fn new_castle(king_from: u8, king_to: u8, rook_from: u8, is_kingside: bool) -> Self {
        Self {
            from: king_from,
            to: king_to,
            promo: PieceType::None,
            flags: if is_kingside { FLAG_CASTLE_K } else { FLAG_CASTLE_Q },
            rook_from,
        }
    }

    #[inline(always)]
    pub fn new_promo(from: u8, to: u8, promo: PieceType) -> Self {
        Self {
            from,
            to,
            promo,
            flags: FLAG_NONE,
            rook_from: 0,
        }
    }

    #[inline(always)]
    pub fn is_castling(self) -> bool {
        self.flags == FLAG_CASTLE_K || self.flags == FLAG_CASTLE_Q
    }

    #[inline(always)]
    pub fn is_en_passant(self) -> bool {
        self.flags == FLAG_EN_PASSANT
    }

    pub fn to_uci(self, uci_chess960: bool) -> String {
        if self == Move::NULL {
            return "0000".to_string();
        }
        let f_col = (self.from % 8) + b'a';
        let f_row = (self.from / 8) + b'1';
        let dest_sq = if uci_chess960 && self.is_castling() {
            self.rook_from
        } else {
            self.to
        };
        let t_col = (dest_sq % 8) + b'a';
        let t_row = (dest_sq / 8) + b'1';
        let promo_char = match self.promo {
            PieceType::Queen => "q",
            PieceType::Rook => "r",
            PieceType::Bishop => "b",
            PieceType::Knight => "n",
            _ => "",
        };
        format!(
            "{}{}{}{}{}",
            f_col as char, f_row as char, t_col as char, t_row as char, promo_char
        )
    }
}
