mod accumulator;

pub use accumulator::threats::initialize;

use std::sync::Arc;

use crate::{
    board::{Board, BoardObserver},
    nnue::accumulator::{
        AccumulatorCache, PstAccumulator, ThreatAccumulator,
        threats::{push_threats_on_change, push_threats_on_move, push_threats_on_mutate},
    },
    numa::NumaReplicable,
    types::{Color, MAX_PLY, Move, Piece, PieceType, Square},
};

mod forward {
    #[cfg(any(
        target_feature = "avx2",
        target_feature = "neon",
        all(target_arch = "wasm32", target_feature = "simd128"),
    ))]
    mod vectorized;
    #[cfg(any(
        target_feature = "avx2",
        target_feature = "neon",
        all(target_arch = "wasm32", target_feature = "simd128"),
    ))]
    pub use vectorized::*;

    #[cfg(not(any(
        target_feature = "avx2",
        target_feature = "neon",
        all(target_arch = "wasm32", target_feature = "simd128"),
    )))]
    mod scalar;
    #[cfg(not(any(
        target_feature = "avx2",
        target_feature = "neon",
        all(target_arch = "wasm32", target_feature = "simd128"),
    )))]
    pub use scalar::*;
}

mod simd {
    #[cfg(target_feature = "avx512f")]
    mod avx512;
    #[cfg(target_feature = "avx512f")]
    pub use avx512::*;

    #[cfg(all(target_feature = "avx2", not(target_feature = "avx512f")))]
    mod avx2;
    #[cfg(all(target_feature = "avx2", not(target_feature = "avx512f")))]
    pub use avx2::*;

    #[cfg(all(target_feature = "neon", not(any(target_feature = "avx2", target_feature = "avx512f"))))]
    mod neon;
    #[cfg(all(target_feature = "neon", not(any(target_feature = "avx2", target_feature = "avx512f"))))]
    pub use neon::*;

    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    mod wasm;
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    pub use wasm::*;

    #[cfg(not(any(
        target_feature = "avx512f",
        target_feature = "avx2",
        target_feature = "neon",
        all(target_arch = "wasm32", target_feature = "simd128"),
    )))]
    mod scalar;
    #[cfg(not(any(
        target_feature = "avx512f",
        target_feature = "avx2",
        target_feature = "neon",
        all(target_arch = "wasm32", target_feature = "simd128"),
    )))]
    pub use scalar::*;
}

const NETWORK_SCALE: i32 = 380;

const INPUT_BUCKETS: usize = 10;
const OUTPUT_BUCKETS: usize = 8;

const L1_SIZE: usize = 768;
const L2_SIZE: usize = 16;
const L3_SIZE: usize = 32;

const FT_QUANT: i32 = 255;
const L1_QUANT: i32 = 64;

#[cfg(target_feature = "avx512f")]
const FT_SHIFT: u32 = 9;
#[cfg(not(target_feature = "avx512f"))]
const FT_SHIFT: i32 = 9;

const DEQUANT_MULTIPLIER: f32 = (1 << FT_SHIFT) as f32 / (FT_QUANT * FT_QUANT * L1_QUANT) as f32;

#[rustfmt::skip]
const INPUT_BUCKETS_LAYOUT: [u8; 64] = [
    0, 1, 2, 3, 3, 2, 1, 0,
    4, 5, 6, 7, 7, 6, 5, 4,
    8, 8, 8, 8, 8, 8, 8, 8,
    9, 9, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 9,
    9, 9, 9, 9, 9, 9, 9, 9,
];

#[rustfmt::skip]
pub const OUTPUT_BUCKETS_LAYOUT: [usize; 33] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1,
    2, 2, 2, 2,
    3, 3, 3,
    4, 4, 4,
    5, 5, 5,
    6, 6, 6,
    7, 7, 7, 7,
];

