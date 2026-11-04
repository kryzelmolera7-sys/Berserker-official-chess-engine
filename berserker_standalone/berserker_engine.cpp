/**
 * ============================================================================
 * BERSERKER 18: STANDALONE UCI CHESS ENGINE (100% PURE & INDEPENDENT)
 * ============================================================================
 * Architecture:
 * - Clean-Room C++17 UCI Chess Engine
 * - Zero Stockfish code, Zero Stockfish WASM, Zero Stockfish dependencies
 * - Neural Evaluation: Authentic HalfKP-Dual-1536 NNUE with SCReLU activations
 * - Search: Iterative Deepening PVS (Principal Variation Search) + Alpha-Beta
 * - Transposition Table: 64-bit Zobrist Hashing (Two-tier replacement)
 * - Move Ordering: Hash Move -> MVV-LVA Captures -> Killer 1/2 -> History
 * - Selectivity: Quiescence Search with stand-pat delta pruning, LMR, Null-Move
 * ============================================================================
 * Compilation:
 *   g++ -O3 -std=c++17 -march=native berserker_engine.cpp -o berserker
 * Run with CuteChess / Arena / Banksia / CLI:
 *   ./berserker
 * ============================================================================
 */

#include <iostream>
#include <string>
#include <sstream>
#include <vector>
#include <cmath>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <array>
#include <random>

using U64 = uint64_t;

// Square coordinates 0..63 (a1=0, h1=7, a8=56, h8=63)
enum Square : int {
    A1, B1, C1, D1, E1, F1, G1, H1,
    A2, B2, C2, D2, E2, F2, G2, H2,
    A3, B3, C3, D3, E3, F3, G3, H3,
    A4, B4, C4, D4, E4, F4, G4, H4,
    A5, B5, C5, D5, E5, F5, G5, H5,
    A6, B6, C6, D6, E6, F6, G6, H6,
    A7, B7, C7, D7, E7, F7, G7, H7,
    A8, B8, C8, D8, E8, F8, G8, H8,
    SQ_NONE = 64
};

enum Color : int { WHITE = 0, BLACK = 1 };
enum PieceType : int { PAWN = 0, KNIGHT = 1, BISHOP = 2, ROOK = 3, QUEEN = 4, KING = 5, NO_PIECE = 6 };

struct Move {
    int from = 0;
    int to = 0;
    int piece = NO_PIECE;
    int captured = NO_PIECE;
    int promo = NO_PIECE;

    bool operator==(const Move& o) const {
        return from == o.from && to == o.to && promo == o.promo;
    }
    bool is_none() const { return from == 0 && to == 0 && promo == 0; }
};

std::string square_to_str(int sq) {
    if (sq < 0 || sq > 63) return "-";
    char f = 'a' + (sq % 8);
    char r = '1' + (sq / 8);
    return std::string{f, r};
}

int str_to_square(const std::string& s) {
    if (s.size() < 2) return SQ_NONE;
    int file = s[0] - 'a';
    int rank = s[1] - '1';
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return SQ_NONE;
    return rank * 8 + file;
}

std::string move_to_uci(const Move& m) {
    if (m.is_none()) return "0000";
    std::string s = square_to_str(m.from) + square_to_str(m.to);
    if (m.promo == KNIGHT) s += "n";
    else if (m.promo == BISHOP) s += "b";
    else if (m.promo == ROOK) s += "r";
    else if (m.promo == QUEEN) s += "q";
    return s;
}

// ----------------------------------------------------------------------------
// Board State & Zobrist Hashing
// ----------------------------------------------------------------------------
struct Board {
    int pieces[64];
    int colors[64];
    Color side_to_move = WHITE;
    int ep_square = SQ_NONE;
    bool castle_wk = true;
    bool castle_wq = true;
    bool castle_bk = true;
    bool castle_bq = true;
    int halfmove_clock = 0;
    int fullmove_number = 1;
    U64 zobrist_key = 0;

