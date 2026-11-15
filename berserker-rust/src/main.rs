//! Berserker v0.7.0 Native Rust Engine - UCI Command Loop

mod types;
mod chess960;
mod nnue;
mod tablebase;
mod search;

use std::io::{self, BufRead};
use types::{Color};
use search::SearchEngine;
use chess960::{generate_chess960_backrank, extract_castling_config};

fn parse_fen(fen: &str) -> ([char; 64], Color) {
    let mut board = ['.'; 64];
    let parts: Vec<&str> = fen.split_whitespace().collect();
    let placement = parts.get(0).unwrap_or(&"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR");
    let stm = match parts.get(1).copied().unwrap_or("w") {
        "b" => Color::Black,
        _ => Color::White,
    };

    let mut row: i32 = 7;
    let mut col: i32 = 0;

    for c in placement.chars() {
        if c == '/' {
            row -= 1;
            col = 0;
        } else if let Some(digit) = c.to_digit(10) {
            col += digit as i32;
        } else {
            if row >= 0 && row < 8 && col >= 0 && col < 8 {
                let idx = (row * 8 + col) as usize;
                board[idx] = c;
            }
            col += 1;
        }
    }

    (board, stm)
}

fn apply_uci_move(board: &mut [char; 64], uci: &str) {
    if uci.len() < 4 { return; }
    let bytes = uci.as_bytes();
    let f_col = (bytes[0] - b'a') as usize;
    let f_row = (bytes[1] - b'1') as usize;
    let t_col = (bytes[2] - b'a') as usize;
    let t_row = (bytes[3] - b'1') as usize;

    let from = f_row * 8 + f_col;
    let to = t_row * 8 + t_col;

    if from < 64 && to < 64 {
        let mut piece = board[from];
        if uci.len() >= 5 {
            let promo = bytes[4] as char;
            piece = if piece.is_uppercase() { promo.to_ascii_uppercase() } else { promo.to_ascii_lowercase() };
        }
        board[to] = piece;
        board[from] = '.';
    }
}

fn main() {
    println!("Berserker v0.7.0 (Native Rust Edition)");
    let mut engine = SearchEngine::new(32);
    let (mut board, mut stm) = parse_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l.trim().to_string(),
            Err(_) => break,
        };

        if line.is_empty() { continue; }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let cmd = tokens[0];

        match cmd {
            "uci" => {
                println!("id name Berserker v0.7.0 (Rust)");
                println!("id author Berserker Engine Team");
                println!("option name UCI_Chess960 type check default false");
                println!("option name MultiPV type spin default 1 min 1 max 5");
                println!("option name Hash type spin default 32 min 1 max 1024");
                println!("uciok");
            }
            "isready" => {
                println!("readyok");
            }
            "ucinewgame" => {
                engine.clear();
                let (b, s) = parse_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
                board = b;
                stm = s;
            }
            "position" => {
                if tokens.len() > 1 {
                    if tokens[1] == "startpos" {
                        let (b, s) = parse_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
                        board = b;
                        stm = s;
                        if let Some(pos) = tokens.iter().position(|&t| t == "moves") {
                            for &m in &tokens[pos + 1..] {
                                apply_uci_move(&mut board, m);
                                stm = stm.opp();
                            }
                        }
                    } else if tokens[1] == "fen" {
                        let fen_tokens: Vec<&str> = tokens.iter().skip(2).take_while(|&&t| t != "moves").copied().collect();
                        let fen_str = fen_tokens.join(" ");
                        let (b, s) = parse_fen(&fen_str);
                        board = b;
                        stm = s;
                        if let Some(pos) = tokens.iter().position(|&t| t == "moves") {
                            for &m in &tokens[pos + 1..] {
                                apply_uci_move(&mut board, m);
                                stm = stm.opp();
                            }
                        }
                    }
                }
            }
            "go" => {
                let mut depth = 10;
                let mut movetime = 2000;

                if let Some(pos) = tokens.iter().position(|&t| t == "depth") {
                    if let Some(d) = tokens.get(pos + 1).and_then(|s| s.parse().ok()) {
                        depth = d;
                    }
                }
                if let Some(pos) = tokens.iter().position(|&t| t == "movetime") {
                    if let Some(t) = tokens.get(pos + 1).and_then(|s| s.parse().ok()) {
                        movetime = t;
                    }
                }

                let (best_move, _) = engine.search(&mut board, stm, depth, movetime);
                println!("bestmove {}", best_move.to_uci());
            }
            "chess960" => {
                let sp: u16 = tokens.get(1).and_then(|s| s.parse().ok()).unwrap_or(518);
                let backrank = generate_chess960_backrank(sp);
                let cfg = extract_castling_config(&backrank, sp);
                println!("info string Chess960 SP #{}: Backrank {} WhiteKingFile: {}", sp, backrank, cfg.white_king_file);
            }
            "bench" => {
                println!("Running Berserker Native Rust Benchmark...");
                let start = std::time::Instant::now();
                let (mut b, s) = parse_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
                let (m, score) = engine.search(&mut b, s, 10, 3000);
                println!("Benchmark completed in {}ms. Best move: {} Score: {}cp", start.elapsed().as_millis(), m.to_uci(), score);
            }
            "quit" => {
                break;
            }
            _ => {}
        }
    }
}
