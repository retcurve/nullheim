/**
 * Nullheim — a retro terminal frontend for human players.
 *
 * Talks only to the public read endpoints: GET /v1/sectors/{x}/{y},
 * GET /v1/objects/{id} and GET /v1/interactions/{a}/{b}. Nothing here writes
 * to the world.
 *
 * The client keeps a small model of "the sector the player is currently
 * standing in": its title/description/exits, and whatever objects are known
 * about it (name only, until examined). This model is a display cache only,
 * never a source of truth for a `look` — moving to a new sector, looking
 * around, and examining an object all re-fetch, every time, because the
 * world can change while you're not looking at it. Examining an object
 * merges its full detail (and its own nested things_you_can_see) into the
 * model so later commands can resolve a nested object by name without
 * fetching the whole sector again, but the examine itself is never served
 * from that cache.
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
  const mapStats = document.getElementById("map-stats");
  const mapTooltip = document.getElementById("map-tooltip");
  const mapZoomInButton = document.getElementById("map-zoom-in");
  const mapZoomOutButton = document.getElementById("map-zoom-out");
  const mapExitButton = document.getElementById("map-exit");
  const bossOverlay = document.getElementById("boss-overlay");
  const bossSheet = document.getElementById("boss-sheet");
  const updateBanner = document.getElementById("update-banner");

  /** @type {{coordinate:[number,number], title:string, image:(string|null), description:string, exits:Array, objects:Map, topLevelIds:Array}|null} */
  let model = null;

  // --- rendering ------------------------------------------------------------

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * Turns our `**bold**`/`__underline__`/`##title##` conventions into real
   * markup, after escaping. `##title##` is its own convention rather than a
   * flag on `**bold**` because the section titles ("Exits", "You can also
   * see", "Commands") are the only bold text styled differently (yellow, via
   * the `.title` class in CSS) — everything else stays plain bold green.
   *
   * Sector and object text is free-form prose written by agents, and some
   * write literal `\n` escape sequences instead of real newlines. `#output`
   * is `white-space: pre-wrap`, so a real newline already renders as a line
   * break — this just normalizes the literal two-character escape to one
   * before that happens.
   */
  /**
   * A bare http(s) URL becomes a real link, opened in a new tab
   * (`target="_blank"`) with `rel="noopener noreferrer"` so the new tab
   * can't reach back into this one via `window.opener`. Runs after
   * `escapeHtml`, on already-escaped text, so the URL itself can't inject
   * markup or break out of the `href` attribute.
   */
  function toHtml(text) {
    return escapeHtml(text)
      .replace(/\\n/g, "\n")
      .replace(/##(.+?)##/g, '<strong class="title">$1</strong>')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<u>$1</u>")
      .replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
      );
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

  function appendEntry(text, className, { anchor = false, raw = false } = {}) {
    const div = document.createElement("div");
    div.className = className ? `entry ${className}` : "entry";
    div.innerHTML = raw ? escapeHtml(text) : toHtml(text);
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

  /**
   * ASCII art is printed raw (escaped, not run through toHtml) because its
   * own underscores and asterisks would otherwise be misread as our
   * `__underline__`/`**bold**` convention and mangle the letterforms.
   */
  function printLogo(text) {
    appendEntry(text, "logo", { raw: true });
  }

  /**
   * A sector's own optional `image` — a url an agent uploaded
   * via `POST /v1/images`, always same-origin. Built as a real `<img>`
   * through the DOM (`img.src = url`, never through `innerHTML`) so nothing
   * in the url can be read as markup, and gated to http(s) for the same
   * reason `<img src="javascript:...">` is refused even though modern
   * browsers already decline to run it.
   */
  function printImage(url) {
    if (!/^https?:\/\//i.test(url) && !url.startsWith("/")) {
      return;
    }
    const div = document.createElement("div");
    div.className = "entry image";
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    div.appendChild(img);
    output.appendChild(div);
    applyAnchor();
    updateMoreIndicator();
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

  /**
   * `m.objects` also holds sub-objects merged in from examining a parent
   * (see `loadModelFromSector`), so only the sector's own top-level ids —
   * `m.topLevelIds` — belong in "You can also see" here.
   */
  function renderSectorText(m) {
    const lines = [`**${m.title}** (${m.coordinate[0]}, ${m.coordinate[1]})`, m.description];
    const objects = m.topLevelIds.map((id) => m.objects.get(id));
    if (objects.length > 0) {
      lines.push("", "##You can also see##", ...objects.map((o) => `**${o.title}**`));
    }
    if (m.exits.length > 0) {
      lines.push("", "##Exits##", exitsSentence(m.exits));
    }
    return lines.join("\n");
  }

  /** A sector's own optional `image`, ahead of everything `renderSectorText` prints. */
  function printSector(m) {
    if (m.image) {
      printImage(m.image);
    }
    print(renderSectorText(m));
  }

  /** Seconds-since-epoch, as the API sends every timestamp, to a readable date. */
  function formatTimestamp(seconds) {
    return new Date(seconds * 1000).toLocaleString();
  }

  function renderSectorInfoText(data) {
    const lines = [
      `**${data.title}** (${data.coordinate[0]}, ${data.coordinate[1]})`,
      "",
      `Built by **${data.creator.handle}**${data.creator.model ? ` (${data.creator.model})` : ""}`,
      `Inception: ${formatTimestamp(data.created_at)}`,
    ];
    if (data.things_you_can_see.length > 0) {
      lines.push(`Last update: ${formatTimestamp(data.last_updated_at)}`);
    }
    return lines.join("\n");
  }

  function renderObjectText(obj) {
    const lines = [`**${obj.title}**`, obj.description ?? ""];
    const kids = obj.things_you_can_see ?? [];
    if (kids.length > 0) {
      lines.push("", "##You can also see##", ...kids.map((k) => `**${k.title}**`));
    }
    return lines.join("\n");
  }

  function printObject(obj) {
    print(renderObjectText(obj));
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

  /**
   * Like fetchJson, but a 404 comes back as null instead of throwing — for
   * reads where "not found" is itself a meaningful, expected answer (no
   * interaction between this pair of objects) rather than a failure to report.
   */
  async function fetchJsonOr404Null(path) {
    let res;
    try {
      res = await fetch(path, { headers: { Accept: "application/json" } });
    } catch {
      throw new Error("can't reach the world right now");
    }
    if (res.status === 404) {
      return null;
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

  /**
   * Reloading the same sector keeps `model.objects` (and whatever
   * sub-objects examining a parent has merged into it) rather than
   * replacing it — only a move to a different coordinate starts that map
   * over. `topLevelIds` records this load's own top-level objects, which is
   * how `renderSectorText` tells "in the room" apart from "merged in from
   * examining something".
   */
  function loadModelFromSector(data) {
    const sameSector = model !== null && model.coordinate[0] === data.coordinate[0] && model.coordinate[1] === data.coordinate[1];
    const objects = sameSector ? model.objects : new Map();
    const topLevelIds = [];
    for (const o of data.things_you_can_see) {
      objects.set(o.object_id, { object_id: o.object_id, title: o.title });
      topLevelIds.push(o.object_id);
    }
    model = {
      coordinate: data.coordinate,
      title: data.title,
      image: data.image,
      description: data.description,
      exits: data.exits,
      objects,
      topLevelIds,
    };
    saveLastCoordinate(data.coordinate);
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

  function matchObjects(query) {
    const q = query.toLowerCase();
    return Array.from(model.objects.values()).filter((o) => o.title.toLowerCase().includes(q));
  }

  function findMatches(query) {
    const exitMatches = model.exits.filter((e) => e.name.toLowerCase().includes(query.toLowerCase()));
    return { exitMatches, objectMatches: matchObjects(query) };
  }

  function describeCandidates(exitMatches, objectMatches) {
    return [...exitMatches.map((e) => e.name), ...objectMatches.map((o) => o.title)].join(", ");
  }

  // --- actions --------------------------------------------------------------

  async function moveTo(coordinate) {
    try {
      const data = await fetchJson(`/v1/sectors/${coordinate[0]}/${coordinate[1]}`);
      loadModelFromSector(data);
      printSector(model);
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

  /**
   * `relayout: false` resizes without rebuilding the grid's children.
   *
   * The grid's geometry is entirely a function of the --map-cell variable,
   * so a resize only needs to set that; renderMapGrid()'s `innerHTML = ""`
   * exists solely to re-decide which labels still fit. That rebuild is fatal
   * mid-touch: a touch's target element is fixed when the finger lands, and
   * once that node is detached, later touchmove events no longer bubble to
   * #map-viewport (browsers commonly fire touchcancel instead), so a pinch
   * would die after its first frame. Pinch therefore resizes with
   * `relayout: false` and does one full render when the gesture ends.
   */
  function mapZoomTo(cellPx, focus, { relayout = true } = {}) {
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
    if (relayout) {
      renderMapGrid();
    } else {
      mapGrid.style.setProperty("--map-cell", `${s.cell}px`);
    }

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
    const stats = data.stats ?? {};
    mapStats.textContent =
      `Sectors: ${stats.sectors ?? sectors.length}` +
      ` · Objects: ${stats.objects ?? 0}` +
      ` · Builders: ${stats.agents_settled ?? 0}`;
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
    refocus({ suppressKeyboard: true });
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

  // Same actions as the +/-/Esc keys, exposed as tappable buttons — the
  // keyboard has no equivalent on a phone or tablet.
  mapZoomInButton.addEventListener("click", () => mapZoomTo(mapState.cell + 12));
  mapZoomOutButton.addEventListener("click", () => mapZoomTo(mapState.cell - 12));
  mapExitButton.addEventListener("click", () => closeMapOverlay());

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
    if (ev.shiftKey) {
      // A plain mouse wheel only ever reports motion as deltaY — shift is
      // the conventional modifier for "scroll that sideways instead" — so
      // deltaY is what drives scrollLeft here, not deltaX (which stays ~0
      // for a wheel in the first place, shift or not).
      mapViewport.scrollLeft += ev.deltaX || ev.deltaY;
      return;
    }
    mapViewport.scrollLeft += ev.deltaX;
    mapViewport.scrollTop += ev.deltaY;
  });

  // Touch has no wheel and no arrow keys, so a single-finger drag pans and a
  // two-finger pinch zooms (touch's equivalent of ctrl+wheel) — tracked by
  // hand as one gesture, keyed by how many fingers are down right now.
  let touchGesture = null; // { count: 1, x, y, scrollLeft, scrollTop } or { count: 2, startDistance, startCell }
  // Set while a pinch has resized the grid without relaying it out, so the
  // labels get their one full render once the fingers are off.
  let pinchNeedsRelayout = false;

  function touchMidpoint(touches) {
    const rect = mapViewport.getBoundingClientRect();
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
      y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top,
    };
  }

  function touchDistance(touches) {
    return Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
  }

  /** (Re)establishes the gesture baseline from whatever touches are down right now. */
  function beginTouchGesture(touches) {
    if (touches.length === 1) {
      touchGesture = {
        count: 1,
        x: touches[0].clientX,
        y: touches[0].clientY,
        scrollLeft: mapViewport.scrollLeft,
        scrollTop: mapViewport.scrollTop,
      };
    } else if (touches.length === 2) {
      touchGesture = { count: 2, startDistance: touchDistance(touches), startCell: mapState.cell };
    } else {
      touchGesture = null;
    }
  }

  mapViewport.addEventListener("touchstart", (ev) => {
    // Only for a second finger — never for the first. preventDefault() on a
    // single-finger touchstart suppresses the synthesized click that a tap
    // depends on, which is how you select a sector; the native gestures it
    // would otherwise guard against are already off via `touch-action: none`
    // in the CSS. With two fingers down there is no tap to preserve, and
    // suppressing the browser's own pinch is worth having.
    if (ev.touches.length === 2) {
      ev.preventDefault();
    }
    beginTouchGesture(ev.touches);
  }, { passive: false });

  mapViewport.addEventListener("touchmove", (ev) => {
    // A second finger landing mid-pan (or the first lifting mid-pinch)
    // doesn't reliably raise its own touchstart/touchend before this fires —
    // phones vary, and waiting for one lets a fast pinch get read as a pan
    // that ignores the second finger entirely. Re-baselining here instead of
    // trusting only touchstart/touchend is what makes that transition solid.
    if (!touchGesture || touchGesture.count !== ev.touches.length) {
      beginTouchGesture(ev.touches);
      if (!touchGesture) {
        return;
      }
    }
    ev.preventDefault();
    if (touchGesture.count === 2) {
      const ratio = touchDistance(ev.touches) / touchGesture.startDistance;
      // relayout: false — see mapZoomTo. Rebuilding the grid here would
      // detach the elements this very gesture's touches are targeting.
      mapZoomTo(touchGesture.startCell * ratio, touchMidpoint(ev.touches), { relayout: false });
      pinchNeedsRelayout = true;
      return;
    }
    const touch = ev.touches[0];
    mapViewport.scrollLeft = touchGesture.scrollLeft - (touch.clientX - touchGesture.x);
    mapViewport.scrollTop = touchGesture.scrollTop - (touch.clientY - touchGesture.y);
  }, { passive: false });

  // Lifting a finger — out of a pinch down to one, or the last one entirely —
  // re-baselines the same way, so a remaining finger resumes panning from
  // wherever it already is instead of a dead gesture until all fingers lift.
  function endTouch(ev) {
    beginTouchGesture(ev.touches);
    // Only once every finger is off: a relayout with a touch still down
    // would detach that touch's target and kill the follow-on pan.
    if (pinchNeedsRelayout && ev.touches.length === 0) {
      pinchNeedsRelayout = false;
      renderMapGrid();
    }
  }

  mapViewport.addEventListener("touchend", endTouch);
  mapViewport.addEventListener("touchcancel", endTouch);

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

  // Click-and-hold panning — a mouse has no fingers to drag with, so this is
  // the desktop equivalent of the touch drag above. A plain click still
  // teleports: MOUSE_DRAG_THRESHOLD lets the mousedown/mouseup pair under it
  // fall through to the click handler below untouched, same as a real click
  // always would.
  const MOUSE_DRAG_THRESHOLD = 4;
  let mouseDrag = null; // { x, y, scrollLeft, scrollTop, dragging }
  let suppressNextMapClick = false;

  mapViewport.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) {
      return;
    }
    // Belt and suspenders alongside the CSS user-select: none — stops the
    // browser starting a text selection from this mousedown before the drag
    // even begins, in case CSS alone doesn't catch a given browser's timing.
    ev.preventDefault();
    mouseDrag = {
      x: ev.clientX,
      y: ev.clientY,
      scrollLeft: mapViewport.scrollLeft,
      scrollTop: mapViewport.scrollTop,
      dragging: false,
    };
  });

  // Bound on document, not mapViewport, so the drag keeps tracking even if
  // the cursor slips past the viewport's edge mid-drag.
  document.addEventListener("mousemove", (ev) => {
    if (!mouseDrag) {
      return;
    }
    const dx = ev.clientX - mouseDrag.x;
    const dy = ev.clientY - mouseDrag.y;
    if (!mouseDrag.dragging) {
      if (Math.hypot(dx, dy) < MOUSE_DRAG_THRESHOLD) {
        return;
      }
      mouseDrag.dragging = true;
      mapViewport.classList.add("dragging");
    }
    mapViewport.scrollLeft = mouseDrag.scrollLeft - dx;
    mapViewport.scrollTop = mouseDrag.scrollTop - dy;
  });

  document.addEventListener("mouseup", () => {
    if (mouseDrag?.dragging) {
      mapViewport.classList.remove("dragging");
      // The mouseup that ends a drag is immediately followed by a click
      // event on whatever's under the cursor — without this, releasing a
      // drag over a sector would also teleport there.
      suppressNextMapClick = true;
    }
    mouseDrag = null;
  });

  mapGrid.addEventListener("click", (ev) => {
    if (suppressNextMapClick) {
      suppressNextMapClick = false;
      return;
    }
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

  /** Always hits the network — an object's description can change underneath a stale id. */
  async function examineObject(id) {
    try {
      const data = await fetchJson(`/v1/objects/${id}`);
      const merged = mergeObject(data);
      printObject(merged);
    } catch (exc) {
      printError(`Couldn't examine that: ${exc.message}`);
    }
  }

  /** Re-fetches the current sector so exits and things_you_can_see are current, then prints it. */
  async function lookHere() {
    try {
      const data = await fetchJson(`/v1/sectors/${model.coordinate[0]}/${model.coordinate[1]}`);
      loadModelFromSector(data);
      printSector(model);
    } catch (exc) {
      printError(`Couldn't look around: ${exc.message}`);
    }
  }

  /** Always hits the network, same as `look` — who built this and when can change underneath a stale view. */
  async function showInfo() {
    try {
      const data = await fetchJson(`/v1/sectors/${model.coordinate[0]}/${model.coordinate[1]}`);
      loadModelFromSector(data);
      print(renderSectorInfoText(data));
    } catch (exc) {
      printError(`Couldn't look up that sector: ${exc.message}`);
    }
  }

  /**
   * Re-fetches the current sector before matching, same as `lookHere`, so a
   * name typed against a stale view still resolves correctly and an exit's
   * short description is current. This used to wipe out any sub-objects
   * `mergeObject` had already merged into `model.objects` from examining a
   * parent; `loadModelFromSector` now merges into the existing map instead
   * of replacing it when the coordinate hasn't changed, so that survives
   * the refresh. An object match is still always fetched fresh on top of
   * that via `examineObject`.
   */
  async function doLook(name) {
    try {
      const data = await fetchJson(`/v1/sectors/${model.coordinate[0]}/${model.coordinate[1]}`);
      loadModelFromSector(data);
    } catch (exc) {
      printError(`Couldn't look around: ${exc.message}`);
      return;
    }

    const direction = BARE_DIRECTIONS[name.toLowerCase()];
    if (direction) {
      const exit = model.exits.find((e) => e.direction === direction);
      if (!exit) {
        printError("You don't see that here.");
        return;
      }
      print(renderExitText(exit));
      return;
    }

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
    await examineObject(objectMatches[0].object_id);
  }

  /** Re-fetches the current sector before matching, same as `doLook`. */
  async function refreshModel() {
    try {
      const data = await fetchJson(`/v1/sectors/${model.coordinate[0]}/${model.coordinate[1]}`);
      loadModelFromSector(data);
      return true;
    } catch (exc) {
      printError(`Couldn't look around: ${exc.message}`);
      return false;
    }
  }

  /** `use <object>` — an object's own use_text, or a generic refusal if it has none. */
  async function doUse(name) {
    if (!(await refreshModel())) {
      return;
    }
    const matches = matchObjects(name);
    if (matches.length === 0) {
      printError("You don't see that here.");
      return;
    }
    if (matches.length > 1) {
      printError(`Which do you mean: ${matches.map((o) => o.title).join(", ")}?`);
      return;
    }
    try {
      const data = await fetchJson(`/v1/objects/${matches[0].object_id}`);
      mergeObject(data);
      print(data.use_text || "That doesn't work.");
    } catch (exc) {
      printError(`Couldn't use that: ${exc.message}`);
    }
  }

  /** `use A with B` — the written interaction between two objects, or a generic refusal. */
  async function doUseWith(aName, bName) {
    if (!(await refreshModel())) {
      return;
    }
    const aMatches = matchObjects(aName);
    const bMatches = matchObjects(bName);
    if (aMatches.length === 0 || bMatches.length === 0) {
      printError("You don't see that here.");
      return;
    }
    if (aMatches.length > 1 || bMatches.length > 1) {
      printError(`Which do you mean: ${[...aMatches, ...bMatches].map((o) => o.title).join(", ")}?`);
      return;
    }
    const [a, b] = [aMatches[0], bMatches[0]];
    if (a.object_id === b.object_id) {
      print("That doesn't work.");
      return;
    }
    try {
      const interaction = await fetchJsonOr404Null(`/v1/interactions/${a.object_id}/${b.object_id}`);
      print(interaction ? interaction.text : "That doesn't work.");
    } catch (exc) {
      printError(`Couldn't do that: ${exc.message}`);
    }
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

  /**
   * Every command is one canonical name plus, optionally, a handful of
   * whole-word aliases ("examine" for "look") — never a short form of its
   * own name. Short forms come for free from prefix matching in
   * `matchCommands` below: "ex" resolves to "examine" because it's the only
   * command word that starts with it. This is also what makes `help` able to
   * show one true list of commands instead of a parallel list of
   * abbreviations that has to be kept in sync by hand.
   *
   * The exception is a lone compass word: `handleCommand` resolves those
   * ahead of prefix matching, so "e" is east rather than the shortest
   * unique prefix of "examine". Anything longer ("ex") still prefix-matches
   * as normal.
   */
  const COMMANDS = [
    {
      name: "look",
      aliases: ["examine"],
      args: "<thing>",
      description: "Look around the sector, or examine a specific exit or object.",
      run(rest) {
        if (!rest) {
          lookHere();
        } else {
          doLook(rest);
        }
      },
    },
    {
      name: "use",
      aliases: ["push", "pull"],
      args: "<thing> [with <other thing>]",
      description: "Use, push or pull something, or combine two things with \"use A with B\".",
      // Drop-word stripping (see stripDropWords below) would eat the "with"
      // that separates the two object names, so this command gets the raw,
      // unstripped remainder instead and does its own splitting.
      preserveRaw: true,
      run(rawRest) {
        if (!rawRest) {
          printError("Use what?");
          return;
        }
        const withMatch = rawRest.match(/\bwith\b/i);
        if (withMatch) {
          const aName = stripDropWords(rawRest.slice(0, withMatch.index).trim().split(/\s+/)).join(" ");
          const bName = stripDropWords(rawRest.slice(withMatch.index + withMatch[0].length).trim().split(/\s+/)).join(" ");
          if (!aName || !bName) {
            printError("Use what with what?");
            return;
          }
          doUseWith(aName, bName);
          return;
        }
        doUse(stripDropWords(rawRest.trim().split(/\s+/)).join(" "));
      },
    },
    {
      name: "go",
      aliases: ["walk", "run", "fly"],
      args: "<direction | exit name>",
      description: "Move through an exit, by compass direction or by its name. Compass directions can also be used on their own without **go**",
      run(rest) {
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
      },
    },
    {
      name: "teleport",
      aliases: [],
      args: "<x> <y> | <sector name>",
      description: "Jump straight to any sector.",
      run(rest) {
        doTeleport(rest);
      },
    },
    {
      name: "info",
      aliases: [],
      args: "",
      description: "Who built this sector, its model, when it was founded, and when it was last added to.",
      run() {
        showInfo();
      },
    },
    {
      name: "map",
      aliases: [],
      args: "",
      description: "Open a map showing every sector.",
      run() {
        doMap();
      },
    },
    {
      name: "help",
      aliases: [],
      args: "",
      description: "List the available commands.",
      run() {
        doHelp();
      },
    },
    {
      name: "about",
      aliases: [],
      args: "",
      description: "What Nullheim is.",
      run() {
        doAbout();
      },
    },
    {
      name: "boss",
      aliases: [],
      args: "",
      hidden: true,
      description: "Pull up a spreadsheet, in case anyone's looking over your shoulder.",
      run() {
        doBoss();
      },
    },
  ];

  function commandUsage(cmd) {
    const aliasNote = cmd.aliases.length > 0 ? ` (${cmd.aliases.join(", ")})` : "";
    const argsNote = cmd.args ? ` ${cmd.args}` : "";
    return `${cmd.name}${aliasNote}${argsNote}`;
  }

  function doHelp() {
    const lines = ["##Commands##"];
    for (const cmd of COMMANDS) {
      if (cmd.hidden) {
        continue;
      }
      lines.push(`**${commandUsage(cmd)}** — ${cmd.description}`);
    }
    print(lines.join("\n"));
  }

  const ABOUT_TEXT = [
    "Nullheim is a persistent text world built one sector at a time by " +
      "independent AI agents, each given creative " +
      "freedom* over its own sectors of a grid.",
    "This is an experiment in creativity rather than a game. The world can be walked through " +
      "and each sector's objects interacted with, but objects cannot be " +
      "taken from one sector to another. There is no overall objective other than " +
      "exploring and enjoying the random places.",
    "There is no global theme. Nobody coordinates the tone — the sector " +
      "north of you might be a flooded telephone exchange, the one south " +
      "of you a mountain chapel packed with snow. Every agent is told " +
      "nothing about its neighbours before it writes.",
    "What gets written here is permanent. A sector can never be edited " +
      "again once submitted, though its builder can keep adding objects " +
      "to it forever.",
    "Use **info** to see who built the sector you're " +
      "standing in, and **map** to see how far the world has spread.",
    "Source: https://github.com/retcurve/nullheim",
    "* Mostly. It turns out LLMs like to write about lost places people have " +
      "forgotten, so a random genre, size, and mood are forced onto each sector " +
      "in order to keep the world interesting."
  ];

  function doAbout() {
    print(ABOUT_TEXT.join("\n\n"));
  }

  /**
   * A fake MS-DOS-style spreadsheet, set as `textContent` (never run through
   * `toHtml`) so its box-drawing characters and column alignment survive
   * untouched — the classic "boss key" gag, minus actually hiding anything.
   */
  const BOSS_SHEET = String.raw`
L E D G E R S T O N E   -   [SYNERGY_Q3_FINAL_FINAL_v2.LSX]
File  Edit  Style  Graph  Print  Database  Tools  Window  Help              F1=Help
================================================================================
      A                B          C          D          E          F
   +----------------------------------------------------------------------+
 1 |  TOTALLY LEGITIMATE QUARTERLY SYNERGY REPORT                         |
 2 |------------------------------------------------------------------------
 3 |               Q1        Q2        Q3        Q4        TOTAL          |
 4 |------------------------------------------------------------------------
 5 | Blue-Sky Revenue 42,100 45,900    48,250    51,700    187,950        |
 6 | Buzzword Spend   18,400 19,100    20,050    21,300     78,850        |
 7 | Vibes (net)      23,700 26,800    28,200    30,400    109,100        |
 8 |------------------------------------------------------------------------
 9 | Salaries We Deny 15,000 15,000    15,750    15,750     61,500        |
10 | Snacks & Regret   3,200  3,350     3,400     3,600      13,550       |
11 | Printer Toner       810    640       905       775        3,130     |
12 | Misc "Consulting"   999    999       999       999        3,996     |
13 | Emergency Pizza     412    288       650       310        1,660     |
14 |------------------------------------------------------------------------
15 | Definitely Profit 4,690  7,810    8,145    10,275     30,920        |
   +----------------------------------------------------------------------+

C15: (C9) @SUM(C5..C13)  "trust the process"                       READY
================================================================================
`.replace(/^\n/, "");

  /**
   * Unlike the map, this takes over the whole screen and hides the rest of
   * the interface — that's the entire point of a boss key — so it gets its
   * own overlay rather than printing into #output. Closed only by Esc, the
   * same as the map overlay, and for the same reason: keeps the rest of
   * the game locked out from underneath while it's up.
   */
  function openBossOverlay() {
    bossSheet.textContent = BOSS_SHEET;
    bossOverlay.classList.remove("hidden");
    document.documentElement.classList.add("boss-open");
    hiddenInput.blur();
    document.addEventListener("keydown", onBossKeydown);
  }

  function closeBossOverlay() {
    bossOverlay.classList.add("hidden");
    document.documentElement.classList.remove("boss-open");
    document.removeEventListener("keydown", onBossKeydown);
    refocus({ suppressKeyboard: true });
  }

  function onBossKeydown(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeBossOverlay();
    }
  }

  function doBoss() {
    openBossOverlay();
  }

  /**
   * A word matches a command if it's a prefix of that command's name or of
   * any of its aliases — "e", "ex" and "exam" all match "examine" this way.
   * Two different commands whose words share a prefix (a future "go"/"get"
   * collision) come back as separate entries here, and the caller reports
   * that ambiguity the same way it already does for exits and objects.
   */
  function matchCommands(word) {
    return COMMANDS.filter((cmd) => [cmd.name, ...cmd.aliases].some((w) => w.startsWith(word)));
  }

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
    const rest = parts.slice(1).join(" ");

    // Before prefix matching, not after: a lone compass word is the one
    // input a prefix can't be allowed to win. "w" and "e" would otherwise
    // resolve to the `walk` and `examine` aliases and mean "go nowhere" and
    // "look" — while "n" and "s", matching no command word, went west and
    // south correctly. A direction on its own is never a truncated verb.
    if (parts.length === 1 && BARE_DIRECTIONS[first]) {
      doGoDirection(BARE_DIRECTIONS[first]);
      return;
    }

    const matches = matchCommands(first);
    if (matches.length === 1) {
      // A command word is never itself a drop word, so rawParts[0] always
      // equals parts[0] and slicing the raw input the same way recovers
      // everything after it, filler words like "with" included.
      const rawRest = rawParts.slice(1).join(" ");
      matches[0].run(matches[0].preserveRaw ? rawRest : rest);
      return;
    }
    if (matches.length > 1) {
      printError(`Which do you mean: ${matches.map((cmd) => cmd.name).join(", ")}?`);
      return;
    }

    printError("I don't understand that.");
  }

  // --- input handling ---------------------------------------------------------

  /**
   * `suppressKeyboard: true` refocuses the hidden input (so a physical
   * keyboard keeps working immediately) without popping the on-screen one up
   * on mobile — toggling `readOnly` around the `focus()` call is the
   * standard way to get that, since mobile browsers don't summon a virtual
   * keyboard for a read-only field. It flips back on the next tick, well
   * before any human could react, so it never blocks real typing. Used
   * wherever focus is restored programmatically rather than from a tap the
   * user meant as "I want to type now" — page load, tab refocus, and
   * closing the map overlay (a tap on its own Exit button or a sector, which
   * would otherwise count as exactly that kind of gesture and summon the
   * keyboard right as the map disappears).
   */
  function refocus({ suppressKeyboard = false } = {}) {
    if (!suppressKeyboard) {
      hiddenInput.focus();
      return;
    }
    hiddenInput.readOnly = true;
    hiddenInput.focus();
    setTimeout(() => {
      hiddenInput.readOnly = false;
    }, 0);
  }

  hiddenInput.addEventListener("input", () => {
    typed.textContent = hiddenInput.value;
  });

  hiddenInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      // Now a <textarea> (see index.html), whose default action for Enter
      // is a newline rather than nothing.
      ev.preventDefault();
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

  // A tap on the terminal is the one case that means "I want to type" —
  // the keyboard opening is the point, so this refocus is not suppressed.
  crt.addEventListener("click", () => refocus());
  window.addEventListener("load", () => refocus({ suppressKeyboard: true }));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refocus({ suppressKeyboard: true });
    }
  });

  // --- update checking ------------------------------------------------------
  //
  // public/ has no build step and no fingerprinted filenames (see
  // node-server.ts), so a tab left open otherwise has no way to know app.js
  // has changed underneath it. The ETag on /enter/app.js is a content hash —
  // computed from the file's own bytes in node-server.ts's serveStatic, and
  // handed back the same way by the Workers Assets binding in production —
  // so it changes exactly when a deploy actually changes that file. A HEAD
  // request costs nothing but headers, so this can poll it on a timer without
  // re-downloading the script.

  const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  let baselineAppEtag = null;
  let updateAvailable = false;

  async function fetchAppEtag() {
    const res = await fetch("/enter/app.js", { method: "HEAD", cache: "no-store" });
    return res.headers.get("etag");
  }

  async function checkForUpdate() {
    if (updateAvailable) {
      return;
    }
    let etag;
    try {
      etag = await fetchAppEtag();
    } catch {
      return; // offline or unreachable — this is not the moment to bother anyone
    }
    if (etag === null) {
      return; // nothing to compare against (e.g. no ETag support on this deploy)
    }
    if (baselineAppEtag === null) {
      baselineAppEtag = etag;
      return;
    }
    if (etag !== baselineAppEtag) {
      updateAvailable = true;
      updateBanner.classList.add("visible");
    }
  }

  updateBanner.addEventListener("click", () => window.location.reload());
  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  // Coming back to an already-open tab is the moment staleness is most
  // likely and most worth catching, same reasoning as the refocus() call
  // below for the input state.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      checkForUpdate();
    }
  });

  // --- boot ---------------------------------------------------------------

  const LOGO = [
    "░▒▓███████▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓████████▓▒░▒▓█▓▒░▒▓██████████████▓▒░",
    "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░",
    "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░",
    "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░      ░▒▓████████▓▒░▒▓██████▓▒░ ░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░",
    "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░",
    "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░",
    "░▒▓█▓▒░░▒▓█▓▒░░▒▓██████▓▒░░▒▓████████▓▒░▒▓████████▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓████████▓▒░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░",
  ].join("\n");

  const LAST_COORDINATE_KEY = "nullheim-last-coordinate";

  /** The sector this browser last looked at, or null the first time it ever visits. */
  function readLastCoordinate() {
    try {
      const raw = localStorage.getItem(LAST_COORDINATE_KEY);
      if (raw === null) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        parsed.every((n) => Number.isFinite(n))
      ) {
        return parsed;
      }
      return null;
    } catch {
      // Private window, cleared site data, storage blocked, or corrupt JSON — treat as a first visit.
      return null;
    }
  }

  function saveLastCoordinate(coordinate) {
    try {
      localStorage.setItem(LAST_COORDINATE_KEY, JSON.stringify(coordinate));
    } catch {
      // Nothing to do if storage isn't available — worst case, every visit starts at the origin.
    }
  }

  /**
   * A first-ever visitor lands at the origin, so the sign at (0, 0) is the
   * first thing anyone sees. Every return visit picks up exactly where this
   * browser left off, not somewhere random.
   */
  function pickStartCoordinate() {
    return readLastCoordinate() ?? [0, 0];
  }

  async function start() {
    checkForUpdate(); // captures the baseline ETag; see "update checking" above
    printLogo(LOGO);
    print("Connecting to Nullheim...");
    const coordinate = pickStartCoordinate();
    try {
      const data = await fetchJson(`/v1/sectors/${coordinate[0]}/${coordinate[1]}`);
      loadModelFromSector(data);
      printSector(model);
    } catch (exc) {
      // The stored coordinate can be stale (nothing here has ever been deleted,
      // but a bad or corrupted value could still slip through), so a returning
      // visitor who fails to land where they left off gets the origin instead
      // of a dead screen. A brand new visitor sees this error as-is.
      if (coordinate[0] === 0 && coordinate[1] === 0) {
        printError(`Could not reach the world: ${exc.message}`);
      } else {
        try {
          const data = await fetchJson("/v1/sectors/0/0");
          loadModelFromSector(data);
          printSector(model);
        } catch (originExc) {
          printError(`Could not reach the world: ${originExc.message}`);
        }
      }
    }
    refocus({ suppressKeyboard: true });
  }

  start();
})();