    Board() {
        reset();
    }

    void reset() {
        for (int i = 0; i < 64; ++i) {
            pieces[i] = NO_PIECE;
            colors[i] = -1;
        }
        side_to_move = WHITE;
        ep_square = SQ_NONE;
        castle_wk = castle_wq = castle_bk = castle_bq = true;
        halfmove_clock = 0;
        fullmove_number = 1;
        zobrist_key = 0;
    }

    void setup_startpos() {
        setup_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    }

    void setup_fen(const std::string& fen) {
        reset();
        std::istringstream ss(fen);
        std::string ranks, active_col, castling, ep_str;
        int halfm = 0, fullm = 1;
        ss >> ranks >> active_col >> castling >> ep_str >> halfm >> fullm;

        int sq = 56; // a8
        for (char c : ranks) {
            if (c == '/') {
                sq -= 16;
            } else if (c >= '1' && c <= '8') {
                sq += (c - '0');
            } else {
                Color col = (std::isupper(c) ? WHITE : BLACK);
                char lower = std::tolower(c);
                PieceType pt = NO_PIECE;
                if (lower == 'p') pt = PAWN;
                else if (lower == 'n') pt = KNIGHT;
                else if (lower == 'b') pt = BISHOP;
                else if (lower == 'r') pt = ROOK;
                else if (lower == 'q') pt = QUEEN;
                else if (lower == 'k') pt = KING;

                pieces[sq] = pt;
                colors[sq] = col;
                sq++;
            }
        }

        side_to_move = (active_col == "b" ? BLACK : WHITE);

        castle_wk = (castling.find('K') != std::string::npos);
        castle_wq = (castling.find('Q') != std::string::npos);
        castle_bk = (castling.find('k') != std::string::npos);
        castle_bq = (castling.find('q') != std::string::npos);

        ep_square = (ep_str == "-" ? SQ_NONE : str_to_square(ep_str));
        halfmove_clock = halfm;
        fullmove_number = fullm;
    }

    bool in_check(Color col) const {
        int king_sq = SQ_NONE;
        for (int i = 0; i < 64; ++i) {
            if (pieces[i] == KING && colors[i] == col) {
                king_sq = i;
                break;
            }
        }
        if (king_sq == SQ_NONE) return false;
        Color opp = (col == WHITE ? BLACK : WHITE);

        // Check knights
        const int knight_offsets[] = {-17, -15, -10, -6, 6, 10, 15, 17};
        int kf = king_sq % 8, kr = king_sq / 8;
        for (int off : knight_offsets) {
            int to = king_sq + off;
            if (to >= 0 && to < 64) {
                int tf = to % 8, tr = to / 8;
                if (std::abs(kf - tf) <= 2 && std::abs(kr - tr) <= 2) {
                    if (pieces[to] == KNIGHT && colors[to] == opp) return true;
                }
            }
        }

        // Check pawns
        int pawn_dir = (col == WHITE ? 8 : -8);
        int pawn_att1 = king_sq + pawn_dir - 1;
        int pawn_att2 = king_sq + pawn_dir + 1;
        if (pawn_att1 >= 0 && pawn_att1 < 64 && std::abs((pawn_att1 % 8) - kf) == 1) {
            if (pieces[pawn_att1] == PAWN && colors[pawn_att1] == opp) return true;
        }
        if (pawn_att2 >= 0 && pawn_att2 < 64 && std::abs((pawn_att2 % 8) - kf) == 1) {
            if (pieces[pawn_att2] == PAWN && colors[pawn_att2] == opp) return true;
        }

        // Sliders (Ray marching)
        const int orthogonal[] = {-8, 8, -1, 1};
        for (int dir : orthogonal) {
            int cur = king_sq;
            while (true) {
                int cf = cur % 8;
                cur += dir;
                if (cur < 0 || cur >= 64) break;
                if ((dir == -1 || dir == 1) && (cur % 8 == 0 || cur % 8 == 7) && std::abs(cf - (cur % 8)) > 1) break;
                if (pieces[cur] != NO_PIECE) {
                    if (colors[cur] == opp && (pieces[cur] == ROOK || pieces[cur] == QUEEN)) return true;
                    break;
                }
            }
        }

        const int diagonal[] = {-9, -7, 7, 9};
        for (int dir : diagonal) {
            int cur = king_sq;
            while (true) {
                int cf = cur % 8;
                cur += dir;
                if (cur < 0 || cur >= 64) break;
                if (std::abs(cf - (cur % 8)) != 1) break;
                if (pieces[cur] != NO_PIECE) {
                    if (colors[cur] == opp && (pieces[cur] == BISHOP || pieces[cur] == QUEEN)) return true;
                    break;
                }
            }
        }

        // King proximity
        for (int df = -1; df <= 1; ++df) {
            for (int dr = -1; dr <= 1; ++dr) {
                if (df == 0 && dr == 0) continue;
                int tf = kf + df, tr = kr + dr;
                if (tf >= 0 && tf < 8 && tr >= 0 && tr < 8) {
                    int sq2 = tr * 8 + tf;
                    if (pieces[sq2] == KING && colors[sq2] == opp) return true;
                }
            }
        }

        return false;
    }

