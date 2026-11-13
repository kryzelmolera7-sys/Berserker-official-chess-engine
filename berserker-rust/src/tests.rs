use crate::board::Board;
use crate::chess960::{generate_chess960_backrank, generate_chess960_fen};
use crate::search::SearchEngine;
use crate::tablebase::{probe_tablebase, TablebaseWdl};
use crate::types::{Color, Move};

#[test]
fn test_startpos_perft() {
    let mut b = Board::startpos();
    assert_eq!(b.perft(1), 20);
    assert_eq!(b.perft(2), 400);
    assert_eq!(b.perft(3), 8902);
    assert_eq!(b.perft(4), 197281);
}

#[test]
fn test_kiwipete_perft() {
    let mut b = Board::from_fen(
        "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
        false,
    );
    assert_eq!(b.perft(1), 48);
    assert_eq!(b.perft(2), 2039);
    assert_eq!(b.perft(3), 97862);
}

#[test]
fn test_en_passant_and_promotion_perft() {
    // Position with EP legality & pins
    let mut b = Board::from_fen("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", false);
    assert_eq!(b.perft(1), 14);
    assert_eq!(b.perft(2), 191);
    assert_eq!(b.perft(3), 2812);
    assert_eq!(b.perft(4), 43238);
}

#[test]
fn test_chess960_backranks_and_castling() {
    assert_eq!(generate_chess960_backrank(0), "BBQNNRKR");
    assert_eq!(generate_chess960_backrank(518), "RNBQKBNR");
    assert_eq!(generate_chess960_backrank(959), "RKRNNQBB");

    // SP 0 Shredder FEN: White K at g1 (sq 6), rooks on e1 (sq 4) and h1 (sq 7).
    // Clear knights/bishops to allow castling both ways in SP 0
    let mut b = Board::from_fen("4r1kr/pppppppp/8/8/8/8/PPPPPPPP/4R1KR w HEhe - 0 1", true);
    let m_k = b.parse_uci_move("g1h1").expect("SP 0 kingside castling g1h1 should parse");
    assert!(m_k.is_castling());
    assert_eq!(m_k.to_uci(true), "g1h1");

    let undo = b.make_move(m_k).expect("SP 0 kingside castling must be legal");
    assert_eq!(b.squares[6], 'K'); // King lands on g1
    assert_eq!(b.squares[5], 'R'); // Rook lands on f1
    assert_eq!(b.squares[7], '.'); // Rook moved off h1
    b.unmake_move(m_k, undo);
    assert_eq!(b.squares[6], 'K');
    assert_eq!(b.squares[7], 'R');

    let fen518 = generate_chess960_fen(518, false);
    assert_eq!(fen518, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
}

#[test]
fn test_mate_in_one_vs_stalemate() {
    let mut engine = SearchEngine::new(8);

    // White Queen + King mate in 1: Qb7# or Qd8#
    let mut b_mate = Board::from_fen("6k1/5ppp/8/8/8/8/1Q6/4K3 w - - 0 1", false);
    let (best, score, _) = engine.search(&mut b_mate, 4, 1000, false);
    assert!(score > 20000, "Expected mate score > 20000, got {}", score);
    assert_ne!(best, Move::NULL);
    let u = b_mate.make_move(best).unwrap();
    assert!(b_mate.in_check() && b_mate.generate_legal_moves(false).is_empty(), "Best move must deliver checkmate");
    b_mate.unmake_move(best, u);

    // Immediate stalemate position -> 0 moves and NOT in check => score == 0
    let mut b_stale = Board::from_fen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", false);
    let (m_s, score_s, _) = engine.search(&mut b_stale, 2, 200, false);
    assert_eq!(m_s, Move::NULL);
    assert_eq!(score_s, 0);
}

#[test]
fn test_tablebase_symmetry() {
    let b_win = Board::from_fen("8/8/8/8/4K3/8/4Q3/7k w - - 0 1", false);
    let (wp, bp) = b_win.collect_pieces();
    let res_w = probe_tablebase(&wp, &bp, Color::White);
    assert_eq!(res_w.wdl, TablebaseWdl::Win);

    let b_loss = Board::from_fen("8/8/8/8/4k3/8/4q3/7K w - - 0 1", false);
    let (wp2, bp2) = b_loss.collect_pieces();
    let res_l = probe_tablebase(&wp2, &bp2, Color::White);
    assert_eq!(res_l.wdl, TablebaseWdl::Loss);
}

#[test]
fn test_see_and_multipv() {
    let mut b = Board::from_fen("4k3/8/8/3p4/4P3/8/8/4K2Q w - - 0 1", false);
    // White queen on h1 capturing defended pawn on d5? Let's test Q captures pawn defended by nothing vs Pawn captures pawn
    let p_cap = b.parse_uci_move("e4d5").unwrap();
    assert_eq!(b.see(p_cap), 100);

    let mut b3 = Board::from_fen("4k3/8/2p5/3p4/8/2N5/8/4K3 w - - 0 1", false);
    let n_cap = b3.parse_uci_move("c3d5").unwrap();
    // Knight (320) captures Pawn (100), recaptured by c6 Pawn -> SEE = 100 - 320 = -220
    assert_eq!(b3.see(n_cap), -220);

    let mut engine = SearchEngine::new(8);
    engine.multi_pv = 3;
    let (_, _, lines) = engine.search(&mut b, 5, 800, false);
    assert_eq!(lines.len(), 3);
    assert_ne!(lines[0].best_move, lines[1].best_move);
    assert_ne!(lines[1].best_move, lines[2].best_move);
}
