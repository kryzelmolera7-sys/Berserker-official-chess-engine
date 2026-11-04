#!/usr/bin/env python3
"""
===============================================================================
Berserker v0.2.0 NNUE Trainer & Quantizer
===============================================================================
Architecture:
- HalfKP-Dual-1536 (Feature Transformer: 40,960 -> 1536 dual perspective)
- SCReLU (Squared Clipped ReLU): clamp(x, 0, 1)^2
- L1 Layer: 3072 -> 32
- Output Layer: 32 -> 1 (Centipawns)
- Quantization & Serialization: Direct export into Berserker .nnue binary format
===============================================================================
Usage:
  python scripts/train_nnue.py --data data/training_data.plain --epochs 5 --output berserker_dual_net_ep9_b400.nnue
===============================================================================
"""

import os
import sys
import argparse
import struct
import math
import numpy as np

try:
    import torch
    import torch.nn as nn
    import torch.optim as optim
    from torch.utils.data import Dataset, DataLoader
except ImportError:
    print("PyTorch is required for NNUE training. Install with: pip install torch numpy")
    sys.exit(1)

# -----------------------------------------------------------------------------
# HalfKP Feature Index Constants
# -----------------------------------------------------------------------------
# 64 King squares * (10 non-king piece types * 64 board squares) = 40,960 features
NUM_KING_SQ = 64
NUM_PIECES = 10
NUM_BOARD_SQ = 64
NUM_FEATURES = NUM_KING_SQ * NUM_PIECES * NUM_BOARD_SQ # 40,960

PIECE_TYPE_MAP = {
    'P': 0, 'N': 1, 'B': 2, 'R': 3, 'Q': 4,
    'p': 5, 'n': 6, 'b': 7, 'r': 8, 'q': 9
}

def parse_fen_to_halfkp(fen):
    """
    Parses a FEN string and returns active HalfKP indices for White and Black perspective.
    """
    parts = fen.strip().split(' ')
    board_str = parts[0]
    side = parts[1] # 'w' or 'b'
    
    rows = board_str.split('/')
    white_king_sq = -1
    black_king_sq = -1
    pieces = [] # (piece_char, sq_0_to_63)
    
    for r_idx, row in enumerate(rows):
        rank = 7 - r_idx
        file_idx = 0
        for char in row:
            if char.isdigit():
                file_idx += int(char)
            else:
                sq = rank * 8 + file_idx
                if char == 'K':
                    white_king_sq = sq
                elif char == 'k':
                    black_king_sq = sq
                else:
                    pieces.append((char, sq))
                file_idx += 1
                
    if white_king_sq == -1 or black_king_sq == -1:
        return [], []
        
    white_indices = []
    black_indices = []
    
    # White perspective:
    for char, sq in pieces:
        p_type = PIECE_TYPE_MAP.get(char)
        if p_type is not None:
            idx_w = white_king_sq * (NUM_PIECES * NUM_BOARD_SQ) + p_type * NUM_BOARD_SQ + sq
            white_indices.append(idx_w)
            
    # Black perspective (horizontally/vertically mirrored):
    mirrored_bk = black_king_sq ^ 56
    for char, sq in pieces:
        # Swap colors for black perspective
        mirrored_sq = sq ^ 56
        swapped_char = char.swapcase()
        p_type = PIECE_TYPE_MAP.get(swapped_char)
        if p_type is not None:
            idx_b = mirrored_bk * (NUM_PIECES * NUM_BOARD_SQ) + p_type * NUM_BOARD_SQ + mirrored_sq
            black_indices.append(idx_b)
            
    return white_indices, black_indices

