/* global state */
let selectedFile = null;   // rel_path
let connected = false;
let searchTimer = null;
let selectedDb = null;     // 对象浏览器当前库
let selectedTable = null;  // 对象浏览器当前表

/* SQL 联想用元数据缓存 */
let schemaDbs = [];                 // 可见数据库名
const schemaTables = {};            // { db: [table, ...] }
const schemaColumns = {};           // { "db.table": [column, ...] }
const columnsLoaded = new Set();    // 已拉取字段的库

const $ = (id) => document.getElementById(id);
const fileListEl = $("fileList");
const searchInput = $("searchInput");

/* ---------------- 工具 ---------------- */
function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("toastWrap").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlightKeyword(name, kw) {
  const safe = escapeHtml(name);
  if (!kw) return safe;
  const idx = name.toLowerCase().indexOf(kw.toLowerCase());
  if (idx === -1) return safe;
  return escapeHtml(name.slice(0, idx)) + "<mark>" + escapeHtml(name.slice(idx, idx + kw.length)) + "</mark>" + escapeHtml(name.slice(idx + kw.length));
}

async function api(url, options = {}) {
  const resp = await fetch(url, options);
  let data = null;
  try { data = await resp.json(); } catch (e) { /* ignore */ }
  if (!resp.ok) {
    const err = new Error((data && data.error) || `HTTP ${resp.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------------- 配置与文件列表 ---------------- */
async function loadConfig() {
  try {
    const cfg = await api("/api/config");
    const info = $("dirInfo");
    if (cfg.valid_dir) {
      info.textContent = cfg.scripts_dir;
      info.title = cfg.scripts_dir;
    } else {
      info.textContent = "⚠ 目录未配置或不存在";
      info.title = cfg.scripts_dir || "请在 config.json 中配置 scripts_dir";
      toast("请先在 config.json 中配置 scripts_dir 指向文件目录", "error");
    }
  } catch (e) { /* ignore */ }
}

async function loadFiles() {
  const kw = searchInput.value.trim();
  try {
    const data = await api(`/api/files?keyword=${encodeURIComponent(kw)}`);
    renderFileList(data, kw);
  } catch (e) {
    fileListEl.innerHTML = `<div class="no-files">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderFileList(data, kw) {
  const files = data.files || [];
  $("fileStats").textContent = `共 ${data.total} 个文件${kw ? `，匹配 ${data.matched} 个` : ""}`;
  if (!files.length) {
    fileListEl.innerHTML = `<div class="no-files">${kw ? "没有匹配的文件" : "目录下没有文件"}</div>`;
    return;
  }
  fileListEl.innerHTML = files.map(f => `
    <div class="file-item${f.rel_path === selectedFile ? " active" : ""}" data-path="${escapeHtml(f.rel_path)}" data-name="${escapeHtml(f.name)}">
      <span class="f-name">${highlightKeyword(f.name, kw)}</span>
      ${f.rel_path !== f.name ? `<span class="f-path">${highlightKeyword(f.rel_path, kw)}</span>` : ""}
    </div>`).join("");
}

fileListEl.addEventListener("click", (e) => {
  const item = e.target.closest(".file-item");
  if (!item) return;
  selectFile(item.dataset.path, item.dataset.name);
});

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadFiles, 200);
});
$("clearBtn").addEventListener("click", () => {
  searchInput.value = "";
  searchInput.focus();
  loadFiles();
});

/* ---------------- 对象浏览器 ---------------- */
function resetExplorer() {
  selectedDb = null;
  selectedTable = null;
  $("explorerCard").classList.add("hidden");
  $("dbList").innerHTML = "";
  $("tableList").innerHTML = "";
  $("tableColTitle").textContent = "数据表";
  $("expBreadcrumb").textContent = "";
}

function showExplorer() {
  $("explorerCard").classList.remove("hidden");
  loadDatabases();
}

