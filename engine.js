/*
 * Small, dependency-free Othello rules and reverse reconstruction engine.
 *
 * The module is deliberately usable from both Node and a Web Worker. Keep the
 * board representation boring (eight strings) here: it makes the replay-proof
 * and the UI easy to inspect, while leaving room for a bit-board
 * implementation later if profiling says it is needed.
 */

const DIRECTIONS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],   [1, 1],
];

const INITIAL = [
  '........',
  '........',
  '........',
  '...WB...',
  '...BW...',
  '........',
  '........',
  '........',
];

const INITIAL_SQUARES = new Set(['D4', 'E4', 'D5', 'E5']);
const VALID_PLAYERS = new Set(['B', 'W']);

// The standard opening position is unchanged by these four D4 symmetries.
// The other four geometric symmetries exchange the opening colours, so they
// cannot be used for a colour-preserving transposition key.
const COLOR_PRESERVING_SYMMETRIES = Object.freeze([
  Object.freeze({ name: 'identity', transform: (row, column) => [row, column] }),
  Object.freeze({ name: 'rotate180', transform: (row, column) => [7 - row, 7 - column] }),
  Object.freeze({ name: 'transpose', transform: (row, column) => [column, row] }),
  Object.freeze({ name: 'antiTranspose', transform: (row, column) => [7 - column, 7 - row] }),
]);

function opposite(player) {
  if (player === 'B') return 'W';
  if (player === 'W') return 'B';
  throw new Error('player must be B or W');
}

function parse(board) {
  if (!Array.isArray(board) || board.length !== 8 || board.some(
    (row) => typeof row !== 'string' || row.length !== 8 || !/^[BW.]+$/.test(row),
  )) {
    throw new Error('board must be 8 rows of B/W/.');
  }
  return board.slice();
}

function boardKey(board) {
  return board.join('/');
}

function transformParsedBoard(source, symmetry) {
  const selected = typeof symmetry === 'string'
    ? COLOR_PRESERVING_SYMMETRIES.find((item) => item.name === symmetry)
    : symmetry;
  if (!selected || typeof selected.transform !== 'function') {
    throw new Error('unknown color-preserving symmetry');
  }

  const result = Array.from({ length: 8 }, () => Array(8).fill('.'));
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const [nextRow, nextColumn] = selected.transform(row, column);
      result[nextRow][nextColumn] = source[row][column];
    }
  }
  return result.map((row) => row.join(''));
}

function transformedBoard(board, symmetry) {
  return transformParsedBoard(parse(board), symmetry);
}

function canonicalKey(board, sideToMove) {
  if (!VALID_PLAYERS.has(sideToMove)) throw new Error('sideToMove must be B or W');
  const source = parse(board);
  let smallest = null;
  for (const symmetry of COLOR_PRESERVING_SYMMETRIES) {
    const key = boardKey(transformParsedBoard(source, symmetry));
    if (smallest === null || key < smallest) smallest = key;
  }
  return `${sideToMove}|${smallest}`;
}

function count(board) {
  const b = parse(board).join('');
  return {
    black: (b.match(/B/g) || []).length,
    white: (b.match(/W/g) || []).length,
    empty: (b.match(/\./g) || []).length,
  };
}

function inBounds(row, column) {
  return row >= 0 && row < 8 && column >= 0 && column < 8;
}

function flips(board, player, row, column) {
  const b = parse(board);
  if (!VALID_PLAYERS.has(player)) throw new Error('player must be B or W');
  if (!Number.isInteger(row) || !Number.isInteger(column) || !inBounds(row, column)) return [];
  if (b[row][column] !== '.') return [];

  const other = opposite(player);
  const result = [];
  for (const [dr, dc] of DIRECTIONS) {
    const line = [];
    let r = row + dr;
    let c = column + dc;
    while (inBounds(r, c) && b[r][c] === other) {
      line.push([r, c]);
      r += dr;
      c += dc;
    }
    if (line.length > 0 && inBounds(r, c) && b[r][c] === player) result.push(...line);
  }
  return result;
}

