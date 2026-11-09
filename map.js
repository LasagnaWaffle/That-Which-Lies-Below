(() => {
  const STORAGE_KEY = "twlb-map";
  const TILE = 32;
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 4;
  // How close (in tiles) the cursor must be to a wall for doors to snap to it / the eraser to pick a door.
  const SNAP = 0.25;
  const GREEN = "#3dff6e";
  const SCREEN_BG = "#06100a";
  const PRESET_COLORS = ["#b8433f", "#3f6fb8", "#c9a43a", "#8a52b8", "#d9772e"];

  const view = document.getElementById("map-view");
  const canvas = document.getElementById("map-canvas");
  const ctx = canvas.getContext("2d");
  const toolButtons = view.querySelectorAll("[data-tool]");
  const palette = document.getElementById("map-palette");
  const customSwatch = document.getElementById("map-custom-swatch");
  const customColor = document.getElementById("map-custom-color");
  const hint = document.getElementById("map-hint");
  const labelInput = document.getElementById("map-label-input");
  const confirmBox = document.getElementById("map-confirm");

  // Tiles: "x,y" -> color (or null). Walls: interior edges that separate two tiles.
  // Edges are "h:x,y" (top edge of tile x,y) or "v:x,y" (left edge of tile x,y).
  let tiles = new Map();
  let walls = new Set();
  let doors = new Set();
  let labels = new Map();
  let camera = { x: 0, y: 0, zoom: 1 };

  let rooms = { byTile: new Map(), list: [] };
  let tool = null;
  let doorRotation = "h";
  let paintColor = PRESET_COLORS[0];
  let hover = null;
  let drag = null;
  let editing = null;
  let size = { w: 0, h: 0 };

  // ---------- Geometry ----------

  const key = (x, y) => `${x},${y}`;
  const parseKey = (k) => k.split(",").map(Number);
  const edgeKey = (o, x, y) => `${o}:${x},${y}`;

  function parseEdge(e) {
    const [o, rest] = e.split(":");
    const [x, y] = parseKey(rest);
    return { o, x, y };
  }

  function edgeSides(e) {
    const { o, x, y } = parseEdge(e);
    return o === "h" ? [[x, y - 1], [x, y]] : [[x - 1, y], [x, y]];
  }

  function tileEdges(x, y) {
    return [edgeKey("h", x, y), edgeKey("h", x, y + 1), edgeKey("v", x, y), edgeKey("v", x + 1, y)];
  }

  // "none" | "exterior" (one side is a tile) | "wall" (two tiles, walled) | "interior" (two tiles, open)
  function edgeKind(e) {
    const count = edgeSides(e).filter(([x, y]) => tiles.has(key(x, y))).length;
    if (count === 0) return "none";
    if (count === 1) return "exterior";
    return walls.has(e) ? "wall" : "interior";
  }

  function isWall(e) {
    const kind = edgeKind(e);
    return kind === "exterior" || kind === "wall";
  }

  // The four edges of the cell under a world point, with the cursor's distance to each.
  function cellEdges(p) {
    const cx = Math.floor(p.wx);
    const cy = Math.floor(p.wy);
    const fx = p.wx - cx;
    const fy = p.wy - cy;
    return [
      { e: edgeKey("h", cx, cy), d: fy },
      { e: edgeKey("h", cx, cy + 1), d: 1 - fy },
      { e: edgeKey("v", cx, cy), d: fx },
      { e: edgeKey("v", cx + 1, cy), d: 1 - fx },
    ];
  }

  function cellOf(p) {
    return [Math.floor(p.wx), Math.floor(p.wy)];
  }

  function roomAt(p) {
    const [x, y] = cellOf(p);
    const id = rooms.byTile.get(key(x, y));
    return id === undefined ? null : rooms.list[id];
  }

  function recomputeRooms() {
    const byTile = new Map();
    const list = [];
    for (const start of tiles.keys()) {
      if (byTile.has(start)) continue;
      const room = { id: list.length, tiles: [] };
      list.push(room);
      byTile.set(start, room.id);
      const stack = [start];
      while (stack.length) {
        const current = stack.pop();
        room.tiles.push(current);
        const [x, y] = parseKey(current);
        const steps = [
          [x, y - 1, edgeKey("h", x, y)],
          [x, y + 1, edgeKey("h", x, y + 1)],
          [x - 1, y, edgeKey("v", x, y)],
          [x + 1, y, edgeKey("v", x + 1, y)],
        ];
        for (const [nx, ny, edge] of steps) {
          const next = key(nx, ny);
          if (!tiles.has(next) || byTile.has(next) || walls.has(edge)) continue;
          byTile.set(next, room.id);
          stack.push(next);
        }
      }
      let sx = 0;
      let sy = 0;
      for (const t of room.tiles) {
        const [x, y] = parseKey(t);
        sx += x + 0.5;
        sy += y + 0.5;
      }
      room.cx = sx / room.tiles.length;
      room.cy = sy / room.tiles.length;
    }
    rooms = { byTile, list };
  }

  // ---------- Map edits ----------

  function addTile(x, y) {
    const k = key(x, y);
    if (tiles.has(k)) return false;
    let color = null;
    for (const [nx, ny] of [[x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y]]) {
      const neighbor = tiles.get(key(nx, ny));
      if (neighbor) {
        color = neighbor;
        break;
      }
    }
    tiles.set(k, color);
    // A door that was on an outside wall now separates this tile from its neighbor.
    for (const e of tileEdges(x, y)) {
      if (doors.has(e) && edgeKind(e) === "interior") walls.add(e);
    }
    return true;
  }

  function removeTile(x, y) {
    const k = key(x, y);
    if (!tiles.has(k)) return false;
    const room = rooms.list[rooms.byTile.get(k)];
    tiles.delete(k);
    for (const e of tileEdges(x, y)) {
      walls.delete(e);
      if (edgeKind(e) === "none") doors.delete(e);
    }
    if (labels.has(k)) {
      const text = labels.get(k);
      labels.delete(k);
      const heir = room && room.tiles.find((t) => t !== k && tiles.has(t));
      if (heir && !labels.has(heir)) labels.set(heir, text);
    }
    return true;
  }

  function doorTarget(p) {
    const [cx, cy] = cellOf(p);
    const onTile = tiles.has(key(cx, cy));
    const nearWall = cellEdges(p)
      .filter((c) => isWall(c.e) && !doors.has(c.e) && (!onTile || c.d < SNAP))
      .sort((a, b) => a.d - b.d)[0];
    if (nearWall) return { edge: nearWall.e, split: false };
    if (!onTile) return null;

    const fx = p.wx - cx;
    const fy = p.wy - cy;
    const edge = doorRotation === "h"
      ? edgeKey("h", cx, fy < 0.5 ? cy : cy + 1)
      : edgeKey("v", fx < 0.5 ? cx : cx + 1, cy);
    if (doors.has(edge)) return null;
    return { edge, split: edgeKind(edge) === "interior" };
  }

  // Interior edges continuing in a straight line from a door until they hit a wall or empty space.
  function splitLine(edge) {
    const { o, x, y } = parseEdge(edge);
    const line = [edge];
    for (const dir of [-1, 1]) {
      for (let i = 1; ; i++) {
        const next = o === "h" ? edgeKey("h", x + dir * i, y) : edgeKey("v", x, y + dir * i);
        if (edgeKind(next) !== "interior") break;
        line.push(next);
      }
    }
    return line;
  }

  function placeDoor(target) {
    if (target.split) for (const e of splitLine(target.edge)) walls.add(e);
    doors.add(target.edge);
    changed();
  }

  function eraseTarget(p) {
    const nearDoor = cellEdges(p)
      .filter((c) => doors.has(c.e) && c.d < SNAP)
      .sort((a, b) => a.d - b.d)[0];
    if (nearDoor) return { door: nearDoor.e };
    const [x, y] = cellOf(p);
    return tiles.has(key(x, y)) ? { tile: [x, y] } : null;
  }

  function applyErase(target) {
    if (target.door) {
      doors.delete(target.door);
      changed();
    } else if (removeTile(...target.tile)) {
      changed();
    }
  }

  function paintAt(p) {
    const room = roomAt(p);
    if (!room) return;
    for (const t of room.tiles) tiles.set(t, paintColor);
    changed();
  }

  function clearMap() {
    tiles.clear();
    walls.clear();
    doors.clear();
    labels.clear();
    camera.x = 0;
    camera.y = 0;
    changed();
  }

  function changed() {
    recomputeRooms();
    save();
    render();
  }

  // ---------- Persistence ----------

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!data) return;
      tiles = new Map(data.tiles || []);
      walls = new Set(data.walls || []);
      doors = new Set(data.doors || []);
      labels = new Map(data.labels || []);
      if (data.camera) camera = { ...camera, ...data.camera };
    } catch {}
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tiles: [...tiles],
        walls: [...walls],
        doors: [...doors],
        labels: [...labels],
        camera,
      }));
    } catch {}
  }

  // ---------- Rendering ----------

  const scale = () => TILE * camera.zoom;
  const toX = (wx) => (wx - camera.x) * scale() + size.w / 2;
  const toY = (wy) => (wy - camera.y) * scale() + size.h / 2;

  function toWorld(px, py) {
    return { wx: (px - size.w / 2) / scale() + camera.x, wy: (py - size.h / 2) / scale() + camera.y };
  }

  function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    size = { w: rect.width, h: rect.height };
    render();
  }

  function fillTile(k, style) {
    const [x, y] = parseKey(k);
    const s = scale();
    ctx.fillStyle = style;
    ctx.fillRect(toX(x), toY(y), s + 0.5, s + 0.5);
  }

  function edgePath(e) {
    const { o, x, y } = parseEdge(e);
    ctx.moveTo(toX(x), toY(y));
    if (o === "h") ctx.lineTo(toX(x + 1), toY(y));
    else ctx.lineTo(toX(x), toY(y + 1));
  }

  function doorRect(e) {
    const { o, x, y } = parseEdge(e);
    const s = scale();
    const length = 0.6 * s;
    const thickness = Math.max(4, 0.22 * s);
    if (o === "h") return [toX(x + 0.5) - length / 2, toY(y) - thickness / 2, length, thickness];
    return [toX(x) - thickness / 2, toY(y + 0.5) - length / 2, thickness, length];
  }

  function drawDoor(e, fill) {
    const rect = doorRect(e);
    ctx.fillStyle = fill;
    ctx.fillRect(...rect);
    ctx.strokeRect(...rect);
  }

  function glow(blur) {
    ctx.strokeStyle = GREEN;
    ctx.shadowColor = GREEN;
    ctx.shadowBlur = blur;
  }

  function render() {
    if (view.hidden || !size.w) return;
    const { w, h } = size;
    const s = scale();
    ctx.clearRect(0, 0, w, h);

    // Grid
    const left = Math.floor(camera.x - w / 2 / s);
    const right = Math.ceil(camera.x + w / 2 / s);
    const top = Math.floor(camera.y - h / 2 / s);
    const bottom = Math.ceil(camera.y + h / 2 / s);
    ctx.save();
    ctx.strokeStyle = `rgba(61, 255, 110, ${s < 12 ? 0.04 : 0.08})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = left; x <= right; x++) {
      const px = Math.round(toX(x)) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
    }
    for (let y = top; y <= bottom; y++) {
      const py = Math.round(toY(y)) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
    }
    ctx.stroke();
    ctx.restore();

    // Room floors
    for (const [k, color] of tiles) {
      fillTile(k, color ? withAlpha(color, 0.5) : "rgba(61, 255, 110, 0.09)");
    }

    const hoverRoom = hover ? roomAt(hover) : null;
    if (hoverRoom && tool === "paint") {
      for (const t of hoverRoom.tiles) fillTile(t, withAlpha(paintColor, 0.45));
    } else if (hoverRoom && tool === "label") {
      for (const t of hoverRoom.tiles) fillTile(t, "rgba(61, 255, 110, 0.12)");
    }

    // Walls and doors
    const wallEdges = new Set();
    for (const k of tiles.keys()) {
      for (const e of tileEdges(...parseKey(k))) if (isWall(e)) wallEdges.add(e);
    }
    ctx.save();
    glow(6);
    ctx.lineWidth = Math.max(1.5, 2 * camera.zoom);
    ctx.lineCap = "square";
    ctx.beginPath();
    for (const e of wallEdges) edgePath(e);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, 1.5 * camera.zoom);
    for (const e of doors) drawDoor(e, SCREEN_BG);
    ctx.restore();

    drawToolPreview();
    drawLabels(hoverRoom);
  }

  function drawToolPreview() {
    if (!hover || !tool || drag?.type === "pan") return;
    const s = scale();
    ctx.save();
    glow(6);
    ctx.lineWidth = 1.5;

    if (tool === "pencil") {
      const [x, y] = cellOf(hover);
      ctx.setLineDash([4, 4]);
      ctx.fillStyle = "rgba(61, 255, 110, 0.12)";
      ctx.fillRect(toX(x), toY(y), s, s);
      ctx.strokeRect(toX(x) + 1, toY(y) + 1, s - 2, s - 2);
    } else if (tool === "eraser") {
      const target = eraseTarget(hover);
      if (target?.door) {
        drawDoor(target.door, "rgba(61, 255, 110, 0.85)");
      } else if (target?.tile) {
        const [x, y] = target.tile;
        ctx.fillStyle = "rgba(61, 255, 110, 0.4)";
        ctx.fillRect(toX(x), toY(y), s, s);
        ctx.strokeRect(toX(x) + 1, toY(y) + 1, s - 2, s - 2);
      }
    } else if (tool === "door") {
      const target = doorTarget(hover);
      if (target) {
        if (target.split) {
          ctx.setLineDash([5, 5]);
          ctx.globalAlpha = 0.7;
          ctx.beginPath();
          for (const e of splitLine(target.edge)) edgePath(e);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.globalAlpha = 0.65;
        ctx.lineWidth = Math.max(1, 1.5 * camera.zoom);
        drawDoor(target.edge, SCREEN_BG);
      }
    }
    ctx.restore();
  }

  function drawLabels(hoverRoom) {
    if ((tool && tool !== "label") || labels.size === 0) return;
    const editingRoom = editing ? rooms.byTile.get(editing.tileKey) : undefined;
    const byRoom = new Map();
    for (const [k, text] of labels) {
      const id = rooms.byTile.get(k);
      if (id === undefined) continue;
      if (!byRoom.has(id)) byRoom.set(id, []);
      byRoom.get(id).push([k, text]);
    }

    ctx.save();
    ctx.font = `${Math.max(14, 20 * camera.zoom)}px VT323, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = GREEN;
    ctx.shadowColor = GREEN;
    ctx.shadowBlur = 6;
    for (const [id, entries] of byRoom) {
      const alpha = !hoverRoom ? 0.5 : hoverRoom.id === id ? 1 : 0;
      if (!alpha || id === editingRoom) continue;
      ctx.globalAlpha = alpha;
      const room = rooms.list[id];
      entries.forEach(([k, text], i) => {
        if (i === 0) {
          ctx.fillText(text, toX(room.cx), toY(room.cy));
        } else {
          const [x, y] = parseKey(k);
          ctx.fillText(text, toX(x + 0.5), toY(y + 0.5));
        }
      });
    }
    ctx.restore();
  }

  // ---------- Tools ----------

  function setTool(next) {
    if (editing) cancelLabel();
    tool = next;
    for (const button of toolButtons) button.classList.toggle("active", button.dataset.tool === tool);
    palette.hidden = tool !== "paint";
    hint.hidden = tool !== "door";
    canvas.classList.toggle("tool-none", !tool);
    canvas.classList.toggle("tool-active", !!tool);
    render();
  }

  function selectColor(color, swatch) {
    paintColor = color;
    for (const el of palette.querySelectorAll(".swatch")) el.classList.toggle("active", el === swatch);
    render();
  }

  function buildPalette() {
    for (const color of PRESET_COLORS) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch";
      swatch.style.background = color;
      swatch.title = color;
      swatch.addEventListener("click", () => selectColor(color, swatch));
      palette.insertBefore(swatch, customSwatch);
    }
    palette.querySelector(".swatch").classList.add("active");
    customColor.addEventListener("input", () => {
      customSwatch.style.background = customColor.value;
      selectColor(customColor.value, customSwatch);
    });
    customColor.addEventListener("click", () => selectColor(customColor.value, customSwatch));
  }

  function openLabel(p) {
    const room = roomAt(p);
    if (!room) return;
    const [x, y] = cellOf(p);
    editing = { tileKey: key(x, y) };
    labelInput.value = room.tiles.map((t) => labels.get(t)).find(Boolean) || "";
    labelInput.style.left = `${toX(room.cx)}px`;
    labelInput.style.top = `${toY(room.cy)}px`;
    labelInput.hidden = false;
    setTimeout(() => {
      labelInput.focus();
      labelInput.select();
    });
    render();
  }

  function commitLabel() {
    if (!editing) return;
    const { tileKey } = editing;
    editing = null;
    labelInput.hidden = true;
    const id = rooms.byTile.get(tileKey);
    if (id === undefined) return render();
    for (const t of rooms.list[id].tiles) labels.delete(t);
    const text = labelInput.value.trim();
    if (text) labels.set(tileKey, text);
    changed();
  }

  function cancelLabel() {
    editing = null;
    labelInput.hidden = true;
    render();
  }

  function centerView() {
    if (tiles.size) {
      let sx = 0;
      let sy = 0;
      for (const k of tiles.keys()) {
        const [x, y] = parseKey(k);
        sx += x + 0.5;
        sy += y + 0.5;
      }
      camera.x = sx / tiles.size;
      camera.y = sy / tiles.size;
    } else {
      camera.x = 0;
      camera.y = 0;
    }
    save();
    render();
  }

  // ---------- Input ----------

  function pointerPos(event) {
    const rect = canvas.getBoundingClientRect();
    return toWorld(event.clientX - rect.left, event.clientY - rect.top);
  }

  function cellsBetween([ax, ay], [bx, by]) {
    const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    if (n === 0) return [[bx, by]];
    const cells = [];
    for (let i = 1; i <= n; i++) {
      cells.push([Math.round(ax + ((bx - ax) * i) / n), Math.round(ay + ((by - ay) * i) / n)]);
    }
    return cells;
  }

  canvas.addEventListener("pointerdown", (event) => {
    const p = pointerPos(event);
    hover = p;

    if (event.button === 1 || event.button === 2 || (event.button === 0 && !tool)) {
      event.preventDefault();
      drag = { type: "pan", sx: event.clientX, sy: event.clientY, cam: { ...camera } };
      canvas.classList.add("panning");
      canvas.setPointerCapture(event.pointerId);
      render();
      return;
    }
    if (event.button !== 0) return;

    if (tool === "pencil") {
      drag = { type: "draw", last: cellOf(p) };
      if (addTile(...cellOf(p))) changed();
    } else if (tool === "eraser") {
      const target = eraseTarget(p);
      drag = { type: "erase", mode: target?.door ? "door" : "tile" };
      if (target) applyErase(target);
    } else if (tool === "paint") {
      paintAt(p);
    } else if (tool === "label") {
      openLabel(p);
    } else if (tool === "door") {
      const target = doorTarget(p);
      if (target) {
        placeDoor(target);
        setTool(null);
      }
    }
    if (drag) canvas.setPointerCapture(event.pointerId);
    render();
  });

  canvas.addEventListener("pointermove", (event) => {
    const p = pointerPos(event);
    hover = p;

    if (drag?.type === "pan") {
      camera.x = drag.cam.x - (event.clientX - drag.sx) / scale();
      camera.y = drag.cam.y - (event.clientY - drag.sy) / scale();
    } else if (drag?.type === "draw") {
      const cell = cellOf(p);
      let added = false;
      for (const [x, y] of cellsBetween(drag.last, cell)) added = addTile(x, y) || added;
      drag.last = cell;
      if (added) changed();
    } else if (drag?.type === "erase") {
      // A stroke that starts on a door only erases doors, so the tiles under them survive.
      if (drag.mode === "door") {
        const target = eraseTarget(p);
        if (target?.door) applyErase(target);
      } else if (removeTile(...cellOf(p))) {
        changed();
      }
    }
    render();
  });

  function endDrag() {
    if (drag?.type === "pan") save();
    drag = null;
    canvas.classList.remove("panning");
    render();
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    if (drag) return;
    hover = null;
    render();
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const before = toWorld(px, py);
    camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * Math.exp(-event.deltaY * 0.0015)));
    const after = toWorld(px, py);
    camera.x += before.wx - after.wx;
    camera.y += before.wy - after.wy;
    hover = toWorld(px, py);
    save();
    render();
  }, { passive: false });

  for (const button of toolButtons) {
    button.addEventListener("click", () => setTool(tool === button.dataset.tool ? null : button.dataset.tool));
  }

  document.getElementById("map-center").addEventListener("click", centerView);
  document.getElementById("map-clear").addEventListener("click", () => {
    setTool(null);
    confirmBox.hidden = false;
  });
  document.getElementById("map-confirm-yes").addEventListener("click", () => {
    confirmBox.hidden = true;
    clearMap();
  });
  document.getElementById("map-confirm-no").addEventListener("click", () => {
    confirmBox.hidden = true;
  });

  labelInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") commitLabel();
    else if (event.key === "Escape") cancelLabel();
  });
  labelInput.addEventListener("blur", commitLabel);

  const TOOL_KEYS = { a: "pencil", s: "eraser", d: "paint", f: "label", g: "door" };

  document.addEventListener("keydown", (event) => {
    if (view.hidden || event.target instanceof HTMLInputElement) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
    const shortcut = TOOL_KEYS[event.key.toLowerCase()];
    if (shortcut && confirmBox.hidden) {
      setTool(tool === shortcut ? null : shortcut);
    } else if ((event.key === "r" || event.key === "R") && tool === "door") {
      doorRotation = doorRotation === "h" ? "v" : "h";
      render();
    } else if (event.key === "Escape") {
      if (!confirmBox.hidden) confirmBox.hidden = true;
      else setTool(null);
    }
  });

  new ResizeObserver(resize).observe(canvas);
  if (document.fonts) document.fonts.ready.then(render);

  load();
  recomputeRooms();
  buildPalette();

  window.TerminalMap = {
    show() {
      view.hidden = false;
      resize();
    },
    hide() {
      setTool(null);
      confirmBox.hidden = true;
      hover = null;
      drag = null;
      view.hidden = true;
    },
    clear: clearMap,
  };
})();