async function loadDatabases() {
  selectedDb = null;
  selectedTable = null;
  $("dbList").innerHTML = `<div class="exp-empty">加载中…</div>`;
  $("tableList").innerHTML = `<div class="exp-empty">← 先选择数据库</div>`;
  $("tableColTitle").textContent = "数据表";
  $("expBreadcrumb").textContent = "";
  try {
    const data = await api(`/api/databases?path=${encodeURIComponent(selectedFile)}`);
    const dbs = data.databases || [];
    schemaDbs = dbs;
    if (!dbs.length) {
      $("dbList").innerHTML = `<div class="exp-empty">没有可见数据库</div>`;
      return;
    }
    $("dbList").innerHTML = dbs.map(d =>
      `<div class="exp-item" data-db="${escapeHtml(d)}" title="${escapeHtml(d)}"><span class="exp-ico">⛁</span>${escapeHtml(d)}</div>`).join("");
  } catch (e) {
    $("dbList").innerHTML = `<div class="exp-empty">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

async function loadTables(db) {
  selectedDb = db;
  selectedTable = null;
  $("tableColTitle").textContent = `数据表（${db}）`;
  $("expBreadcrumb").textContent = db;
  $("tableList").innerHTML = `<div class="exp-empty">加载中…</div>`;
  document.querySelectorAll("#dbList .exp-item").forEach(el =>
    el.classList.toggle("active", el.dataset.db === db));
  $("resultArea").innerHTML = "";
  try {
    const data = await api(`/api/tables?path=${encodeURIComponent(selectedFile)}&db=${encodeURIComponent(db)}`);
    const tables = data.tables || [];
    schemaTables[db] = tables.map(t => t.name);
    loadAllColumns(db); // 后台拉取字段，供 SQL 联想使用
    if (!tables.length) {
      $("tableList").innerHTML = `<div class="exp-empty">该库没有表</div>`;
      return;
    }
    $("tableList").innerHTML = tables.map(t => `
      <div class="exp-item" data-table="${escapeHtml(t.name)}" title="${escapeHtml(t.comment || t.name)}">
        <span class="exp-ico">${String(t.type).toUpperCase().includes("VIEW") ? "◫" : "▤"}</span>
        <span class="exp-name">${escapeHtml(t.name)}</span>
        ${t.row_est ? `<span class="exp-rows" title="估算行数">≈${escapeHtml(String(t.row_est))}</span>` : ""}
        <button class="exp-struct" data-act="struct" title="查看表结构">结构</button>
      </div>`).join("");
  } catch (e) {
    $("tableList").innerHTML = `<div class="exp-empty">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

async function loadAllColumns(db) {
  if (!db || columnsLoaded.has(db)) return;
  columnsLoaded.add(db);
  try {
    const data = await api(`/api/table/columns/all?path=${encodeURIComponent(selectedFile)}&db=${encodeURIComponent(db)}`);
    Object.entries(data.tables || {}).forEach(([t, cols]) => { schemaColumns[`${db}.${t}`] = cols; });
  } catch (e) {
    columnsLoaded.delete(db); // 允许下次重试
  }
}

function resetSchemaCache() {
  schemaDbs = [];
  columnsLoaded.clear();
  Object.keys(schemaTables).forEach(k => delete schemaTables[k]);
  Object.keys(schemaColumns).forEach(k => delete schemaColumns[k]);
}

async function previewTable(db, table) {
  selectedTable = table;
  document.querySelectorAll("#tableList .exp-item").forEach(el =>
    el.classList.toggle("active", el.dataset.table === table));
  $("expBreadcrumb").textContent = `${db} › ${table}`;
  const limit = parseInt($("previewLimit").value, 10) || 50;
  $("resultArea").innerHTML = `<div class="result-block"><div class="dml-result">加载中…</div></div>`;
  try {
    const data = await api(`/api/table/data?path=${encodeURIComponent(selectedFile)}&db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}&limit=${limit}`);
    renderResults([{
      type: "select",
      exportable: true,
      columns: data.columns,
      rows: data.rows,
      row_count: data.rows.length,
      truncated: data.truncated,
      elapsed_ms: null,
      sql: `SELECT * FROM ${db}.${table} LIMIT ${limit}`,
    }], null);
    setSqlInputValue(`SELECT * FROM ${db}.${table} LIMIT ${limit};`);
  } catch (e) {
    renderQueryError(e.message);
  }
}

async function showTableColumns(db, table) {
  selectedTable = table;
  document.querySelectorAll("#tableList .exp-item").forEach(el =>
    el.classList.toggle("active", el.dataset.table === table));
  $("expBreadcrumb").textContent = `${db} › ${table} › 结构`;
  try {
    const data = await api(`/api/table/columns?path=${encodeURIComponent(selectedFile)}&db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`);
    renderResults([{
      type: "select",
      columns: data.columns,
      rows: data.rows,
      row_count: data.rows.length,
      truncated: false,
      elapsed_ms: null,
      sql: `表结构：${db}.${table}`,
    }], null);
  } catch (e) {
    renderQueryError(e.message);
  }
}

$("dbList").addEventListener("click", (e) => {
  const item = e.target.closest(".exp-item");
  if (item) loadTables(item.dataset.db);
});

$("tableList").addEventListener("click", (e) => {
  const item = e.target.closest(".exp-item");
  if (!item) return;
  const table = item.dataset.table;
  if (e.target.closest('[data-act="struct"]')) {
    showTableColumns(selectedDb, table);
  } else {
    previewTable(selectedDb, table);
  }
});

$("refreshDbBtn").addEventListener("click", () => {
  if (!connected) { toast("请先连接数据库", "error"); return; }
  if (selectedDb) loadTables(selectedDb); else loadDatabases();
});

/* 导出：结果区按钮（按 SQL 导出）与对象浏览器按钮（整表导出） */
$("resultArea").addEventListener("click", (e) => {
  const btn = e.target.closest(".exp-export");
  if (!btn) return;
  if (!connected) { toast("请先连接数据库", "error"); return; }
  const qs = new URLSearchParams({ path: selectedFile, sql: btn.dataset.exportSql });
  if (selectedDb) qs.set("db", selectedDb);
  toast("正在导出 CSV…");
  window.location.href = "/api/export?" + qs.toString();
});

function updateExportBtn() {
  $("exportTableBtn").disabled = !selectedTable;
}

const _previewTable = previewTable;
previewTable = function (db, table) { updateExportBtn(); return _previewTable(db, table); };
const _showTableColumns = showTableColumns;
showTableColumns = function (db, table) { updateExportBtn(); return _showTableColumns(db, table); };
const _loadTables = loadTables;
loadTables = function (db) { updateExportBtn(); return _loadTables(db); };

$("exportTableBtn").addEventListener("click", () => {
  if (!connected || !selectedDb || !selectedTable) { toast("请先在对象浏览器中选择表", "error"); return; }
  const qs = new URLSearchParams({ path: selectedFile, db: selectedDb, table: selectedTable });
  toast("正在导出整表 CSV…（数据量大时请耐心等待）");
  window.location.href = "/api/export?" + qs.toString();
});

/* ---------------- 选择文件 & 连接 ---------------- */
async function selectFile(path, name) {
  selectedFile = path;
  connected = false;
  resetExplorer();
  resetSchemaCache();
  updateConnUI("disconnected");
  document.querySelectorAll(".file-item").forEach(el => {
    el.classList.toggle("active", el.dataset.path === path);
  });
  $("emptyState").classList.add("hidden");
  $("workArea").classList.remove("hidden");
  $("connFile").textContent = name;
  $("connFile").title = path;
  $("connParams").innerHTML = `<span>解析中…</span>`;
  hideError();

  try {
    const data = await api(`/api/file/content?path=${encodeURIComponent(path)}`);
    renderParams(data.params);
    await doConnect(); // 默认自动连接
  } catch (e) {
    renderParams(null);
    showError(e.message);
  }
}

function renderParams(params) {
  const el = $("connParams");
  if (!params) { el.innerHTML = ""; return; }
  const items = [
    ["host", params.host],
    ["port", params.port],
    ["user", params.user],
    ["password", params.password ? "••••••" : "(空)"],
    ["database", params.database || "(未指定)"],
    ["charset", params.charset || "utf8mb4"],
  ];
  el.innerHTML = items.map(([k, v]) => `<span>${k}: <b>${escapeHtml(String(v))}</b></span>`).join("");
}

async function doConnect() {
  if (!selectedFile) return;
  updateConnUI("connecting");
  hideError();
  $("connectBtn").disabled = true;
  try {
    const data = await api("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: selectedFile }),
    });
    connected = true;
    updateConnUI("connected");
    const s = data.server || {};
    const extra = [];
    if (s.version) extra.push(`版本 ${s.version}`);
    if (s.db) extra.push(`库 ${s.db}`);
    toast(`连接成功${extra.length ? "（" + extra.join(" · ") + "）" : ""}`, "success");
    showExplorer();
  } catch (e) {
    connected = false;
    updateConnUI("disconnected");
    showError(e.message);
    toast("连接失败", "error");
  } finally {
    $("connectBtn").disabled = false;
  }
}

$("connectBtn").addEventListener("click", doConnect);

$("disconnectBtn").addEventListener("click", async () => {
  if (!selectedFile) return;
  try {
    await api("/api/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: selectedFile }),
    });
  } catch (e) { /* ignore */ }
  connected = false;
  resetExplorer();
  updateConnUI("disconnected");
  toast("已断开连接");
});