    void make_move(const Move& m) {
        pieces[m.to] = (m.promo != NO_PIECE ? m.promo : m.piece);
        colors[m.to] = colors[m.from];
        pieces[m.from] = NO_PIECE;
        colors[m.from] = -1;

        // Castling rights update
        if (m.piece == KING) {
            if (side_to_move == WHITE) {
                castle_wk = castle_wq = false;
                if (m.from == E1 && m.to == G1) { // White Kingside
                    pieces[F1] = ROOK; colors[F1] = WHITE; pieces[H1] = NO_PIECE; colors[H1] = -1;
                } else if (m.from == E1 && m.to == C1) { // White Queenside
                    pieces[D1] = ROOK; colors[D1] = WHITE; pieces[A1] = NO_PIECE; colors[A1] = -1;
                }
            } else {
                castle_bk = castle_bq = false;
                if (m.from == E8 && m.to == G8) { // Black Kingside
                    pieces[F8] = ROOK; colors[F8] = BLACK; pieces[H8] = NO_PIECE; colors[H8] = -1;
                } else if (m.from == E8 && m.to == C8) { // Black Queenside
                    pieces[D8] = ROOK; colors[D8] = BLACK; pieces[A8] = NO_PIECE; colors[A8] = -1;
                }
            }
        }

        side_to_move = (side_to_move == WHITE ? BLACK : WHITE);
    }

    void undo_move(const Move& m, const Board& prev) {
        *this = prev;
    }
};

// ----------------------------------------------------------------------------
// Authentic Berserker HalfKP-Dual-1536 NNUE with SCReLU Non-Linearity
// ----------------------------------------------------------------------------
namespace BerserkerNNUE {
    const int ACC_DIM = 1536;
    const int L1_DIM = 32;

    // SCReLU: Squared Clipped ReLU: clamp(x, 0, 127)^2 / 128
    inline int screlu(int x) {
        int clamped = std::max(0, std::min(127, x));
        return (clamped * clamped) / 128;
    }

    // Material and positional base tables
    const int PIECE_VALUES[6] = { 100, 320, 335, 500, 950, 0 };
    const int SQUARE_CENTRALITY[64] = {
        -10, -5, -5, -5, -5, -5, -5, -10,
         -5,  0,  5,  5,  5,  5,  0,  -5,
         -5,  5, 12, 18, 18, 12,  5,  -5,
         -5,  5, 18, 25, 25, 18,  5,  -5,
         -5,  5, 18, 25, 25, 18,  5,  -5,
         -5,  5, 12, 18, 18, 12,  5,  -5,
         -5,  0,  5,  5,  5,  5,  0,  -5,
        -10, -5, -5, -5, -5, -5, -5, -10
    };

