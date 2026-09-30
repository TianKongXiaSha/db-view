#!/usr/bin/env node
/* db-view 服务端（Node 零依赖）：扫描目录内连接文件，调用本机 mysql 客户端执行 SQL */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const BASE_DIR = __dirname;

/* ---------- 访问密钥校验 ----------
 * 密钥每次服务启动时随机生成并打印到控制台；
 * 校验通过后向浏览器签发随机会话 token（仅存内存）。
 * 服务重启 => token 全部失效 => 客户端需用新密钥重新校验；
 * token 存于浏览器 localStorage => 换浏览器/换电脑需重新校验。 */
const ACCESS_KEY = crypto.randomBytes(8).toString("hex").toUpperCase();
const AUTH_TOKENS = new Set();

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || "")), bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function checkAuth(req, url) {
  const h = req.headers["x-auth-token"];
  const token = (typeof h === "string" && h) || url.searchParams.get("token") || "";
  return !!(token && AUTH_TOKENS.has(token));
}

function loadConfig() {
  const cfg = {};
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(BASE_DIR, "config.json"), "utf8"))); }
  catch (e) { console.warn("[warn] 读取 config.json 失败:", e.message); }
  cfg.scripts_dir = process.env.SCRIPTS_DIR || cfg.scripts_dir || "";
  cfg.server = Object.assign({ host: "0.0.0.0", port: 5001 }, cfg.server || {});
  return cfg;
}
const CONFIG = loadConfig();
const SCRIPTS_DIR = CONFIG.scripts_dir;

/* ---------- mysql 命令解析 ---------- */
class ParseError extends Error {}

function tokenize(line) {
  const tokens = [];
  let cur = "", has = false, quote = null, i = 0;
  while (i < line.length) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote !== "'") { cur += c + (line[i + 1] || ""); i += 2; continue; }
      if (c === quote) { quote = null; i++; continue; }
      cur += c; i++; continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; i++; continue; }
    if (/\s/.test(c)) { if (has) { tokens.push(cur); cur = ""; has = false; } i++; continue; }
    cur += c; has = true; i++;
  }
  if (has) tokens.push(cur);
  return tokens;
}

const VALUE_FLAGS = new Set(["-h", "-P", "-u", "-p", "-D", "-S", "-e", "--host", "--port", "--user", "--password", "--database", "--socket", "--default-character-set", "--connect-timeout", "--execute"]);
const LONG_MAP = { "--host": "host", "--port": "port", "--user": "user", "--password": "password", "--database": "database", "--default-character-set": "charset", "--connect-timeout": "connect_timeout" };
const SHORT_MAP = { "-h": "host", "-P": "port", "-u": "user", "-p": "password", "-D": "database" };

function parseMysqlCommand(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (!lines.length) throw new ParseError("文件为空或没有有效内容");
  let tokens = null;
  for (const line of lines) {
    const t = tokenize(line);
    if (t.length && t[0].split(/[/\\]/).pop().toLowerCase().startsWith("mysql")) { tokens = t; break; }
  }
  if (!tokens) {
    const joined = lines.join(" ");
    const m = joined.match(/mysql\s/i);
    if (!m) throw new ParseError("未在文件中找到 mysql 连接命令");
    tokens = tokenize(joined.slice(m.index));
  }
  const rest = tokens.slice(1);
  const params = { bin: tokens[0], host: "127.0.0.1", port: 3306, user: "root", password: "", database: null, charset: "utf8mb4" };
  let expecting = null;
  const positional = [];
  for (const tok of rest) {
    if (expecting) {
      if (expecting === "port" || expecting === "connect_timeout") params[expecting] = parseInt(tok, 10) || params[expecting];
      else if (expecting === "charset") params.charset = tok;
      else params[expecting] = tok;
      expecting = null;
      continue;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq > 0) {
        const key = tok.slice(0, eq).toLowerCase(), val = tok.slice(eq + 1);
        if (LONG_MAP[key]) params[LONG_MAP[key]] = key === "--port" ? (parseInt(val, 10) || 3306) : val;
      } else if (LONG_MAP[tok.toLowerCase()]) expecting = LONG_MAP[tok.toLowerCase()];
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      const flag = tok.slice(0, 2);
      if (flag === "--") continue;
      if (VALUE_FLAGS.has(flag)) {
        if (tok.length > 2) {
          const val = tok.slice(2);
          if (flag === "-P") params.port = parseInt(val, 10) || 3306;
          else if (SHORT_MAP[flag]) params[SHORT_MAP[flag]] = val;
        } else expecting = SHORT_MAP[flag] || null;
      }
      continue;
    }
    positional.push(tok);
  }
  if (expecting) throw new ParseError("mysql 命令解析不完整：缺少参数值");
  if (params.database === null && positional.length) params.database = positional[0];
  if (!params.host || !params.user) throw new ParseError("mysql 命令中缺少主机或用户名");
  return params;
}

