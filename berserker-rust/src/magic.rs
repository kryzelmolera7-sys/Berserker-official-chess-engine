//! O(1) Sliding Attack Bitboards (BMI2 PEXT Tables + Portable Classical Fallback)
//!
//! Uses hardware `_pext_u64` with ~861 KB L2-resident tables when compiled with `target_feature = "bmi2"`,
//! initialized in ~1.5ms once at startup via `OnceLock`, falling back cleanly on non-BMI2 targets.

use std::sync::OnceLock;

struct SlidingTables {
    rook_masks: [u64; 64],
    rook_offsets: [usize; 64],
    rook_attacks: Vec<u64>,
    bishop_masks: [u64; 64],
    bishop_offsets: [usize; 64],
    bishop_attacks: Vec<u64>,
}

static TABLES: OnceLock<SlidingTables> = OnceLock::new();

#[inline]
fn rook_mask(sq: usize) -> u64 {
    let r = (sq / 8) as i32;
    let f = (sq % 8) as i32;
    let mut mask = 0u64;
    for rr in (r + 1)..7 {
        mask |= 1u64 << (rr * 8 + f);
    }
    for rr in 1..r {
        mask |= 1u64 << (rr * 8 + f);
    }
    for ff in (f + 1)..7 {
        mask |= 1u64 << (r * 8 + ff);
    }
    for ff in 1..f {
        mask |= 1u64 << (r * 8 + ff);
    }
    mask
}

#[inline]
fn bishop_mask(sq: usize) -> u64 {
    let r = (sq / 8) as i32;
    let f = (sq % 8) as i32;
    let mut mask = 0u64;
    for (dr, df) in [(1, 1), (1, -1), (-1, 1), (-1, -1)] {
        let mut rr = r + dr;
        let mut ff = f + df;
        while (1..=6).contains(&rr) && (1..=6).contains(&ff) {
            mask |= 1u64 << (rr * 8 + ff);
            rr += dr;
            ff += df;
        }
    }
    mask
}

#[inline]
pub fn rook_attacks_slow(sq: u8, occ: u64) -> u64 {
    let mut atk = 0u64;
    let r0 = (sq / 8) as i32;
    let f0 = (sq % 8) as i32;
    for &(dr, df) in &[(1, 0), (-1, 0), (0, 1), (0, -1)] {
        let mut r = r0 + dr;
        let mut f = f0 + df;
        while (0..8).contains(&r) && (0..8).contains(&f) {
            let bit = 1u64 << (r * 8 + f);
            atk |= bit;
            if (occ & bit) != 0 {
                break;
            }
            r += dr;
            f += df;
        }
    }
    atk
}

#[inline]
pub fn bishop_attacks_slow(sq: u8, occ: u64) -> u64 {
    let mut atk = 0u64;
    let r0 = (sq / 8) as i32;
    let f0 = (sq % 8) as i32;
    for &(dr, df) in &[(1, 1), (1, -1), (-1, 1), (-1, -1)] {
        let mut r = r0 + dr;
        let mut f = f0 + df;
        while (0..8).contains(&r) && (0..8).contains(&f) {
            let bit = 1u64 << (r * 8 + f);
            atk |= bit;
            if (occ & bit) != 0 {
                break;
            }
            r += dr;
            f += df;
        }
    }
    atk
}

#[inline]
fn deposit_pext_bits(idx: usize, mask: u64) -> u64 {
    let mut occ = 0u64;
    let mut m = mask;
    let mut bit_idx = 0usize;
    while m != 0 {
        let lsb = m.trailing_zeros();
        m &= m - 1;
        if ((idx >> bit_idx) & 1) != 0 {
            occ |= 1u64 << lsb;
        }
        bit_idx += 1;
    }
    occ
}

fn build_tables() -> SlidingTables {
    let mut rook_masks = [0u64; 64];
    let mut rook_offsets = [0usize; 64];
    let mut bishop_masks = [0u64; 64];
    let mut bishop_offsets = [0usize; 64];

    let mut r_total = 0usize;
    let mut b_total = 0usize;
    for sq in 0..64 {
        let rm = rook_mask(sq);
        rook_masks[sq] = rm;
        rook_offsets[sq] = r_total;
        r_total += 1usize << rm.count_ones();

        let bm = bishop_mask(sq);
        bishop_masks[sq] = bm;
        bishop_offsets[sq] = b_total;
        b_total += 1usize << bm.count_ones();
    }

    let mut rook_attacks = vec![0u64; r_total];
    let mut bishop_attacks = vec![0u64; b_total];

    for sq in 0..64 {
        let rm = rook_masks[sq];
        let r_off = rook_offsets[sq];
        let r_cnt = 1usize << rm.count_ones();
        for idx in 0..r_cnt {
            let occ = deposit_pext_bits(idx, rm);
            rook_attacks[r_off + idx] = rook_attacks_slow(sq as u8, occ);
        }

        let bm = bishop_masks[sq];
        let b_off = bishop_offsets[sq];
        let b_cnt = 1usize << bm.count_ones();
        for idx in 0..b_cnt {
            let occ = deposit_pext_bits(idx, bm);
            bishop_attacks[b_off + idx] = bishop_attacks_slow(sq as u8, occ);
        }
    }

    SlidingTables {
        rook_masks,
        rook_offsets,
        rook_attacks,
        bishop_masks,
        bishop_offsets,
        bishop_attacks,
    }
}

pub fn init_magic_tables() {
    let _ = TABLES.get_or_init(build_tables);
}

#[inline(always)]
pub fn rook_attacks_fast(sq: u8, occ: u64) -> u64 {
    #[cfg(all(target_arch = "x86_64", target_feature = "bmi2"))]
    {
        let t = TABLES.get_or_init(build_tables);
        let s = sq as usize;
        let idx = unsafe { std::arch::x86_64::_pext_u64(occ, t.rook_masks[s]) } as usize;
        // SAFETY: idx is bounded by 1 << popcount(rook_masks[s]), allocated in build_tables
        unsafe { *t.rook_attacks.get_unchecked(t.rook_offsets[s] + idx) }
    }
    #[cfg(not(all(target_arch = "x86_64", target_feature = "bmi2")))]
    {
        rook_attacks_slow(sq, occ)
    }
}

#[inline(always)]
pub fn bishop_attacks_fast(sq: u8, occ: u64) -> u64 {
    #[cfg(all(target_arch = "x86_64", target_feature = "bmi2"))]
    {
        let t = TABLES.get_or_init(build_tables);
        let s = sq as usize;
        let idx = unsafe { std::arch::x86_64::_pext_u64(occ, t.bishop_masks[s]) } as usize;
        unsafe { *t.bishop_attacks.get_unchecked(t.bishop_offsets[s] + idx) }
    }
    #[cfg(not(all(target_arch = "x86_64", target_feature = "bmi2")))]
    {
        bishop_attacks_slow(sq, occ)
    }
}