function updateConnUI(state) {
  const badge = $("connStatus");
  const map = {
    connected: ["connected", "已连接"],
    connecting: ["connecting", "连接中…"],
    disconnected: ["disconnected", "未连接"],
  };
  const [cls, text] = map[state];
  badge.className = `status-badge ${cls}`;
  badge.textContent = text;
  $("connectBtn").classList.toggle("hidden", state === "connected");
  $("disconnectBtn").classList.toggle("hidden", state !== "connected");
  $("runBtn").disabled = state !== "connected";
}

function showError(msg) {
  const el = $("connError");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function hideError() { $("connError").classList.add("hidden"); }

/* ---------------- 快捷命令 ---------------- */
const PRESET_QUERIES = [
  ["查看所有数据库", "SHOW DATABASES;"],
  ["当前连接信息", "SELECT VERSION() AS 版本, DATABASE() AS 当前库, USER() AS 登录用户, @@hostname AS 主机名;"],
  ["查看当前库所有表", "SHOW TABLES;"],
  ["各库表数量统计", "SELECT table_schema AS 数据库, COUNT(*) AS 表数量 FROM information_schema.tables GROUP BY table_schema ORDER BY 表数量 DESC;"],
  ["当前连接线程", "SHOW PROCESSLIST;"],
  ["字符集配置", "SHOW VARIABLES LIKE 'character%';"],
];

function renderPresets() {
  $("sqlPresets").innerHTML = PRESET_QUERIES.map(([label, sql], i) =>
    `<button class="preset-chip" data-idx="${i}" title="${escapeHtml(sql)}">${escapeHtml(label)}</button>`).join("");
}

$("sqlPresets").addEventListener("click", (e) => {
  const chip = e.target.closest(".preset-chip");
  if (!chip) return;
  if (!connected) { toast("请先连接数据库", "error"); return; }
  const [, sql] = PRESET_QUERIES[parseInt(chip.dataset.idx, 10)];
  setSqlInputValue(sql);
  runSQL();
});

/* ---------------- SQL 语法高亮 ---------------- */
const SQL_KEYWORDS = new Set(`SELECT FROM WHERE AND OR NOT NULL IS IN LIKE RLIKE REGEXP BETWEEN EXISTS
  ORDER BY GROUP HAVING LIMIT OFFSET UNION ALL DISTINCT AS JOIN INNER LEFT RIGHT OUTER CROSS NATURAL ON USING
  INSERT INTO VALUES UPDATE SET DELETE REPLACE CREATE ALTER DROP TRUNCATE RENAME TABLE TABLES VIEW INDEX KEY
  DATABASE SCHEMA PRIMARY FOREIGN REFERENCES CONSTRAINT UNIQUE DEFAULT AUTO_INCREMENT COMMENT ENGINE CHARSET
  CHARACTER COLLATE IF CASE WHEN THEN ELSE END ASC DESC USE SHOW STATUS VARIABLES PROCESSLIST DESCRIBE EXPLAIN
  WITH RECURSIVE DUPLICATE IGNORE FOR LOCK UNLOCK SHARE MODE GRANT REVOKE COMMIT ROLLBACK SAVEPOINT BEGIN START
  TRANSACTION PROCEDURE FUNCTION TRIGGER EVENT AFTER BEFORE EACH ROW DECLARE CURSOR LOOP WHILE REPEAT LEAVE
  ITERATE CALL RETURN RETURNS DETERMINISTIC PARTITION RANGE LIST HASH INT INTEGER BIGINT SMALLINT TINYINT
  MEDIUMINT DECIMAL NUMERIC FLOAT DOUBLE REAL CHAR VARCHAR TEXT BLOB DATE DATETIME TIMESTAMP TIME ENUM BOOL
  BOOLEAN JSON UNSIGNED ZEROFILL INTERVAL OVER ANY SOME WITHIN CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP
  AUTO_INCREMENT SQL_CALC_FOUND_ROWS IGNORE UNLOCK`.split(/\s+/).filter(Boolean));

const SQL_FUNCTIONS = new Set(`COUNT SUM AVG MIN MAX ABS CEIL CEILING FLOOR ROUND RAND MOD POW POWER SQRT
  CONCAT CONCAT_WS LENGTH CHAR_LENGTH SUBSTRING SUBSTR MID LEFT RIGHT TRIM LTRIM RTRIM UPPER LOWER LCASE UCASE
  REPLACE INSTR LOCATE LPAD RPAD REVERSE REPEAT SPACE FORMAT DATE_FORMAT STR_TO_DATE DATEDIFF TIMEDIFF
  TIMESTAMPDIFF DATE_ADD DATE_SUB ADDDATE SUBDATE NOW SYSDATE CURDATE CURTIME UNIX_TIMESTAMP FROM_UNIXTIME YEAR
  MONTH DAY DAYOFWEEK DAYOFMONTH DAYOFYEAR HOUR MINUTE SECOND WEEK QUARTER LAST_DAY EXTRACT MONTHNAME DAYNAME
  IFNULL NULLIF COALESCE IF ISNULL CAST CONVERT GROUP_CONCAT JSON_EXTRACT JSON_UNQUOTE JSON_ARRAY JSON_OBJECT
  JSON_LENGTH MD5 SHA1 SHA2 UUID VERSION DATABASE USER CURRENT_USER CONNECTION_ID FOUND_ROWS ROW_COUNT
  LAST_INSERT_ID ROW_NUMBER RANK DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE NTILE REGEXP_REPLACE REGEXP_SUBSTR
  BIN HEX UNHEX ASCII ORD`.split(/\s+/).filter(Boolean));

const SQL_TOKEN_RE = /(--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|\\[\s\S]|[^'\\])*'|"(?:""|\\[\s\S]|[^"\\])*"|`(?:``|[^`])*`)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$\u4e00-\u9fa5][A-Za-z0-9_$\u4e00-\u9fa5]*)|([(),.;*+\-<>!=|/%&~^?:]+)/g;

function highlightSql(sql) {
  const out = [];
  let last = 0, m;
  SQL_TOKEN_RE.lastIndex = 0;
  while ((m = SQL_TOKEN_RE.exec(sql)) !== null) {
    if (m.index > last) out.push(escapeHtml(sql.slice(last, m.index)));
    const [, cmt, str, num, word, op] = m;
    if (cmt) out.push(`<span class="t-cmt">${escapeHtml(cmt)}</span>`);
    else if (str) out.push(`<span class="t-str">${escapeHtml(str)}</span>`);
    else if (num) out.push(`<span class="t-num">${escapeHtml(num)}</span>`);
    else if (word) {
      const up = word.toUpperCase();
      if (SQL_KEYWORDS.has(up)) out.push(`<span class="t-kw">${escapeHtml(word)}</span>`);
      else if (SQL_FUNCTIONS.has(up)) out.push(`<span class="t-fn">${escapeHtml(word)}</span>`);
      else out.push(escapeHtml(word));
    } else if (op) out.push(`<span class="t-op">${escapeHtml(op)}</span>`);
    last = m.index + m[0].length;
  }
  if (last < sql.length) out.push(escapeHtml(sql.slice(last)));
  return out.join("");
}

function updateHighlight() {
  const ta = $("sqlInput");
  const hl = $("sqlHighlight");
  // 超长内容跳过高亮，避免输入卡顿
  const html = ta.value.length > 50000 ? escapeHtml(ta.value) : highlightSql(ta.value);
  hl.innerHTML = html + "\n";
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
}

function setSqlInputValue(v) {
  $("sqlInput").value = v;
  updateHighlight();
  updateSuggest();
}

/* ---------------- SQL 语法联想 ---------------- */
const SUGGEST_LIMIT = 12;
const KIND_TEXT = { kw: "关键字", fn: "函数", db: "库", table: "表", col: "字段" };

let acOpen = false, acItems = [], acIndex = 0, acWordStart = 0;

function suggestionList(prefix, qualifier) {
  const res = [];
  const seen = new Set();
  const lower = prefix.toLowerCase();
  const add = (label, kind) => {
    if (!label) return;
    if (prefix && !label.toLowerCase().startsWith(lower)) return;
    const k = label.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    res.push({ label, kind });
  };
  const addAll = (arr, kind) => (arr || []).forEach(v => add(v, kind));

  /* 带限定符：`db.` / `table.` / `db.table.` */
  if (qualifier) {
    const parts = qualifier.split(".");
    if (parts.length >= 2) {
      addAll(schemaColumns[parts.slice(-2).join(".")], "col");
      if (!res.length) { // 跨库同名表
        const t = parts[parts.length - 1];
        Object.keys(schemaColumns).forEach(k => {
          if (k.split(".")[1] === t) addAll(schemaColumns[k], "col");
        });
      }
      return res.slice(0, SUGGEST_LIMIT);
    }
    if (schemaTables[qualifier]) { addAll(schemaTables[qualifier], "table"); return res.slice(0, SUGGEST_LIMIT); }
    if (selectedDb && schemaColumns[selectedDb + "." + qualifier]) {
      addAll(schemaColumns[selectedDb + "." + qualifier], "col");
      return res.slice(0, SUGGEST_LIMIT);
    }
  }

  /* 无限定符：字段 → 表 → 库 → 关键字 → 函数 */
  if (selectedDb && selectedTable) addAll(schemaColumns[selectedDb + "." + selectedTable], "col");
  if (selectedDb) addAll(schemaTables[selectedDb], "table");
  addAll(schemaDbs, "db");
  [...SQL_KEYWORDS].forEach(k => add(k, "kw"));
  [...SQL_FUNCTIONS].forEach(f => add(f, "fn"));
  return res.slice(0, SUGGEST_LIMIT);
}

/* 光标是否位于字符串 / 注释中 */
function inStringOrComment(sql, pos) {
  let quote = null, line = false, block = false;
  for (let i = 0; i < pos; i++) {
    const c = sql[i], n = sql[i + 1];
    if (line) { if (c === "\n") line = false; continue; }
    if (block) { if (c === "*" && n === "/") { block = false; i++; } continue; }
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) { if (n === quote) { i++; continue; } quote = null; }
      continue;
    }
    if (c === "-" && n === "-") { line = true; i++; continue; }
    if (c === "#") { line = true; continue; }
    if (c === "/" && n === "*") { block = true; i++; continue; }
    if (c === "'" || c === '"' || c === "`") quote = c;
  }
  return !!(quote || line || block);
}