/* ---------- mysql 执行 ---------- */
function quoteStr(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function quoteIdent(s) {
  if (!/^[A-Za-z0-9_$\u4e00-\u9fa5-]+$/.test(String(s))) throw new Error("非法标识符: " + s);
  return "`" + s + "`";
}

/* mysql 客户端路径解析：配置/环境变量 > 常见安装位置 > PATH */
let RESOLVED_MYSQL_BIN = null;
function resolveMysqlBin(params) {
  if (params.bin && params.bin !== "mysql" && fs.existsSync(params.bin)) return params.bin;
  if (RESOLVED_MYSQL_BIN) return RESOLVED_MYSQL_BIN;
  const candidates = [];
  if (process.env.MYSQL_BIN) candidates.push(process.env.MYSQL_BIN);
  if (CONFIG.mysql_bin) candidates.push(CONFIG.mysql_bin);
  candidates.push(
    "/opt/homebrew/opt/mysql-client/bin/mysql",
    "/opt/homebrew/bin/mysql",
    "/usr/local/opt/mysql-client/bin/mysql",
    "/usr/local/bin/mysql",
    "/usr/local/mysql/bin/mysql",
    "/usr/bin/mysql"
  );
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); RESOLVED_MYSQL_BIN = c; return c; } catch (e) { /* next */ }
  }
  try {
    const which = require("child_process").execFileSync("which", ["mysql"], { encoding: "utf8" }).trim();
    if (which) { RESOLVED_MYSQL_BIN = which; return which; }
  } catch (e) { /* ignore */ }
  return "mysql";
}

function runMysql(params, sql, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ["-h", params.host, "-P", String(params.port), "-u", params.user];
    if (params.database) args.push("-D", params.database);
    args.push("--default-character-set", params.charset || "utf8mb4", "--batch");
    if (sql) args.push("-e", sql);
    const env = Object.assign({}, process.env);
    if (params.password) env.MYSQL_PWD = params.password;
    execFile(resolveMysqlBin(params), args, {
      timeout: timeoutMs || 60000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024, env,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr && String(stderr).trim()) || err.message;
        return reject(new Error(msg.replace(/^ERROR \d+( \(HY000\))?: /, "")));
      }
      resolve(String(stdout));
    });
  });
}

function unescapeCell(s) {
  return s.replace(/\\(.)/g, (m, c) => c === "t" ? "\t" : c === "n" ? "\n" : c === "0" ? "" : c);
}
function parseTsv(out) {
  const lines = out.split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return { columns: [], rows: [] };
  const columns = lines[0].split("\t").map(unescapeCell);
  const rows = lines.slice(1).map(l => l.split("\t").map(c => c === "NULL" ? null : unescapeCell(c)));
  return { columns, rows };
}