function legal(board, player) {
  const b = parse(board);
  const result = [];
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const moved = flips(b, player, row, column);
      if (moved.length > 0) result.push({ row, column, r: row, c: column, flips: moved });
    }
  }
  return result;
}

function apply(board, player, row, column) {
  const b = parse(board);
  if (!VALID_PLAYERS.has(player)) throw new Error('player must be B or W');
  const moved = flips(b, player, row, column);
  if (moved.length === 0) throw new Error('illegal move');

  const next = b.map((line) => line.split(''));
  next[row][column] = player;
  for (const [r, c] of moved) next[r][c] = player;
  return { board: next.map((line) => line.join('')), flips: moved };
}

function coord(row, column) {
  if (!Number.isInteger(row) || !Number.isInteger(column) || !inBounds(row, column)) {
    throw new Error('coordinate is outside the board');
  }
  return String.fromCharCode(65 + column) + String(row + 1);
}

function parseCoord(value) {
  if (typeof value !== 'string' || !/^[A-H][1-8]$/.test(value)) return null;
  return { row: value.charCodeAt(1) - 49, column: value.charCodeAt(0) - 65 };
}

function validate(board, options = {}) {
  let b;
  try {
    b = parse(board);
  } catch (error) {
    return error.message;
  }

  const stones = count(b);
  if (stones.black + stones.white < 4) return 'at least four stones required';
  for (const square of INITIAL_SQUARES) {
    const point = parseCoord(square);
    if (b[point.row][point.column] === '.') return 'initial four squares cannot be empty';
  }

  if (options.positionType === 'terminal') {
    if (legal(b, 'B').length !== 0 || legal(b, 'W').length !== 0) return 'board is not terminal';
  } else if (options.positionType && options.positionType !== 'any') {
    return 'positionType must be terminal or any';
  }
  return null;
}

function sameBoard(left, right) {
  return boardKey(left) === boardKey(right);
}

function sameSquareSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = left.map((item) => Array.isArray(item) ? `${item[0]},${item[1]}` : item).sort();
  const b = right.map((item) => Array.isArray(item) ? `${item[0]},${item[1]}` : item).sort();
  return a.every((value, index) => value === b[index]);
}

function eventLabel(event, index = null) {
  const prefix = index === null ? '' : `${index + 1}. `;
  return `${prefix}${event.player === 'B' ? 'Black' : 'White'} ${event.type === 'PASS' ? 'PASS' : event.square}`;
}

/*
 * Generate every legal predecessor of (board, sideToMove).
 *
 * If p made the last move, p is opposite(sideToMove). In the current board a
 * possible move square is a p stone. Looking out from it, the first k
 * contiguous p stones (1 <= k < run length) can have been q stones before the
 * move; the (k + 1)th p stone is the anchor. The cell after the whole run is
 * irrelevant. Every candidate is checked by applying the ordinary forward
 * rule, which keeps this reverse enumeration sound at edges and corners.
 */
function generatePredecessors(board, sideToMove) {
  const current = parse(board);
  if (!VALID_PLAYERS.has(sideToMove)) throw new Error('sideToMove must be B or W');
  const prior = opposite(sideToMove);
  const result = [];

  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      if (current[row][column] !== prior) continue;
      const square = coord(row, column);
      if (INITIAL_SQUARES.has(square)) continue;

      const choicesByDirection = [];
      for (const [dr, dc] of DIRECTIONS) {
        const run = [];
        let r = row + dr;
        let c = column + dc;
        while (inBounds(r, c) && current[r][c] === prior) {
          run.push([r, c]);
          r += dr;
          c += dc;
        }

        // Option zero means this direction did not flip. A flip of length k
        // needs a p anchor at run[k], so k is strictly less than run.length.
        const choices = [[]];
        for (let k = 1; k < run.length; k += 1) choices.push(run.slice(0, k));
        choicesByDirection.push(choices);
      }

      const selected = [];
      const enumerate = (directionIndex) => {
        if (directionIndex === choicesByDirection.length) {
          if (selected.length === 0) return;
          const predecessor = current.map((line) => line.split(''));
          predecessor[row][column] = '.';
          for (const [r, c] of selected) predecessor[r][c] = sideToMove;
          const previousBoard = predecessor.map((line) => line.join(''));
          try {
            const forward = apply(previousBoard, prior, row, column);
            if (!sameBoard(forward.board, current)) return;
            result.push({
              board: previousBoard,
              sideToMove: prior,
              event: {
                player: prior,
                type: 'MOVE',
                square,
                flips: forward.flips.map(([r, c]) => coord(r, c)),
              },
            });
          } catch {
            // The ordinary forward validator is authoritative.
          }
          return;
        }

        for (const choice of choicesByDirection[directionIndex]) {
          const length = selected.length;
          selected.push(...choice);
          enumerate(directionIndex + 1);
          selected.length = length;
        }
      };
      enumerate(0);
    }
  }
  return result;
}

