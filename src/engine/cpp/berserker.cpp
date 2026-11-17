/**
 * Berserker Engine — High-Performance C++20 WebAssembly Core
 *
 * Pure standalone 64-bit bitboard PVS/Alpha-Beta engine compiled to wasm32-simd128
 * backed by the genuine quantized Reckless v60-7f587dfb.nnue threat+PSQ neural network.
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <wasm_simd128.h>

// ----------------------------------------------------------------------------
// Freestanding libc helpers (zero external runtime required)
// ----------------------------------------------------------------------------
extern "C" {
void* memset(void* dst, int c, size_t n) {
    uint8_t* p = (uint8_t*)dst;
    uint8_t v = (uint8_t)c;
    for (size_t i = 0; i < n; ++i) p[i] = v;
    return dst;
}
void* memcpy(void* dst, const void* src, size_t n) {
    uint8_t* d = (uint8_t*)dst;
    const uint8_t* s = (const uint8_t*)src;
    for (size_t i = 0; i < n; ++i) d[i] = s[i];
    return dst;
}
}

// Host imports provided by Web Worker or Node.js wrapper
extern "C" {
__attribute__((import_module("env"), import_name("js_uci_out")))
void js_uci_out(const char* ptr, int len);

__attribute__((import_module("env"), import_name("js_now_ms")))
double js_now_ms();
}

static inline int ctz64(uint64_t x) { return __builtin_ctzll(x); }
static inline int popcnt64(uint64_t x) { return __builtin_popcountll(x); }
static inline uint64_t bswap64(uint64_t x) { return __builtin_bswap64(x); }
static inline int abs_i(int x) { return x < 0 ? -x : x; }
static inline int max_i(int a, int b) { return a > b ? a : b; }
static inline int min_i(int a, int b) { return a < b ? a : b; }
static inline int clamp_i(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
static inline float clamp_f(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

static float fast_ln(float x) {
    if (x <= 1.0f) return 0.0f;
    // Quick log(x) via binary exponent + polynomial mantissa
    int exp = 0;
    while (x >= 2.0f) { x *= 0.5f; exp++; }
    float y = (x - 1.0f) / (x + 1.0f);
    float y2 = y * y;
    float poly = 2.0f * y * (1.0f + y2 * (0.3333333f + y2 * 0.2f));
    return exp * 0.69314718f + poly;
}

// ----------------------------------------------------------------------------
// Engine Constants & Encodings (Matches Reckless v60-7f587dfb.nnue layout)
// ----------------------------------------------------------------------------
enum { WHITE = 0, BLACK = 1 };
enum { PT_PAWN = 0, PT_KNIGHT = 1, PT_BISHOP = 2, PT_ROOK = 3, PT_QUEEN = 4, PT_KING = 5 };
static constexpr uint8_t EMPTY_SQ = 255;

enum {
    FLAG_QUIET = 0,
    FLAG_DOUBLE_PUSH = 1,
    FLAG_KING_CASTLE = 2,
    FLAG_QUEEN_CASTLE = 3,
    FLAG_CAPTURE = 4,
    FLAG_EP = 5,
    FLAG_PROMO = 8
};

enum { CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8 };

static constexpr int MAX_PLY = 128;
static constexpr int MAX_MOVES = 256;
static constexpr int MAX_HIST = 1024;
static constexpr int MATE_SCORE = 25000;
static constexpr int MATE_BOUND = 23000;
static constexpr int INF_SCORE = 30000;

static constexpr int SEE_VALUES[6] = { 100, 320, 335, 500, 950, 20000 };

static inline int encode_move(int from, int to, int promo, int flags) {
    return from | (to << 6) | (promo << 12) | (flags << 15);
}
static inline int mv_from(int m) { return m & 63; }
static inline int mv_to(int m) { return (m >> 6) & 63; }
static inline int mv_promo(int m) { return (m >> 12) & 7; }
static inline int mv_flags(int m) { return (m >> 15) & 15; }

// ----------------------------------------------------------------------------
// Precomputed Bitboard Attack Tables & Zobrist Keys
// ----------------------------------------------------------------------------
static uint64_t PAWN_ATK[2][64];
static uint64_t KNIGHT_ATK[64];
static uint64_t KING_ATK[64];
static uint64_t FILE_MASK[64];
static uint64_t DIAG_MASK[64];
static uint64_t ANTI_MASK[64];
static uint64_t RANK_ATK[64][64];
static uint64_t BETWEEN_BB[64][64];
static uint64_t RAYPASS_BB[64][64];
static uint8_t CASTLE_MASK[64];

static uint64_t ZOBRIST_PIECE[12][64];
static uint64_t ZOBRIST_CASTLE[16];
static uint64_t ZOBRIST_EP[8];
static uint64_t ZOBRIST_SIDE;

static int LMR_TABLE[64][64];

static inline uint64_t splitmix64(uint64_t& state) {
    uint64_t z = (state += 0x9e3779b97f4a7c15ULL);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return z ^ (z >> 31);
}

static inline uint64_t hyp(uint64_t occ, int sq, uint64_t mask) {
    uint64_t b = 1ULL << sq;
    uint64_t f = occ & mask;
    uint64_t r = bswap64(f);
    uint64_t rb = bswap64(b);
    return ((f - 2ULL * b) ^ bswap64(r - 2ULL * rb)) & mask;
}

static inline uint64_t rook_attacks(int sq, uint64_t occ) {
    int rank = sq >> 3;
    int occ6 = (int)((occ >> (rank * 8 + 1)) & 63ULL);
    return RANK_ATK[sq][occ6] | hyp(occ, sq, FILE_MASK[sq]);
}

static inline uint64_t bishop_attacks(int sq, uint64_t occ) {
    return hyp(occ, sq, DIAG_MASK[sq]) | hyp(occ, sq, ANTI_MASK[sq]);
}

static inline uint64_t queen_attacks(int sq, uint64_t occ) {
    return rook_attacks(sq, occ) | bishop_attacks(sq, occ);
}

static inline uint64_t piece_attacks(int piece, int sq, uint64_t occ) {
    int pt = piece >> 1;
    switch (pt) {
        case PT_PAWN:   return PAWN_ATK[piece & 1][sq];
        case PT_KNIGHT: return KNIGHT_ATK[sq];
        case PT_BISHOP: return bishop_attacks(sq, occ);
        case PT_ROOK:   return rook_attacks(sq, occ);
        case PT_QUEEN:  return queen_attacks(sq, occ);
        case PT_KING:   return KING_ATK[sq];
        default:        return 0ULL;
    }
}

// ----------------------------------------------------------------------------
// Reckless NNUE Weights & Threat Indexing Tables
// ----------------------------------------------------------------------------
static constexpr int NNUE_TOTAL_BYTES = 63266880;
static constexpr int L1_SIZE = 768;
static constexpr int L2_SIZE = 16;
static constexpr int L3_SIZE = 32;
static constexpr int INPUT_BUCKETS = 10;
static constexpr int OUTPUT_BUCKETS = 8;
static constexpr int FT_QUANT = 255;
static constexpr int L1_QUANT = 64;
static constexpr int FT_SHIFT = 9;
static constexpr int NETWORK_SCALE = 380;
static constexpr float DEQUANT_MULT = (float)(1 << FT_SHIFT) / (float)(FT_QUANT * FT_QUANT * L1_QUANT);

alignas(64) static uint8_t g_nnue_buf[NNUE_TOTAL_BYTES];
static bool g_nnue_loaded = false;

static const int8_t*   g_ft_threats = (const int8_t*)(g_nnue_buf + 0);
static const int16_t*  g_ft_pieces  = (const int16_t*)(g_nnue_buf + 51351552);
static const int16_t*  g_ft_biases  = (const int16_t*)(g_nnue_buf + 63148032);
static const int8_t*   g_l1_weights = (const int8_t*)(g_nnue_buf + 63149568);
static const float*    g_l1_biases  = (const float*)(g_nnue_buf + 63247872);
static const float*    g_l2_weights = (const float*)(g_nnue_buf + 63248384);
static const float*    g_l2_biases  = (const float*)(g_nnue_buf + 63264768);
static const float*    g_l3_weights = (const float*)(g_nnue_buf + 63265792);
static const float*    g_l3_biases  = (const float*)(g_nnue_buf + 63266816);

static const uint8_t INPUT_BUCKETS_LAYOUT[64] = {
    0, 1, 2, 3, 3, 2, 1, 0,
    4, 5, 6, 7, 7, 6, 5, 4,
    8, 8, 8, 8, 8, 8, 8, 8,
    9, 9, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 9
};

static const uint8_t OUTPUT_BUCKETS_LAYOUT[33] = {
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1,
    2, 2, 2, 2,
    3, 3, 3,
    4, 4, 4,
    5, 5, 5,
    6, 6, 6,
    7, 7, 7, 7
};

static uint32_t PIECE_PAIR_LOOKUP[12 * 12];
static int32_t  PIECE_OFFSET_LOOKUP[12 * 64];
static uint8_t  ATTACK_INDEX_LOOKUP[12 * 64 * 64];

static void init_tables() {
    static bool initialized = false;
    if (initialized) return;
    initialized = true;

    for (int i = 0; i < 64; ++i) CASTLE_MASK[i] = 15;
    CASTLE_MASK[0]  &= ~CASTLE_WQ;
    CASTLE_MASK[4]  &= ~(CASTLE_WK | CASTLE_WQ);
    CASTLE_MASK[7]  &= ~CASTLE_WK;
    CASTLE_MASK[56] &= ~CASTLE_BQ;
    CASTLE_MASK[60] &= ~(CASTLE_BK | CASTLE_BQ);
    CASTLE_MASK[63] &= ~CASTLE_BK;

    const int k_dr[8] = {-2,-2,-1,-1, 1, 1, 2, 2};
    const int k_df[8] = {-1, 1,-2, 2,-2, 2,-1, 1};

    for (int sq = 0; sq < 64; ++sq) {
        int r = sq >> 3, f = sq & 7;
        PAWN_ATK[WHITE][sq] = 0;
        PAWN_ATK[BLACK][sq] = 0;
        if (r + 1 < 8) {
            if (f > 0) PAWN_ATK[WHITE][sq] |= 1ULL << ((r + 1) * 8 + (f - 1));
            if (f + 1 < 8) PAWN_ATK[WHITE][sq] |= 1ULL << ((r + 1) * 8 + (f + 1));
        }
        if (r - 1 >= 0) {
            if (f > 0) PAWN_ATK[BLACK][sq] |= 1ULL << ((r - 1) * 8 + (f - 1));
            if (f + 1 < 8) PAWN_ATK[BLACK][sq] |= 1ULL << ((r - 1) * 8 + (f + 1));
        }

        uint64_t na = 0;
        for (int i = 0; i < 8; ++i) {
            int nr = r + k_dr[i], nf = f + k_df[i];
            if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) na |= 1ULL << (nr * 8 + nf);
        }
        KNIGHT_ATK[sq] = na;

        uint64_t ka = 0;
        for (int dr = -1; dr <= 1; ++dr) {
            for (int df = -1; df <= 1; ++df) {
                if (dr == 0 && df == 0) continue;
                int nr = r + dr, nf = f + df;
                if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) ka |= 1ULL << (nr * 8 + nf);
            }
        }
        KING_ATK[sq] = ka;

        uint64_t fm = 0, dm = 0, am = 0;
        for (int rr = 0; rr < 8; ++rr) {
            for (int ff = 0; ff < 8; ++ff) {
                int s2 = rr * 8 + ff;
                if (s2 == sq) continue;
                if (ff == f) fm |= 1ULL << s2;
                if ((rr - ff) == (r - f)) dm |= 1ULL << s2;
                if ((rr + ff) == (r + f)) am |= 1ULL << s2;
            }
        }
        FILE_MASK[sq] = fm;
        DIAG_MASK[sq] = dm;
        ANTI_MASK[sq] = am;

        for (int occ6 = 0; occ6 < 64; ++occ6) {
            uint64_t rank_occ = ((uint64_t)occ6) << 1;
            uint64_t atk = 0;
            for (int ff = f + 1; ff < 8; ++ff) {
                atk |= 1ULL << (r * 8 + ff);
                if ((rank_occ >> ff) & 1ULL) break;
            }
            for (int ff = f - 1; ff >= 0; --ff) {
                atk |= 1ULL << (r * 8 + ff);
                if ((rank_occ >> ff) & 1ULL) break;
            }
            RANK_ATK[sq][occ6] = atk;
        }
    }

    // Between and Raypass bitboards
    for (int s1 = 0; s1 < 64; ++s1) {
        int r1 = s1 >> 3, f1 = s1 & 7;
        for (int s2 = 0; s2 < 64; ++s2) {
            BETWEEN_BB[s1][s2] = 0ULL;
            RAYPASS_BB[s1][s2] = 0ULL;
            if (s1 == s2) continue;
            int r2 = s2 >> 3, f2 = s2 & 7;
            int dr = (r2 > r1) - (r2 < r1);
            int df = (f2 > f1) - (f2 < f1);
            if (r1 != r2 && f1 != f2 && abs_i(r2 - r1) != abs_i(f2 - f1)) continue;
            int nr = r1 + dr, nf = f1 + df;
            bool past = false;
            while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
                int cur = nr * 8 + nf;
                if (cur == s2) {
                    past = true;
                } else if (!past) {
                    BETWEEN_BB[s1][s2] |= 1ULL << cur;
                } else {
                    RAYPASS_BB[s1][s2] |= 1ULL << cur;
                }
                nr += dr;
                nf += df;
            }
        }
    }

    // Zobrist keys
    uint64_t rng = 0x123456789abcdef0ULL;
    for (int p = 0; p < 12; ++p)
        for (int sq = 0; sq < 64; ++sq)
            ZOBRIST_PIECE[p][sq] = splitmix64(rng);
    for (int c = 0; c < 16; ++c) ZOBRIST_CASTLE[c] = splitmix64(rng);
    for (int f = 0; f < 8; ++f) ZOBRIST_EP[f] = splitmix64(rng);
    ZOBRIST_SIDE = splitmix64(rng);

    // LMR table
    for (int d = 0; d < 64; ++d) {
        for (int m = 0; m < 64; ++m) {
            if (d == 0 || m == 0) LMR_TABLE[d][m] = 0;
            else LMR_TABLE[d][m] = (int)(0.75f + fast_ln((float)d) * fast_ln((float)m) / 2.2f);
        }
    }

    // Reckless threat index lookup tables
    static const int8_t PIECE_INTERACTION_MAP[6][6] = {
        {0, 1, -1, 2, -1, -1},
        {0, 1,  2, 3,  4, -1},
        {0, 1,  2, 3, -1, -1},
        {0, 1,  2, 3, -1, -1},
        {0, 1,  2, 3,  4, -1},
        {0, 1,  2, 3, -1, -1}
    };
    static const int PIECE_TARGET_COUNT[6] = {6, 10, 8, 8, 10, 8};

    int offset = 0;
    int piece_offset[12];
    int offset_table[12];
    for (int color = 0; color < 2; ++color) {
        for (int pt = 0; pt < 6; ++pt) {
            int piece = (pt << 1) | color;
            int count = 0;
            for (int sq = 0; sq < 64; ++sq) {
                PIECE_OFFSET_LOOKUP[piece * 64 + sq] = count;
                if (pt != PT_PAWN || (sq >= 8 && sq < 56)) {
                    uint64_t atk = piece_attacks(piece, sq, 0ULL);
                    count += popcnt64(atk);
                }
            }
            piece_offset[piece] = count;
            offset_table[piece] = offset;
            offset += PIECE_TARGET_COUNT[pt] * count;
        }
    }

    for (int atk = 0; atk < 12; ++atk) {
        int atkPt = atk >> 1, atkCol = atk & 1;
        for (int def = 0; def < 12; ++def) {
            int defPt = def >> 1, defCol = def & 1;
            int map = PIECE_INTERACTION_MAP[atkPt][defPt];
            uint32_t base = (uint32_t)(offset_table[atk] + (defCol * (PIECE_TARGET_COUNT[atkPt] >> 1) + map) * piece_offset[atk]);
            bool enemy = atkCol != defCol;
            bool semiExcluded = atkPt == defPt && (enemy || atkPt != PT_PAWN);
            bool excluded = map < 0;
            uint32_t inner = ((uint32_t)(semiExcluded && !excluded) << 30) | ((uint32_t)excluded << 31) | (base & 0x3fffffffU);
            PIECE_PAIR_LOOKUP[atk * 12 + def] = inner;
        }
    }

    for (int piece = 0; piece < 12; ++piece) {
        for (int from = 0; from < 64; ++from) {
            uint64_t atk = piece_attacks(piece, from, 0ULL);
            int baseIdx = (piece * 64 + from) * 64;
            for (int to = 0; to < 64; ++to) {
                uint64_t belowMask = (to == 0) ? 0ULL : ((1ULL << to) - 1ULL);
                ATTACK_INDEX_LOOKUP[baseIdx + to] = (uint8_t)popcnt64(atk & belowMask);
            }
        }
    }
}

static inline int32_t threat_index(int piece, int from, int attacked, int to, bool mirrored, int pov) {
    int flip = (mirrored ? 7 : 0) ^ (56 * pov);
    int f = from ^ flip;
    int t = to ^ flip;
    int atk = piece ^ pov;
    int def = attacked ^ pov;
    uint32_t inner = PIECE_PAIR_LOOKUP[atk * 12 + def];
    uint32_t below = (uint32_t)(f < t);
    int32_t base_signed = (int32_t)((inner + (below << 30)) & 0x80ffffffU);
    if (base_signed < 0) return -1;
    return base_signed + PIECE_OFFSET_LOOKUP[atk * 64 + f] + ATTACK_INDEX_LOOKUP[(atk * 64 + f) * 64 + t];
}

static inline int pst_index(int color, int pt, int sq, int king_sq, int pov) {
    int kingside = (king_sq & 7) >= 4 ? 1 : 0;
    int flip = (7 * kingside) ^ (56 * pov);
    int bucket = INPUT_BUCKETS_LAYOUT[king_sq ^ flip];
    return bucket * 768 + (color != pov ? 384 : 0) + pt * 64 + (sq ^ flip);
}

// ----------------------------------------------------------------------------
// Board Representation
// ----------------------------------------------------------------------------
struct UndoInfo {
    int move;
    uint8_t captured;
    uint8_t castling;
    int8_t ep_sq;
    uint8_t moved;
    uint16_t halfmove;
    uint64_t hash;
    uint64_t pawn_key;
    uint64_t nonpawn_key;
};

struct Board {
    uint8_t mailbox[64];
    uint64_t pieces[12];
    uint64_t colors[2];
    uint64_t occ;
    int turn;
    uint8_t castling;
    int8_t ep_sq;
    uint16_t halfmove;
    uint16_t fullmove;
    uint8_t king_sq[2];
    uint64_t hash;
    uint64_t pawn_key;
    uint64_t nonpawn_key;

    UndoInfo undo[MAX_HIST];
    int undo_top;
    uint64_t rep_hash[MAX_HIST];
    int rep_len;

    int move_list[MAX_PLY][MAX_MOVES];
    int move_scores[MAX_PLY][MAX_MOVES];

    inline void put_piece(int piece, int sq) {
        mailbox[sq] = (uint8_t)piece;
        uint64_t b = 1ULL << sq;
        pieces[piece] |= b;
        colors[piece & 1] |= b;
        occ |= b;
        uint64_t z = ZOBRIST_PIECE[piece][sq];
        hash ^= z;
        int pt = piece >> 1;
        if (pt == PT_PAWN) pawn_key ^= z;
        else if (pt != PT_KING) nonpawn_key ^= z;
    }

    inline void remove_piece(int piece, int sq) {
        mailbox[sq] = EMPTY_SQ;
        uint64_t mask = ~(1ULL << sq);
        pieces[piece] &= mask;
        colors[piece & 1] &= mask;
        occ &= mask;
        uint64_t z = ZOBRIST_PIECE[piece][sq];
        hash ^= z;
        int pt = piece >> 1;
        if (pt == PT_PAWN) pawn_key ^= z;
        else if (pt != PT_KING) nonpawn_key ^= z;
    }

    inline void move_piece(int piece, int from, int to) {
        mailbox[from] = EMPTY_SQ;
        mailbox[to] = (uint8_t)piece;
        uint64_t toggle = (1ULL << from) ^ (1ULL << to);
        pieces[piece] ^= toggle;
        colors[piece & 1] ^= toggle;
        occ ^= toggle;
        uint64_t z = ZOBRIST_PIECE[piece][from] ^ ZOBRIST_PIECE[piece][to];
        hash ^= z;
        int pt = piece >> 1;
        if (pt == PT_PAWN) pawn_key ^= z;
        else if (pt != PT_KING) nonpawn_key ^= z;
    }

    bool set_fen(const char* fen, int len) {
        memset(mailbox, EMPTY_SQ, 64);
        for (int i = 0; i < 12; ++i) pieces[i] = 0ULL;
        colors[0] = colors[1] = occ = 0ULL;
        hash = pawn_key = nonpawn_key = 0ULL;
        undo_top = 0;
        rep_len = 0;

        int idx = 0;
        while (idx < len && fen[idx] == ' ') idx++;

        int rank = 7, file = 0;
        while (idx < len && fen[idx] != ' ') {
            char ch = fen[idx++];
            if (ch == '/') {
                rank--;
                file = 0;
            } else if (ch >= '1' && ch <= '8') {
                file += ch - '0';
            } else {
                int p = -1;
                switch (ch) {
                    case 'P': p = 0; break; case 'p': p = 1; break;
                    case 'N': p = 2; break; case 'n': p = 3; break;
                    case 'B': p = 4; break; case 'b': p = 5; break;
                    case 'R': p = 6; break; case 'r': p = 7; break;
                    case 'Q': p = 8; break; case 'q': p = 9; break;
                    case 'K': p = 10; break; case 'k': p = 11; break;
                    default: break;
                }
                if (p >= 0 && rank >= 0 && rank < 8 && file < 8) {
                    int sq = rank * 8 + file;
                    put_piece(p, sq);
                    if ((p >> 1) == PT_KING) king_sq[p & 1] = (uint8_t)sq;
                }
                file++;
            }
        }

        while (idx < len && fen[idx] == ' ') idx++;
        turn = (idx < len && fen[idx] == 'b') ? BLACK : WHITE;
        if (turn == BLACK) hash ^= ZOBRIST_SIDE;
        while (idx < len && fen[idx] != ' ') idx++;

        while (idx < len && fen[idx] == ' ') idx++;
        castling = 0;
        while (idx < len && fen[idx] != ' ') {
            char ch = fen[idx++];
            if (ch == 'K') castling |= CASTLE_WK;
            else if (ch == 'Q') castling |= CASTLE_WQ;
            else if (ch == 'k') castling |= CASTLE_BK;
            else if (ch == 'q') castling |= CASTLE_BQ;
        }
        hash ^= ZOBRIST_CASTLE[castling];

        while (idx < len && fen[idx] == ' ') idx++;
        ep_sq = -1;
        if (idx + 1 < len && fen[idx] >= 'a' && fen[idx] <= 'h' && fen[idx + 1] >= '1' && fen[idx + 1] <= '8') {
            ep_sq = (int8_t)((fen[idx + 1] - '1') * 8 + (fen[idx] - 'a'));
            hash ^= ZOBRIST_EP[ep_sq & 7];
        }
        while (idx < len && fen[idx] != ' ') idx++;

        while (idx < len && fen[idx] == ' ') idx++;
        int hm = 0;
        while (idx < len && fen[idx] >= '0' && fen[idx] <= '9') {
            hm = hm * 10 + (fen[idx++] - '0');
        }
        halfmove = (uint16_t)hm;

        while (idx < len && fen[idx] == ' ') idx++;
        int fm = 0;
        while (idx < len && fen[idx] >= '0' && fen[idx] <= '9') {
            fm = fm * 10 + (fen[idx++] - '0');
        }
        fullmove = (uint16_t)(fm > 0 ? fm : 1);

        rep_hash[0] = hash;
        rep_len = 1;
        return true;
    }

    inline bool is_attacked(int sq, int by_color) const {
        if (PAWN_ATK[by_color ^ 1][sq] & pieces[by_color]) return true;
        if (KNIGHT_ATK[sq] & pieces[(PT_KNIGHT << 1) | by_color]) return true;
        if (KING_ATK[sq] & pieces[(PT_KING << 1) | by_color]) return true;
        uint64_t rq = pieces[(PT_ROOK << 1) | by_color] | pieces[(PT_QUEEN << 1) | by_color];
        if (rq && (rook_attacks(sq, occ) & rq)) return true;
        uint64_t bq = pieces[(PT_BISHOP << 1) | by_color] | pieces[(PT_QUEEN << 1) | by_color];
        if (bq && (bishop_attacks(sq, occ) & bq)) return true;
        return false;
    }

    inline bool in_check() const { return is_attacked(king_sq[turn], turn ^ 1); }

    inline bool has_non_pawn(int c) const {
        return (pieces[(PT_KNIGHT << 1) | c] | pieces[(PT_BISHOP << 1) | c] |
                pieces[(PT_ROOK << 1) | c] | pieces[(PT_QUEEN << 1) | c]) != 0ULL;
    }

    bool is_repetition(int ply) const {
        if (halfmove < 4 || rep_len < 3) return false;
        int lookback = min_i((int)halfmove, rep_len - 1);
        uint64_t cur = hash;
        int start = rep_len - 1;
        int hits = 0;
        for (int dist = 2; dist <= lookback; dist += 2) {
            if (rep_hash[start - dist] == cur) {
                if (ply > 0) return true;
                if (++hits >= 2) return true;
            }
        }
        return false;
    }

    bool is_insufficient_material() const {
        if (pieces[0] | pieces[1] | pieces[6] | pieces[7] | pieces[8] | pieces[9]) return false;
        return popcnt64(pieces[2] | pieces[4]) <= 1 && popcnt64(pieces[3] | pieces[5]) <= 1;
    }

    inline bool is_draw(int ply) const {
        return halfmove >= 100 || is_repetition(ply) || is_insufficient_material();
    }

    int gen_pseudo(int ply, bool captures_only) {
        int count = 0;
        int* list = move_list[ply];
        int us = turn;
        int them = us ^ 1;
        uint64_t their_bb = colors[them];
        uint64_t empty_bb = ~occ;
        uint64_t target_bb = captures_only ? their_bb : ~colors[us];

        // 1. Pawns
        uint64_t pawns = pieces[(PT_PAWN << 1) | us];
        int up = us == WHITE ? 8 : -8;
        int promo_rank = us == WHITE ? 6 : 1;
        int start_rank = us == WHITE ? 1 : 6;
        while (pawns) {
            int sq = ctz64(pawns);
            pawns &= pawns - 1;
            int rank = sq >> 3;
            int to = sq + up;
            bool empty_to = mailbox[to] == EMPTY_SQ;
            if (rank == promo_rank) {
                if (empty_to) {
                    list[count++] = encode_move(sq, to, PT_QUEEN, FLAG_PROMO);
                    if (!captures_only) {
                        list[count++] = encode_move(sq, to, PT_ROOK, FLAG_PROMO);
                        list[count++] = encode_move(sq, to, PT_BISHOP, FLAG_PROMO);
                        list[count++] = encode_move(sq, to, PT_KNIGHT, FLAG_PROMO);
                    }
                }
            } else if (!captures_only && empty_to) {
                list[count++] = encode_move(sq, to, 0, FLAG_QUIET);
                if (rank == start_rank && mailbox[to + up] == EMPTY_SQ) {
                    list[count++] = encode_move(sq, to + up, 0, FLAG_DOUBLE_PUSH);
                }
            }

            uint64_t caps = PAWN_ATK[us][sq] & their_bb;
            while (caps) {
                int cap_sq = ctz64(caps);
                caps &= caps - 1;
                if (rank == promo_rank) {
                    list[count++] = encode_move(sq, cap_sq, PT_QUEEN, FLAG_PROMO | FLAG_CAPTURE);
                    list[count++] = encode_move(sq, cap_sq, PT_ROOK, FLAG_PROMO | FLAG_CAPTURE);
                    list[count++] = encode_move(sq, cap_sq, PT_BISHOP, FLAG_PROMO | FLAG_CAPTURE);
                    list[count++] = encode_move(sq, cap_sq, PT_KNIGHT, FLAG_PROMO | FLAG_CAPTURE);
                } else {
                    list[count++] = encode_move(sq, cap_sq, 0, FLAG_CAPTURE);
                }
            }

            if (ep_sq >= 0 && (PAWN_ATK[us][sq] & (1ULL << ep_sq))) {
                list[count++] = encode_move(sq, ep_sq, 0, FLAG_EP);
            }
        }

        // 2. Knights
        uint64_t bb = pieces[(PT_KNIGHT << 1) | us];
        while (bb) {
            int sq = ctz64(bb);
            bb &= bb - 1;
            uint64_t t = KNIGHT_ATK[sq] & target_bb;
            while (t) {
                int to = ctz64(t);
                t &= t - 1;
                int fl = ((their_bb >> to) & 1ULL) ? FLAG_CAPTURE : FLAG_QUIET;
                list[count++] = encode_move(sq, to, 0, fl);
            }
        }

        // 3. Bishops
        bb = pieces[(PT_BISHOP << 1) | us];
        while (bb) {
            int sq = ctz64(bb);
            bb &= bb - 1;
            uint64_t t = bishop_attacks(sq, occ) & target_bb;
            while (t) {
                int to = ctz64(t);
                t &= t - 1;
                int fl = ((their_bb >> to) & 1ULL) ? FLAG_CAPTURE : FLAG_QUIET;
                list[count++] = encode_move(sq, to, 0, fl);
            }
        }

        // 4. Rooks
        bb = pieces[(PT_ROOK << 1) | us];
        while (bb) {
            int sq = ctz64(bb);
            bb &= bb - 1;
            uint64_t t = rook_attacks(sq, occ) & target_bb;
            while (t) {
                int to = ctz64(t);
                t &= t - 1;
                int fl = ((their_bb >> to) & 1ULL) ? FLAG_CAPTURE : FLAG_QUIET;
                list[count++] = encode_move(sq, to, 0, fl);
            }
        }

        // 5. Queens
        bb = pieces[(PT_QUEEN << 1) | us];
        while (bb) {
            int sq = ctz64(bb);
            bb &= bb - 1;
            uint64_t t = queen_attacks(sq, occ) & target_bb;
            while (t) {
                int to = ctz64(t);
                t &= t - 1;
                int fl = ((their_bb >> to) & 1ULL) ? FLAG_CAPTURE : FLAG_QUIET;
                list[count++] = encode_move(sq, to, 0, fl);
            }
        }

        // 6. King + Castling
        int ksq = king_sq[us];
        uint64_t kt = KING_ATK[ksq] & target_bb;
        while (kt) {
            int to = ctz64(kt);
            kt &= kt - 1;
            int fl = ((their_bb >> to) & 1ULL) ? FLAG_CAPTURE : FLAG_QUIET;
            list[count++] = encode_move(ksq, to, 0, fl);
        }

        if (!captures_only) {
            if (us == WHITE && ksq == 4) {
                if ((castling & CASTLE_WK) && ((empty_bb & ((1ULL << 5) | (1ULL << 6))) == ((1ULL << 5) | (1ULL << 6)))) {
                    if (!is_attacked(4, BLACK) && !is_attacked(5, BLACK) && !is_attacked(6, BLACK)) {
                        list[count++] = encode_move(4, 6, 0, FLAG_KING_CASTLE);
                    }
                }
                if ((castling & CASTLE_WQ) && ((empty_bb & ((1ULL << 1) | (1ULL << 2) | (1ULL << 3))) == ((1ULL << 1) | (1ULL << 2) | (1ULL << 3)))) {
                    if (!is_attacked(4, BLACK) && !is_attacked(3, BLACK) && !is_attacked(2, BLACK)) {
                        list[count++] = encode_move(4, 2, 0, FLAG_QUEEN_CASTLE);
                    }
                }
            } else if (us == BLACK && ksq == 60) {
                if ((castling & CASTLE_BK) && ((empty_bb & ((1ULL << 61) | (1ULL << 62))) == ((1ULL << 61) | (1ULL << 62)))) {
                    if (!is_attacked(60, WHITE) && !is_attacked(61, WHITE) && !is_attacked(62, WHITE)) {
                        list[count++] = encode_move(60, 62, 0, FLAG_KING_CASTLE);
                    }
                }
                if ((castling & CASTLE_BQ) && ((empty_bb & ((1ULL << 57) | (1ULL << 58) | (1ULL << 59))) == ((1ULL << 57) | (1ULL << 58) | (1ULL << 59)))) {
                    if (!is_attacked(60, WHITE) && !is_attacked(59, WHITE) && !is_attacked(58, WHITE)) {
                        list[count++] = encode_move(60, 58, 0, FLAG_QUEEN_CASTLE);
                    }
                }
            }
        }
        return count;
    }

    int static_exchange_eval(int move) const {
        int from = mv_from(move);
        int to = mv_to(move);
        int promo = mv_promo(move);
        int flags = mv_flags(move);
        uint8_t moved = mailbox[from];
        if (moved == EMPTY_SQ) return 0;

        int gain = 0;
        if (flags == FLAG_EP) gain = SEE_VALUES[PT_PAWN];
        else if (mailbox[to] != EMPTY_SQ) gain = SEE_VALUES[mailbox[to] >> 1];
        if (promo > 0) gain += SEE_VALUES[promo] - SEE_VALUES[PT_PAWN];
        if (gain == 0 && flags != FLAG_EP && promo == 0) return 0;

        int attacker_pt = promo > 0 ? promo : (moved >> 1);
        int next_victim = SEE_VALUES[attacker_pt];

        uint64_t o = occ ^ (1ULL << from);
        if (flags == FLAG_EP) {
            int ep_cap = turn == WHITE ? to - 8 : to + 8;
            o ^= (1ULL << ep_cap);
        }

        int swap[32];
        int d = 0;
        swap[0] = gain;

        uint64_t diag_sliders = pieces[4] | pieces[5] | pieces[8] | pieces[9];
        uint64_t ortho_sliders = pieces[6] | pieces[7] | pieces[8] | pieces[9];

        uint64_t attackers =
            ((PAWN_ATK[BLACK][to] & pieces[0]) |
             (PAWN_ATK[WHITE][to] & pieces[1]) |
             (KNIGHT_ATK[to] & (pieces[2] | pieces[3])) |
             (KING_ATK[to] & (pieces[10] | pieces[11])) |
             (bishop_attacks(to, o) & diag_sliders) |
             (rook_attacks(to, o) & ortho_sliders)) & o;

        int stm = turn ^ 1;
        while (d < 31) {
            uint64_t stm_atk = attackers & colors[stm];
            if (!stm_atk) break;

            int picked_sq = -1;
            int picked_pt = PT_KING;
            for (int pt = PT_PAWN; pt <= PT_KING; ++pt) {
                uint64_t hit = stm_atk & pieces[(pt << 1) | stm];
                if (hit) {
                    picked_sq = ctz64(hit);
                    picked_pt = pt;
                    break;
                }
            }
            if (picked_sq < 0) break;

            d++;
            swap[d] = next_victim - swap[d - 1];
            next_victim = SEE_VALUES[picked_pt];

            o ^= (1ULL << picked_sq);
            if (picked_pt == PT_PAWN || picked_pt == PT_BISHOP || picked_pt == PT_QUEEN) {
                attackers |= bishop_attacks(to, o) & diag_sliders;
            }
            if (picked_pt == PT_ROOK || picked_pt == PT_QUEEN) {
                attackers |= rook_attacks(to, o) & ortho_sliders;
            }
            attackers &= o;
            stm ^= 1;
        }

        while (d > 0) {
            swap[d - 1] = -max_i(-swap[d - 1], swap[d]);
            d--;
        }
        return swap[0];
    }
};

// ----------------------------------------------------------------------------
// Reckless NNUE Evaluator (SIMD-Accelerated Lazy Accumulator Stack)
// ----------------------------------------------------------------------------
struct RecklessNnue {
    static constexpr int ACC_DEPTH = 132;
    static constexpr int MAX_THREAT_DELTAS = 96;

    alignas(16) int16_t pst[ACC_DEPTH][2][L1_SIZE];
    alignas(16) int16_t threat[ACC_DEPTH][2][L1_SIZE];
    uint8_t pst_valid[ACC_DEPTH][2];
    uint8_t threat_valid[ACC_DEPTH][2];
    uint8_t pst_refresh[ACC_DEPTH][2];
    uint8_t threat_refresh[ACC_DEPTH][2];

    int32_t pst_add1[ACC_DEPTH][2], pst_add2[ACC_DEPTH][2];
    int32_t pst_sub1[ACC_DEPTH][2], pst_sub2[ACC_DEPTH][2];

    int32_t threat_add[ACC_DEPTH][2][MAX_THREAT_DELTAS];
    int32_t threat_sub[ACC_DEPTH][2][MAX_THREAT_DELTAS];
    uint8_t threat_add_cnt[ACC_DEPTH][2];
    uint8_t threat_sub_cnt[ACC_DEPTH][2];

    int ply;

    alignas(16) uint8_t ft_out[L1_SIZE];

    static inline void vec_add(int16_t* dst, const int16_t* src, const int8_t* w) {
        for (int i = 0; i < L1_SIZE; i += 8) {
            v128_t a = wasm_v128_load(src + i);
            v128_t b = wasm_i16x8_load8x8(w + i);
            wasm_v128_store(dst + i, wasm_i16x8_add(a, b));
        }
    }

    static inline void vec_sub_i8_inplace(int16_t* dst, const int8_t* w) {
        for (int i = 0; i < L1_SIZE; i += 8) {
            v128_t a = wasm_v128_load(dst + i);
            v128_t b = wasm_i16x8_load8x8(w + i);
            wasm_v128_store(dst + i, wasm_i16x8_sub(a, b));
        }
    }

    static inline void vec_add_i8_inplace(int16_t* dst, const int8_t* w) {
        for (int i = 0; i < L1_SIZE; i += 8) {
            v128_t a = wasm_v128_load(dst + i);
            v128_t b = wasm_i16x8_load8x8(w + i);
            wasm_v128_store(dst + i, wasm_i16x8_add(a, b));
        }
    }

    static inline void vec_addsub_i8_inplace(int16_t* dst, const int8_t* w_add, const int8_t* w_sub) {
        for (int i = 0; i < L1_SIZE; i += 8) {
            v128_t a = wasm_v128_load(dst + i);
            v128_t va = wasm_i16x8_load8x8(w_add + i);
            v128_t vs = wasm_i16x8_load8x8(w_sub + i);
            wasm_v128_store(dst + i, wasm_i16x8_sub(wasm_i16x8_add(a, va), vs));
        }
    }

    void refresh_pst_pov(const Board& b, int pov, int target_ply) {
        int16_t* acc = pst[target_ply][pov];
        memcpy(acc, g_ft_biases, L1_SIZE * sizeof(int16_t));
        int ksq = b.king_sq[pov];
        for (int piece = 0; piece < 12; ++piece) {
            int c = piece & 1, pt = piece >> 1;
            uint64_t bb = b.pieces[piece];
            while (bb) {
                int sq = ctz64(bb);
                bb &= bb - 1;
                const int16_t* w = g_ft_pieces + pst_index(c, pt, sq, ksq, pov) * L1_SIZE;
                for (int i = 0; i < L1_SIZE; i += 8) {
                    v128_t va = wasm_v128_load(acc + i);
                    v128_t vw = wasm_v128_load(w + i);
                    wasm_v128_store(acc + i, wasm_i16x8_add(va, vw));
                }
            }
        }
        pst_valid[target_ply][pov] = 1;
        pst_refresh[target_ply][pov] = 0;
    }

    void refresh_threats_pov(const Board& b, int pov, int target_ply) {
        int16_t* acc = threat[target_ply][pov];
        memset(acc, 0, L1_SIZE * sizeof(int16_t));
        int ksq = b.king_sq[pov];
        bool mirrored = (ksq & 7) >= 4;
        uint64_t occ = b.occ;
        uint64_t pbb = occ;
        while (pbb) {
            int sq = ctz64(pbb);
            pbb &= pbb - 1;
            uint8_t piece = b.mailbox[sq];
            uint64_t targets = piece_attacks(piece, sq, occ) & occ;
            while (targets) {
                int t = ctz64(targets);
                targets &= targets - 1;
                int32_t idx = threat_index(piece, sq, b.mailbox[t], t, mirrored, pov);
                if (idx >= 0) {
                    vec_add_i8_inplace(acc, g_ft_threats + idx * L1_SIZE);
                }
            }
        }
        threat_valid[target_ply][pov] = 1;
        threat_refresh[target_ply][pov] = 0;
    }

    void on_reset(const Board& b) {
        ply = 0;
        memset(pst_valid, 0, sizeof(pst_valid));
        memset(threat_valid, 0, sizeof(threat_valid));
        if (!g_nnue_loaded) return;
        refresh_pst_pov(b, WHITE, 0);
        refresh_pst_pov(b, BLACK, 0);
        refresh_threats_pov(b, WHITE, 0);
        refresh_threats_pov(b, BLACK, 0);
    }

    inline void push_threat_delta(int p, int piece, int from, int attacked, int to, bool add, int w_ksq, int b_ksq) {
        int32_t iw = threat_index(piece, from, attacked, to, (w_ksq & 7) >= 4, WHITE);
        if (iw >= 0) {
            if (add) {
                int c = threat_add_cnt[p][WHITE];
                if (c < MAX_THREAT_DELTAS) threat_add[p][WHITE][threat_add_cnt[p][WHITE]++] = iw;
                else threat_refresh[p][WHITE] = 1;
            } else {
                int c = threat_sub_cnt[p][WHITE];
                if (c < MAX_THREAT_DELTAS) threat_sub[p][WHITE][threat_sub_cnt[p][WHITE]++] = iw;
                else threat_refresh[p][WHITE] = 1;
            }
        }
        int32_t ib = threat_index(piece, from, attacked, to, (b_ksq & 7) >= 4, BLACK);
        if (ib >= 0) {
            if (add) {
                int c = threat_add_cnt[p][BLACK];
                if (c < MAX_THREAT_DELTAS) threat_add[p][BLACK][threat_add_cnt[p][BLACK]++] = ib;
                else threat_refresh[p][BLACK] = 1;
            } else {
                int c = threat_sub_cnt[p][BLACK];
                if (c < MAX_THREAT_DELTAS) threat_sub[p][BLACK][threat_sub_cnt[p][BLACK]++] = ib;
                else threat_refresh[p][BLACK] = 1;
            }
        }
    }

    void push_threats_single(int p, const Board& b, uint64_t occ, int piece, int sq, bool add, int w_ksq, int b_ksq) {
        uint64_t atk = piece_attacks(piece, sq, occ) & occ;
        while (atk) {
            int t = ctz64(atk);
            atk &= atk - 1;
            push_threat_delta(p, piece, sq, b.mailbox[t], t, add, w_ksq, b_ksq);
        }

        uint64_t diag_bb = b.pieces[4] | b.pieces[5] | b.pieces[8] | b.pieces[9];
        uint64_t ortho_bb = b.pieces[6] | b.pieces[7] | b.pieces[8] | b.pieces[9];
        uint64_t r_atk = rook_attacks(sq, occ);
        uint64_t b_atk = bishop_attacks(sq, occ);
        uint64_t q_atk = r_atk | b_atk;
        uint64_t sliders = ((b_atk & diag_bb) | (r_atk & ortho_bb)) & occ;

        while (sliders) {
            int from = ctz64(sliders);
            sliders &= sliders - 1;
            uint8_t sp = b.mailbox[from];
            uint64_t thr = RAYPASS_BB[from][sq] & occ & q_atk;
            if (thr) {
                int to = ctz64(thr);
                push_threat_delta(p, sp, from, b.mailbox[to], to, !add, w_ksq, b_ksq);
            }
            push_threat_delta(p, sp, from, piece, sq, add, w_ksq, b_ksq);
        }

        uint64_t non_sliders =
            ((b.pieces[1] & PAWN_ATK[WHITE][sq]) |
             (b.pieces[0] & PAWN_ATK[BLACK][sq]) |
             ((b.pieces[2] | b.pieces[3]) & KNIGHT_ATK[sq]) |
             ((b.pieces[10] | b.pieces[11]) & KING_ATK[sq])) & occ;
        while (non_sliders) {
            int from = ctz64(non_sliders);
            non_sliders &= non_sliders - 1;
            push_threat_delta(p, b.mailbox[from], from, piece, sq, add, w_ksq, b_ksq);
        }
    }

    void on_move(const Board& b, int move, uint8_t moved, uint8_t captured) {
        ply++;
        if (!g_nnue_loaded || ply >= ACC_DEPTH) return;
        int p = ply;
        pst_valid[p][0] = pst_valid[p][1] = 0;
        threat_valid[p][0] = threat_valid[p][1] = 0;

        int from = mv_from(move), to = mv_to(move), promo = mv_promo(move), flags = mv_flags(move);
        int us = b.turn, them = us ^ 1, pt = moved >> 1;
        int old_ksq = b.king_sq[us];
        int new_ksq = (pt == PT_KING) ? to : old_ksq;
        int enemy_ksq = b.king_sq[them];

        bool old_flip = (old_ksq & 7) >= 4;
        bool new_flip = (new_ksq & 7) >= 4;
        int old_b = INPUT_BUCKETS_LAYOUT[old_ksq ^ ((old_flip ? 7 : 0) ^ (56 * us))];
        int new_b = INPUT_BUCKETS_LAYOUT[new_ksq ^ ((new_flip ? 7 : 0) ^ (56 * us))];
        bool king_refresh = (pt == PT_KING) && (old_flip != new_flip || old_b != new_b);
        int res_pt = promo > 0 ? promo : pt;

        for (int pov = 0; pov < 2; ++pov) {
            if (pov == us && king_refresh) {
                pst_refresh[p][pov] = 1;
            } else {
                pst_refresh[p][pov] = 0;
                int p_ksq = (pov == us) ? new_ksq : enemy_ksq;
                pst_add1[p][pov] = pst_index(us, res_pt, to, p_ksq, pov);
                pst_sub1[p][pov] = pst_index(us, pt, from, p_ksq, pov);
                if (flags == FLAG_KING_CASTLE || flags == FLAG_QUEEN_CASTLE) {
                    int rf = flags == FLAG_KING_CASTLE ? (us == WHITE ? 7 : 63) : (us == WHITE ? 0 : 56);
                    int rt = flags == FLAG_KING_CASTLE ? (us == WHITE ? 5 : 61) : (us == WHITE ? 3 : 59);
                    pst_add2[p][pov] = pst_index(us, PT_ROOK, rt, p_ksq, pov);
                    pst_sub2[p][pov] = pst_index(us, PT_ROOK, rf, p_ksq, pov);
                } else if (flags == FLAG_EP) {
                    int ep = us == WHITE ? to - 8 : to + 8;
                    pst_add2[p][pov] = -1;
                    pst_sub2[p][pov] = pst_index(them, PT_PAWN, ep, p_ksq, pov);
                } else if (captured != EMPTY_SQ) {
                    pst_add2[p][pov] = -1;
                    pst_sub2[p][pov] = pst_index(them, captured >> 1, to, p_ksq, pov);
                } else {
                    pst_add2[p][pov] = -1;
                    pst_sub2[p][pov] = -1;
                }
            }
        }

        int w_ksq = (us == WHITE) ? new_ksq : enemy_ksq;
        int b_ksq = (us == BLACK) ? new_ksq : enemy_ksq;
        threat_add_cnt[p][0] = threat_add_cnt[p][1] = 0;
        threat_sub_cnt[p][0] = threat_sub_cnt[p][1] = 0;

        if (flags == FLAG_KING_CASTLE || flags == FLAG_QUEEN_CASTLE || flags == FLAG_EP || promo > 0) {
            threat_refresh[p][0] = threat_refresh[p][1] = 1;
            return;
        }
        threat_refresh[p][0] = threat_refresh[p][1] = 0;
        if (pt == PT_KING && old_flip != new_flip) {
            threat_refresh[p][us] = 1;
        }
        if (captured != EMPTY_SQ) {
            push_threats_single(p, b, b.occ, captured, to, false, w_ksq, b_ksq);
        }
        uint64_t occ_no = b.occ & ~(1ULL << from) & ~(1ULL << to);
        push_threats_single(p, b, occ_no, moved, from, false, w_ksq, b_ksq);
        push_threats_single(p, b, occ_no, moved, to, true, w_ksq, b_ksq);
    }

    inline void on_unmove() { if (ply > 0) ply--; }

    void on_null_move() {
        ply++;
        if (!g_nnue_loaded || ply >= ACC_DEPTH) return;
        int p = ply;
        for (int pov = 0; pov < 2; ++pov) {
            pst_valid[p][pov] = 0;
            pst_refresh[p][pov] = 0;
            pst_add1[p][pov] = pst_add2[p][pov] = pst_sub1[p][pov] = pst_sub2[p][pov] = -1;
            threat_valid[p][pov] = 0;
            threat_refresh[p][pov] = 0;
            threat_add_cnt[p][pov] = threat_sub_cnt[p][pov] = 0;
        }
    }

    inline void on_unnull_move() { if (ply > 0) ply--; }

    void ensure_pst(const Board& b, int pov) {
        int tp = ply;
        if (pst_valid[tp][pov]) return;
        int anc = tp;
        while (anc > 0 && !pst_valid[anc][pov] && !pst_refresh[anc][pov]) anc--;
        if (!pst_valid[anc][pov] || tp - anc > 5) {
            refresh_pst_pov(b, pov, tp);
            return;
        }
        for (int p = anc + 1; p <= tp; ++p) {
            int16_t* prev = pst[p - 1][pov];
            int16_t* cur = pst[p][pov];
            int a1 = pst_add1[p][pov], s1 = pst_sub1[p][pov];
            if (a1 < 0) {
                memcpy(cur, prev, L1_SIZE * sizeof(int16_t));
            } else {
                const int16_t* va1 = g_ft_pieces + a1 * L1_SIZE;
                const int16_t* vs1 = g_ft_pieces + s1 * L1_SIZE;
                int a2 = pst_add2[p][pov], s2 = pst_sub2[p][pov];
                if (a2 >= 0) {
                    const int16_t* va2 = g_ft_pieces + a2 * L1_SIZE;
                    const int16_t* vs2 = g_ft_pieces + s2 * L1_SIZE;
                    for (int i = 0; i < L1_SIZE; i += 8) {
                        v128_t x = wasm_v128_load(prev + i);
                        x = wasm_i16x8_add(x, wasm_v128_load(va1 + i));
                        x = wasm_i16x8_add(x, wasm_v128_load(va2 + i));
                        x = wasm_i16x8_sub(x, wasm_v128_load(vs1 + i));
                        x = wasm_i16x8_sub(x, wasm_v128_load(vs2 + i));
                        wasm_v128_store(cur + i, x);
                    }
                } else if (s2 >= 0) {
                    const int16_t* vs2 = g_ft_pieces + s2 * L1_SIZE;
                    for (int i = 0; i < L1_SIZE; i += 8) {
                        v128_t x = wasm_v128_load(prev + i);
                        x = wasm_i16x8_add(x, wasm_v128_load(va1 + i));
                        x = wasm_i16x8_sub(x, wasm_v128_load(vs1 + i));
                        x = wasm_i16x8_sub(x, wasm_v128_load(vs2 + i));
                        wasm_v128_store(cur + i, x);
                    }
                } else {
                    for (int i = 0; i < L1_SIZE; i += 8) {
                        v128_t x = wasm_v128_load(prev + i);
                        x = wasm_i16x8_add(x, wasm_v128_load(va1 + i));
                        x = wasm_i16x8_sub(x, wasm_v128_load(vs1 + i));
                        wasm_v128_store(cur + i, x);
                    }
                }
            }
            pst_valid[p][pov] = 1;
        }
    }

    void ensure_threats(const Board& b, int pov) {
        int tp = ply;
        if (threat_valid[tp][pov]) return;
        int anc = tp;
        while (anc > 0 && !threat_valid[anc][pov] && !threat_refresh[anc][pov]) anc--;
        if (!threat_valid[anc][pov] || tp - anc > 4) {
            refresh_threats_pov(b, pov, tp);
            return;
        }
        for (int p = anc + 1; p <= tp; ++p) {
            int16_t* prev = threat[p - 1][pov];
            int16_t* cur = threat[p][pov];
            memcpy(cur, prev, L1_SIZE * sizeof(int16_t));
            int ac = threat_add_cnt[p][pov], sc = threat_sub_cnt[p][pov];
            int a = 0, s = 0;
            while (a < ac && s < sc) {
                vec_addsub_i8_inplace(cur, g_ft_threats + threat_add[p][pov][a] * L1_SIZE, g_ft_threats + threat_sub[p][pov][s] * L1_SIZE);
                a++; s++;
            }
            while (a < ac) vec_add_i8_inplace(cur, g_ft_threats + threat_add[p][pov][a++] * L1_SIZE);
            while (s < sc) vec_sub_i8_inplace(cur, g_ft_threats + threat_sub[p][pov][s++] * L1_SIZE);
            threat_valid[p][pov] = 1;
        }
    }

    int forward_raw(const Board& b) {
        ensure_pst(b, WHITE);
        ensure_pst(b, BLACK);
        ensure_threats(b, WHITE);
        ensure_threats(b, BLACK);

        int stm = b.turn;
        const int16_t* stm_pst = pst[ply][stm];
        const int16_t* stm_thr = threat[ply][stm];
        const int16_t* opp_pst = pst[ply][stm ^ 1];
        const int16_t* opp_thr = threat[ply][stm ^ 1];
        constexpr int HALF = L1_SIZE >> 1; // 384

        const v128_t vzero = wasm_i16x8_splat(0);
        const v128_t vmax = wasm_i16x8_splat(FT_QUANT);

        for (int i = 0; i < HALF; i += 8) {
            v128_t l = wasm_i16x8_add(wasm_v128_load(stm_pst + i), wasm_v128_load(stm_thr + i));
            v128_t r = wasm_i16x8_add(wasm_v128_load(stm_pst + HALF + i), wasm_v128_load(stm_thr + HALF + i));
            l = wasm_i16x8_min(wasm_i16x8_max(l, vzero), vmax);
            r = wasm_i16x8_min(wasm_i16x8_max(r, vzero), vmax);
            v128_t prod = wasm_u16x8_shr(wasm_i16x8_mul(l, r), FT_SHIFT);
            // Narrow 8 int16s to 8 uint8s (low 64 bits)
            v128_t packed = wasm_u8x16_narrow_i16x8(prod, vzero);
            *(uint64_t*)(ft_out + i) = (uint64_t)wasm_u64x2_extract_lane(packed, 0);
        }

        for (int i = 0; i < HALF; i += 8) {
            v128_t l = wasm_i16x8_add(wasm_v128_load(opp_pst + i), wasm_v128_load(opp_thr + i));
            v128_t r = wasm_i16x8_add(wasm_v128_load(opp_pst + HALF + i), wasm_v128_load(opp_thr + HALF + i));
            l = wasm_i16x8_min(wasm_i16x8_max(l, vzero), vmax);
            r = wasm_i16x8_min(wasm_i16x8_max(r, vzero), vmax);
            v128_t prod = wasm_u16x8_shr(wasm_i16x8_mul(l, r), FT_SHIFT);
            v128_t packed = wasm_u8x16_narrow_i16x8(prod, vzero);
            *(uint64_t*)(ft_out + HALF + i) = (uint64_t)wasm_u64x2_extract_lane(packed, 0);
        }

        int bucket = OUTPUT_BUCKETS_LAYOUT[popcnt64(b.occ)];
        int32_t l1_pre[L2_SIZE] = {};
        const uint32_t* ft32 = (const uint32_t*)ft_out;
        const int8_t* l1_w_base = g_l1_weights + bucket * L2_SIZE * L1_SIZE;

        for (int idx = 0; idx < 192; ++idx) {
            uint32_t chunk = ft32[idx];
            if (!chunk) continue;
            int f0 = (int)(chunk & 255U);
            int f1 = (int)((chunk >> 8) & 255U);
            int f2 = (int)((chunk >> 16) & 255U);
            int f3 = (int)((chunk >> 24) & 255U);
            const int8_t* w = l1_w_base + idx * (L2_SIZE * 4);
            for (int j = 0; j < L2_SIZE; ++j) {
                const int8_t* wj = w + j * 4;
                l1_pre[j] += f0 * wj[0] + f1 * wj[1] + f2 * wj[2] + f3 * wj[3];
            }
        }

        float l1_out[L2_SIZE];
        const float* l1_b = g_l1_biases + bucket * L2_SIZE;
        for (int i = 0; i < L2_SIZE; ++i) {
            l1_out[i] = clamp_f((float)l1_pre[i] * DEQUANT_MULT + l1_b[i], 0.0f, 1.0f);
        }

        alignas(16) float l2_out[L3_SIZE];
        memcpy(l2_out, g_l2_biases + bucket * L3_SIZE, L3_SIZE * sizeof(float));
        const float* l2_w = g_l2_weights + bucket * L2_SIZE * L3_SIZE;
        for (int i = 0; i < L2_SIZE; ++i) {
            v128_t va = wasm_f32x4_splat(l1_out[i]);
            const float* row = l2_w + i * L3_SIZE;
            for (int j = 0; j < L3_SIZE; j += 4) {
                v128_t vo = wasm_v128_load(l2_out + j);
                v128_t vw = wasm_v128_load(row + j);
                wasm_v128_store(l2_out + j, wasm_f32x4_add(vo, wasm_f32x4_mul(vw, va)));
            }
        }

        const float* l3_w = g_l3_weights + bucket * L3_SIZE;
        float sum = g_l3_biases[bucket];
        for (int j = 0; j < L3_SIZE; ++j) {
            float a = clamp_f(l2_out[j], 0.0f, 1.0f);
            sum += l3_w[j] * a;
        }
        return (int)(sum * NETWORK_SCALE);
    }

    static inline int normalize_to_cp(int score, const Board& b) {
        if (abs_i(score) > 20000) return score;
        int pawns   = popcnt64(b.pieces[0] | b.pieces[1]);
        int knights = popcnt64(b.pieces[2] | b.pieces[3]);
        int bishops = popcnt64(b.pieces[4] | b.pieces[5]);
        int rooks   = popcnt64(b.pieces[6] | b.pieces[7]);
        int queens  = popcnt64(b.pieces[8] | b.pieces[9]);
        int mat = clamp_i(pawns + 3 * knights + 3 * bishops + 5 * rooks + 9 * queens, 16, 78);
        float v = (float)mat / 58.0f;
        float norm = ((-285.1f * v + 642.5f) * v - 455.5f) * v + 464.8f;
        float res = (100.0f * (float)score) / norm;
        return (int)(res >= 0.0f ? (res + 0.5f) : (res - 0.5f));
    }

    int evaluate_cp(const Board& b) {
        if (g_nnue_loaded) {
            int raw = forward_raw(b);
            return normalize_to_cp(raw, b);
        }
        // Fallback tapered classical material + pawn PST if NNUE not yet loaded
        static const int PAWN_PST[64] = {
            0,0,0,0,0,0,0,0,
            5,10,10,-20,-20,10,10,5,
            5,-5,-10,0,0,-10,-5,5,
            0,0,0,20,20,0,0,0,
            5,5,10,25,25,10,5,5,
            10,10,20,30,30,20,10,10,
            50,50,50,50,50,50,50,50,
            0,0,0,0,0,0,0,0
        };
        int s = 0;
        for (int pt = 0; pt < 5; ++pt) {
            uint64_t wb = b.pieces[pt << 1];
            while (wb) {
                int sq = ctz64(wb); wb &= wb - 1;
                s += SEE_VALUES[pt] + (pt == PT_PAWN ? PAWN_PST[sq] : 0);
            }
            uint64_t bb = b.pieces[(pt << 1) | 1];
            while (bb) {
                int sq = ctz64(bb); bb &= bb - 1;
                s -= SEE_VALUES[pt] + (pt == PT_PAWN ? PAWN_PST[sq ^ 56] : 0);
            }
        }
        return b.turn == WHITE ? s : -s;
    }
};

// ----------------------------------------------------------------------------
// Board Make / Unmake with RecklessNnue Observer
// ----------------------------------------------------------------------------
static Board g_board;
static RecklessNnue g_nnue;

static bool make_move(Board& b, int move, RecklessNnue* nnue) {
    int from = mv_from(move), to = mv_to(move), promo = mv_promo(move), flags = mv_flags(move);
    uint8_t moved = b.mailbox[from];
    int us = b.turn, them = us ^ 1;
    uint8_t captured = EMPTY_SQ;
    if (flags == FLAG_EP) {
        captured = b.mailbox[us == WHITE ? to - 8 : to + 8];
    } else if (b.mailbox[to] != EMPTY_SQ) {
        captured = b.mailbox[to];
    }

    if (nnue) nnue->on_move(b, move, moved, captured);

    UndoInfo& u = b.undo[b.undo_top++];
    u.move = move;
    u.captured = captured;
    u.castling = b.castling;
    u.ep_sq = b.ep_sq;
    u.moved = moved;
    u.halfmove = b.halfmove;
    u.hash = b.hash;
    u.pawn_key = b.pawn_key;
    u.nonpawn_key = b.nonpawn_key;

    if (b.ep_sq >= 0) {
        b.hash ^= ZOBRIST_EP[b.ep_sq & 7];
        b.ep_sq = -1;
    }

    if ((moved >> 1) == PT_PAWN || captured != EMPTY_SQ) b.halfmove = 0;
    else b.halfmove++;

    if (flags == FLAG_EP) {
        b.remove_piece(captured, us == WHITE ? to - 8 : to + 8);
    } else if (captured != EMPTY_SQ) {
        b.remove_piece(captured, to);
    }

    if (promo > 0) {
        b.remove_piece(moved, from);
        b.put_piece((promo << 1) | us, to);
    } else {
        b.move_piece(moved, from, to);
        if ((moved >> 1) == PT_KING) b.king_sq[us] = (uint8_t)to;
    }

    if (flags == FLAG_DOUBLE_PUSH) {
        b.ep_sq = (int8_t)(us == WHITE ? to - 8 : to + 8);
        b.hash ^= ZOBRIST_EP[b.ep_sq & 7];
    } else if (flags == FLAG_KING_CASTLE) {
        b.move_piece((PT_ROOK << 1) | us, us == WHITE ? 7 : 63, us == WHITE ? 5 : 61);
    } else if (flags == FLAG_QUEEN_CASTLE) {
        b.move_piece((PT_ROOK << 1) | us, us == WHITE ? 0 : 56, us == WHITE ? 3 : 59);
    }

    uint8_t new_cast = b.castling & CASTLE_MASK[from] & CASTLE_MASK[to];
    if (new_cast != b.castling) {
        b.hash ^= ZOBRIST_CASTLE[b.castling] ^ ZOBRIST_CASTLE[new_cast];
        b.castling = new_cast;
    }

    b.turn = them;
    b.hash ^= ZOBRIST_SIDE;
    if (us == BLACK) b.fullmove++;

    if (b.is_attacked(b.king_sq[us], them)) {
        // Inline illegal unmake
        if (nnue) nnue->on_unmove();
        b.undo_top--;
        if (flags == FLAG_KING_CASTLE) b.move_piece((PT_ROOK << 1) | us, us == WHITE ? 5 : 61, us == WHITE ? 7 : 63);
        else if (flags == FLAG_QUEEN_CASTLE) b.move_piece((PT_ROOK << 1) | us, us == WHITE ? 3 : 59, us == WHITE ? 0 : 56);
        if (promo > 0) {
            b.remove_piece((promo << 1) | us, to);
            b.put_piece(moved, from);
        } else {
            b.move_piece(moved, to, from);
            if ((moved >> 1) == PT_KING) b.king_sq[us] = (uint8_t)from;
        }
        if (flags == FLAG_EP) b.put_piece(captured, us == WHITE ? to - 8 : to + 8);
        else if (captured != EMPTY_SQ) b.put_piece(captured, to);
        b.turn = us;
        if (us == BLACK) b.fullmove--;
        b.castling = u.castling;
        b.ep_sq = u.ep_sq;
        b.halfmove = u.halfmove;
        b.hash = u.hash;
        b.pawn_key = u.pawn_key;
        b.nonpawn_key = u.nonpawn_key;
        return false;
    }

    if (b.rep_len < MAX_HIST) b.rep_hash[b.rep_len++] = b.hash;
    return true;
}

static void unmake_move(Board& b, RecklessNnue* nnue) {
    if (nnue) nnue->on_unmove();
    if (b.rep_len > 0) b.rep_len--;
    const UndoInfo& u = b.undo[--b.undo_top];
    int move = u.move;
    int from = mv_from(move), to = mv_to(move), promo = mv_promo(move), flags = mv_flags(move);
    int them = b.turn, us = them ^ 1;
    b.turn = us;
    if (us == BLACK) b.fullmove--;

    if (flags == FLAG_KING_CASTLE) b.move_piece((PT_ROOK << 1) | us, us == WHITE ? 5 : 61, us == WHITE ? 7 : 63);
    else if (flags == FLAG_QUEEN_CASTLE) b.move_piece((PT_ROOK << 1) | us, us == WHITE ? 3 : 59, us == WHITE ? 0 : 56);

    if (promo > 0) {
        b.remove_piece((promo << 1) | us, to);
        b.put_piece(u.moved, from);
    } else {
        b.move_piece(u.moved, to, from);
        if ((u.moved >> 1) == PT_KING) b.king_sq[us] = (uint8_t)from;
    }

    if (flags == FLAG_EP) b.put_piece(u.captured, us == WHITE ? to - 8 : to + 8);
    else if (u.captured != EMPTY_SQ) b.put_piece(u.captured, to);

    b.castling = u.castling;
    b.ep_sq = u.ep_sq;
    b.halfmove = u.halfmove;
    b.hash = u.hash;
    b.pawn_key = u.pawn_key;
    b.nonpawn_key = u.nonpawn_key;
}

static void make_null_move(Board& b, RecklessNnue* nnue) {
    if (nnue) nnue->on_null_move();
    UndoInfo& u = b.undo[b.undo_top++];
    u.move = 0;
    u.captured = EMPTY_SQ;
    u.castling = b.castling;
    u.ep_sq = b.ep_sq;
    u.moved = EMPTY_SQ;
    u.halfmove = b.halfmove;
    u.hash = b.hash;
    u.pawn_key = b.pawn_key;
    u.nonpawn_key = b.nonpawn_key;

    if (b.ep_sq >= 0) {
        b.hash ^= ZOBRIST_EP[b.ep_sq & 7];
        b.ep_sq = -1;
    }
    b.turn ^= 1;
    b.halfmove++;
    b.hash ^= ZOBRIST_SIDE;
    if (b.rep_len < MAX_HIST) b.rep_hash[b.rep_len++] = b.hash;
}

static void unmake_null_move(Board& b, RecklessNnue* nnue) {
    if (nnue) nnue->on_unnull_move();
    if (b.rep_len > 0) b.rep_len--;
    const UndoInfo& u = b.undo[--b.undo_top];
    b.ep_sq = u.ep_sq;
    b.halfmove = u.halfmove;
    b.hash = u.hash;
    b.turn ^= 1;
}

// ----------------------------------------------------------------------------
// Transposition Table & Search Heuristics (2^20 entries = 16 MB)
// ----------------------------------------------------------------------------
enum { TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2 };

struct alignas(16) TTEntry {
    uint64_t key;
    int32_t move;
    int16_t score;
    int8_t depth;
    uint8_t flag_age; // low 2 bits = flag, high 6 bits = age
};

static constexpr int TT_BITS = 20;
static constexpr int TT_SIZE = 1 << TT_BITS;
static constexpr int TT_MASK = TT_SIZE - 1;
static TTEntry g_tt[TT_SIZE];
static uint8_t g_tt_age = 1;
static int g_tt_filled = 0;

static int32_t g_killers[MAX_PLY][2];
static int32_t g_history[2][64][64];
static int32_t g_countermoves[2][64][64];
static int16_t g_conthist[12 * 64][12 * 64];
static int16_t g_cap_hist[12][64][6];
static int16_t g_pawn_corr[2][16384];
static int16_t g_nonpawn_corr[2][16384];

static void clear_search_state() {
    memset(g_tt, 0, sizeof(g_tt));
    g_tt_age = 1;
    g_tt_filled = 0;
    memset(g_killers, 0, sizeof(g_killers));
    memset(g_history, 0, sizeof(g_history));
    memset(g_countermoves, 0, sizeof(g_countermoves));
    memset(g_conthist, 0, sizeof(g_conthist));
    memset(g_cap_hist, 0, sizeof(g_cap_hist));
    memset(g_pawn_corr, 0, sizeof(g_pawn_corr));
    memset(g_nonpawn_corr, 0, sizeof(g_nonpawn_corr));
}

static inline void tt_store(uint64_t key, int depth, int score, int flag, int32_t move) {
    int idx = (int)(key & TT_MASK);
    TTEntry& e = g_tt[idx];
    uint8_t age = e.flag_age >> 2;
    bool is_empty = (age == 0);
    bool same = !is_empty && e.key == key;
    if (is_empty || same || age != g_tt_age || depth >= e.depth || flag == TT_EXACT) {
        if (is_empty) g_tt_filled++;
        e.key = key;
        e.move = move ? move : (same ? e.move : 0);
        e.score = (int16_t)score;
        e.depth = (int8_t)depth;
        e.flag_age = (uint8_t)((g_tt_age << 2) | (flag & 3));
    }
}

// ----------------------------------------------------------------------------
// PVS + Quiescence Search State & Heuristics
// ----------------------------------------------------------------------------
static int g_moved_piece[MAX_PLY];
static int g_move_to[MAX_PLY];
static int g_pv_table[MAX_PLY][MAX_PLY];
static int g_pv_len[MAX_PLY];

static int g_multipv = 1;
static int g_contempt = 0;

struct SearchControl {
    uint64_t nodes;
    uint64_t qnodes;
    int seldepth;
    uint64_t tt_hits;
    double start_ms;
    double max_time_ms;
    bool infinite;
    bool aborted;
    int target_depth;
    int completed_best_move;
    int completed_score;
    int completed_depth;
    int completed_pv[MAX_PLY];
    int completed_pv_len;
    int last_root_move;
    int stable_count;
    int current_depth;
    bool active;
};

static SearchControl g_sc;
static volatile bool g_stop_requested = false;

static inline bool check_abort() {
    if (g_sc.aborted) return true;
    if ((g_sc.nodes & 1023ULL) == 0ULL) {
        if (g_stop_requested) {
            g_sc.aborted = true;
            return true;
        }
        if (!g_sc.infinite && g_sc.completed_depth >= 1 && (js_now_ms() - g_sc.start_ms) >= g_sc.max_time_ms) {
            g_sc.aborted = true;
            return true;
        }
    }
    return false;
}

static inline int eval_node(const Board& b) {
    int cp = g_nnue.evaluate_cp(b);
    if (g_contempt != 0) {
        cp += (b.turn == WHITE ? g_contempt : -g_contempt) / 4;
    }
    return clamp_i(cp, -20000, 20000);
}

static inline void update_quiet_hist(int c, int from, int to, int bonus) {
    int clamped = clamp_i(bonus, -16384, 16384);
    int32_t& h = g_history[c][from][to];
    h += clamped - (h * abs_i(clamped)) / 16384;
}

static inline void update_cont_hist(int prev_idx, int curr_idx, int bonus) {
    int clamped = clamp_i(bonus, -16384, 16384);
    int16_t& h = g_conthist[prev_idx][curr_idx];
    h = (int16_t)(h + clamped - (h * abs_i(clamped)) / 16384);
}

static int score_move(const Board& b, int move, int tt_move, int ply, int p1, int t1, int p2, int t2) {
    if (move == tt_move && tt_move != 0) return 2000000;
    int from = mv_from(move), to = mv_to(move), promo = mv_promo(move), flags = mv_flags(move);
    uint8_t piece = b.mailbox[from];
    int captured = (flags == FLAG_EP) ? PT_PAWN : (b.mailbox[to] == EMPTY_SQ ? -1 : (b.mailbox[to] >> 1));

    if (captured >= 0 || promo == PT_QUEEN) {
        int vval = captured >= 0 ? SEE_VALUES[captured] : 0;
        int apt = piece >> 1;
        int ch = g_cap_hist[piece][to][captured >= 0 ? captured : 0];
        bool good = (promo == PT_QUEEN) || (vval >= SEE_VALUES[apt]) || (b.static_exchange_eval(move) >= 0);
        return (good ? 400000 : -200000) + vval * 16 - apt + (promo == PT_QUEEN ? 9000 : 0) + ch;
    }

    if (ply < MAX_PLY) {
        if (g_killers[ply][0] == move) return 300000;
        if (g_killers[ply][1] == move) return 280000;
    }

    int c = b.turn;
    if (t1 >= 0 && g_countermoves[c][t1][to] == move) return 250000;

    int score = g_history[c][from][to];
    int cidx = piece * 64 + to;
    if (p1 >= 0) score += g_conthist[p1 * 64 + t1][cidx];
    if (p2 >= 0) score += g_conthist[p2 * 64 + t2][cidx] >> 1;
    return score;
}

static int quiescence(int alpha, int beta, int ply, int qdepth) {
    g_sc.nodes++;
    g_sc.qnodes++;
    if (ply > g_sc.seldepth) g_sc.seldepth = ply;
    if (check_abort()) return alpha;
    if (g_board.is_draw(ply)) return 0;

    bool in_check = g_board.in_check();
    if (ply >= MAX_PLY - 2 || qdepth >= 10) {
        return in_check ? 0 : eval_node(g_board);
    }

    int orig_alpha = alpha;
    int best = -INF_SCORE;
    if (!in_check) {
        int stand_pat = eval_node(g_board);
        if (stand_pat >= beta) return stand_pat;
        if (stand_pat > alpha) alpha = stand_pat;
        best = stand_pat;
        if (stand_pat + 1100 < alpha) return alpha;
    }

    int count = g_board.gen_pseudo(ply, !in_check);
    int* list = g_board.move_list[ply];
    int* scores = g_board.move_scores[ply];

    for (int i = 0; i < count; ++i) {
        int m = list[i];
        int flags = mv_flags(m), to = mv_to(m), promo = mv_promo(m);
        if (!in_check) {
            int victim = flags == FLAG_EP ? PT_PAWN : (g_board.mailbox[to] == EMPTY_SQ ? -1 : (g_board.mailbox[to] >> 1));
            if (victim < 0 && promo != PT_QUEEN) {
                scores[i] = -1000000;
                continue;
            }
            int atk = g_board.mailbox[mv_from(m)] >> 1;
            scores[i] = (victim >= 0 ? SEE_VALUES[victim] * 16 : 0) - atk + (promo == PT_QUEEN ? 9000 : 0);
        } else {
            int cap = g_board.mailbox[to] != EMPTY_SQ ? SEE_VALUES[g_board.mailbox[to] >> 1] : 0;
            scores[i] = cap + (promo == PT_QUEEN ? 9000 : 0) + (g_killers[ply][0] == m ? 500 : 0);
        }
    }

    int legal = 0;
    for (int i = 0; i < count; ++i) {
        int best_i = i, best_s = scores[i];
        for (int j = i + 1; j < count; ++j) {
            if (scores[j] > best_s) { best_s = scores[j]; best_i = j; }
        }
        if (best_i != i) {
            int tm = list[i]; list[i] = list[best_i]; list[best_i] = tm;
            scores[best_i] = scores[i]; scores[i] = best_s;
        }
        int m = list[i];
        if (!in_check && best_s <= -1000000) break;
        if (!in_check && g_board.static_exchange_eval(m) < 0) continue;
        if (!make_move(g_board, m, &g_nnue)) continue;
        legal++;
        int sc = -quiescence(-beta, -alpha, ply + 1, qdepth + 1);
        unmake_move(g_board, &g_nnue);
        if (g_sc.aborted) return orig_alpha;
        if (sc > best) {
            best = sc;
            if (sc > alpha) {
                alpha = sc;
                if (sc >= beta) return sc;
            }
        }
    }

    if (in_check && legal == 0) return -MATE_SCORE + ply;
    return best;
}

static int pvs(int depth, int ply, int alpha, int beta, int excluded_move, bool cutnode) {
    if (ply < MAX_PLY) g_pv_len[ply] = 0;
    if (check_abort()) return alpha;

    bool is_root = (ply == 0);
    bool is_pv = (beta - alpha > 1);
    bool in_check = g_board.in_check();

    if (in_check && depth > 0 && ply < MAX_PLY - 4) depth++;
    if (depth <= 0) return quiescence(alpha, beta, ply, 0);

    g_sc.nodes++;
    if (ply > g_sc.seldepth) g_sc.seldepth = ply;

    if (!is_root) {
        if (g_board.is_draw(ply)) return 0;
        if (ply >= MAX_PLY - 2) return in_check ? 0 : eval_node(g_board);
        int m_alpha = max_i(alpha, -MATE_SCORE + ply);
        int m_beta = min_i(beta, MATE_SCORE - ply - 1);
        if (m_alpha >= m_beta) return m_alpha;
    }

    // TT probe
    int tt_move = 0, tt_score = 0, tt_depth = 0, tt_flag = 0;
    bool tt_hit = false;
    if (excluded_move == 0) {
        const TTEntry& te = g_tt[g_board.hash & TT_MASK];
        if ((te.flag_age >> 2) != 0 && te.key == g_board.hash) {
            tt_hit = true;
            tt_move = te.move;
            tt_score = te.score;
            tt_depth = te.depth;
            tt_flag = te.flag_age & 3;
            if (tt_score >= MATE_BOUND) tt_score -= ply;
            else if (tt_score <= -MATE_BOUND) tt_score += ply;

            if (!is_pv && !is_root && tt_depth >= depth) {
                g_sc.tt_hits++;
                if (tt_flag == TT_EXACT) return tt_score;
                if (tt_flag == TT_LOWER && tt_score >= beta) return tt_score;
                if (tt_flag == TT_UPPER && tt_score <= alpha) return tt_score;
            }
        }
    }

    // IIR
    if (depth >= 4 && tt_move == 0 && (is_pv || cutnode) && excluded_move == 0) depth--;

    int us = g_board.turn;
    int raw_eval = 0, static_eval = 0;
    if (!in_check) {
        raw_eval = eval_node(g_board);
        int pidx = (int)(g_board.pawn_key & 16383ULL);
        int npidx = (int)(g_board.nonpawn_key & 16383ULL);
        int corr = (g_pawn_corr[us][pidx] * 2 + g_nonpawn_corr[us][npidx]) / 64;
        static_eval = clamp_i(raw_eval + corr, -MATE_BOUND + 1, MATE_BOUND - 1);
        if (g_board.halfmove > 20) {
            static_eval = (static_eval * (200 - (int)g_board.halfmove)) / 200;
        }
    }

    if (!is_pv && !in_check && excluded_move == 0) {
        // RFP
        if (depth <= 7 && abs_i(beta) < MATE_BOUND) {
            int margin = 90 * depth;
            if (static_eval - margin >= beta) return static_eval - margin;
        }
        // Razoring
        if (depth <= 2 && abs_i(alpha) < MATE_BOUND && static_eval + 260 * depth <= alpha) {
            int qs = quiescence(alpha, alpha + 1, ply, 0);
            if (qs <= alpha) return qs;
        }
        // NMP
        if (depth >= 3 && static_eval >= beta && abs_i(beta) < MATE_BOUND && g_board.has_non_pawn(us)) {
            int r = 3 + depth / 4;
            g_moved_piece[ply] = -1;
            g_move_to[ply] = -1;
            make_null_move(g_board, &g_nnue);
            int ns = -pvs(depth - 1 - r, ply + 1, -beta, -beta + 1, 0, !cutnode);
            unmake_null_move(g_board, &g_nnue);
            if (g_sc.aborted) return alpha;
            if (ns >= beta) return ns >= MATE_BOUND ? beta : ns;
        }
    }

    int count = g_board.gen_pseudo(ply, false);
    int* list = g_board.move_list[ply];
    int* scores = g_board.move_scores[ply];
    int p1 = ply > 0 ? g_moved_piece[ply - 1] : -1;
    int t1 = ply > 0 ? g_move_to[ply - 1] : -1;
    int p2 = ply > 1 ? g_moved_piece[ply - 2] : -1;
    int t2 = ply > 1 ? g_move_to[ply - 2] : -1;

    for (int i = 0; i < count; ++i) {
        scores[i] = score_move(g_board, list[i], tt_move, ply, p1, t1, p2, t2);
    }

    int orig_alpha = alpha;
    int best_score = -INF_SCORE;
    int best_move = 0;
    int moves_searched = 0;
    int legal_count = 0;
    int quiet_searched[MAX_MOVES];
    int quiet_cnt = 0;

    for (int i = 0; i < count; ++i) {
        int best_i = i, best_os = scores[i];
        for (int j = i + 1; j < count; ++j) {
            if (scores[j] > best_os) { best_os = scores[j]; best_i = j; }
        }
        if (best_i != i) {
            int tm = list[i]; list[i] = list[best_i]; list[best_i] = tm;
            scores[best_i] = scores[i]; scores[i] = best_os;
        }

        int move = list[i];
        if (move == excluded_move) continue;

        int from = mv_from(move), to = mv_to(move), promo = mv_promo(move), flags = mv_flags(move);
        uint8_t moved_piece = g_board.mailbox[from];
        bool is_cap = (flags == FLAG_EP) || (g_board.mailbox[to] != EMPTY_SQ);
        bool is_tactical = is_cap || (promo == PT_QUEEN);

        if (!is_pv && !is_root && !in_check && best_score > -MATE_BOUND) {
            if (!is_tactical) {
                if (depth <= 4 && moves_searched >= 4 + depth * depth * 2) continue;
                if (depth <= 3 && static_eval + 130 * depth <= alpha) continue;
                if (depth <= 4 && g_board.static_exchange_eval(move) < -60 * depth) continue;
            } else if (depth <= 3 && is_cap) {
                if (g_board.static_exchange_eval(move) < -95 * depth) continue;
            }
        }

        int ext = 0;
        if (!is_root && excluded_move == 0 && move == tt_move && depth >= 6 &&
            tt_hit && tt_depth >= depth - 3 && tt_flag != TT_UPPER && abs_i(tt_score) < MATE_BOUND) {
            int s_beta = max_i(-MATE_BOUND + 1, tt_score - depth * 2);
            int s_depth = (depth - 1) / 2;
            int s_sc = pvs(s_depth, ply, s_beta - 1, s_beta, move, cutnode);
            if (g_sc.aborted) return orig_alpha;
            if (s_sc < s_beta) ext = (s_sc < s_beta - depth * 4) ? 2 : 1;
            else if (s_beta >= beta) return s_beta;
        }

        if (!make_move(g_board, move, &g_nnue)) continue;
        legal_count++;
        moves_searched++;

        g_moved_piece[ply] = moved_piece;
        g_move_to[ply] = to;

        bool gives_check = g_board.in_check();
        int new_depth = depth - 1 + ext;
        int sc;

        if (moves_searched == 1) {
            sc = -pvs(new_depth, ply + 1, -beta, -alpha, 0, false);
        } else {
            int red = 0;
            if (depth >= 3 && moves_searched >= 3 && !is_tactical && !in_check && !gives_check) {
                red = LMR_TABLE[min_i(depth, 63)][min_i(moves_searched, 63)];
                if (!is_pv) red++;
                int hv = g_history[us][from][to];
                if (hv > 4000) red--;
                else if (hv < -4000) red++;
                if (cutnode) red++;
                red = clamp_i(red, 0, max_i(0, new_depth - 1));
            } else if (depth >= 3 && moves_searched >= 5 && is_cap && !in_check && !gives_check && best_os < 0) {
                red = 1;
            }

            sc = -pvs(new_depth - red, ply + 1, -alpha - 1, -alpha, 0, true);
            if (!g_sc.aborted && sc > alpha && red > 0) {
                sc = -pvs(new_depth, ply + 1, -alpha - 1, -alpha, 0, !cutnode);
            }
            if (!g_sc.aborted && sc > alpha && sc < beta) {
                sc = -pvs(new_depth, ply + 1, -beta, -alpha, 0, false);
            }
        }

        unmake_move(g_board, &g_nnue);
        if (g_sc.aborted) return orig_alpha;

        if (sc > best_score) {
            best_score = sc;
            best_move = move;
            if (sc > alpha) {
                alpha = sc;
                if (ply < MAX_PLY - 1) {
                    int clen = g_pv_len[ply + 1];
                    g_pv_table[ply][0] = move;
                    for (int k = 0; k < clen; ++k) g_pv_table[ply][1 + k] = g_pv_table[ply + 1][k];
                    g_pv_len[ply] = 1 + clen;
                }
                if (sc >= beta) {
                    int bonus = min_i(2048, depth * depth * 16);
                    if (!is_cap) {
                        if (ply < MAX_PLY && g_killers[ply][0] != move) {
                            g_killers[ply][1] = g_killers[ply][0];
                            g_killers[ply][0] = move;
                        }
                        if (t1 >= 0) g_countermoves[us][t1][to] = move;
                        update_quiet_hist(us, from, to, bonus);
                        int cidx = moved_piece * 64 + to;
                        if (p1 >= 0) update_cont_hist(p1 * 64 + t1, cidx, bonus);
                        if (p2 >= 0) update_cont_hist(p2 * 64 + t2, cidx, bonus >> 1);
                        for (int q = 0; q < quiet_cnt; ++q) {
                            int qm = quiet_searched[q];
                            int qf = mv_from(qm), qt = mv_to(qm);
                            uint8_t qp = g_board.mailbox[qf];
                            update_quiet_hist(us, qf, qt, -bonus);
                            if (p1 >= 0) update_cont_hist(p1 * 64 + t1, qp * 64 + qt, -bonus);
                        }
                    } else {
                        int raw_cap_pt = (flags == FLAG_EP) ? PT_PAWN : (g_board.mailbox[to] >> 1);
                        int cap_pt = clamp_i(raw_cap_pt, 0, 5);
                        int16_t& ch = g_cap_hist[moved_piece][to][cap_pt];
                        ch = (int16_t)clamp_i((int)ch + bonus, -16384, 16384);
                    }
                    break;
                }
            }
        }
        if (!is_cap && quiet_cnt < MAX_MOVES) quiet_searched[quiet_cnt++] = move;
    }

    if (legal_count == 0 && excluded_move == 0) {
        return in_check ? -MATE_SCORE + ply : 0;
    }

    if (!in_check && excluded_move == 0 && best_move != 0 && abs_i(best_score) < MATE_BOUND) {
        int bflags = mv_flags(best_move), bto = mv_to(best_move);
        if (bflags != FLAG_EP && g_board.mailbox[bto] == EMPTY_SQ) {
            int pidx = (int)(g_board.pawn_key & 16383ULL);
            int npidx = (int)(g_board.nonpawn_key & 16383ULL);
            int err = clamp_i(best_score - raw_eval, -256, 256);
            int w = min_i(16, depth + 1);
            g_pawn_corr[us][pidx] = (int16_t)clamp_i((g_pawn_corr[us][pidx] * (256 - w) + err * 16 * w) / 256, -2048, 2048);
            g_nonpawn_corr[us][npidx] = (int16_t)clamp_i((g_nonpawn_corr[us][npidx] * (256 - w) + err * 12 * w) / 256, -2048, 2048);
        }
    }

    if (excluded_move == 0 && best_move != 0) {
        int flag = TT_EXACT;
        if (best_score <= orig_alpha) flag = TT_UPPER;
        else if (best_score >= beta) flag = TT_LOWER;

        int store_sc = best_score;
        if (store_sc >= MATE_BOUND) store_sc += ply;
        else if (store_sc <= -MATE_BOUND) store_sc -= ply;
        tt_store(g_board.hash, depth, store_sc, flag, best_move);
    }

    return best_score;
}

// ----------------------------------------------------------------------------
// String Formatting & UCI Output Helpers
// ----------------------------------------------------------------------------
static char g_out_buf[4096];

static int append_str(char* dst, int pos, const char* s) {
    while (*s && pos < 4090) dst[pos++] = *s++;
    return pos;
}

static int append_int(char* dst, int pos, int64_t val) {
    if (val < 0) { dst[pos++] = '-'; val = -val; }
    char tmp[32];
    int n = 0;
    if (val == 0) tmp[n++] = '0';
    else while (val > 0) { tmp[n++] = (char)('0' + (val % 10)); val /= 10; }
    while (n > 0 && pos < 4090) dst[pos++] = tmp[--n];
    return pos;
}

static int append_move_uci(char* dst, int pos, int m) {
    if (m == 0) return append_str(dst, pos, "0000");
    int f = mv_from(m), t = mv_to(m), p = mv_promo(m);
    dst[pos++] = (char)('a' + (f & 7));
    dst[pos++] = (char)('1' + (f >> 3));
    dst[pos++] = (char)('a' + (t & 7));
    dst[pos++] = (char)('1' + (t >> 3));
    if (p > 0) {
        static const char pc[6] = {0, 'n', 'b', 'r', 'q', 0};
        dst[pos++] = pc[p];
    }
    return pos;
}

static void emit_line(const char* s) {
    int n = 0;
    while (s[n]) n++;
    js_uci_out(s, n);
}

static bool apply_uci_move(Board& b, const char* s, int len, RecklessNnue* nnue) {
    if (len < 4) return false;
    int f = (s[1] - '1') * 8 + (s[0] - 'a');
    int t = (s[3] - '1') * 8 + (s[2] - 'a');
    if (f < 0 || f > 63 || t < 0 || t > 63) return false;
    int promo = 0;
    if (len >= 5) {
        char pc = s[4];
        if (pc == 'n' || pc == 'N') promo = PT_KNIGHT;
        else if (pc == 'b' || pc == 'B') promo = PT_BISHOP;
        else if (pc == 'r' || pc == 'R') promo = PT_ROOK;
        else if (pc == 'q' || pc == 'Q') promo = PT_QUEEN;
    }
    int count = b.gen_pseudo(0, false);
    for (int i = 0; i < count; ++i) {
        int m = b.move_list[0][i];
        if (mv_from(m) == f && mv_to(m) == t && mv_promo(m) == promo) {
            if (make_move(b, m, nnue)) return true;
        }
    }
    return false;
}

// ----------------------------------------------------------------------------
// Cooperative Iterative Deepening Driver (Zero PV/Move Mismatch!)
// ----------------------------------------------------------------------------
static int g_root_legal[MAX_MOVES];
static int g_root_legal_cnt = 0;

static void finish_search_and_emit() {
    g_sc.active = false;
    int pos = 0;
    pos = append_str(g_out_buf, pos, "bestmove ");
    pos = append_move_uci(g_out_buf, pos, g_sc.completed_best_move);
    if (g_sc.completed_pv_len >= 2 && g_sc.completed_pv[1] != 0) {
        pos = append_str(g_out_buf, pos, " ponder ");
        pos = append_move_uci(g_out_buf, pos, g_sc.completed_pv[1]);
    }
    js_uci_out(g_out_buf, pos);
}

extern "C" __attribute__((visibility("default")))
int wasm_search_begin(int max_depth, int max_time_ms, bool infinite) {
    init_tables();
    g_stop_requested = false;
    g_nnue.on_reset(g_board);

    int pseudo = g_board.gen_pseudo(0, false);
    g_root_legal_cnt = 0;
    for (int i = 0; i < pseudo; ++i) {
        int m = g_board.move_list[0][i];
        if (make_move(g_board, m, &g_nnue)) {
            g_root_legal[g_root_legal_cnt++] = m;
            unmake_move(g_board, &g_nnue);
        }
    }

    if (g_root_legal_cnt == 0) {
        emit_line("bestmove 0000");
        g_sc.active = false;
        return 0;
    }

    g_tt_age++;
    if (g_tt_age == 0 || g_tt_age > 60) g_tt_age = 1;

    g_sc.nodes = 0;
    g_sc.qnodes = 0;
    g_sc.seldepth = 0;
    g_sc.tt_hits = 0;
    g_sc.start_ms = js_now_ms();
    g_sc.max_time_ms = max_time_ms < 10 ? 10 : max_time_ms;
    g_sc.infinite = infinite;
    g_sc.aborted = false;
    g_sc.target_depth = clamp_i(max_depth, 1, 64);
    g_sc.completed_best_move = g_root_legal[0];
    g_sc.completed_score = 0;
    g_sc.completed_depth = 0;
    g_sc.completed_pv[0] = g_root_legal[0];
    g_sc.completed_pv_len = 1;
    g_sc.last_root_move = 0;
    g_sc.stable_count = 0;
    g_sc.current_depth = 1;
    g_sc.active = true;
    return 1;
}

extern "C" __attribute__((visibility("default")))
int wasm_search_step() {
    if (!g_sc.active) return 0;

    if (g_stop_requested || g_sc.current_depth > g_sc.target_depth ||
        (!g_sc.infinite && g_sc.completed_depth >= 1 && (js_now_ms() - g_sc.start_ms) >= g_sc.max_time_ms)) {
        finish_search_and_emit();
        return 0;
    }

    int d = g_sc.current_depth;
    if (!g_sc.infinite && d > 1 && (js_now_ms() - g_sc.start_ms) >= g_sc.max_time_ms * 0.72 && g_sc.stable_count >= 2) {
        finish_search_and_emit();
        return 0;
    }

    int num_lines = min_i(g_multipv, g_root_legal_cnt);
    int excluded_root[8];
    int excluded_cnt = 0;
    int primary_move = 0;
    int primary_score = 0;
    int primary_pv[MAX_PLY];
    int primary_pv_len = 0;

    for (int pv_idx = 0; pv_idx < num_lines; ++pv_idx) {
        int score = 0;
        if (pv_idx == 0) {
            if (d >= 4) {
                int delta = 25;
                int alpha = max_i(-INF_SCORE, g_sc.completed_score - delta);
                int beta = min_i(INF_SCORE, g_sc.completed_score + delta);
                while (true) {
                    score = pvs(d, 0, alpha, beta, 0, false);
                    if (g_sc.aborted) break;
                    if (score <= alpha) {
                        beta = (alpha + beta) / 2;
                        alpha = max_i(-INF_SCORE, alpha - delta);
                        delta = (delta * 9) / 5 + 15;
                    } else if (score >= beta) {
                        beta = min_i(INF_SCORE, beta + delta);
                        delta = (delta * 9) / 5 + 15;
                    } else {
                        break;
                    }
                    if (alpha <= -20000 && beta >= 20000) {
                        score = pvs(d, 0, -INF_SCORE, INF_SCORE, 0, false);
                        break;
                    }
                }
            } else {
                score = pvs(d, 0, -INF_SCORE, INF_SCORE, 0, false);
            }
        } else {
            int sub_best = -INF_SCORE;
            int sub_move = 0;
            int sub_pv[MAX_PLY];
            int sub_pv_len = 0;
            for (int r = 0; r < g_root_legal_cnt; ++r) {
                int rm = g_root_legal[r];
                bool skip = false;
                for (int e = 0; e < excluded_cnt; ++e) if (excluded_root[e] == rm) { skip = true; break; }
                if (skip) continue;
                make_move(g_board, rm, &g_nnue);
                g_moved_piece[0] = g_board.mailbox[mv_to(rm)];
                g_move_to[0] = mv_to(rm);
                int s = -pvs(d - 1, 1, -INF_SCORE, -sub_best, 0, false);
                unmake_move(g_board, &g_nnue);
                if (g_sc.aborted) break;
                if (s > sub_best) {
                    sub_best = s;
                    sub_move = rm;
                    sub_pv[0] = rm;
                    for (int k = 0; k < g_pv_len[1]; ++k) sub_pv[1 + k] = g_pv_table[1][k];
                    sub_pv_len = 1 + g_pv_len[1];
                }
            }
            if (!g_sc.aborted && sub_move != 0) {
                score = sub_best;
                g_pv_len[0] = sub_pv_len;
                for (int k = 0; k < sub_pv_len; ++k) g_pv_table[0][k] = sub_pv[k];
            }
        }

        if (g_sc.aborted) break;

        int pv_len = g_pv_len[0];
        if (pv_len > 0) {
            excluded_root[excluded_cnt++] = g_pv_table[0][0];
            if (pv_idx == 0) {
                primary_move = g_pv_table[0][0];
                primary_score = score;
                primary_pv_len = pv_len;
                for (int k = 0; k < pv_len; ++k) primary_pv[k] = g_pv_table[0][k];
            }

            int64_t elapsed = max_i(1, (int)(js_now_ms() - g_sc.start_ms));
            int64_t nps = (int64_t)((double)g_sc.nodes * 1000.0 / (double)elapsed);
            int hashfull = min_i(1000, (int)((int64_t)g_tt_filled * 1000 / TT_SIZE));

            int pos = 0;
            pos = append_str(g_out_buf, pos, "info depth ");
            pos = append_int(g_out_buf, pos, d);
            pos = append_str(g_out_buf, pos, " seldepth ");
            pos = append_int(g_out_buf, pos, g_sc.seldepth);
            pos = append_str(g_out_buf, pos, " multipv ");
            pos = append_int(g_out_buf, pos, pv_idx + 1);
            if (abs_i(score) >= MATE_BOUND) {
                int md = ((MATE_SCORE - abs_i(score)) + 1) / 2;
                pos = append_str(g_out_buf, pos, " score mate ");
                pos = append_int(g_out_buf, pos, score > 0 ? md : -md);
            } else {
                pos = append_str(g_out_buf, pos, " score cp ");
                pos = append_int(g_out_buf, pos, score);
            }
            pos = append_str(g_out_buf, pos, " nodes ");
            pos = append_int(g_out_buf, pos, (int64_t)g_sc.nodes);
            pos = append_str(g_out_buf, pos, " nps ");
            pos = append_int(g_out_buf, pos, nps);
            pos = append_str(g_out_buf, pos, " hashfull ");
            pos = append_int(g_out_buf, pos, hashfull);
            pos = append_str(g_out_buf, pos, " time ");
            pos = append_int(g_out_buf, pos, elapsed);
            pos = append_str(g_out_buf, pos, " pv");
            for (int k = 0; k < pv_len; ++k) {
                g_out_buf[pos++] = ' ';
                pos = append_move_uci(g_out_buf, pos, g_pv_table[0][k]);
            }
            js_uci_out(g_out_buf, pos);
        }
    }

    if (!g_sc.aborted && primary_move != 0) {
        g_sc.completed_best_move = primary_move;
        g_sc.completed_score = primary_score;
        g_sc.completed_depth = d;
        g_sc.completed_pv_len = primary_pv_len;
        for (int k = 0; k < primary_pv_len; ++k) g_sc.completed_pv[k] = primary_pv[k];

        if (primary_move == g_sc.last_root_move) g_sc.stable_count++;
        else { g_sc.last_root_move = primary_move; g_sc.stable_count = 0; }
    }

    if (g_sc.aborted || (abs_i(g_sc.completed_score) >= MATE_BOUND && d >= 2)) {
        finish_search_and_emit();
        return 0;
    }

    g_sc.current_depth++;
    return 1;
}

// ----------------------------------------------------------------------------
// Perft & Exported WASM API
// ----------------------------------------------------------------------------
static uint64_t perft_rec(int depth, int ply) {
    if (depth == 0) return 1ULL;
    int count = g_board.gen_pseudo(ply, false);
    uint64_t nodes = 0ULL;
    for (int i = 0; i < count; ++i) {
        int m = g_board.move_list[ply][i];
        if (make_move(g_board, m, nullptr)) {
            nodes += perft_rec(depth - 1, ply + 1);
            unmake_move(g_board, nullptr);
        }
    }
    return nodes;
}

static char g_cmd_buf[16384];

static bool str_eq(const char* a, int alen, const char* b) {
    int i = 0;
    while (b[i]) {
        if (i >= alen || a[i] != b[i]) return false;
        i++;
    }
    return i == alen;
}

static int parse_int_tok(const char* s, int len) {
    int sign = 1, i = 0, val = 0;
    if (i < len && s[i] == '-') { sign = -1; i++; }
    while (i < len && s[i] >= '0' && s[i] <= '9') {
        val = val * 10 + (s[i++] - '0');
    }
    return sign * val;
}

extern "C" {

__attribute__((visibility("default")))
uint8_t* wasm_get_nnue_ptr() { return g_nnue_buf; }

__attribute__((visibility("default")))
int wasm_get_nnue_max_bytes() { return NNUE_TOTAL_BYTES; }

__attribute__((visibility("default")))
int wasm_init_nnue(int byte_len) {
    init_tables();
    if (byte_len < NNUE_TOTAL_BYTES - 32) {
        g_nnue_loaded = false;
        return 0;
    }
    g_nnue_loaded = true;
    g_nnue.on_reset(g_board);
    return 1;
}

__attribute__((visibility("default")))
int wasm_is_nnue_loaded() { return g_nnue_loaded ? 1 : 0; }

__attribute__((visibility("default")))
void wasm_init() {
    init_tables();
    static const char STARTPOS[] = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    g_board.set_fen(STARTPOS, sizeof(STARTPOS) - 1);
    g_nnue.on_reset(g_board);
}

__attribute__((visibility("default")))
uint8_t* wasm_get_cmd_buf() { return (uint8_t*)g_cmd_buf; }

__attribute__((visibility("default")))
int wasm_get_cmd_buf_size() { return (int)sizeof(g_cmd_buf); }

__attribute__((visibility("default")))
void wasm_stop() { g_stop_requested = true; }

__attribute__((visibility("default")))
int wasm_evaluate_fen(int len) {
    init_tables();
    g_board.set_fen(g_cmd_buf, len);
    g_nnue.on_reset(g_board);
    return g_nnue.evaluate_cp(g_board);
}

__attribute__((visibility("default")))
int wasm_evaluate_raw_fen(int len) {
    init_tables();
    g_board.set_fen(g_cmd_buf, len);
    g_nnue.on_reset(g_board);
    return g_nnue_loaded ? g_nnue.forward_raw(g_board) : g_nnue.evaluate_cp(g_board);
}

__attribute__((visibility("default")))
uint64_t wasm_perft(int depth) {
    init_tables();
    return perft_rec(depth, 0);
}

__attribute__((visibility("default")))
int wasm_get_last_best_move(char* out4_6) {
    return append_move_uci(out4_6, 0, g_sc.completed_best_move);
}

__attribute__((visibility("default")))
int wasm_get_last_score() { return g_sc.completed_score; }

__attribute__((visibility("default")))
int wasm_get_last_depth() { return g_sc.completed_depth; }

__attribute__((visibility("default")))
uint64_t wasm_get_last_nodes() { return g_sc.nodes; }

__attribute__((visibility("default")))
int wasm_get_last_seldepth() { return g_sc.seldepth; }

/**
 * Parse and execute a UCI line placed in g_cmd_buf[0..len].
 * Returns 1 if an asynchronous/stepped search was initiated (caller loops wasm_search_step()),
 * or 0 if command completed immediately.
 */