/* 计算光标像素坐标（相对 .sql-editor） */
let _mirrorEl = null;
function getCaretPixel() {
  const ta = $("sqlInput");
  if (!_mirrorEl) {
    _mirrorEl = document.createElement("div");
    _mirrorEl.className = "sql-mirror";
    document.querySelector(".sql-editor").appendChild(_mirrorEl);
  }
  const cs = getComputedStyle(ta);
  ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textTransform",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "whiteSpace", "overflowWrap", "wordBreak",
    "tabSize", "boxSizing", "direction"].forEach(p => { _mirrorEl.style[p] = cs[p]; });
  _mirrorEl.style.width = ta.clientWidth + "px";
  _mirrorEl.style.borderStyle = "none";
  _mirrorEl.textContent = ta.value.slice(0, ta.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  _mirrorEl.appendChild(marker);
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.7;
  return { x: Math.max(0, marker.offsetLeft - ta.scrollLeft), y: marker.offsetTop + lh - ta.scrollTop, lineHeight: lh };
}

function renderSuggest() {
  const box = $("sqlSuggest");
  if (!acItems.length) return closeSuggest();
  box.innerHTML = acItems.map((it, i) =>
    `<div class="sql-suggest-item${i === acIndex ? " active" : ""}" data-i="${i}">
       <span class="ss-label">${escapeHtml(it.label)}</span>
       <span class="ss-kind k-${it.kind}">${KIND_TEXT[it.kind] || ""}</span>
     </div>`).join("");
  box.classList.remove("hidden");
  const editor = document.querySelector(".sql-editor");
  const { x, y, lineHeight } = getCaretPixel();
  box.style.left = Math.max(0, Math.min(x, editor.clientWidth - box.offsetWidth - 8)) + "px";
  // 下方空间不足时翻转到光标上方，避免被卡片裁切
  const above = y - lineHeight;
  if (editor.clientHeight - y < box.offsetHeight + 8 && above > box.offsetHeight + 8) {
    box.style.top = "auto";
    box.style.bottom = (editor.clientHeight - above) + "px";
  } else {
    box.style.bottom = "auto";
    box.style.top = y + "px";
  }
}