#[repr(align(16))]
#[derive(Clone, Copy)]
struct SparseEntry {
    indexes: [u16; 8],
    count: usize,
}

#[derive(Clone)]
pub struct Network {
    parameters: Arc<ParametersHandle>,
    index: usize,
    pst_stack: Box<[PstAccumulator]>,
    threat_stack: Box<[ThreatAccumulator]>,
    cache: AccumulatorCache,
    nnz_table: Box<[SparseEntry]>,
}

impl Network {
    pub fn new(parameters: Arc<ParametersHandle>) -> Self {
        let mut nnz_table = vec![SparseEntry { indexes: [0; 8], count: 0 }; 256];

        for (byte, entry) in nnz_table.iter_mut().enumerate() {
            let mut count = 0;

            for bit in 0..8 {
                if (byte & (1 << bit)) != 0 {
                    entry.indexes[count] = bit as u16;
                    count += 1;
                }
            }

            entry.count = count;
        }

        Self {
            parameters: parameters.clone(),
            index: 0,
            pst_stack: vec![PstAccumulator::new(&parameters); MAX_PLY].into_boxed_slice(),
            threat_stack: vec![ThreatAccumulator::new(); MAX_PLY].into_boxed_slice(),
            cache: AccumulatorCache::new(&parameters),
            nnz_table: nnz_table.into_boxed_slice(),
        }
    }

    pub fn push(&mut self, mv: Move, board: &Board) {
        debug_assert!(mv.is_present());

        self.index += 1;

        self.pst_stack[self.index].accurate = [false; 2];
        self.pst_stack[self.index].delta.mv = mv;
        self.pst_stack[self.index].delta.piece = board.piece_on(mv.from());
        self.pst_stack[self.index].delta.captured = board.piece_on(mv.to());

        self.threat_stack[self.index].accurate = [false; 2];
        self.threat_stack[self.index].delta.clear();
    }

    pub const fn pop(&mut self) {
        self.index -= 1;
    }

    pub fn full_refresh(&mut self, board: &Board) {
        let parameters = self.parameters.as_ref();

        self.pst_stack[self.index].refresh(board, Color::White, &mut self.cache, parameters);
        self.pst_stack[self.index].refresh(board, Color::Black, &mut self.cache, parameters);

        self.threat_stack[self.index].refresh(board, Color::White, parameters);
        self.threat_stack[self.index].refresh(board, Color::Black, parameters);
    }

    pub fn evaluate(&mut self, board: &Board) -> i32 {
        debug_assert!(self.pst_stack[0].accurate == [true; 2]);
        debug_assert!(self.threat_stack[0].accurate == [true; 2]);

        for pov in [Color::White, Color::Black] {
            if self.pst_stack[self.index].accurate[pov] && self.threat_stack[self.index].accurate[pov] {
                continue;
            }

            match self.can_update_pst(pov) {
                Some(index) => self.update_pst_accumulator(index, board, pov),
                None => self.pst_stack[self.index].refresh(board, pov, &mut self.cache, self.parameters.as_ref()),
            }

            match self.can_update_threats(pov) {
                Some(index) => self.update_threat_accumulator(index, board, pov),
                None => self.threat_stack[self.index].refresh(board, pov, self.parameters.as_ref()),
            }
        }

        self.output_transformer(board)
    }

    fn update_pst_accumulator(&mut self, accurate: usize, board: &Board, pov: Color) {
        let king = board.king_square(pov);
        let parameters = self.parameters.as_ref();

        for i in accurate..self.index {
            if let (prev, [current, ..]) = self.pst_stack.split_at_mut(i + 1) {
                current.update(&prev[i], board, king, pov, parameters);
            }
        }
    }

    fn update_threat_accumulator(&mut self, accurate: usize, board: &Board, pov: Color) {
        let king = board.king_square(pov);
        let parameters = self.parameters.as_ref();

        for i in accurate..self.index {
            if let (prev, [current, ..]) = self.threat_stack.split_at_mut(i + 1) {
                unsafe { current.update(&prev[i], king, pov, parameters) };
            }
        }
    }

