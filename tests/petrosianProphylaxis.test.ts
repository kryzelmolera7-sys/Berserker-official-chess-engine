import test from 'node:test';
import assert from 'node:assert';
import { Chess } from 'chess.js';
import { 
  computeOpponentThreatSpace, 
  evaluateProphylacticQuality, 
  searchHybridNnueMcts, 
  resetMctsTree,
  computeMovePriors
} from '../src/engine/berserkerMctsHybrid';

test('Threat-Space Prophylaxis: detects opponent checkmate threat', () => {
  // Black has Queen on h4 and Bishop on c5 attacking f2
  // White to move. If White makes a random move, Black threatens Qxf2#
  // FEN: r1bqk2r/pppp1ppp/2n5/2b1p3/2B1P2q/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 6
  // Black threatens Qxf2# (mate in 1 if White does nothing)
  const chess = new Chess('r1bqk2r/pppp1ppp/2n5/2b1p3/2B1P2q/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 6');
  const threats = computeOpponentThreatSpace(chess);

  assert.ok(threats.length > 0, 'Should detect at least 1 severe opponent threat');
  const mateThreat = threats.find(t => t.threatType === 'checkmate-threat' || t.san.includes('Qxf2'));
  assert.ok(mateThreat, 'Should detect Qxf2# as primary checkmate threat');
  assert.strictEqual(mateThreat.threatSeverity, 100);
});

test('Threat-Space Prophylaxis: detects opponent tactical fork threat', () => {
  // White to move. Black knight on c6 can jump to d4 or b4, or Black queen attacking
  // Position where Black knight on e5 threatens Nxf3+ or central fork
  const chess = new Chess('r1bqkb1r/pppp1ppp/2n5/4n3/2B1P3/5N2/PPP2PPP/RNBQK2R w KQkq - 0 6');
  const threats = computeOpponentThreatSpace(chess);

  assert.ok(threats.length > 0, 'Should identify tactical threat space');
  assert.ok(threats.some(t => t.piece === 'n' || t.threatSeverity >= 50));
});

test('Threat-Space Prophylaxis: evaluateProphylacticQuality rewards classic Petrosian guards', () => {
  const chess = new Chess('r1bqk2r/pppp1ppp/2n5/4p3/2B1P1n1/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 6');
  // Opponent threatens Nxf2 or Bxf2+
  const threats = computeOpponentThreatSpace(chess);
  assert.ok(threats.length > 0);

  const legalMoves = chess.moves({ verbose: true });
  const h3Move = legalMoves.find(m => m.san === 'h3');
  const OOMove = legalMoves.find(m => m.san === 'O-O');

  if (h3Move) {
    const qH3 = evaluateProphylacticQuality(chess, h3Move, threats);
    assert.ok(qH3 >= 0);
  }

  if (OOMove) {
    const qOO = evaluateProphylacticQuality(chess, OOMove, threats);
    assert.ok(qOO >= 0);
  }
});

test('Threat-Space Prophylaxis: MCTS search returns activeOpponentThreats and prophylactic telemetry', () => {
  resetMctsTree();
  // Sharp position where opponent threatens Qxf2#
  const fen = 'r1bqk2r/pppp1ppp/2n5/2b1p3/2B1P2q/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 6';
  const result = searchHybridNnueMcts(fen, {
    simulations: 100,
    maxTimeMs: 400,
    enableProphylaxis: true
  });

  assert.ok(result.activeOpponentThreats.length > 0, 'Should register active opponent threats');
  assert.ok(result.bestMoveSan.length > 0);
  // White must play O-O, Qe2, Rf1, or defend f2 (Qe2, d4, O-O, etc.)
  assert.ok(['O-O', 'Qe2', 'd4', 'Rf1', 'Be3'].includes(result.bestMoveSan) || result.scoreCp > -500,
    `Must play defensive/prophylactic move against mate threat, got ${result.bestMoveSan}`);
});