# -----------------------------------------------------------------------------
# Dataset Loader
# -----------------------------------------------------------------------------
class PlainMarlinDataset(Dataset):
    def __init__(self, data_file, max_samples=100000):
        self.samples = []
        if not os.path.exists(data_file):
            print(f"Warning: Data file {data_file} not found. Generating synthetic bootstrap samples.")
            self._generate_synthetic_samples()
            return

        with open(data_file, 'r', encoding='utf-8') as f:
            for line in f:
                parts = line.strip().split('|')
                if len(parts) >= 3:
                    fen = parts[0].strip()
                    eval_cp = float(parts[1].strip())
                    wdl = float(parts[2].strip())
                    self.samples.append((fen, eval_cp, wdl))
                    if len(self.samples) >= max_samples:
                        break
                        
        if len(self.samples) == 0:
            self._generate_synthetic_samples()
            
    def _generate_synthetic_samples(self):
        fens = [
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "r1bqkb1r/pp2pppp/2np1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 2 6",
            "r1bqk1nr/pppp1ppp/2n5/b7/3PP3/2P2N2/P4PPP/RNBQKB1R b KQkq - 0 6",
            "rnbqk2r/ppp1bppp/4pn2/3p2B1/2PP4/2N5/PP2PPPP/R2QKBNR w KQkq - 4 5",
            "r1bq1rk1/pp2ppbp/2np1np1/8/3NP3/2N1BP2/PPPQ2PP/R3KB1R w KQ - 1 9"
        ]
        for i in range(200):
            fen = fens[i % len(fens)]
            self.samples.append((fen, float((i % 40) - 20) * 10, 0.5))

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        fen, eval_cp, wdl = self.samples[idx]
        w_feats, b_feats = parse_fen_to_halfkp(fen)
        is_white = 1.0 if ' w ' in fen else 0.0
        # Target blended score: sigmoid normalized target
        # Sigmoid(cp / 400) blended with WDL
        target_score = 1.0 / (1.0 + math.exp(-eval_cp / 400.0))
        blended_target = 0.7 * target_score + 0.3 * wdl
        return w_feats, b_feats, is_white, blended_target

def collate_sparse_halfkp(batch):
    batch_size = len(batch)
    is_white_tensor = torch.zeros(batch_size, dtype=torch.float32)
    target_tensor = torch.zeros(batch_size, 1, dtype=torch.float32)
    
    w_indices_list = []
    b_indices_list = []
    
    for b_idx, (w_feats, b_feats, is_white, target) in enumerate(batch):
        is_white_tensor[b_idx] = is_white
        target_tensor[b_idx, 0] = target
        for f in w_feats:
            w_indices_list.append((b_idx, f))
        for f in b_feats:
            b_indices_list.append((b_idx, f))
            
    # Sparse feature matrix
    if len(w_indices_list) == 0:
        w_indices_list.append((0, 0))
    if len(b_indices_list) == 0:
        b_indices_list.append((0, 0))
        
    w_idx = torch.tensor(w_indices_list, dtype=torch.int64).t()
    b_idx = torch.tensor(b_indices_list, dtype=torch.int64).t()
    
    w_sparse = torch.sparse_coo_tensor(w_idx, torch.ones(w_idx.size(1)), torch.Size([batch_size, NUM_FEATURES])).coalesce()
    b_sparse = torch.sparse_coo_tensor(b_idx, torch.ones(b_idx.size(1)), torch.Size([batch_size, NUM_FEATURES])).coalesce()
    
    return w_sparse, b_sparse, is_white_tensor, target_tensor

# -----------------------------------------------------------------------------
# HalfKP-Dual-1536 Architecture with SCReLU
# -----------------------------------------------------------------------------
class SCReLU(nn.Module):
    """Squared Clipped ReLU: clamp(x, 0, 1)^2"""
    def forward(self, x):
        clamped = torch.clamp(x, 0.0, 1.0)
        return clamped * clamped

class BerserkerHalfKPNnue(nn.Module):
    def __init__(self, half_dim=1536, l1_dim=32):
        super().__init__()
        self.half_dim = half_dim
        # Feature Transformer (40960 -> 1536)
        self.ft = nn.Linear(NUM_FEATURES, half_dim, bias=True)
        self.screlu = SCReLU()
        # Dual perspective output: 1536 + 1536 = 3072
        self.l1 = nn.Linear(half_dim * 2, l1_dim, bias=True)
        self.out = nn.Linear(l1_dim, 1, bias=True)

    def forward(self, w_features, b_features, is_white):
        acc_w = self.screlu(self.ft(w_features))
        acc_b = self.screlu(self.ft(b_features))
        
        # Orient dual perspective according to active side
        is_w_expanded = is_white.unsqueeze(1)
        us = is_w_expanded * acc_w + (1.0 - is_w_expanded) * acc_b
        them = is_w_expanded * acc_b + (1.0 - is_w_expanded) * acc_w
        
        x = torch.cat([us, them], dim=1)
        x = self.screlu(self.l1(x))
        pred_sigmoid = torch.sigmoid(self.out(x) / 400.0)
        return pred_sigmoid

