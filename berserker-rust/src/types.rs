//! Core Chess types for Berserker v0.7.0 Rust Engine

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

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct Move {
    pub from: u8,
    pub to: u8,
    pub promo: PieceType,
    pub is_castling: bool,
    pub is_en_passant: bool,
}

impl Move {
    pub const NULL: Move = Move {
        from: 0,
        to: 0,
        promo: PieceType::None,
        is_castling: false,
        is_en_passant: false,
    };

    pub fn new(from: u8, to: u8) -> Self {
        Self {
            from,
            to,
            promo: PieceType::None,
            is_castling: false,
            is_en_passant: false,
        }
    }

    pub fn new_promo(from: u8, to: u8, promo: PieceType) -> Self {
        Self {
            from,
            to,
            promo,
            is_castling: false,
            is_en_passant: false,
        }
    }

    pub fn to_uci(self) -> String {
        let f_col = (self.from % 8) as u8 + b'a';
        let f_row = (self.from / 8) as u8 + b'1';
        let t_col = (self.to % 8) as u8 + b'a';
        let t_row = (self.to / 8) as u8 + b'1';
        let promo_char = match self.promo {
            PieceType::Queen => "q",
            PieceType::Rook => "r",
            PieceType::Bishop => "b",
            PieceType::Knight => "n",
            _ => "",
        };
        format!("{}{}{}{}{}", f_col as char, f_row as char, t_col as char, t_row as char, promo_char)
    }
}