    fn can_update_pst(&self, pov: Color) -> Option<usize> {
        for i in (0..=self.index).rev() {
            if self.pst_stack[i].accurate[pov] {
                return Some(i);
            }

            let delta = &self.pst_stack[i].delta;

            let from = delta.mv.from().relative_to(delta.piece.color());
            let to = delta.mv.to().relative_to(delta.piece.color());

            if delta.piece.piece_type() == PieceType::King
                && delta.piece.color() == pov
                && (from.is_kingside() != to.is_kingside() || INPUT_BUCKETS_LAYOUT[from] != INPUT_BUCKETS_LAYOUT[to])
            {
                return None;
            }
        }

        None
    }

    fn can_update_threats(&self, pov: Color) -> Option<usize> {
        for i in (0..=self.index).rev() {
            if self.threat_stack[i].accurate[pov] {
                return Some(i);
            }

            let delta = &self.pst_stack[i].delta;

            let from = delta.mv.from();
            let to = delta.mv.to();

            if delta.piece.piece_type() == PieceType::King
                && delta.piece.color() == pov
                && from.is_kingside() != to.is_kingside()
            {
                return None;
            }
        }

        None
    }

    fn output_transformer(&self, board: &Board) -> i32 {
        let bucket = OUTPUT_BUCKETS_LAYOUT[board.occupancies().popcount()];
        let parameters = self.parameters.as_ref();

        unsafe {
            let ft_out =
                forward::activate_ft(&self.pst_stack[self.index], &self.threat_stack[self.index], board.side_to_move());
            let (nnz_indexes, nnz_count) = forward::find_nnz(&ft_out, &self.nnz_table);

            let l1_out = forward::propagate_l1(&ft_out, &nnz_indexes[..nnz_count], bucket, parameters);
            let l2_out = forward::propagate_l2(&l1_out, bucket, parameters);
            let l3_out = forward::propagate_l3(&l2_out, bucket, parameters);

            (l3_out * NETWORK_SCALE as f32) as i32
        }
    }

    pub fn eval_with_bucket(&mut self, board: &Board, bucket: usize) -> i32 {
        self.full_refresh(board);
        self.evaluate(board); // just to update internal state

        let parameters = self.parameters.as_ref();

        unsafe {
            let ft_out =
                forward::activate_ft(&self.pst_stack[self.index], &self.threat_stack[self.index], board.side_to_move());
            let (nnz_indexes, nnz_count) = forward::find_nnz(&ft_out, &self.nnz_table);
            let l1_out = forward::propagate_l1(&ft_out, &nnz_indexes[..nnz_count], bucket, parameters);
            let l2_out = forward::propagate_l2(&l1_out, bucket, parameters);
            let l3_out = forward::propagate_l3(&l2_out, bucket, parameters);
            (l3_out * NETWORK_SCALE as f32) as i32
        }
    }

    pub fn piece_contribution(&mut self, board: &Board, sq: Square) -> Option<i32> {
        let piece = board.piece_on(sq);

        if piece == Piece::None || piece.piece_type() == PieceType::King {
            return None;
        }

        let baseline = self.evaluate(board);

        let mut board_without = board.clone();
        board_without.remove_piece(sq);

        self.full_refresh(&board_without);
        let without = self.evaluate(&board_without);

        self.full_refresh(board);
        self.evaluate(board);

        Some(baseline - without)
    }
}

impl BoardObserver for Network {
    fn on_piece_move(&mut self, board: &Board, piece: Piece, from: Square, to: Square) {
        push_threats_on_move(&mut self.threat_stack[self.index], board, piece, from, to);
    }

