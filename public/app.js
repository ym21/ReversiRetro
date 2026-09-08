(() => {
  'use strict';

  const E = window.ReversiEngine;
  const initial = E.initial.slice();
  const $ = (id) => document.getElementById(id);

  const boardElement = $('board');
  const textElement = $('text');
  const pickerElements = Array.from(document.querySelectorAll('.picker'));
  const controls = {
    reset: $('reset'),
    go: $('go'),
    cancel: $('cancel'),
    copy: $('copy'),
    searchMode: $('search-mode'),
    first: $('first'),
    prev: $('prev'),
    play: $('play'),
    next: $('next'),
    last: $('last'),
  };

  let inputBoard = initial.slice();
  let selectedPiece = '.';
  let replayMode = false;
  let events = [];
  let snapshots = [];
  let replayStep = 0;
  let worker = null;
  let running = false;
  let startedAt = 0;
  let elapsedTimer = null;
  let playTimer = null;
  let activeSearchMode = null;
  let lastMetrics = {
    nodesVisited: 0,
    cacheSize: 0,
    cacheEvictions: 0,
    currentStones: 4,
    elapsedMs: 0,
    searchStrategy: null,
  };

  const searchProfiles = {
    quick: { label: 'クイック', maxNodes: 50000, maxMs: 3000, maxCacheEntries: 50000 },
    thorough: { label: 'じっくり', maxNodes: 5000000, maxMs: 300000, maxCacheEntries: 250000 },
    unlimited: { label: '無制限', unlimited: true, maxCacheEntries: 500000 },
  };

  function formatElapsed(milliseconds) {
    if (!Number.isFinite(milliseconds)) return '—';
    return `${(milliseconds / 1000).toFixed(1)} 秒`;
  }

  function formatSearchStrategy(strategy) {
    if (strategy === 'VERIFIED_BOOK') return '検証済み棋譜帳';
    if (strategy === 'REVERSE_DFS') return '逆向きDFS';
    return '—';
  }

  function updateMetrics(metrics = {}) {
    lastMetrics = {
      ...lastMetrics,
      ...metrics,
    };
    $('elapsed').textContent = formatElapsed(lastMetrics.elapsedMs);
    $('nodes').textContent = Number.isFinite(lastMetrics.nodesVisited) ? lastMetrics.nodesVisited.toLocaleString('ja-JP') : '—';
    $('cache').textContent = Number.isFinite(lastMetrics.cacheSize) ? lastMetrics.cacheSize.toLocaleString('ja-JP') : '—';
    $('cache-evictions').textContent = Number.isFinite(lastMetrics.cacheEvictions)
      ? lastMetrics.cacheEvictions.toLocaleString('ja-JP')
      : '—';
    $('current-stones').textContent = Number.isFinite(lastMetrics.currentStones) ? `${lastMetrics.currentStones} 石` : '—';
    $('strategy').textContent = formatSearchStrategy(lastMetrics.searchStrategy);
  }

  function setBadge(label, type = '') {
    const badge = $('status-badge');
    badge.className = `badge${type ? ` ${type}` : ''}`;
    badge.textContent = label;
  }

  function setStatus(text, type = '') {
    $('status').textContent = text;
    setBadge(type === 'success' ? '発見' : type === 'error' ? '要確認' : type === 'running' ? '探索中' : '待機中', type);
  }

  function currentView() {
    if (replayMode && snapshots[replayStep]) return snapshots[replayStep].board;
    return inputBoard;
  }

  function updatePickerState() {
    for (const picker of pickerElements) {
      const selected = picker.dataset.p === selectedPiece;
      picker.classList.toggle('selected', selected);
      picker.setAttribute('aria-pressed', String(selected));
    }
  }

  function updateReplayControls() {
    const hasTranscript = events.length > 0 && snapshots.length === events.length + 1;
    const atStart = replayStep <= 0;
    const atEnd = replayStep >= events.length;
    controls.first.disabled = !hasTranscript || atStart;
    controls.prev.disabled = !hasTranscript || atStart;
    controls.next.disabled = !hasTranscript || atEnd;
    controls.last.disabled = !hasTranscript || atEnd;
    controls.play.disabled = !hasTranscript;
    controls.play.textContent = playTimer ? '停止' : '再生';
    $('step-label').textContent = `${replayStep} / ${events.length} 手`;
  }

  function renderTranscript() {
    const list = $('moves');
    list.replaceChildren();
    if (events.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'moves-empty';
      empty.textContent = 'FOUND の棋譜がここに表示されます。';
      list.append(empty);
      updateReplayControls();
      return;
    }

    events.forEach((event, index) => {
      const item = document.createElement('li');
      const move = document.createElement('button');
      move.type = 'button';
      move.className = 'move-button';
      move.textContent = E.eventLabel(event, index);
      move.setAttribute('aria-label', `${E.eventLabel(event, index)}を表示`);
      if (replayMode && replayStep === index + 1) {
        move.classList.add('current');
        move.setAttribute('aria-current', 'step');
      }
      move.addEventListener('click', () => setReplayStep(index + 1));
      item.append(move);
      list.append(item);
    });
    updateReplayControls();
  }

  function renderBoard() {
    const view = currentView();
    const snapshot = replayMode ? snapshots[replayStep] : null;
    const placed = snapshot?.placed || null;
    const flipped = new Set(snapshot?.flips || []);
    boardElement.replaceChildren();

    view.forEach((line, row) => {
      [...line].forEach((value, column) => {
        const square = E.coord(row, column);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = `cell ${value}`;
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-label', `${square} ${value === 'B' ? '黒' : value === 'W' ? '白' : '空'}`);
        if (replayMode) {
          cell.disabled = true;
          if (square === placed) cell.classList.add('placed');
          if (flipped.has(square)) cell.classList.add('flipped');
        } else {
          cell.addEventListener('click', () => {
            if (running) cancelSearch();
            const next = inputBoard.map((current) => current.split(''));
            next[row][column] = selectedPiece;
            inputBoard = next.map((current) => current.join(''));
            textElement.value = inputBoard.join('\n');
            clearTranscript();
            render();
          });
        }
        boardElement.append(cell);
      });
    });
    $('replay-label').textContent = replayMode ? `再生中 ${replayStep}/${events.length}手` : '編集モード';
  }

  function render() {
    renderBoard();
    renderTranscript();
    updatePickerState();
    const validation = E.validate(inputBoard, { positionType: 'terminal' });
    const status = $('input-status');
    status.className = 'input-status';
    if (validation === null) {
      status.classList.add('ok');
      status.textContent = '終局盤面です。探索を開始できます。';
      controls.go.disabled = running;
    } else if (validation === 'board is not terminal') {
      status.classList.add('warning');
      status.textContent = '終局ではありません。黒・白の合法手がない盤面を入力してください。';
      controls.go.disabled = true;
    } else {
      status.classList.add('error');
      status.textContent = `入力エラー: ${validation}`;
      controls.go.disabled = true;
    }
    const numbers = E.count(inputBoard);
    $('counts').textContent = `黒 ${numbers.black} / 白 ${numbers.white} / 空 ${numbers.empty}`;
    controls.cancel.disabled = !running;
    controls.copy.disabled = events.length === 0;
    controls.searchMode.disabled = running;
  }

  function clearTranscript() {
    pausePlayback();
    replayMode = false;
    events = [];
    snapshots = [];
    replayStep = 0;
    controls.copy.disabled = true;
  }

  function parseTextInput() {
    const lines = textElement.value.trim().split(/\r?\n/);
    if (lines.length !== 8 || lines.some((line) => !/^[BW.]{8}$/.test(line))) return null;
    return lines;
  }

  function handleTextInput() {
    if (running) cancelSearch();
    const parsed = parseTextInput();
    clearTranscript();
    if (parsed) inputBoard = parsed;
    render();
    if (!parsed) {
      const status = $('input-status');
      status.className = 'input-status error';
      status.textContent = '入力エラー: B/W/. の8文字を8行入力してください。';
      controls.go.disabled = true;
    }
  }

  function createWorker() {
    if (worker) worker.terminate();
    worker = new Worker('worker.js');
    const ownedWorker = worker;
    ownedWorker.onmessage = (message) => {
      if (ownedWorker !== worker) return;
      const data = message.data || {};
      if (data.type === 'progress') {
        updateMetrics(data);
        const elapsed = Number.isFinite(data.elapsedMs) ? formatElapsed(data.elapsedMs) : formatElapsed(Date.now() - startedAt);
        const evictions = data.cacheEvictions > 0
          ? ` / 退避 ${data.cacheEvictions.toLocaleString('ja-JP')}`
          : '';
        $('status').textContent = `${activeSearchMode?.label || ''}探索中 — ${data.nodesVisited.toLocaleString('ja-JP')} ノード / ${data.currentStones} 石 / キャッシュ ${data.cacheSize.toLocaleString('ja-JP')}${evictions} / ${elapsed}`;
        return;
      }
      if (data.type === 'result') finishSearch(data.result || { status: 'ERROR', error: '探索結果が空です' }, ownedWorker);
    };
    ownedWorker.onerror = () => finishSearch({ status: 'ERROR', error: 'Web Workerで探索に失敗しました' }, ownedWorker);
    return ownedWorker;
  }

  function finishSearch(result, ownedWorker) {
    if (ownedWorker !== worker) return;
    running = false;
    activeSearchMode = null;
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    worker = null;
    ownedWorker.terminate();
    updateMetrics({
      nodesVisited: result.nodesVisited ?? lastMetrics.nodesVisited,
      cacheSize: result.cacheSize ?? lastMetrics.cacheSize,
      cacheEvictions: result.cacheEvictions ?? lastMetrics.cacheEvictions,
      elapsedMs: result.elapsedMs ?? (Date.now() - startedAt),
      searchStrategy: result.searchStrategy ?? lastMetrics.searchStrategy,
    });

    if (result.status === 'FOUND' && result.solution && Array.isArray(result.solution.events)) {
      try {
        const replayed = E.replay(result.solution.events);
        if (replayed.board.join('/') !== inputBoard.join('/')) throw new Error('最終盤面が一致しません');
        events = result.solution.events.slice();
        snapshots = replayed.snapshots;
        replayStep = 0;
        replayMode = true;
        const strategyLabel = result.searchStrategy === 'VERIFIED_BOOK' ? '検証済み棋譜帳から' : '逆向きDFSで';
        setStatus(`${strategyLabel}合法手順を発見しました。${events.length}手を再生できます。`, 'success');
        updateMetrics({ currentStones: 4 });
      } catch (error) {
        events = [];
        snapshots = [];
        replayMode = false;
        setStatus(`結果の再生検証に失敗しました: ${error.message}`, 'error');
      }
    } else if (result.status === 'UNREACHABLE_PROVEN') {
      setStatus('初期配置からの合法手順は存在しないと判定しました。', 'error');
      events = [];
      snapshots = [];
      replayMode = false;
    } else if (result.status === 'UNKNOWN_TIMEOUT') {
      setStatus('探索上限に達しました（到達不能とは限りません）。必要なら無制限モードで再実行してください。', 'error');
    } else if (result.status === 'CANCELLED') {
      setStatus('探索を停止しました。', '');
    } else {
      setStatus(result.error || `探索結果: ${result.status || 'ERROR'}`, 'error');
    }
    render();
  }

  function startSearch() {
    const validation = E.validate(inputBoard, { positionType: 'terminal' });
    if (validation || running) return;
    clearTranscript();
    running = true;
    activeSearchMode = searchProfiles[controls.searchMode.value] || searchProfiles.quick;
    startedAt = Date.now();
    updateMetrics({
      nodesVisited: 0,
      cacheSize: 0,
      cacheEvictions: 0,
      currentStones: E.count(inputBoard).black + E.count(inputBoard).white,
      elapsedMs: 0,
      searchStrategy: null,
    });
    setStatus(`${activeSearchMode.label}モードで探索を開始しました。`, 'running');
    render();
    elapsedTimer = setInterval(() => updateMetrics({ elapsedMs: Date.now() - startedAt }), 250);
    const activeWorker = createWorker();
    activeWorker.postMessage({
      type: 'start',
      positionType: 'terminal',
      board: inputBoard.slice(),
      maxNodes: activeSearchMode.maxNodes,
      maxMs: activeSearchMode.maxMs,
      maxCacheEntries: activeSearchMode.maxCacheEntries,
      unlimited: activeSearchMode.unlimited === true,
    });
  }

  function cancelSearch() {
    if (!running) return;
    running = false;
    activeSearchMode = null;
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    if (worker) {
      // DFS is synchronous inside the worker, so a cancel message cannot be
      // observed until the stack unwinds. Terminate and recreate it instead.
      worker.terminate();
      worker = null;
    }
    setStatus('探索を停止しました。', '');
    updateMetrics({ elapsedMs: Date.now() - startedAt });
    render();
  }

  function setReplayStep(step) {
    if (events.length === 0) return;
    pausePlayback();
    replayStep = Math.max(0, Math.min(events.length, step));
    replayMode = true;
    render();
  }

  function pausePlayback() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    updateReplayControls();
  }

  function togglePlayback() {
    if (events.length === 0) return;
    if (playTimer) {
      pausePlayback();
      return;
    }
    if (replayStep >= events.length) replayStep = 0;
    replayMode = true;
    playTimer = setInterval(() => {
      if (replayStep >= events.length) {
        pausePlayback();
        render();
        return;
      }
      replayStep += 1;
      render();
    }, 520);
    render();
  }

  async function copyTranscript() {
    if (events.length === 0) return;
    const text = events.map((event, index) => E.eventLabel(event, index)).join('\n');
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setStatus('棋譜をクリップボードにコピーしました。', 'success');
    } catch {
      setStatus('このブラウザではコピーできません。HTTPS環境で再試行してください。', 'error');
    }
  }

  pickerElements.forEach((picker) => picker.addEventListener('click', () => {
    selectedPiece = picker.dataset.p;
    updatePickerState();
  }));
  textElement.addEventListener('input', handleTextInput);
  controls.reset.addEventListener('click', () => {
    if (running) cancelSearch();
    inputBoard = initial.slice();
    textElement.value = inputBoard.join('\n');
    clearTranscript();
    setStatus('初期配置に戻しました。', '');
    render();
  });
  controls.go.addEventListener('click', startSearch);
  controls.cancel.addEventListener('click', cancelSearch);
  controls.copy.addEventListener('click', copyTranscript);
  controls.first.addEventListener('click', () => setReplayStep(0));
  controls.prev.addEventListener('click', () => setReplayStep(replayStep - 1));
  controls.play.addEventListener('click', togglePlayback);
  controls.next.addEventListener('click', () => setReplayStep(replayStep + 1));
  controls.last.addEventListener('click', () => setReplayStep(events.length));

  textElement.value = inputBoard.join('\n');
  updateMetrics();
  render();
})();
