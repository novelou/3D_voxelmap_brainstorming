(() => {
  "use strict";

  const STORAGE_KEY = "indoor-map-lab-v1";
  const BACKUP_KEY = "indoor-map-lab-v1-before-voxel-merge";
  const COLORS = ["#f8d75a", "#5bd5eb", "#a994ff", "#ff9b65", "#7bdd9b", "#f1f5fa"];
  const ISO_X = 31;
  const ISO_Y = 16;
  const TOP_UNIT = 46;
  const HISTORY_LIMIT = 50;
  const DIMMED_ALPHA = .22;
  const FLOOR_PITCH = 104;
  const ROOM_HEIGHT = 27;
  const ISO_X_SCALE = ISO_X * Math.SQRT2;
  const ISO_Y_SCALE = ISO_Y * Math.SQRT2;

  const canvas = document.getElementById("mapCanvas");
  const ctx = canvas.getContext("2d");
  const properties = document.getElementById("properties");
  const toastElement = document.getElementById("toast");
  const els = {
    floorCount: document.getElementById("floorCount"),
    activeFloor: document.getElementById("activeFloor"),
    visibleFloor: document.getElementById("visibleFloor"),
    focusFloor: document.getElementById("focusFloor"),
    viewMode: document.getElementById("viewMode"),
    undoButton: document.getElementById("undoButton"),
    redoButton: document.getElementById("redoButton"),
    gridWidth: document.getElementById("gridWidth"),
    gridDepth: document.getElementById("gridDepth"),
    modeHelp: document.getElementById("modeHelp"),
    viewHelp: document.getElementById("viewHelp"),
    canvasHint: document.getElementById("canvasHint"),
    saveStatus: document.getElementById("saveStatus")
  };

  const emptyMap = () => ({ version: 2, floors: 2, width: 12, depth: 10, rooms: [], connectors: [] });
  let map = loadMap();
  let mode = "select";
  let activeFloor = 1;
  let visibleFloor = "all";
  let focusFloor = "none";
  let viewMode = "iso";
  let selected = null;
  let connectorStart = null;
  let drag = null;
  let cameraDrag = null;
  const camera = { yaw: Math.PI / 4, tilt: 1, zoom: 1, panX: 0, panY: 0 };
  let nextNumber = 1;
  let view = null;
  let toastTimer = 0;
  let cssWidth = 1;
  let cssHeight = 1;
  const undoStack = [];
  const redoStack = [];
  let historyGroup = null;

  function isInteger(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max;
  }

  function validateMap(value) {
    if (!value || !isInteger(value.floors, 1, 30) || !isInteger(value.width, 4, 30) || !isInteger(value.depth, 4, 30)) throw new Error("階層数または格子サイズが不正です。");
    if (!Array.isArray(value.rooms) || !Array.isArray(value.connectors) || value.rooms.length > 900 || value.connectors.length > 1800) throw new Error("部屋またはコネクタの数が不正です。");
    const rooms = [];
    const ids = new Set();
    let cellCount = 0;
    for (const raw of value.rooms) {
      const room = {
        id: String(raw.id ?? ""),
        title: String(raw.title ?? "").slice(0, 100),
        description: String(raw.description ?? "").slice(0, 3000),
        floor: Number(raw.floor), cells: []
      };
      if (Array.isArray(raw.cells)) {
        room.cells = raw.cells.map(cell => ({ x: Number(cell.x), y: Number(cell.y) }));
      } else {
        const x = Number(raw.x), y = Number(raw.y), w = Number(raw.w), d = Number(raw.d);
        if (!isInteger(x, 0, value.width - 1) || !isInteger(y, 0, value.depth - 1) || !isInteger(w, 1, value.width) || !isInteger(d, 1, value.depth) || x + w > value.width || y + d > value.depth) throw new Error("部屋の配置データが不正です。");
        for (let cy = y; cy < y + d; cy++) for (let cx = x; cx < x + w; cx++) room.cells.push({ x: cx, y: cy });
      }
      cellCount += room.cells.length;
      const uniqueCells = new Set(room.cells.map(cell => `${cell.x},${cell.y}`));
      if (!room.id || ids.has(room.id) || !isInteger(room.floor, 1, value.floors) || !room.cells.length || cellCount > value.width * value.depth * value.floors || uniqueCells.size !== room.cells.length || room.cells.some(cell => !isInteger(cell.x, 0, value.width - 1) || !isInteger(cell.y, 0, value.depth - 1)) || rooms.some(other => overlaps(room, other))) throw new Error("部屋の配置データが不正です。");
      ids.add(room.id);
      rooms.push(room);
    }
    const connectors = [];
    const connectorIds = new Set();
    for (const raw of value.connectors) {
      const connector = { id: String(raw.id ?? ""), from: String(raw.from ?? ""), to: String(raw.to ?? ""), description: String(raw.description ?? "").slice(0, 3000), color: COLORS.includes(raw.color) ? raw.color : COLORS[0] };
      if (!connector.id || connectorIds.has(connector.id) || !ids.has(connector.from) || !ids.has(connector.to) || connector.from === connector.to) throw new Error("コネクタの接続データが不正です。");
      connectorIds.add(connector.id);
      connectors.push(connector);
    }
    const state = { version: 2, floors: value.floors, width: value.width, depth: value.depth, rooms, connectors };
    for (const room of [...rooms]) if (state.rooms.includes(room)) mergeAdjacent(state, room.id);
    return state;
  }

  function loadMap() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return emptyMap();
      const parsed = JSON.parse(stored);
      if (parsed.version !== 2 && !localStorage.getItem(BACKUP_KEY)) {
        try { localStorage.setItem(BACKUP_KEY, stored); } catch (error) { console.warn("旧データのバックアップを保存できませんでした:", error); }
      }
      return validateMap(parsed);
    } catch (error) {
      console.warn("保存データを読み込めませんでした:", error);
      return emptyMap();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
      els.saveStatus.textContent = "自動保存";
    } catch (error) {
      els.saveStatus.textContent = "保存不可・JSONを書き出してください";
    }
  }

  function snapshot() {
    return { map: JSON.stringify(map), selected: selected ? { ...selected } : null };
  }

  function refreshHistoryButtons() {
    els.undoButton.disabled = undoStack.length === 0;
    els.redoButton.disabled = redoStack.length === 0;
  }

  function recordChange(group = null) {
    if (group === null || historyGroup !== group) {
      undoStack.push(snapshot());
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    }
    redoStack.length = 0;
    historyGroup = group;
    refreshHistoryButtons();
  }

  function restoreSnapshot(state) {
    map = JSON.parse(state.map);
    selected = state.selected;
    if (selected && !(selected.type === "room" ? roomById(selected.id) : connectorById(selected.id))) selected = null;
    connectorStart = null;
    drag = null;
    cameraDrag = null;
    canvas.classList.remove("dragging", "orbiting");
    historyGroup = null;
    save();
    refreshControls();
    renderProperties();
    draw();
    refreshHistoryButtons();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restoreSnapshot(undoStack.pop());
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restoreSnapshot(redoStack.pop());
  }

  function overlaps(a, b) {
    if (a.floor !== b.floor) return false;
    const cells = new Set(b.cells.map(cell => `${cell.x},${cell.y}`));
    return a.cells.some(cell => cells.has(`${cell.x},${cell.y}`));
  }

  function canPlace(candidate, exceptId = null) {
    return candidate.cells.every(cell => isInteger(cell.x, 0, map.width - 1) && isInteger(cell.y, 0, map.depth - 1)) && !map.rooms.some(room => room.id !== exceptId && overlaps(candidate, room));
  }

  function roomBounds(room) {
    return { x: Math.min(...room.cells.map(cell => cell.x)), y: Math.min(...room.cells.map(cell => cell.y)) };
  }

  function roomCenter(room) {
    const total = room.cells.reduce((sum, cell) => ({ x: sum.x + cell.x + .5, y: sum.y + cell.y + .5 }), { x: 0, y: 0 });
    return { x: total.x / room.cells.length, y: total.y / room.cells.length };
  }

  function roomAnchor(room) {
    const center = roomCenter(room);
    if (room.cells.some(cell => center.x >= cell.x && center.x <= cell.x + 1 && center.y >= cell.y && center.y <= cell.y + 1)) return center;
    const closest = room.cells.reduce((best, cell) => {
      const distance = (cell.x + .5 - center.x) ** 2 + (cell.y + .5 - center.y) ** 2;
      return distance < best.distance ? { cell, distance } : best;
    }, { cell: room.cells[0], distance: Infinity }).cell;
    return { x: closest.x + .5, y: closest.y + .5 };
  }

  function wallExit(room, toward) {
    const start = roomAnchor(room);
    const dx = toward.x - start.x, dy = toward.y - start.y;
    if (Math.hypot(dx, dy) < 1e-8) return start;
    const cells = new Set(room.cells.map(cell => `${cell.x},${cell.y}`));
    let bestT = Infinity;
    for (const cell of room.cells) {
      const edges = [
        { neighbor: `${cell.x - 1},${cell.y}`, axis: "x", value: cell.x, min: cell.y, max: cell.y + 1 },
        { neighbor: `${cell.x + 1},${cell.y}`, axis: "x", value: cell.x + 1, min: cell.y, max: cell.y + 1 },
        { neighbor: `${cell.x},${cell.y - 1}`, axis: "y", value: cell.y, min: cell.x, max: cell.x + 1 },
        { neighbor: `${cell.x},${cell.y + 1}`, axis: "y", value: cell.y + 1, min: cell.x, max: cell.x + 1 }
      ];
      for (const edge of edges) {
        if (cells.has(edge.neighbor)) continue;
        const axisDelta = edge.axis === "x" ? dx : dy;
        if (Math.abs(axisDelta) < 1e-8) continue;
        const t = (edge.value - (edge.axis === "x" ? start.x : start.y)) / axisDelta;
        const otherValue = edge.axis === "x" ? start.y + t * dy : start.x + t * dx;
        if (t > 1e-8 && otherValue >= edge.min - 1e-8 && otherValue <= edge.max + 1e-8) bestT = Math.min(bestT, t);
      }
    }
    return Number.isFinite(bestT) ? { x: start.x + bestT * dx, y: start.y + bestT * dy } : start;
  }

  function roomsTouch(a, b) {
    if (a.floor !== b.floor) return false;
    const cells = new Set(b.cells.map(cell => `${cell.x},${cell.y}`));
    return a.cells.some(cell => cells.has(`${cell.x + 1},${cell.y}`) || cells.has(`${cell.x - 1},${cell.y}`) || cells.has(`${cell.x},${cell.y + 1}`) || cells.has(`${cell.x},${cell.y - 1}`));
  }

  function mergeInto(state, primary, secondary) {
    primary.cells.push(...secondary.cells);
    state.rooms = state.rooms.filter(room => room.id !== secondary.id);
    for (const connector of state.connectors) {
      if (connector.from === secondary.id) connector.from = primary.id;
      if (connector.to === secondary.id) connector.to = primary.id;
    }
    const seen = new Set();
    state.connectors = state.connectors.filter(connector => {
      if (connector.from === connector.to) return false;
      const key = [connector.from, connector.to].sort().join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function mergeAdjacent(state, primaryId) {
    const primary = state.rooms.find(room => room.id === primaryId);
    if (!primary) return null;
    let neighbor;
    while ((neighbor = state.rooms.find(room => room.id !== primary.id && roomsTouch(primary, room)))) mergeInto(state, primary, neighbor);
    return primary;
  }

  function roomById(id) { return map.rooms.find(room => room.id === id); }
  function connectorById(id) { return map.connectors.find(connector => connector.id === id); }
  function visibleFloors() { return visibleFloor === "all" ? Array.from({ length: map.floors }, (_, i) => i + 1) : [Number(visibleFloor)]; }
  function roomVisible(room) { return visibleFloor === "all" || room.floor === Number(visibleFloor); }
  function connectorVisible(connector) {
    const from = roomById(connector.from);
    const to = roomById(connector.to);
    return from && to && roomVisible(from) && roomVisible(to);
  }

  function uid(prefix) { return `${prefix}${Date.now().toString(36)}${(nextNumber++).toString(36)}`; }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
  function showToast(message) {
    toastElement.textContent = message;
    toastElement.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastElement.classList.remove("show"), 3400);
  }

  function refreshControls() {
    els.floorCount.value = map.floors;
    els.gridWidth.value = map.width;
    els.gridDepth.value = map.depth;
    if (activeFloor > map.floors) activeFloor = map.floors;
    if (visibleFloor !== "all" && Number(visibleFloor) > map.floors) visibleFloor = "all";
    if (focusFloor !== "none" && Number(focusFloor) > map.floors) focusFloor = "none";
    els.activeFloor.innerHTML = Array.from({ length: map.floors }, (_, i) => `<option value="${i + 1}">${i + 1}階</option>`).join("");
    els.activeFloor.value = String(activeFloor);
    els.visibleFloor.innerHTML = `<option value="all">全て</option>` + Array.from({ length: map.floors }, (_, i) => `<option value="${i + 1}">${i + 1}階</option>`).join("");
    els.visibleFloor.value = String(visibleFloor);
    els.focusFloor.innerHTML = `<option value="none">なし</option>` + Array.from({ length: map.floors }, (_, i) => `<option value="${i + 1}">${i + 1}階</option>`).join("");
    els.focusFloor.value = focusFloor;
    els.focusFloor.disabled = visibleFloor !== "all";
    if (visibleFloor === "all") viewMode = "iso";
    els.viewMode.value = viewMode;
    els.viewMode.disabled = visibleFloor === "all";
    els.viewHelp.textContent = visibleFloor === "all"
      ? "右ドラッグで回転・角度調整。Shift+右ドラッグで移動、ホイールで拡大縮小。強調する階を選ぶと他階が半透明になります。真上視点は特定階のみ。"
      : viewMode === "top"
        ? "右ドラッグで移動、ホイールで拡大縮小できます。"
        : "右ドラッグで回転・角度調整。Shift+右ドラッグで移動、ホイールで拡大縮小。";
    document.querySelectorAll(".tool-button").forEach(button => {
      const active = button.dataset.mode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    els.modeHelp.textContent = mode === "room" ? `${activeFloor}階の格子をクリックして1×1ボクセルを置きます。隣接すると既存の部屋に統合されます。` : mode === "connector" ? (connectorStart ? "接続先の部屋をクリックしてください。" : "接続元の部屋、次に接続先の部屋をクリックしてください。") : "部屋をドラッグして移動できます。線もクリックで選択できます。";
    els.canvasHint.textContent = mode === "room" ? `${activeFloor}階の格子をクリックして1×1ボクセルを配置` : mode === "connector" ? (connectorStart ? "接続先の部屋をクリック" : "接続元の部屋をクリック") : map.rooms.length ? "部屋をクリックして編集・ドラッグで移動" : "右の「部屋を追加」を選び、格子をクリック";
  }

  function select(type, id) {
    selected = type && id ? { type, id } : null;
    renderProperties();
    draw();
  }

  function renderProperties() {
    if (!selected) {
      properties.innerHTML = `<div class="empty-selection">部屋またはコネクタを選ぶと<br>ここで内容を編集できます。</div>`;
      return;
    }
    if (selected.type === "room") {
      const room = roomById(selected.id);
      if (!room) { selected = null; renderProperties(); return; }
      const bounds = roomBounds(room);
      properties.innerHTML = `
        <span class="selection-chip">部屋</span>
        <div class="field-grid full">
          <label class="field">タイトル<input data-field="title" maxlength="100" value="${escapeHtml(room.title)}"></label>
          <label class="field">説明<textarea data-field="description" maxlength="3000">${escapeHtml(room.description)}</textarea></label>
        </div>
        <div class="field-grid two">
          <label class="field">階<select data-field="floor">${Array.from({ length: map.floors }, (_, i) => `<option value="${i + 1}" ${room.floor === i + 1 ? "selected" : ""}>${i + 1}階</option>`).join("")}</select></label>
          <div></div>
          <label class="field">X位置<input data-field="x" type="number" min="0" max="${map.width - 1}" value="${bounds.x}"></label>
          <label class="field">Y位置<input data-field="y" type="number" min="0" max="${map.depth - 1}" value="${bounds.y}"></label>
        </div>
        <p class="helper">${room.cells.length}ボクセル。移動先で他の部屋に接すると統合されます。</p>
        <button class="danger-button" data-action="delete">この部屋を削除</button>`;
    } else {
      const connector = connectorById(selected.id);
      if (!connector) { selected = null; renderProperties(); return; }
      const from = roomById(connector.from), to = roomById(connector.to);
      const connectionType = from.floor === to.floor ? "同じ階: 壁から壁へ接続" : "階をまたぐ接続: 下階の天面から上階の底面へ接続";
      const options = map.rooms.map(room => `<option value="${escapeHtml(room.id)}">${room.floor}階 · ${escapeHtml(room.title || "名称なし")}</option>`).join("");
      properties.innerHTML = `
        <span class="selection-chip connector">コネクタ</span>
        <div class="field-grid full">
          <label class="field">説明<textarea data-field="description" maxlength="3000">${escapeHtml(connector.description)}</textarea></label>
          <label class="field">接続元<select data-field="from">${options}</select></label>
          <label class="field">接続先<select data-field="to">${options}</select></label>
          <label class="field">線の色</label>
        </div>
        <div class="color-options" role="group" aria-label="線の色">${COLORS.map(color => `<button class="color-choice ${connector.color === color ? "active" : ""}" data-color="${color}" style="--swatch:${color}" title="${color}" aria-label="${color}" aria-pressed="${connector.color === color}"></button>`).join("")}</div>
        <p class="helper">${connectionType}</p>
        <button class="danger-button" data-action="delete">このコネクタを削除</button>`;
      properties.querySelector('[data-field="from"]').value = connector.from;
      properties.querySelector('[data-field="to"]').value = connector.to;
    }
  }

  function updateProperty(target) {
    if (!selected) return;
    const field = target.dataset.field;
    if (!field) return;
    const item = selected.type === "room" ? roomById(selected.id) : connectorById(selected.id);
    if (!item) return;
    if (field === "title" || field === "description") {
      if (item[field] === target.value) return;
      recordChange(target);
      item[field] = target.value;
      save(); draw();
      return;
    }
    if (selected.type === "room") {
      const number = Number(target.value);
      const bounds = roomBounds(item);
      const dx = field === "x" ? number - bounds.x : 0;
      const dy = field === "y" ? number - bounds.y : 0;
      const candidate = { ...item, floor: field === "floor" ? number : item.floor, cells: item.cells.map(cell => ({ x: cell.x + dx, y: cell.y + dy })) };
      if (!Number.isInteger(number) || !isInteger(candidate.floor, 1, map.floors) || !canPlace(candidate, item.id)) {
        target.value = field === "floor" ? item.floor : bounds[field];
        showToast("格子外または他の部屋と重なるため変更できません。");
        return;
      }
      if (number === (field === "floor" ? item.floor : bounds[field])) return;
      recordChange();
      item.floor = candidate.floor;
      item.cells = candidate.cells;
      absorbMovedRoom(item);
      if (field === "floor") {
        activeFloor = number;
        if (visibleFloor !== "all") visibleFloor = String(number);
        refreshControls();
      }
      renderProperties();
    } else {
      if (target.value === item[field]) return;
      if (target.value === item[field === "from" ? "to" : "from"]) {
        target.value = item[field];
        showToast("接続元と接続先には別の部屋を選んでください。");
        return;
      }
      recordChange();
      item[field] = target.value;
      renderProperties();
    }
    save(); draw();
  }

  function absorbMovedRoom(room) {
    const neighbor = map.rooms.find(other => other.id !== room.id && roomsTouch(room, other));
    if (!neighbor) return room;
    const primary = mergeAdjacent(map, neighbor.id);
    selected = { type: "room", id: primary.id };
    connectorStart = null;
    return primary;
  }

  function deleteSelected() {
    if (!selected) return;
    recordChange();
    if (selected.type === "room") {
      map.rooms = map.rooms.filter(room => room.id !== selected.id);
      map.connectors = map.connectors.filter(connector => connector.from !== selected.id && connector.to !== selected.id);
    } else {
      map.connectors = map.connectors.filter(connector => connector.id !== selected.id);
    }
    selected = null;
    connectorStart = null;
    save(); refreshControls(); renderProperties(); draw();
  }

  function setMode(value) {
    mode = value;
    connectorStart = null;
    refreshControls(); draw();
  }

  function addRoom(cell) {
    if (!cell) return;
    const candidate = { floor: activeFloor, cells: [{ x: cell.x, y: cell.y }] };
    if (!canPlace(candidate)) {
      const room = map.rooms.find(other => overlaps(candidate, other));
      if (room) select("room", room.id);
      return;
    }
    const neighbor = map.rooms.find(room => roomsTouch(candidate, room));
    recordChange();
    let room;
    if (neighbor) {
      neighbor.cells.push(candidate.cells[0]);
      room = mergeAdjacent(map, neighbor.id);
    } else {
      room = { id: uid("r"), title: `部屋 ${map.rooms.length + 1}`, description: "", ...candidate };
      map.rooms.push(room);
    }
    save(); select("room", room.id); refreshControls();
  }

  function connectRoom(room) {
    if (!room) return;
    if (!connectorStart) {
      connectorStart = room.id;
      select("room", room.id);
      refreshControls();
      return;
    }
    if (connectorStart === room.id) return;
    const existing = map.connectors.find(connector => (connector.from === connectorStart && connector.to === room.id) || (connector.to === connectorStart && connector.from === room.id));
    if (existing) {
      select("connector", existing.id);
      showToast("この部屋同士は接続済みです。");
    } else {
      recordChange();
      const connector = { id: uid("c"), from: connectorStart, to: room.id, description: "", color: COLORS[0] };
      map.connectors.push(connector);
      save(); select("connector", connector.id);
    }
    connectorStart = null;
    refreshControls();
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    cssWidth = Math.max(1, rect.width);
    cssHeight = Math.max(1, rect.height);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }

  function makeView() {
    const top = viewMode === "top";
    const floors = visibleFloors();
    const corners = [];
    for (const floor of floors) for (const z of top ? [0] : [0, 1]) {
      corners.push(rawPoint(0, 0, floor, z), rawPoint(map.width, 0, floor, z), rawPoint(map.width, map.depth, floor, z), rawPoint(0, map.depth, floor, z));
    }
    const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x));
    const minY = Math.min(...corners.map(p => p.y)), maxY = Math.max(...corners.map(p => p.y));
    const paddingX = cssWidth < 600 ? 24 : 78;
    const paddingTop = cssHeight < 500 ? 66 : 104;
    const paddingBottom = cssHeight < 500 ? 58 : 76;
    const scale = Math.min((cssWidth - paddingX * 2) / (maxX - minX), (cssHeight - paddingTop - paddingBottom) / (maxY - minY)) * camera.zoom;
    const safeScale = Math.max(.1, scale);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    return { top, floors, scale: safeScale, centerX, centerY, screenX: cssWidth / 2 + camera.panX, screenY: (paddingTop + cssHeight - paddingBottom) / 2 + camera.panY };
  }

  function rawPoint(x, y, floor, z = 0) {
    if (viewMode === "top") return { x: x * TOP_UNIT, y: y * TOP_UNIT };
    const level = visibleFloor === "all" ? floor - 1 : 0;
    const cos = Math.cos(camera.yaw), sin = Math.sin(camera.yaw);
    return { x: (x * cos - y * sin) * ISO_X_SCALE, y: (x * sin + y * cos) * ISO_Y_SCALE * camera.tilt - level * FLOOR_PITCH - z * ROOM_HEIGHT };
  }

  function point(x, y, floor, z = 0) {
    const raw = rawPoint(x, y, floor, z);
    return { x: (raw.x - view.centerX) * view.scale + view.screenX, y: (raw.y - view.centerY) * view.scale + view.screenY };
  }

  function polygon(points, fill, stroke = null, lineWidth = 1) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
  }

  function line(a, b, color, width = 1) {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }

  function drawFloor(floor) {
    const z = 0;
    const corners = [point(0, 0, floor, z), point(map.width, 0, floor, z), point(map.width, map.depth, floor, z), point(0, map.depth, floor, z)];
    const active = floor === activeFloor;
    polygon(corners, view.top ? "#10263b" : active ? "#17314b99" : "#142b42aa", active ? "#5c9ac477" : "#426b8c66", 1.4);
    for (let x = 1; x < map.width; x++) line(point(x, 0, floor, z), point(x, map.depth, floor, z), active ? "#73a0c329" : "#729ac01c");
    for (let y = 1; y < map.depth; y++) line(point(0, y, floor, z), point(map.width, y, floor, z), active ? "#73a0c329" : "#729ac01c");
    const label = point(0, 0, floor, z);
    ctx.fillStyle = active ? "#8ed0ff" : "#6889a8";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(`${floor}F`, label.x + (view.top ? 7 : -25), label.y + (view.top ? 16 : -9));
  }

  function occupancyForFloor(floor) {
    const grid = Array.from({ length: map.depth }, () => Array(map.width).fill(null));
    for (const room of map.rooms) if (room.floor === floor) {
      for (const cell of room.cells) grid[cell.y][cell.x] = room;
    }
    return grid;
  }

  function occupied(grid, x, y) { return y >= 0 && y < map.depth && x >= 0 && x < map.width && Boolean(grid[y][x]); }

  function drawRooms(floor) {
    const grid = occupancyForFloor(floor);
    const floorRooms = map.rooms.filter(room => room.floor === floor);
    const cells = floorRooms.flatMap(room => room.cells.map(cell => ({ ...cell, room })))
      .sort((a, b) => (a.x - b.x) * Math.sin(camera.yaw) + (a.y - b.y) * Math.cos(camera.yaw));
    for (const cell of cells) {
      const { x, y, room } = cell;
      const isSelected = selected?.type === "room" && selected.id === room.id;
      if (!view.top) {
        const sideA = isSelected ? "#a4334f88" : "#1f6cad88";
        const sideB = isSelected ? "#bb42598c" : "#2a7cbc88";
        if (Math.sin(camera.yaw) >= 0 && !occupied(grid, x + 1, y)) drawSide(x + 1, y, x + 1, y + 1, floor, sideA);
        if (Math.sin(camera.yaw) < 0 && !occupied(grid, x - 1, y)) drawSide(x, y, x, y + 1, floor, sideA);
        if (Math.cos(camera.yaw) >= 0 && !occupied(grid, x, y + 1)) drawSide(x, y + 1, x + 1, y + 1, floor, sideB);
        if (Math.cos(camera.yaw) < 0 && !occupied(grid, x, y - 1)) drawSide(x, y, x + 1, y, floor, sideB);
      }
      polygon([point(x, y, floor, 1), point(x + 1, y, floor, 1), point(x + 1, y + 1, floor, 1), point(x, y + 1, floor, 1)], isSelected ? "#ee586879" : "#3e9ffa70");
    }
    for (let y = 0; y < map.depth; y++) for (let x = 0; x < map.width; x++) {
      if (!occupied(grid, x, y)) continue;
      const room = grid[y][x];
      const edgeColor = selected?.type === "room" && selected.id === room.id ? "#ff9ba6" : "#83ceff";
      const z = 1;
      if (!occupied(grid, x, y - 1)) line(point(x, y, floor, z), point(x + 1, y, floor, z), edgeColor, 1.8);
      if (!occupied(grid, x + 1, y)) line(point(x + 1, y, floor, z), point(x + 1, y + 1, floor, z), edgeColor, 1.8);
      if (!occupied(grid, x, y + 1)) line(point(x, y + 1, floor, z), point(x + 1, y + 1, floor, z), edgeColor, 1.8);
      if (!occupied(grid, x - 1, y)) line(point(x, y, floor, z), point(x, y + 1, floor, z), edgeColor, 1.8);
      if (!view.top) {
        if (Math.sin(camera.yaw) >= 0 && !occupied(grid, x + 1, y)) line(point(x + 1, y, floor, 0), point(x + 1, y + 1, floor, 0), "#5aa9da9c");
        if (Math.sin(camera.yaw) < 0 && !occupied(grid, x - 1, y)) line(point(x, y, floor, 0), point(x, y + 1, floor, 0), "#5aa9da9c");
        if (Math.cos(camera.yaw) >= 0 && !occupied(grid, x, y + 1)) line(point(x, y + 1, floor, 0), point(x + 1, y + 1, floor, 0), "#5aa9da9c");
        if (Math.cos(camera.yaw) < 0 && !occupied(grid, x, y - 1)) line(point(x, y, floor, 0), point(x + 1, y, floor, 0), "#5aa9da9c");
      }
    }
    for (const room of floorRooms) drawRoomLabel(room);
  }

  function drawSide(ax, ay, bx, by, floor, fill) {
    polygon([point(ax, ay, floor, 1), point(bx, by, floor, 1), point(bx, by, floor, 0), point(ax, ay, floor, 0)], fill);
  }

  function drawRoomLabel(room) {
    const centroid = roomCenter(room);
    const center = point(centroid.x, centroid.y, room.floor, 1);
    let title = room.title || "名称なし";
    if (title.length > 13) title = `${title.slice(0, 12)}…`;
    ctx.font = "600 11px sans-serif";
    const width = Math.min(160, ctx.measureText(title).width + 16);
    ctx.fillStyle = "#071423d9";
    ctx.fillRect(center.x - width / 2, center.y - 9, width, 19);
    ctx.fillStyle = "#eaf6ff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(title, center.x, center.y + .5, width - 10);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  function connectorPoints(connector) {
    const from = roomById(connector.from), to = roomById(connector.to);
    if (!from || !to) return null;
    const fromAnchor = roomAnchor(from), toAnchor = roomAnchor(to);
    if (from.floor === to.floor) {
      const start = wallExit(from, toAnchor);
      const end = wallExit(to, fromAnchor);
      return [point(start.x, start.y, from.floor, .5), point(end.x, end.y, to.floor, .5)];
    }
    const fromZ = from.floor < to.floor ? 1 : 0;
    const toZ = to.floor < from.floor ? 1 : 0;
    return [point(fromAnchor.x, fromAnchor.y, from.floor, fromZ), point(toAnchor.x, toAnchor.y, to.floor, toZ)];
  }

  function drawConnectors(floor) {
    for (const connector of map.connectors) {
      if (!connectorVisible(connector)) continue;
      const from = roomById(connector.from), to = roomById(connector.to);
      if (Math.max(from.floor, to.floor) !== floor) continue;
      const points = connectorPoints(connector);
      if (!points) continue;
      const isSelected = selected?.type === "connector" && selected.id === connector.id;
      ctx.save();
      if (visibleFloor === "all" && focusFloor !== "none" && (from.floor !== Number(focusFloor) || to.floor !== Number(focusFloor))) ctx.globalAlpha = DIMMED_ALPHA;
      ctx.lineCap = "round";
      line(points[0], points[1], "#0a1425dd", isSelected ? 10 : 6);
      if (isSelected) { ctx.shadowColor = connector.color; ctx.shadowBlur = 14; }
      line(points[0], points[1], connector.color, isSelected ? 5 : 2.5);
      ctx.shadowBlur = 0;
      for (const p of points) {
        ctx.beginPath(); ctx.arc(p.x, p.y, isSelected ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = connector.color; ctx.fill();
      }
      ctx.restore();
    }
  }

  function draw() {
    if (!ctx || !canvas.width) return;
    view = makeView();
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    for (const floor of view.floors) {
      ctx.save();
      if (visibleFloor === "all" && focusFloor !== "none" && floor !== Number(focusFloor)) ctx.globalAlpha = DIMMED_ALPHA;
      drawFloor(floor);
      drawRooms(floor);
      ctx.restore();
      drawConnectors(floor);
    }
    if (connectorStart) {
      const room = roomById(connectorStart);
      if (room && roomVisible(room)) {
        ctx.save();
        if (visibleFloor === "all" && focusFloor !== "none" && room.floor !== Number(focusFloor)) ctx.globalAlpha = DIMMED_ALPHA;
        const center = roomCenter(room);
        const p = point(center.x, center.y, room.floor, 1.2);
        ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx.strokeStyle = "#f8d75a"; ctx.lineWidth = 2; ctx.stroke();
        ctx.restore();
      }
    }
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function gridPosition(screen, floor) {
    if (!view) return null;
    const rawX = (screen.x - view.screenX) / view.scale + view.centerX;
    const rawY = (screen.y - view.screenY) / view.scale + view.centerY;
    if (view.top) return { x: rawX / TOP_UNIT, y: rawY / TOP_UNIT };
    const level = visibleFloor === "all" ? floor - 1 : 0;
    const a = rawX / ISO_X_SCALE;
    const b = (rawY + level * FLOOR_PITCH) / (ISO_Y_SCALE * camera.tilt);
    const cos = Math.cos(camera.yaw), sin = Math.sin(camera.yaw);
    return { x: a * cos + b * sin, y: -a * sin + b * cos };
  }

  function cellAt(screen, floor) {
    const p = gridPosition(screen, floor);
    if (!p || p.x < 0 || p.y < 0 || p.x >= map.width || p.y >= map.depth) return null;
    return { x: Math.floor(p.x), y: Math.floor(p.y) };
  }

  function pointInPolygon(p, vertices) {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const a = vertices[i], b = vertices[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function hitRoom(screen) {
    const rooms = map.rooms.filter(roomVisible).sort((a, b) => b.floor - a.floor);
    return rooms.find(room => room.cells.some(cell => pointInPolygon(screen, [point(cell.x, cell.y, room.floor, 1), point(cell.x + 1, cell.y, room.floor, 1), point(cell.x + 1, cell.y + 1, room.floor, 1), point(cell.x, cell.y + 1, room.floor, 1)]))) || null;
  }

  function distanceToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function hitConnector(screen) {
    for (let i = map.connectors.length - 1; i >= 0; i--) {
      const connector = map.connectors[i];
      if (!connectorVisible(connector)) continue;
      const points = connectorPoints(connector);
      if (points && distanceToSegment(screen, points[0], points[1]) <= 7) return connector;
    }
    return null;
  }

  canvas.addEventListener("pointerdown", event => {
    if (event.button === 2) {
      event.preventDefault();
      cameraDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan: event.shiftKey || viewMode === "top" };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("orbiting");
      return;
    }
    if (event.button !== 0) return;
    const pos = pointerPosition(event);
    if (mode === "room") { addRoom(cellAt(pos, activeFloor)); return; }
    const room = hitRoom(pos);
    if (mode === "connector") { connectRoom(room); return; }
    const connector = hitConnector(pos);
    if (connector) { select("connector", connector.id); return; }
    if (!room) { select(null, null); return; }
    select("room", room.id);
    const start = gridPosition(pos, room.floor);
    drag = { id: room.id, pointerId: event.pointerId, start, cells: room.cells.map(cell => ({ ...cell })), moved: false };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("dragging");
  });

  canvas.addEventListener("pointermove", event => {
    if (cameraDrag && cameraDrag.pointerId === event.pointerId) {
      const dx = event.clientX - cameraDrag.x;
      const dy = event.clientY - cameraDrag.y;
      cameraDrag.x = event.clientX;
      cameraDrag.y = event.clientY;
      if (cameraDrag.pan) {
        camera.panX += dx;
        camera.panY += dy;
      } else {
        camera.yaw += dx * .008;
        camera.tilt = Math.max(.4, Math.min(2.2, camera.tilt + dy * .005));
      }
      draw();
      return;
    }
    if (!drag || drag.pointerId !== event.pointerId) return;
    const room = roomById(drag.id);
    if (!room) return;
    const current = gridPosition(pointerPosition(event), room.floor);
    const dx = Math.round(current.x - drag.start.x), dy = Math.round(current.y - drag.start.y);
    const candidate = { ...room, cells: drag.cells.map(cell => ({ x: cell.x + dx, y: cell.y + dy })) };
    if (canPlace(candidate, room.id) && candidate.cells.some((cell, i) => cell.x !== room.cells[i].x || cell.y !== room.cells[i].y)) {
      if (!drag.moved) recordChange();
      room.cells = candidate.cells; drag.moved = true;
      renderProperties(); draw();
    }
  });

  function endDrag(event) {
    if (cameraDrag && cameraDrag.pointerId === event.pointerId) {
      cameraDrag = null;
      canvas.classList.remove("orbiting");
      return;
    }
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      const room = roomById(drag.id);
      if (room) absorbMovedRoom(room);
      save(); renderProperties(); draw();
    }
    drag = null;
    canvas.classList.remove("dragging");
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("contextmenu", event => event.preventDefault());
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    camera.zoom = Math.max(.4, Math.min(3.5, camera.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    draw();
  }, { passive: false });

  document.querySelectorAll(".tool-button").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
  els.undoButton.addEventListener("click", undo);
  els.redoButton.addEventListener("click", redo);
  document.getElementById("resetViewButton").addEventListener("click", () => {
    camera.yaw = Math.PI / 4;
    camera.tilt = 1;
    camera.zoom = 1;
    camera.panX = 0;
    camera.panY = 0;
    draw();
  });
  els.floorCount.addEventListener("change", () => {
    const count = Number(els.floorCount.value);
    const highest = Math.max(1, ...map.rooms.map(room => room.floor));
    if (!isInteger(count, 1, 30) || count < highest) {
      els.floorCount.value = map.floors;
      showToast(`部屋があるため、${highest}階より少なくできません。`);
      return;
    }
    if (count === map.floors) return;
    recordChange();
    map.floors = count; save(); refreshControls(); renderProperties(); draw();
  });
  els.activeFloor.addEventListener("change", () => {
    activeFloor = Number(els.activeFloor.value);
    if (visibleFloor !== "all") visibleFloor = String(activeFloor);
    refreshControls(); draw();
  });
  els.visibleFloor.addEventListener("change", () => { visibleFloor = els.visibleFloor.value; if (visibleFloor !== "all") activeFloor = Number(visibleFloor); if (visibleFloor === "all") viewMode = "iso"; refreshControls(); draw(); });
  els.focusFloor.addEventListener("change", () => { focusFloor = els.focusFloor.value; if (focusFloor !== "none") activeFloor = Number(focusFloor); refreshControls(); draw(); });
  els.viewMode.addEventListener("change", () => { viewMode = els.viewMode.value; refreshControls(); draw(); });
  for (const [element, field] of [[els.gridWidth, "width"], [els.gridDepth, "depth"]]) {
    element.addEventListener("change", () => {
      const number = Number(element.value);
      if (!isInteger(number, 4, 30) || map.rooms.some(room => room.cells.some(cell => field === "width" ? cell.x >= number : cell.y >= number))) {
        element.value = map[field];
        showToast("部屋が格子外に出るため、このサイズに変更できません。");
        return;
      }
      if (number === map[field]) return;
      recordChange();
      map[field] = number; save(); renderProperties(); draw();
    });
  }

  properties.addEventListener("input", event => {
    if (["title", "description"].includes(event.target.dataset.field)) updateProperty(event.target);
  });
  properties.addEventListener("change", event => {
    if (event.target.dataset.field && !["title", "description"].includes(event.target.dataset.field)) updateProperty(event.target);
  });
  properties.addEventListener("focusout", () => { historyGroup = null; });
  properties.addEventListener("click", event => {
    const color = event.target.closest("[data-color]");
    if (color && selected?.type === "connector") {
      const connector = connectorById(selected.id);
      if (connector.color === color.dataset.color) return;
      recordChange();
      connector.color = color.dataset.color;
      save(); renderProperties(); draw();
    }
    if (event.target.closest('[data-action="delete"]')) deleteSelected();
  });

  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") {
        event.preventDefault();
        if (key === "z" && !event.shiftKey) undo();
        else redo();
        return;
      }
    }
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (typing) return;
    if (event.key === "Escape") { connectorStart = null; setMode("select"); }
    if (event.key === "Delete" || event.key === "Backspace") deleteSelected();
  });

  document.getElementById("exportButton").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(map, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "indoor-map.json";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.getElementById("importInput").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = validateMap(JSON.parse(await file.text()));
      if (JSON.stringify(imported) !== JSON.stringify(map)) recordChange();
      map = imported; activeFloor = 1; visibleFloor = "all"; viewMode = "iso"; selected = null; connectorStart = null;
      save(); refreshControls(); renderProperties(); draw(); showToast("マップを読み込みました。");
    } catch (error) {
      showToast(`読み込めませんでした: ${error.message}`);
    }
    event.target.value = "";
  });
  document.getElementById("clearButton").addEventListener("click", () => {
    if (!confirm("部屋とコネクタをすべて削除しますか？")) return;
    if (map.rooms.length || map.connectors.length) recordChange();
    map.rooms = []; map.connectors = []; selected = null; connectorStart = null;
    save(); refreshControls(); renderProperties(); draw();
  });

  refreshControls();
  refreshHistoryButtons();
  renderProperties();
  new ResizeObserver(resizeCanvas).observe(canvas);
  resizeCanvas();
})();