function replay(events, options = {}) {
  const start = parse(options.start || INITIAL);
  if (!Array.isArray(events)) throw new Error('events must be an array');
  let board = start;
  let side = options.sideToMove || 'B';
  if (!VALID_PLAYERS.has(side)) throw new Error('sideToMove must be B or W');
  const snapshots = [{ board: board.slice(), event: null, placed: null, flips: [] }];

  for (const event of events) {
    if (!event || event.player !== side || !VALID_PLAYERS.has(event.player)) {
      throw new Error('event player does not match the side to move');
    }
    if (event.type === 'PASS') {
      if (legal(board, side).length !== 0) throw new Error('pass is only legal without a move');
      if (legal(board, opposite(side)).length === 0) throw new Error('both sides have no legal move');
      board = board.slice();
      snapshots.push({ board: board.slice(), event, placed: null, flips: [] });
      side = opposite(side);
      continue;
    }
    if (event.type !== 'MOVE') throw new Error('event type must be MOVE or PASS');
    const point = parseCoord(event.square);
    if (!point) throw new Error('move square is invalid');
    const moved = apply(board, side, point.row, point.column);
    if (event.flips && !sameSquareSet(event.flips, moved.flips.map(([r, c]) => coord(r, c)))) {
      throw new Error('event flips do not match the legal move');
    }
    board = moved.board;
    snapshots.push({
      board: board.slice(),
      event,
      placed: event.square,
      flips: moved.flips.map(([r, c]) => coord(r, c)),
    });
    side = opposite(side);
  }
  return { board: board.slice(), sideToMove: side, snapshots };
}

function replayTo(events, step, options = {}) {
  if (!Number.isInteger(step) || step < 0 || step > events.length) throw new Error('replay step is out of range');
  return replay(events.slice(0, step), options);
}

function targetPruneReason(board, target) {
  const current = parse(board);
  const expected = parse(target);
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const stone = current[row][column];
      if (stone === '.') continue;
      if (expected[row][column] === '.') return 'target-empty-occupancy';
      if ((row === 0 || row === 7) && (column === 0 || column === 7)
        && stone !== expected[row][column]) return 'corner-mismatch';
    }
  }

  // A same-colour edge run connected to an occupied corner is stable. An
  // edge disc cannot be bracketed from outside the board, and the corner end
  // can never change. This is deliberately conservative: uncertain interior
  // stability is not used for pruning.
  const corners = [
    { row: 0, column: 0, rays: [[0, 1], [1, 0]] },
    { row: 0, column: 7, rays: [[0, -1], [1, 0]] },
    { row: 7, column: 0, rays: [[0, 1], [-1, 0]] },
    { row: 7, column: 7, rays: [[0, -1], [-1, 0]] },
  ];
  for (const corner of corners) {
    const color = current[corner.row][corner.column];
    if (color === '.') continue;
    for (const [dr, dc] of corner.rays) {
      let row = corner.row + dr;
      let column = corner.column + dc;
      while (inBounds(row, column) && current[row][column] === color) {
        if (expected[row][column] !== color) return 'stable-edge-mismatch';
        row += dr;
        column += dc;
      }
    }
  }
  return null;
}

