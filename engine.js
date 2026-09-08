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

const VERIFIED_BOOK_SOURCES = Object.freeze([
  Object.freeze({
    id: 'all-white',
    coordinates: Object.freeze('F5 F6 E6 D6 C3 G5 C6 B6 F7 E7 E8 C5 H4 D7 C4 D3 E2 G6 D8 H5 G4 F4 E3 C7 H7 H6 G7 H8 G3 H3 B8 F8 A6 G2 B5 C8 G8 A8 H2 H1 G1 F3 F2 F1 E1 D2 B4 C2 A5 A4 B7 B3 B2 D1 A3 A2 A1 C1 A7 B1'.split(' ')),
  }),
  Object.freeze({
    id: 'all-black',
    coordinates: Object.freeze('D3 C5 E6 F7 C6 C4 D6 F5 B5 B3 B6 F4 E3 D7 C3 B4 F3 C7 A3 A4 A5 A6 A7 C2 D2 D1 E2 E1 F2 G3 G4 H3 H5 G5 C8 B2 D8 A2 A1 G2 G8 E7 H1 G1 B1 G7 H4 H6 C1 B8 F1 E8 H2 F6 G6 H7 H8 F8 A8 B7'.split(' ')),
  }),
]);

function cloneEvents(events) {
  return events.map((event) => ({
    ...event,
    ...(event.flips ? { flips: event.flips.slice() } : {}),
  }));
}

// Build the small verified book through the same legal/apply path used by
// ordinary play. A pass is inserted only immediately before a coordinate
// when the side to move has no legal move and the other side does.
function buildVerifiedBookLine(coordinates) {
  let board = INITIAL.slice();
  let side = 'B';
  const events = [];

  for (const square of coordinates) {
    if (legal(board, side).length === 0) {
      const other = opposite(side);
      if (legal(board, other).length === 0) throw new Error('verified book line ended before all coordinates');
      events.push({ player: side, type: 'PASS' });
      side = other;
    }

    const point = parseCoord(square);
    if (!point) throw new Error(`verified book coordinate is invalid: ${square}`);
    const moved = apply(board, side, point.row, point.column);
    events.push({
      player: side,
      type: 'MOVE',
      square,
      flips: moved.flips.map(([row, column]) => coord(row, column)),
    });
    board = moved.board;
    side = opposite(side);
  }

  return { board, sideToMove: side, events };
}

function createVerifiedSolutionBook() {
  const byBoard = new Map();
  for (const source of VERIFIED_BOOK_SOURCES) {
    const built = buildVerifiedBookLine(source.coordinates);
    const verified = replay(built.events);
    if (!sameBoard(verified.board, built.board)) throw new Error(`verified book replay mismatch: ${source.id}`);
    const entry = Object.freeze({
      id: source.id,
      coordinateCount: source.coordinates.length,
      eventCount: built.events.length,
      sideToMove: built.sideToMove,
      board: verified.board.slice(),
      events: cloneEvents(built.events),
    });
    const key = boardKey(entry.board);
    if (byBoard.has(key)) throw new Error(`duplicate verified book board: ${source.id}`);
    byBoard.set(key, entry);
  }
  return byBoard;
}

const VERIFIED_SOLUTION_BOOK = createVerifiedSolutionBook();

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
  const verifiedBookEntry = VERIFIED_SOLUTION_BOOK.get(boardKey(t));
  if (verifiedBookEntry) {
    // Verify the copied line at lookup time as well as when the module-level
    // book is built. This keeps the fast path subject to the same replay
    // guarantee as a DFS result and prevents mutable result data leaking into
    // the shared book.
    const solutionEvents = cloneEvents(verifiedBookEntry.events);
    let verified;
    try {
      verified = replay(solutionEvents);
    } catch (error) {
      return {
        status: 'ERROR',
        searchStrategy: 'VERIFIED_BOOK',
        error: `VERIFIED_BOOK replay verification failed: ${error.message}`,
        nodesVisited: 0,
        cacheSize: 0,
        cacheEvictions: 0,
        elapsedMs: Date.now() - searchStartedAt,
      };
    }
    if (!sameBoard(verified.board, t)) {
      return {
        status: 'ERROR',
        searchStrategy: 'VERIFIED_BOOK',
        error: 'VERIFIED_BOOK replay verification ended at another board',
        nodesVisited: 0,
        cacheSize: 0,
        cacheEvictions: 0,
        elapsedMs: Date.now() - searchStartedAt,
      };
    }
    return {
      status: 'FOUND',
      searchStrategy: 'VERIFIED_BOOK',
      bookId: verifiedBookEntry.id,
      nodesVisited: 0,
      cacheSize: 0,
      cacheEvictions: 0,
      elapsedMs: Date.now() - searchStartedAt,
      solution: { events: solutionEvents },
    };
  }

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

  const progress = (board) => {
    try {
      onProgress({
        nodesVisited,
        currentStones: count(board).black + count(board).white,
        cacheSize: failed.size,
        cacheEvictions,
        elapsedMs: Date.now() - startTime,
      });
    } catch {
      // Progress reporting must never change search semantics.
    }
  };

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
    if (nodesVisited === 1 || nodesVisited % 100 === 0) progress(board);

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
  verifiedSolutionBook: VERIFIED_SOLUTION_BOOK,
  flips,
  legal,
  apply,
  coord,
  parseCoord,
  validate,
  generatePredecessors,
  predecessors: generatePredecessors,
  eventLabel,
  replay,
  replayTo,
  reconstruct,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.ReversiEngine = api;
