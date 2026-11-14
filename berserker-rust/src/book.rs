//! Native Rust Grandmaster Opening Book Trie
//!
//! Compiled directly into the binary from verified mainline & tournament lines.
//! Zero-millisecond lookup by exact Zobrist hash so Berserker plays crisp GM theory
//! in tournaments without burning clock on moves 1-8.

use crate::board::Board;
use crate::types::Move;
use std::collections::HashMap;
use std::sync::OnceLock;

struct BookEntry {
    uci: &'static str,
    weight: u16,
}

const BOOK_LINES: &[(&[&str], u16)] = &[
    // Ruy Lopez (Mainlines: Morphy, Berlin, Marshall, Breyer, Chigorin)
    (&["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5", "a4b3", "d7d6", "c2c3", "e1g1"], 100),
    (&["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5", "a4b3", "e8g8", "c2c3", "d7d5"], 80),
    (&["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "g8f6", "e1g1", "f6e4", "d2d4", "e4d6", "b5c6", "d7c6", "d4e5", "d6f5", "d1d8", "e8d8"], 75),
    (&["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "d2d3", "b7b5", "a4b3", "f8c5"], 65),
    // Italian Game (Giuoco Piano / Two Knights)
    (&["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "c2c3", "g8f6", "d2d3", "d7d6", "e1g1", "a7a6"], 90),
    (&["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "d2d3", "g8f6", "c2c3", "e8g8", "e1g1", "d7d5"], 75),
    (&["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5", "b1c3", "d7d6"], 70),
    // Scotch & Petrov
    (&["e2e4", "e7e5", "g1f3", "b8c6", "d2d4", "e5d4", "f3d4", "g8f6", "d4c6", "b7c6", "e4e5", "d8e7"], 65),
    (&["e2e4", "e7e5", "g1f3", "g8f6", "f3e5", "d7d6", "e5f3", "f6e4", "d2d4", "d6d5", "f1d3", "f8d6"], 75),
    // Sicilian Najdorf, Sveshnikov, Classical, Rossolimo
    (&["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "a7a6", "c1g5", "e7e6", "f2f4", "f8e7"], 100),
    (&["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "a7a6", "f1e2", "e7e5", "d4b3", "f8e7"], 85),
    (&["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "a7a6", "c1e3", "e7e5", "d4b3", "c8e6"], 85),
    (&["e2e4", "c7c5", "g1f3", "b8c6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "e7e5", "d4b5", "d7d6", "c1g5", "a7a6"], 80),
    (&["e2e4", "c7c5", "g1f3", "b8c6", "f1b5", "g7g6", "b5c6", "d7c6", "d2d3", "f8g7", "h2h3", "g8f6"], 75),
    (&["e2e4", "c7c5", "g1f3", "e7e6", "d2d4", "c5d4", "f3d4", "a7a6", "f1d3", "f8c5"], 70),
    // French Defense (Winawer, Tarrasch, Classical)
    (&["e2e4", "e7e6", "d2d4", "d7d5", "b1c3", "f8b4", "e4e5", "c7c5", "a2a3", "b4c3", "b2c3", "g8e7"], 80),
    (&["e2e4", "e7e6", "d2d4", "d7d5", "b1d2", "c7c5", "e4d5", "e6d5", "g1f3", "b8c6", "f1b5", "f8d6"], 75),
    (&["e2e4", "e7e6", "d2d4", "d7d5", "b1c3", "g8f6", "c1g5", "f8e7", "e4e5", "f6d7", "g5e7", "d8e7"], 70),
    // Caro-Kann Defense
    (&["e2e4", "c7c6", "d2d4", "d7d5", "b1c3", "d5e4", "c3e4", "c8f5", "e4g3", "f5g6", "h2h4", "h7h6"], 85),
    (&["e2e4", "c7c6", "d2d4", "d7d5", "e4e5", "c8f5", "g1f3", "e7e6", "f1e2", "c6c5", "c1e3", "b8c6"], 80),
    // Queen's Gambit Declined, Slav, Catalan
    (&["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "c1g5", "f8e7", "e2e3", "h7h6", "g5h4", "e8g8", "g1f3", "b7b6"], 95),
    (&["d2d4", "d7d5", "c2c4", "e7e6", "g1f3", "g8f6", "g2g3", "f8e7", "f1g2", "e8g8", "e1g1", "d5c4", "d1c2", "a7a6"], 95),
    (&["d2d4", "d7d5", "c2c4", "c7c6", "g1f3", "g8f6", "b1c3", "d5c4", "a2a4", "c8f5", "e2e3", "e7e6", "f1c4", "f8b4"], 85),
    (&["d2d4", "d7d5", "c2c4", "d5c4", "e2e4", "e7e5", "g1f3", "e5d4", "f1c4", "b8c6"], 65),
    // Nimzo-Indian & Queen's Indian
    (&["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4", "e2e3", "e8g8", "f1d3", "d7d5", "g1f3", "c7c5", "e1g1", "d5c4"], 95),
    (&["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4", "d1c2", "e8g8", "a2a3", "b4c3", "c2c3", "b7b6"], 85),
    (&["d2d4", "g8f6", "c2c4", "e7e6", "g1f3", "b7b6", "g2g3", "c8a6", "b2b3", "f8b4", "c1d2", "b4e7"], 75),
    // King's Indian & Grunfeld
    (&["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "f8g7", "e2e4", "d7d6", "g1f3", "e8g8", "f1e2", "e7e5", "e1g1", "b8c6", "d4d5", "c6e7"], 90),
    (&["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "d7d5", "c4d5", "f6d5", "e2e4", "d5c3", "b2c3", "f8g7", "g1f3", "c7c5"], 85),
    // English Opening & Reti
    (&["c2c4", "e7e5", "b1c3", "g8f6", "g1f3", "b8c6", "g2g3", "d7d5", "c4d5", "f6d5", "f1g2", "d5b6"], 80),
    (&["c2c4", "g8f6", "b1c3", "e7e6", "g1f3", "d7d5", "d2d4", "f8e7", "c1g5", "e8g8"], 80),
    (&["g1f3", "d7d5", "d2d4", "g8f6", "c2c4", "e7e6", "g2g3", "f8e7", "f1g2", "e8g8"], 80),
];

static BOOK_MAP: OnceLock<HashMap<u64, Vec<BookEntry>>> = OnceLock::new();

fn build_book() -> HashMap<u64, Vec<BookEntry>> {
    let mut map: HashMap<u64, Vec<BookEntry>> = HashMap::with_capacity(512);
    for &(line, weight) in BOOK_LINES {
        let mut board = Board::startpos();
        for &uci in line {
            let key = board.hash;
            if let Some(m) = board.parse_uci_move(uci) {
                let entries = map.entry(key).or_default();
                if let Some(existing) = entries.iter_mut().find(|e| e.uci == uci) {
                    existing.weight = existing.weight.saturating_add(weight / 2);
                } else {
                    entries.push(BookEntry { uci, weight });
                }
                if board.make_move(m).is_none() {
                    break;
                }
            } else {
                break;
            }
        }
    }
    map
}

/// Probes the Grandmaster Opening Book for a verified legal book move in standard chess.
pub fn probe_book(board: &mut Board, salt: u64) -> Option<Move> {
    if board.is_chess960 || board.fullmove > 14 {
        return None;
    }
    let map = BOOK_MAP.get_or_init(build_book);
    let entries = map.get(&board.hash)?;
    if entries.is_empty() {
        return None;
    }

    let total_weight: u64 = entries.iter().map(|e| e.weight as u64).sum();
    if total_weight == 0 {
        return None;
    }

    // Deterministic weighted choice using position hash + optional salt
    let mix = board.hash ^ salt.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut pick = (mix ^ (mix >> 30)) % total_weight;
    let mut chosen_uci = entries[0].uci;
    for e in entries {
        if pick < e.weight as u64 {
            chosen_uci = e.uci;
            break;
        }
        pick -= e.weight as u64;
    }
    board.parse_uci_move(chosen_uci)
}