function splitSqlStatements(sql) {
  const stmts = [];
  let buf = "", inS = false, inDq = false, inBt = false;
  const n = sql.length;
  for (let i = 0; i < n; i++) {
    const c = sql[i], nxt = sql[i + 1] || "";
    if (!inDq && !inBt && c === "'") {
      if (inS && nxt === "'") { buf += "''"; i++; continue; }
      inS = !inS; buf += c; continue;
    }
    if (!inS && !inBt && c === '"') {
      if (inDq && nxt === '"') { buf += '""'; i++; continue; }
      inDq = !inDq; buf += c; continue;
    }
    if (!inS && !inDq && c === "`") { inBt = !inBt; buf += c; continue; }
    if (!inS && !inDq && !inBt) {
      if (c === "-" && nxt === "-") { const j = sql.indexOf("\n", i); if (j === -1) break; buf += sql.slice(i, j + 1); i = j; continue; }
      if (c === "#") { const j = sql.indexOf("\n", i); if (j === -1) break; buf += sql.slice(i, j + 1); i = j; continue; }
      if (c === "/" && nxt === "*") { const j = sql.indexOf("*/", i + 2); const end = j === -1 ? n : j + 2; buf += sql.slice(i, end); i = end - 1; continue; }
      if (c === ";") { stmts.push(buf.trim()); buf = ""; continue; }
    }
    buf += c;
  }
  if (buf.trim()) stmts.push(buf.trim());
  return stmts.filter(s => s);
}
const READ_RE = /^(select|show|desc|describe|explain|with|table|values|analyze|checksum|help)\b/i;

/* ---------- 文件 ---------- */
function safeRel(rel) {
  if (!rel || rel.includes("..") || rel.startsWith("/") || rel.includes("\0")) return null;
  return rel;
}
function getParamsFor(rel) {
  const r = safeRel(rel);
  if (!r) throw new Error("非法文件路径");
  const full = path.join(SCRIPTS_DIR, r);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error("文件不存在");
  return parseMysqlCommand(fs.readFileSync(full, "utf8"));
}
function listFiles() {
  if (!SCRIPTS_DIR || !fs.existsSync(SCRIPTS_DIR)) return [];
  const files = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile()) continue;
      files.push({ name: ent.name, rel_path: path.relative(SCRIPTS_DIR, full), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
    }
  })(SCRIPTS_DIR);
  files.sort((a, b) => a.rel_path.toLowerCase() < b.rel_path.toLowerCase() ? -1 : 1);
  return files;
}

