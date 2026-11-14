use crate::board::Board;
use crate::book::probe_book;
use crate::chess960::{generate_chess960_backrank, generate_chess960_fen};
use crate::gauntlet::compute_elo_stats;
use crate::mcts::run_puct_verification;
use crate::nnue::evaluate_board;
use crate::search::SearchEngine;
use crate::selfplay::run_selfplay_batch;
use crate::smp::{AtomicTT, TTFlag};
use crate::tablebase::{probe_tablebase, TablebaseWdl};
use crate::types::{Color, Move, PieceType};

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

    let mut b = Board::from_fen("4r1kr/pppppppp/8/8/8/8/PPPPPPPP/4R1KR w HEhe - 0 1", true);
    let m_k = b
        .parse_uci_move("g1h1")
        .expect("SP 0 kingside castling g1h1 should parse");
    assert!(m_k.is_castling());
    assert_eq!(m_k.to_uci(true), "g1h1");

    let undo = b.make_move(m_k).expect("SP 0 kingside castling must be legal");
    assert_eq!(b.squares[6], 'K');
    assert_eq!(b.squares[5], 'R');
    assert_eq!(b.squares[7], '.');
    b.unmake_move(m_k, undo);
    assert_eq!(b.squares[6], 'K');
    assert_eq!(b.squares[7], 'R');

    let fen518 = generate_chess960_fen(518, false);
    assert_eq!(
        fen518,
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    );
}

#[test]
fn test_mate_in_one_vs_stalemate() {
    let mut engine = SearchEngine::new(8);

    let mut b_mate = Board::from_fen("6k1/5ppp/8/8/8/8/1Q6/4K3 w - - 0 1", false);
    let (best, score, _) = engine.search(&mut b_mate, 4, 1000, false);
    assert!(score > 20000, "Expected mate score > 20000, got {}", score);
    assert_ne!(best, Move::NULL);
    let u = b_mate.make_move(best).unwrap();
    assert!(
        b_mate.in_check() && b_mate.generate_legal_moves(false).is_empty(),
        "Best move must deliver checkmate"
    );
    b_mate.unmake_move(best, u);

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
    let p_cap = b.parse_uci_move("e4d5").unwrap();
    assert_eq!(b.see(p_cap), 100);

    let mut b3 = Board::from_fen("4k3/8/2p5/3p4/8/2N5/8/4K3 w - - 0 1", false);
    let n_cap = b3.parse_uci_move("c3d5").unwrap();
    assert_eq!(b3.see(n_cap), -220);

    let mut engine = SearchEngine::new(8);
    engine.multi_pv = 3;
    let (_, _, lines) = engine.search(&mut b, 5, 800, false);
    assert_eq!(lines.len(), 3);
    assert_ne!(lines[0].best_move, lines[1].best_move);
    assert_ne!(lines[1].best_move, lines[2].best_move);
}

#[test]
fn test_atomic_tt_pack_and_lazy_smp() {
    let tt = AtomicTT::new(2);
    let mv = Move::new_promo(52, 60, PieceType::Queen);
    let key = 0xCAFE_BABE_1234_5678u64;
    tt.store(key, 12, 245, TTFlag::Exact, mv);
    let probed = tt.probe(key).expect("AtomicTT probe must succeed");
    assert_eq!(probed.depth, 12);
    assert_eq!(probed.score, 245);
    assert_eq!(probed.flag, TTFlag::Exact);
    assert_eq!(probed.best_move, mv);

    let mut null_pack = Move::NULL.pack();
    assert_eq!(null_pack, 0);
    null_pack = Move::unpack(0).pack();
    assert_eq!(null_pack, 0);

    let mut smp_engine = SearchEngine::new(8);
    smp_engine.threads = 2;
    let mut b = Board::startpos();
    let (best, _, _) = smp_engine.search(&mut b, 5, 600, false);
    assert_ne!(best, Move::NULL);
}

#[test]
fn test_book_mcts_gauntlet_and_nnue_mopup() {
    let mut b = Board::startpos();
    let book_mv = probe_book(&mut b, 0).expect("Opening book must return theory move from startpos");
    assert!(b.make_move(book_mv).is_some());

    let mut b_tac = Board::from_fen("r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 3", false);
    let (mcts_mv, _, visits) = run_puct_verification(&mut b_tac, 48).expect("MCTS must choose legal move");
    assert!(visits >= 1);
    assert!(b_tac.make_move(mcts_mv).is_some());

    let (score_pct, elo_diff, _, los) = compute_elo_stats(6, 4, 0);
    assert!((score_pct - 80.0).abs() < 0.01);
    assert!(elo_diff > 200.0);
    assert!(los > 95.0);

    let corner_k = Board::from_fen("7k/8/5K2/8/8/8/4Q3/8 w - - 0 1", false);
    let center_k = Board::from_fen("8/8/8/3k4/8/3K4/4Q3/8 w - - 0 1", false);
    assert!(
        evaluate_board(&corner_k).centipawns > evaluate_board(&center_k).centipawns,
        "Endgame mop-up must reward pushing losing king to edge/corner and keeping winning king close"
    );

    let selfplay = run_selfplay_batch(1, 2, 40, false);
    assert!(selfplay.total_positions > 0);
    assert!(selfplay.texel_mse >= 0.0);

    let mut pht = crate::pawnhash::PawnHashTable::new(1024);
    let end_board = Board::from_fen("4k3/8/8/3P4/8/8/8/4K3 w - - 0 1", false);
    let pe1 = pht.probe_or_eval(&end_board);
    let pe2 = pht.probe_or_eval(&end_board);
    assert_eq!(pe1.key, pe2.key);
    assert!(pe1.w_passed != 0);
    assert!(pe1.eg_score > 0);

    let epd_res = crate::epd::run_tactical_suite(80, 2);
    assert!(epd_res.solved >= 3, "Expected >=3 tactical solves, got {}/{}", epd_res.solved, epd_res.total);

    let (best_t, mse, samples) = crate::tuner::run_texel_tempo_tune(1);
    assert!(samples > 0);
    assert!(best_t >= 4 && best_t <= 24);
    assert!(mse >= 0.0);
}
