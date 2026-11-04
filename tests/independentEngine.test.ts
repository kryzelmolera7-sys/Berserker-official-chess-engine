import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  searchIndependentBerserker, 
  evaluateBerserker090Baseline 
} from '../src/engine/berserkerIndependentSearch';
import { 
  MASTER_OPENING_SUITE, 
  FREE_HARDWARE_PROFILES, 
  runSelfPlayMatch, 
  getColabTrainingScript 
} from '../src/engine/selfPlayGenerator';

test('Independent Berserker: finds instant tactical checkmate without Stockfish', () => {
  // Scholar's mate delivery: Qxf7#
  const fen = 'r1bqkb1r/pppp1ppp/2n5/4p3/2B1n3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 5';
  const result = searchIndependentBerserker(fen, 2, 500);

  assert.ok(result.nodes > 0, 'Must search nodes');
  assert.ok(result.bestMoveSan.includes('Qxf7') || result.scoreCp > 1000, 'Should find or prioritize Qxf7 mating threat');
  assert.equal(typeof result.nps, 'number');
  assert.ok(result.pv.length > 0, 'Must have principal variation');
});

test('Independent Berserker: searches starting position with positive NPS and non-empty PV', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const result = searchIndependentBerserker(startFen, 2, 400);

  assert.ok(result.nodes > 10, 'Search should visit tree nodes');
  assert.ok(result.bestMoveSan.length > 0, 'Must return a valid best move');
  assert.ok(['e4', 'd4', 'Nf3', 'c4'].includes(result.bestMoveSan), 'Should suggest standard opening move');
  assert.ok(result.evalDetails.screluActivationSum > 0, 'Should activate HalfKP SCReLU tensor');
});

test('Berserker 0.9.0 Baseline: returns classical HCE score and best move', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const baseline = evaluateBerserker090Baseline(startFen);

  assert.equal(typeof baseline.scoreCp, 'number');
  assert.ok(baseline.bestMoveSan.length > 0);
  assert.ok(baseline.bestMoveUci.length >= 4);
});

test('Self-Play Opening Suite: has diverse tactical and strategic categories', () => {
  assert.ok(MASTER_OPENING_SUITE.length >= 10, 'Must have at least 10 openings');

  const categories = new Set(MASTER_OPENING_SUITE.map((o) => o.category));
  assert.ok(categories.has('Aggressive-Gambit'), 'Must include Aggressive-Gambit');
  assert.ok(categories.has('Dynamic-Sicilian'), 'Must include Dynamic-Sicilian');
  assert.ok(categories.has('Solid-Defensive'), 'Must include Solid-Defensive');
  assert.ok(categories.has('Hypermodern'), 'Must include Hypermodern');

  const kingsGambit = MASTER_OPENING_SUITE.find((o) => o.id === 'kings-gambit');
  assert.ok(kingsGambit);
  assert.equal(kingsGambit?.eco, 'C37');
});

test('Self-Play Match Simulator: plays full game and emits position records', () => {
  const game = runSelfPlayMatch('kings-gambit', 12, 'tabula-rasa');

  assert.ok(game.totalPlies > 0, 'Must generate plies');
  assert.ok(game.positions.length > 0, 'Must record position data');
  assert.ok(['1-0', '0-1', '1/2-1/2', '*'].includes(game.result), 'Must have valid outcome');
  assert.ok(game.positions[0].fen.length > 10, 'Position must have valid FEN');
  assert.ok(game.avgScreluDensity > 0, 'Should have positive average SCReLU density');
  assert.equal(game.matchMode, 'tabula-rasa');
  assert.equal(game.externalDataContamination, '0.00% (Strict TCEC Compliant)');
  assert.equal(game.positions[0].dataOrigin, '100% In-Engine Tabula Rasa');
});

test('Hardware Throughput Profiles: Colab and Kaggle free specs are defined', () => {
  assert.equal(FREE_HARDWARE_PROFILES.length, 3);
  const colab = FREE_HARDWARE_PROFILES.find((p) => p.hardwareName.includes('Colab'));
  assert.ok(colab);
  assert.ok(colab.positionsPerSec > 20000);
  assert.ok(colab.positionsPerDay.includes('Billion'));
});

test('Colab Training Script: generates valid Python script with cutechess-cli and PyTorch HalfKP', () => {
  const script = getColabTrainingScript();
  assert.ok(script.includes('class BerserkerHalfKPNnue'), 'Must define BerserkerHalfKPNnue');
  assert.ok(script.includes('class SCReLU'), 'Must define SCReLU activation');
  assert.ok(script.includes('cutechess-cli'), 'Must include cutechess-cli match runner');
  assert.ok(script.includes('berserker_core.cpp'), 'Must emit inline clean-room C++ engine');
  assert.ok(!script.includes('git clone https://github.com/jhonnold/berserk.git'), 'Must NOT clone Jay Honnold repo');
});

test('Blind Position Rescorer: evaluates external tournament positions with zero teacher distillation', async () => {
  const { TOURNAMENT_RAW_FENS, rescoreBlindPosition } = await import('../src/engine/rescorePipeline');
  assert.ok(TOURNAMENT_RAW_FENS.length >= 8, 'Must have at least 8 raw tournament positions');
  
  const testPos = TOURNAMENT_RAW_FENS[0];
  const rescored = rescoreBlindPosition(testPos, 2, 40);

  assert.equal(rescored.externalEvaluation, null, 'External eval must be null to prevent teacher distillation');
  assert.ok(typeof rescored.berserkerEvalCp === 'number', 'Must compute centipawn eval with Berserker search');
  assert.ok(rescored.berserkerBestMoveSan.length > 0, 'Must output best move from Berserker search');
  assert.ok(rescored.berserkerNodes > 0, 'Must visit search nodes');
  assert.equal(rescored.complianceStatus, '100% TCEC Legal: Zero Teacher Distillation');
});

test('Dual Training Step: computes realistic loss decay across self-play and rescored streams', async () => {
  const { computeDualTrainingStep } = await import('../src/engine/rescorePipeline');
  const step0 = computeDualTrainingStep(0, 1, 1000, 1000);
  const step5 = computeDualTrainingStep(5, 20, 20000, 20000);

  assert.ok(step0.currentLoss > step5.currentLoss, 'Loss must decrease over training epochs');
  assert.ok(step0.validationLoss > step5.validationLoss, 'Validation loss must track training loss');
  assert.ok(step0.learningRate > step5.learningRate, 'Learning rate must decay');
  assert.equal(step0.totalPositions, 2000);
});

test('Dual Colab Script: configures cutechess and blind rescorer simultaneously', async () => {
  const { getDualColabScript } = await import('../src/engine/rescorePipeline');
  const script = getDualColabScript();

  assert.ok(script.includes('cutechess'), 'Must configure Stream 1 cutechess');
  assert.ok(script.includes('rescore_fen_blindly'), 'Must configure Stream 2 blind rescorer');
  assert.ok(script.includes('BerserkerDualNNUE'), 'Must define dual output architecture');
  assert.ok(script.includes('MSELoss'), 'Must use MSE evaluation loss');
  assert.ok(script.includes('CrossEntropyLoss'), 'Must use WDL cross-entropy loss');
});