/* ---------- HTTP ---------- */
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 5 * 1024 * 1024) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error("请求体不是合法 JSON")); } });
    req.on("error", reject);
  });
}
function maskParams(p) {
  const m = Object.assign({}, p);
  if (m.password) m.password = "******";
  return m;
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function serveStatic(res, urlPath) {
  let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  if (rel.startsWith("static/")) rel = rel.slice(7);
  const staticRoot = path.join(BASE_DIR, "static");
  const full = path.join(staticRoot, rel);
  if (!full.startsWith(staticRoot) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404); res.end("Not Found"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (!p.startsWith("/api/")) return serveStatic(res, p);

    /* ---- 访问密钥校验 ---- */
    if (p === "/api/auth/status")
      return sendJson(res, checkAuth(req, url) ? 200 : 401, { authed: checkAuth(req, url) });

    if (p === "/api/auth/verify" && req.method === "POST") {
      const body = await readBody(req);
      if (!safeEqual((body.key || "").trim(), ACCESS_KEY))
        return sendJson(res, 401, { error: "密钥错误，请检查服务启动时打印的访问密钥" });
      const token = crypto.randomBytes(24).toString("hex");
      AUTH_TOKENS.add(token);
      return sendJson(res, 200, { token });
    }

    /* 其余接口均需已校验的会话 token */
    if (!checkAuth(req, url))
      return sendJson(res, 401, { error: "未校验或会话已失效（服务可能已重启），请重新输入访问密钥" });

    if (p === "/api/config")
      return sendJson(res, 200, { scripts_dir: SCRIPTS_DIR, valid_dir: !!(SCRIPTS_DIR && fs.existsSync(SCRIPTS_DIR)) });

    if (p === "/api/files") {
      const kw = (url.searchParams.get("keyword") || "").trim().toLowerCase();
      const all = listFiles();
      const matched = kw ? all.filter(f => f.name.toLowerCase().includes(kw) || f.rel_path.toLowerCase().includes(kw)) : all;
      return sendJson(res, 200, { total: all.length, matched: matched.length, files: matched.slice(0, 500) });
    }

    if (p === "/api/file/content") {
      const rel = safeRel(url.searchParams.get("path") || "");
      if (!rel) return sendJson(res, 400, { error: "非法文件路径" });
      const full = path.join(SCRIPTS_DIR, rel);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendJson(res, 404, { error: "文件不存在" });
      const text = fs.readFileSync(full, "utf8");
      try { return sendJson(res, 200, { params: maskParams(parseMysqlCommand(text)), raw: text }); }
      catch (e) { return sendJson(res, 422, { error: "解析失败: " + e.message, raw: text }); }
    }

    if (p === "/api/connect" && req.method === "POST") {
      const body = await readBody(req);
      let params;
      try { params = getParamsFor(body.path || ""); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
      try {
        const out = await runMysql(params, "SELECT VERSION() AS v, DATABASE() AS db, @@hostname AS hn", 8000);
        const row = parseTsv(out).rows[0] || [];
        return sendJson(res, 200, { message: "连接成功", params: maskParams(params), server: { version: row[0] || null, db: row[1] || null, hostname: row[2] || null } });
      } catch (e) { return sendJson(res, 502, { error: "连接失败: " + e.message }); }
    }

    if (p === "/api/disconnect" && req.method === "POST") return sendJson(res, 200, { message: "已断开" });

    if (p === "/api/databases") {
      try {
        const params = getParamsFor(url.searchParams.get("path") || "");
        const out = await runMysql(params, "SHOW DATABASES", 15000);
        const sys = new Set(["information_schema", "performance_schema", "mysql", "sys"]);
        const dbs = parseTsv(out).rows.map(r => r[0]).filter(Boolean);
        return sendJson(res, 200, { databases: [...dbs.filter(d => !sys.has(d)), ...dbs.filter(d => sys.has(d))] });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    if (p === "/api/tables") {
      try {
        const params = getParamsFor(url.searchParams.get("path") || "");
        const db = url.searchParams.get("db") || "";
        quoteIdent(db);
        const out = await runMysql(params,
          "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = " + quoteStr(db) + " ORDER BY TABLE_NAME", 15000);
        return sendJson(res, 200, { tables: parseTsv(out).rows.map(r => ({ name: r[0], type: r[1] || "", row_est: r[2] || "", comment: r[3] || "" })) });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    if (p === "/api/table/columns") {
      try {
        const params = getParamsFor(url.searchParams.get("path") || "");
        const db = url.searchParams.get("db") || "", table = url.searchParams.get("table") || "";
        quoteIdent(db); quoteIdent(table);
        const out = await runMysql(params,
          "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = " + quoteStr(db) + " AND TABLE_NAME = " + quoteStr(table) + " ORDER BY ORDINAL_POSITION", 15000);
        const t = parseTsv(out);
        return sendJson(res, 200, { columns: ["字段", "类型", "可空", "键", "注释"], rows: t.rows });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    /* 库内全部表的字段名（供前端 SQL 联想） */
    if (p === "/api/table/columns/all") {
      try {
        const params = getParamsFor(url.searchParams.get("path") || "");
        const db = url.searchParams.get("db") || "";
        quoteIdent(db);
        const out = await runMysql(params,
          "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = " + quoteStr(db) + " ORDER BY TABLE_NAME, ORDINAL_POSITION", 20000);
        const tables = {};
        for (const r of parseTsv(out).rows) {
          if (!r[0]) continue;
          (tables[r[0]] = tables[r[0]] || []).push(r[1]);
        }
        return sendJson(res, 200, { tables });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    if (p === "/api/table/data") {
      try {
        const params = getParamsFor(url.searchParams.get("path") || "");
        const db = url.searchParams.get("db") || "", table = url.searchParams.get("table") || "";
        const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit"), 10) || 50, 1000));
        const out = await runMysql(params, "SELECT * FROM " + quoteIdent(db) + "." + quoteIdent(table) + " LIMIT " + limit, 30000);
        const t = parseTsv(out);
        return sendJson(res, 200, { columns: t.columns, rows: t.rows.slice(0, 200), truncated: t.rows.length > 200 });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    /* ---- 数据导出（CSV） ---- */
    if (p === "/api/export") {
      let params;
      try { params = getParamsFor(url.searchParams.get("path") || ""); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
      const db = url.searchParams.get("db") || "";
      if (db) {
        try { params.database = String(quoteIdent(db)).slice(1, -1); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
      }

      const table = url.searchParams.get("table") || "";
      let sql, baseName;
      if (table) {
        try { quoteIdent(db); quoteIdent(table); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
        sql = "SELECT * FROM " + quoteIdent(db) + "." + quoteIdent(table);
        const limit = url.searchParams.get("limit");
        if (limit) sql += " LIMIT " + Math.max(1, Math.min(parseInt(limit, 10) || 1000, 1000000));
        baseName = (db ? db + "_" : "") + table;
      } else {
        sql = (url.searchParams.get("sql") || "").trim();
        if (!sql) return sendJson(res, 400, { error: "缺少导出内容" });
        if (!READ_RE.test(sql)) return sendJson(res, 400, { error: "仅支持导出查询语句（SELECT/SHOW 等）" });
        const stmts = splitSqlStatements(sql);
        if (stmts.length !== 1) return sendJson(res, 400, { error: "导出仅支持单条查询语句" });
        baseName = "query_result";
      }

      let out;
      try { out = await runMysql(params, sql, 300000); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }

      const t = parseTsv(out);
      const csvEscape = v => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [t.columns.map(csvEscape).join(",")];
      for (const row of t.rows) lines.push(row.map(csvEscape).join(","));
      const csv = lines.join("\r\n") + "\r\n";

      const fname = baseName + "_" + new Date().toISOString().slice(0, 10) + ".csv";
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
      });
      // BOM：保证 Excel 直接打开中文不乱码
      return res.end(Buffer.from("\uFEFF" + csv, "utf8"));
    }

    if (p === "/api/query" && req.method === "POST") {
      const body = await readBody(req);
      const sql = (body.sql || "").trim();
      const maxRows = Math.max(1, Math.min(parseInt(body.max_rows, 10) || 500, 5000));
      let params;
      try { params = getParamsFor(body.path || ""); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
      if (body.db) {
        try { params.database = String(quoteIdent(body.db)).slice(1, -1); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      if (!sql) return sendJson(res, 400, { error: "SQL 语句为空" });

      const results = [];
      const started = Date.now();
      for (const stmt of splitSqlStatements(sql)) {
        const t0 = Date.now();
        try {
          if (READ_RE.test(stmt)) {
            const t = parseTsv(await runMysql(params, stmt));
            results.push({ type: "select", columns: t.columns, rows: t.rows.slice(0, maxRows), row_count: Math.min(t.rows.length, maxRows), truncated: t.rows.length > maxRows, elapsed_ms: Date.now() - t0, sql: stmt });
          } else {
            const t = parseTsv(await runMysql(params, stmt + "; SELECT ROW_COUNT() AS affected_rows;"));
            results.push({ type: "dml", affected: t.rows.length ? (parseInt(t.rows[0][0], 10) || 0) : 0, elapsed_ms: Date.now() - t0, sql: stmt });
          }
        } catch (e) { return sendJson(res, 400, { error: "SQL 执行出错: " + e.message, results }); }
      }
      return sendJson(res, 200, { results, total_elapsed_ms: Date.now() - started });
    }

    return sendJson(res, 404, { error: "接口不存在" });
  } catch (e) {
    return sendJson(res, 500, { error: "服务器内部错误: " + e.message });
  }
});

if (require.main === module) {
  const resolved = resolveMysqlBin({ bin: "mysql" });
  console.log("[db-view] mysql 客户端:", resolved === "mysql" ? "未找到! (PATH 与常见路径均无，请安装或配置 mysql_bin)" : resolved);
  server.listen(CONFIG.server.port, CONFIG.server.host, () => {
    console.log("[db-view] 脚本目录:", SCRIPTS_DIR || "(未配置!)");
    console.log("[db-view] 服务启动: http://" + CONFIG.server.host + ":" + CONFIG.server.port);
    console.log("[db-view] Node 版本:", process.version);
    console.log("[db-view] ============================================================");
    console.log("[db-view] 本次启动的访问密钥: " + ACCESS_KEY);
    console.log("[db-view] 浏览器首次打开页面需输入该密钥校验；服务重启后密钥与会话均会更新，需重新校验。");
    console.log("[db-view] ============================================================");
  });
} else {
  module.exports = { parseMysqlCommand, splitSqlStatements, parseTsv, listFiles };
}