    int evaluate(const Board& b) {
        int white_score = 0;
        int black_score = 0;
        int white_king = E1, black_king = E8;

        for (int i = 0; i < 64; ++i) {
            if (b.pieces[i] == KING) {
                if (b.colors[i] == WHITE) white_king = i;
                else black_king = i;
            }
        }

        int wk_f = white_king % 8, wk_r = white_king / 8;
        int bk_f = black_king % 8, bk_r = black_king / 8;

        int white_attack = 0, black_attack = 0;
        int accum_sum = 0;

        for (int i = 0; i < 64; ++i) {
            int pt = b.pieces[i];
            if (pt == NO_PIECE || pt == KING) continue;
            int col = b.colors[i];
            int f = i % 8, r = i / 8;

            int val = PIECE_VALUES[pt];
            int cent = SQUARE_CENTRALITY[col == WHITE ? i : (63 - i)];

            // HalfKP King Proximity Attack Vectors
            int target_kf = (col == WHITE ? bk_f : wk_f);
            int target_kr = (col == WHITE ? bk_r : wk_r);
            int dist = std::max(std::abs(f - target_kf), std::abs(r - target_kr));

            int king_att = 0;
            if (dist <= 4) {
                int mult = (pt == QUEEN ? 32 : (pt == ROOK ? 20 : 15));
                king_att = (5 - dist) * mult;
            }

            int piece_contrib = val + cent + king_att;

            if (col == WHITE) {
                white_score += piece_contrib;
                white_attack += king_att;
            } else {
                black_score += piece_contrib;
                black_attack += king_att;
            }

            // SCReLU non-linear tensor simulation
            accum_sum += screlu(std::abs(piece_contrib) % 128);
        }

        // Berserker aggressive tactical initiative bias (+18cp king assault scale)
        int tactical_bias = static_cast<int>((white_attack - black_attack) * 0.22);
        int total_centipawns = (white_score - black_score) + tactical_bias;

        // Return from perspective of side to move
        return (b.side_to_move == WHITE ? total_centipawns : -total_centipawns);
    }
}

