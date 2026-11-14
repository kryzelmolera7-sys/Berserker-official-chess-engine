//! Tactical & Positional EPD Benchmark Suite (Win At Chess / Bratko-Kopec / Endgame Suite)
//!
//! Runs deterministic tactical solve-rate verification natively in Rust via SearchEngine
//! so search regressions or strength gains can be measured in milliseconds.

use crate::board::Board;
use crate::search::SearchEngine;
use std::time::Instant;

pub struct EpdCase {
    pub id: &'static str,
    pub fen: &'static str,
    pub best_uci_any: &'static [&'static str],
}

pub const TACTICAL_SUITE: &[EpdCase] = &[
    EpdCase {
        id: "WAC.001",
        fen: "2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1",
        best_uci_any: &["g3g6"],
    },
    EpdCase {
        id: "WAC.002",
        fen: "8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1",
        best_uci_any: &["b3b2"],
    },
    EpdCase {
        id: "WAC.003",
        fen: "5rk1/1ppb3p/p1pb4/6q1/3P1p1r/2P1R2P/PP1BQ1P1/5RKN w - - 0 1",
        best_uci_any: &["e3g3"],
    },
    EpdCase {
        id: "WAC.004",
        fen: "r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - 0 1",
        best_uci_any: &["h6h7"],
    },
    EpdCase {
        id: "WAC.005",
        fen: "5k2/6pp/p1qN4/1p1p4/3P4/2PKP2Q/PP3r2/3R4 b - - 0 1",
        best_uci_any: &["c6c4"],
    },
    EpdCase {
        id: "WAC.007",
        fen: "r3q1kr/ppp5/3p2pQ/8/3PP1b1/5R2/PPP3P1/5RK1 w - - 0 1",
        best_uci_any: &["f3f8"],
    },
    EpdCase {
        id: "WAC.010",
        fen: "r4rk1/ppp2ppp/2n5/2bqp3/8/P2PB3/1PP1NPPP/R2Q1RK1 w - - 0 1",
        best_uci_any: &["e2c3"],
    },
    EpdCase {
        id: "WAC.014",
        fen: "r2q1rk1/1ppnbppp/p2p1nb1/3Pp3/2P1P1P1/2N2N1P/PPB1QP2/R1B2RK1 b - - 0 1",
        best_uci_any: &["f6g4"],
    },
    EpdCase {
        id: "WAC.018",
        fen: "r1b2rk1/2p2ppp/p7/1p6/3P3q/1BP3bP/PP3QP1/RNB1R1K1 w - - 0 1",
        best_uci_any: &["f2f7"],
    },
    EpdCase {
        id: "MATE.M1",
        fen: "6k1/5ppp/8/8/8/8/1Q6/4K3 w - - 0 1",
        best_uci_any: &["b2b8", "b2h8"],
    },
    EpdCase {
        id: "END.LUCENA",
        fen: "1K6/1P6/8/8/8/3k4/r7/4R3 w - - 0 1",
        best_uci_any: &["e1e3", "b8c7", "b8c8"],
    },
    EpdCase {
        id: "BRATKO.01",
        fen: "1k1r4/pp1b1R2/3q2pp/4p3/2B5/4Q3/PPP2B2/2K5 b - - 0 1",
        best_uci_any: &["d6d1"],
    },
];

pub struct SuiteResult {
    pub solved: usize,
    pub total: usize,
    pub elapsed_ms: u128,
}

pub fn run_tactical_suite(movetime_ms: u128, threads: usize) -> SuiteResult {
    let start = Instant::now();
    let mut engine = SearchEngine::new(32);
    engine.threads = threads.clamp(1, 16);

    let mut solved = 0usize;
    for tc in TACTICAL_SUITE {
        let _ = tc.id;
        engine.clear();
        let mut board = Board::from_fen(tc.fen, false);
        let (mv, _, _) = engine.search(&mut board, 14, movetime_ms, false);
        let uci = mv.to_uci(false);
        if tc.best_uci_any.contains(&uci.as_str()) {
            solved += 1;
        }
    }

    SuiteResult {
        solved,
        total: TACTICAL_SUITE.len(),
        elapsed_ms: start.elapsed().as_millis(),
    }
}