function closeSuggest() {
  acOpen = false;
  acItems = [];
  acIndex = 0;
  $("sqlSuggest").classList.add("hidden");
  $("sqlSuggest").innerHTML = "";
}

function updateSuggest(force) {
  const ta = $("sqlInput");
  if (ta.selectionStart !== ta.selectionEnd) return closeSuggest();
  const pos = ta.selectionStart;
  const word = (ta.value.slice(0, pos).match(/[A-Za-z0-9_$\u4e00-\u9fa5.]+$/) || [""])[0];
  const dot = word.lastIndexOf(".");
  const prefix = dot >= 0 ? word.slice(dot + 1) : word;
  const qualifier = dot >= 0 ? word.slice(0, dot) : "";
  if (!prefix && !qualifier && !force) return closeSuggest();
  if (inStringOrComment(ta.value, pos)) return closeSuggest();
  const items = suggestionList(prefix, qualifier);
  if (!items.length) return closeSuggest();
  acItems = items;
  acIndex = 0;
  acWordStart = pos - prefix.length;
  acOpen = true;
  renderSuggest();
}

function acceptSuggest() {
  if (!acOpen) return;
  const it = acItems[acIndex];
  if (!it) return;
  const ta = $("sqlInput");
  if (ta.selectionStart < acWordStart) return closeSuggest();
  const before = ta.value.slice(0, acWordStart);
  const caret = before.length + it.label.length;
  ta.value = before + it.label + ta.value.slice(ta.selectionStart);
  ta.selectionStart = ta.selectionEnd = caret;
  closeSuggest();
  updateHighlight();
  ta.focus();
}

