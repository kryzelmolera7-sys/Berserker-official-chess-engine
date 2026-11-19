/**
 * Berserker Engine — High-Performance C++20 Pure-PVS & Auto-Loaded NNUE Core
 *
 * Dual-target standalone 64-bit bitboard chess engine:
 *   - wasm32-simd128 (Web Worker / Node WASM): single-threaded SIMD128 with 64 MB 4-way clustered TT
 *   - BERSERKER_NATIVE (x86_64 C++20 -pthread): multi-threaded Lazy SMP + lockless XOR 4-way clustered TT
 *
 * Neural Network:
 *   Genuine Stockfish K32H3 + FullThreats + PP_3Wide (1024x32x32, 92/192 LayerStacks)
 *   from nn-bddd9d57eb87.nnue (138,360,528 bytes) loaded automatically at runtime into g_nnue_buf
 *   (keeps WASM/native binaries tiny <200KB for GitHub, with zero classical HCE fallback).
 */

#ifdef BERSERKER_NATIVE
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdbool>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#else
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <wasm_simd128.h>

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

extern "C" {
__attribute__((import_module("env"), import_name("js_uci_out")))
void js_uci_out(const char* ptr, int len);

__attribute__((import_module("env"), import_name("js_now_ms")))
double js_now_ms();
}
#endif

// ----------------------------------------------------------------------------
// Runtime-Loaded Binary NNUE Buffer (nn-bddd9d57eb87.nnue, 138,360,528 bytes)
// Populated at runtime by automatic raw download / IndexedDB / EvalFile loader.
// Takes 0 bytes on disk inside .wasm or native ELF executable.
// ----------------------------------------------------------------------------
static constexpr size_t EXPECTED_NNUE_BYTES = 138360528ULL;
alignas(64) static uint8_t g_nnue_buf[EXPECTED_NNUE_BYTES];

// ----------------------------------------------------------------------------
// Platform Timing & UCI I/O Abstractions
// ----------------------------------------------------------------------------
#ifdef BERSERKER_NATIVE
static auto g_prog_start = std::chrono::steady_clock::now();
static std::mutex g_io_mutex;

static inline double now_ms() {
    auto d = std::chrono::steady_clock::now() - g_prog_start;
    return std::chrono::duration<double, std::milli>(d).count();
}

static inline void uci_out(const char* ptr, int len) {
    if (len <= 0) return;
    std::lock_guard<std::mutex> lk(g_io_mutex);
    fwrite(ptr, 1, (size_t)len, stdout);
    putchar('\n');
    fflush(stdout);
}
#else
static inline double now_ms() { return js_now_ms(); }
static inline void uci_out(const char* ptr, int len) { js_uci_out(ptr, len); }
#endif

