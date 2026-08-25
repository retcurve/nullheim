/**
 * Mosaic — a retro terminal frontend for human players.
 *
 * Talks only to the public read endpoints: GET /v1/sectors/{x}/{y} and
 * GET /v1/objects/{id}. Nothing here writes to the world.
 *
 * The client keeps a small model of "the sector the player is currently
 * standing in": its title/description/exits, and whatever objects are known
 * about it (name only, until examined). Moving to a new sector always throws
 * that model away and re-fetches — the world can change while you're not
 * looking at it. Examining an object merges its full detail (and its own
 * nested things_you_can_see) into the model, so later `look`s can resolve
 * nested objects without re-fetching, and re-examining something already
 * known doesn't need the network.
 */

(() => {
  const output = document.getElementById("output");
  const typed = document.getElementById("typed");
  const hiddenInput = document.getElementById("hidden-input");
  const crt = document.getElementById("crt");
  const moreIndicator = document.getElementById("more-indicator");
  const mapOverlay = document.getElementById("map-overlay");
  const mapViewport = document.getElementById("map-viewport");
  const mapGrid = document.getElementById("map-grid");
  const mapTooltip = document.getElementById("map-tooltip");

  /** @type {{coordinate:[number,number], title:string, description:string, exits:Array, objects:Map}|null} */
  let model = null;

  // --- rendering ------------------------------------------------------------

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** Turns our `**bold**`/`__underline__` conventions into real markup, after escaping. */
  function toHtml(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<u>$1</u>");
  }

  function maxScroll() {
    return Math.max(0, output.scrollHeight - output.clientHeight);
  }

  /**
   * Where the view is heading, not where it is right now. Every scroll here
   * is animated, so the live `scrollTop` spends most of its time mid-flight;
   * reading it to decide anything — the badge, the next arrow step — makes
   * both stutter. `null` means nothing is in flight and the live position is
   * the truth (the user scrolled by wheel, or nothing has moved yet).
   */
  let scrollTarget = null;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /** Handle of the in-flight scroll animation, so a new one can replace it. */
  let scrollAnim = null;

  function cancelScrollAnim() {
    if (scrollAnim !== null) {
      cancelAnimationFrame(scrollAnim);
      scrollAnim = null;
    }
  }

  /**
   * Animated by hand rather than with `scrollTo({behavior: "smooth"})`.
   * Native smooth scales its duration with the distance travelled, and the
   * distances here are small — a command's response typically moves the view
   * only a few dozen pixels, which native smooth covers in a frame or two and
   * reads as an instant jump. A floor on the duration is what makes the glide
   * actually visible.
   */
  function scrollOutputTo(top) {
    const target = Math.min(Math.max(0, top), maxScroll());
    scrollTarget = target;
    cancelScrollAnim();

    const start = output.scrollTop;
    const distance = target - start;
    if (reduceMotion.matches || Math.abs(distance) < 1) {
      output.scrollTop = target;
      updateMoreIndicator();
      return;
    }

    const duration = Math.min(600, Math.max(220, Math.abs(distance) * 1.6));
    const startedAt = performance.now();

    const step = (now) => {
      const p = Math.min(1, (now - startedAt) / duration);
      // easeInOutQuad — starts and stops gently, like a terminal catching up.
      const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      output.scrollTop = start + distance * eased;
      updateMoreIndicator();
      scrollAnim = p < 1 ? requestAnimationFrame(step) : null;
    };
    scrollAnim = requestAnimationFrame(step);
  }

  function effectiveScrollTop() {
    return scrollTarget === null ? output.scrollTop : scrollTarget;
  }

  function isAtBottom() {
    return maxScroll() - effectiveScrollTop() <= 2;
  }

  function updateMoreIndicator() {
    moreIndicator.classList.toggle("visible", !isAtBottom());
  }

  /**
   * Arrow-key scrolling, deliberately instant. The glide belongs to text
   * arriving on its own; when the reader is driving, a tween just lags behind
   * the key. The wheel is already native for the same reason — nothing here
   * intercepts it.
   */
  function scrollOutputBy(amount) {
    cancelScrollAnim();
    scrollTarget = null;
    output.scrollTop = Math.min(Math.max(0, output.scrollTop + amount), maxScroll());
    updateMoreIndicator();
  }

  /**
   * The echoed command line the view is currently pinned to. A command's
   * response arrives after the echo — sometimes several appends later, and
   * after an await — so the scroll cannot be set once at echo time: at that
   * moment the response does not exist, `scrollHeight` is barely past
   * `clientHeight`, and the browser clamps the assignment to almost nothing.
   * It is instead re-applied after every append until the next command.
   */
  let anchorEl = null;

  /**
   * How much of the previous exchange stays on screen above the echoed
   * command: one line of text plus the gap between entries. Measured from
   * the real computed style so it tracks any font or spacing change.
   */
  function revealContextPx() {
    const style = getComputedStyle(output);
    const lineHeight = parseFloat(style.lineHeight) || 22;
    const gap = 14; // .entry margin-bottom
    return lineHeight + gap;
  }

  function applyAnchor() {
    if (!anchorEl) {
      return;
    }
    scrollOutputTo(anchorEl.offsetTop - revealContextPx());
  }

  function appendEntry(text, className, { anchor = false } = {}) {
    const div = document.createElement("div");
    div.className = className ? `entry ${className}` : "entry";
    div.innerHTML = toHtml(text);
    output.appendChild(div);

    if (anchor) {
      anchorEl = div;
    }
    // Keep the echoed command pinned near the top as its response fills in,
    // so a tall response never pushes its own beginning off the top. What
    // overflows below waits behind the "More" badge.
    applyAnchor();
    updateMoreIndicator();
  }

  function print(text) {
    appendEntry(text, "");
  }

  function printError(text) {
    appendEntry(text, "error");
  }

  function echoCommand(cmd) {
    appendEntry(`> ${cmd}`, "echo", { anchor: true });
  }

  function exitsSentence(exits) {
    const parts = exits.map((e, i) => `to the ${e.direction}${i === 0 ? " you see" : ""} **${e.name}**`);
    const sentence = `${parts.join(", ")}.`;
    return sentence.charAt(0).toUpperCase() + sentence.slice(1);
  }

  function renderSectorText(m) {
    const lines = [`**${m.title}** (${m.coordinate[0]}, ${m.coordinate[1]})`, m.description];
    if (m.exits.length > 0) {
      lines.push("", "__Exits__", exitsSentence(m.exits));
    }
    const objects = Array.from(m.objects.values());
    if (objects.length > 0) {
      lines.push("", "__You can also see__", ...objects.map((o) => `**${o.title}**`));
    }
    return lines.join("\n");
  }

  function renderObjectText(obj) {
    const lines = [`**${obj.title}**`, obj.description ?? ""];
    const kids = obj.things_you_can_see ?? [];
    if (kids.length > 0) {
      lines.push("", "__You can also see__", ...kids.map((k) => `**${k.title}**`));
    }
    return lines.join("\n");
  }

  function renderExitText(exit) {
    return `**${exit.name}**\n${exit.description}`;
  }

  // --- networking -------------------------------------------------------------

  async function fetchJson(path) {
    let res;
    try {
      res = await fetch(path, { headers: { Accept: "application/json" } });
    } catch {
      throw new Error("can't reach the world right now");
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* fall through to status-based error below */
    }
    if (!res.ok) {
      const message = body && body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
      throw new Error(message);
    }
    return body;
  }

  // --- model --------------------------------------------------------------

  function loadModelFromSector(data) {
    const objects = new Map();
    for (const o of data.things_you_can_see) {
      objects.set(o.object_id, { object_id: o.object_id, title: o.title });
    }
    model = {
      coordinate: data.coordinate,
      title: data.title,
      description: data.description,
      exits: data.exits,
      objects,
    };
  }

  function mergeObject(data) {
    const merged = {
      object_id: data.object_id,
      title: data.title,
      description: data.description,
      things_you_can_see: data.things_you_can_see,
    };
    model.objects.set(data.object_id, merged);
    for (const kid of data.things_you_can_see) {
      if (!model.objects.has(kid.object_id)) {
        model.objects.set(kid.object_id, { object_id: kid.object_id, title: kid.title });
      }
    }
    return merged;
  }

  // --- matching -------------------------------------------------------------

  function findMatches(query) {
    const q = query.toLowerCase();
    const exitMatches = model.exits.filter((e) => e.name.toLowerCase().includes(q));
    const objectMatches = Array.from(model.objects.values()).filter((o) => o.title.toLowerCase().includes(q));
    return { exitMatches, objectMatches };
  }

  function describeCandidates(exitMatches, objectMatches) {
    return [...exitMatches.map((e) => e.name), ...objectMatches.map((o) => o.title)].join(", ");
  }

  // --- actions --------------------------------------------------------------

  async function moveTo(coordinate) {
    try {
      const data = await fetchJson(`/v1/sectors/${coordinate[0]}/${coordinate[1]}`);
      loadModelFromSector(data);
      print(renderSectorText(model));
    } catch (exc) {
      printError(`The way is blocked: ${exc.message}`);
    }
  }

  function doGoDirection(direction) {
    const exit = model.exits.find((e) => e.direction === direction);
    if (!exit) {
      printError("You can't go that way.");
      return;
    }
    moveTo(exit.to);
  }

  function doGoByName(name) {
    const q = name.toLowerCase();
    const matches = model.exits.filter((e) => e.name.toLowerCase().includes(q));
    if (matches.length === 0) {
      printError("You can't go that way.");
      return;
    }
    if (matches.length > 1) {
      printError(`Which do you mean: ${matches.map((m) => m.name).join(", ")}?`);
      return;
    }
    moveTo(matches[0].to);
  }

  async function doTeleport(args) {
    if (!args) {
      printError("Teleport where? Usage: teleport <x> <y> | teleport <sector name>");
      return;
    }

    let map;
    try {
      map = await fetchJson("/v1/map");
    } catch (exc) {
      printError(`Couldn't read the map: ${exc.message}`);
      return;
    }
    const sectors = map.sectors ?? [];

    const tokens = args.trim().split(/\s+/);
    const asCoordinate =
      tokens.length === 2 && tokens.every((t) => /^-?\d+$/.test(t))
        ? [Number(tokens[0]), Number(tokens[1])]
        : null;

    if (asCoordinate) {
      const found = sectors.find((s) => s.coordinate[0] === asCoordinate[0] && s.coordinate[1] === asCoordinate[1]);
      if (!found) {
        printError("There's no sector there.");
        return;
      }
      await moveTo(found.coordinate);
      return;
    }

    const q = args.toLowerCase();
    const matches = sectors.filter((s) => s.title.toLowerCase().includes(q));
    if (matches.length === 0) {
      printError("You don't know a sector by that name.");
      return;
    }
    if (matches.length > 1) {
      printError(`Which do you mean: ${matches.map((m) => m.title).join(", ")}?`);
      return;
    }
    await moveTo(matches[0].coordinate);
  }

  // --- map overlay ----------------------------------------------------------
  //
  // A grid of every known sector, zoomed to fit on open. Each cell's label
  // measures its own text once (font size is fixed, independent of zoom) so
  // zooming only ever has to compare that width against the current cell
  // size — never re-measure — to decide whether to show the title in place
  // or fall back to a hover tooltip.

  const MAP_CELL_MIN = 10;
  const MAP_CELL_MAX = 160;
  const MAP_LABEL_FONT = "bold 11px 'Courier New', ui-monospace, monospace";
  const MAP_LABEL_PADDING = 6; // room (in both axes) the label text must fit within
  const MAP_LABEL_LINE_HEIGHT = 13; // matches the 11px font at line-height: 1.2
  const MAP_LABEL_MIN_CELL = 24; // below this a cell is too small to wrap into legibly

  const measureCanvas = document.createElement("canvas").getContext("2d");
  measureCanvas.font = MAP_LABEL_FONT;

  let mapState = null; // { sectors, byKey, minX, maxX, minY, maxY, cols, rows, cell }

  function coordKey(x, y) {
    return `${x},${y}`;
  }

  function mapClampCell(px) {
    return Math.min(MAP_CELL_MAX, Math.max(MAP_CELL_MIN, Math.round(px)));
  }

  function mapFitCell(cols, rows) {
    // Leave room for the grid's own margin so a fitted map never starts
    // pinned against the viewport edge.
    const availW = mapViewport.clientWidth - 48;
    const availH = mapViewport.clientHeight - 48;
    return mapClampCell(Math.min(availW / cols, availH / rows));
  }

  function renderMapGrid() {
    const s = mapState;
    mapGrid.style.setProperty("--map-cols", s.cols);
    mapGrid.style.setProperty("--map-rows", s.rows);
    mapGrid.style.setProperty("--map-cell", `${s.cell}px`);
    mapGrid.innerHTML = "";

    const availWidth = s.cell - MAP_LABEL_PADDING;
    const availHeight = s.cell - MAP_LABEL_PADDING;
    const frag = document.createDocumentFragment();
    for (let y = s.maxY; y >= s.minY; y--) {
      for (let x = s.minX; x <= s.maxX; x++) {
        const sector = s.byKey.get(coordKey(x, y));
        const cell = document.createElement("div");
        if (!sector) {
          cell.className = "map-cell empty";
          frag.appendChild(cell);
          continue;
        }
        const isCurrent = model !== null && model.coordinate[0] === x && model.coordinate[1] === y;
        cell.className = isCurrent ? "map-cell filled current" : "map-cell filled";
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        // Wrapping lets a long title span multiple lines, so "fits" is a
        // vertical question too: estimate the lines it'll wrap to from its
        // unwrapped width, and check the stack of them still fits the cell.
        const wrappedLines = Math.max(1, Math.ceil(sector.textWidth / Math.max(1, availWidth)));
        const willFit = s.cell >= MAP_LABEL_MIN_CELL && wrappedLines * MAP_LABEL_LINE_HEIGHT <= availHeight;
        if (willFit) {
          const label = document.createElement("div");
          label.className = "map-cell-label";
          label.innerHTML = toHtml(`**${sector.title}**`);
          cell.appendChild(label);
        }
        frag.appendChild(cell);
      }
    }
    mapGrid.appendChild(frag);
  }

  function mapZoomTo(cellPx, focus) {
    const s = mapState;
    if (!s) {
      return;
    }
    // Keep whatever point under `focus` (viewport-relative px, defaults to
    // center) still under it after the resize, so zooming feels anchored
    // rather than yanking the view back to the top-left corner.
    const before = focus ?? { x: mapViewport.clientWidth / 2, y: mapViewport.clientHeight / 2 };
    const contentX = mapViewport.scrollLeft + before.x;
    const contentY = mapViewport.scrollTop + before.y;
    const ratio = mapClampCell(cellPx) / s.cell;

    s.cell = mapClampCell(cellPx);
    renderMapGrid();

    mapViewport.scrollLeft = contentX * ratio - before.x;
    mapViewport.scrollTop = contentY * ratio - before.y;
  }

  /**
   * Scrolls so the current-sector cell sits in the middle of the viewport.
   * Measured via getBoundingClientRect rather than offsetTop/offsetLeft,
   * since the cell's offsetParent (#map-grid, itself centered by `margin:
   * auto` inside the flex viewport) isn't the scroll container itself —
   * comparing rects sidesteps needing to know that chain at all.
   */
  function mapCenterOnCurrent() {
    const cellEl = mapGrid.querySelector(".map-cell.current");
    if (!cellEl) {
      return;
    }
    const cellRect = cellEl.getBoundingClientRect();
    const viewportRect = mapViewport.getBoundingClientRect();
    mapViewport.scrollLeft +=
      cellRect.left - viewportRect.left + cellRect.width / 2 - viewportRect.width / 2;
    mapViewport.scrollTop +=
      cellRect.top - viewportRect.top + cellRect.height / 2 - viewportRect.height / 2;
  }

  function openMapOverlay(data) {
    const sectors = data.sectors ?? [];
    const byKey = new Map();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of sectors) {
      const [x, y] = s.coordinate;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      byKey.set(coordKey(x, y), {
        coordinate: [x, y],
        title: s.title,
        textWidth: measureCanvas.measureText(s.title).width,
      });
    }
    const cols = maxX - minX + 1;
    const rows = maxY - minY + 1;

    mapState = { byKey, minX, maxX, minY, maxY, cols, rows, cell: MAP_CELL_MIN };
    mapOverlay.classList.remove("hidden");
    mapState.cell = mapFitCell(cols, rows);
    renderMapGrid();
    mapViewport.scrollLeft = 0;
    mapViewport.scrollTop = 0;
    mapCenterOnCurrent();

    // Belt and suspenders: the popup's own scroll region is fully contained
    // by design, but locking the page underneath means there is structurally
    // nothing left for a stray wheel or arrow event to scroll instead.
    document.documentElement.classList.add("map-open");
    hiddenInput.blur();
    document.addEventListener("keydown", onMapKeydown);
  }

  function closeMapOverlay() {
    mapOverlay.classList.add("hidden");
    mapTooltip.classList.add("hidden");
    mapState = null;
    document.documentElement.classList.remove("map-open");
    document.removeEventListener("keydown", onMapKeydown);
    refocus();
  }

  function onMapKeydown(ev) {
    const MAP_PAN_STEP = 60;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeMapOverlay();
      return;
    }
    if (ev.key === "+" || ev.key === "=") {
      ev.preventDefault();
      mapZoomTo(mapState.cell + 12);
      return;
    }
    if (ev.key === "-" || ev.key === "_") {
      ev.preventDefault();
      mapZoomTo(mapState.cell - 12);
      return;
    }
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown" || ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      ev.preventDefault();
      const dx = ev.key === "ArrowLeft" ? -MAP_PAN_STEP : ev.key === "ArrowRight" ? MAP_PAN_STEP : 0;
      const dy = ev.key === "ArrowUp" ? -MAP_PAN_STEP : ev.key === "ArrowDown" ? MAP_PAN_STEP : 0;
      // The viewport clamps this natively — panning simply stops at the
      // edge sectors, with no extra bookkeeping needed here.
      mapViewport.scrollLeft += dx;
      mapViewport.scrollTop += dy;
    }
  }

  mapViewport.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey) {
      // A ctrl+wheel pinch/scroll zooms, anchored under the cursor.
      const rect = mapViewport.getBoundingClientRect();
      mapZoomTo(mapState.cell - ev.deltaY * 0.4, { x: ev.clientX - rect.left, y: ev.clientY - rect.top });
      return;
    }
    // overflow is `hidden` on this element (no native scrollbar, see the
    // CSS), which also means no native wheel scrolling — driven by hand here
    // instead, the same as the arrow keys just below.
    mapViewport.scrollLeft += ev.deltaX;
    mapViewport.scrollTop += ev.deltaY;
  });

  mapGrid.addEventListener("mousemove", (ev) => {
    const cellEl = ev.target.closest(".map-cell.filled");
    if (!cellEl || cellEl.querySelector(".map-cell-label")) {
      mapTooltip.classList.add("hidden");
      return;
    }
    const sector = mapState.byKey.get(coordKey(Number(cellEl.dataset.x), Number(cellEl.dataset.y)));
    mapTooltip.textContent = sector.title;
    mapTooltip.style.left = `${ev.clientX}px`;
    mapTooltip.style.top = `${ev.clientY}px`;
    mapTooltip.classList.remove("hidden");
  });

  mapGrid.addEventListener("mouseleave", () => {
    mapTooltip.classList.add("hidden");
  });

  mapGrid.addEventListener("click", (ev) => {
    const cellEl = ev.target.closest(".map-cell.filled");
    if (!cellEl) {
      return;
    }
    const coordinate = [Number(cellEl.dataset.x), Number(cellEl.dataset.y)];
    closeMapOverlay();
    echoCommand(`teleport ${coordinate[0]} ${coordinate[1]}`);
    moveTo(coordinate);
  });

  async function doMap() {
    try {
      const data = await fetchJson("/v1/map");
      if (!data.sectors || data.sectors.length === 0) {
        print("The world is empty.");
        return;
      }
      openMapOverlay(data);
    } catch (exc) {
      printError(`Couldn't read the map: ${exc.message}`);
    }
  }

  async function examineObject(id) {
    const known = model.objects.get(id);
    if (known && known.description !== undefined) {
      print(renderObjectText(known));
      return;
    }
    try {
      const data = await fetchJson(`/v1/objects/${id}`);
      const merged = mergeObject(data);
      print(renderObjectText(merged));
    } catch (exc) {
      printError(`Couldn't examine that: ${exc.message}`);
    }
  }

  function doLook(name) {
    const { exitMatches, objectMatches } = findMatches(name);
    const total = exitMatches.length + objectMatches.length;
    if (total === 0) {
      printError("You don't see that here.");
      return;
    }
    if (total > 1) {
      printError(`Which do you mean: ${describeCandidates(exitMatches, objectMatches)}?`);
      return;
    }
    if (exitMatches.length === 1) {
      print(renderExitText(exitMatches[0]));
      return;
    }
    examineObject(objectMatches[0].object_id);
  }

  // --- command parsing --------------------------------------------------------

  const BARE_DIRECTIONS = {
    n: "north",
    s: "south",
    e: "east",
    w: "west",
    north: "north",
    south: "south",
    east: "east",
    west: "west",
  };

  const DROP_WORDS = new Set([
    // Articles
    "a", "an", "the",
    // Prepositions
    "to", "from", "at", "in", "on", "with", "under", "over",
    // Conjunctions
    "and", "but", "or",
    // Polite words
    "please", "thank", "you", "sorry",
    // Pronouns
    "it", "that", "them",
  ]);

  function stripDropWords(parts) {
    return parts.filter((word) => !DROP_WORDS.has(word.toLowerCase()));
  }

  function handleCommand(raw) {
    const input = raw.trim();
    if (!input) {
      return;
    }
    echoCommand(input);

    const rawParts = input.split(/\s+/);
    const parts = stripDropWords(rawParts);
    if (parts.length === 0) {
      printError("I don't understand that.");
      return;
    }
    const first = parts[0].toLowerCase();

    if (first === "look" || first === "l" || first === "examine" || first === "ex") {
      const rest = parts.slice(1).join(" ");
      if (!rest) {
        print(renderSectorText(model));
      } else {
        doLook(rest);
      }
      return;
    }

    if (first === "go" || first === "g" || first === "walk" || first === "run" || first === "fly") {
      const rest = parts.slice(1).join(" ");
      if (!rest) {
        printError("Go where?");
        return;
      }
      const direction = BARE_DIRECTIONS[rest.toLowerCase()];
      if (direction) {
        doGoDirection(direction);
      } else {
        doGoByName(rest);
      }
      return;
    }

    if (first === "teleport" || first === "tele" || first === "t") {
      doTeleport(parts.slice(1).join(" "));
      return;
    }

    if (first === "map" || first === "m") {
      doMap();
      return;
    }

    if (parts.length === 1 && BARE_DIRECTIONS[first]) {
      doGoDirection(BARE_DIRECTIONS[first]);
      return;
    }

    printError("I don't understand that.");
  }

  // --- input handling ---------------------------------------------------------

  function refocus() {
    hiddenInput.focus();
  }

  hiddenInput.addEventListener("input", () => {
    typed.textContent = hiddenInput.value;
  });

  hiddenInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      const value = hiddenInput.value;
      hiddenInput.value = "";
      typed.textContent = "";
      handleCommand(value);
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      scrollOutputBy(40);
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      scrollOutputBy(-40);
      return;
    }
  });

  // A wheel or touch drag hands control back to the live scroll position —
  // whatever the last animation was aiming at is no longer where the reader
  // wants to be.
  for (const name of ["wheel", "touchmove"]) {
    output.addEventListener(
      name,
      () => {
        cancelScrollAnim();
        scrollTarget = null;
      },
      { passive: true },
    );
  }

  output.addEventListener("scroll", updateMoreIndicator);

  crt.addEventListener("click", refocus);
  window.addEventListener("load", refocus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refocus();
    }
  });

  // --- boot ---------------------------------------------------------------

  async function pickStartCoordinate() {
    // A fresh arrival lands somewhere in the built world at random, not
    // always at the origin. Falls back to (0, 0) — which always exists, it's
    // the one sector the engine seeds itself — if the map can't be read.
    try {
      const map = await fetchJson("/v1/map");
      const sectors = map.sectors ?? [];
      if (sectors.length > 0) {
        return sectors[Math.floor(Math.random() * sectors.length)].coordinate;
      }
    } catch {
      // fall through to the origin
    }
    return [0, 0];
  }

  async function start() {
    print("Connecting to Mosaic...");
    try {
      const coordinate = await pickStartCoordinate();
      const data = await fetchJson(`/v1/sectors/${coordinate[0]}/${coordinate[1]}`);
      loadModelFromSector(data);
      print(renderSectorText(model));
    } catch (exc) {
      printError(`Could not reach the world: ${exc.message}`);
    }
    refocus();
  }

  start();
})();