$("sqlInput").addEventListener("input", () => { updateHighlight(); updateSuggest(); });
$("sqlInput").addEventListener("scroll", () => {
  $("sqlHighlight").scrollTop = $("sqlInput").scrollTop;
  $("sqlHighlight").scrollLeft = $("sqlInput").scrollLeft;
  if (acOpen) renderSuggest();
});
$("sqlInput").addEventListener("blur", closeSuggest);
$("sqlSuggest").addEventListener("mousedown", (e) => {
  const item = e.target.closest(".sql-suggest-item");
  if (!item) return;
  e.preventDefault(); // 阻止 textarea 失焦
  acIndex = parseInt(item.dataset.i, 10) || 0;
  acceptSuggest();
});

/* ---------------- SQL 执行 ---------------- */
$("runBtn").addEventListener("click", runSQL);

$("sqlInput").addEventListener("keydown", (e) => {
  if (acOpen) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      acIndex = (acIndex + (e.key === "ArrowDown" ? 1 : acItems.length - 1)) % acItems.length;
      renderSuggest();
      return;
    }
    if ((e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      acceptSuggest();
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); closeSuggest(); return; }
  }
  // 光标横向移动后，按新位置重新计算联想词
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { setTimeout(() => updateSuggest(), 0); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === " ") { e.preventDefault(); updateSuggest(true); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runSQL();
  }
  if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    const t = e.target, s = t.selectionStart, en = t.selectionEnd;
    t.value = t.value.slice(0, s) + "  " + t.value.slice(en);
    t.selectionStart = t.selectionEnd = s + 2;
    updateHighlight();
  }
});