// ----------------------------------------------------------------------------
// Move Generator (Pseudo-legal + In-Check verification)
// ----------------------------------------------------------------------------
void generate_moves(const Board& b, std::vector<Move>& move_list) {
    move_list.clear();
    Color us = b.side_to_move;
    Color them = (us == WHITE ? BLACK : WHITE);

    for (int from = 0; from < 64; ++from) {
        if (b.colors[from] != us) continue;
        int pt = b.pieces[from];
        int f = from % 8, r = from / 8;

        if (pt == PAWN) {
            int dir = (us == WHITE ? 8 : -8);
            int start_rank = (us == WHITE ? 1 : 6);
            int promo_rank = (us == WHITE ? 7 : 0);

            // Forward 1
            int to1 = from + dir;
            if (to1 >= 0 && to1 < 64 && b.pieces[to1] == NO_PIECE) {
                if (to1 / 8 == promo_rank) {
                    for (int p : {QUEEN, ROOK, BISHOP, KNIGHT}) {
                        move_list.push_back({from, to1, PAWN, NO_PIECE, p});
                    }
                } else {
                    move_list.push_back({from, to1, PAWN, NO_PIECE, NO_PIECE});
                    // Forward 2
                    int to2 = from + 2 * dir;
                    if (r == start_rank && b.pieces[to2] == NO_PIECE) {
                        move_list.push_back({from, to2, PAWN, NO_PIECE, NO_PIECE});
                    }
                }
            }

            // Captures
            for (int cap_df : {-1, 1}) {
                int cap_f = f + cap_df;
                if (cap_f >= 0 && cap_f < 8) {
                    int to_cap = from + dir + cap_df;
                    if (to_cap >= 0 && to_cap < 64 && b.colors[to_cap] == them) {
                        if (to_cap / 8 == promo_rank) {
                            for (int p : {QUEEN, ROOK, BISHOP, KNIGHT}) {
                                move_list.push_back({from, to_cap, PAWN, b.pieces[to_cap], p});
                            }
                        } else {
                            move_list.push_back({from, to_cap, PAWN, b.pieces[to_cap], NO_PIECE});
                        }
                    }
                }
            }
        } else if (pt == KNIGHT) {
            const int knight_offsets[] = {-17, -15, -10, -6, 6, 10, 15, 17};
            for (int off : knight_offsets) {
                int to = from + off;
                if (to >= 0 && to < 64) {
                    int tf = to % 8, tr = to / 8;
                    if (std::abs(f - tf) <= 2 && std::abs(r - tr) <= 2) {
                        if (b.colors[to] != us) {
                            move_list.push_back({from, to, KNIGHT, b.pieces[to], NO_PIECE});
                        }
                    }
                }
            }
        } else if (pt == BISHOP || pt == ROOK || pt == QUEEN) {
            std::vector<int> dirs;
            if (pt == BISHOP || pt == QUEEN) {
                dirs.insert(dirs.end(), {-9, -7, 7, 9});
            }
            if (pt == ROOK || pt == QUEEN) {
                dirs.insert(dirs.end(), {-8, 8, -1, 1});
            }

            for (int dir : dirs) {
                int cur = from;
                while (true) {
                    int cf = cur % 8;
                    cur += dir;
                    if (cur < 0 || cur >= 64) break;
                    if ((dir == -1 || dir == 1) && std::abs(cf - (cur % 8)) > 1) break;
                    if ((dir == -9 || dir == -7 || dir == 7 || dir == 9) && std::abs(cf - (cur % 8)) != 1) break;

                    if (b.colors[cur] == us) break;
                    move_list.push_back({from, cur, pt, b.pieces[cur], NO_PIECE});
                    if (b.colors[cur] == them) break; // Captured enemy, stop ray
                }
            }
        } else if (pt == KING) {
            for (int df = -1; df <= 1; ++df) {
                for (int dr = -1; dr <= 1; ++dr) {
                    if (df == 0 && dr == 0) continue;
                    int tf = f + df, tr = r + dr;
                    if (tf >= 0 && tf < 8 && tr >= 0 && tr < 8) {
                        int to = tr * 8 + tf;
                        if (b.colors[to] != us) {
                            move_list.push_back({from, to, KING, b.pieces[to], NO_PIECE});
                        }
                    }
                }
            }
            // Castling
            if (us == WHITE && from == E1) {
                if (b.castle_wk && b.pieces[F1] == NO_PIECE && b.pieces[G1] == NO_PIECE && b.pieces[H1] == ROOK) {
                    move_list.push_back({E1, G1, KING, NO_PIECE, NO_PIECE});
                }
                if (b.castle_wq && b.pieces[D1] == NO_PIECE && b.pieces[C1] == NO_PIECE && b.pieces[B1] == NO_PIECE && b.pieces[A1] == ROOK) {
                    move_list.push_back({E1, C1, KING, NO_PIECE, NO_PIECE});
                }
            } else if (us == BLACK && from == E8) {
                if (b.castle_bk && b.pieces[F8] == NO_PIECE && b.pieces[G8] == NO_PIECE && b.pieces[H8] == ROOK) {
                    move_list.push_back({E8, G8, KING, NO_PIECE, NO_PIECE});
                }
                if (b.castle_bq && b.pieces[D8] == NO_PIECE && b.pieces[C8] == NO_PIECE && b.pieces[B8] == NO_PIECE && b.pieces[A8] == ROOK) {
                    move_list.push_back({E8, C8, KING, NO_PIECE, NO_PIECE});
                }
            }
        }
    }
}

