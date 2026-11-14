//! 4-Way Clustered Lockless Shared Atomic Transposition Table (for Lazy SMP)

use crate::types::Move;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum TTFlag {
    Exact = 0,
    Lowerbound = 1,
    Upperbound = 2,
}

impl TTFlag {
    #[inline(always)]
    pub fn from_u8(v: u8) -> Self {
        match v & 3 {
            0 => TTFlag::Exact,
            1 => TTFlag::Lowerbound,
            _ => TTFlag::Upperbound,
        }
    }
}

#[derive(Clone, Copy)]
pub struct TTEntry {
    pub depth: u8,
    pub score: i32,
    pub flag: TTFlag,
    pub best_move: Move,
}

/// Lockless XOR-verified 128-bit atomic slot.
pub struct AtomicTTSlot {
    key_xor_data: AtomicU64,
    data: AtomicU64,
}

impl AtomicTTSlot {
    #[inline(always)]
    const fn empty() -> Self {
        Self {
            key_xor_data: AtomicU64::new(0),
            data: AtomicU64::new(0),
        }
    }
}

/// Cache-line aligned 4-way set-associative cluster (64 bytes).
#[repr(align(64))]
struct TTCluster {
    slots: [AtomicTTSlot; 4],
}

impl TTCluster {
    #[inline(always)]
    const fn empty() -> Self {
        Self {
            slots: [
                AtomicTTSlot::empty(),
                AtomicTTSlot::empty(),
                AtomicTTSlot::empty(),
                AtomicTTSlot::empty(),
            ],
        }
    }
}

const VALID_BIT: u64 = 1u64 << 63;

pub struct AtomicTT {
    clusters: Vec<TTCluster>,
    mask: usize,
    generation: AtomicU8,
}

impl AtomicTT {
    pub fn new(size_mb: usize) -> Self {
        let cluster_bytes = std::mem::size_of::<TTCluster>().max(64);
        let raw_clusters = ((size_mb.max(1) * 1024 * 1024) / cluster_bytes).max(1024);
        let size = raw_clusters.next_power_of_two();
        let mut clusters = Vec::with_capacity(size);
        for _ in 0..size {
            clusters.push(TTCluster::empty());
        }
        Self {
            clusters,
            mask: size - 1,
            generation: AtomicU8::new(1),
        }
    }

    pub fn new_search(&self) {
        let cur = self.generation.load(Ordering::Relaxed);
        let next = cur.wrapping_add(1) & 0x3F;
        self.generation.store(if next == 0 { 1 } else { next }, Ordering::Relaxed);
    }

    pub fn clear(&self) {
        for c in &self.clusters {
            for s in &c.slots {
                s.key_xor_data.store(0, Ordering::Relaxed);
                s.data.store(0, Ordering::Relaxed);
            }
        }
        self.generation.store(1, Ordering::Relaxed);
    }

    #[inline(always)]
    pub fn prefetch(&self, hash: u64) {
        let idx = (hash as usize) & self.mask;
        #[cfg(target_arch = "x86_64")]
        unsafe {
            let ptr = self.clusters.as_ptr().add(idx) as *const i8;
            std::arch::x86_64::_mm_prefetch::<{ std::arch::x86_64::_MM_HINT_T0 }>(ptr);
        }
        #[cfg(not(target_arch = "x86_64"))]
        {
            let _ = idx;
        }
    }

    #[inline(always)]
    fn pack_data(score: i32, depth: u8, flag: TTFlag, age: u8, best_move: Move) -> u64 {
        let s16 = (score.clamp(-32000, 32000) as i16) as u16 as u64;
        let d8 = depth as u64;
        let f2 = (flag as u64) & 3;
        let a6 = (age as u64) & 0x3F;
        let mv24 = (best_move.pack() as u64) & 0xFF_FFFF;
        VALID_BIT | s16 | (d8 << 16) | (f2 << 24) | (a6 << 26) | (mv24 << 32)
    }

    #[inline(always)]
    fn unpack_data(data: u64) -> TTEntry {
        let s16 = (data & 0xFFFF) as u16 as i16;
        let depth = ((data >> 16) & 0xFF) as u8;
        let flag = TTFlag::from_u8(((data >> 24) & 3) as u8);
        let mv24 = ((data >> 32) & 0xFF_FFFF) as u32;
        TTEntry {
            depth,
            score: s16 as i32,
            flag,
            best_move: Move::unpack(mv24),
        }
    }

    #[inline(always)]
    pub fn probe(&self, hash: u64) -> Option<TTEntry> {
        let idx = (hash as usize) & self.mask;
        let cluster = &self.clusters[idx];
        for slot in &cluster.slots {
            let d = slot.data.load(Ordering::Relaxed);
            if d == 0 {
                continue;
            }
            let k = slot.key_xor_data.load(Ordering::Relaxed);
            if (k ^ d) == hash {
                return Some(Self::unpack_data(d));
            }
        }
        None
    }

    #[inline(always)]
    pub fn store(&self, hash: u64, depth: u8, score: i32, flag: TTFlag, best_move: Move) {
        let idx = (hash as usize) & self.mask;
        let cluster = &self.clusters[idx];
        let cur_age = self.generation.load(Ordering::Relaxed);

        let mut replace_idx = 0usize;
        let mut worst_quality = i32::MAX;

        for (i, slot) in cluster.slots.iter().enumerate() {
            let d = slot.data.load(Ordering::Relaxed);
            if d == 0 {
                replace_idx = i;
                break;
            }
            let k = slot.key_xor_data.load(Ordering::Relaxed);
            if (k ^ d) == hash {
                let old_depth = ((d >> 16) & 0xFF) as u8;
                let old_age = ((d >> 26) & 0x3F) as u8;
                let old_mv24 = ((d >> 32) & 0xFF_FFFF) as u32;
                let kept_move = if best_move == Move::NULL && old_mv24 != 0 {
                    Move::unpack(old_mv24)
                } else {
                    best_move
                };
                if old_age != cur_age || flag == TTFlag::Exact || depth + 2 >= old_depth {
                    let packed = Self::pack_data(score, depth, flag, cur_age, kept_move);
                    slot.data.store(packed, Ordering::Relaxed);
                    slot.key_xor_data.store(hash ^ packed, Ordering::Relaxed);
                }
                return;
            }

            let old_depth = ((d >> 16) & 0xFF) as i32;
            let old_age = ((d >> 26) & 0x3F) as u8;
            let age_diff = ((cur_age.wrapping_sub(old_age)) & 0x3F) as i32;
            let quality = old_depth - age_diff * 4;
            if quality < worst_quality {
                worst_quality = quality;
                replace_idx = i;
            }
        }

        let packed = Self::pack_data(score, depth, flag, cur_age, best_move);
        let target = &cluster.slots[replace_idx];
        target.data.store(packed, Ordering::Relaxed);
        target.key_xor_data.store(hash ^ packed, Ordering::Relaxed);
    }
}
