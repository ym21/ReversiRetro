const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine');

function play(board, player, square) {
  const point = E.parseCoord(square);
  const moved = E.apply(board, player, point.row, point.column);
  return {
    board: moved.board,
    event: {
      player,
      type: 'MOVE',
      square,
      flips: moved.flips.map(([row, column]) => E.coord(row, column)),
    },
  };
}

function deterministicGame(plies) {
  let board = E.initial.slice();
  let side = 'B';
  const events = [];
  for (let turn = 0; turn < plies; turn += 1) {
    let moves = E.legal(board, side);
    if (moves.length === 0) {
      if (E.legal(board, E.opposite(side)).length === 0) break;
      events.push({ player: side, type: 'PASS' });
      side = E.opposite(side);
      moves = E.legal(board, side);
    }
    const move = moves[(turn * 7 + 3) % moves.length];
    const next = E.apply(board, side, move.row, move.column);
    events.push({
      player: side,
      type: 'MOVE',
      square: E.coord(move.row, move.column),
      flips: next.flips.map(([row, column]) => E.coord(row, column)),
    });
    board = next.board;
    side = E.opposite(side);
  }
  return { board, events, side };
}

test('initial legal moves and forward application', () => {
  const moves = E.legal(E.initial, 'B');
  assert.equal(moves.length, 4);
  const result = E.apply(E.initial, 'B', 2, 3); // D3
  assert.equal(result.board[2][3], 'B');
  assert.equal(result.board[3][3], 'B');
  assert.deepEqual(result.flips, [[3, 3]]);
});

test('multi-direction flips and illegal moves', () => {
  const board = [
    '........',
    '...B....',
    '...W....',
    '....WB..',
    '....W...',
    '.....B..',
    '........',
    '........',
  ];
  const moved = E.apply(board, 'B', 3, 3);
  assert.equal(moved.flips.length, 3); // north, east, and south-east
  assert.deepEqual(moved.flips, [[2, 3], [3, 4], [4, 4]]);
  assert.throws(() => E.apply(E.initial, 'B', 0, 0), /illegal move/);
});

test('input and terminal validation', () => {
  assert.equal(E.validate(['........', '........', '........', '...WB...', '...B....', '........', '........', '........']), 'at least four stones required');
  assert.equal(E.validate(['B.......', '........', '........', '...WB...', '...B....', '........', '........', '........']), 'initial four squares cannot be empty');
  assert.equal(E.validate(E.initial, { positionType: 'terminal' }), 'board is not terminal');
  const terminal = ['B.......', '........', '........', '...BB...', '...BB...', '........', '........', '........'];
  assert.equal(E.validate(terminal, { positionType: 'terminal' }), null);
  assert.equal(E.reconstruct(terminal, { positionType: 'terminal', maxMs: 500 }).status, 'UNREACHABLE_PROVEN');
});

test('reverse predecessor property holds for generated moves', () => {
  let board = E.initial.slice();
  let side = 'B';
  for (let turn = 0; turn < 12; turn += 1) {
    const move = E.legal(board, side)[(turn * 5 + 1) % E.legal(board, side).length];
    const next = E.apply(board, side, move.row, move.column);
    const after = next.board;
    const predecessors = E.generatePredecessors(after, E.opposite(side));
    assert.ok(
      predecessors.some((candidate) => candidate.sideToMove === side && candidate.board.join('/') === board.join('/')),
      `turn ${turn + 1} ${E.coord(move.row, move.column)} was not reversible`,
    );
    board = after;
    side = E.opposite(side);
  }
});

test('reverse candidates use an internal anchor, not the cell after the whole run', () => {
  const predecessor = [
    '.WBB....',
    '........',
    '........',
    '...WB...',
    '...BW...',
    '........',
    '........',
    '........',
  ];
  const current = E.apply(predecessor, 'B', 0, 0).board;
  const candidates = E.generatePredecessors(current, 'W');
  assert.ok(candidates.some((candidate) => candidate.board.join('/') === predecessor.join('/')));
});

test('replay enforces move, flip, and pass legality', () => {
  const game = deterministicGame(8);
  const replayed = E.replay(game.events);
  assert.deepEqual(replayed.board, game.board);
  assert.equal(replayed.snapshots.length, game.events.length + 1);

  const passBoard = [
    'BBBBBBBB',
    'BBBWWWBB',
    'BBBWWBBB',
    'WBWWBWBW',
    'WBBWBBWW',
    'WWBWBWWW',
    'WWBBWWWW',
    'WWWWWWW.',
  ];
  assert.equal(E.legal(passBoard, 'W').length, 0);
  assert.ok(E.legal(passBoard, 'B').length > 0);
  const passed = E.replay([{ player: 'W', type: 'PASS' }], { start: passBoard, sideToMove: 'W' });
  assert.equal(passed.sideToMove, 'B');
  assert.throws(() => E.replay([{ player: 'B', type: 'PASS' }]), /pass is only legal/);
  assert.throws(() => E.replay([{ player: 'B', type: 'MOVE', square: 'D3', flips: ['A1'] }]), /event flips/);
});

test('short-game reconstruction is replay-verified', () => {
  const target = deterministicGame(7).board;
  const result = E.reconstruct(target, { positionType: 'any', maxMs: 1000, maxNodes: 100000 });
  assert.equal(result.status, 'FOUND');
  assert.ok(result.solution.events.length > 0);
  assert.deepEqual(E.replay(result.solution.events).board, target);
});

test('initial base case requires Black to move', () => {
  assert.equal(E.reconstruct(E.initial, { positionType: 'any', sideToMove: 'B' }).status, 'FOUND');
  assert.equal(E.reconstruct(E.initial, { positionType: 'any', sideToMove: 'W' }).status, 'UNREACHABLE_PROVEN');
});

test('timeout and cancellation are not reported as proofs', () => {
  const target = deterministicGame(8).board;
  assert.equal(E.reconstruct(target, { positionType: 'any', maxNodes: 0, maxMs: 1000 }).status, 'UNKNOWN_TIMEOUT');
  let calls = 0;
  assert.equal(E.reconstruct(target, {
    positionType: 'any',
    maxNodes: 100000,
    maxMs: 1000,
    cancelled: () => calls++ > 0,
  }).status, 'CANCELLED');
});

test('unlimited mode ignores finite zero budgets', () => {
  const target = deterministicGame(6).board;
  const result = E.reconstruct(target, {
    positionType: 'any',
    unlimited: true,
    maxNodes: 0,
    maxMs: 0,
  });
  assert.equal(result.status, 'FOUND');
  assert.deepEqual(E.replay(result.solution.events).board, target);
});

test('bounded cache evicts old failures without losing reachable solutions', () => {
  const target = deterministicGame(11).board;
  const result = E.reconstruct(target, {
    positionType: 'any',
    unlimited: true,
    maxCacheEntries: 1,
  });
  assert.equal(result.status, 'FOUND');
  assert.ok(result.cacheEvictions > 0);
  assert.deepEqual(E.replay(result.solution.events).board, target);
});

test('several deterministic reachable positions reconstruct', () => {
  for (const plies of [2, 3, 4, 5, 6, 9, 11]) {
    const target = deterministicGame(plies).board;
    const result = E.reconstruct(target, { positionType: 'any', maxMs: 1000, maxNodes: 100000 });
    assert.equal(result.status, 'FOUND', `plies=${plies} status=${result.status}`);
    assert.deepEqual(E.replay(result.solution.events).board, target);
  }
});
