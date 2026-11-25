(() => {
  'use strict';

  const BOARD_WIDTH = 600;
  const BOARD_HEIGHT = 520;
  const TILE_WIDTH = 72;
  const TILE_HEIGHT = 78;
  const TRAY_CAPACITY = 7;
  const HOLDING_CAPACITY = 3;
  const STORAGE_KEY = 'meadow-match-records-v1';
  const SOUND_KEY = 'meadow-match-sound-v1';
  const SESSION_KEY = 'meadow-match-session-v1';

  const TYPES = [
    { id: 'carrot', name: '胡萝卜' },
    { id: 'clover', name: '幸运草' },
    { id: 'bell', name: '铃铛' },
    { id: 'apple', name: '苹果' },
    { id: 'flower', name: '小花' },
    { id: 'milk', name: '牛奶' },
    { id: 'yarn', name: '毛线球' },
    { id: 'corn', name: '玉米' },
    { id: 'strawberry', name: '草莓' },
    { id: 'mushroom', name: '蘑菇' },
    { id: 'pumpkin', name: '南瓜' },
    { id: 'grape', name: '葡萄' }
  ];
  const EASY_TYPE_COUNT = 8;
  const inventory = { undo: 3, shuffle: 2, extract: 2 };

  const $ = (id) => document.getElementById(id);
  const dom = {
    panel: $('gamePanel'), board: $('board'), tray: $('tray'), holdingRow: $('holdingRow'), holdingSlots: $('holdingSlots'),
    levelTitle: $('levelTitle'), hardBadge: $('hardBadge'), sideLevel: $('sideLevel'), score: $('scoreValue'), time: $('timeValue'),
    progressText: $('progressText'), progressBar: $('progressBar'), moveText: $('moveText'),
    trayCount: $('trayCount'), cleared: $('clearedValue'), clearedTotal: $('clearedTotal'), progressRing: $('progressRing'),
    progressHint: $('progressHint'), boardCaption: $('boardCaption'), tipText: $('tipText'),
    bestScore: $('bestScore'), winCount: $('winCount'),
    undo: $('undoButton'), shuffle: $('shuffleButton'), extract: $('extractButton'),
    undoCount: $('undoCount'), shuffleCount: $('shuffleCount'), extractCount: $('extractCount'),
    overlay: $('gameOverlay'), resultIcon: $('resultIcon'), overlayKicker: $('overlayKicker'),
    overlayTitle: $('overlayTitle'), overlayDescription: $('overlayDescription'),
    resultScore: $('resultScore'), resultTime: $('resultTime'),
    overlayPrimary: $('overlayPrimary'), overlaySecondary: $('overlaySecondary'),
    helpModal: $('helpModal'), soundIcon: $('soundIcon'), soundButton: $('soundButton'), toast: $('toast')
  };

  let records = loadRecords();
  let soundEnabled = loadSoundSetting();
  let audioContext = null;
  let masterGain = null;
  let musicGain = null;
  const music = { playing: false, timer: 0, nextTime: 0, step: 0 };
  let toastTimer = null;
  let sessionTimer = null;
  let modalShouldResume = false;
  let previousFocus = null;
  const boardNodes = new Map();
  const pendingPicks = [];
  let state;

  function loadRecords() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return { best: Number(saved.best) || 0, wins: Number(saved.wins) || 0 };
    } catch {
      return { best: 0, wins: 0 };
    }
  }

  function saveRecords() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch {
      // 隐私模式下无法保存时，不影响本局游戏。
    }
  }

  function sanitizeTools(tools) {
    const count = (value, fallback) => {
      const num = Number(value);
      return Number.isFinite(num) ? Math.max(0, Math.min(99, num)) : fallback;
    };
    return {
      undo: count(tools?.undo, inventory.undo),
      shuffle: count(tools?.shuffle, inventory.shuffle),
      extract: count(tools?.extract, inventory.extract)
    };
  }

  function saveSession() {
    // 消除动画进行中状态不一致，跳过本次写入，保留上一份完整快照。
    if (!state || state.locked) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        v: 1,
        level: state.level,
        status: state.status,
        tiles: state.tiles.map(({ id, x, y, layer, type, removed }) => ({ id, x, y, layer, type, removed })),
        tray: [...state.tray],
        held: [...state.held],
        history: state.history.slice(-10),
        tools: { ...inventory },
        score: state.score,
        moves: state.moves,
        combo: state.combo,
        elapsed: getElapsed()
      }));
    } catch {
      // 存储不可用时忽略，本局仍可正常游玩。
    }
  }

  // 渲染可能连续触发，合并写入避免频繁操作 localStorage。
  function scheduleSave() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(saveSession, 400);
  }

  // 恢复上次未打完的牌局；数据缺失或版本不符时返回 false。
  function restoreSession() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch {
      return false;
    }
    if (!saved || saved.v !== 1 || !Array.isArray(saved.tiles) || !saved.tiles.length) return false;

    try {
      const tiles = saved.tiles.map((tile) => ({ ...tile, removed: Boolean(tile.removed) }));
      const tileMap = new Map(tiles.map((tile) => [tile.id, tile]));
      const level = Number(saved.level) || 1;
      Object.assign(inventory, sanitizeTools(saved.tools));
      state = {
        roundId: 1,
        level,
        hard: level % 3 === 0,
        tiles,
        tileMap,
        coverMap: buildCoverMap(tiles),
        tray: Array.isArray(saved.tray) ? saved.tray.filter((id) => tileMap.has(id)) : [],
        held: Array.isArray(saved.held) ? saved.held.filter((id) => tileMap.has(id)) : [],
        history: Array.isArray(saved.history) ? saved.history : [],
        tools: inventory,
        score: Number(saved.score) || 0,
        moves: Number(saved.moves) || 0,
        combo: Number(saved.combo) || 0,
        matching: [],
        locked: false,
        status: ['ready', 'playing', 'won', 'lost'].includes(saved.status) ? saved.status : 'ready',
        elapsed: Number(saved.elapsed) || 0,
        startedAt: 0,
        timer: null
      };
      renderAll();
      updateTime();
      showToast('已恢复上次进度');
      return true;
    } catch {
      return false;
    }
  }

  // 成绩只保存在本机浏览器。


  function loadSoundSetting() {
    try {
      return localStorage.getItem(SOUND_KEY) !== 'off';
    } catch {
      return true;
    }
  }

  function shuffled(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function createLayout(level = 1) {
    const positions = [];
    const addGrid = (layer, xs, ys, dx = 0, dy = 0) => {
      ys.forEach((y) => xs.forEach((x) => positions.push({
        id: `tile-${positions.length}`,
        x: x + dx, y: y + dy, layer, type: null, removed: false
      })));
    };
    const addSet = (baseLayer, dx, dy) => {
      addGrid(baseLayer, [84, 156, 228, 300, 372, 444], [70, 148, 226, 304, 382], dx, dy);
      addGrid(baseLayer + 1, [120, 192, 264, 336, 408], [109, 187, 265, 343], dx, dy);
      addGrid(baseLayer + 2, [156, 228, 300, 372], [148, 226, 304], dx, dy);
      addGrid(baseLayer + 3, [228, 300], [187, 265], dx, dy);
    };

    addSet(0, 0, 0);
    // 每 3 关叠上第二套错位牌，纸牌数量翻倍、层数更多。
    if (level % 3 === 0) addSet(4, 36, 39);
    return positions;
  }

  function overlaps(a, b) {
    return Math.abs(a.x - b.x) < TILE_WIDTH - 10 &&
      Math.abs(a.y - b.y) < TILE_HEIGHT - 10;
  }

  // 预先缓存每张牌被哪些上层牌压住，避免每次查询都全量扫描。
  function buildCoverMap(tiles) {
    const coverMap = new Map(tiles.map((tile) => [tile.id, []]));
    tiles.forEach((tile) => {
      tiles.forEach((other) => {
        if (other.layer > tile.layer && overlaps(tile, other)) {
          coverMap.get(tile.id).push(other.id);
        }
      });
    });
    return coverMap;
  }

  function typePoolFor(level) {
    // 前 3 关固定 8 种图案，之后每 2 关多 1 种，直到用满全部图案。
    const grown = EASY_TYPE_COUNT + Math.max(0, Math.floor((level - 3) / 2));
    return TYPES.slice(0, Math.min(TYPES.length, grown));
  }

  function assignSolvableTypes(tiles, tileMap, coverMap, pool) {
    let groups = null;
    const attempts = tiles.length > 100 ? 40 : 60;

    // 先模拟一条可完成的取牌路径，再把相同图案发给路径上的每组三张牌。
    for (let attempt = 0; attempt < attempts && !groups; attempt += 1) {
      const remaining = new Set(tiles.map((tile) => tile.id));
      const candidateGroups = [];

      while (remaining.size) {
        const available = shuffled([...remaining].filter((id) =>
          !coverMap.get(id).some((coverId) => remaining.has(coverId))
        ));
        if (available.length < 3) break;

        const group = available.slice(0, 3);
        candidateGroups.push(group);
        group.forEach((id) => remaining.delete(id));
      }

      if (!remaining.size) groups = candidateGroups;
    }

    if (!groups) throw new Error('无法生成可解牌局，请刷新重试。');

    const groupTypes = shuffled(groups.map((_, index) => pool[index % pool.length].id));
    groups.forEach((group, index) => {
      group.forEach((id) => { tileMap.get(id).type = groupTypes[index]; });
    });
  }

  function createState(level = 1) {
    const tiles = createLayout(level);
    const tileMap = new Map(tiles.map((tile) => [tile.id, tile]));
    const coverMap = buildCoverMap(tiles);
    assignSolvableTypes(tiles, tileMap, coverMap, typePoolFor(level));
    return {
      roundId: state ? state.roundId + 1 : 1,
      level,
      hard: level % 3 === 0,
      tiles,
      tileMap,
      coverMap,
      tray: [],
      held: [],
      history: [],
      tools: inventory,
      score: 0,
      moves: 0,
      combo: 0,
      matching: [],
      locked: false,
      status: 'ready',
      elapsed: 0,
      startedAt: 0,
      timer: null
    };
  }

  function newGame(level = 1) {
    if (state?.timer) clearInterval(state.timer);
    state = createState(level);
    pendingPicks.length = 0;
    dom.overlay.hidden = true;
    renderAll();
    updateTime();
  }

  function tileType(tile) {
    return TYPES.find((type) => type.id === tile.type);
  }

  function isBlocked(tile) {
    return state.coverMap.get(tile.id).some((id) => !state.tileMap.get(id).removed);
  }

  function remainingTiles() {
    return state.tiles.filter((tile) => !tile.removed);
  }

  function getElapsed() {
    return state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : state.elapsed;
  }

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
    const rest = (seconds % 60).toString().padStart(2, '0');
    return `${minutes}:${rest}`;
  }

  function updateTime() {
    state.elapsed = getElapsed();
    dom.time.textContent = formatTime(state.elapsed);
  }

  function startTimer() {
    if (state.status === 'ready') state.status = 'playing';
    if (state.status !== 'playing') return;
    if (!state.startedAt) state.startedAt = Date.now() - state.elapsed * 1000;
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(updateTime, 1000);
  }

  function stopTimer() {
    state.elapsed = getElapsed();
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.startedAt = 0;
    updateTime();
  }

  function tileContents(tile) {
    const type = tileType(tile);
    return `<svg class="tile-icon" aria-hidden="true"><use href="#tile-${type.id}"></use></svg><span class="tile-label">${type.name}</span>`;
  }

  function createTileNode(tile) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'tile';
    node.dataset.tileId = tile.id;
    node.style.left = `${tile.x / BOARD_WIDTH * 100}%`;
    node.style.top = `${tile.y / BOARD_HEIGHT * 100}%`;
    node.style.zIndex = `${tile.layer * 100 + Math.round(tile.y)}`;
    const face = document.createElement('span');
    face.className = 'tile-face';
    node.appendChild(face);
    return node;
  }

  // 增量更新棋盘：复用已有节点，避免重建 DOM 时丢掉正在进行的点击。
  function renderBoard() {
    const seen = new Set();

    state.tiles.forEach((tile) => {
      if (tile.removed) return;
      seen.add(tile.id);

      let node = boardNodes.get(tile.id);
      if (!node) {
        node = createTileNode(tile);
        boardNodes.set(tile.id, node);
        dom.board.appendChild(node);
      }

      const blocked = isBlocked(tile);
      const type = tileType(tile);
      node.classList.toggle('is-blocked', blocked);
      node.disabled = blocked;
      node.setAttribute('aria-label', `${type.name}，${blocked ? '被其他纸牌压住' : '可以选择'}`);

      if (node.dataset.type !== type.id) {
        node.dataset.type = type.id;
        node.firstChild.innerHTML = tileContents(tile);
      }
    });

    boardNodes.forEach((node, id) => {
      if (seen.has(id)) return;
      node.remove();
      boardNodes.delete(id);
    });
  }

  function renderTray() {
    const tileMap = new Map(state.tiles.map((tile) => [tile.id, tile]));

    if (dom.tray.children.length !== TRAY_CAPACITY) {
      dom.tray.innerHTML = '<div class="tray-slot" aria-hidden="true"></div>'.repeat(TRAY_CAPACITY);
    }

    Array.from(dom.tray.children).forEach((slot, index) => {
      const id = state.tray[index];
      const matching = Boolean(id) && state.matching.includes(id);
      const signature = id ? `${id}|${matching ? 'match' : ''}` : '';
      if (slot.dataset.signature === signature) return;
      slot.dataset.signature = signature;

      slot.classList.toggle('has-tile', Boolean(id));
      slot.classList.toggle('is-matching', matching);

      if (id) {
        slot.setAttribute('aria-label', tileType(tileMap.get(id)).name);
        slot.removeAttribute('aria-hidden');
        slot.innerHTML = tileContents(tileMap.get(id));
      } else {
        slot.removeAttribute('aria-label');
        slot.setAttribute('aria-hidden', 'true');
        slot.innerHTML = '';
      }
    });
  }

  function renderHeld() {
    const tileMap = new Map(state.tiles.map((tile) => [tile.id, tile]));
    dom.holdingRow.hidden = state.held.length === 0;
    dom.holdingSlots.innerHTML = Array.from({ length: HOLDING_CAPACITY }, (_, index) => {
      const id = state.held[index];
      if (!id) return '<span class="holding-slot" aria-hidden="true"></span>';
      const tile = tileMap.get(id);
      return `<button type="button" class="holding-slot" data-held-id="${id}" aria-label="将${tileType(tile).name}放回收集槽">${tileContents(tile)}</button>`;
    }).join('');
  }

  function renderHud() {
    const remaining = remainingTiles().length;
    const cleared = state.tiles.length - remaining;
    const percent = cleared / state.tiles.length * 100;
    const traySize = state.tray.length;

    dom.levelTitle.textContent = `青草坡 · 第 ${state.level} 关`;
    dom.hardBadge.hidden = !state.hard;
    dom.panel.classList.toggle('is-hard', state.hard);
    dom.sideLevel.textContent = state.level;
    dom.score.textContent = state.score.toLocaleString('zh-CN');
    dom.progressText.textContent = `剩余 ${remaining} 张纸牌`;
    dom.progressBar.style.width = `${percent}%`;
    dom.moveText.textContent = `${state.moves} 步`;
    dom.trayCount.textContent = `${traySize} / ${TRAY_CAPACITY}`;
    dom.trayCount.classList.toggle('is-danger', traySize >= 5);
    dom.cleared.textContent = cleared;
    dom.clearedTotal.textContent = state.tiles.length;
    dom.progressRing.style.setProperty('--progress', `${percent * 3.6}deg`);
    dom.bestScore.textContent = records.best ? records.best.toLocaleString('zh-CN') : '—';
    dom.winCount.textContent = records.wins;

    dom.undoCount.textContent = state.tools.undo;
    dom.shuffleCount.textContent = state.tools.shuffle;
    dom.extractCount.textContent = state.tools.extract;
    dom.undo.title = state.tools.undo > 0 ? `撤销一步（剩余 ${state.tools.undo} 次）` : '撤销次数已用完';
    dom.shuffle.title = state.tools.shuffle > 0 ? `洗牌（剩余 ${state.tools.shuffle} 次）` : '洗牌次数已用完';
    dom.extract.title = state.tools.extract > 0 ? `移出纸牌（剩余 ${state.tools.extract} 次）` : '移出次数已用完';
    dom.undo.disabled = state.locked || !state.history.length || state.tools.undo <= 0 || state.status === 'won';
    dom.shuffle.disabled = state.locked || remaining < 2 || state.tools.shuffle <= 0 || ['won', 'lost'].includes(state.status);
    dom.extract.disabled = state.locked || !traySize || state.held.length >= HOLDING_CAPACITY || state.tools.extract <= 0 || state.status === 'won';

    if (state.locked) {
      dom.boardCaption.innerHTML = '<span></span>相同的纸牌正在消除';
    } else if (traySize >= 5) {
      dom.boardCaption.innerHTML = '<span></span>卡槽紧张，优先凑齐已有图案';
    } else {
      dom.boardCaption.innerHTML = '<span></span>点选没有被压住的纸牌';
    }

    if (traySize >= 5) {
      dom.tipText.textContent = '卡槽快满了，先凑对已有图案，或使用撤销和移出道具腾出空间。';
      dom.progressHint.textContent = '注意卡槽，别让不同图案占满位置';
    } else if (cleared / state.tiles.length >= 0.67) {
      dom.tipText.textContent = '已经清理大半，留意每一层的位置，避免留下无法配对的孤牌。';
      dom.progressHint.textContent = '胜利在望，保持现在的节奏';
    } else {
      dom.tipText.textContent = '优先拿走压住更多纸牌的顶层牌，会让后面的选择更多。';
      dom.progressHint.textContent = '从顶层开始，慢慢清理牧场吧';
    }
  }

  function renderOverlay() {
    const finished = state.status === 'won' || state.status === 'lost';
    dom.overlay.hidden = !finished;
    if (!finished) return;

    const won = state.status === 'won';
    dom.resultIcon.classList.toggle('is-loss', !won);
    dom.resultIcon.innerHTML = won
      ? '<svg><use href="#icon-trophy"></use></svg>'
      : '<span>!</span>';
    dom.overlayKicker.textContent = won ? '挑战完成' : '卡槽已满';
    dom.overlayTitle.textContent = won ? '牧场焕然一新！' : '只差一点点';
    dom.overlayDescription.textContent = won
      ? '纸牌全部清空，时间奖励已计入分数。'
      : '可以重新挑战，或用撤销、移出道具补救。';
    dom.resultScore.textContent = state.score.toLocaleString('zh-CN');
    dom.resultTime.textContent = formatTime(state.elapsed);
    dom.overlayPrimary.textContent = won ? '前往下一关' : '重新挑战';
    dom.overlaySecondary.textContent = won ? '再玩一次本关' : '查看玩法说明';
  }

  function renderAll() {
    renderBoard();
    renderTray();
    renderHeld();
    renderHud();
    renderOverlay();
    scheduleSave();
  }

  function pushHistory() {
    state.history.push({
      removedIds: state.tiles.filter((tile) => tile.removed).map((tile) => tile.id),
      tray: [...state.tray],
      held: [...state.held],
      score: state.score,
      moves: state.moves,
      combo: state.combo,
      elapsed: getElapsed()
    });
    if (state.history.length > 30) state.history.shift();
  }

  function selectBoardTile(id) {
    if (['won', 'lost'].includes(state.status)) return;
    if (state.locked) {
      // 消除动画期间先记录点击，动画结束后立即处理，避免连点被丢弃。
      if (pendingPicks.length < 3) pendingPicks.push(id);
      return;
    }
    const tile = state.tiles.find((item) => item.id === id);
    if (!tile || tile.removed || isBlocked(tile)) return;

    startTimer();
    pushHistory();
    tile.removed = true;
    state.moves += 1;
    insertIntoTray(tile);
    playSound('pick');
  }

  function flushPendingPicks() {
    while (pendingPicks.length && !state.locked && !['won', 'lost'].includes(state.status)) {
      selectBoardTile(pendingPicks.shift());
    }
    if (['won', 'lost'].includes(state.status)) pendingPicks.length = 0;
  }

  function selectHeldTile(id) {
    if (state.locked || ['won', 'lost'].includes(state.status)) return;
    if (state.tray.length >= TRAY_CAPACITY) {
      showToast('收集槽已满，暂时无法放回');
      return;
    }
    const tile = state.tiles.find((item) => item.id === id);
    if (!tile || !state.held.includes(id)) return;

    startTimer();
    pushHistory();
    state.held = state.held.filter((heldId) => heldId !== id);
    state.moves += 1;
    insertIntoTray(tile);
    playSound('pick');
  }

  function insertIntoTray(tile) {
    let lastSameIndex = -1;
    state.tray.forEach((id, index) => {
      if (state.tiles.find((item) => item.id === id).type === tile.type) lastSameIndex = index;
    });
    if (lastSameIndex === -1) state.tray.push(tile.id);
    else state.tray.splice(lastSameIndex + 1, 0, tile.id);
    resolveTray(tile.type);
  }

  function resolveTray(typeId) {
    const matches = state.tray.filter((id) =>
      state.tiles.find((tile) => tile.id === id).type === typeId
    ).slice(0, 3);

    if (matches.length < 3) {
      state.combo = 0;
      checkEnd();
      renderAll();
      return;
    }

    state.combo += 1;
    state.matching = matches;
    state.locked = true;
    const roundId = state.roundId;
    renderAll();

    setTimeout(() => {
      if (roundId !== state.roundId) return;
      state.tray = state.tray.filter((id) => !matches.includes(id));
      state.score += 100 + (state.combo - 1) * 25;
      state.matching = [];
      state.locked = false;
      playSound('match');
      checkEnd();
      renderAll();
      flushPendingPicks();
    }, 220);
  }

  function checkEnd() {
    const boardClear = remainingTiles().length === 0;
    if (boardClear && state.tray.length === 0 && state.held.length === 0) {
      finishGame(true);
    } else if (state.tray.length >= TRAY_CAPACITY) {
      finishGame(false);
    }
  }

  function finishGame(won) {
    stopTimer();
    state.status = won ? 'won' : 'lost';
    state.locked = false;
    if (won) {
      state.score += Math.max(0, 500 - state.elapsed * 2);
      records.wins += 1;
      playSound('win');
      launchConfetti();
    } else {
      playSound('lose');
    }
    records.best = Math.max(records.best, state.score);
    saveRecords();
  }

  function resumeAfterTool() {
    if (state.status === 'lost') {
      state.status = 'playing';
      dom.overlay.hidden = true;
    }
    startTimer();
  }

  function useUndo() {
    if (state.locked || state.tools.undo <= 0 || !state.history.length || state.status === 'won') return;
    const snapshot = state.history.pop();
    const usesLeft = state.tools.undo - 1;
    const removed = new Set(snapshot.removedIds);
    state.tiles.forEach((tile) => { tile.removed = removed.has(tile.id); });
    state.tray = snapshot.tray;
    state.held = snapshot.held;
    state.score = snapshot.score;
    state.moves = snapshot.moves;
    state.combo = snapshot.combo;
    state.elapsed = snapshot.elapsed;
    state.tools.undo = usesLeft;
    state.matching = [];
    state.status = 'playing';
    state.startedAt = 0;
    dom.overlay.hidden = true;
    startTimer();
    renderAll();
    playSound('tool');
    showToast('已撤销上一步');
  }

  function useShuffle() {
    if (state.locked || state.tools.shuffle <= 0 || ['won', 'lost'].includes(state.status)) return;
    const active = remainingTiles();
    if (active.length < 2) return;
    const types = shuffled(active.map((tile) => tile.type));
    active.forEach((tile, index) => { tile.type = types[index]; });
    state.tools.shuffle -= 1;
    state.combo = 0;
    renderAll();
    playSound('tool');
    showToast('剩余纸牌的图案已重新排列');
  }

  function useExtract() {
    if (state.locked || state.tools.extract <= 0 || !state.tray.length || state.status === 'won') return;
    const space = HOLDING_CAPACITY - state.held.length;
    if (!space) {
      showToast('暂存区已满，请先将纸牌放回');
      return;
    }
    resumeAfterTool();
    const count = Math.min(space, state.tray.length);
    const extracted = state.tray.splice(0, count);
    state.held.push(...extracted);
    state.tools.extract -= 1;
    state.combo = 0;
    renderAll();
    playSound('tool');
    showToast(`已移出 ${count} 张纸牌，点击暂存牌可放回`);
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.classList.add('is-visible');
    toastTimer = setTimeout(() => dom.toast.classList.remove('is-visible'), 2200);
  }

  function updateSoundButton() {
    dom.soundIcon.setAttribute('href', soundEnabled ? '#icon-volume' : '#icon-mute');
    dom.soundButton.setAttribute('aria-label', soundEnabled ? '关闭声音（音效与背景音乐）' : '打开声音（音效与背景音乐）');
  }

  // 首次交互时创建音频上下文，并接入音量总线，供音效和背景音乐共用。
  function ensureAudio() {
    try {
      if (!audioContext) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return null;
        audioContext = new AudioContext();
        masterGain = audioContext.createGain();
        masterGain.gain.value = .9;
        masterGain.connect(audioContext.destination);
        musicGain = audioContext.createGain();
        musicGain.gain.value = .0001;
        const softener = audioContext.createBiquadFilter();
        softener.type = 'lowpass';
        softener.frequency.value = 2400;
        musicGain.connect(softener);
        softener.connect(masterGain);
      }
      if (audioContext.state === 'suspended') audioContext.resume();
      return audioContext;
    } catch {
      return null;
    }
  }

  function playTone(frequency, {
    type = 'sine', delay = 0, duration = .2, gain = .05, attack = .012, bus = null
  } = {}) {
    if (!audioContext) return;
    const start = audioContext.currentTime + delay;
    const oscillator = audioContext.createOscillator();
    const amp = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    amp.gain.setValueAtTime(.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + attack);
    amp.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(amp);
    amp.connect(bus || masterGain);
    oscillator.start(start);
    oscillator.stop(start + duration + .03);
  }

  function playSound(kind) {
    if (!soundEnabled || !ensureAudio()) return;
    const chords = {
      // 轻快的木琴单音，选中纸牌时使用。
      pick: () => {
        playTone(659.25, { duration: .17, gain: .05, attack: .006 });
        playTone(987.77, { duration: .12, gain: .016, attack: .006 });
      },
      // 三连音上行的柔和风铃，消除成功时使用。
      match: () => {
        [523.25, 659.25, 783.99].forEach((f, i) =>
          playTone(f, { type: 'triangle', delay: i * .075, duration: .3, gain: .04, attack: .008 }));
        playTone(1046.5, { delay: .16, duration: .34, gain: .018 });
      },
      // 低频轻触，道具生效时使用。
      tool: () => {
        playTone(392, { duration: .22, gain: .038 });
        playTone(587.33, { delay: .07, duration: .24, gain: .026 });
      },
      lose: () => {
        [392, 329.63, 261.63].forEach((f, i) =>
          playTone(f, { delay: i * .14, duration: .32, gain: .04 }));
      },
      win: () => {
        [523.25, 587.33, 659.25, 783.99, 880].forEach((f, i) =>
          playTone(f, { type: 'triangle', delay: i * .12, duration: .38, gain: .038 }));
        playTone(1046.5, { delay: .62, duration: .7, gain: .026, attack: .06 });
      }
    };
    (chords[kind] || (() => {}))();
  }

  // 背景音乐：四段温和的和弦循环，配合缓慢的琶音，音量很低。
  const MUSIC_STEP = .56;
  const MUSIC_STEPS_PER_CHORD = 8;
  const MUSIC_LOOKAHEAD = 1;
  const MUSIC_CHORDS = [
    [53, 57, 60, 64], // Fmaj7
    [55, 59, 62, 64], // G6
    [52, 55, 59, 62], // Em7
    [57, 60, 64, 67]  // Am7
  ];
  const MUSIC_PATTERN = [0, 1, 2, 3, 2, 1, 3, 2];
  const midiToFrequency = (note) => 440 * Math.pow(2, (note - 69) / 12);

  function scheduleMusicStep(step, at) {
    const chord = MUSIC_CHORDS[Math.floor(step / MUSIC_STEPS_PER_CHORD) % MUSIC_CHORDS.length];
    const index = step % MUSIC_STEPS_PER_CHORD;
    const chordLength = MUSIC_STEP * MUSIC_STEPS_PER_CHORD;

    if (index === 0) {
      const delay = at - audioContext.currentTime;
      // 低音铺底与柔和的长音和弦，让循环更连贯。
      playTone(midiToFrequency(chord[0] - 12), { delay, duration: chordLength * .95, gain: .05, attack: .9, bus: musicGain });
      chord.forEach((note) =>
        playTone(midiToFrequency(note), { type: 'triangle', delay, duration: chordLength * .82, gain: .011, attack: 1.1, bus: musicGain }));
    }

    const note = chord[MUSIC_PATTERN[index]] + 12;
    playTone(midiToFrequency(note), {
      delay: at - audioContext.currentTime,
      duration: MUSIC_STEP * 1.7,
      gain: .034,
      attack: .02,
      bus: musicGain
    });
  }

  function pumpMusic() {
    if (!music.playing || !audioContext) return;
    while (music.nextTime < audioContext.currentTime + MUSIC_LOOKAHEAD) {
      scheduleMusicStep(music.step, music.nextTime);
      music.step += 1;
      music.nextTime += MUSIC_STEP;
    }
  }

  function startMusic() {
    if (!soundEnabled || music.playing || !ensureAudio()) return;
    music.playing = true;
    music.step = 0;
    music.nextTime = audioContext.currentTime + .2;
    const now = audioContext.currentTime;
    musicGain.gain.cancelScheduledValues(now);
    musicGain.gain.setValueAtTime(Math.max(musicGain.gain.value, .0001), now);
    musicGain.gain.linearRampToValueAtTime(.55, now + 2.4);
    music.timer = setInterval(pumpMusic, 260);
    pumpMusic();
  }

  function stopMusic() {
    if (!music.playing) return;
    music.playing = false;
    clearInterval(music.timer);
    music.timer = 0;
    if (!audioContext || !musicGain) return;
    const now = audioContext.currentTime;
    musicGain.gain.cancelScheduledValues(now);
    musicGain.gain.setValueAtTime(musicGain.gain.value, now);
    musicGain.gain.linearRampToValueAtTime(.0001, now + .7);
  }

  function toggleSound() {
    soundEnabled = !soundEnabled;
    try {
      localStorage.setItem(SOUND_KEY, soundEnabled ? 'on' : 'off');
    } catch {
      // 声音设置保存失败不影响切换。
    }
    updateSoundButton();
    if (soundEnabled) {
      ensureAudio();
      startMusic();
      playSound('tool');
    } else {
      stopMusic();
    }
  }

  // 浏览器要求先有用户操作才能播放声音，首次点击或按键时开启背景音乐。
  function unlockAudio(event) {
    if (event?.target?.closest?.('#soundButton')) return;
    if (!soundEnabled) return;
    ensureAudio();
    startMusic();
  }

  function launchConfetti() {
    const colors = ['#6f9963', '#e8b957', '#d78978', '#a98dbb', '#85b5b3'];
    for (let i = 0; i < 42; i += 1) {
      const piece = document.createElement('i');
      piece.className = 'confetti';
      piece.style.left = `${Math.random() * 100}vw`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = `${Math.random() * .7}s`;
      piece.style.setProperty('--drift', `${Math.random() * 180 - 90}px`);
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 3700);
    }
  }

  function openHelp() {
    previousFocus = document.activeElement;
    modalShouldResume = state.status === 'playing';
    if (modalShouldResume) stopTimer();
    dom.helpModal.hidden = false;
    $('closeHelpButton').focus();
  }

  function closeHelp() {
    dom.helpModal.hidden = true;
    if (modalShouldResume) startTimer();
    modalShouldResume = false;
    if (previousFocus) previousFocus.focus();
  }

  dom.board.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tile-id]');
    if (button) selectBoardTile(button.dataset.tileId);
  });
  dom.holdingSlots.addEventListener('click', (event) => {
    const button = event.target.closest('[data-held-id]');
    if (button) selectHeldTile(button.dataset.heldId);
  });
  dom.undo.addEventListener('click', useUndo);
  dom.shuffle.addEventListener('click', useShuffle);
  dom.extract.addEventListener('click', useExtract);
  $('restartButton').addEventListener('click', () => {
    newGame(state.level);
    showToast('本关已重新开始');
  });
  dom.soundButton.addEventListener('click', toggleSound);
  dom.overlayPrimary.addEventListener('click', () => {
    newGame(state.status === 'won' ? state.level + 1 : state.level);
  });
  dom.overlaySecondary.addEventListener('click', () => {
    if (state.status === 'won') newGame(state.level);
    else openHelp();
  });
  ['helpButton', 'tipHelpButton'].forEach((id) => $(id).addEventListener('click', openHelp));
  ['closeHelpButton', 'startPlayingButton'].forEach((id) => $(id).addEventListener('click', closeHelp));
  dom.helpModal.querySelector('[data-close-modal]').addEventListener('click', closeHelp);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.helpModal.hidden) closeHelp();
  });
  // 首次交互后再启动音频，符合浏览器的自动播放限制。
  ['pointerdown', 'keydown'].forEach((name) => document.addEventListener(name, unlockAudio, { once: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveSession();
    if (!audioContext) return;
    if (document.hidden) audioContext.suspend();
    else if (soundEnabled) audioContext.resume();
  });
  window.addEventListener('beforeunload', saveSession);

  updateSoundButton();
  if (!restoreSession()) newGame();
})();