// ----------------------------------------------------------------------------
// Fast Scalar & Bit Utilities
// ----------------------------------------------------------------------------
static inline int ctz64(uint64_t x) { return __builtin_ctzll(x); }
static inline int popcnt64(uint64_t x) { return __builtin_popcountll(x); }
static inline uint64_t bswap64(uint64_t x) { return __builtin_bswap64(x); }
static inline int abs_i(int x) { return x < 0 ? -x : x; }
static inline int max_i(int a, int b) { return a > b ? a : b; }
static inline int min_i(int a, int b) { return a < b ? a : b; }
static inline int clamp_i(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

static float fast_ln(float x) {
    if (x <= 1.0f) return 0.0f;
    int exp = 0;
    while (x >= 2.0f) { x *= 0.5f; exp++; }
    float y = (x - 1.0f) / (x + 1.0f);
    float y2 = y * y;
    float poly = 2.0f * y * (1.0f + y2 * (0.3333333f + y2 * 0.2f));
    return exp * 0.69314718f + poly;
}

static inline uint16_t rd_u16(const uint8_t* p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static inline uint32_t rd_u32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// ----------------------------------------------------------------------------
// Engine Constants & 16-bit Move Encoding (Stockfish-compact Move16)
// ----------------------------------------------------------------------------
enum { WHITE = 0, BLACK = 1 };
enum { PT_PAWN = 0, PT_KNIGHT = 1, PT_BISHOP = 2, PT_ROOK = 3, PT_QUEEN = 4, PT_KING = 5 };
static constexpr uint8_t EMPTY_SQ = 255;

enum {
    MT_NORMAL = 0,
    MT_PROMOTION = 1,
    MT_EN_PASSANT = 2,
    MT_CASTLING = 3
};

enum { CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8 };

static constexpr int MAX_PLY = 128;
static constexpr int MAX_MOVES = 256;
static constexpr int MAX_HIST = 1024;
static constexpr int MATE_SCORE = 25000;
static constexpr int MATE_BOUND = 23000;
static constexpr int INF_SCORE = 30000;
static constexpr int16_t VALUE_NONE = 32000;

static constexpr int SEE_VALUES[6] = { 100, 320, 330, 500, 950, 20000 };

static inline uint16_t encode_move(int from, int to, int promo = 0, int mtype = MT_NORMAL) {
    int pbits = (mtype == MT_PROMOTION) ? ((promo - 1) & 3) : 0;
    return (uint16_t)((to & 63) | ((from & 63) << 6) | (pbits << 12) | ((mtype & 3) << 14));
}

static inline int mv_to(uint16_t m) { return m & 63; }
static inline int mv_from(uint16_t m) { return (m >> 6) & 63; }
static inline int mv_type(uint16_t m) { return (m >> 14) & 3; }
static inline int mv_promo(uint16_t m) { return (mv_type(m) == MT_PROMOTION) ? (((m >> 12) & 3) + 1) : 0; }

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
static uint64_t LINE_BB[64][64];
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

// ----------------------------------------------------------------------------
// Runtime NNUE Architecture Constants & Tables (nn-bddd9d57eb87.nnue)
// ----------------------------------------------------------------------------
static constexpr uint32_t SF_NNUE_VERSION = 0x6a448afaU;
static constexpr uint32_t SF_NNUE_NET_HASH = 0x9a4fcb66U;
static constexpr uint32_t SF_STACK_TABLE_HASH = 0x5a7ab1e5U;
static constexpr uint32_t SF_FT_HASH = 0xa3060b95U;
static constexpr uint32_t SF_ARCH_HASH = 0x63337116U;

static constexpr int L1_SIZE = 1024;
static constexpr int L1_HALF = 512;
static constexpr int L2_SIZE = 32;
static constexpr int L3_SIZE = 32;
static constexpr int OUTPUT_SCALE = 16;
static constexpr int WEIGHT_SCALE_BITS = 6;
static constexpr int FT_MAX_VAL = 255;
static constexpr int HIDDEN_ONE_VAL = 128;

static constexpr int RAW_LAYER_STACKS = 192;
static constexpr int MAX_STORED_STACKS = 96;
static constexpr int K32_PS_NB = 704;
static constexpr int K32_BLOCK_DIM = 32 * K32_PS_NB; // 22528
static constexpr int K32_DIM = 3 * K32_BLOCK_DIM;    // 67584
static constexpr int FT_THREAT_DIM = 59808;
static constexpr int FT_PP_BASE = 59808;
static constexpr int FT_PP_DIM = 4560;

// Stockfish Piece encoding: 1..6 = White, 9..14 = Black
enum {
    SF_NO_PIECE = 0,
    SF_W_PAWN = 1, SF_W_KNIGHT = 2, SF_W_BISHOP = 3, SF_W_ROOK = 4, SF_W_QUEEN = 5, SF_W_KING = 6,
    SF_B_PAWN = 9, SF_B_KNIGHT = 10, SF_B_BISHOP = 11, SF_B_ROOK = 12, SF_B_QUEEN = 13, SF_B_KING = 14
};
enum { SF_PAWN = 1, SF_KNIGHT = 2, SF_BISHOP = 3, SF_ROOK = 4, SF_QUEEN = 5, SF_KING = 6 };

static const uint8_t BSZ_TO_SF[12] = {
    SF_W_PAWN,   SF_B_PAWN,
    SF_W_KNIGHT, SF_B_KNIGHT,
    SF_W_BISHOP, SF_B_BISHOP,
    SF_W_ROOK,   SF_B_ROOK,
    SF_W_QUEEN,  SF_B_QUEEN,
    SF_W_KING,   SF_B_KING
};

static const uint8_t ORIENT_TBL[64] = {
    7,7,7,7,0,0,0,0, 7,7,7,7,0,0,0,0, 7,7,7,7,0,0,0,0, 7,7,7,7,0,0,0,0,
    7,7,7,7,0,0,0,0, 7,7,7,7,0,0,0,0, 7,7,7,7,0,0,0,0, 7,7,7,7,0,0,0,0
};

static const uint16_t PIECE_SQUARE_INDEX[2][16] = {
    {0, 0, 128, 256, 384, 512, 640, 0, 0, 64, 192, 320, 448, 576, 640, 0},
    {0, 64, 192, 320, 448, 576, 640, 0, 0, 0, 128, 256, 384, 512, 640, 0}
};

#define KB_VAL(v) ((uint32_t)(v) * 704U)
static const uint32_t KING_BUCKETS[64] = {
    KB_VAL(28), KB_VAL(29), KB_VAL(30), KB_VAL(31), KB_VAL(31), KB_VAL(30), KB_VAL(29), KB_VAL(28),
    KB_VAL(24), KB_VAL(25), KB_VAL(26), KB_VAL(27), KB_VAL(27), KB_VAL(26), KB_VAL(25), KB_VAL(24),
    KB_VAL(20), KB_VAL(21), KB_VAL(22), KB_VAL(23), KB_VAL(23), KB_VAL(22), KB_VAL(21), KB_VAL(20),
    KB_VAL(16), KB_VAL(17), KB_VAL(18), KB_VAL(19), KB_VAL(19), KB_VAL(18), KB_VAL(17), KB_VAL(16),
    KB_VAL(12), KB_VAL(13), KB_VAL(14), KB_VAL(15), KB_VAL(15), KB_VAL(14), KB_VAL(13), KB_VAL(12),
    KB_VAL( 8), KB_VAL( 9), KB_VAL(10), KB_VAL(11), KB_VAL(11), KB_VAL(10), KB_VAL( 9), KB_VAL( 8),
    KB_VAL( 4), KB_VAL( 5), KB_VAL( 6), KB_VAL( 7), KB_VAL( 7), KB_VAL( 6), KB_VAL( 5), KB_VAL( 4),
    KB_VAL( 0), KB_VAL( 1), KB_VAL( 2), KB_VAL( 3), KB_VAL( 3), KB_VAL( 2), KB_VAL( 1), KB_VAL( 0)
};
#undef KB_VAL

static uint64_t SF_PSEUDO_ATK[8][64]; // 0: White Pawn, 1: Black Pawn, 2..6: N,B,R,Q,K
static uint64_t PAWN_PAIR_BB[64];
static uint32_t THREAT_LUT1[16][16][2];
static uint16_t THREAT_LUT2[8][64][64];

struct alignas(64) UnpackedLayerStack {
    alignas(16) int32_t fc0_b[L2_SIZE];
    alignas(16) int8_t  fc0_w_t[L1_SIZE / 4][L2_SIZE][4];
    alignas(16) int32_t fc1_b[L3_SIZE];
    alignas(16) int8_t  fc1_w_t[64 / 4][L3_SIZE][4];
    alignas(16) int32_t fc2_b[1];
    alignas(16) int8_t  fc2_w[128];
};

static bool g_nnue_loaded = false;
static uint32_t g_stored_stacks = 0;
static uint16_t g_layer_stack_index[RAW_LAYER_STACKS];
alignas(64) static int16_t g_ft_biases[L1_SIZE];
static const int8_t* g_ft_thr_pp = nullptr;
static const int8_t* g_ft_psq = nullptr;
alignas(64) static UnpackedLayerStack g_layer_stacks[MAX_STORED_STACKS];

static bool init_nnue_buffer(size_t sz) {
    if (sz != EXPECTED_NNUE_BYTES) return false;
    g_nnue_loaded = false;
    const uint8_t* base = g_nnue_buf;

    size_t off = 0;
    uint32_t ver = rd_u32(base + off); off += 4;
    uint32_t nh  = rd_u32(base + off); off += 4;
    uint32_t dsz = rd_u32(base + off); off += 4;
    if (ver != SF_NNUE_VERSION || nh != SF_NNUE_NET_HASH || off + dsz + 16 > sz) return false;
    off += dsz;

    uint32_t st_hash = rd_u32(base + off); off += 4;
    uint32_t raw_stacks = rd_u32(base + off); off += 4;
    g_stored_stacks = rd_u32(base + off); off += 4;
    if (st_hash != SF_STACK_TABLE_HASH || raw_stacks != RAW_LAYER_STACKS || g_stored_stacks > MAX_STORED_STACKS) {
        return false;
    }

    uint16_t fb[RAW_LAYER_STACKS];
    uint16_t idx[RAW_LAYER_STACKS];
    uint16_t st = 0;
    for (int s = 0; s < RAW_LAYER_STACKS; ++s) {
        fb[s] = rd_u16(base + off);
        off += 2;
        if (fb[s] >= RAW_LAYER_STACKS) return false;
        if (fb[s] == s) idx[s] = st++;
    }
    for (int s = 0; s < RAW_LAYER_STACKS; ++s) {
        g_layer_stack_index[s] = idx[fb[s]];
    }

    uint32_t fth = rd_u32(base + off); off += 4;
    if (fth != SF_FT_HASH) return false;

    memcpy(g_ft_biases, base + off, L1_SIZE * sizeof(int16_t));
    off += L1_SIZE * sizeof(int16_t);

    size_t thr_pp_bytes = (size_t)(FT_THREAT_DIM + FT_PP_DIM) * L1_SIZE;
    size_t psq_bytes = (size_t)K32_DIM * L1_SIZE;
    if (off + thr_pp_bytes + psq_bytes > sz) return false;

    g_ft_thr_pp = (const int8_t*)(base + off);
    off += thr_pp_bytes;

    g_ft_psq = (const int8_t*)(base + off);
    off += psq_bytes;

    for (uint32_t s = 0; s < g_stored_stacks; ++s) {
        if (off + 4 > sz) return false;
        uint32_t ah = rd_u32(base + off); off += 4;
        if (ah != SF_ARCH_HASH) return false;

        UnpackedLayerStack& L = g_layer_stacks[s];
        memcpy(L.fc0_b, base + off, sizeof(L.fc0_b)); off += sizeof(L.fc0_b);
        const int8_t* raw_fc0 = (const int8_t*)(base + off);
        off += L2_SIZE * L1_SIZE;
        for (int c = 0; c < L1_SIZE / 4; ++c) {
            for (int r = 0; r < L2_SIZE; ++r) {
                for (int k = 0; k < 4; ++k) {
                    L.fc0_w_t[c][r][k] = raw_fc0[r * L1_SIZE + c * 4 + k];
                }
            }
        }

        memcpy(L.fc1_b, base + off, sizeof(L.fc1_b)); off += sizeof(L.fc1_b);
        const int8_t* raw_fc1 = (const int8_t*)(base + off);
        off += L3_SIZE * 64;
        for (int c = 0; c < 64 / 4; ++c) {
            for (int r = 0; r < L3_SIZE; ++r) {
                for (int k = 0; k < 4; ++k) {
                    L.fc1_w_t[c][r][k] = raw_fc1[r * 64 + c * 4 + k];
                }
            }
        }

        memcpy(L.fc2_b, base + off, sizeof(L.fc2_b)); off += sizeof(L.fc2_b);
        memcpy(L.fc2_w, base + off, sizeof(L.fc2_w)); off += sizeof(L.fc2_w);
    }

    if (off != sz) return false;
    g_nnue_loaded = true;
    return true;
}

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
        SF_PSEUDO_ATK[WHITE][sq] = PAWN_ATK[WHITE][sq];
        SF_PSEUDO_ATK[BLACK][sq] = PAWN_ATK[BLACK][sq];

        uint64_t na = 0;
        for (int i = 0; i < 8; ++i) {
            int nr = r + k_dr[i], nf = f + k_df[i];
            if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) na |= 1ULL << (nr * 8 + nf);
        }
        KNIGHT_ATK[sq] = na;
        SF_PSEUDO_ATK[SF_KNIGHT][sq] = na;

        uint64_t ka = 0;
        for (int dr = -1; dr <= 1; ++dr) {
            for (int df = -1; df <= 1; ++df) {
                if (dr == 0 && df == 0) continue;
                int nr = r + dr, nf = f + df;
                if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) ka |= 1ULL << (nr * 8 + nf);
            }
        }
        KING_ATK[sq] = ka;
        SF_PSEUDO_ATK[SF_KING][sq] = ka;

        uint64_t fm = 0, dm = 0, am = 0, rm = 0;
        for (int rr = 0; rr < 8; ++rr) {
            for (int ff = 0; ff < 8; ++ff) {
                int s2 = rr * 8 + ff;
                if (s2 == sq) continue;
                if (rr == r) rm |= 1ULL << s2;
                if (ff == f) fm |= 1ULL << s2;
                if ((rr - ff) == (r - f)) dm |= 1ULL << s2;
                if ((rr + ff) == (r + f)) am |= 1ULL << s2;
            }
        }
        FILE_MASK[sq] = fm;
        DIAG_MASK[sq] = dm;
        ANTI_MASK[sq] = am;
        SF_PSEUDO_ATK[SF_BISHOP][sq] = dm | am;
        SF_PSEUDO_ATK[SF_ROOK][sq]   = fm | rm;
        SF_PSEUDO_ATK[SF_QUEEN][sq]  = dm | am | fm | rm;

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

        uint64_t pp = 0;
        for (int rr = 1; rr <= 6; ++rr) {
            for (int ff = max_i(0, f - 1); ff <= min_i(7, f + 1); ++ff) {
                int s2 = rr * 8 + ff;
                if (s2 != sq) pp |= 1ULL << s2;
            }
        }
        PAWN_PAIR_BB[sq] = pp;
    }

    for (int s1 = 0; s1 < 64; ++s1) {
        int r1 = s1 >> 3, f1 = s1 & 7;
        for (int s2 = 0; s2 < 64; ++s2) {
            BETWEEN_BB[s1][s2] = 0ULL;
            LINE_BB[s1][s2] = 0ULL;
            RAYPASS_BB[s1][s2] = 0ULL;
            if (s1 == s2) continue;
            int r2 = s2 >> 3, f2 = s2 & 7;
            int dr = (r2 > r1) - (r2 < r1);
            int df = (f2 > f1) - (f2 < f1);
            if (r1 != r2 && f1 != f2 && abs_i(r2 - r1) != abs_i(f2 - f1)) continue;

            for (int rr = 0; rr < 8; ++rr) {
                for (int ff = 0; ff < 8; ++ff) {
                    int s3 = rr * 8 + ff;
                    if ((rr - r1) * df == (ff - f1) * dr) LINE_BB[s1][s2] |= 1ULL << s3;
                }
            }

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

    uint64_t rng = 0x123456789abcdef0ULL;
    for (int p = 0; p < 12; ++p)
        for (int sq = 0; sq < 64; ++sq)
            ZOBRIST_PIECE[p][sq] = splitmix64(rng);
    for (int c = 0; c < 16; ++c) ZOBRIST_CASTLE[c] = splitmix64(rng);
    for (int f = 0; f < 8; ++f) ZOBRIST_EP[f] = splitmix64(rng);
    ZOBRIST_SIDE = splitmix64(rng);

    for (int d = 0; d < 64; ++d) {
        for (int m = 0; m < 64; ++m) {
            if (d == 0 || m == 0) LMR_TABLE[d][m] = 0;
            else LMR_TABLE[d][m] = (int)(0.75f + fast_ln((float)d) * fast_ln((float)m) / 2.25f);
        }
    }

    // Exact Stockfish FullThreats LUTs
    static constexpr int numValidTargets[16] = {0, 4, 10, 8, 8, 10, 0, 0, 0, 4, 10, 8, 8, 10, 0, 0};
    static constexpr int map[6][6] = {
        {-1,  0, -1,  1, -1, -1},
        { 0,  1,  2,  3,  4, -1},
        { 0,  1,  2,  3, -1, -1},
        { 0,  1,  2,  3, -1, -1},
        { 0,  1,  2,  3,  4, -1},
        {-1, -1, -1, -1, -1, -1}
    };
    const int AllSfPieces[12] = {
        SF_W_PAWN, SF_W_KNIGHT, SF_W_BISHOP, SF_W_ROOK, SF_W_QUEEN, SF_W_KING,
        SF_B_PAWN, SF_B_KNIGHT, SF_B_BISHOP, SF_B_ROOK, SF_B_QUEEN, SF_B_KING
    };
    uint32_t offsets[8]{};
    for (int pt = SF_PAWN; pt <= SF_KING; ++pt) {
        uint16_t off = 0;
        for (int from = 0; from < 64; ++from) {
            for (int to = 0; to < 64; ++to) {
                uint64_t atk = (pt != SF_PAWN) ? SF_PSEUDO_ATK[pt][from]
                             : (to < from)     ? SF_PSEUDO_ATK[BLACK][from]
                                               : SF_PSEUDO_ATK[WHITE][from];
                uint64_t below = (to == 0) ? 0ULL : ((1ULL << to) - 1ULL);
                THREAT_LUT2[pt][from][to] = off + (uint16_t)popcnt64(below & atk);
            }
            if (pt != SF_PAWN) off += (uint16_t)popcnt64(SF_PSEUDO_ATK[pt][from]);
            else if (from >= 8 && from <= 55) off += (uint16_t)popcnt64(SF_PSEUDO_ATK[WHITE][from]);
        }
        offsets[pt] = off;
    }

    uint32_t cum = 0;
    for (int atk : AllSfPieces) {
        int apt = atk & 7;
        uint32_t coff = offsets[apt];
        uint32_t vt = (uint32_t)numValidTargets[atk];
        for (int def : AllSfPieces) {
            bool enemy = (atk ^ def) == 8;
            int dpt = def & 7;
            int m = map[apt - 1][dpt - 1];
            bool semi_excl = (apt == dpt) && (enemy || apt != SF_PAWN);
            uint32_t dcol = (uint32_t)((def >> 3) & 1);
            uint32_t feat = cum + (dcol * (vt / 2) + (uint32_t)m) * coff;
            bool excl = (m < 0);
            THREAT_LUT1[atk][def][0] = excl ? (uint32_t)FT_THREAT_DIM : feat;
            THREAT_LUT1[atk][def][1] = (excl || semi_excl) ? (uint32_t)FT_THREAT_DIM : feat;
        }
        cum += vt * coff;
    }

}

// ----------------------------------------------------------------------------
// Forward-Declared NNUE Delta Types
// ----------------------------------------------------------------------------
struct DirtyThreat {
    uint8_t pc;     // Berserker piece 0..11
    uint8_t tpc;    // Berserker piece 0..11
    uint8_t sq;
    uint8_t tsq;
    uint8_t add;
};

struct SfNnue;

// ----------------------------------------------------------------------------
// Board Representation & Bitboard Primitives
// ----------------------------------------------------------------------------
struct UndoInfo {
    uint16_t move;
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

    uint16_t move_list[MAX_PLY][MAX_MOVES];
    int move_scores[MAX_PLY][MAX_MOVES];

    inline uint64_t by_pt(int pt) const {
        return pieces[pt << 1] | pieces[(pt << 1) | 1];
    }

    inline int psq_block(int persp) const {
        if (pieces[(PT_QUEEN << 1) | (persp ^ 1)]) return 2;
        if (by_pt(PT_ROOK) | by_pt(PT_QUEEN)) return 1;
        return 0;
    }

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

    bool gives_check(uint16_t move) const {
        int from = mv_from(move), to = mv_to(move), mtype = mv_type(move), promo = mv_promo(move);
        int us = turn, them = us ^ 1;
        int ksq = king_sq[them];
        uint64_t kbb = 1ULL << ksq;
        uint8_t pc = mailbox[from];
        int pt = (promo > 0) ? promo : (pc >> 1);

        // Direct check from destination square
        switch (pt) {
            case PT_PAWN:   if (PAWN_ATK[us][to] & kbb) return true; break;
            case PT_KNIGHT: if (KNIGHT_ATK[to] & kbb) return true; break;
            case PT_BISHOP: if (bishop_attacks(to, occ ^ (1ULL << from)) & kbb) return true; break;
            case PT_ROOK:   if (rook_attacks(to, occ ^ (1ULL << from)) & kbb) return true; break;
            case PT_QUEEN:  if (queen_attacks(to, occ ^ (1ULL << from)) & kbb) return true; break;
            default: break;
        }

        // Discovered check from 'from' vacating line with enemy king
        if (LINE_BB[from][ksq]) {
            uint64_t new_occ = (occ ^ (1ULL << from)) | (1ULL << to);
            if (mtype == MT_EN_PASSANT) new_occ ^= 1ULL << (us == WHITE ? to - 8 : to + 8);
            uint64_t rq = pieces[(PT_ROOK << 1) | us] | pieces[(PT_QUEEN << 1) | us];
            if (rq && (rook_attacks(ksq, new_occ) & rq)) return true;
            uint64_t bq = pieces[(PT_BISHOP << 1) | us] | pieces[(PT_QUEEN << 1) | us];
            if (bq && (bishop_attacks(ksq, new_occ) & bq)) return true;
        }

        if (mtype == MT_EN_PASSANT) {
            int capsq = us == WHITE ? to - 8 : to + 8;
            if (LINE_BB[capsq][ksq]) {
                uint64_t new_occ = (occ ^ (1ULL << from) ^ (1ULL << capsq)) | (1ULL << to);
                uint64_t rq = pieces[(PT_ROOK << 1) | us] | pieces[(PT_QUEEN << 1) | us];
                if (rq && (rook_attacks(ksq, new_occ) & rq)) return true;
                uint64_t bq = pieces[(PT_BISHOP << 1) | us] | pieces[(PT_QUEEN << 1) | us];
                if (bq && (bishop_attacks(ksq, new_occ) & bq)) return true;
            }
        } else if (mtype == MT_CASTLING) {
            int rfrom = (to > from) ? (us == WHITE ? 7 : 63) : (us == WHITE ? 0 : 56);
            int rto   = (to > from) ? (us == WHITE ? 5 : 61) : (us == WHITE ? 3 : 59);
            uint64_t new_occ = (occ ^ (1ULL << from) ^ (1ULL << rfrom)) | (1ULL << to) | (1ULL << rto);
            if (rook_attacks(ksq, new_occ) & (1ULL << rto)) return true;
        }

        return false;
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
        uint16_t* list = move_list[ply];
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
                    list[count++] = encode_move(sq, to, PT_QUEEN, MT_PROMOTION);
                    if (!captures_only) {
                        list[count++] = encode_move(sq, to, PT_ROOK, MT_PROMOTION);
                        list[count++] = encode_move(sq, to, PT_BISHOP, MT_PROMOTION);
                        list[count++] = encode_move(sq, to, PT_KNIGHT, MT_PROMOTION);
                    }
                }
            } else if (!captures_only && empty_to) {
                list[count++] = encode_move(sq, to, 0, MT_NORMAL);
                if (rank == start_rank && mailbox[to + up] == EMPTY_SQ) {
                    list[count++] = encode_move(sq, to + up, 0, MT_NORMAL);
                }
            }

            uint64_t caps = PAWN_ATK[us][sq] & their_bb;
            while (caps) {
                int cap_sq = ctz64(caps);
                caps &= caps - 1;
                if (rank == promo_rank) {
                    list[count++] = encode_move(sq, cap_sq, PT_QUEEN, MT_PROMOTION);
                    list[count++] = encode_move(sq, cap_sq, PT_ROOK, MT_PROMOTION);
                    list[count++] = encode_move(sq, cap_sq, PT_BISHOP, MT_PROMOTION);
                    list[count++] = encode_move(sq, cap_sq, PT_KNIGHT, MT_PROMOTION);
                } else {
                    list[count++] = encode_move(sq, cap_sq, 0, MT_NORMAL);
                }
            }

            if (ep_sq >= 0 && (PAWN_ATK[us][sq] & (1ULL << ep_sq))) {
                list[count++] = encode_move(sq, ep_sq, 0, MT_EN_PASSANT);
            }
        }

        // 2. Knights
        uint64_t bb = pieces[(PT_KNIGHT << 1) | us];
        while (bb) {
            int sq = ctz64(bb); bb &= bb - 1;
            uint64_t t = KNIGHT_ATK[sq] & target_bb;
            while (t) { int to = ctz64(t); t &= t - 1; list[count++] = encode_move(sq, to); }
        }

        // 3. Bishops
        bb = pieces[(PT_BISHOP << 1) | us];
        while (bb) {
            int sq = ctz64(bb); bb &= bb - 1;
            uint64_t t = bishop_attacks(sq, occ) & target_bb;
            while (t) { int to = ctz64(t); t &= t - 1; list[count++] = encode_move(sq, to); }
        }

        // 4. Rooks
        bb = pieces[(PT_ROOK << 1) | us];
        while (bb) {
            int sq = ctz64(bb); bb &= bb - 1;
            uint64_t t = rook_attacks(sq, occ) & target_bb;
            while (t) { int to = ctz64(t); t &= t - 1; list[count++] = encode_move(sq, to); }
        }

        // 5. Queens
        bb = pieces[(PT_QUEEN << 1) | us];
        while (bb) {
            int sq = ctz64(bb); bb &= bb - 1;
            uint64_t t = queen_attacks(sq, occ) & target_bb;
            while (t) { int to = ctz64(t); t &= t - 1; list[count++] = encode_move(sq, to); }
        }

        // 6. King + Castling
        int ksq = king_sq[us];
        uint64_t kt = KING_ATK[ksq] & target_bb;
        while (kt) { int to = ctz64(kt); kt &= kt - 1; list[count++] = encode_move(ksq, to); }

        if (!captures_only) {
            if (us == WHITE && ksq == 4) {
                if ((castling & CASTLE_WK) && ((empty_bb & ((1ULL << 5) | (1ULL << 6))) == ((1ULL << 5) | (1ULL << 6)))) {
                    if (!is_attacked(4, BLACK) && !is_attacked(5, BLACK) && !is_attacked(6, BLACK)) {
                        list[count++] = encode_move(4, 6, 0, MT_CASTLING);
                    }
                }
                if ((castling & CASTLE_WQ) && ((empty_bb & ((1ULL << 1) | (1ULL << 2) | (1ULL << 3))) == ((1ULL << 1) | (1ULL << 2) | (1ULL << 3)))) {
                    if (!is_attacked(4, BLACK) && !is_attacked(3, BLACK) && !is_attacked(2, BLACK)) {
                        list[count++] = encode_move(4, 2, 0, MT_CASTLING);
                    }
                }
            } else if (us == BLACK && ksq == 60) {
                if ((castling & CASTLE_BK) && ((empty_bb & ((1ULL << 61) | (1ULL << 62))) == ((1ULL << 61) | (1ULL << 62)))) {
                    if (!is_attacked(60, WHITE) && !is_attacked(61, WHITE) && !is_attacked(62, WHITE)) {
                        list[count++] = encode_move(60, 62, 0, MT_CASTLING);
                    }
                }
                if ((castling & CASTLE_BQ) && ((empty_bb & ((1ULL << 57) | (1ULL << 58) | (1ULL << 59))) == ((1ULL << 57) | (1ULL << 58) | (1ULL << 59)))) {
                    if (!is_attacked(60, WHITE) && !is_attacked(59, WHITE) && !is_attacked(58, WHITE)) {
                        list[count++] = encode_move(60, 58, 0, MT_CASTLING);
                    }
                }
            }
        }
        return count;
    }

    int static_exchange_eval(uint16_t move) const {
        int from = mv_from(move), to = mv_to(move), promo = mv_promo(move), mtype = mv_type(move);
        if (mtype == MT_CASTLING) return 0;
        uint8_t moved = mailbox[from];
        if (moved == EMPTY_SQ) return 0;

        int gain = 0;
        if (mtype == MT_EN_PASSANT) gain = SEE_VALUES[PT_PAWN];
        else if (mailbox[to] != EMPTY_SQ) gain = SEE_VALUES[mailbox[to] >> 1];
        if (promo > 0) gain += SEE_VALUES[promo] - SEE_VALUES[PT_PAWN];

        int attacker_pt = promo > 0 ? promo : (moved >> 1);
        int next_victim = SEE_VALUES[attacker_pt];

        uint64_t o = occ ^ (1ULL << from);
        if (mtype == MT_EN_PASSANT) {
            o ^= 1ULL << (turn == WHITE ? to - 8 : to + 8);
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

            o ^= 1ULL << picked_sq;
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
// Stockfish NNUE Evaluator (K32H3 + FullThreats + PP_3Wide, Finny Cache)
// ----------------------------------------------------------------------------
static inline uint32_t psq_feature_index(int persp, int bsz_pc, int sq, int ksq, int blk) {
    uint16_t flip = (uint16_t)(56 * persp);
    uint16_t orient = (uint16_t)ORIENT_TBL[ksq] ^ flip;
    uint32_t kb = KING_BUCKETS[ksq ^ flip];
    uint8_t sf_pc = BSZ_TO_SF[bsz_pc];
    return (uint32_t)blk * K32_BLOCK_DIM + ((uint32_t)sq ^ (PIECE_SQUARE_INDEX[persp][sf_pc] + kb + orient));
}

static inline uint32_t threat_feature_index(int persp, int ksq, int bsz_atk, int bsz_def, int from, int to) {
    uint16_t orient = (uint16_t)ORIENT_TBL[ksq] ^ (uint16_t)(56 * persp);
    uint8_t swap = (uint8_t)(8 * persp);
    int fo = from ^ orient;
    int to_o = to ^ orient;
    uint8_t sfa = BSZ_TO_SF[bsz_atk] ^ swap;
    uint8_t sfd = BSZ_TO_SF[bsz_def] ^ swap;
    int pt = sfa & 7;
    return THREAT_LUT1[sfa][sfd][fo < to_o] + THREAT_LUT2[pt][fo][to_o];
}

struct FinnyCacheEntry {
    alignas(16) int16_t acc[L1_SIZE];
    uint64_t pieces[12];
};

struct SfNnue {
    static constexpr int ACC_DEPTH = 132;
    static constexpr int MAX_DT = 160;

    alignas(16) int16_t psq[ACC_DEPTH][2][L1_SIZE];
    alignas(16) int16_t thr[ACC_DEPTH][2][L1_SIZE];
    uint8_t psq_valid[ACC_DEPTH][2];
    uint8_t thr_valid[ACC_DEPTH][2];
    uint8_t psq_needs_refresh[ACC_DEPTH][2];
    uint8_t thr_needs_refresh[ACC_DEPTH][2];

    // Per-ply incremental PSQ diff (piece add/sub squares)
    uint8_t dp_sub_pc[ACC_DEPTH][2];
    uint8_t dp_sub_sq[ACC_DEPTH][2];
    uint8_t dp_sub_cnt[ACC_DEPTH];
    uint8_t dp_add_pc[ACC_DEPTH][2];
    uint8_t dp_add_sq[ACC_DEPTH][2];
    uint8_t dp_add_cnt[ACC_DEPTH];
    uint8_t dp_ksq[ACC_DEPTH][2];
    uint8_t dp_blk[ACC_DEPTH][2];

    // Per-ply incremental Threat & PawnPair diff
    DirtyThreat dt[ACC_DEPTH][MAX_DT];
    uint16_t dt_cnt[ACC_DEPTH];
    uint64_t pp_before[ACC_DEPTH][2];
    uint64_t pp_after[ACC_DEPTH][2];

    FinnyCacheEntry finny[3][64][2];
    bool finny_initialized = false;
    int ply;
    alignas(16) uint8_t ft_out[L1_SIZE];

#ifdef __wasm_simd128__
    static inline void vec_add_i8_inplace(int16_t* dst, const int8_t* w) {
        for (int i = 0; i < L1_SIZE; i += 8) {
            v128_t a = wasm_v128_load(dst + i);
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
    static inline void vec_addsub_i8_inplace(int16_t* dst, const int8_t* wa, const int8_t* ws) {
        for (int i = 0; i < L1_SIZE; i += 8) {
            v128_t a = wasm_v128_load(dst + i);
            v128_t va = wasm_i16x8_load8x8(wa + i);
            v128_t vs = wasm_i16x8_load8x8(ws + i);
            wasm_v128_store(dst + i, wasm_i16x8_sub(wasm_i16x8_add(a, va), vs));
        }
    }
#else
    static inline void vec_add_i8_inplace(int16_t* __restrict__ dst, const int8_t* __restrict__ w) {
        for (int i = 0; i < L1_SIZE; ++i) dst[i] += w[i];
    }
    static inline void vec_sub_i8_inplace(int16_t* __restrict__ dst, const int8_t* __restrict__ w) {
        for (int i = 0; i < L1_SIZE; ++i) dst[i] -= w[i];
    }
    static inline void vec_addsub_i8_inplace(int16_t* __restrict__ dst, const int8_t* __restrict__ wa, const int8_t* __restrict__ ws) {
        for (int i = 0; i < L1_SIZE; ++i) dst[i] += (int16_t)wa[i] - (int16_t)ws[i];
    }
#endif

    void clear_finny() {
        for (int blk = 0; blk < 3; ++blk) {
            for (int ksq = 0; ksq < 64; ++ksq) {
                for (int pov = 0; pov < 2; ++pov) {
                    memcpy(finny[blk][ksq][pov].acc, g_ft_biases, L1_SIZE * sizeof(int16_t));
                    memset(finny[blk][ksq][pov].pieces, 0, sizeof(finny[blk][ksq][pov].pieces));
                }
            }
        }
        finny_initialized = true;
    }

    void refresh_psq_finny(const Board& b, int pov, int target_ply) {
        if (!finny_initialized) clear_finny();
        int ksq = b.king_sq[pov];
        int blk = b.psq_block(pov);
        FinnyCacheEntry& ce = finny[blk][ksq][pov];

        for (int pc = 0; pc < 12; ++pc) {
            uint64_t cur = b.pieces[pc];
            uint64_t prev = ce.pieces[pc];
            if (cur == prev) continue;
            uint64_t added = cur & ~prev;
            uint64_t removed = prev & ~cur;
            while (added && removed) {
                int sq_a = ctz64(added); added &= added - 1;
                int sq_r = ctz64(removed); removed &= removed - 1;
                uint32_t ia = psq_feature_index(pov, pc, sq_a, ksq, blk);
                uint32_t ir = psq_feature_index(pov, pc, sq_r, ksq, blk);
                vec_addsub_i8_inplace(ce.acc, g_ft_psq + (size_t)ia * L1_SIZE, g_ft_psq + (size_t)ir * L1_SIZE);
            }
            while (added) {
                int sq_a = ctz64(added); added &= added - 1;
                uint32_t ia = psq_feature_index(pov, pc, sq_a, ksq, blk);
                vec_add_i8_inplace(ce.acc, g_ft_psq + (size_t)ia * L1_SIZE);
            }
            while (removed) {
                int sq_r = ctz64(removed); removed &= removed - 1;
                uint32_t ir = psq_feature_index(pov, pc, sq_r, ksq, blk);
                vec_sub_i8_inplace(ce.acc, g_ft_psq + (size_t)ir * L1_SIZE);
            }
            ce.pieces[pc] = cur;
        }
        memcpy(psq[target_ply][pov], ce.acc, L1_SIZE * sizeof(int16_t));
        psq_valid[target_ply][pov] = 1;
        psq_needs_refresh[target_ply][pov] = 0;
    }

    inline void add_pp_features(int16_t* acc, int pov, int ksq, uint64_t updated, uint64_t pw, uint64_t pb, bool add) {
        if (!updated) return;
        uint16_t orient = (uint16_t)ORIENT_TBL[ksq] ^ (uint16_t)(56 * pov);
        uint64_t unchanged = (pw | pb) & ~updated;
        for (uint64_t u = updated; u;) {
            int a = ctz64(u); u &= u - 1;
            uint64_t partners = PAWN_PAIR_BB[a] & (unchanged | u);
            if (!partners) continue;
            int aCol = ((pb >> a) & 1ULL) ? BLACK : WHITE;
            uint32_t aId = (uint32_t)(48 * (aCol ^ pov) + ((a ^ orient) - 8));
            while (partners) {
                int b_sq = ctz64(partners); partners &= partners - 1;
                int bCol = ((pb >> b_sq) & 1ULL) ? BLACK : WHITE;
                uint32_t bId = (uint32_t)(48 * (bCol ^ pov) + ((b_sq ^ orient) - 8));
                uint32_t hi = aId > bId ? aId : bId;
                uint32_t lo = aId < bId ? aId : bId;
                uint32_t pidx = (hi * (hi - 1)) / 2 + lo + FT_PP_BASE;
                const int8_t* w = g_ft_thr_pp + (size_t)pidx * L1_SIZE;
                if (add) vec_add_i8_inplace(acc, w);
                else     vec_sub_i8_inplace(acc, w);
            }
        }
    }

    void refresh_thr_pov(const Board& b, int pov, int target_ply) {
        int16_t* acc = thr[target_ply][pov];
        memset(acc, 0, L1_SIZE * sizeof(int16_t));
        int ksq = b.king_sq[pov];
        uint64_t occ = b.occ;

        uint64_t pawnTargets = b.by_pt(PT_KNIGHT) | b.by_pt(PT_ROOK);
        uint64_t minorTargets = b.by_pt(PT_PAWN) | b.by_pt(PT_KNIGHT) | b.by_pt(PT_BISHOP) | b.by_pt(PT_ROOK);
        uint64_t queenTargets = minorTargets | b.by_pt(PT_QUEEN);

        // Pawns
        uint64_t p = b.by_pt(PT_PAWN);
        while (p) {
            int from = ctz64(p); p &= p - 1;
            int pc = b.mailbox[from];
            uint64_t t = PAWN_ATK[pc & 1][from] & pawnTargets;
            while (t) {
                int to = ctz64(t); t &= t - 1;
                uint32_t tidx = threat_feature_index(pov, ksq, pc, b.mailbox[to], from, to);
                if (tidx < FT_THREAT_DIM) vec_add_i8_inplace(acc, g_ft_thr_pp + (size_t)tidx * L1_SIZE);
            }
        }

        // Knights, Bishops, Rooks, Queens
        for (int pt = PT_KNIGHT; pt <= PT_QUEEN; ++pt) {
            uint64_t pbb = b.by_pt(pt);
            uint64_t targets = (pt == PT_KNIGHT || pt == PT_QUEEN) ? queenTargets : minorTargets;
            while (pbb) {
                int from = ctz64(pbb); pbb &= pbb - 1;
                int pc = b.mailbox[from];
                uint64_t atk = (pt == PT_KNIGHT ? KNIGHT_ATK[from] :
                                pt == PT_BISHOP ? bishop_attacks(from, occ) :
                                pt == PT_ROOK   ? rook_attacks(from, occ) :
                                                  queen_attacks(from, occ)) & targets;
                while (atk) {
                    int to = ctz64(atk); atk &= atk - 1;
                    uint32_t tidx = threat_feature_index(pov, ksq, pc, b.mailbox[to], from, to);
                    if (tidx < FT_THREAT_DIM) vec_add_i8_inplace(acc, g_ft_thr_pp + (size_t)tidx * L1_SIZE);
                }
            }
        }

        // PP_3Wide
        uint64_t pw = b.pieces[0], pb = b.pieces[1];
        add_pp_features(acc, pov, ksq, pw | pb, pw, pb, true);

        thr_valid[target_ply][pov] = 1;
        thr_needs_refresh[target_ply][pov] = 0;
    }

    void on_reset(const Board& b) {
        ply = 0;
        memset(psq_valid, 0, sizeof(psq_valid));
        memset(thr_valid, 0, sizeof(thr_valid));
        memset(psq_needs_refresh, 0, sizeof(psq_needs_refresh));
        memset(thr_needs_refresh, 0, sizeof(thr_needs_refresh));
        if (!g_nnue_loaded) return;
        if (!finny_initialized) clear_finny();
        refresh_psq_finny(b, WHITE, 0);
        refresh_psq_finny(b, BLACK, 0);
        refresh_thr_pov(b, WHITE, 0);
        refresh_thr_pov(b, BLACK, 0);
    }

    inline void push_ply_begin(const Board& b) {
        ply++;
        if (ply >= ACC_DEPTH) return;
        psq_valid[ply][0] = psq_valid[ply][1] = 0;
        thr_valid[ply][0] = thr_valid[ply][1] = 0;
        psq_needs_refresh[ply][0] = psq_needs_refresh[ply][1] = 0;
        thr_needs_refresh[ply][0] = thr_needs_refresh[ply][1] = 0;
        dp_sub_cnt[ply] = 0;
        dp_add_cnt[ply] = 0;
        dt_cnt[ply] = 0;
        pp_before[ply][0] = b.pieces[0];
        pp_before[ply][1] = b.pieces[1];
        dp_ksq[ply][0] = b.king_sq[0];
        dp_ksq[ply][1] = b.king_sq[1];
        dp_blk[ply][0] = (uint8_t)b.psq_block(0);
        dp_blk[ply][1] = (uint8_t)b.psq_block(1);
    }

    inline void record_psq_add(uint8_t pc, uint8_t sq) {
        if (ply < ACC_DEPTH && dp_add_cnt[ply] < 2) {
            int i = dp_add_cnt[ply]++;
            dp_add_pc[ply][i] = pc;
            dp_add_sq[ply][i] = sq;
        }
    }

    inline void record_psq_sub(uint8_t pc, uint8_t sq) {
        if (ply < ACC_DEPTH && dp_sub_cnt[ply] < 2) {
            int i = dp_sub_cnt[ply]++;
            dp_sub_pc[ply][i] = pc;
            dp_sub_sq[ply][i] = sq;
        }
    }

    inline void add_dirty_threat(bool add, uint8_t pc, uint8_t tpc, uint8_t sq, uint8_t tsq) {
        if (ply >= ACC_DEPTH) return;
        uint16_t& c = dt_cnt[ply];
        if (c < MAX_DT) {
            dt[ply][c++] = {pc, tpc, sq, tsq, (uint8_t)(add ? 1 : 0)};
        } else {
            thr_needs_refresh[ply][0] = 1;
            thr_needs_refresh[ply][1] = 1;
        }
    }

    inline void push_ply_end(const Board& b) {
        if (ply >= ACC_DEPTH) return;
        pp_after[ply][0] = b.pieces[0];
        pp_after[ply][1] = b.pieces[1];
        for (int pov = 0; pov < 2; ++pov) {
            uint8_t nksq = b.king_sq[pov];
            uint8_t nblk = (uint8_t)b.psq_block(pov);
            if (nksq != dp_ksq[ply][pov]) {
                // PSQ: KingBuckets depends on ksq; Finny handles any ksq change fast
                if (KING_BUCKETS[nksq ^ (56 * pov)] != KING_BUCKETS[dp_ksq[ply][pov] ^ (56 * pov)] ||
                    ORIENT_TBL[nksq] != ORIENT_TBL[dp_ksq[ply][pov]]) {
                    psq_needs_refresh[ply][pov] = 1;
                }
                if (ORIENT_TBL[nksq] != ORIENT_TBL[dp_ksq[ply][pov]]) {
                    thr_needs_refresh[ply][pov] = 1;
                }
            }
            if (nblk != dp_blk[ply][pov]) {
                psq_needs_refresh[ply][pov] = 1;
            }
            dp_ksq[ply][pov] = nksq;
            dp_blk[ply][pov] = nblk;
        }
    }

    void update_piece_threats(const Board& b, int pc, bool putPiece, int s, bool computeRay, uint64_t noRaysContaining) {
        uint64_t occupied = b.occ;
        uint64_t bAttacks = bishop_attacks(s, occupied);
        uint64_t rAttacks = rook_attacks(s, occupied);
        uint64_t sliderAttacks = bAttacks | rAttacks;
        uint64_t occupiedNoK = occupied ^ b.by_pt(PT_KING);
        int pt = pc >> 1;
        uint64_t sliders = (b.by_pt(PT_BISHOP) | b.by_pt(PT_QUEEN)) & bAttacks;
        sliders |= (b.by_pt(PT_ROOK) | b.by_pt(PT_QUEEN)) & rAttacks;

        auto can_slider_threat = [](int tpc, int slider_pc) -> bool {
            return (tpc >> 1) != PT_QUEEN || (slider_pc >> 1) == PT_QUEEN;
        };

        auto process_sliders = [&](bool addDirect) {
            uint64_t sl = sliders;
            while (sl) {
                int sliderSq = ctz64(sl); sl &= sl - 1;
                int slider = b.mailbox[sliderSq];
                uint64_t ray = RAYPASS_BB[sliderSq][s];
                uint64_t discovered = ray & sliderAttacks & occupiedNoK;
                if (discovered && (ray & noRaysContaining) != noRaysContaining) {
                    int threatenedSq = ctz64(discovered);
                    int threatenedPc = b.mailbox[threatenedSq];
                    if (can_slider_threat(threatenedPc, slider)) {
                        add_dirty_threat(!putPiece, (uint8_t)slider, (uint8_t)threatenedPc, (uint8_t)sliderSq, (uint8_t)threatenedSq);
                    }
                }
                if (addDirect && can_slider_threat(pc, slider)) {
                    add_dirty_threat(putPiece, (uint8_t)slider, (uint8_t)pc, (uint8_t)sliderSq, (uint8_t)s);
                }
            }
        };

        if (pt == PT_KING) {
            if (computeRay) process_sliders(false);
            return;
        }

        uint64_t threatTargets = (pt == PT_PAWN)
            ? (b.by_pt(PT_KNIGHT) | b.by_pt(PT_ROOK))
            : (pt == PT_BISHOP || pt == PT_ROOK)
                ? (b.by_pt(PT_PAWN) | b.by_pt(PT_KNIGHT) | b.by_pt(PT_BISHOP) | b.by_pt(PT_ROOK))
                : occupiedNoK;

        uint64_t threatened = ((pt == PT_BISHOP) ? bAttacks :
                               (pt == PT_ROOK)   ? rAttacks :
                               (pt == PT_QUEEN)  ? sliderAttacks :
                               (pt == PT_PAWN)   ? PAWN_ATK[pc & 1][s] :
                                                   KNIGHT_ATK[s]) & threatTargets;

        uint64_t incoming = KNIGHT_ATK[s] & b.by_pt(PT_KNIGHT);
        if (pt == PT_KNIGHT || pt == PT_ROOK) {
            incoming |= (PAWN_ATK[WHITE][s] & b.pieces[1]) | (PAWN_ATK[BLACK][s] & b.pieces[0]);
        }

        while (threatened) {
            int tsq = ctz64(threatened); threatened &= threatened - 1;
            add_dirty_threat(putPiece, (uint8_t)pc, b.mailbox[tsq], (uint8_t)s, (uint8_t)tsq);
        }

        if (computeRay) {
            process_sliders(true);
        } else {
            incoming |= (pt == PT_QUEEN) ? (sliders & b.by_pt(PT_QUEEN)) : sliders;
        }

        while (incoming) {
            int srcSq = ctz64(incoming); incoming &= incoming - 1;
            add_dirty_threat(putPiece, b.mailbox[srcSq], (uint8_t)pc, (uint8_t)srcSq, (uint8_t)s);
        }
    }

    inline void on_unmove() { if (ply > 0) ply--; }

    void on_null_move(const Board& b) {
        ply++;
        if (ply >= ACC_DEPTH) return;
        psq_valid[ply][0] = psq_valid[ply][1] = 0;
        thr_valid[ply][0] = thr_valid[ply][1] = 0;
        psq_needs_refresh[ply][0] = psq_needs_refresh[ply][1] = 0;
        thr_needs_refresh[ply][0] = thr_needs_refresh[ply][1] = 0;
        dp_sub_cnt[ply] = dp_add_cnt[ply] = 0;
        dt_cnt[ply] = 0;
        pp_before[ply][0] = pp_after[ply][0] = b.pieces[0];
        pp_before[ply][1] = pp_after[ply][1] = b.pieces[1];
        dp_ksq[ply][0] = b.king_sq[0];
        dp_ksq[ply][1] = b.king_sq[1];
        dp_blk[ply][0] = (uint8_t)b.psq_block(0);
        dp_blk[ply][1] = (uint8_t)b.psq_block(1);
    }

    inline void on_unnull_move() { if (ply > 0) ply--; }

    void ensure_psq(const Board& b, int pov) {
        int tp = ply;
        if (psq_valid[tp][pov]) return;
        int anc = tp;
        while (anc > 0 && !psq_valid[anc][pov] && !psq_needs_refresh[anc][pov]) anc--;
        if (!psq_valid[anc][pov] || (tp - anc) > 6) {
            refresh_psq_finny(b, pov, tp);
            return;
        }
        for (int p = anc + 1; p <= tp; ++p) {
            int16_t* prev = psq[p - 1][pov];
            int16_t* cur = psq[p][pov];
            memcpy(cur, prev, L1_SIZE * sizeof(int16_t));
            int ksq = dp_ksq[p][pov];
            int blk = dp_blk[p][pov];
            int ac = dp_add_cnt[p], sc = dp_sub_cnt[p];
            int ai = 0, si = 0;
            while (ai < ac && si < sc) {
                uint32_t ia = psq_feature_index(pov, dp_add_pc[p][ai], dp_add_sq[p][ai], ksq, blk);
                uint32_t is = psq_feature_index(pov, dp_sub_pc[p][si], dp_sub_sq[p][si], ksq, blk);
                vec_addsub_i8_inplace(cur, g_ft_psq + (size_t)ia * L1_SIZE, g_ft_psq + (size_t)is * L1_SIZE);
                ai++; si++;
            }
            while (ai < ac) {
                uint32_t ia = psq_feature_index(pov, dp_add_pc[p][ai], dp_add_sq[p][ai], ksq, blk);
                vec_add_i8_inplace(cur, g_ft_psq + (size_t)ia * L1_SIZE);
                ai++;
            }
            while (si < sc) {
                uint32_t is = psq_feature_index(pov, dp_sub_pc[p][si], dp_sub_sq[p][si], ksq, blk);
                vec_sub_i8_inplace(cur, g_ft_psq + (size_t)is * L1_SIZE);
                si++;
            }
            psq_valid[p][pov] = 1;
        }
    }

    void ensure_thr(const Board& b, int pov) {
        int tp = ply;
        if (thr_valid[tp][pov]) return;
        int anc = tp;
        while (anc > 0 && !thr_valid[anc][pov] && !thr_needs_refresh[anc][pov]) anc--;
        if (!thr_valid[anc][pov] || (tp - anc) > 4) {
            refresh_thr_pov(b, pov, tp);
            return;
        }
        for (int p = anc + 1; p <= tp; ++p) {
            int16_t* prev = thr[p - 1][pov];
            int16_t* cur = thr[p][pov];
            memcpy(cur, prev, L1_SIZE * sizeof(int16_t));
            int ksq = dp_ksq[p][pov];
            uint16_t n = dt_cnt[p];
            for (uint16_t i = 0; i < n; ++i) {
                const DirtyThreat& d = dt[p][i];
                uint32_t tidx = threat_feature_index(pov, ksq, d.pc, d.tpc, d.sq, d.tsq);
                if (tidx < FT_THREAT_DIM) {
                    const int8_t* w = g_ft_thr_pp + (size_t)tidx * L1_SIZE;
                    if (d.add) vec_add_i8_inplace(cur, w);
                    else       vec_sub_i8_inplace(cur, w);
                }
            }
            uint64_t bw = pp_before[p][0], bb = pp_before[p][1];
            uint64_t aw = pp_after[p][0],  ab = pp_after[p][1];
            if (bw != aw || bb != ab) {
                add_pp_features(cur, pov, ksq, (aw & ~bw) | (ab & ~bb), aw, ab, true);
                add_pp_features(cur, pov, ksq, (bw & ~aw) | (bb & ~ab), bw, bb, false);
            }
            thr_valid[p][pov] = 1;
        }
    }

    int forward_raw(const Board& b) {
        ensure_psq(b, WHITE);
        ensure_psq(b, BLACK);
        ensure_thr(b, WHITE);
        ensure_thr(b, BLACK);

        int stm = b.turn;
        for (int side = 0; side < 2; ++side) {
            int c = (side == 0) ? stm : (stm ^ 1);
            const int16_t* p_acc = psq[ply][c];
            const int16_t* t_acc = thr[ply][c];
            uint8_t* dst = ft_out + side * L1_HALF;
#ifdef __wasm_simd128__
            const v128_t vzero = wasm_i16x8_splat(0);
            const v128_t vmax = wasm_i16x8_splat(FT_MAX_VAL);
            for (int i = 0; i < L1_HALF; i += 8) {
                v128_t l = wasm_i16x8_add(wasm_v128_load(p_acc + i), wasm_v128_load(t_acc + i));
                v128_t r = wasm_i16x8_add(wasm_v128_load(p_acc + L1_HALF + i), wasm_v128_load(t_acc + L1_HALF + i));
                l = wasm_i16x8_min(wasm_i16x8_max(l, vzero), vmax);
                r = wasm_i16x8_min(wasm_i16x8_max(r, vzero), vmax);
                v128_t prod = wasm_u16x8_shr(wasm_i16x8_mul(l, r), 9);
                v128_t packed = wasm_u8x16_narrow_i16x8(prod, vzero);
                *(uint64_t*)(dst + i) = (uint64_t)wasm_u64x2_extract_lane(packed, 0);
            }
#else
            for (int i = 0; i < L1_HALF; ++i) {
                int s0 = clamp_i((int)p_acc[i] + (int)t_acc[i], 0, FT_MAX_VAL);
                int s1 = clamp_i((int)p_acc[i + L1_HALF] + (int)t_acc[i + L1_HALF], 0, FT_MAX_VAL);
                dst[i] = (uint8_t)(((uint32_t)s0 * (uint32_t)s1) >> 9);
            }
#endif
        }

        // Layer stack lookup
        int band = (popcnt64(b.occ) - 1) / 4;
        int queens = 2 * (int)((b.pieces[(PT_QUEEN << 1) | stm]) != 0ULL)
                       + (int)((b.pieces[(PT_QUEEN << 1) | (stm ^ 1)]) != 0ULL);
        static constexpr uint64_t QUEEN_SIDE = 0x0F0F0F0F0F0F0F0FULL;
        uint64_t pawns = b.by_pt(PT_PAWN);
        int layout = !pawns ? 2 : ((pawns & QUEEN_SIDE) && (pawns & ~QUEEN_SIDE)) ? 0 : 1;
        int nw = popcnt64(b.colors[WHITE] & ~(b.by_pt(PT_PAWN) | b.by_pt(PT_KING)));
        int nb = popcnt64(b.colors[BLACK] & ~(b.by_pt(PT_PAWN) | b.by_pt(PT_KING)));
        int many = max_i(nw, nb) >= 2 ? 1 : 0;
        int bucket = g_layer_stack_index[((band * 4 + queens) * 3 + layout) * 2 + many];
        const UnpackedLayerStack& L = g_layer_stacks[bucket];

        // FC0: 1024 uint8 -> 32 int32 (sparse 4-byte chunk dot product)
        const uint32_t* ft32 = (const uint32_t*)ft_out;
        alignas(16) int32_t fc0_out[L2_SIZE];
        memcpy(fc0_out, L.fc0_b, sizeof(fc0_out));

#ifdef __wasm_simd128__
        for (int idx = 0; idx < L1_SIZE / 4; ++idx) {
            uint32_t chunk = ft32[idx];
            if (!chunk) continue;
            v128_t c8 = wasm_u32x4_splat(chunk);
            v128_t vc_lo = wasm_u16x8_extend_low_u8x16(c8);
            const int8_t (*w)[4] = L.fc0_w_t[idx];
            for (int r = 0; r < L2_SIZE; r += 4) {
                v128_t w01 = wasm_i16x8_load8x8(&w[r][0]);
                v128_t w23 = wasm_i16x8_load8x8(&w[r + 2][0]);
                v128_t p01 = wasm_i32x4_dot_i16x8(vc_lo, w01);
                v128_t p23 = wasm_i32x4_dot_i16x8(vc_lo, w23);
                // p01 = [d0a, d0b, d1a, d1b], p23 = [d2a, d2b, d3a, d3b]
                v128_t even = wasm_i32x4_shuffle(p01, p23, 0, 2, 4, 6);
                v128_t odd  = wasm_i32x4_shuffle(p01, p23, 1, 3, 5, 7);
                v128_t acc = wasm_v128_load(fc0_out + r);
                wasm_v128_store(fc0_out + r, wasm_i32x4_add(acc, wasm_i32x4_add(even, odd)));
            }
        }
#else
        for (int idx = 0; idx < L1_SIZE / 4; ++idx) {
            uint32_t chunk = ft32[idx];
            if (!chunk) continue;
            int u0 = (int)(chunk & 255U);
            int u1 = (int)((chunk >> 8) & 255U);
            int u2 = (int)((chunk >> 16) & 255U);
            int u3 = (int)((chunk >> 24) & 255U);
            const int8_t (* __restrict__ w)[4] = L.fc0_w_t[idx];
            for (int r = 0; r < L2_SIZE; ++r) {
                fc0_out[r] += u0 * w[r][0] + u1 * w[r][1] + u2 * w[r][2] + u3 * w[r][3];
            }
        }
#endif

        alignas(16) uint8_t concat[128];
        for (int i = 0; i < L2_SIZE; ++i) {
            int64_t x = (int64_t)fc0_out[i];
            int sqr = (int)((x * x) >> (2 * (WEIGHT_SCALE_BITS + 1) + 7));
            concat[i] = (uint8_t)min_i(127, sqr);
            concat[L2_SIZE + i] = (uint8_t)clamp_i(fc0_out[i] >> (WEIGHT_SCALE_BITS + 1), 0, 127);
        }

        // FC1: 64 uint8 -> 32 int32
        const uint32_t* c32 = (const uint32_t*)concat;
        alignas(16) int32_t fc1_out[L3_SIZE];
        memcpy(fc1_out, L.fc1_b, sizeof(fc1_out));
        for (int idx = 0; idx < 16; ++idx) {
            uint32_t chunk = c32[idx];
            if (!chunk) continue;
#ifdef __wasm_simd128__
            v128_t c8 = wasm_u32x4_splat(chunk);
            v128_t vc_lo = wasm_u16x8_extend_low_u8x16(c8);
            const int8_t (*w)[4] = L.fc1_w_t[idx];
            for (int r = 0; r < L3_SIZE; r += 4) {
                v128_t w01 = wasm_i16x8_load8x8(&w[r][0]);
                v128_t w23 = wasm_i16x8_load8x8(&w[r + 2][0]);
                v128_t p01 = wasm_i32x4_dot_i16x8(vc_lo, w01);
                v128_t p23 = wasm_i32x4_dot_i16x8(vc_lo, w23);
                v128_t even = wasm_i32x4_shuffle(p01, p23, 0, 2, 4, 6);
                v128_t odd  = wasm_i32x4_shuffle(p01, p23, 1, 3, 5, 7);
                v128_t acc = wasm_v128_load(fc1_out + r);
                wasm_v128_store(fc1_out + r, wasm_i32x4_add(acc, wasm_i32x4_add(even, odd)));
            }
#else
            int u0 = (int)(chunk & 255U);
            int u1 = (int)((chunk >> 8) & 255U);
            int u2 = (int)((chunk >> 16) & 255U);
            int u3 = (int)((chunk >> 24) & 255U);
            const int8_t (* __restrict__ w)[4] = L.fc1_w_t[idx];
            for (int r = 0; r < L3_SIZE; ++r) {
                fc1_out[r] += u0 * w[r][0] + u1 * w[r][1] + u2 * w[r][2] + u3 * w[r][3];
            }
#endif
        }

        for (int i = 0; i < L3_SIZE; ++i) {
            int64_t x = (int64_t)fc1_out[i];
            int sqr = (int)((x * x) >> (2 * WEIGHT_SCALE_BITS + 7));
            concat[64 + i] = (uint8_t)min_i(127, sqr);
            concat[96 + i] = (uint8_t)clamp_i(fc1_out[i] >> WEIGHT_SCALE_BITS, 0, 127);
        }

        int32_t fwdOut = L.fc2_b[0];
        for (int j = 0; j < 128; ++j) fwdOut += (int32_t)concat[j] * (int32_t)L.fc2_w[j];
        fwdOut += fc0_out[L2_SIZE - 2] - fc0_out[L2_SIZE - 1];

        int32_t positional = (int32_t)(((int64_t)fwdOut * (600 * OUTPUT_SCALE)) /
                                       ((int64_t)HIDDEN_ONE_VAL * (1 << WEIGHT_SCALE_BITS) * 2));
        return positional / OUTPUT_SCALE;
    }

    static inline int to_cp(int v, const Board& b) {
        int pawns   = popcnt64(b.by_pt(PT_PAWN));
        int knights = popcnt64(b.by_pt(PT_KNIGHT));
        int bishops = popcnt64(b.by_pt(PT_BISHOP));
        int rooks   = popcnt64(b.by_pt(PT_ROOK));
        int queens  = popcnt64(b.by_pt(PT_QUEEN));
        int mat = clamp_i(pawns + 3 * knights + 3 * bishops + 5 * rooks + 9 * queens, 17, 78);
        double m = (double)mat / 58.0;
        double a = (((-142.72052667 * m + 372.35176398) * m - 340.71073572) * m) + 415.23490212;
        double res = 100.0 * (double)v / a;
        return (int)(res >= 0.0 ? (res + 0.5) : (res - 0.5));
    }

    static inline int evaluate_scaled(int nnue, const Board& b) {
        int us = b.turn, them = us ^ 1;
        auto npm = [&](int c) -> int {
            return 781 * popcnt64(b.pieces[(PT_KNIGHT << 1) | c])
                 + 825 * popcnt64(b.pieces[(PT_BISHOP << 1) | c])
                 + 1276 * popcnt64(b.pieces[(PT_ROOK << 1) | c])
                 + 2538 * popcnt64(b.pieces[(PT_QUEEN << 1) | c]);
        };
        int se = 208 * (popcnt64(b.pieces[(PT_PAWN << 1) | us]) - popcnt64(b.pieces[(PT_PAWN << 1) | them]))
               + npm(us) - npm(them);
        int se_norm = (se * 1024) / (abs_i(se) + 1024);
        int nn_norm = (nnue * 1024) / (abs_i(nnue) + 1024);
        int correl = (se_norm * nn_norm) / 512;
        int v = nnue + (nnue * correl) / 65536;
        int mat = 521 * popcnt64(b.by_pt(PT_PAWN)) + npm(WHITE) + npm(BLACK);
        v += (int)(((int64_t)mat * v) / 90649);
        v -= (v * (int)b.halfmove) / 189;
        return v;
    }

    int evaluate_cp(const Board& b) {
        if (!g_nnue_loaded) return 0;
        int nnue = forward_raw(b);
        int scaled = evaluate_scaled(nnue, b);
        return to_cp(scaled, b);
    }
};

// ----------------------------------------------------------------------------
// Make / Unmake Move with Exact Stockfish-Parity NNUE Deltas
// ----------------------------------------------------------------------------
static bool make_move(Board& b, uint16_t move, SfNnue* nnue) {
    int from = mv_from(move), to = mv_to(move), mtype = mv_type(move), promo = mv_promo(move);
    uint8_t moved = b.mailbox[from];
    int us = b.turn, them = us ^ 1;
    uint8_t captured = EMPTY_SQ;
    if (mtype == MT_EN_PASSANT) {
        captured = b.mailbox[us == WHITE ? to - 8 : to + 8];
    } else if (mtype != MT_CASTLING && b.mailbox[to] != EMPTY_SQ) {
        captured = b.mailbox[to];
    }

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

    if (nnue) nnue->push_ply_begin(b);

    if (b.ep_sq >= 0) {
        b.hash ^= ZOBRIST_EP[b.ep_sq & 7];
        b.ep_sq = -1;
    }

    if ((moved >> 1) == PT_PAWN || captured != EMPTY_SQ) b.halfmove = 0;
    else b.halfmove++;

    if (mtype == MT_CASTLING) {
        int rfrom = (to > from) ? (us == WHITE ? 7 : 63) : (us == WHITE ? 0 : 56);
        int rto   = (to > from) ? (us == WHITE ? 5 : 61) : (us == WHITE ? 3 : 59);
        int rook_pc = (PT_ROOK << 1) | us;
        if (nnue) {
            nnue->update_piece_threats(b, moved, false, from, true, ~0ULL);
            nnue->record_psq_sub(moved, (uint8_t)from);
            b.remove_piece(moved, from);

            nnue->update_piece_threats(b, rook_pc, false, rfrom, true, ~0ULL);
            nnue->record_psq_sub((uint8_t)rook_pc, (uint8_t)rfrom);
            b.remove_piece(rook_pc, rfrom);

            b.put_piece(moved, to);
            nnue->record_psq_add(moved, (uint8_t)to);
            nnue->update_piece_threats(b, moved, true, to, true, ~0ULL);

            b.put_piece(rook_pc, rto);
            nnue->record_psq_add((uint8_t)rook_pc, (uint8_t)rto);
            nnue->update_piece_threats(b, rook_pc, true, rto, true, ~0ULL);
        } else {
            b.move_piece(moved, from, to);
            b.move_piece(rook_pc, rfrom, rto);
        }
        b.king_sq[us] = (uint8_t)to;
    } else if (mtype == MT_EN_PASSANT) {
        int capsq = us == WHITE ? to - 8 : to + 8;
        if (nnue) {
            nnue->update_piece_threats(b, captured, false, capsq, true, ~0ULL);
            nnue->record_psq_sub(captured, (uint8_t)capsq);
            b.remove_piece(captured, capsq);

            uint64_t fromTo = (1ULL << from) | (1ULL << to);
            nnue->update_piece_threats(b, moved, false, from, true, fromTo);
            nnue->record_psq_sub(moved, (uint8_t)from);
            b.move_piece(moved, from, to);
            nnue->record_psq_add(moved, (uint8_t)to);
            nnue->update_piece_threats(b, moved, true, to, true, fromTo);
        } else {
            b.remove_piece(captured, capsq);
            b.move_piece(moved, from, to);
        }
    } else if (captured != EMPTY_SQ) {
        int to_pc = (promo > 0) ? ((promo << 1) | us) : moved;
        if (nnue) {
            nnue->update_piece_threats(b, moved, false, from, true, ~0ULL);
            nnue->record_psq_sub(moved, (uint8_t)from);
            b.remove_piece(moved, from);

            nnue->update_piece_threats(b, captured, false, to, false, ~0ULL);
            nnue->record_psq_sub(captured, (uint8_t)to);
            b.remove_piece(captured, to);

            b.put_piece(to_pc, to);
            nnue->record_psq_add((uint8_t)to_pc, (uint8_t)to);
            nnue->update_piece_threats(b, to_pc, true, to, false, ~0ULL);
        } else {
            b.remove_piece(captured, to);
            if (promo > 0) { b.remove_piece(moved, from); b.put_piece(to_pc, to); }
            else b.move_piece(moved, from, to);
        }
        if ((moved >> 1) == PT_KING) b.king_sq[us] = (uint8_t)to;
    } else if (promo > 0) {
        int to_pc = (promo << 1) | us;
        if (nnue) {
            nnue->update_piece_threats(b, moved, false, from, true, ~0ULL);
            nnue->record_psq_sub(moved, (uint8_t)from);
            b.remove_piece(moved, from);

            b.put_piece(to_pc, to);
            nnue->record_psq_add((uint8_t)to_pc, (uint8_t)to);
            nnue->update_piece_threats(b, to_pc, true, to, true, ~0ULL);
        } else {
            b.remove_piece(moved, from);
            b.put_piece(to_pc, to);
        }
    } else {
        // Quiet normal move
        if (nnue) {
            uint64_t fromTo = (1ULL << from) | (1ULL << to);
            nnue->update_piece_threats(b, moved, false, from, true, fromTo);
            nnue->record_psq_sub(moved, (uint8_t)from);
            b.move_piece(moved, from, to);
            nnue->record_psq_add(moved, (uint8_t)to);
            nnue->update_piece_threats(b, moved, true, to, true, fromTo);
        } else {
            b.move_piece(moved, from, to);
        }
        if ((moved >> 1) == PT_KING) b.king_sq[us] = (uint8_t)to;
    }

    if ((moved >> 1) == PT_PAWN && abs_i(to - from) == 16) {
        b.ep_sq = (int8_t)(us == WHITE ? to - 8 : to + 8);
        b.hash ^= ZOBRIST_EP[b.ep_sq & 7];
    }

    uint8_t new_cast = b.castling & CASTLE_MASK[from] & CASTLE_MASK[to];
    if (new_cast != b.castling) {
        b.hash ^= ZOBRIST_CASTLE[b.castling] ^ ZOBRIST_CASTLE[new_cast];
        b.castling = new_cast;
    }

    b.turn = them;
    b.hash ^= ZOBRIST_SIDE;
    if (us == BLACK) b.fullmove++;

    if (nnue) nnue->push_ply_end(b);

    if (b.is_attacked(b.king_sq[us], them)) {
        if (nnue) nnue->on_unmove();
        b.undo_top--;
        if (mtype == MT_CASTLING) {
            int rfrom = (to > from) ? (us == WHITE ? 7 : 63) : (us == WHITE ? 0 : 56);
            int rto   = (to > from) ? (us == WHITE ? 5 : 61) : (us == WHITE ? 3 : 59);
            b.move_piece((PT_ROOK << 1) | us, rto, rfrom);
            b.move_piece(moved, to, from);
            b.king_sq[us] = (uint8_t)from;
        } else {
            if (promo > 0) {
                b.remove_piece((promo << 1) | us, to);
                b.put_piece(moved, from);
            } else {
                b.move_piece(moved, to, from);
                if ((moved >> 1) == PT_KING) b.king_sq[us] = (uint8_t)from;
            }
            if (mtype == MT_EN_PASSANT) b.put_piece(captured, us == WHITE ? to - 8 : to + 8);
            else if (captured != EMPTY_SQ) b.put_piece(captured, to);
        }
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

static void unmake_move(Board& b, SfNnue* nnue) {
    if (nnue) nnue->on_unmove();
    if (b.rep_len > 0) b.rep_len--;
    const UndoInfo& u = b.undo[--b.undo_top];
    uint16_t move = u.move;
    int from = mv_from(move), to = mv_to(move), mtype = mv_type(move), promo = mv_promo(move);
    int them = b.turn, us = them ^ 1;
    b.turn = us;
    if (us == BLACK) b.fullmove--;

    if (mtype == MT_CASTLING) {
        int rfrom = (to > from) ? (us == WHITE ? 7 : 63) : (us == WHITE ? 0 : 56);
        int rto   = (to > from) ? (us == WHITE ? 5 : 61) : (us == WHITE ? 3 : 59);
        b.move_piece((PT_ROOK << 1) | us, rto, rfrom);
        b.move_piece(u.moved, to, from);
        b.king_sq[us] = (uint8_t)from;
    } else {
        if (promo > 0) {
            b.remove_piece((promo << 1) | us, to);
            b.put_piece(u.moved, from);
        } else {
            b.move_piece(u.moved, to, from);
            if ((u.moved >> 1) == PT_KING) b.king_sq[us] = (uint8_t)from;
        }
        if (mtype == MT_EN_PASSANT) b.put_piece(u.captured, us == WHITE ? to - 8 : to + 8);
        else if (u.captured != EMPTY_SQ) b.put_piece(u.captured, to);
    }

    b.castling = u.castling;
    b.ep_sq = u.ep_sq;
    b.halfmove = u.halfmove;
    b.hash = u.hash;
    b.pawn_key = u.pawn_key;
    b.nonpawn_key = u.nonpawn_key;
}

static void make_null_move(Board& b, SfNnue* nnue) {
    if (nnue) nnue->on_null_move(b);
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

static void unmake_null_move(Board& b, SfNnue* nnue) {
    if (nnue) nnue->on_unnull_move();
    if (b.rep_len > 0) b.rep_len--;
    const UndoInfo& u = b.undo[--b.undo_top];
    b.ep_sq = u.ep_sq;
    b.halfmove = u.halfmove;
    b.hash = u.hash;
    b.turn ^= 1;
}

// ----------------------------------------------------------------------------
// 4-Way Clustered Lockless Transposition Table (64 bytes/cluster = cache line)
// ----------------------------------------------------------------------------
enum { TT_NONE = 0, TT_UPPER = 1, TT_LOWER = 2, TT_EXACT = 3 };

struct TTEntry {
    uint64_t key_xor_data;
    uint64_t data;
};

struct alignas(64) TTCluster {
    TTEntry slot[4];
};

static inline uint64_t pack_tt_data(uint16_t move, int16_t score, int16_t eval,
                                    int depth, int bound, bool was_pv, uint8_t age) {
    uint8_t dep8 = (uint8_t)clamp_i(depth + 8, 0, 255);
    return (uint64_t)move
         | ((uint64_t)(uint16_t)score << 16)
         | ((uint64_t)(uint16_t)eval  << 32)
         | ((uint64_t)dep8            << 48)
         | ((uint64_t)(bound & 3)     << 56)
         | ((uint64_t)(was_pv ? 1 : 0)<< 58)
         | ((uint64_t)(age & 31)      << 59);
}

static inline void unpack_tt_data(uint64_t d, uint16_t& move, int16_t& score, int16_t& eval,
                                  int& depth, int& bound, bool& was_pv, uint8_t& age) {
    move   = (uint16_t)(d & 0xFFFFULL);
    score  = (int16_t)((d >> 16) & 0xFFFFULL);
    eval   = (int16_t)((d >> 32) & 0xFFFFULL);
    depth  = (int)((d >> 48) & 0xFFULL) - 8;
    bound  = (int)((d >> 56) & 3ULL);
    was_pv = ((d >> 58) & 1ULL) != 0;
    age    = (uint8_t)((d >> 59) & 31ULL);
}

#ifdef BERSERKER_NATIVE
static std::vector<TTCluster> g_tt_vec;
static TTCluster* g_tt = nullptr;
static size_t g_tt_mask = 0;
static int g_hash_mb = 64;

static void resize_tt_mb(int mb) {
    mb = clamp_i(mb, 16, 2048);
    g_hash_mb = mb;
    size_t target_bytes = (size_t)mb * 1024ULL * 1024ULL;
    size_t n_clusters = 1;
    while ((n_clusters << 1) * sizeof(TTCluster) <= target_bytes) n_clusters <<= 1;
    g_tt_vec.assign(n_clusters, TTCluster{});
    g_tt = g_tt_vec.data();
    g_tt_mask = n_clusters - 1;
}

static inline void clear_tt() {
    if (!g_tt_vec.empty()) memset(g_tt_vec.data(), 0, g_tt_vec.size() * sizeof(TTCluster));
}
#else
static constexpr size_t WASM_TT_CLUSTERS = 1ULL << 20; // 1M clusters * 64B = 64 MB
static TTCluster g_tt[WASM_TT_CLUSTERS];
static constexpr size_t g_tt_mask = WASM_TT_CLUSTERS - 1;
[[maybe_unused]] static int g_hash_mb = 64;

static inline void clear_tt() {
    memset(g_tt, 0, sizeof(g_tt));
}
#endif

static uint8_t g_tt_age = 1;

static inline bool tt_probe(uint64_t key, uint16_t& move, int& score, int16_t& eval,
                            int& depth, int& bound, bool& was_pv) {
    const TTCluster& cl = g_tt[key & g_tt_mask];
    for (int i = 0; i < 4; ++i) {
        uint64_t d = cl.slot[i].data;
        uint64_t k = cl.slot[i].key_xor_data ^ d;
        if (k == key && ((d >> 56) & 3ULL) != TT_NONE) {
            uint8_t age;
            int16_t sc16;
            unpack_tt_data(d, move, sc16, eval, depth, bound, was_pv, age);
            score = (int)sc16;
            return true;
        }
    }
    return false;
}

static inline void tt_store(uint64_t key, int depth, int score, int bound, uint16_t move,
                            int16_t eval, bool was_pv) {
    TTCluster& cl = g_tt[key & g_tt_mask];
    int replace_idx = 0;
    int worst_quality = 1 << 29;
    uint16_t preserved_move = 0;

    for (int i = 0; i < 4; ++i) {
        uint64_t d = cl.slot[i].data;
        uint64_t k = cl.slot[i].key_xor_data ^ d;
        int b = (int)((d >> 56) & 3ULL);
        if (b == TT_NONE || k == key) {
            uint16_t old_m = (uint16_t)(d & 0xFFFFULL);
            uint8_t old_dep = (uint8_t)((d >> 48) & 0xFFULL);
            uint8_t old_age = (uint8_t)((d >> 59) & 31ULL);
            if (k == key && b != TT_NONE && move == 0) preserved_move = old_m;
            // Don't overwrite significantly deeper exact/same-age entry with very shallow upper bound
            if (k == key && b == TT_EXACT && bound != TT_EXACT && old_age == g_tt_age &&
                (int)old_dep - 8 > depth + 3) {
                return;
            }
            replace_idx = i;
            break;
        }
        int entry_dep = (int)((d >> 48) & 0xFFULL) - 8;
        uint8_t entry_age = (uint8_t)((d >> 59) & 31ULL);
        int age_diff = ((int)g_tt_age - (int)entry_age + 32) & 31;
        int quality = entry_dep - age_diff * 4 + (b == TT_EXACT ? 2 : 0);
        if (quality < worst_quality) {
            worst_quality = quality;
            replace_idx = i;
        }
    }

    uint16_t final_move = move ? move : preserved_move;
    uint64_t nd = pack_tt_data(final_move, (int16_t)clamp_i(score, -30000, 30000),
                               eval, depth, bound, was_pv, g_tt_age);
    cl.slot[replace_idx].key_xor_data = key ^ nd;
    cl.slot[replace_idx].data = nd;
}

static inline int tt_hashfull() {
#ifdef BERSERKER_NATIVE
    if (!g_tt) return 0;
#endif
    int used = 0;
    int sample_clusters = min_i(250, (int)g_tt_mask + 1);
    for (int i = 0; i < sample_clusters; ++i) {
        const TTCluster& cl = g_tt[i];
        for (int j = 0; j < 4; ++j) {
            uint64_t d = cl.slot[j].data;
            int b = (int)((d >> 56) & 3ULL);
            uint8_t a = (uint8_t)((d >> 59) & 31ULL);
            if (b != TT_NONE && a == g_tt_age) used++;
        }
    }
    return min_i(1000, (used * 1000) / (sample_clusters * 4));
}

// ----------------------------------------------------------------------------
// Per-Thread Search Worker & Shared Control
// ----------------------------------------------------------------------------
struct RootMove {
    uint16_t move;
    int score;
    int prev_score;
    int pv_len;
    uint16_t pv[MAX_PLY];
};

struct SearchConfig {
    double start_ms;
    double max_time_ms;
    bool infinite;
    int target_depth;
    int completed_best_move;
    int completed_score;
    int completed_depth;
    uint16_t completed_pv[MAX_PLY];
    int completed_pv_len;
    uint16_t last_root_move;
    int stable_count;
    int current_depth;
    bool active;
};

static int g_multipv = 1;
static int g_contempt = 0;
[[maybe_unused]] static int g_threads = 1;
static SearchConfig g_sc;

#ifdef BERSERKER_NATIVE
static std::atomic<bool> g_stop_requested{false};
#else
static volatile bool g_stop_requested = false;
#endif

struct SearchWorker {
    int thread_id;
    Board board;
    SfNnue nnue;

    uint16_t killers[MAX_PLY][2];
    int32_t history[2][64][64];
    uint16_t countermoves[2][64][64];
    int16_t conthist[12 * 64][12 * 64];
    int16_t cap_hist[12][64][6];
    int16_t pawn_corr[2][16384];
    int16_t nonpawn_corr[2][16384];

    int moved_piece[MAX_PLY];
    int move_to[MAX_PLY];
    int eval_stack[MAX_PLY];
    uint16_t pv_table[MAX_PLY][MAX_PLY];
    int pv_len[MAX_PLY];
    int double_exts[MAX_PLY];
    int nmp_min_ply;

    RootMove root_moves[MAX_MOVES];
    int root_cnt;

    uint64_t nodes;
    uint64_t qnodes;
    int seldepth;
    bool aborted;

    void clear_heuristics() {
        memset(killers, 0, sizeof(killers));
        memset(history, 0, sizeof(history));
        memset(countermoves, 0, sizeof(countermoves));
        memset(conthist, 0, sizeof(conthist));
        memset(cap_hist, 0, sizeof(cap_hist));
        memset(pawn_corr, 0, sizeof(pawn_corr));
        memset(nonpawn_corr, 0, sizeof(nonpawn_corr));
        nmp_min_ply = 0;
    }

    inline bool check_abort() {
        if (aborted) return true;
        if ((nodes & 1023ULL) == 0ULL) {
#ifdef BERSERKER_NATIVE
            if (g_stop_requested.load(std::memory_order_relaxed)) {
#else
            if (g_stop_requested) {
#endif
                aborted = true;
                return true;
            }
            if (!g_sc.infinite && g_sc.completed_depth >= 1 && (now_ms() - g_sc.start_ms) >= g_sc.max_time_ms) {
                aborted = true;
                return true;
            }
        }
        return false;
    }

    inline int raw_eval_node() {
        return nnue.evaluate_cp(board);
    }

    inline int adjust_eval_with_corr(int raw_cp) const {
        int us = board.turn;
        int pidx = (int)(board.pawn_key & 16383ULL);
        int npidx = (int)(board.nonpawn_key & 16383ULL);
        int corr = (pawn_corr[us][pidx] * 2 + nonpawn_corr[us][npidx]) / 64;
        int v = raw_cp + corr;
        if (g_contempt != 0) {
            v += (us == WHITE ? g_contempt : -g_contempt) / 4;
        }
        if (board.halfmove > 20) {
            v = (v * (200 - (int)board.halfmove)) / 200;
        }
        return clamp_i(v, -MATE_BOUND + 1, MATE_BOUND - 1);
    }

    inline void update_quiet_hist(int c, int from, int to, int bonus) {
        int clamped = clamp_i(bonus, -16384, 16384);
        int32_t& h = history[c][from][to];
        h += clamped - (h * abs_i(clamped)) / 16384;
    }

    inline void update_cont_hist(int prev_idx, int curr_idx, int bonus) {
        int clamped = clamp_i(bonus, -16384, 16384);
        int16_t& h = conthist[prev_idx][curr_idx];
        h = (int16_t)(h + clamped - (h * abs_i(clamped)) / 16384);
    }

    inline void update_cap_hist(int moved_pc, int to, int cap_pt, int bonus) {
        int clamped = clamp_i(bonus, -16384, 16384);
        int16_t& h = cap_hist[moved_pc][to][cap_pt];
        h = (int16_t)(h + clamped - (h * abs_i(clamped)) / 16384);
    }

    int score_move(uint16_t move, uint16_t tt_move, int ply, int p1, int t1, int p2, int t2) const {
        if (move == tt_move && tt_move != 0) return 2000000;
        int from = mv_from(move), to = mv_to(move), mtype = mv_type(move), promo = mv_promo(move);
        uint8_t piece = board.mailbox[from];
        int captured = (mtype == MT_EN_PASSANT) ? PT_PAWN
                     : (mtype != MT_CASTLING && board.mailbox[to] != EMPTY_SQ) ? (board.mailbox[to] >> 1) : -1;

        if (captured >= 0 || promo == PT_QUEEN) {
            int vval = captured >= 0 ? SEE_VALUES[captured] : 0;
            int apt = piece >> 1;
            int ch = cap_hist[piece][to][captured >= 0 ? captured : 0];
            bool good = (promo == PT_QUEEN) || (vval >= SEE_VALUES[apt]) || (board.static_exchange_eval(move) >= 0);
            return (good ? 400000 : -200000) + vval * 16 - apt + (promo == PT_QUEEN ? 9000 : 0) + ch;
        }

        if (ply < MAX_PLY) {
            if (killers[ply][0] == move) return 300000;
            if (killers[ply][1] == move) return 280000;
        }

        int c = board.turn;
        if (t1 >= 0 && countermoves[c][t1][to] == move) return 250000;

        int sc = history[c][from][to];
        int cidx = piece * 64 + to;
        if (p1 >= 0) sc += conthist[p1 * 64 + t1][cidx];
        if (p2 >= 0) sc += conthist[p2 * 64 + t2][cidx] >> 1;
        return sc;
    }

    int quiescence(int alpha, int beta, int ply, int qdepth, bool is_pv) {
        nodes++;
        qnodes++;
        if (ply > seldepth) seldepth = ply;
        if (check_abort()) return alpha;
        if (board.is_draw(ply)) return 0;

        bool in_check = board.in_check();
        if (ply >= MAX_PLY - 2 || qdepth >= 12) {
            return in_check ? 0 : adjust_eval_with_corr(raw_eval_node());
        }

        int qs_depth = in_check ? 0 : -1;
        uint16_t tt_move = 0;
        int tt_score = 0, tt_depth = -10, tt_bound = TT_NONE;
        int16_t tt_eval = VALUE_NONE;
        bool tt_was_pv = false;
        bool tt_hit = tt_probe(board.hash, tt_move, tt_score, tt_eval, tt_depth, tt_bound, tt_was_pv);
        if (tt_hit) {
            if (tt_score >= MATE_BOUND) tt_score -= ply;
            else if (tt_score <= -MATE_BOUND) tt_score += ply;
            if (!is_pv && tt_depth >= qs_depth) {
                if (tt_bound == TT_EXACT) return tt_score;
                if (tt_bound == TT_LOWER && tt_score >= beta) return tt_score;
                if (tt_bound == TT_UPPER && tt_score <= alpha) return tt_score;
            }
        }

        int orig_alpha = alpha;
        int best = -INF_SCORE;
        int stand_pat = -INF_SCORE;
        int futility_base = -INF_SCORE;
        int16_t stored_raw_eval = tt_eval;

        if (!in_check) {
            if (tt_hit && tt_eval != VALUE_NONE) {
                stand_pat = adjust_eval_with_corr((int)tt_eval);
            } else {
                int raw = raw_eval_node();
                stored_raw_eval = (int16_t)clamp_i(raw, -20000, 20000);
                stand_pat = adjust_eval_with_corr(raw);
            }
            if (stand_pat >= beta) {
                if (!tt_hit) tt_store(board.hash, qs_depth, stand_pat, TT_LOWER, 0, stored_raw_eval, is_pv);
                return stand_pat;
            }
            if (stand_pat > alpha) alpha = stand_pat;
            best = stand_pat;
            futility_base = stand_pat + 160;
        }

        // In check: generate all moves for evasions; at qdepth == 0: generate all moves so checks are inspected cleanly
        bool caps_only = !in_check && (qdepth > 0);
        int count = board.gen_pseudo(ply, caps_only);
        uint16_t* list = board.move_list[ply];
        int* scores = board.move_scores[ply];
        bool has_np = board.has_non_pawn(board.turn ^ 1);

        for (int i = 0; i < count; ++i) {
            uint16_t m = list[i];
            if (m == tt_move && tt_move != 0) { scores[i] = 2000000; continue; }
            int mtype = mv_type(m), to = mv_to(m), promo = mv_promo(m);
            bool is_cap = (mtype == MT_EN_PASSANT) || (mtype != MT_CASTLING && board.mailbox[to] != EMPTY_SQ);
            if (!in_check) {
                if (!is_cap && promo != PT_QUEEN) {
                    if (qdepth == 0 && board.gives_check(m)) {
                        scores[i] = 50000 + history[board.turn][mv_from(m)][to];
                    } else {
                        scores[i] = -1000000;
                    }
                    continue;
                }
                int victim = (mtype == MT_EN_PASSANT) ? PT_PAWN : (is_cap ? (board.mailbox[to] >> 1) : -1);
                int atk = board.mailbox[mv_from(m)] >> 1;
                scores[i] = (victim >= 0 ? SEE_VALUES[victim] * 16 : 0) - atk + (promo == PT_QUEEN ? 9000 : 0);
            } else {
                int cap = is_cap ? SEE_VALUES[(mtype == MT_EN_PASSANT) ? PT_PAWN : (board.mailbox[to] >> 1)] : 0;
                scores[i] = (cap > 0 ? 400000 + cap : 0) + (promo == PT_QUEEN ? 9000 : 0) +
                            (killers[ply][0] == m ? 10000 : history[board.turn][mv_from(m)][to]);
            }
        }

        int legal = 0;
        uint16_t best_move = 0;
        for (int i = 0; i < count; ++i) {
            int best_i = i, best_s = scores[i];
            for (int j = i + 1; j < count; ++j) {
                if (scores[j] > best_s) { best_s = scores[j]; best_i = j; }
            }
            if (best_i != i) {
                uint16_t tm = list[i]; list[i] = list[best_i]; list[best_i] = tm;
                scores[best_i] = scores[i]; scores[i] = best_s;
            }
            uint16_t m = list[i];
            if (!in_check && best_s <= -1000000) break;

            bool check_mv = !in_check ? board.gives_check(m) : false;
            if (!in_check) {
                int promo = mv_promo(m), mtype = mv_type(m), to = mv_to(m);
                if (!check_mv && promo != PT_QUEEN && has_np && futility_base > -MATE_BOUND) {
                    int victim_val = (mtype == MT_EN_PASSANT) ? SEE_VALUES[PT_PAWN]
                                   : (board.mailbox[to] != EMPTY_SQ ? SEE_VALUES[board.mailbox[to] >> 1] : 0);
                    if (futility_base + victim_val <= alpha) continue;
                }
                if (board.static_exchange_eval(m) < (check_mv ? -50 : 0)) continue;
            }

            if (!make_move(board, m, &nnue)) continue;
            legal++;
            int sc = -quiescence(-beta, -alpha, ply + 1, qdepth + 1, is_pv);
            unmake_move(board, &nnue);
            if (aborted) return orig_alpha;
            if (sc > best) {
                best = sc;
                best_move = m;
                if (sc > alpha) {
                    alpha = sc;
                    if (sc >= beta) {
                        int st_sc = sc;
                        if (st_sc >= MATE_BOUND) st_sc += ply;
                        else if (st_sc <= -MATE_BOUND) st_sc -= ply;
                        tt_store(board.hash, qs_depth, st_sc, TT_LOWER, m, stored_raw_eval, is_pv || tt_was_pv);
                        return sc;
                    }
                }
            }
        }

        if (in_check && legal == 0) return -MATE_SCORE + ply;

        int bound = (best <= orig_alpha) ? TT_UPPER : TT_EXACT;
        int st_sc = best;
        if (st_sc >= MATE_BOUND) st_sc += ply;
        else if (st_sc <= -MATE_BOUND) st_sc -= ply;
        tt_store(board.hash, qs_depth, st_sc, bound, best_move, stored_raw_eval, is_pv || tt_was_pv);
        return best;
    }

    int pvs(int depth, int ply, int alpha, int beta, uint16_t excluded_move, bool cutnode) {
        if (ply < MAX_PLY) pv_len[ply] = 0;
        if (check_abort()) return alpha;

        bool is_root = (ply == 0);
        bool is_pv = (beta - alpha > 1);
        bool in_check = board.in_check();

        if (depth <= 0) return quiescence(alpha, beta, ply, 0, is_pv);

        nodes++;
        if (ply > seldepth) seldepth = ply;
        if (ply < MAX_PLY) double_exts[ply] = (ply > 0 ? double_exts[ply - 1] : 0);

        if (!is_root) {
            if (board.is_draw(ply)) return 0;
            if (ply >= MAX_PLY - 2) return in_check ? 0 : adjust_eval_with_corr(raw_eval_node());
            alpha = max_i(alpha, -MATE_SCORE + ply);
            beta  = min_i(beta,  MATE_SCORE - ply - 1);
            if (alpha >= beta) return alpha;
        }

        // TT Probe
        uint16_t tt_move = 0;
        int tt_score = 0, tt_depth = -10, tt_bound = TT_NONE;
        int16_t tt_eval = VALUE_NONE;
        bool tt_was_pv = false;
        bool tt_hit = false;

        if (excluded_move == 0) {
            tt_hit = tt_probe(board.hash, tt_move, tt_score, tt_eval, tt_depth, tt_bound, tt_was_pv);
            if (tt_hit) {
                if (tt_score >= MATE_BOUND) tt_score -= ply;
                else if (tt_score <= -MATE_BOUND) tt_score += ply;

                if (!is_pv && !is_root && tt_depth >= depth && board.halfmove < 90) {
                    if (tt_bound == TT_EXACT) return tt_score;
                    if (tt_bound == TT_LOWER && tt_score >= beta) return tt_score;
                    if (tt_bound == TT_UPPER && tt_score <= alpha) return tt_score;
                }
            }
        }

        bool tt_pv = is_pv || (tt_hit && tt_was_pv);

        // IIR (Internal Iterative Reduction)
        if (depth >= 4 && tt_move == 0 && (is_pv || cutnode) && excluded_move == 0) depth--;

        int us = board.turn;
        int raw_eval = 0, static_eval = 0;
        int16_t cached_raw = VALUE_NONE;
        bool improving = false;

        if (!in_check) {
            if (tt_hit && tt_eval != VALUE_NONE && excluded_move == 0) {
                raw_eval = (int)tt_eval;
                cached_raw = tt_eval;
            } else {
                raw_eval = raw_eval_node();
                cached_raw = (int16_t)clamp_i(raw_eval, -20000, 20000);
            }
            static_eval = adjust_eval_with_corr(raw_eval);
            if (ply < MAX_PLY) {
                eval_stack[ply] = static_eval;
                if (ply >= 2 && eval_stack[ply - 2] != VALUE_NONE) improving = static_eval > eval_stack[ply - 2];
                else if (ply >= 4 && eval_stack[ply - 4] != VALUE_NONE) improving = static_eval > eval_stack[ply - 4];
                else improving = true;
            }
        } else {
            if (ply < MAX_PLY) eval_stack[ply] = VALUE_NONE;
        }

        if (!is_pv && !in_check && excluded_move == 0) {
            // Reverse Futility Pruning (improving-aware)
            if (depth <= 8 && abs_i(beta) < MATE_BOUND) {
                int margin = (75 - 12 * (int)improving) * depth;
                if (static_eval - margin >= beta) return (static_eval + beta) / 2;
            }

            // Razoring
            if (depth <= 2 && abs_i(alpha) < MATE_BOUND && static_eval + 240 * depth <= alpha) {
                int qs = quiescence(alpha, alpha + 1, ply, 0, false);
                if (aborted) return alpha;
                if (qs <= alpha) return qs;
            }

            // Null Move Pruning with Zugzwang verification at high depth
            if (depth >= 3 && static_eval >= beta && abs_i(beta) < MATE_BOUND &&
                ply >= nmp_min_ply && (ply == 0 || moved_piece[ply - 1] != -1) &&
                board.has_non_pawn(us)) {
                int r = 3 + depth / 4 + min_i((static_eval - beta) / 200, 2);
                if (ply < MAX_PLY) { moved_piece[ply] = -1; move_to[ply] = -1; }
                make_null_move(board, &nnue);
                int ns = -pvs(depth - 1 - r, ply + 1, -beta, -beta + 1, 0, !cutnode);
                unmake_null_move(board, &nnue);
                if (aborted) return alpha;
                if (ns >= beta) {
                    if (ns >= MATE_BOUND) ns = beta;
                    if (depth < 12 || nmp_min_ply > 0) return ns;
                    // Verification search to prevent Zugzwang unsoundness
                    int saved_min = nmp_min_ply;
                    nmp_min_ply = ply + (3 * (depth - r)) / 4;
                    int vs = pvs(depth - r, ply, beta - 1, beta, 0, false);
                    nmp_min_ply = saved_min;
                    if (aborted) return alpha;
                    if (vs >= beta) return ns;
                }
            }

            // ProbCut: deep high-threshold capture verification
            if (depth >= 5 && abs_i(beta) < MATE_BOUND) {
                int pc_beta = min_i(beta + 190 - 45 * (int)improving, MATE_BOUND - 1);
                int pc_count = board.gen_pseudo(ply, true);
                uint16_t* pc_list = board.move_list[ply];
                int* pc_scores = board.move_scores[ply];
                for (int i = 0; i < pc_count; ++i) {
                    uint16_t pm = pc_list[i];
                    int ptype = mv_type(pm), pto = mv_to(pm), pp = mv_promo(pm);
                    bool cap = (ptype == MT_EN_PASSANT) || (board.mailbox[pto] != EMPTY_SQ);
                    if (!cap && pp != PT_QUEEN) { pc_scores[i] = -1000000; continue; }
                    int v = (ptype == MT_EN_PASSANT) ? PT_PAWN : (cap ? (board.mailbox[pto] >> 1) : 0);
                    pc_scores[i] = SEE_VALUES[v] * 16 - (board.mailbox[mv_from(pm)] >> 1) + (pp == PT_QUEEN ? 9000 : 0);
                }
                for (int i = 0; i < pc_count; ++i) {
                    int bi = i, bs = pc_scores[i];
                    for (int j = i + 1; j < pc_count; ++j) if (pc_scores[j] > bs) { bs = pc_scores[j]; bi = j; }
                    if (bi != i) {
                        uint16_t tm = pc_list[i]; pc_list[i] = pc_list[bi]; pc_list[bi] = tm;
                        pc_scores[bi] = pc_scores[i]; pc_scores[i] = bs;
                    }
                    if (bs <= -1000000) break;
                    uint16_t pm = pc_list[i];
                    if (board.static_exchange_eval(pm) < pc_beta - static_eval) continue;
                    if (!make_move(board, pm, &nnue)) continue;
                    if (ply < MAX_PLY) { moved_piece[ply] = board.mailbox[mv_to(pm)]; move_to[ply] = mv_to(pm); }
                    int psc = -quiescence(-pc_beta, -pc_beta + 1, ply + 1, 0, false);
                    if (!aborted && psc >= pc_beta) {
                        psc = -pvs(depth - 4, ply + 1, -pc_beta, -pc_beta + 1, 0, !cutnode);
                    }
                    unmake_move(board, &nnue);
                    if (aborted) return alpha;
                    if (psc >= pc_beta) {
                        tt_store(board.hash, depth - 3, psc, TT_LOWER, pm, cached_raw, tt_pv);
                        return psc;
                    }
                }
            }
        }

        int count = board.gen_pseudo(ply, false);
        uint16_t* list = board.move_list[ply];
        int* scores = board.move_scores[ply];
        int p1 = ply > 0 ? moved_piece[ply - 1] : -1;
        int t1 = ply > 0 ? move_to[ply - 1] : -1;
        int p2 = ply > 1 ? moved_piece[ply - 2] : -1;
        int t2 = ply > 1 ? move_to[ply - 2] : -1;

        for (int i = 0; i < count; ++i) {
            scores[i] = score_move(list[i], tt_move, ply, p1, t1, p2, t2);
        }

        int orig_alpha = alpha;
        int best_score = -INF_SCORE;
        uint16_t best_move = 0;
        int moves_searched = 0;
        int legal_count = 0;
        uint16_t quiet_searched[MAX_MOVES];
        uint16_t cap_searched[MAX_MOVES];
        int quiet_cnt = 0, cap_cnt = 0;

        for (int i = 0; i < count; ++i) {
            int best_i = i, best_os = scores[i];
            for (int j = i + 1; j < count; ++j) {
                if (scores[j] > best_os) { best_os = scores[j]; best_i = j; }
            }
            if (best_i != i) {
                uint16_t tm = list[i]; list[i] = list[best_i]; list[best_i] = tm;
                scores[best_i] = scores[i]; scores[i] = best_os;
            }

            uint16_t move = list[i];
            if (move == excluded_move) continue;

            int from = mv_from(move), to = mv_to(move), mtype = mv_type(move), promo = mv_promo(move);
            uint8_t moved_pc = board.mailbox[from];
            bool is_cap = (mtype == MT_EN_PASSANT) || (mtype != MT_CASTLING && board.mailbox[to] != EMPTY_SQ);
            bool is_tactical = is_cap || (promo == PT_QUEEN);
            bool gives_check = board.gives_check(move);

            // Non-PV Pruning: NEVER prune checking moves or tactical sacrifices when in check/winning
            if (!is_pv && !is_root && !in_check && !gives_check && best_score > -MATE_BOUND) {
                if (!is_tactical) {
                    int lmp_limit = (3 + depth * depth) / (2 - (int)improving);
                    if (depth <= 6 && moves_searched >= lmp_limit) continue;
                    int lmr_d = max_i(0, depth - LMR_TABLE[min_i(depth, 63)][min_i(moves_searched, 63)]);
                    if (lmr_d <= 5 && static_eval + 110 + 95 * lmr_d <= alpha) continue;
                    if (depth <= 6 && board.static_exchange_eval(move) < -50 * depth) continue;
                } else if (is_cap && depth <= 5) {
                    if (board.static_exchange_eval(move) < -90 * depth) continue;
                }
            }

            // Extensions (Singular + MultiCut + Negative + Safe Check Ext)
            int ext = 0;
            if (!is_root && excluded_move == 0 && move == tt_move && depth >= 6 &&
                tt_hit && tt_depth >= depth - 3 && tt_bound != TT_UPPER && abs_i(tt_score) < MATE_BOUND) {
                int s_beta = max_i(-MATE_BOUND + 1, tt_score - depth * 2);
                int s_depth = (depth - 1) / 2;
                int s_sc = pvs(s_depth, ply, s_beta - 1, s_beta, move, cutnode);
                if (aborted) return orig_alpha;
                if (s_sc < s_beta) {
                    if (!is_pv && s_sc < s_beta - 30 && ply < MAX_PLY && double_exts[ply] <= 5) {
                        ext = 2;
                        double_exts[ply]++;
                    } else {
                        ext = 1;
                    }
                } else if (s_beta >= beta) {
                    return s_beta; // Multi-Cut
                } else if (tt_score >= beta && depth >= 8) {
                    ext = -2; // Negative extension when TT move already fails high
                }
            } else if (gives_check && ply < MAX_PLY - 4 && (in_check || board.static_exchange_eval(move) >= 0) &&
                       (ply < MAX_PLY && double_exts[ply] <= 6)) {
                ext = 1;
            }

            if (!make_move(board, move, &nnue)) continue;
            legal_count++;
            moves_searched++;

            if (ply < MAX_PLY) {
                moved_piece[ply] = moved_pc;
                move_to[ply] = to;
            }

            int new_depth = max_i(0, depth - 1 + ext);
            int sc;

            if (moves_searched == 1) {
                sc = -pvs(new_depth, ply + 1, -beta, -alpha, 0, false);
            } else {
                int red = 0;
                if (depth >= 3 && moves_searched >= 3 && !is_tactical && !in_check && !gives_check) {
                    red = LMR_TABLE[min_i(depth, 63)][min_i(moves_searched, 63)];
                    if (!tt_pv) red++;
                    if (cutnode) red++;
                    if (!improving) red++;
                    int hv = history[us][from][to];
                    if (hv > 4096) red--;
                    else if (hv < -4096) red++;
                    red = clamp_i(red, 0, max_i(0, new_depth - 1));
                } else if (depth >= 3 && moves_searched >= 5 && is_cap && !in_check && !gives_check && best_os < 0) {
                    red = 1;
                }

                sc = -pvs(new_depth - red, ply + 1, -alpha - 1, -alpha, 0, true);
                if (!aborted && sc > alpha && red > 0) {
                    sc = -pvs(new_depth, ply + 1, -alpha - 1, -alpha, 0, !cutnode);
                }
                if (!aborted && sc > alpha && sc < beta) {
                    sc = -pvs(new_depth, ply + 1, -beta, -alpha, 0, false);
                }
            }

            unmake_move(board, &nnue);
            if (aborted) return orig_alpha;

            if (sc > best_score) {
                best_score = sc;
                best_move = move;
                if (sc > alpha) {
                    alpha = sc;
                    if (ply < MAX_PLY - 1) {
                        int clen = pv_len[ply + 1];
                        pv_table[ply][0] = move;
                        for (int k = 0; k < clen; ++k) pv_table[ply][1 + k] = pv_table[ply + 1][k];
                        pv_len[ply] = 1 + clen;
                    }
                    if (sc >= beta) {
                        int bonus = min_i(2048, depth * depth * 16);
                        if (!is_cap) {
                            if (ply < MAX_PLY && killers[ply][0] != move) {
                                killers[ply][1] = killers[ply][0];
                                killers[ply][0] = move;
                            }
                            if (t1 >= 0) countermoves[us][t1][to] = move;
                            update_quiet_hist(us, from, to, bonus);
                            int cidx = moved_pc * 64 + to;
                            if (p1 >= 0) update_cont_hist(p1 * 64 + t1, cidx, bonus);
                            if (p2 >= 0) update_cont_hist(p2 * 64 + t2, cidx, bonus >> 1);
                            for (int q = 0; q < quiet_cnt; ++q) {
                                uint16_t qm = quiet_searched[q];
                                int qf = mv_from(qm), qt = mv_to(qm);
                                uint8_t qp = board.mailbox[qf];
                                update_quiet_hist(us, qf, qt, -bonus);
                                if (p1 >= 0) update_cont_hist(p1 * 64 + t1, qp * 64 + qt, -bonus);
                            }
                        } else {
                            int cap_pt = (mtype == MT_EN_PASSANT) ? PT_PAWN : clamp_i(board.mailbox[to] >> 1, 0, 5);
                            update_cap_hist(moved_pc, to, cap_pt, bonus);
                        }
                        for (int cq = 0; cq < cap_cnt; ++cq) {
                            uint16_t cm = cap_searched[cq];
                            int cf = mv_from(cm), ct = mv_to(cm), cmt = mv_type(cm);
                            int cpt = (cmt == MT_EN_PASSANT) ? PT_PAWN : clamp_i(board.mailbox[ct] >> 1, 0, 5);
                            update_cap_hist(board.mailbox[cf], ct, cpt, -bonus);
                        }
                        break;
                    }
                }
            }
            if (!is_cap) {
                if (quiet_cnt < MAX_MOVES) quiet_searched[quiet_cnt++] = move;
            } else {
                if (cap_cnt < MAX_MOVES) cap_searched[cap_cnt++] = move;
            }
        }

        if (legal_count == 0 && excluded_move == 0) {
            return in_check ? -MATE_SCORE + ply : 0;
        }

        if (!in_check && excluded_move == 0 && best_move != 0 && abs_i(best_score) < MATE_BOUND) {
            int bmtype = mv_type(best_move), bto = mv_to(best_move);
            if (bmtype != MT_EN_PASSANT && (bmtype == MT_CASTLING || board.mailbox[bto] == EMPTY_SQ)) {
                if ((best_score > static_eval || best_score >= beta) &&
                    !(best_score < beta && best_score > orig_alpha)) {
                    // Only update when static eval error sign aligns or bound holds cleanly
                }
                int pidx = (int)(board.pawn_key & 16383ULL);
                int npidx = (int)(board.nonpawn_key & 16383ULL);
                int err = clamp_i(best_score - raw_eval, -256, 256);
                int w = min_i(16, depth + 1);
                pawn_corr[us][pidx] = (int16_t)clamp_i((pawn_corr[us][pidx] * (256 - w) + err * 16 * w) / 256, -2048, 2048);
                nonpawn_corr[us][npidx] = (int16_t)clamp_i((nonpawn_corr[us][npidx] * (256 - w) + err * 12 * w) / 256, -2048, 2048);
            }
        }

        if (excluded_move == 0 && best_move != 0) {
            int bound = TT_EXACT;
            if (best_score <= orig_alpha) bound = TT_UPPER;
            else if (best_score >= beta) bound = TT_LOWER;

            int st_sc = best_score;
            if (st_sc >= MATE_BOUND) st_sc += ply;
            else if (st_sc <= -MATE_BOUND) st_sc -= ply;
            tt_store(board.hash, depth, st_sc, bound, best_move, cached_raw, tt_pv);
        }

        return best_score;
    }

    // Root search across ordered RootMoves with Aspiration Windows & MultiPV
    void populate_root_moves() {
        int pseudo = board.gen_pseudo(0, false);
        root_cnt = 0;
        for (int i = 0; i < pseudo; ++i) {
            uint16_t m = board.move_list[0][i];
            if (make_move(board, m, &nnue)) {
                unmake_move(board, &nnue);
                RootMove& rm = root_moves[root_cnt++];
                rm.move = m;
                rm.score = -INF_SCORE;
                rm.prev_score = 0;
                rm.pv_len = 1;
                rm.pv[0] = m;
            }
        }
    }

    int search_root_iteration(int depth, int multipv_lines, int* out_scores,
                              uint16_t out_pvs[][MAX_PLY], int* out_pv_lens) {
        aborted = false;
        int lines = min_i(multipv_lines, root_cnt);

        // Order root_moves using TT move boost before depth 1 or stable previous score
        uint16_t tt_move = 0;
        int tt_sc = 0, tt_dep = 0, tt_bnd = 0;
        int16_t tt_ev = VALUE_NONE;
        bool tt_wpv = false;
        tt_probe(board.hash, tt_move, tt_sc, tt_ev, tt_dep, tt_bnd, tt_wpv);

        if (depth == 1) {
            int p1 = -1, t1 = -1, p2 = -1, t2 = -1;
            for (int i = 0; i < root_cnt; ++i) {
                root_moves[i].score = score_move(root_moves[i].move, tt_move, 0, p1, t1, p2, t2);
            }
            for (int i = 0; i < root_cnt; ++i) {
                for (int j = i + 1; j < root_cnt; ++j) {
                    if (root_moves[j].score > root_moves[i].score) {
                        RootMove tmp = root_moves[i]; root_moves[i] = root_moves[j]; root_moves[j] = tmp;
                    }
                }
            }
        }

        int pvs_done = 0;
        for (int pv_idx = 0; pv_idx < lines; ++pv_idx) {
            // Search unsorted tail [pv_idx .. root_cnt - 1]
            int delta = 18;
            int prev_sc = root_moves[pv_idx].prev_score;
            int alpha = (depth >= 4) ? max_i(-INF_SCORE, prev_sc - delta) : -INF_SCORE;
            int beta  = (depth >= 4) ? min_i(INF_SCORE,  prev_sc + delta) : INF_SCORE;

            int best_idx = pv_idx;
            int best_value = -INF_SCORE;

            while (true) {
                best_value = -INF_SCORE;
                best_idx = pv_idx;
                int cur_alpha = alpha;

                for (int r = pv_idx; r < root_cnt; ++r) {
                    uint16_t rm = root_moves[r].move;
                    uint8_t mpc = board.mailbox[mv_from(rm)];
                    if (!make_move(board, rm, &nnue)) continue;

                    moved_piece[0] = mpc;
                    move_to[0] = mv_to(rm);
                    bool gives_check = board.in_check();
                    int ext = gives_check ? 1 : 0;
                    int nd = max_i(0, depth - 1 + ext);

                    int sc;
                    if (r == pv_idx) {
                        sc = -pvs(nd, 1, -beta, -cur_alpha, 0, false);
                    } else {
                        int red = 0;
                        int mtype = mv_type(rm), mpromo = mv_promo(rm);
                        bool cap = (mtype == MT_EN_PASSANT) || (board.undo[board.undo_top - 1].captured != EMPTY_SQ);
                        if (depth >= 3 && r >= pv_idx + 2 && !cap && mpromo != PT_QUEEN && !gives_check) {
                            red = clamp_i(LMR_TABLE[min_i(depth, 63)][min_i(r - pv_idx + 1, 63)] - 1, 0, max_i(0, nd - 1));
                        }
                        sc = -pvs(nd - red, 1, -cur_alpha - 1, -cur_alpha, 0, true);
                        if (!aborted && sc > cur_alpha && red > 0) {
                            sc = -pvs(nd, 1, -cur_alpha - 1, -cur_alpha, 0, false);
                        }
                        if (!aborted && sc > cur_alpha) {
                            sc = -pvs(nd, 1, -beta, -cur_alpha, 0, false);
                        }
                    }

                    unmake_move(board, &nnue);
                    if (aborted) break;

                    if (sc > best_value) {
                        best_value = sc;
                        best_idx = r;
                        root_moves[r].score = sc;
                        root_moves[r].pv[0] = rm;
                        int clen = pv_len[1];
                        for (int k = 0; k < clen; ++k) root_moves[r].pv[1 + k] = pv_table[1][k];
                        root_moves[r].pv_len = 1 + clen;

                        if (sc > cur_alpha) {
                            cur_alpha = sc;
                        }
                        if (sc >= beta) break;
                    }
                }

                if (aborted) break;
                if (best_value <= alpha) {
                    beta = (alpha + beta) / 2;
                    alpha = max_i(-INF_SCORE, alpha - delta);
                    delta = (delta * 9) / 5 + 15;
                } else if (best_value >= beta) {
                    beta = min_i(INF_SCORE, beta + delta);
                    delta = (delta * 9) / 5 + 15;
                } else {
                    break;
                }
                if (alpha <= -20000 && beta >= 20000) {
                    alpha = -INF_SCORE;
                    beta = INF_SCORE;
                }
            }

            if (aborted) break;

            // Bring best move of this PV rank to slot pv_idx (so pv_idx+1 skips it)
            if (best_idx != pv_idx) {
                RootMove tmp = root_moves[best_idx];
                for (int r = best_idx; r > pv_idx; --r) root_moves[r] = root_moves[r - 1];
                root_moves[pv_idx] = tmp;
            }
            root_moves[pv_idx].prev_score = best_value;

            out_scores[pv_idx] = best_value;
            out_pv_lens[pv_idx] = root_moves[pv_idx].pv_len;
            for (int k = 0; k < root_moves[pv_idx].pv_len; ++k) {
                out_pvs[pv_idx][k] = root_moves[pv_idx].pv[k];
            }
            pvs_done++;
        }

        if (!aborted && pvs_done > 0) {
            int st_sc = out_scores[0];
            tt_store(board.hash, depth, st_sc, TT_EXACT, root_moves[0].move,
                     (int16_t)clamp_i(raw_eval_node(), -20000, 20000), true);
        }
        return pvs_done;
    }

    int verify_incremental_rec(int depth, int ply) {
        static SfNnue ref_nnue;
        int inc_cp = nnue.evaluate_cp(board);
        ref_nnue.on_reset(board);
        int ref_cp = ref_nnue.evaluate_cp(board);
        if (inc_cp != ref_cp) return 1;
        if (depth == 0) return 0;

        int count = board.gen_pseudo(ply, false);
        int errs = 0;
        for (int i = 0; i < count; ++i) {
            uint16_t m = board.move_list[ply][i];
            if (make_move(board, m, &nnue)) {
                errs += verify_incremental_rec(depth - 1, ply + 1);
                unmake_move(board, &nnue);
                if (errs > 0) break;
            }
        }
        return errs;
    }
};

// ----------------------------------------------------------------------------
// Worker Allocation (Static in WASM, Heap Vector in Native Lazy SMP)
// ----------------------------------------------------------------------------
#ifdef BERSERKER_NATIVE
static std::vector<std::unique_ptr<SearchWorker>> g_workers;
static Board g_board;

static SearchWorker* ensure_workers(int count) {
    count = clamp_i(count, 1, 64);
    while ((int)g_workers.size() < count) {
        auto w = std::make_unique<SearchWorker>();
        w->thread_id = (int)g_workers.size();
        w->clear_heuristics();
        g_workers.push_back(std::move(w));
    }
    while ((int)g_workers.size() > count) {
        g_workers.pop_back();
    }
    return g_workers[0].get();
}

static inline SearchWorker* main_worker() {
    if (g_workers.empty()) ensure_workers(g_threads);
    return g_workers[0].get();
}
#else
static SearchWorker g_main_worker_inst;
static inline SearchWorker* main_worker() { return &g_main_worker_inst; }
static Board& g_board = g_main_worker_inst.board;
#endif

static void clear_search_state() {
    clear_tt();
    g_tt_age = 1;
#ifdef BERSERKER_NATIVE
    for (auto& w : g_workers) w->clear_heuristics();
#else
    main_worker()->clear_heuristics();
#endif
}

// ----------------------------------------------------------------------------
// String Formatting & UCI Command Parser
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

static int append_move_uci(char* dst, int pos, uint16_t m) {
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
    uci_out(s, n);
}

static bool apply_uci_move(Board& b, const char* s, int len, SfNnue* nnue) {
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
        uint16_t m = b.move_list[0][i];
        if (mv_from(m) == f && mv_to(m) == t && mv_promo(m) == promo) {
            if (make_move(b, m, nnue)) return true;
        }
    }
    return false;
}

static void emit_info_pv(int d, int seldepth, int pv_rank, int score, uint64_t total_nodes,
                         double start_ms, int pv_len, const uint16_t* pv) {
    int64_t elapsed = max_i(1, (int)(now_ms() - start_ms));
    int64_t nps = (int64_t)((double)total_nodes * 1000.0 / (double)elapsed);
    int hashfull = tt_hashfull();

    int pos = 0;
    pos = append_str(g_out_buf, pos, "info depth ");
    pos = append_int(g_out_buf, pos, d);
    pos = append_str(g_out_buf, pos, " seldepth ");
    pos = append_int(g_out_buf, pos, seldepth);
    pos = append_str(g_out_buf, pos, " multipv ");
    pos = append_int(g_out_buf, pos, pv_rank);
    if (abs_i(score) >= MATE_BOUND) {
        int md = ((MATE_SCORE - abs_i(score)) + 1) / 2;
        pos = append_str(g_out_buf, pos, " score mate ");
        pos = append_int(g_out_buf, pos, score > 0 ? md : -md);
    } else {
        pos = append_str(g_out_buf, pos, " score cp ");
        pos = append_int(g_out_buf, pos, score);
    }
    pos = append_str(g_out_buf, pos, " nodes ");
    pos = append_int(g_out_buf, pos, (int64_t)total_nodes);
    pos = append_str(g_out_buf, pos, " nps ");
    pos = append_int(g_out_buf, pos, nps);
    pos = append_str(g_out_buf, pos, " hashfull ");
    pos = append_int(g_out_buf, pos, hashfull);
    pos = append_str(g_out_buf, pos, " time ");
    pos = append_int(g_out_buf, pos, elapsed);
    pos = append_str(g_out_buf, pos, " pv");
    for (int k = 0; k < pv_len; ++k) {
        g_out_buf[pos++] = ' ';
        pos = append_move_uci(g_out_buf, pos, pv[k]);
    }
    uci_out(g_out_buf, pos);
}

static void finish_search_and_emit() {
    g_sc.active = false;
    if (g_sc.completed_depth == 0 && g_sc.completed_best_move != 0) {
        uint16_t fallback_pv[1] = { (uint16_t)g_sc.completed_best_move };
        SearchWorker* w = main_worker();
        emit_info_pv(1, max_i(1, w->seldepth), 1, g_sc.completed_score, (w->nodes > 0 ? w->nodes : 1ULL), g_sc.start_ms, 1, fallback_pv);
    }
    int pos = 0;
    pos = append_str(g_out_buf, pos, "bestmove ");
    pos = append_move_uci(g_out_buf, pos, (uint16_t)g_sc.completed_best_move);
    if (g_sc.completed_pv_len >= 2 && g_sc.completed_pv[1] != 0) {
        pos = append_str(g_out_buf, pos, " ponder ");
        pos = append_move_uci(g_out_buf, pos, g_sc.completed_pv[1]);
    }
    uci_out(g_out_buf, pos);
}

// ----------------------------------------------------------------------------
// Search Driver (Single-Step Cooperative for WASM & Multi-Thread Lazy SMP Native)
// ----------------------------------------------------------------------------
extern "C" {

#ifndef __wasm__
#define WASM_EXPORT
#else
#define WASM_EXPORT __attribute__((visibility("default")))
#endif

WASM_EXPORT
int wasm_search_begin(int max_depth, int max_time_ms, bool infinite) {
    init_tables();
    if (!g_nnue_loaded) {
        emit_line("info string ERROR: NNUE network not loaded yet");
        emit_line("bestmove 0000");
        g_sc.active = false;
        return 0;
    }

    g_stop_requested = false;
    SearchWorker* mw = main_worker();
#ifdef BERSERKER_NATIVE
    mw->board = g_board;
#endif
    mw->nnue.on_reset(mw->board);
    mw->populate_root_moves();

    if (mw->root_cnt == 0) {
        emit_line("bestmove 0000");
        g_sc.active = false;
        return 0;
    }

    g_tt_age++;
    if (g_tt_age == 0 || g_tt_age > 30) g_tt_age = 1;

    mw->nodes = 0;
    mw->qnodes = 0;
    mw->seldepth = 0;
    mw->aborted = false;

    g_sc.start_ms = now_ms();
    g_sc.max_time_ms = max_time_ms < 10 ? 10 : max_time_ms;
    g_sc.infinite = infinite;
    g_sc.target_depth = clamp_i(max_depth, 1, 64);
    g_sc.completed_best_move = mw->root_moves[0].move;
    g_sc.completed_score = mw->raw_eval_node();
    g_sc.completed_depth = 0;
    g_sc.completed_pv[0] = mw->root_moves[0].move;
    g_sc.completed_pv_len = 1;
    g_sc.last_root_move = 0;
    g_sc.stable_count = 0;
    g_sc.current_depth = 1;
    g_sc.active = true;
    return 1;
}

WASM_EXPORT
int wasm_search_step() {
    if (!g_sc.active) return 0;
    SearchWorker* mw = main_worker();

    if (g_stop_requested || g_sc.current_depth > g_sc.target_depth ||
        (!g_sc.infinite && g_sc.completed_depth >= 1 && (now_ms() - g_sc.start_ms) >= g_sc.max_time_ms)) {
        finish_search_and_emit();
        return 0;
    }

    int d = g_sc.current_depth;
    // Intelligent early-stop: only after depth >= 5 AND stable best move >= 4 iterations AND past 55% budget
    if (!g_sc.infinite && d >= 5 && g_sc.completed_depth >= 5 &&
        (now_ms() - g_sc.start_ms) >= g_sc.max_time_ms * 0.55 &&
        g_sc.stable_count >= 4) {
        finish_search_and_emit();
        return 0;
    }

    int out_scores[8];
    uint16_t out_pvs[8][MAX_PLY];
    int out_pv_lens[8];
    int pvs_done = mw->search_root_iteration(d, g_multipv, out_scores, out_pvs, out_pv_lens);

    if (!mw->aborted && pvs_done > 0) {
        uint16_t primary_move = out_pvs[0][0];
        int primary_score = out_scores[0];
        int primary_pv_len = out_pv_lens[0];

        int prev_completed_score = g_sc.completed_score;
        g_sc.completed_best_move = primary_move;
        g_sc.completed_score = primary_score;
        g_sc.completed_depth = d;
        g_sc.completed_pv_len = primary_pv_len;
        for (int k = 0; k < primary_pv_len; ++k) g_sc.completed_pv[k] = out_pvs[0][k];

        if (primary_move == g_sc.last_root_move && primary_score >= prev_completed_score - 12) {
            g_sc.stable_count++;
        } else {
            g_sc.last_root_move = primary_move;
            g_sc.stable_count = 0;
        }

        for (int pv_idx = 0; pv_idx < pvs_done; ++pv_idx) {
            emit_info_pv(d, mw->seldepth, pv_idx + 1, out_scores[pv_idx], mw->nodes,
                         g_sc.start_ms, out_pv_lens[pv_idx], out_pvs[pv_idx]);
        }
    }

    if (mw->aborted || (abs_i(g_sc.completed_score) >= MATE_BOUND && d >= 2)) {
        finish_search_and_emit();
        return 0;
    }

    g_sc.current_depth++;
    return 1;
}

#ifdef BERSERKER_NATIVE
static void native_run_smp_search(int max_depth, int max_time_ms, bool infinite) {
    if (!wasm_search_begin(max_depth, max_time_ms, infinite)) return;

    int num_threads = clamp_i(g_threads, 1, 64);
    ensure_workers(num_threads);

    std::vector<std::thread> helpers;
    for (int tid = 1; tid < num_threads; ++tid) {
        SearchWorker* hw = g_workers[tid].get();
        hw->board = g_board;
        hw->nnue.on_reset(hw->board);
        hw->populate_root_moves();
        hw->nodes = 0;
        hw->qnodes = 0;
        hw->seldepth = 0;
        hw->aborted = false;

        helpers.emplace_back([hw, tid, max_depth]() {
            int out_sc[8];
            uint16_t out_pvs[8][MAX_PLY];
            int out_len[8];
            for (int hd = 1 + (tid % 2); hd <= max_depth && !hw->aborted && !g_stop_requested.load(std::memory_order_relaxed); ++hd) {
                hw->search_root_iteration(hd, 1, out_sc, out_pvs, out_len);
                if (g_stop_requested.load(std::memory_order_relaxed)) break;
            }
        });
    }

    // Main thread 0 drives iterative deepening & emits info + authoritative bestmove
    SearchWorker* mw = main_worker();
    while (g_sc.active) {
        if (g_stop_requested.load(std::memory_order_relaxed) || g_sc.current_depth > g_sc.target_depth ||
            (!g_sc.infinite && g_sc.completed_depth >= 1 && (now_ms() - g_sc.start_ms) >= g_sc.max_time_ms)) {
            break;
        }
        int d = g_sc.current_depth;
        if (!g_sc.infinite && d >= 5 && g_sc.completed_depth >= 5 &&
            (now_ms() - g_sc.start_ms) >= g_sc.max_time_ms * 0.55 &&
            g_sc.stable_count >= 4) {
            break;
        }

        int out_scores[8];
        uint16_t out_pvs[8][MAX_PLY];
        int out_pv_lens[8];
        int pvs_done = mw->search_root_iteration(d, g_multipv, out_scores, out_pvs, out_pv_lens);

        if (!mw->aborted && pvs_done > 0) {
            uint64_t total_nodes = 0;
            int max_sd = mw->seldepth;
            for (int t = 0; t < num_threads; ++t) {
                total_nodes += g_workers[t]->nodes;
                max_sd = max_i(max_sd, g_workers[t]->seldepth);
            }
            uint16_t primary_move = out_pvs[0][0];
            int primary_score = out_scores[0];
            int primary_pv_len = out_pv_lens[0];

            int prev_completed_score = g_sc.completed_score;
            g_sc.completed_best_move = primary_move;
            g_sc.completed_score = primary_score;
            g_sc.completed_depth = d;
            g_sc.completed_pv_len = primary_pv_len;
            for (int k = 0; k < primary_pv_len; ++k) g_sc.completed_pv[k] = out_pvs[0][k];

            if (primary_move == g_sc.last_root_move && primary_score >= prev_completed_score - 12) {
                g_sc.stable_count++;
            } else {
                g_sc.last_root_move = primary_move;
                g_sc.stable_count = 0;
            }

            for (int pv_idx = 0; pv_idx < pvs_done; ++pv_idx) {
                emit_info_pv(d, max_sd, pv_idx + 1, out_scores[pv_idx], total_nodes,
                             g_sc.start_ms, out_pv_lens[pv_idx], out_pvs[pv_idx]);
            }
        }
        if (mw->aborted || (abs_i(g_sc.completed_score) >= MATE_BOUND && d >= 2)) break;
        g_sc.current_depth++;
    }

    g_stop_requested = true;
    for (auto& th : helpers) if (th.joinable()) th.join();
    mw->nodes = 0;
    for (int t = 0; t < num_threads; ++t) mw->nodes += g_workers[t]->nodes;
    finish_search_and_emit();
}
#endif

// ----------------------------------------------------------------------------
// Perft, Parity Check & Exported WASM API
// ----------------------------------------------------------------------------
static uint64_t perft_rec(Board& b, int depth, int ply) {
    if (depth == 0) return 1ULL;
    int count = b.gen_pseudo(ply, false);
    uint64_t nodes = 0ULL;
    for (int i = 0; i < count; ++i) {
        uint16_t m = b.move_list[ply][i];
        if (make_move(b, m, nullptr)) {
            nodes += perft_rec(b, depth - 1, ply + 1);
            unmake_move(b, nullptr);
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

WASM_EXPORT uint8_t* wasm_get_nnue_ptr() { return g_nnue_buf; }
WASM_EXPORT int wasm_get_nnue_max_bytes() { return (int)EXPECTED_NNUE_BYTES; }

WASM_EXPORT int wasm_init_nnue(int byte_len) {
    init_tables();
    if (byte_len != (int)EXPECTED_NNUE_BYTES) return 0;
    if (!init_nnue_buffer((size_t)byte_len)) return 0;
    SearchWorker* mw = main_worker();
#ifdef BERSERKER_NATIVE
    mw->board = g_board;
#endif
    mw->nnue.on_reset(mw->board);
    return 1;
}

WASM_EXPORT int wasm_is_nnue_loaded() {
    init_tables();
    return g_nnue_loaded ? 1 : 0;
}

#ifdef BERSERKER_NATIVE
static bool load_nnue_from_file(const char* path) {
    if (!path || !*path) return false;
    FILE* f = fopen(path, "rb");
    if (!f) return false;
    fseek(f, 0, SEEK_END);
    long fsz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (fsz != (long)EXPECTED_NNUE_BYTES) {
        fclose(f);
        return false;
    }
    size_t rd = fread(g_nnue_buf, 1, EXPECTED_NNUE_BYTES, f);
    fclose(f);
    if (rd != EXPECTED_NNUE_BYTES) return false;
    if (!init_nnue_buffer(EXPECTED_NNUE_BYTES)) return false;
    SearchWorker* mw = main_worker();
    mw->board = g_board;
    mw->nnue.on_reset(mw->board);
    return true;
}

static void try_autoload_native_nnue() {
    if (g_nnue_loaded) return;
    static const char* CANDIDATES[] = {
        "storage/nn-cache/nn-bddd9d57eb87.nnue",
        "nn-bddd9d57eb87.nnue",
        "public/nnue/nn-bddd9d57eb87.nnue",
        "../storage/nn-cache/nn-bddd9d57eb87.nnue"
    };
    for (const char* p : CANDIDATES) {
        if (load_nnue_from_file(p)) break;
    }
}
#endif

WASM_EXPORT void wasm_init() {
    init_tables();
    SearchWorker* mw = main_worker();
    mw->clear_heuristics();
    static const char STARTPOS[] = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    g_board.set_fen(STARTPOS, sizeof(STARTPOS) - 1);
    mw->board = g_board;
    mw->nnue.on_reset(mw->board);
}

WASM_EXPORT uint8_t* wasm_get_cmd_buf() { return (uint8_t*)g_cmd_buf; }
WASM_EXPORT int wasm_get_cmd_buf_size() { return (int)sizeof(g_cmd_buf); }
WASM_EXPORT void wasm_stop() { g_stop_requested = true; }

WASM_EXPORT int wasm_evaluate_fen(int len) {
    init_tables();
    SearchWorker* mw = main_worker();
    g_board.set_fen(g_cmd_buf, len);
    mw->board = g_board;
    mw->nnue.on_reset(mw->board);
    return mw->nnue.evaluate_cp(mw->board);
}

WASM_EXPORT int wasm_evaluate_raw_fen(int len) {
    init_tables();
    SearchWorker* mw = main_worker();
    g_board.set_fen(g_cmd_buf, len);
    mw->board = g_board;
    mw->nnue.on_reset(mw->board);
    return g_nnue_loaded ? mw->nnue.forward_raw(mw->board) : 0;
}

WASM_EXPORT int wasm_verify_incremental_parity(int len, int depth) {
    init_tables();
    SearchWorker* mw = main_worker();
    g_board.set_fen(g_cmd_buf, len);
    mw->board = g_board;
    mw->nnue.on_reset(mw->board);
    return mw->verify_incremental_rec(clamp_i(depth, 0, 3), 0);
}

WASM_EXPORT uint64_t wasm_perft(int depth) {
    init_tables();
    return perft_rec(g_board, depth, 0);
}

WASM_EXPORT int wasm_get_last_best_move(char* out4_6) {
    return append_move_uci(out4_6, 0, (uint16_t)g_sc.completed_best_move);
}

WASM_EXPORT int wasm_get_last_score() { return g_sc.completed_score; }
WASM_EXPORT int wasm_get_last_depth() { return g_sc.completed_depth; }
WASM_EXPORT uint64_t wasm_get_last_nodes() { return main_worker()->nodes; }
WASM_EXPORT int wasm_get_last_seldepth() { return main_worker()->seldepth; }

WASM_EXPORT
int wasm_exec_uci(int len) {
    init_tables();
    SearchWorker* mw = main_worker();

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
        emit_line("id name Berserker v0.7.0");
        emit_line("id author Berserker Engine Team");
#ifdef BERSERKER_NATIVE
        emit_line("option name Threads type spin default 1 min 1 max 64");
        emit_line("option name Hash type spin default 64 min 16 max 2048");
#else
        emit_line("option name Threads type spin default 1 min 1 max 1");
        emit_line("option name Hash type spin default 64 min 64 max 64");
#endif
        emit_line("option name MultiPV type spin default 1 min 1 max 5");
        emit_line("option name SearchMode type combo default Pure-PVS var Pure-PVS");
        emit_line("option name TacticalContempt type spin default 0 min -100 max 100");
        emit_line("option name EvalFile type string default nn-bddd9d57eb87.nnue");
        emit_line("info string NNUE raw url: https://github.com/official-stockfish/networks/raw/master/nn-bddd9d57eb87.nnue");
        emit_line("uciok");
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "isready")) {
        if (g_nnue_loaded) {
            emit_line("info string NNUE loaded: nn-bddd9d57eb87.nnue (138360528 bytes)");
        } else {
            emit_line("info string NNUE pending: nn-bddd9d57eb87.nnue not loaded yet");
        }
        emit_line("readyok");
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "ucinewgame")) {
        static const char STARTPOS[] = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        g_board.set_fen(STARTPOS, sizeof(STARTPOS) - 1);
#ifdef BERSERKER_NATIVE
        mw->board = g_board;
#endif
        mw->nnue.on_reset(mw->board);
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
#ifdef BERSERKER_NATIVE
            } else if (str_eq(tok[name_idx], tlen[name_idx], "Threads")) {
                g_threads = clamp_i(parse_int_tok(tok[val_idx], tlen[val_idx]), 1, 64);
                ensure_workers(g_threads);
            } else if (str_eq(tok[name_idx], tlen[name_idx], "Hash")) {
                resize_tt_mb(parse_int_tok(tok[val_idx], tlen[val_idx]));
            } else if (str_eq(tok[name_idx], tlen[name_idx], "EvalFile")) {
                const char* p_start = tok[val_idx];
                int p_len = (int)((tok[ntok - 1] + tlen[ntok - 1]) - p_start);
                if (p_len > 0 && p_len < 1020) {
                    char path_buf[1024];
                    memcpy(path_buf, p_start, (size_t)p_len);
                    path_buf[p_len] = '\0';
                    if (load_nnue_from_file(path_buf)) {
                        emit_line("info string NNUE loaded: nn-bddd9d57eb87.nnue (138360528 bytes)");
                    } else {
                        emit_line("info string ERROR: Failed to load EvalFile");
                    }
                }
#endif
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
#ifdef BERSERKER_NATIVE
        mw->board = g_board;
#endif
        mw->nnue.on_reset(mw->board);
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "eval")) {
#ifdef BERSERKER_NATIVE
        mw->board = g_board;
#endif
        mw->nnue.on_reset(mw->board);
        int raw = g_nnue_loaded ? mw->nnue.forward_raw(mw->board) : 0;
        int cp = mw->nnue.evaluate_cp(mw->board);
        int pos = 0;
        pos = append_str(g_out_buf, pos, "info string NNUE net ");
        pos = append_str(g_out_buf, pos, g_nnue_loaded ? "nn-bddd9d57eb87.nnue (138.4 MB Auto-Loaded)" : "ERROR-NOT-LOADED");
        pos = append_str(g_out_buf, pos, " | stm ");
        pos = append_str(g_out_buf, pos, mw->board.turn == WHITE ? "White" : "Black");
        pos = append_str(g_out_buf, pos, " | eval ");
        if (cp > 0) g_out_buf[pos++] = '+';
        pos = append_int(g_out_buf, pos, cp);
        pos = append_str(g_out_buf, pos, " cp (raw ");
        pos = append_int(g_out_buf, pos, raw);
        pos = append_str(g_out_buf, pos, ")");
        uci_out(g_out_buf, pos);
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "perft")) {
        int d = ntok >= 2 ? clamp_i(parse_int_tok(tok[1], tlen[1]), 1, 6) : 4;
        double t0 = now_ms();
        uint64_t n = perft_rec(g_board, d, 0);
        int ms = max_i(1, (int)(now_ms() - t0));
        int pos = 0;
        pos = append_str(g_out_buf, pos, "info string perft(");
        pos = append_int(g_out_buf, pos, d);
        pos = append_str(g_out_buf, pos, ") = ");
        pos = append_int(g_out_buf, pos, (int64_t)n);
        pos = append_str(g_out_buf, pos, " nodes in ");
        pos = append_int(g_out_buf, pos, ms);
        pos = append_str(g_out_buf, pos, " ms");
        uci_out(g_out_buf, pos);
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
        double t0 = now_ms();
        for (int b_idx = 0; b_idx < 4; ++b_idx) {
            int flen = 0; while (BENCH_FENS[b_idx][flen]) flen++;
            g_board.set_fen(BENCH_FENS[b_idx], flen);
            wasm_search_begin(7, 1500, false);
            while (wasm_search_step()) {}
            total_nodes += mw->nodes;
        }
        int elapsed = max_i(1, (int)(now_ms() - t0));
        int64_t nps = (int64_t)((double)total_nodes * 1000.0 / (double)elapsed);
        int pos = 0;
        pos = append_str(g_out_buf, pos, "info string bench: ");
        pos = append_int(g_out_buf, pos, (int64_t)total_nodes);
        pos = append_str(g_out_buf, pos, " nodes | ");
        pos = append_int(g_out_buf, pos, elapsed);
        pos = append_str(g_out_buf, pos, " ms | ");
        pos = append_int(g_out_buf, pos, nps);
        pos = append_str(g_out_buf, pos, " nps");
        uci_out(g_out_buf, pos);
        return 0;
    }

    if (str_eq(tok[0], tlen[0], "d")) {
        static const char PCH[12] = {'P','p','N','n','B','b','R','r','Q','q','K','k'};
        emit_line("+---+---+---+---+---+---+---+---+");
        for (int r = 7; r >= 0; --r) {
            int pos = 0;
            for (int f = 0; f < 8; ++f) {
                g_out_buf[pos++] = '|'; g_out_buf[pos++] = ' ';
                uint8_t p = g_board.mailbox[r * 8 + f];
                g_out_buf[pos++] = (p < 12) ? PCH[p] : ' ';
                g_out_buf[pos++] = ' ';
            }
            g_out_buf[pos++] = '|'; g_out_buf[pos++] = ' ';
            g_out_buf[pos++] = (char)('1' + r);
            uci_out(g_out_buf, pos);
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
        uci_out(g_out_buf, pos);
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
                ++k; depth = parse_int_tok(tok[k], tlen[k]); has_depth = true;
            } else if (str_eq(tok[k], tlen[k], "movetime") && k + 1 < ntok) {
                ++k; movetime = parse_int_tok(tok[k], tlen[k]); has_movetime = true;
            } else if (str_eq(tok[k], tlen[k], "wtime") && k + 1 < ntok) {
                ++k; wtime = parse_int_tok(tok[k], tlen[k]);
            } else if (str_eq(tok[k], tlen[k], "btime") && k + 1 < ntok) {
                ++k; btime = parse_int_tok(tok[k], tlen[k]);
            } else if (str_eq(tok[k], tlen[k], "winc") && k + 1 < ntok) {
                ++k; winc = parse_int_tok(tok[k], tlen[k]);
            } else if (str_eq(tok[k], tlen[k], "binc") && k + 1 < ntok) {
                ++k; binc = parse_int_tok(tok[k], tlen[k]);
            } else if (str_eq(tok[k], tlen[k], "movestogo") && k + 1 < ntok) {
                ++k; movestogo = max_i(1, parse_int_tok(tok[k], tlen[k]));
            }
        }

        if (has_depth && !has_movetime && !infinite && wtime < 0 && btime < 0) {
            movetime = 60000;
        }
        if (!has_movetime && !infinite) {
            int t = g_board.turn == WHITE ? wtime : btime;
            int inc = g_board.turn == WHITE ? winc : binc;
            if (t > 0) movetime = clamp_i(t / movestogo + (inc * 3) / 4, 40, max_i(40, t - 30));
        }

#ifdef BERSERKER_NATIVE
        native_run_smp_search(depth, movetime, infinite);
        return 0;
#else
        return wasm_search_begin(depth, movetime, infinite);
#endif
    }

    return 0;
}

} // extern "C"

#ifdef BERSERKER_NATIVE
int main() {
    init_tables();
    resize_tt_mb(64);
    ensure_workers(1);
    wasm_init();
    try_autoload_native_nnue();

    char line_buf[16384];
    std::thread search_thread;

    while (fgets(line_buf, sizeof(line_buf), stdin) != nullptr) {
        size_t l = strlen(line_buf);
        while (l > 0 && (line_buf[l - 1] == '\n' || line_buf[l - 1] == '\r')) line_buf[--l] = '\0';
        if (l == 0) continue;

        if (strcmp(line_buf, "quit") == 0) {
            g_stop_requested = true;
            if (search_thread.joinable()) search_thread.join();
            break;
        }
        if (strcmp(line_buf, "stop") == 0) {
            g_stop_requested = true;
            if (search_thread.joinable()) search_thread.join();
            continue;
        }
        if (strncmp(line_buf, "go ", 3) == 0 || strcmp(line_buf, "go") == 0) {
            g_stop_requested = true;
            if (search_thread.joinable()) search_thread.join();
            std::string cmd_copy(line_buf, l);
            search_thread = std::thread([cmd_copy]() {
                size_t len = min_i((int)cmd_copy.size(), (int)sizeof(g_cmd_buf) - 1);
                memcpy(g_cmd_buf, cmd_copy.data(), len);
                g_cmd_buf[len] = '\0';
                wasm_exec_uci((int)len);
            });
            continue;
        }

        if (search_thread.joinable()) search_thread.join();
        size_t len = min_i((int)l, (int)sizeof(g_cmd_buf) - 1);
        memcpy(g_cmd_buf, line_buf, len);
        g_cmd_buf[len] = '\0';
        wasm_exec_uci((int)len);
    }

    g_stop_requested = true;
    if (search_thread.joinable()) search_thread.join();
    return 0;
}
#endif