__attribute__((visibility("default")))
int wasm_exec_uci(int len) {
    init_tables();

    // Tokenize spaces
    const char* tok[2048];
    int tlen[2048];
    int ntok = 0;
    int i = 0;
    while (i < len && ntok < 2048) {
        while (i < len && (g_cmd_buf[i] == ' ' || g_cmd_buf[i] == '\t' || g_cmd_buf[i] == '\r' || g_cmd_buf[i] == '\n')) i++;
        if (i >= len) break;
        int start = i;
        while (i < len && g_cmd_buf[i] != ' ' && g_cmd_buf[i] != '\t' && g_cmd_buf[i] != '\r' && g_cmd_buf[i] != '\n') i++;
        tok[ntok] = g_cmd_buf + start;
        tlen[ntok] = i - start;
        ntok++;
    }
    if (ntok == 0) return 0;

    if (str_eq(tok[0], tlen[0], "uci")) {
        emit_line("id name Berserker v0.6.0-wasm");
        emit_line("id author Berserker Engine Team");
        emit_line("option name Threads type spin default 1 min 1 max 1");
        emit_line("option name Hash type spin default 16 min 16 max 64");
        emit_line("option name MultiPV type spin default 1 min 1 max 5");
        emit_line("option name SearchMode type combo default Pure-PVS var Pure-PVS");
        emit_line("option name TacticalContempt type spin default 0 min -100 max 100");
        emit_line("option name NNUE_Net type string default v60-7f587dfb.nnue");
        emit_line("uciok");
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "isready")) {
        emit_line("readyok");
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "ucinewgame")) {
        static const char STARTPOS[] = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        g_board.set_fen(STARTPOS, sizeof(STARTPOS) - 1);
        g_nnue.on_reset(g_board);
        clear_search_state();
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "stop")) {
        g_stop_requested = true;
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "setoption")) {
        int name_idx = -1, val_idx = -1;
        for (int k = 1; k < ntok; ++k) {
            if (str_eq(tok[k], tlen[k], "name")) name_idx = k + 1;
            else if (str_eq(tok[k], tlen[k], "value")) { val_idx = k + 1; break; }
        }
        if (name_idx > 0 && val_idx > 0 && val_idx < ntok) {
            if (str_eq(tok[name_idx], tlen[name_idx], "MultiPV")) {
                g_multipv = clamp_i(parse_int_tok(tok[val_idx], tlen[val_idx]), 1, 5);
            } else if (str_eq(tok[name_idx], tlen[name_idx], "TacticalContempt") ||
                       str_eq(tok[name_idx], tlen[name_idx], "Contempt")) {
                g_contempt = clamp_i(parse_int_tok(tok[val_idx], tlen[val_idx]), -100, 100);
            }
        }
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "position")) {
        int moves_idx = -1;
        for (int k = 1; k < ntok; ++k) {
            if (str_eq(tok[k], tlen[k], "moves")) { moves_idx = k; break; }
        }
        if (ntok >= 2 && str_eq(tok[1], tlen[1], "startpos")) {
            static const char STARTPOS[] = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
            g_board.set_fen(STARTPOS, sizeof(STARTPOS) - 1);
        } else if (ntok >= 3 && str_eq(tok[1], tlen[1], "fen")) {
            const char* fen_start = tok[2];
            int fen_end_idx = (moves_idx != -1) ? moves_idx - 1 : (ntok - 1);
            int fen_len = (int)((tok[fen_end_idx] + tlen[fen_end_idx]) - fen_start);
            g_board.set_fen(fen_start, fen_len);
        }
        if (moves_idx != -1) {
            for (int k = moves_idx + 1; k < ntok; ++k) {
                apply_uci_move(g_board, tok[k], tlen[k], nullptr);
            }
        }
        g_nnue.on_reset(g_board);
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "eval")) {
        g_nnue.on_reset(g_board);
        int raw = g_nnue_loaded ? g_nnue.forward_raw(g_board) : 0;
        int cp = g_nnue.evaluate_cp(g_board);
        int pos = 0;
        pos = append_str(g_out_buf, pos, "info string NNUE net ");
        pos = append_str(g_out_buf, pos, g_nnue_loaded ? "v60-7f587dfb.nnue (Reckless 63MB real quantized)" : "fallback-pst");
        pos = append_str(g_out_buf, pos, " | stm ");
        pos = append_str(g_out_buf, pos, g_board.turn == WHITE ? "White" : "Black");
        pos = append_str(g_out_buf, pos, " | eval ");
        if (cp > 0) g_out_buf[pos++] = '+';
        pos = append_int(g_out_buf, pos, cp);
        pos = append_str(g_out_buf, pos, " cp (raw ");
        pos = append_int(g_out_buf, pos, raw);
        pos = append_str(g_out_buf, pos, ")");
        js_uci_out(g_out_buf, pos);
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "perft")) {
        int d = ntok >= 2 ? clamp_i(parse_int_tok(tok[1], tlen[1]), 1, 6) : 4;
        double t0 = js_now_ms();
        uint64_t n = perft_rec(d, 0);
        int ms = max_i(1, (int)(js_now_ms() - t0));
        int pos = 0;
        pos = append_str(g_out_buf, pos, "info string perft(");
        pos = append_int(g_out_buf, pos, d);
        pos = append_str(g_out_buf, pos, ") = ");
        pos = append_int(g_out_buf, pos, (int64_t)n);
        pos = append_str(g_out_buf, pos, " nodes in ");
        pos = append_int(g_out_buf, pos, ms);
        pos = append_str(g_out_buf, pos, " ms");
        js_uci_out(g_out_buf, pos);
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "bench")) {
        static const char* BENCH_FENS[4] = {
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
            "3rk2r/4bppp/p1q5/4p3/1p2P3/3B4/PPP1Q1PP/3R1R1K w - - 0 20",
            "8/5pk1/4p1p1/7p/7P/2r2PK1/6P1/8 w - - 0 40"
        };
        uint64_t total_nodes = 0;
        double t0 = js_now_ms();
        for (int b_idx = 0; b_idx < 4; ++b_idx) {
            int flen = 0; while (BENCH_FENS[b_idx][flen]) flen++;
            g_board.set_fen(BENCH_FENS[b_idx], flen);
            wasm_search_begin(7, 1500, false);
            while (wasm_search_step()) {}
            total_nodes += g_sc.nodes;
        }
        int elapsed = max_i(1, (int)(js_now_ms() - t0));
        int64_t nps = (int64_t)((double)total_nodes * 1000.0 / (double)elapsed);
        int pos = 0;
        pos = append_str(g_out_buf, pos, "info string WASM bench: ");
        pos = append_int(g_out_buf, pos, (int64_t)total_nodes);
        pos = append_str(g_out_buf, pos, " nodes | ");
        pos = append_int(g_out_buf, pos, elapsed);
        pos = append_str(g_out_buf, pos, " ms | ");
        pos = append_int(g_out_buf, pos, nps);
        pos = append_str(g_out_buf, pos, " nps");
        js_uci_out(g_out_buf, pos);
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "d")) {
        static const char PCH[12] = {'P','p','N','n','B','b','R','r','Q','q','K','k'};
        emit_line("+---+---+---+---+---+---+---+---+");
        for (int r = 7; r >= 0; --r) {
            int pos = 0;
            for (int f = 0; f < 8; ++f) {
                g_out_buf[pos++] = '|';
                g_out_buf[pos++] = ' ';
                uint8_t p = g_board.mailbox[r * 8 + f];
                g_out_buf[pos++] = (p < 12) ? PCH[p] : ' ';
                g_out_buf[pos++] = ' ';
            }
            g_out_buf[pos++] = '|';
            g_out_buf[pos++] = ' ';
            g_out_buf[pos++] = (char)('1' + r);
            js_uci_out(g_out_buf, pos);
            emit_line("+---+---+---+---+---+---+---+---+");
        }
        emit_line("  a   b   c   d   e   f   g   h");
        int pos = 0;
        pos = append_str(g_out_buf, pos, "Side: ");
        pos = append_str(g_out_buf, pos, g_board.turn == WHITE ? "White" : "Black");
        pos = append_str(g_out_buf, pos, " | Halfmove: ");
        pos = append_int(g_out_buf, pos, g_board.halfmove);
        pos = append_str(g_out_buf, pos, " | Fullmove: ");
        pos = append_int(g_out_buf, pos, g_board.fullmove);
        js_uci_out(g_out_buf, pos);
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "go")) {
        int depth = 24;
        int movetime = 2500;
        bool infinite = false;
        int wtime = -1, btime = -1, winc = 0, binc = 0, movestogo = 28;
        bool has_movetime = false, has_depth = false;

        for (int k = 1; k < ntok; ++k) {
            if (str_eq(tok[k], tlen[k], "infinite")) infinite = true;
            else if (str_eq(tok[k], tlen[k], "depth") && k + 1 < ntok) {
                ++k;
                depth = parse_int_tok(tok[k], tlen[k]);
                has_depth = true;
            } else if (str_eq(tok[k], tlen[k], "movetime") && k + 1 < ntok) {
                ++k;
                movetime = parse_int_tok(tok[k], tlen[k]);
                has_movetime = true;
            } else if (str_eq(tok[k], tlen[k], "wtime") && k + 1 < ntok) {
                ++k;
                wtime = parse_int_tok(tok[k], tlen[k]);
            } else if (str_eq(tok[k], tlen[k], "btime") && k + 1 < ntok) {
                ++k;
                btime = parse_int_tok(tok[k], tlen[k]);
            } else if (str_eq(tok[k], tlen[k], "winc") && k + 1 < ntok) {
                ++k;
                winc = parse_int_tok(tok[k], tlen[k]);
            } else if (str_eq(tok[k], tlen[k], "binc") && k + 1 < ntok) {
                ++k;
                binc = parse_int_tok(tok[k], tlen[k]);
            } else if (str_eq(tok[k], tlen[k], "movestogo") && k + 1 < ntok) {
                ++k;
                movestogo = max_i(1, parse_int_tok(tok[k], tlen[k]));
            }
        }

        if (has_depth && !has_movetime && !infinite && wtime < 0 && btime < 0) {
            movetime = 60000;
        }
        if (!has_movetime && !infinite) {
            int t = g_board.turn == WHITE ? wtime : btime;
            int inc = g_board.turn == WHITE ? winc : binc;
            if (t > 0) {
                movetime = clamp_i(t / movestogo + (inc * 3) / 4, 40, max_i(40, t - 30));
            }
        }

        return wasm_search_begin(depth, movetime, infinite);
    }

    return 0;
}

} // extern "C"