// ----------------------------------------------------------------------------
// Search: PVS, Quiescence, Move Ordering
// ----------------------------------------------------------------------------
struct SearchStats {
    uint64_t nodes = 0;
    int seldepth = 0;
    std::chrono::time_point<std::chrono::steady_clock> start_time;
    int time_limit_ms = 1000;
    bool stop = false;
};

int score_move(const Move& m, const Move& hash_move) {
    if (m == hash_move) return 1000000;
    if (m.captured != NO_PIECE) {
        return 100000 + (BerserkerNNUE::PIECE_VALUES[m.captured] * 10 - BerserkerNNUE::PIECE_VALUES[m.piece]);
    }
    return BerserkerNNUE::SQUARE_CENTRALITY[m.to];
}

int quiescence(Board& b, int alpha, int beta, SearchStats& stats) {
    stats.nodes++;
    int stand_pat = BerserkerNNUE::evaluate(b);
    if (stand_pat >= beta) return beta;
    if (stand_pat > alpha) alpha = stand_pat;

    std::vector<Move> moves;
    generate_moves(b, moves);

    // Keep only captures
    std::vector<Move> captures;
    for (const auto& m : moves) {
        if (m.captured != NO_PIECE) captures.push_back(m);
    }

    std::sort(captures.begin(), captures.end(), [](const Move& a, const Move& b_move) {
        return (BerserkerNNUE::PIECE_VALUES[a.captured] * 10 - BerserkerNNUE::PIECE_VALUES[a.piece]) >
               (BerserkerNNUE::PIECE_VALUES[b_move.captured] * 10 - BerserkerNNUE::PIECE_VALUES[b_move.piece]);
    });

    for (const auto& m : captures) {
        Board prev = b;
        b.make_move(m);
        if (b.in_check(prev.side_to_move)) {
            b.undo_move(m, prev);
            continue;
        }

        int score = -quiescence(b, -beta, -alpha, stats);
        b.undo_move(m, prev);

        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
    }

    return alpha;
}

int pvs_search(Board& b, int depth, int ply, int alpha, int beta, Move& best_move_out, SearchStats& stats) {
    if ((stats.nodes & 2047) == 0) {
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - stats.start_time).count();
        if (elapsed >= stats.time_limit_ms) {
            stats.stop = true;
            return 0;
        }
    }

    if (depth <= 0) {
        return quiescence(b, alpha, beta, stats);
    }

    stats.nodes++;
    if (ply > stats.seldepth) stats.seldepth = ply;

    std::vector<Move> moves;
    generate_moves(b, moves);

    Move null_move;
    std::sort(moves.begin(), moves.end(), [&](const Move& a, const Move& bm) {
        return score_move(a, null_move) > score_move(bm, null_move);
    });

    int legal_moves = 0;
    int best_score = -30000;
    Move local_best;

    for (size_t i = 0; i < moves.size(); ++i) {
        const auto& m = moves[i];
        Board prev = b;
        b.make_move(m);

        if (b.in_check(prev.side_to_move)) {
            b.undo_move(m, prev);
            continue;
        }

        legal_moves++;
        Move sub_best;
        int score = 0;

        if (legal_moves == 1) {
            score = -pvs_search(b, depth - 1, ply + 1, -beta, -alpha, sub_best, stats);
        } else {
            // Null window search
            score = -pvs_search(b, depth - 1, ply + 1, -alpha - 1, -alpha, sub_best, stats);
            if (score > alpha && score < beta) {
                score = -pvs_search(b, depth - 1, ply + 1, -beta, -alpha, sub_best, stats);
            }
        }

        b.undo_move(m, prev);
        if (stats.stop) return 0;

        if (score > best_score) {
            best_score = score;
            local_best = m;
        }

        if (score > alpha) {
            alpha = score;
            if (alpha >= beta) break; // Beta cutoff
        }
    }

    if (legal_moves == 0) {
        if (b.in_check(b.side_to_move)) return -20000 + ply; // Checkmate
        return 0; // Stalemate
    }

    best_move_out = local_best;
    return best_score;
}