async function runSQL() {
  if (!connected || !selectedFile) { toast("请先连接数据库", "error"); return; }
  const sql = $("sqlInput").value.trim();
  if (!sql) { toast("请输入 SQL 语句", "error"); return; }
  const maxRows = parseInt($("maxRows").value, 10);

  $("runBtn").disabled = true;
  $("runBtn").textContent = "执行中…";
  try {
    const data = await api("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: selectedFile, sql, max_rows: maxRows, db: selectedDb || undefined }),
    });
    data.results.forEach(r => { if (r.type === "select") r.exportable = true; });
    renderResults(data.results, data.total_elapsed_ms);
    toast(`执行完成，耗时 ${data.total_elapsed_ms}ms`, "success");
  } catch (e) {
    if (e.data && e.data.results && e.data.results.length) renderResults(e.data.results, null);
    renderQueryError(e.message);
    toast("SQL 执行出错", "error");
  } finally {
    $("runBtn").disabled = false;
    $("runBtn").textContent = "执行 (Ctrl+Enter)";
  }
}

function renderQueryError(msg) {
  const area = $("resultArea");
  const block = document.createElement("div");
  block.className = "result-block";
  block.innerHTML = `<div class="query-error">${escapeHtml(msg)}</div>`;
  area.appendChild(block);
}