# -----------------------------------------------------------------------------
# Binary .nnue Exporter & Quantizer
# -----------------------------------------------------------------------------
def export_quantized_nnue(model, output_path):
    """
    Serializes model into standard Berserker HalfKP .nnue format:
    - Magic header: 0x7E36 (Berserker / SF NNUE signature)
    - Feature Transformer weights: 40960 * 1536 int16 (quantized by 255)
    - Feature Transformer biases: 1536 int16
    - L1 weights: 3072 * 32 int8 (quantized by 64)
    - L1 biases: 32 int32
    - Output weights: 32 * 1 int8
    - Output bias: 1 int32
    """
    print(f"📦 Quantizing neural weights to HalfKP binary format: {output_path}...")
    
    with torch.no_grad():
        # 1. Feature Transformer weights (1536, 40960) -> int16
        ft_w = (model.ft.weight.cpu().numpy() * 255.0).clip(-32768, 32767).astype(np.int16)
        ft_b = (model.ft.bias.cpu().numpy() * 255.0).clip(-32768, 32767).astype(np.int16)
        
        # 2. L1 weights (32, 3072) -> int8
        l1_w = (model.l1.weight.cpu().numpy() * 64.0).clip(-128, 127).astype(np.int8)
        l1_b = (model.l1.bias.cpu().numpy() * (64.0 * 255.0)).clip(-2147483648, 2147483647).astype(np.int32)
        
        # 3. Output weights (1, 32) -> int8
        out_w = (model.out.weight.cpu().numpy() * 16.0).clip(-128, 127).astype(np.int8)
        out_b = (model.out.bias.cpu().numpy() * (16.0 * 64.0)).clip(-2147483648, 2147483647).astype(np.int32)

    with open(output_path, 'wb') as f:
        # Magic header (4 bytes: 'B', 'N', 'U', 'E' or 0x7E360002)
        f.write(struct.pack('<I', 0x7E360002))
        # Architecture identifier string length + string
        arch_id = b"Berserker-HalfKP-Dual-1536"
        f.write(struct.pack('<H', len(arch_id)))
        f.write(arch_id)
        # Dimensions
        f.write(struct.pack('<III', NUM_FEATURES, 1536, 32))
        
        # Serialized weights
        f.write(ft_w.tobytes())
        f.write(ft_b.tobytes())
        f.write(l1_w.tobytes())
        f.write(l1_b.tobytes())
        f.write(out_w.tobytes())
        f.write(out_b.tobytes())
        
    file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"✅ Successfully exported Berserker NNUE: {output_path} ({file_size_mb:.2f} MB)")
    return file_size_mb

# -----------------------------------------------------------------------------
# Main Training Loop
# -----------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Train Berserker v0.2.0 NNUE Network")
    parser.add_argument('--data', type=str, default='data/training_data.plain', help='Path to baked training data')
    parser.add_argument('--epochs', type=int, default=5, help='Number of training epochs')
    parser.add_argument('--batch-size', type=int, default=64, help='Batch size')
    parser.add_argument('--lr', type=float, default=0.001, help='Learning rate')
    parser.add_argument('--output', type=str, default='berserker_dual_net_ep9_b400.nnue', help='Output .nnue path')
    args = parser.parse_args()

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f"🚀 Initializing Berserker NNUE Training on: {device}")
    print(f"📊 Training Data Source: {args.data}")
    print(f"🔄 Epochs: {args.epochs} | Batch Size: {args.batch_size} | Learning Rate: {args.lr}")

    dataset = PlainMarlinDataset(args.data)
    dataloader = DataLoader(dataset, batch_size=args.batch_size, shuffle=True, collate_fn=collate_sparse_halfkp)

    model = BerserkerHalfKPNnue().to(device)
    total_params = sum(p.numel() for p in model.parameters())
    print(f"🧠 Model Architecture: HalfKP-Dual-1536 with SCReLU | Parameters: {total_params:,}")

    criterion = nn.MSELoss()
    optimizer = optim.Adam(model.parameters(), lr=args.lr, weight_decay=1e-5)

    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = 0.0
        batches = 0

        for w_sparse, b_sparse, is_white, targets in dataloader:
            w_dense = w_sparse.to_dense().to(device)
            b_dense = b_sparse.to_dense().to(device)
            is_white = is_white.to(device)
            targets = targets.to(device)

            optimizer.zero_grad()
            preds = model(w_dense, b_dense, is_white)
            loss = criterion(preds, targets)
            loss.backward()
            optimizer.step()

            total_loss += loss.item()
            batches += 1

        avg_loss = total_loss / max(1, batches)
        print(f"Epoch [{epoch}/{args.epochs}] -> Training Loss (MSE): {avg_loss:.6f}")

    # Export to .nnue
    export_quantized_nnue(model, args.output)

if __name__ == '__main__':
    main()