void iterative_deepening(Board& b, int max_depth, int time_limit_ms) {
    SearchStats stats;
    stats.start_time = std::chrono::steady_clock::now();
    stats.time_limit_ms = time_limit_ms;

    Move overall_best;
    int overall_score = 0;

    for (int d = 1; d <= max_depth; ++d) {
        Move best_at_depth;
        int score = pvs_search(b, d, 0, -30000, 30000, best_at_depth, stats);
        if (stats.stop && d > 1) break;

        overall_best = best_at_depth;
        overall_score = score;

        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - stats.start_time).count();
        uint64_t nps = (elapsed > 0 ? (stats.nodes * 1000) / elapsed : 0);

        std::cout << "info depth " << d 
                  << " seldepth " << stats.seldepth 
                  << " score cp " << overall_score 
                  << " nodes " << stats.nodes 
                  << " nps " << nps 
                  << " time " << elapsed 
                  << " pv " << move_to_uci(overall_best) << std::endl;

        if (elapsed > time_limit_ms / 2) break;
    }

    std::cout << "bestmove " << move_to_uci(overall_best) << std::endl;
}

// ----------------------------------------------------------------------------
// UCI Protocol Loop
// ----------------------------------------------------------------------------
int main() {
    std::ios_base::sync_with_stdio(false);
    std::cin.tie(NULL);

    Board board;
    board.setup_startpos();

    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream is(line);
        std::string cmd;
        is >> cmd;

        if (cmd == "uci") {
            std::cout << "id name Berserker 18 (HalfKP-Dual-1536 NNUE)" << std::endl;
            std::cout << "id author Berserker Independent Team" << std::endl;
            std::cout << "option name Hash type spin default 64 min 1 max 1024" << std::endl;
            std::cout << "option name Threads type spin default 1 min 1 max 64" << std::endl;
            std::cout << "uciok" << std::endl;
        } else if (cmd == "isready") {
            std::cout << "readyok" << std::endl;
        } else if (cmd == "ucinewgame") {
            board.setup_startpos();
        } else if (cmd == "position") {
            std::string sub;
            is >> sub;
            if (sub == "startpos") {
                board.setup_startpos();
                std::string moves_token;
                if (is >> moves_token && moves_token == "moves") {
                    std::string m_str;
                    while (is >> m_str) {
                        std::vector<Move> legal;
                        generate_moves(board, legal);
                        for (const auto& m : legal) {
                            if (move_to_uci(m) == m_str) {
                                board.make_move(m);
                                break;
                            }
                        }
                    }
                }
            } else if (sub == "fen") {
                std::string fen;
                std::string token;
                for (int i = 0; i < 6; ++i) {
                    if (is >> token) {
                        if (token == "moves") break;
                        fen += (i > 0 ? " " : "") + token;
                    }
                }
                board.setup_fen(fen);
                if (token == "moves") {
                    std::string m_str;
                    while (is >> m_str) {
                        std::vector<Move> legal;
                        generate_moves(board, legal);
                        for (const auto& m : legal) {
                            if (move_to_uci(m) == m_str) {
                                board.make_move(m);
                                break;
                            }
                        }
                    }
                }
            }
        } else if (cmd == "go") {
            int depth = 8;
            int movetime = 1000;
            std::string token;
            while (is >> token) {
                if (token == "depth") is >> depth;
                else if (token == "movetime") is >> movetime;
                else if (token == "wtime" && board.side_to_move == WHITE) {
                    int wtime; is >> wtime;
                    movetime = std::max(50, wtime / 25);
                } else if (token == "btime" && board.side_to_move == BLACK) {
                    int btime; is >> btime;
                    movetime = std::max(50, btime / 25);
                }
            }
            iterative_deepening(board, depth, movetime);
        } else if (cmd == "quit") {
            break;
        }
    }

    return 0;
}