function renderResults(results, totalMs) {
  const area = $("resultArea");
  area.innerHTML = "";
  if (!results || !results.length) return;

  results.forEach((r, i) => {
    const block = document.createElement("div");
    block.className = "result-block";

    if (r.type === "select") {
      const head = `
        <div class="result-head">
          <span class="tag ok">结果 ${i + 1}</span>
          <span>${r.row_count} 行${r.truncated ? "（已截断，超出最大返回行数）" : ""}</span>
          ${r.elapsed_ms != null ? `<span>${r.elapsed_ms}ms</span>` : ""}
          <span class="sql-preview" title="${escapeHtml(r.sql)}">${escapeHtml(r.sql)}</span>
          ${r.exportable ? `<button class="exp-export" data-export-sql="${escapeHtml(r.sql)}">导出 CSV</button>` : ""}
        </div>`;
      let tableHtml = "";
      if (r.rows.length) {
        tableHtml = `<div class="table-wrap"><table>
          <thead><tr>${r.columns.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
          <tbody>${r.rows.map(row => `<tr>${row.map(v =>
            `<td${v === null ? ' class="null"' : ""}>${v === null ? "NULL" : escapeHtml(v)}</td>`).join("")}</tr>`).join("")}
          </tbody></table></div>`;
      } else {
        tableHtml = `<div class="dml-result">查询结果为空（0 行）</div>`;
      }
      block.innerHTML = head + tableHtml;
    } else {
      block.innerHTML = `
        <div class="result-head">
          <span class="tag ok">语句 ${i + 1}</span>
          <span>${r.elapsed_ms}ms</span>
          <span class="sql-preview" title="${escapeHtml(r.sql)}">${escapeHtml(r.sql)}</span>
        </div>
        <div class="dml-result">执行成功，影响 <b>${r.affected}</b> 行（已自动提交）</div>`;
    }
    area.appendChild(block);
  });
}

/* ---------------- 初始化 ---------------- */
loadConfig();
loadFiles();
renderPresets();
updateHighlight();