function targetProfile(board, target) {
  let matches = 0;
  let black = 0;
  let occupied = 0;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const stone = board[row][column];
      if (stone === '.') continue;
      occupied += 1;
      if (stone === 'B') black += 1;
      if (stone === target[row][column]) matches += 1;
    }
  }
  return { matches, black, occupied };
}

function reconstruct(target, options = {}) {
  const positionType = options.positionType || 'any';
  let t;
  try {
    t = parse(target);
  } catch (error) {
    return { status: 'INVALID_INPUT', error: error.message };
  }
  const validationError = validate(t, { positionType });
  if (validationError) return { status: 'INVALID_INPUT', error: validationError };

  const searchStartedAt = Date.now();

  const unlimited = options.unlimited === true;
  const maxNodes = unlimited || options.maxNodes === null
    ? null
    : (Number.isFinite(options.maxNodes) ? Math.max(0, Math.floor(options.maxNodes)) : 50000);
  const maxMs = unlimited || options.maxMs === null
    ? null
    : (Number.isFinite(options.maxMs) ? Math.max(0, options.maxMs) : 3000);
  const maxCacheEntries = Number.isFinite(options.maxCacheEntries)
    ? Math.max(1, Math.floor(options.maxCacheEntries))
    : (unlimited ? 500000 : 100000);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const cancelled = typeof options.cancelled === 'function' ? options.cancelled : () => false;
  const startTime = searchStartedAt;
  const deadline = maxMs === null ? null : startTime + maxMs;
  let nodesVisited = 0;
  let timedOut = false;
  let foundPath = null;
  const failed = new Set();
  let cacheEvictions = 0;

  // Failed states are only a speed optimization. Removing older entries may
  // cause repeated work, but it cannot remove a legal path or create a false
  // proof. Set iteration order is insertion order, so this is a bounded FIFO
  // cache rather than an all-at-once reset.
  const rememberFailed = (key) => {
    if (failed.has(key)) return;
    if (failed.size >= maxCacheEntries) {
      const removeCount = Math.max(1, Math.ceil(maxCacheEntries / 4));
      const oldest = failed.values();
      for (let index = 0; index < removeCount; index += 1) {
        const entry = oldest.next();
        if (entry.done) break;
        failed.delete(entry.value);
        cacheEvictions += 1;
      }
    }
    failed.add(key);
  };

  const progress = (board, cacheSize = failed.size, searchStrategy = null) => {
    try {
      onProgress({
        nodesVisited,
        currentStones: count(board).black + count(board).white,
        cacheSize,
        cacheEvictions,
        searchStrategy,
        elapsedMs: Date.now() - startTime,
      });
    } catch {
      // Progress reporting must never change search semantics.
    }
  };

  // Target-directed forward search. Occupancy and fixed-corner checks are
  // sound: stones are never removed, and a corner can never be flipped.
  const targetStoneCount = count(t).black + count(t).white;
  const requestedTargetSide = options.sideToMove === 'B' || options.sideToMove === 'W'
    ? options.sideToMove
    : null;
  const expectedTargetSide = positionType === 'terminal' ? null : requestedTargetSide;
  let forwardCacheSize = 0;
  const targetForward = () => {
    const seen = new Set();
    const rememberSeen = (key) => {
      if (seen.size >= maxCacheEntries) {
        const removeCount = Math.max(1, Math.ceil(maxCacheEntries / 4));
        const oldest = seen.values();
        for (let index = 0; index < removeCount; index += 1) {
          const entry = oldest.next();
          if (entry.done) break;
          seen.delete(entry.value);
          cacheEvictions += 1;
        }
      }
      seen.add(key);
      forwardCacheSize = seen.size;
    };
    const search = (board, side, events, movesMade) => {
      if (cancelled()) return 'cancel';
      if ((deadline !== null && Date.now() >= deadline) || (maxNodes !== null && nodesVisited >= maxNodes)) {
        timedOut = true; return 'timeout';
      }
      nodesVisited += 1;
      if (nodesVisited === 1 || nodesVisited % 100 === 0) progress(board, seen.size, 'TARGET_FORWARD');
      const stones = count(board);
      if (targetPruneReason(board, t)) return 'no';
      if (stones.black + stones.white === targetStoneCount) {
        if (sameBoard(board, t) && (expectedTargetSide === null || side === expectedTargetSide)) {
          foundPath = events;
          return 'found';
        }
        return 'no';
      }
      if (movesMade >= targetStoneCount - 4) return 'no';
      // The target can be asymmetric, so symmetric current boards are not
      // generally equivalent relative to it. Use the exact board here;
      // symmetry canonicalization remains safe in reverse search because the
      // standard initial board is symmetric.
      const key = `${side}|${boardKey(board)}`;
      if (seen.has(key)) return 'no';
      rememberSeen(key);
      let moves = legal(board, side);
      const otherMoves = legal(board, opposite(side));
      if (moves.length === 0) {
        if (otherMoves.length === 0) return 'no';
        const result = search(board, opposite(side), events.concat({ player: side, type: 'PASS' }), movesMade);
        if (result !== 'no') return result;
        return 'no';
      }
      const before = targetProfile(board, t);
      moves = moves.map((move) => {
        const next = apply(board, side, move.row, move.column);
        if (targetPruneReason(next.board, t)) return null;
        const after = targetProfile(next.board, t);
        const mobility = legal(next.board, 'B').length + legal(next.board, 'W').length;
        const corners = [[0, 0], [0, 7], [7, 0], [7, 7]]
          .filter(([row, column]) => next.board[row][column] === t[row][column]).length;
        // The agreement delta is colour-independent: a black move that flips
        // fewer white stones is preferred for an all-white target, while a
        // white move that flips more black stones is preferred. The rest is
        // heuristic ordering only; every soundly legal child is retained.
        const agreementDelta = after.matches - before.matches;
        const score = agreementDelta * 1000
          + after.matches * 5
          - (after.occupied - after.matches) * 50
          - mobility
          + corners * 200;
        return { move, next, score };
      }).filter(Boolean).sort((a, b) => b.score - a.score);
      for (const { move, next } of moves) {
        const event = { player: side, type: 'MOVE', square: coord(move.row, move.column), flips: next.flips.map(([r, c]) => coord(r, c)) };
        const result = search(next.board, opposite(side), events.concat(event), movesMade + 1);
        if (result !== 'no') return result;
      }
      return 'no';
    };
    return search(INITIAL.slice(), 'B', [], 0);
  };

  // A standard game always starts with Black. target.sideToMove describes the
  // requested target interpretation and must never be used as a second root.
  const result = targetForward();
  if (result === 'found') {
    const verified = replay(foundPath);
    if (!sameBoard(verified.board, t)) return { status: 'ERROR', searchStrategy: 'TARGET_FORWARD', error: 'FOUND replay mismatch', nodesVisited };
    return { status: 'FOUND', searchStrategy: 'TARGET_FORWARD', nodesVisited, cacheSize: forwardCacheSize, cacheEvictions, elapsedMs: Date.now() - startTime, solution: { events: foundPath } };
  }
  if (result === 'cancel') return { status: 'CANCELLED', searchStrategy: 'TARGET_FORWARD', nodesVisited, cacheSize: forwardCacheSize, cacheEvictions, elapsedMs: Date.now() - startTime };

  const dfs = (board, sideToMove, reverseEvents) => {
    if (cancelled()) return 'cancel';
    if (sameBoard(board, INITIAL) && sideToMove === 'B') {
      foundPath = reverseEvents.slice().reverse();
      return 'found';
    }
    if ((deadline !== null && Date.now() >= deadline) || (maxNodes !== null && nodesVisited >= maxNodes)) {
      timedOut = true;
      return 'timeout';
    }
    nodesVisited += 1;
    if (nodesVisited === 1 || nodesVisited % 100 === 0) progress(board, failed.size, 'REVERSE_DFS');

    const key = canonicalKey(board, sideToMove);
    if (failed.has(key)) return 'no';
    const stones = count(board);
    if (stones.black + stones.white === 4) {
      rememberFailed(key);
      return 'no';
    }

    const prior = opposite(sideToMove);
    const currentMoves = legal(board, sideToMove);
    const priorMoves = legal(board, prior);

    // Reverse a pass only when the previous player had no move and the side
    // that received the turn does have one. A terminal (both-pass) position
    // therefore never gains a spurious pass event.
    if (priorMoves.length === 0 && currentMoves.length > 0) {
      const passEvent = { player: prior, type: 'PASS' };
      const passResult = dfs(board, prior, reverseEvents.concat(passEvent));
      if (passResult === 'found' || passResult === 'cancel') return passResult;
      if (passResult === 'timeout') return passResult;
    }

    const predecessors = generatePredecessors(board, sideToMove);
    // Fewer flips usually gets back toward the sparse opening sooner. This
    // changes only order; every verified predecessor remains in the search.
    predecessors.sort((left, right) => left.event.flips.length - right.event.flips.length);
    for (const predecessor of predecessors) {
      const result = dfs(predecessor.board, predecessor.sideToMove, reverseEvents.concat(predecessor.event));
      if (result === 'found' || result === 'cancel') return result;
      if (result === 'timeout') return result;
    }

    rememberFailed(key);
    return 'no';
  };

  const requestedSide = options.sideToMove;
  // A terminal board has no meaningful next player. The specification
  // therefore requires both possible side-to-move roots to be searched.
  const roots = positionType === 'terminal'
    ? ['B', 'W']
    : (requestedSide === 'B' || requestedSide === 'W' ? [requestedSide] : ['B', 'W']);
  for (const side of roots) {
    const result = dfs(t, side, []);
    if (result === 'found') {
      let verified;
      try {
        verified = replay(foundPath);
      } catch (error) {
        return {
          status: 'ERROR',
          searchStrategy: 'REVERSE_DFS',
          error: `FOUND replay verification failed: ${error.message}`,
          nodesVisited,
          cacheSize: failed.size,
          cacheEvictions,
        };
      }
      if (!sameBoard(verified.board, t)) {
        return {
          status: 'ERROR',
          searchStrategy: 'REVERSE_DFS',
          error: 'FOUND replay verification ended at another board',
          nodesVisited,
          cacheSize: failed.size,
          cacheEvictions,
        };
      }
      return {
        status: 'FOUND',
        searchStrategy: 'REVERSE_DFS',
        nodesVisited,
        cacheSize: failed.size,
        cacheEvictions,
        elapsedMs: Date.now() - startTime,
        solution: { events: foundPath },
      };
    }
    if (result === 'cancel') {
      return {
        status: 'CANCELLED',
        searchStrategy: 'REVERSE_DFS',
        nodesVisited,
        cacheSize: failed.size,
        cacheEvictions,
        elapsedMs: Date.now() - startTime,
      };
    }
    // Do not turn a timeout on one root side into a proof. The other root is
    // still attempted when budget remains, and the aggregate result below
    // reports UNKNOWN_TIMEOUT if any root was cut short.
  }

  if (timedOut) {
    return {
      status: 'UNKNOWN_TIMEOUT',
      searchStrategy: 'REVERSE_DFS',
      nodesVisited,
      cacheSize: failed.size,
      cacheEvictions,
      elapsedMs: Date.now() - startTime,
    };
  }
  return {
    status: 'UNREACHABLE_PROVEN',
    searchStrategy: 'REVERSE_DFS',
    nodesVisited,
    cacheSize: failed.size,
    cacheEvictions,
    elapsedMs: Date.now() - startTime,
  };
}

const api = {
  initial: INITIAL.slice(),
  opposite,
  parse,
  count,
  transformedBoard,
  transformBoard: transformedBoard,
  canonicalKey,
  canonicalStateKey: canonicalKey,
  colorPreservingSymmetries: COLOR_PRESERVING_SYMMETRIES.map(({ name }) => name),
  flips,
  legal,
  apply,
  coord,
  parseCoord,
  validate,
  targetPruneReason,
  generatePredecessors,
  predecessors: generatePredecessors,
  eventLabel,
  replay,
  replayTo,
  reconstruct,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.ReversiEngine = api;