    fn on_piece_mutate(&mut self, board: &Board, old_piece: Piece, new_piece: Piece, square: Square) {
        push_threats_on_mutate(&mut self.threat_stack[self.index], board, old_piece, new_piece, square);
    }

    fn on_piece_change(&mut self, board: &Board, piece: Piece, square: Square, add: bool) {
        push_threats_on_change(&mut self.threat_stack[self.index], board, piece, square, add);
    }
}

#[repr(C)]
pub struct Parameters {
    ft_threat_weights: Aligned<[[i8; L1_SIZE]; 66864]>,
    ft_piece_weights: Aligned<[[i16; L1_SIZE]; INPUT_BUCKETS * 768]>,
    ft_biases: Aligned<[i16; L1_SIZE]>,
    l1_weights: Aligned<[[i8; L2_SIZE * L1_SIZE]; OUTPUT_BUCKETS]>,
    l1_biases: Aligned<[[f32; L2_SIZE]; OUTPUT_BUCKETS]>,
    l2_weights: Aligned<[[[f32; L3_SIZE]; L2_SIZE]; OUTPUT_BUCKETS]>,
    l2_biases: Aligned<[[f32; L3_SIZE]; OUTPUT_BUCKETS]>,
    l3_weights: Aligned<[[f32; L3_SIZE]; OUTPUT_BUCKETS]>,
    l3_biases: Aligned<[f32; OUTPUT_BUCKETS]>,
}

pub const PARAMETERS_BYTES: usize = std::mem::size_of::<Parameters>();
const _: () = assert!(PARAMETERS_BYTES == 63_266_880);

pub const NETWORK_NAME: &str = "v60-7f587dfb.nnue";
pub const NETWORK_URL: &str =
    "https://github.com/codedeliveryservice/RecklessNetworks/releases/download/networks/v60-7f587dfb.nnue";

#[repr(C, align(64))]
struct RuntimeParametersStorage {
    data: std::cell::UnsafeCell<std::mem::MaybeUninit<Parameters>>,
}

unsafe impl Sync for RuntimeParametersStorage {}

static RUNTIME_PARAMETERS: RuntimeParametersStorage = RuntimeParametersStorage {
    data: std::cell::UnsafeCell::new(std::mem::MaybeUninit::zeroed()),
};
static NNUE_LOADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn is_loaded() -> bool {
    NNUE_LOADED.load(std::sync::atomic::Ordering::Acquire)
}

pub fn params_mut_ptr() -> *mut u8 {
    RUNTIME_PARAMETERS.data.get().cast::<u8>()
}

#[allow(dead_code)]
pub const fn params_size() -> usize {
    PARAMETERS_BYTES
}

pub fn mark_loaded() {
    NNUE_LOADED.store(true, std::sync::atomic::Ordering::Release);
}

#[cfg(not(target_arch = "wasm32"))]
pub fn load_from_file(path: &std::path::Path) -> Result<usize, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    let meta = file.metadata().map_err(|e| format!("Failed to stat {}: {e}", path.display()))?;
    if meta.len() as usize != PARAMETERS_BYTES {
        return Err(format!(
            "Invalid NNUE size for {}: got {} bytes, expected {}",
            path.display(),
            meta.len(),
            PARAMETERS_BYTES
        ));
    }
    let dst = unsafe { std::slice::from_raw_parts_mut(params_mut_ptr(), PARAMETERS_BYTES) };
    file.read_exact(dst).map_err(|e| format!("Failed reading {}: {e}", path.display()))?;
    mark_loaded();
    Ok(PARAMETERS_BYTES)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn ensure_native_nnue_loaded() -> Result<std::path::PathBuf, String> {
    use std::path::PathBuf;
    if is_loaded() {
        return Ok(PathBuf::from(NETWORK_NAME));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(env_path) = std::env::var("EVALFILE")
        && !env_path.trim().is_empty()
    {
        candidates.push(PathBuf::from(env_path));
    }
    candidates.push(PathBuf::from("storage/nn-cache").join(NETWORK_NAME));
    candidates.push(PathBuf::from("networks").join(NETWORK_NAME));
    candidates.push(PathBuf::from("reckless/networks").join(NETWORK_NAME));
    candidates.push(PathBuf::from(NETWORK_NAME));
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join(NETWORK_NAME));
        candidates.push(dir.join("..").join("storage/nn-cache").join(NETWORK_NAME));
    }

    for cand in &candidates {
        if let Ok(meta) = std::fs::metadata(cand)
            && meta.len() as usize == PARAMETERS_BYTES
            && load_from_file(cand).is_ok()
        {
            return Ok(cand.clone());
        }
    }

    let cache_dir = PathBuf::from("storage/nn-cache");
    let _ = std::fs::create_dir_all(&cache_dir);
    let target_path = cache_dir.join(NETWORK_NAME);
    let tmp_path = cache_dir.join(format!("{NETWORK_NAME}.tmp.{}", std::process::id()));

    let status = std::process::Command::new("curl")
        .arg("-sfL")
        .arg("-o")
        .arg(&tmp_path)
        .arg(NETWORK_URL)
        .status()
        .map_err(|e| format!("Failed to spawn curl: {e}"))?;

    if !status.success() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to auto-download {NETWORK_NAME} from {NETWORK_URL}"));
    }

    let size_ok = std::fs::metadata(&tmp_path).map(|m| m.len() as usize == PARAMETERS_BYTES).unwrap_or(false);
    if !size_ok {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Downloaded {NETWORK_NAME} had unexpected byte length"));
    }

    std::fs::rename(&tmp_path, &target_path).map_err(|e| format!("Failed saving NNUE: {e}"))?;
    load_from_file(&target_path)?;
    Ok(target_path)
}

impl Parameters {
    fn embedded() -> &'static Self {
        unsafe { &*RUNTIME_PARAMETERS.data.get().cast::<Self>() }
    }

    fn allocate_owned() -> Arc<Self> {
        let mut boxed = Box::<std::mem::MaybeUninit<Self>>::new(std::mem::MaybeUninit::uninit());
        let ptr = boxed.as_mut_ptr();
        std::mem::forget(boxed);

        unsafe {
            std::ptr::copy_nonoverlapping(Self::embedded() as *const Self, ptr, 1);
            Arc::from(Box::from_raw(ptr))
        }
    }
}

#[derive(Clone)]
pub struct ParametersHandle {
    inner: ParametersStorage,
}

#[derive(Clone)]
enum ParametersStorage {
    Embedded(&'static Parameters),
    Owned(Arc<Parameters>),
}

impl ParametersHandle {
    fn embedded() -> Self {
        Self { inner: ParametersStorage::Embedded(Parameters::embedded()) }
    }

    const fn owned(parameters: Arc<Parameters>) -> Self {
        Self { inner: ParametersStorage::Owned(parameters) }
    }
}

impl std::ops::Deref for ParametersHandle {
    type Target = Parameters;

    fn deref(&self) -> &Self::Target {
        match &self.inner {
            ParametersStorage::Embedded(parameters) => parameters,
            ParametersStorage::Owned(parameters) => parameters.as_ref(),
        }
    }
}

impl NumaReplicable for ParametersHandle {
    fn allocate() -> Arc<Self> {
        Arc::new(Self::owned(Parameters::allocate_owned()))
    }

    fn allocate_shared() -> Option<Arc<Self>> {
        Arc::new(Self::embedded()).into()
    }
}

#[repr(align(64))]
#[derive(Copy, Clone)]
struct Aligned<T> {
    data: T,
}

impl<T> Aligned<T> {
    pub const fn new(data: T) -> Self {
        Self { data }
    }
}

impl<T> std::ops::Deref for Aligned<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.data
    }
}

impl<T> std::ops::DerefMut for Aligned<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.data
    }
}
