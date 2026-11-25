const __IMETA_URL__ = require("url").pathToFileURL(__filename).href;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key3 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key3) && key3 !== except)
        __defProp(to, key3, { get: () => from[key3], enumerable: !(desc = __getOwnPropDesc(from, key3)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/@deepseek-ai/dsh-tools/index.js
var require_dsh_tools = __commonJS({
  "node_modules/@deepseek-ai/dsh-tools/index.js"(exports, module2) {
    function defineTool15(def) {
      return def;
    }
    module2.exports = { defineTool: defineTool15 };
  }
});

// src/_fsp.js
var require_fsp = __commonJS({
  "src/_fsp.js"(exports, module2) {
    var fs = require("fs");
    var p = fs.promises;
    module2.exports = {
      readFile: p.readFile.bind(p),
      writeFile: p.writeFile.bind(p),
      access: p.access.bind(p),
      mkdir: p.mkdir.bind(p),
      readdir: p.readdir.bind(p),
      stat: p.stat.bind(p),
      lstat: p.lstat.bind(p),
      unlink: p.unlink.bind(p),
      rm: p.rm ? p.rm.bind(p) : function(t, o) {
        return o && o.recursive ? p.rmdir(t, { recursive: true }) : p.unlink(t);
      },
      copyFile: p.copyFile.bind(p),
      rename: p.rename.bind(p),
      appendFile: p.appendFile.bind(p),
      realpath: p.realpath.bind(p)
    };
  }
});

// src/entry.js
var entry_exports = {};
__export(entry_exports, {
  collectTools: () => collectTools,
  referenceDomains: () => referenceDomains
});
module.exports = __toCommonJS(entry_exports);
var import_dsh_tools14 = __toESM(require_dsh_tools());
var import_node_path20 = require("path");
var import_node_fs13 = require("fs");

// src/seam.js
var import_node_fs2 = require("fs");
var import_promises = __toESM(require_fsp());
var import_node_child_process = require("child_process");
var import_node_url2 = require("url");

// src/sealed-refs.js
var import_node_fs = require("fs");
var import_node_path = require("path");
var import_node_url = require("url");

// src/crypt.js
var import_node_crypto = __toESM(require("crypto"));
var SECRET = "helm-d/profiles/v1::6f4d2a0c-9e17-4b8e-a3f2-c81d54e7b930";
var SALT = "helm-d/profiles/v1::salt-v1";
var cached;
function key() {
  if (cached === void 0)
    cached = import_node_crypto.default.scryptSync(SECRET, SALT, 32);
  return cached;
}
function unseal(sealed) {
  const [ivB64, tagB64, dataB64] = sealed.split(".");
  const decipher = import_node_crypto.default.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

// src/sealed-refs.js
var cache;
function packageRoot() {
  let dir = (0, import_node_path.dirname)((0, import_node_url.fileURLToPath)(__IMETA_URL__));
  for (let i = 0; i < 6; i++) {
    if ((0, import_node_fs.existsSync)((0, import_node_path.join)(dir, "package.json")))
      return dir;
    dir = (0, import_node_path.dirname)(dir);
  }
  return dir;
}
function bundlePath() {
  return (0, import_node_path.join)(packageRoot(), "references.dat");
}
function manifest() {
  if (cache !== void 0)
    return cache;
  const p = bundlePath();
  if (!(0, import_node_fs.existsSync)(p))
    return void 0;
  try {
    const parsed = JSON.parse(unseal((0, import_node_fs.readFileSync)(p, "utf8")));
    cache = new Map(Object.entries(parsed.files));
    return cache;
  } catch {
    return void 0;
  }
}
function readSealedByAbsPath(absPath) {
  var _a;
  const m = manifest();
  if (m === void 0)
    return void 0;
  const norm = absPath.replace(/\\/g, "/");
  const marker = "/references/";
  const idx = norm.lastIndexOf(marker);
  if (idx < 0)
    return void 0;
  const rest = norm.slice(idx + marker.length);
  return (_a = m.get(rest)) != null ? _a : m.get(`references/${rest}`);
}

// src/seam.js
var import_node_util = require("util");
var import_node_path2 = require("path");
function packageRoot2() {
  let dir = (0, import_node_path2.dirname)((0, import_node_url2.fileURLToPath)(__IMETA_URL__));
  for (let i = 0; i < 6; i++) {
    if ((0, import_node_fs2.existsSync)((0, import_node_path2.join)(dir, "package.json")))
      return dir;
    dir = (0, import_node_path2.dirname)(dir);
  }
  return dir;
}
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
var MAX_OUTPUT_BYTES = 256 * 1024;
var GRACE_MS = 3e4;
var INTERPRETER_ALIASES = {
  python: ["python", "py", "python3"],
  bash: ["bash"]
};
function isUsableBinary(path) {
  try {
    const stat = (0, import_node_fs2.statSync)(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}
function isStub(path) {
  try {
    return (0, import_node_fs2.statSync)(path).isFile() && (0, import_node_fs2.statSync)(path).size === 0;
  } catch {
    return false;
  }
}
var probeCache = /* @__PURE__ */ new Map();
function runsSuccessfully(path, args) {
  const cacheKey = `${path}\0${args.join(" ")}`;
  const cached2 = probeCache.get(cacheKey);
  if (cached2 !== void 0)
    return cached2;
  let ok = false;
  try {
    const result = (0, import_node_child_process.spawnSync)(path, args, { timeout: 15e3, encoding: "utf8" });
    ok = !result.error && result.status === 0;
  } catch {
    ok = false;
  }
  probeCache.set(cacheKey, ok);
  return ok;
}
function findInterpreter(command) {
  var _a, _b, _c;
  const aliases = (_a = INTERPRETER_ALIASES[command]) != null ? _a : [command];
  const probeArgs = command === "python" || command === "python3" || command === "py" ? ["--version"] : [];
  for (const alias of aliases) {
    const pathext = ((_b = process.env.PATHEXT) != null ? _b : "").split(";").filter(Boolean);
    const exts = ["", ...pathext];
    for (const dir of ((_c = process.env.PATH) != null ? _c : "").split(import_node_path2.delimiter)) {
      if (!dir)
        continue;
      for (const ext of exts) {
        const full = (0, import_node_path2.join)(dir, alias + ext);
        try {
          (0, import_node_fs2.accessSync)(full, import_node_fs2.constants.F_OK);
        } catch {
          continue;
        }
        if (isStub(full))
          continue;
        if (!isUsableBinary(full))
          continue;
        if (probeArgs.length > 0 && !runsSuccessfully(full, probeArgs))
          continue;
        return full;
      }
    }
  }
  return null;
}
async function resolveCommand(_ctx, command) {
  const subprocess = safeService(_ctx, "subprocess");
  if (subprocess != null && typeof subprocess.resolveExecutable === "function") {
    try {
      const resolved = await subprocess.resolveExecutable(command);
      if (resolved) {
        if (INTERPRETER_ALIASES[command] === void 0 || !isStub(resolved))
          return resolved;
      }
    } catch {
    }
  }
  const local = findInterpreter(command);
  if (local)
    return local;
  return command;
}
function assertWithinRoot(absPath, root) {
  const normalized = (0, import_node_path2.normalize)(absPath);
  const normalizedRoot = (0, import_node_path2.normalize)(root);
  const prefix = normalizedRoot.endsWith(import_node_path2.sep) ? normalizedRoot : normalizedRoot + import_node_path2.sep;
  if (normalized !== normalizedRoot && !normalized.startsWith(prefix)) {
    throw new Error("path out of scope");
  }
  return normalized;
}
async function readTextSeam(ctx, absPath) {
  if (!(0, import_node_fs2.existsSync)(absPath)) {
    const sealed = readSealedByAbsPath(absPath);
    if (sealed !== void 0)
      return sealed;
  }
  const fs = ctx.get("fs");
  if (fs != null && typeof fs.resolve === "function" && typeof fs.readText === "function") {
    const target = await fs.resolve(absPath);
    return await fs.readText(target);
  }
  return await (0, import_promises.readFile)(absPath, "utf8");
}
async function runSeam(ctx, argv, cwd) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
  const program = await resolveCommand(ctx, argv[0]);
  const resolvedArgv = [program, ...argv.slice(1)];
  const subprocess = ctx.get("subprocess");
  if (subprocess != null && typeof subprocess.spawn === "function") {
    const handle = subprocess.spawn({
      argv: resolvedArgv,
      cwd,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_OUTPUT_BYTES * 8 } },
        stderr: { maxBytes: MAX_OUTPUT_BYTES }
      },
      graceMs: GRACE_MS,
      env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
    });
    const outcome = await handle.done;
    const out = (_d = (_c = (_b = (_a = handle.collected) == null ? void 0 : _a.stdout) == null ? void 0 : _b.readFrom(0)) == null ? void 0 : _c.text) != null ? _d : "";
    const err = (_h = (_g = (_f = (_e = handle.collected) == null ? void 0 : _e.stderr) == null ? void 0 : _f.readFrom(0)) == null ? void 0 : _g.text) != null ? _h : "";
    if (outcome.exitCode !== 0) {
      throw new Error(`${program} exited with code ${outcome.exitCode}${err ? `: ${err.trim()}` : ""}`);
    }
    return out;
  }
  try {
    const { stdout } = await execFileAsync(resolvedArgv[0], resolvedArgv.slice(1), {
      cwd,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: GRACE_MS,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
    });
    return stdout;
  } catch (error) {
    const e = error;
    throw new Error(`${program} failed: ${(_j = (_i = e == null ? void 0 : e.stderr) != null ? _i : e == null ? void 0 : e.message) != null ? _j : String(e)}`);
  }
}
function safeService(ctx, name) {
  if (!ctx || typeof ctx !== "object")
    return void 0;
  const c = ctx;
  try {
    if (typeof c.get === "function") {
      const s = c.get(name);
      if (s != null)
        return s;
    }
  } catch {
  }
  try {
    const root = c.root;
    if (root && root !== c && typeof root.get === "function") {
      const s = root.get(name);
      if (s != null)
        return s;
    }
  } catch {
  }
  try {
    if (c.reflect && typeof c.reflect.get === "function") {
      const s = c.reflect.get(name, false);
      if (s != null)
        return s;
    }
  } catch {
  }
  try {
    const root = c.root;
    if (root && root !== c && root.reflect && typeof root.reflect.get === "function") {
      const s = root.reflect.get(name, false);
      if (s != null)
        return s;
    }
  } catch {
  }
  return void 0;
}

// src/tools/web.js
var import_dsh_tools = __toESM(require_dsh_tools());
var import_node_path3 = require("path");
var refRoot = (0, import_node_path3.join)(packageRoot2(), "references", "web");
var scriptRoot = (0, import_node_path3.join)(packageRoot2(), "scripts", "web");
function registerWebTools(ctx) {
  ctx.tools.register((0, import_dsh_tools.defineTool)({
    name: "web_reference",
    description: "Read a web reference doc on demand; apply your own judgment. Start with index.md.",
    parameters: { path: { type: "string", required: true, description: "Path relative to references/." } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      const abs = (0, import_node_path3.resolve)(refRoot, args.path);
      assertWithinRoot(abs, refRoot);
      return await readTextSeam(ctx, abs);
    }
  }));
  ctx.tools.register((0, import_dsh_tools.defineTool)({
    name: "bot_analyze",
    description: "Analyze a Puppeteer Bot server.js: extract params, classify mode, build attack timeline.",
    parameters: {
      file: { type: "string", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["python", (0, import_node_path3.resolve)(scriptRoot, "web-analysis_bot_analyze.py"), args.file], packageRoot2());
    }
  }));
}

// src/tools/android.js
var import_dsh_tools2 = __toESM(require_dsh_tools());
var import_node_path4 = require("path");
var scriptRoot2 = (0, import_node_path4.join)(packageRoot2(), "scripts", "android");
function registerAndroidTools(ctx) {
  ctx.tools.register((0, import_dsh_tools2.defineTool)({
    name: "apk_fingerprint",
    description: "Detect APK framework / HTTP stack / obfuscation. Read references/fingerprint.md for interpretation.",
    parameters: {
      apk: { type: "string", required: true, description: "Path to the APK/XAPK file." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["bash", (0, import_node_path4.resolve)(scriptRoot2, "fingerprint.sh"), args.apk], packageRoot2());
    }
  }));
}

// src/tools/native.js
var import_dsh_tools3 = __toESM(require_dsh_tools());
var import_node_path5 = require("path");
var refRoot2 = (0, import_node_path5.join)(packageRoot2(), "references", "native");
var scriptRoot3 = (0, import_node_path5.join)(packageRoot2(), "scripts", "native");
function registerNativeTools(ctx) {
  ctx.tools.register((0, import_dsh_tools3.defineTool)({
    name: "native_reference",
    description: "Read a native/binary reference doc on demand; apply your own judgment. Start with index.md.",
    parameters: { path: { type: "string", required: true, description: "Path relative to references/." } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      const abs = (0, import_node_path5.resolve)(refRoot2, args.path);
      assertWithinRoot(abs, refRoot2);
      return await readTextSeam(ctx, abs);
    }
  }));
  ctx.tools.register((0, import_dsh_tools3.defineTool)({
    name: "detect_packer",
    description: "Detect PE/ELF packers (UPX/VMProtect/Themida/OLLVM).",
    parameters: {
      file: { type: "string", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["python", (0, import_node_path5.resolve)(scriptRoot3, "protection/detect_packer.py"), args.file], packageRoot2());
    }
  }));
  ctx.tools.register((0, import_dsh_tools3.defineTool)({
    name: "scan_strings",
    description: "Extract printable ASCII/UTF-16LE strings from a binary.",
    parameters: {
      path: { type: "string", required: true },
      min: { type: "number" }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["python", (0, import_node_path5.resolve)(scriptRoot3, "scan_strings.py"), args.path, ...args.min != null ? ["--min", String(args.min)] : []], packageRoot2());
    }
  }));
  ctx.tools.register((0, import_dsh_tools3.defineTool)({
    name: "xor_bruteforce",
    description: "Single/multi-byte XOR key bruteforce ranked by English-likeness (letter density + word/flag-format bonus). Omit keylen for single-byte ranked candidates; pass keylen for repeating-key. Use top_n to widen the candidate list.",
    parameters: {
      data: { type: "string", required: true, description: "File path or hex string." },
      keylen: { type: "number", description: "Repeating-key length; omit for single-byte mode." },
      top_n: { type: "number", description: "Candidate count (default 10)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      const extra = [];
      if (args.keylen != null)
        extra.push("-k", String(args.keylen));
      if (args.top_n != null)
        extra.push("-n", String(args.top_n));
      return await runSeam(ctx, ["python", (0, import_node_path5.resolve)(scriptRoot3, "crypto/xor_bruteforce.py"), args.data, ...extra], packageRoot2());
    }
  }));
  ctx.tools.register((0, import_dsh_tools3.defineTool)({
    name: "encoding_detect",
    description: "Detect and decode Base64/Hex/ROT13/XOR on an encoded string.",
    parameters: {
      text: { type: "string", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["python", (0, import_node_path5.resolve)(scriptRoot3, "crypto/encoding_detect.py"), args.text], packageRoot2());
    }
  }));
}

// src/tools/protocol.js
var import_dsh_tools4 = __toESM(require_dsh_tools());
var import_node_path6 = require("path");
var refRoot3 = (0, import_node_path6.join)(packageRoot2(), "references", "protocol");
var scriptRoot4 = (0, import_node_path6.join)(packageRoot2(), "scripts", "protocol");
function registerProtocolTools(ctx) {
  ctx.tools.register((0, import_dsh_tools4.defineTool)({
    name: "protocol_reference",
    description: "Read a protocol reference doc on demand; apply your own judgment. Start with index.md.",
    parameters: { path: { type: "string", required: true, description: "Path relative to references/." } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      const abs = (0, import_node_path6.resolve)(refRoot3, args.path);
      assertWithinRoot(abs, refRoot3);
      return await readTextSeam(ctx, abs);
    }
  }));
  ctx.tools.register((0, import_dsh_tools4.defineTool)({
    name: "pcap_parse",
    description: "Parse a PCAP and extract TCP/UDP streams.",
    parameters: {
      file: { type: "string", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["python", (0, import_node_path6.resolve)(scriptRoot4, "protocol/pcap_minimal.py"), args.file], packageRoot2());
    }
  }));
  ctx.tools.register((0, import_dsh_tools4.defineTool)({
    name: "state_machine",
    description: "Infer a protocol state machine (DOT) from a message log.",
    parameters: {
      messages: { type: "string", required: true },
      out: { type: "string" }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["python", (0, import_node_path6.resolve)(scriptRoot4, "protocol/protocol_state_machine.py"), args.messages, ...args.out != null ? [args.out] : []], packageRoot2());
    }
  }));
  ctx.tools.register((0, import_dsh_tools4.defineTool)({
    name: "parse_har",
    description: "Parse HAR request/response fields for protocol reversing.",
    parameters: {
      har: { type: "string", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["python", (0, import_node_path6.resolve)(scriptRoot4, "parse_har_fields.py"), args.har], packageRoot2());
    }
  }));
}

// src/tools/malware.js
var import_dsh_tools5 = __toESM(require_dsh_tools());
var import_node_path7 = require("path");
var refRoot4 = (0, import_node_path7.join)(packageRoot2(), "references", "malware");
var scriptRoot5 = (0, import_node_path7.join)(packageRoot2(), "scripts", "malware");
function registerMalwareTools(ctx) {
  ctx.tools.register((0, import_dsh_tools5.defineTool)({
    name: "malware_reference",
    description: "Read a malware reference doc on demand; apply your own judgment. Start with index.md.",
    parameters: { path: { type: "string", required: true, description: "Path relative to references/." } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      const abs = (0, import_node_path7.resolve)(refRoot4, args.path);
      assertWithinRoot(abs, refRoot4);
      return await readTextSeam(ctx, abs);
    }
  }));
  ctx.tools.register((0, import_dsh_tools5.defineTool)({
    name: "ioc_extract",
    description: "Extract IOCs (IPv4/IPv6/URL/domain/email/hash) from an artifact file.",
    parameters: {
      file: { type: "string", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["python", (0, import_node_path7.resolve)(scriptRoot5, "malware/ioc_extractor.py"), args.file], packageRoot2());
    }
  }));
  ctx.tools.register((0, import_dsh_tools5.defineTool)({
    name: "yara_gen",
    description: "Generate a YARA rule from binary strings and imports.",
    parameters: {
      file: { type: "string", required: true },
      out: { type: "string" }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["python", (0, import_node_path7.resolve)(scriptRoot5, "malware/yara_gen.py"), args.file, ...args.out != null ? [args.out] : []], packageRoot2());
    }
  }));
}

// src/tools/ai-security.js
var import_dsh_tools6 = __toESM(require_dsh_tools());
var import_node_path8 = require("path");
var refRoot5 = (0, import_node_path8.join)(packageRoot2(), "references", "ai-security");
var scriptRoot6 = (0, import_node_path8.join)(packageRoot2(), "scripts", "ai-security");
function registerAiSecurityTools(ctx) {
  ctx.tools.register((0, import_dsh_tools6.defineTool)({
    name: "ai_reference",
    description: "Read a AI/LLM security reference doc on demand; apply your own judgment. Start with index.md.",
    parameters: { path: { type: "string", required: true, description: "Path relative to references/." } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      const abs = (0, import_node_path8.resolve)(refRoot5, args.path);
      assertWithinRoot(abs, refRoot5);
      return await readTextSeam(ctx, abs);
    }
  }));
  ctx.tools.register((0, import_dsh_tools6.defineTool)({
    name: "llm_sim",
    description: "Simulate an LLM app locally to test prompt-injection payloads (OpenAI-compatible).",
    parameters: {
      system_prompt: { type: "string", required: true },
      input: { type: "string", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["python", (0, import_node_path8.resolve)(scriptRoot6, "ai-security-analysis_llm_sim.py"), "--system-prompt", args.system_prompt, "--input", args.input], packageRoot2());
    }
  }));
}

// src/tools/evidence.js
var import_dsh_tools7 = __toESM(require_dsh_tools());
var import_node_path9 = require("path");
var import_node_os = require("os");
var refRoot6 = (0, import_node_path9.join)(packageRoot2(), "references", "evidence");
var scriptRoot7 = (0, import_node_path9.join)(packageRoot2(), "scripts", "evidence");
function registerEvidenceTools(ctx) {
  ctx.tools.register((0, import_dsh_tools7.defineTool)({
    name: "evidence_reference",
    description: "Read a evidence/reporting reference doc on demand; apply your own judgment. Start with index.md.",
    parameters: { path: { type: "string", required: true, description: "Path relative to references/." } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      const abs = (0, import_node_path9.resolve)(refRoot6, args.path);
      assertWithinRoot(abs, refRoot6);
      return await readTextSeam(ctx, abs);
    }
  }));
  ctx.tools.register((0, import_dsh_tools7.defineTool)({
    name: "triage_artifact",
    description: "Collect safe offline triage facts for an artifact (magic, entropy, strings).",
    parameters: {
      artifact: { type: "string", required: true },
      out: { type: "string", required: false, description: "Output directory. Defaults to the plugin data dir under triage/." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      let out = args.out === void 0 || args.out === null ? "" : String(args.out).trim();
      if (out === "") {
        const data = process.env.AICODE_DATA_DIR || (0, import_node_path9.join)(process.env.AICODE_HOME || (0, import_node_path9.join)((0, import_node_os.homedir)(), ".guru"), "plugins", "data", "jinghan.toolbox");
        out = (0, import_node_path9.join)(data, "triage");
      }
      return await runSeam(ctx, ["python", (0, import_node_path9.resolve)(scriptRoot7, "triage_artifact.py"), args.artifact, "--out", out], packageRoot2());
    }
  }));
  ctx.tools.register((0, import_dsh_tools7.defineTool)({
    name: "hash_artifact",
    description: "Print SHA-256 and size of an artifact.",
    parameters: {
      path: { type: "string", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return await runSeam(ctx, ["python", (0, import_node_path9.resolve)(scriptRoot7, "hash_artifact.py"), args.path], packageRoot2());
    }
  }));
}

// src/tools/toolbox.js
var import_dsh_tools8 = __toESM(require_dsh_tools());
var import_node_path15 = require("path");

// src/toolbox/catalog.js
var TOOL_CATALOG = [
  {
    id: "garlic",
    name: "garlic",
    repo: "https://github.com/neocanable/garlic",
    category: "Android",
    purpose: "APK/DEX/JAR fast decompiler and string search",
    kind: "release",
    tag: "v1.8-release",
    asset: "garlic-win64.exe",
    usage: "garlic -d out/ app.apk"
  },
  {
    id: "jadx",
    name: "jadx",
    repo: "https://github.com/skylot/jadx",
    category: "Android",
    purpose: "DEX/APK to Java decompiler",
    kind: "release",
    assetPattern: "^jadx-\\d.*\\.zip$",
    usage: "jadx -d out/ app.apk"
  },
  {
    id: "apktool",
    name: "apktool",
    repo: "https://github.com/iBotPeaches/Apktool",
    category: "Android",
    purpose: "APK unpack/repack, smali and resources",
    kind: "release",
    usage: "java -jar apktool.jar d app.apk -o out/"
  },
  {
    id: "androguard",
    name: "androguard",
    repo: "https://github.com/androguard/androguard",
    category: "Android",
    purpose: "APK static analysis (manifest, call graph)",
    kind: "pip",
    package: "androguard",
    installHint: "pip install androguard",
    usage: 'python -c "from androguard.core.apk import APK; ..."'
  },
  {
    id: "unidbg",
    name: "unidbg",
    repo: "https://github.com/zhkl0228/unidbg",
    category: "Android",
    purpose: "Android native SO emulation",
    kind: "manual",
    installHint: "git clone + ./mvnw package (JDK required)",
    usage: "java -jar unidbg-android.jar ..."
  },
  {
    id: "mobsf",
    name: "MobSF",
    repo: "https://github.com/MobSF/Mobile-Security-Framework-MobSF",
    category: "Android",
    purpose: "All-in-one mobile static/dynamic security assessment",
    license: "GPL-3.0",
    kind: "manual",
    installHint: "docker run --rm -p 8000:8000 opensecurity/mobile-security-framework-mobsf:latest",
    usage: "upload APK/IPA in MobSF; REST API on :8000"
  },
  {
    id: "objection",
    name: "objection",
    repo: "https://github.com/sensepost/objection",
    category: "Android",
    purpose: "Frida-backed runtime mobile exploration",
    license: "GPL-3.0",
    kind: "pip",
    package: "objection",
    installHint: "pip install objection",
    usage: "objection -g com.example.app explore"
  },
  {
    id: "quark-engine",
    name: "Quark Engine",
    repo: "https://github.com/ev-flow/quark-engine",
    category: "Android",
    purpose: "Obfuscation-neglect Android malware scoring",
    license: "GPL-3.0",
    kind: "pip",
    package: "quark-engine",
    installHint: "pip install quark-engine",
    usage: "quark -a app.apk -s"
  },
  {
    id: "apkid",
    name: "APKiD",
    repo: "https://github.com/rednaga/APKiD",
    category: "Android",
    purpose: "Packer/protector/obfuscator identification for APKs",
    license: "GPL-3.0 (dual commercial)",
    kind: "pip",
    package: "apkid",
    installHint: "pip install apkid",
    usage: "apkid app.apk"
  },
  {
    id: "fernflower",
    name: "fernflower",
    repo: "https://github.com/JetBrains/fernflower",
    category: "Android",
    purpose: "Java bytecode decompiler",
    kind: "manual",
    installHint: "download the fernflower jar / build from source",
    usage: "java -jar fernflower.jar classes/ out/"
  },
  {
    id: "rustfrida",
    name: "rustFrida",
    repo: "https://github.com/kkkbbb/rustFrida",
    category: "Android",
    purpose: "Android ARM64 dynamic instrumentation",
    kind: "release",
    asset: "rustfrida",
    usage: "rustfrida --spawn <package>"
  },
  {
    id: "frida",
    name: "Frida",
    repo: "https://github.com/frida/frida",
    category: "Runtime",
    purpose: "Cross-platform dynamic instrumentation",
    kind: "pip",
    package: "frida-tools",
    installHint: "pip install frida frida-tools",
    usage: "frida -U -f <package> -l hook.js"
  },
  {
    id: "scrapling",
    name: "Scrapling",
    repo: "https://github.com/D4Vinci/Scrapling",
    category: "Web",
    purpose: "Adaptive web scraping / anti-bot handling",
    kind: "pip",
    package: "scrapling",
    installHint: "pip install scrapling",
    usage: "python -m scrapling ..."
  },
  {
    id: "wxapkg-unpacker",
    name: "wxapkg-unpacker",
    repo: "https://github.com/zgqwork/wxapkg-unpacker",
    category: "Web",
    purpose: "WeChat mini-program package decrypt/unpack",
    license: "MIT",
    kind: "manual",
    installHint: "npm i -g wxapkg-unpacker",
    usage: "wxunpacker -h"
  },
  {
    id: "ip-checker",
    name: "ip_checker",
    repo: "https://github.com/test692618/ip_checker",
    category: "Web",
    purpose: "IP liveness probe",
    kind: "manual",
    installHint: "build from source or use the project Releases page",
    usage: "ip_checker -f ips.txt"
  },
  {
    id: "cipherbridge",
    name: "CipherBridge",
    repo: "https://github.com/CuriousLearnerDev/CipherBridge",
    category: "Web",
    purpose: "Encryption/signature analysis bridge",
    kind: "manual",
    installHint: "download from the repository Releases; no sha256 digest published",
    usage: "CipherBridge --help"
  },
  {
    id: "nuclei",
    name: "Nuclei",
    repo: "https://github.com/projectdiscovery/nuclei",
    category: "Web",
    purpose: "Template-driven vulnerability scanning",
    license: "MIT",
    kind: "release",
    assetPattern: "^nuclei_.*_windows_amd64\\.zip$",
    usage: "nuclei -u https://target -severity high,critical"
  },
  {
    id: "ffuf",
    name: "ffuf",
    repo: "https://github.com/ffuf/ffuf",
    category: "Web",
    purpose: "Fast web content and parameter fuzzing",
    license: "MIT",
    kind: "release",
    assetPattern: "^ffuf_.*_windows_amd64\\.zip$",
    usage: "ffuf -w wordlist.txt -u https://target/FUZZ"
  },
  {
    id: "mitmproxy",
    name: "mitmproxy",
    repo: "https://github.com/mitmproxy/mitmproxy",
    category: "Web",
    purpose: "TLS-intercepting HTTP proxy for capture and replay",
    license: "MIT",
    kind: "pip",
    package: "mitmproxy",
    installHint: "pip install mitmproxy",
    usage: "mitmproxy -p 8080"
  },
  {
    id: "impacket",
    name: "Impacket",
    repo: "https://github.com/fortra/impacket",
    category: "Web",
    purpose: "Windows network protocol toolkit (SMB/WMI/Kerberos)",
    license: "Apache-2.0 (modified)",
    kind: "pip",
    package: "impacket",
    installHint: "pip install impacket",
    usage: "python -m impacket.examples.secretsdump -h"
  },
  {
    id: "netexec",
    name: "NetExec",
    repo: "https://github.com/Pennyw0rth/NetExec",
    category: "Web",
    purpose: "Network/AD service execution and enumeration",
    license: "BSD-2-Clause",
    kind: "manual",
    installHint: "pipx install git+https://github.com/Pennyw0rth/NetExec",
    usage: "nxc smb 10.0.0.0/24 -u user -p pass"
  },
  {
    id: "sqlmap",
    name: "sqlmap",
    repo: "https://github.com/sqlmapproject/sqlmap",
    category: "Web",
    purpose: "Automated SQL injection detection and exploitation",
    license: "GPL-2.0",
    kind: "manual",
    installHint: "git clone https://github.com/sqlmapproject/sqlmap; pip install -r requirements.txt",
    usage: 'python sqlmap.py -u "http://target/?id=1" --batch'
  },
  {
    id: "headless-ida",
    name: "headless-ida",
    repo: "https://github.com/DennyDai/headless-ida",
    category: "Native",
    purpose: "IDA headless scripting (requires IDA Pro)",
    kind: "pip",
    package: "headless-ida",
    installHint: "pip install headless-ida",
    usage: "python -m headless_ida ..."
  },
  {
    id: "radare2",
    name: "radare2",
    repo: "https://github.com/radareorg/radare2",
    category: "Native",
    purpose: "Command-line reverse-engineering framework",
    kind: "release",
    assetPattern: "^radare2-.*-w64\\.zip$",
    usage: "r2 -A sample.bin"
  },
  {
    id: "ghidra",
    name: "Ghidra",
    repo: "https://github.com/NationalSecurityAgency/ghidra",
    category: "Native",
    purpose: "NSA reverse-engineering suite",
    license: "Apache-2.0",
    kind: "manual",
    installHint: "download ghidra_*_PUBLIC_*.zip from Releases (~570 MB; installer cap 512 MB)",
    usage: "ghidraRun"
  },
  {
    id: "detect-it-easy",
    name: "Detect It Easy",
    repo: "https://github.com/horsicq/Detect-It-Easy",
    category: "Native",
    purpose: "Packer/compiler detection",
    kind: "manual",
    installHint: "install from the project Releases page (only pre-release DB assets on GitHub)",
    usage: "diec sample.exe"
  },
  {
    id: "upx",
    name: "UPX",
    repo: "https://github.com/upx/upx",
    category: "Native",
    purpose: "Executable packer/unpacker",
    kind: "release",
    assetPattern: "^upx-.*-win64\\.zip$",
    usage: "upx -d packed.exe"
  },
  {
    id: "rizin",
    name: "Rizin",
    repo: "https://github.com/rizinorg/rizin",
    category: "Native",
    purpose: "Command-line reverse-engineering framework (radare2 fork)",
    license: "LGPL-3.0",
    kind: "release",
    assetPattern: "^rizin-windows-static-v.*\\.zip$",
    usage: "rizin -A sample.bin"
  },
  {
    id: "capa",
    name: "capa",
    repo: "https://github.com/mandiant/capa",
    category: "Native",
    purpose: "Identify capabilities in executables (ATT&CK/MBC mapping)",
    license: "Apache-2.0",
    kind: "pip",
    package: "flare-capa",
    installHint: "pip install flare-capa",
    usage: "capa sample.exe"
  },
  {
    id: "flare-floss",
    name: "FLOSS",
    repo: "https://github.com/mandiant/flare-floss",
    category: "Native",
    purpose: "Extract obfuscated/stack strings from malware",
    license: "Apache-2.0",
    kind: "pip",
    package: "flare-floss",
    installHint: "pip install flare-floss",
    usage: "floss sample.exe"
  },
  {
    id: "yara",
    name: "YARA",
    repo: "https://github.com/VirusTotal/yara",
    category: "Native",
    purpose: "Pattern matching for malware classification",
    license: "BSD-3-Clause",
    kind: "release",
    assetPattern: "^yara-.*-win64\\.zip$",
    usage: "yara rule.yar sample.exe"
  },
  {
    id: "angr",
    name: "angr",
    repo: "https://github.com/angr/angr",
    category: "Native",
    purpose: "Symbolic execution and binary analysis platform",
    license: "BSD-2-Clause",
    kind: "pip",
    package: "angr",
    installHint: "pip install angr",
    usage: `python -c "import angr; p=angr.Project('sample.bin')"`
  },
  {
    id: "pwntools",
    name: "pwntools",
    repo: "https://github.com/Gallopsled/pwntools",
    category: "Native",
    purpose: "Exploit development and CTF toolkit",
    license: "MIT (mostly)",
    kind: "pip",
    package: "pwntools",
    installHint: "pip install pwntools (Windows \u539F\u751F\u53D7\u9650\uFF0C\u5EFA\u8BAE WSL/Kali)",
    usage: "pwn checksec ./bin"
  },
  {
    id: "ropgadget",
    name: "ROPgadget",
    repo: "https://github.com/JonathanSalwan/ROPgadget",
    category: "Native",
    purpose: "Find ROP/JOP gadgets in binaries",
    license: "BSD-3-Clause",
    kind: "pip",
    package: "ROPgadget",
    installHint: "pip install ROPgadget",
    usage: "ROPgadget --binary ./bin"
  },
  {
    id: "ghidra-mcp",
    name: "GhidraMCP",
    repo: "https://github.com/LaurieWired/GhidraMCP",
    category: "Native",
    purpose: "MCP bridge exposing Ghidra analysis to agents",
    license: "Apache-2.0",
    kind: "release",
    assetPattern: "^GhidraMCP-release-.*\\.zip$",
    usage: "install extension in Ghidra 12.1.4, then run ghidra-mcp"
  },
  {
    id: "binwalk",
    name: "binwalk",
    repo: "https://github.com/ReFirmLabs/binwalk",
    category: "Firmware",
    purpose: "Firmware image analysis and embedded-file extraction",
    license: "MIT",
    kind: "manual",
    installHint: "cargo install binwalk (v3 Rust; or build from source)",
    usage: "binwalk firmware.bin"
  },
  {
    id: "unblob",
    name: "unblob",
    repo: "https://github.com/onekey-sec/unblob",
    category: "Firmware",
    purpose: "Extract files from firmware/container formats",
    license: "MIT",
    kind: "manual",
    installHint: "pip install unblob (Linux/WSL; requires libmagic)",
    usage: "unblob -e out firmware.bin"
  },
  {
    id: "semgrep",
    name: "Semgrep",
    repo: "https://github.com/semgrep/semgrep",
    category: "Code",
    purpose: "Pattern-based source audit and bug-variant discovery",
    license: "LGPL-2.1",
    kind: "pip",
    package: "semgrep",
    installHint: "pip install semgrep",
    usage: "semgrep --config auto ."
  },
  {
    id: "joern",
    name: "Joern",
    repo: "https://github.com/joernio/joern",
    category: "Code",
    purpose: "Code property graph for source/binary data-flow queries",
    license: "Apache-2.0",
    kind: "manual",
    installHint: "download joern-cli-windows-x86_64.zip from Releases (~1.7 GB)",
    usage: "joern --script query.sc"
  },
  {
    id: "vmp-static-unpacker",
    name: "VMPStaticUnpacker",
    repo: "https://github.com/YuroGod/VMPStaticUnpacker",
    category: "Windows",
    purpose: "VMProtect static unpacking",
    kind: "manual",
    installHint: "download from the project Releases page (no published release found)",
    usage: "VMPStaticUnpacker.exe sample.exe"
  },
  {
    id: "x64dbg",
    name: "x64dbg",
    repo: "https://github.com/x64dbg/x64dbg",
    category: "Windows",
    purpose: "Windows user-mode debugger",
    kind: "release",
    assetPattern: "^snapshot_.*\\.zip$",
    usage: "x64dbg.exe sample.exe"
  },
  {
    id: "x64dbg-mcp",
    name: "x64dbg-mcp",
    repo: "https://github.com/SetsunaYukiOvO/x64dbg-mcp",
    category: "Windows",
    purpose: "MCP bridge for x64dbg",
    kind: "release",
    asset: "x64dbg_mcp.dp64",
    usage: "install plugin into x64dbg plugins/"
  },
  {
    id: "hashdump-bypassedr",
    name: "HashDump-BypassEDR",
    repo: "https://github.com/AabyssZG/HashDump-BypassEDR",
    category: "Windows",
    purpose: "EDR-resistant hash dump helper",
    kind: "release",
    usage: "BootKey.exe"
  },
  {
    id: "weakpassdetect",
    name: "WeakPassDetect",
    repo: "https://github.com/Pick-program/WeakPassDetect",
    category: "Protocol",
    purpose: "Weak-password detection",
    kind: "manual",
    installHint: "download from the project Releases page (no published release found)",
    usage: "python weak_passwd_detect.py ..."
  },
  {
    id: "pe-inspector",
    name: "pe-inspector",
    repo: "https://github.com/la-1314/pe-inspector",
    category: "Malware",
    purpose: "PE malware inspection",
    kind: "manual",
    installHint: "download from the project Releases page (no published release found)",
    usage: "pe-inspector sample.exe"
  },
  {
    id: "volatility3",
    name: "Volatility 3",
    repo: "https://github.com/volatilityfoundation/volatility3",
    category: "Malware",
    purpose: "Memory forensics framework",
    license: "VSL",
    kind: "pip",
    package: "volatility3",
    installHint: "pip install volatility3",
    usage: "vol -f memory.raw windows.pslist"
  },
  {
    id: "oletools",
    name: "oletools",
    repo: "https://github.com/decalage2/oletools",
    category: "Malware",
    purpose: "Office/OLE macro and document analysis",
    license: "BSD-3-Clause",
    kind: "pip",
    package: "oletools",
    installHint: "pip install oletools",
    usage: "olevba sample.doc"
  },
  {
    id: "pe-sieve",
    name: "PE-sieve",
    repo: "https://github.com/hasherezade/pe-sieve",
    category: "Malware",
    purpose: "Detect and dump in-memory implants/injections",
    license: "BSD-2-Clause",
    kind: "release",
    assetPattern: "^pe-sieve64\\.zip$",
    usage: "pe-sieve64.exe /pid <pid>"
  },
  {
    id: "hollows-hunter",
    name: "hollows_hunter",
    repo: "https://github.com/hasherezade/hollows_hunter",
    category: "Malware",
    purpose: "Scan running processes for hollowing/injection",
    license: "BSD-2-Clause",
    kind: "release",
    assetPattern: "^hollows_hunter64\\.zip$",
    usage: "hollows_hunter64.exe /loop"
  },
  {
    id: "garak",
    name: "garak",
    repo: "https://github.com/NVIDIA/garak",
    category: "AI",
    purpose: "LLM vulnerability and jailbreak scanner",
    license: "Apache-2.0",
    kind: "pip",
    package: "garak",
    installHint: 'pip install "garak==0.17.0" (0.17.1 wheel \u7F3A probe \u6A21\u5757\uFF1B\u6216 git+https://github.com/NVIDIA/garak.git@main)',
    usage: "garak --target_type openai --target_name <model> --spec probes.encoding.InjectBase64 -g 1"
  },
  {
    id: "dex2jar",
    name: "dex2jar",
    repo: "https://github.com/pxb1988/dex2jar",
    category: "General",
    purpose: "DEX to JAR conversion",
    kind: "manual",
    installHint: "download from the repository Releases; no sha256 digest published",
    usage: "d2j-dex2jar classes.dex"
  },
  {
    id: "cfr",
    name: "CFR",
    repo: "https://github.com/leibnitz27/cfr",
    category: "General",
    purpose: "Java decompiler",
    kind: "manual",
    installHint: "download the CFR jar from Releases; no sha256 digest published",
    usage: "java -jar cfr.jar classes.jar"
  },
  {
    id: "nmap",
    name: "nmap",
    repo: "https://github.com/nmap/nmap",
    category: "General",
    purpose: "Network/port scanning",
    kind: "manual",
    installHint: "install from nmap.org or the distro package manager",
    usage: "nmap -sV target"
  },
  {
    id: "wireshark",
    name: "Wireshark",
    repo: "https://github.com/wireshark/wireshark",
    category: "General",
    purpose: "Packet capture/analysis",
    kind: "manual",
    installHint: "install from wireshark.org or the distro package manager",
    usage: "tshark -r capture.pcap"
  }
];
function catalogEntry(id) {
  return TOOL_CATALOG.find((entry) => entry.id === id);
}
function isGithubRepo(url) {
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url);
}

// src/toolbox/installer.js
var import_node_crypto2 = require("crypto");
var import_node_fs4 = require("fs");
var import_node_path12 = require("path");
var import_node_child_process3 = require("child_process");

// src/http.js
var import_node_child_process2 = require("child_process");
var import_node_http = require("http");
var import_node_https = require("https");
var import_node_tls = require("tls");
var REQUEST_TIMEOUT_MS = 2e4;
var PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy"
];
var cachedSystemProxy;
function parseProxy(raw) {
  if (raw === void 0)
    return void 0;
  const trimmed = raw.trim();
  if (trimmed === "")
    return void 0;
  try {
    return new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
  } catch {
    return void 0;
  }
}
function bypassed(host, list) {
  if (list === void 0 || list.trim() === "")
    return false;
  const lower = host.toLowerCase();
  for (const rawEntry of list.split(",")) {
    const entry = rawEntry.trim().toLowerCase();
    if (entry === "")
      continue;
    if (entry === "*")
      return true;
    const bare = entry.replace(/:\d+$/, "").replace(/^\./, "");
    if (bare === "")
      continue;
    if (lower === bare || lower.endsWith(`.${bare}`))
      return true;
  }
  return false;
}
function windowsSystemProxy() {
  var _a, _b, _c, _d, _e;
  if (cachedSystemProxy !== void 0)
    return cachedSystemProxy != null ? cachedSystemProxy : void 0;
  cachedSystemProxy = null;
  if (process.platform !== "win32")
    return void 0;
  const key3 = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  try {
    const enabled = (0, import_node_child_process2.execFileSync)("reg", ["query", key3, "/v", "ProxyEnable"], {
      encoding: "utf8",
      windowsHide: true
    });
    cachedSystemProxy = null;
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled))
      return void 0;
    const server = (0, import_node_child_process2.execFileSync)("reg", ["query", key3, "/v", "ProxyServer"], {
      encoding: "utf8",
      windowsHide: true
    });
    const value = (_a = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(server)) == null ? void 0 : _a[1];
    if (value === void 0)
      return void 0;
    const chosen = value.includes("=") ? (_e = (_d = (_b = /(?:^|;)https=([^;]+)/i.exec(value)) == null ? void 0 : _b[1]) != null ? _d : (_c = /(?:^|;)http=([^;]+)/i.exec(value)) == null ? void 0 : _c[1]) != null ? _e : value : value;
    const trimmed = chosen.trim();
    cachedSystemProxy = trimmed === "" ? null : trimmed;
    return cachedSystemProxy != null ? cachedSystemProxy : void 0;
  } catch {
    return void 0;
  }
}
function resolveProxy(targetHost) {
  var _a;
  if (bypassed(targetHost, (_a = process.env.NO_PROXY) != null ? _a : process.env.no_proxy))
    return void 0;
  for (const key3 of PROXY_ENV_KEYS) {
    const proxy = parseProxy(process.env[key3]);
    if (proxy !== void 0)
      return proxy;
  }
  return parseProxy(windowsSystemProxy());
}
function connectViaProxy(proxy, host, port) {
  return new Promise((resolve12, reject) => {
    const secureProxy = proxy.protocol === "https:";
    const requestFn = secureProxy ? import_node_https.request : import_node_http.request;
    const headers = { host: `${host}:${port}` };
    if (proxy.username !== "" || proxy.password !== "") {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["proxy-authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }
    const req = requestFn({
      host: proxy.hostname,
      port: Number(proxy.port || (secureProxy ? 443 : 80)),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      timeout: REQUEST_TIMEOUT_MS
    });
    req.once("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT refused: HTTP ${String(res.statusCode)}`));
        return;
      }
      if (head.length > 0)
        socket.unshift(head);
      resolve12(socket);
    });
    req.once("timeout", () => req.destroy(new Error("proxy CONNECT timed out")));
    req.once("error", reject);
    req.end();
  });
}
function wrapTls(socket, host) {
  return new Promise((resolve12, reject) => {
    const tls = (0, import_node_tls.connect)({ socket, servername: host, ALPNProtocols: ["http/1.1"] });
    tls.once("secureConnect", () => resolve12(tls));
    tls.once("error", reject);
  });
}
function tunnelAgent(socket) {
  const agent = new import_node_https.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => socket;
  return agent;
}
async function requestBuffer(url, init, hops = 0) {
  const target = new URL(url);
  const secure = target.protocol === "https:";
  const port = Number(target.port || (secure ? 443 : 80));
  const path = `${target.pathname}${target.search}`;
  const headers = { "user-agent": "helm-d", host: target.host, ...init.headers };
  const proxy = resolveProxy(target.hostname);
  let agent;
  if (proxy !== void 0) {
    const raw = await connectViaProxy(proxy, target.hostname, port);
    agent = tunnelAgent(secure ? await wrapTls(raw, target.hostname) : raw);
  }
  return await new Promise((resolve12, reject) => {
    const requestFn = secure ? import_node_https.request : import_node_http.request;
    const req = requestFn({
      host: target.hostname,
      port,
      path,
      method: init.method,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      ...agent !== void 0 ? { agent } : {}
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.once("end", () => {
        var _a;
        const status = (_a = res.statusCode) != null ? _a : 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && typeof location === "string" && location !== "") {
          if (hops >= 5) {
            reject(new Error(`too many redirects: ${target.hostname}`));
            return;
          }
          if (init.method !== "GET" && init.method !== "HEAD" && status !== 307 && status !== 308) {
            reject(new Error(`refusing to redirect ${init.method} with HTTP ${String(status)}`));
            return;
          }
          let next;
          try {
            next = new URL(location, target);
          } catch {
            reject(new Error(`invalid redirect from ${target.hostname}`));
            return;
          }
          const nextHeaders = { ...init.headers };
          if (next.hostname !== target.hostname)
            delete nextHeaders.authorization;
          resolve12(requestBuffer(next.href, { ...init, headers: nextHeaders }, hops + 1));
          return;
        }
        resolve12({ status, buffer: Buffer.concat(chunks) });
      });
      res.once("error", reject);
    });
    req.once("timeout", () => req.destroy(new Error(`request timed out: ${target.hostname}`)));
    req.once("error", reject);
    if (init.body !== void 0)
      req.write(init.body);
    req.end();
  });
}
async function requestText(url, init) {
  const response = await requestBuffer(url, init);
  return { status: response.status, text: response.buffer.toString("utf8") };
}

// src/toolbox/registry.js
var import_node_fs3 = require("fs");
var import_node_path11 = require("path");

// src/nox-home.js
var import_node_os2 = require("os");
var import_node_path10 = require("path");
function guruHome() {
  const env = process.env.AICODE_HOME;
  if (env !== void 0 && env.trim() !== "")
    return env.trim();
  return (0, import_node_path10.join)((0, import_node_os2.homedir)(), ".guru");
}
function dataDir(...parts) {
  const root = process.env.AICODE_DATA_DIR || (0, import_node_path10.join)(guruHome(), "plugins", "data", "jinghan.toolbox");
  return (0, import_node_path10.join)(root, ...parts);
}

// src/runtime-paths.js
function runtimeStateDir() {
  var _a;
  const env = (_a = process.env.HELMD_TOOLS_DIR) == null ? void 0 : _a.trim();
  if (env)
    return env;
  return dataDir("tools");
}

// src/toolbox/registry.js
function toolboxRoot() {
  return (0, import_node_path11.join)(runtimeStateDir(), "catalog");
}
function registryPath() {
  return (0, import_node_path11.join)(runtimeStateDir(), "registry.json");
}
function loadRegistry() {
  try {
    const parsed = JSON.parse((0, import_node_fs3.readFileSync)(registryPath(), "utf8"));
    return { tools: parsed && typeof parsed.tools === "object" && parsed.tools !== null ? parsed.tools : {} };
  } catch {
    return { tools: {} };
  }
}
function saveRegistry(registry) {
  const path = registryPath();
  (0, import_node_fs3.mkdirSync)((0, import_node_path11.dirname)(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  (0, import_node_fs3.writeFileSync)(temp, JSON.stringify(registry, null, 2), "utf8");
  (0, import_node_fs3.renameSync)(temp, path);
}
function installedTool(id) {
  return loadRegistry().tools[id];
}
function upsertInstalled(tool) {
  const registry = loadRegistry();
  registry.tools[tool.id] = tool;
  saveRegistry(registry);
}
function removeInstalled(id) {
  const registry = loadRegistry();
  const tool = registry.tools[id];
  if (tool === void 0)
    return void 0;
  delete registry.tools[id];
  saveRegistry(registry);
  return tool;
}
function toolDir(id, version) {
  const safeVersion = version.replace(/[^A-Za-z0-9._-]+/g, "_");
  return (0, import_node_path11.join)(toolboxRoot(), id, safeVersion);
}

// src/toolbox/installer.js
var ARCHIVE_RE = /\.(zip|tar\.gz|tgz|tar|tar\.xz|jar|exe)$/i;
var MAX_ASSET_BYTES = 512 * 1024 * 1024;
function ownerRepo(repo) {
  if (!isGithubRepo(repo))
    throw new Error(`not a GitHub repository: ${repo}`);
  const parts = repo.replace(/\/$/, "").split("/");
  return { owner: parts[3], repo: parts[4] };
}
function ghHeaders() {
  var _a;
  const token = (_a = process.env.GITHUB_TOKEN) == null ? void 0 : _a.trim();
  return {
    accept: "application/vnd.github+json",
    ...token !== void 0 && token !== "" ? { authorization: `Bearer ${token}` } : {}
  };
}
async function latestRelease(entry) {
  const { owner, repo } = ownerRepo(entry.repo);
  const releasePath = entry.tag !== void 0 && entry.tag !== "" ? `releases/tags/${encodeURIComponent(entry.tag)}` : "releases/latest";
  const response = await requestText(`https://api.github.com/repos/${owner}/${repo}/${releasePath}`, {
    method: "GET",
    headers: ghHeaders()
  });
  if (response.status !== 200)
    throw new Error(`GitHub release lookup for ${owner}/${repo} failed: HTTP ${response.status}`);
  const data = JSON.parse(response.text);
  const tag = typeof data.tag_name === "string" ? data.tag_name : "";
  if (tag === "")
    throw new Error(`release for ${owner}/${repo} carries no tag`);
  const assets = (Array.isArray(data.assets) ? data.assets : []).filter((asset) => asset.state !== "incomplete" && typeof asset.name === "string" && typeof asset.browser_download_url === "string").map((asset) => {
    var _a;
    return {
      name: String(asset.name),
      size: Number((_a = asset.size) != null ? _a : 0),
      digest: typeof asset.digest === "string" ? asset.digest : null,
      url: String(asset.browser_download_url)
    };
  });
  return { tag, assets };
}
function chooseAsset(assets, requested, pattern) {
  if (requested !== void 0 && requested !== "") {
    const exact = assets.find((asset) => asset.name === requested);
    if (exact === void 0)
      throw new Error(`release has no asset named ${requested}`);
    if (exact.digest === null)
      throw new Error(`asset ${exact.name} has no GitHub sha256 digest; refusing an unhashed install`);
    return exact;
  }
  if (pattern !== void 0 && pattern !== "") {
    let matcher;
    try {
      matcher = new RegExp(pattern);
    } catch {
      throw new Error(`catalog assetPattern is not a valid regex: ${pattern}`);
    }
    const matched = assets.filter((asset) => matcher.test(asset.name));
    if (matched.length === 0)
      throw new Error(`release has no asset matching ${pattern}; pass assetName`);
    if (matched.length > 1)
      throw new Error(`asset pattern ${pattern} is ambiguous (${matched.map((asset) => asset.name).join(", ")}); pass assetName`);
    if (matched[0].digest === null)
      throw new Error(`asset ${matched[0].name} has no GitHub sha256 digest; refusing an unhashed install`);
    return matched[0];
  }
  const candidates = assets.filter((asset) => asset.digest !== null && ARCHIVE_RE.test(asset.name));
  if (candidates.length === 1)
    return candidates[0];
  if (candidates.length === 0)
    throw new Error("release has no digest-pinned archive asset; install manually");
  throw new Error(`release has multiple assets (${candidates.map((asset) => asset.name).join(", ")}); pass assetName`);
}
function sha256File(path) {
  return new Promise((resolve12, reject) => {
    const hash = (0, import_node_crypto2.createHash)("sha256");
    const stream = (0, import_node_fs4.createReadStream)(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve12(hash.digest("hex")));
    stream.once("error", reject);
  });
}
function assertNoEscapingLinks(dir) {
  for (const name of (0, import_node_fs4.readdirSync)(dir)) {
    const path = (0, import_node_path12.join)(dir, name);
    const stat = (0, import_node_fs4.lstatSync)(path);
    if (stat.isSymbolicLink())
      throw new Error(`archive contains a symlink (${name}); refusing to install`);
    if (stat.isDirectory())
      assertNoEscapingLinks(path);
  }
}
function runExtractor(command, args, cwd) {
  var _a;
  const result = (0, import_node_child_process3.spawnSync)(command, args, { cwd, timeout: 12e4, encoding: "utf8" });
  if (result.error !== void 0)
    throw new Error(`archive extraction failed: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`archive extraction failed: ${String((_a = result.stderr) != null ? _a : "").trim() || `${command} exit ${String(result.status)}`}`);
}
function extract(archivePath, destDir) {
  var _a;
  const systemTar = process.platform === "win32" ? (0, import_node_path12.join)((_a = process.env.SystemRoot) != null ? _a : "C:\\Windows", "System32", "tar.exe") : void 0;
  if (systemTar !== void 0 && (0, import_node_fs4.existsSync)(systemTar)) {
    runExtractor(systemTar, ["-xf", (0, import_node_path12.basename)(archivePath), "-C", destDir], (0, import_node_path12.dirname)(archivePath));
    return;
  }
  if (/\.zip$/i.test(archivePath)) {
    runExtractor("unzip", ["-o", archivePath, "-d", destDir]);
    return;
  }
  runExtractor("tar", ["-xf", (0, import_node_path12.basename)(archivePath), "-C", destDir], (0, import_node_path12.dirname)(archivePath));
}
async function installCatalogTool(id, assetName) {
  var _a, _b;
  const entry = catalogEntry(id);
  if (entry === void 0)
    throw new Error(`unknown catalog tool: ${id}`);
  if (entry.kind !== "release")
    throw new Error(`${entry.name} is a ${entry.kind} tool; use: ${(_a = entry.installHint) != null ? _a : entry.usage}`);
  const existing = installedTool(id);
  if (existing !== void 0)
    return existing;
  const release = await latestRelease(entry);
  const asset = chooseAsset(release.assets, assetName != null ? assetName : entry.asset, entry.assetPattern);
  if (asset.size > MAX_ASSET_BYTES)
    throw new Error(`asset is larger than ${MAX_ASSET_BYTES} bytes; install manually`);
  const root = toolboxRoot();
  (0, import_node_fs4.mkdirSync)(root, { recursive: true });
  const tempDir = (0, import_node_path12.join)(root, ".tmp", `${id}-${Date.now()}`);
  (0, import_node_fs4.mkdirSync)(tempDir, { recursive: true });
  const archivePath = (0, import_node_path12.join)(tempDir, (0, import_node_path12.basename)(asset.name));
  try {
    const response = await requestBuffer(asset.url, { method: "GET", headers: { accept: "application/octet-stream" } });
    if (response.status !== 200)
      throw new Error(`asset download failed: HTTP ${response.status}`);
    if (response.buffer.length > MAX_ASSET_BYTES)
      throw new Error("downloaded asset exceeds the size cap");
    (0, import_node_fs4.writeFileSync)(archivePath, response.buffer);
    const actual = await sha256File(archivePath);
    const expected = (_b = asset.digest) == null ? void 0 : _b.replace(/^sha256:/i, "").toLowerCase();
    if (expected === void 0 || expected === "" || actual !== expected) {
      throw new Error(`sha256 mismatch for ${asset.name}: expected ${expected != null ? expected : "(none)"}, got ${actual}`);
    }
    const extractDir = (0, import_node_path12.join)(tempDir, "x");
    (0, import_node_fs4.mkdirSync)(extractDir, { recursive: true });
    if (/\.(zip|tar\.gz|tgz|tar|tar\.xz)$/i.test(asset.name))
      extract(archivePath, extractDir);
    else
      (0, import_node_fs4.copyFileSync)(archivePath, (0, import_node_path12.join)(extractDir, (0, import_node_path12.basename)(asset.name)));
    assertNoEscapingLinks(extractDir);
    const dest = toolDir(id, release.tag);
    assertWithinRoot(dest, root);
    if ((0, import_node_fs4.existsSync)(dest))
      throw new Error(`install directory already exists: ${dest}`);
    (0, import_node_fs4.mkdirSync)((0, import_node_path12.join)(dest, ".."), { recursive: true });
    (0, import_node_fs4.renameSync)(extractDir, dest);
    const tool = {
      id,
      name: entry.name,
      repo: entry.repo,
      version: release.tag,
      path: dest,
      assetName: asset.name,
      sha256: actual,
      installedAt: new Date().toISOString()
    };
    upsertInstalled(tool);
    return tool;
  } finally {
    (0, import_node_fs4.rmSync)(tempDir, { recursive: true, force: true });
  }
}
async function updateCatalogTool(id, assetName) {
  var _a;
  const existing = installedTool(id);
  if (existing === void 0)
    return installCatalogTool(id, assetName);
  const entry = catalogEntry(id);
  if (entry === void 0)
    throw new Error(`unknown catalog tool: ${id}`);
  if (entry.kind !== "release")
    throw new Error(`${entry.name} is a ${entry.kind} tool; use: ${(_a = entry.installHint) != null ? _a : entry.usage}`);
  const backup = `${existing.path}.old-${Date.now()}`;
  let moved = false;
  if ((0, import_node_fs4.existsSync)(existing.path)) {
    (0, import_node_fs4.renameSync)(existing.path, backup);
    moved = true;
  }
  removeInstalled(id);
  try {
    const installed = await installCatalogTool(id, assetName);
    if (moved)
      (0, import_node_fs4.rmSync)(backup, { recursive: true, force: true });
    if (installed.path !== existing.path && (0, import_node_fs4.existsSync)(existing.path))
      (0, import_node_fs4.rmSync)(existing.path, { recursive: true, force: true });
    return installed;
  } catch (error) {
    upsertInstalled(existing);
    if (moved && !(0, import_node_fs4.existsSync)(existing.path))
      (0, import_node_fs4.renameSync)(backup, existing.path);
    else if (moved)
      (0, import_node_fs4.rmSync)(backup, { recursive: true, force: true });
    throw error;
  }
}
async function installCatalogMirror(id, archivePath, sha256) {
  var _a;
  const entry = catalogEntry(id);
  if (entry === void 0)
    throw new Error(`unknown catalog tool: ${id}`);
  if (entry.kind !== "release")
    throw new Error(`${entry.name} is a ${entry.kind} tool; use: ${(_a = entry.installHint) != null ? _a : entry.usage}`);
  const expected = sha256.trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(expected))
    throw new Error("sha256 must be 64 hex characters");
  const source = (0, import_node_path12.join)(archivePath);
  if (!(0, import_node_fs4.existsSync)(source))
    throw new Error(`mirror archive not found: ${source}`);
  const bytes = (0, import_node_fs4.readFileSync)(source);
  if (bytes.length > MAX_ASSET_BYTES)
    throw new Error(`mirror archive is larger than ${MAX_ASSET_BYTES} bytes`);
  const actual = (0, import_node_crypto2.createHash)("sha256").update(bytes).digest("hex");
  if (actual !== expected)
    throw new Error(`sha256 mismatch for mirror: expected ${expected}, got ${actual}`);
  const root = toolboxRoot();
  (0, import_node_fs4.mkdirSync)(root, { recursive: true });
  const tempDir = (0, import_node_path12.join)(root, ".tmp", `${id}-mirror-${Date.now()}`);
  (0, import_node_fs4.mkdirSync)(tempDir, { recursive: true });
  try {
    const local = (0, import_node_path12.join)(tempDir, (0, import_node_path12.basename)(archivePath));
    (0, import_node_fs4.writeFileSync)(local, bytes);
    const extractDir = (0, import_node_path12.join)(tempDir, "x");
    (0, import_node_fs4.mkdirSync)(extractDir, { recursive: true });
    if (/\.(zip|tar\.gz|tgz|tar|tar\.xz)$/i.test(local))
      extract(local, extractDir);
    else
      (0, import_node_fs4.copyFileSync)(local, (0, import_node_path12.join)(extractDir, (0, import_node_path12.basename)(archivePath)));
    assertNoEscapingLinks(extractDir);
    const version = `mirror-${actual.slice(0, 8)}`;
    const dest = toolDir(id, version);
    assertWithinRoot(dest, root);
    if ((0, import_node_fs4.existsSync)(dest))
      throw new Error(`install directory already exists: ${dest}`);
    (0, import_node_fs4.mkdirSync)((0, import_node_path12.join)(dest, ".."), { recursive: true });
    (0, import_node_fs4.renameSync)(extractDir, dest);
    const tool = {
      id,
      name: entry.name,
      repo: entry.repo,
      version,
      path: dest,
      assetName: (0, import_node_path12.basename)(archivePath),
      sha256: actual,
      installedAt: new Date().toISOString()
    };
    upsertInstalled(tool);
    return tool;
  } finally {
    (0, import_node_fs4.rmSync)(tempDir, { recursive: true, force: true });
  }
}
function toolHealth(id) {
  const tool = installedTool(id);
  if (tool === void 0)
    return { installed: false };
  return { installed: true, version: tool.version, path: tool.path, present: (0, import_node_fs4.existsSync)(tool.path) && (0, import_node_fs4.statSync)(tool.path).isDirectory() };
}

// src/toolbox/health.js
var import_node_child_process4 = require("child_process");
var ttlMs = 5 * 60 * 1e3;
var maxEntries = 64;
var cache2 = /* @__PURE__ */ new Map();
function probeCommand(command) {
  var _a, _b;
  const name = command.trim();
  if (name === "")
    throw new Error("command is required");
  const hit = cache2.get(name);
  if (hit !== void 0 && Date.now() - Date.parse(hit.at) < ttlMs)
    return hit;
  const finder = process.platform === "win32" ? "where" : "which";
  const result = (0, import_node_child_process4.spawnSync)(finder, [name], { encoding: "utf8", timeout: 5e3 });
  const path = result.status === 0 ? (_b = String((_a = result.stdout) != null ? _a : "").split(/\r?\n/).find((line) => line.trim() !== "")) == null ? void 0 : _b.trim() : void 0;
  const probe = {
    command: name,
    status: path === void 0 ? "missing" : "verified",
    ...path !== void 0 ? { path } : {},
    at: new Date().toISOString()
  };
  cache2.set(name, probe);
  if (cache2.size > maxEntries) {
    const oldest = [...cache2.entries()].sort((a, b) => a[1].at.localeCompare(b[1].at))[0];
    if (oldest !== void 0)
      cache2.delete(oldest[0]);
  }
  return probe;
}

// src/settings.js
var import_node_fs6 = require("fs");
var import_node_os3 = require("os");
var import_node_path14 = require("path");

// src/team.js
var import_node_fs5 = require("fs");
var import_node_path13 = require("path");
var TEAM_ROLES = ["orchestrator", "triage", "static", "dynamic", "decoy-audit", "critic", "reporter"];
var DEFAULT_ROLES = ["triage", "static", "critic", "reporter"];
function configuredDefaultRoles() {
  try {
    const roles = loadSettings().team.defaultRoles;
    const valid = roles.filter((role) => TEAM_ROLES.includes(role));
    if (valid.length > 0)
      return valid;
  } catch {
  }
  return DEFAULT_ROLES;
}
function teamDir() {
  return (0, import_node_path13.normalize)(dataDir("team"));
}
function statePath() {
  return (0, import_node_path13.join)(teamDir(), "state.json");
}
var lockDepth = 0;
var sleepCell = new Int32Array(new SharedArrayBuffer(4));
function withStoreLock(fn) {
  if (lockDepth > 0)
    return fn();
  (0, import_node_fs5.mkdirSync)(teamDir(), { recursive: true });
  const lock = (0, import_node_path13.join)(teamDir(), "state.lock");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const fd = (0, import_node_fs5.openSync)(lock, "wx");
      lockDepth += 1;
      try {
        return fn();
      } finally {
        lockDepth -= 1;
        (0, import_node_fs5.closeSync)(fd);
        try {
          (0, import_node_fs5.unlinkSync)(lock);
        } catch {
        }
      }
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      Atomics.wait(sleepCell, 0, 0, 10);
    }
  }
  throw new Error("team state is locked by another process; retry");
}
function readJson(path, fallback) {
  try {
    return JSON.parse((0, import_node_fs5.readFileSync)(path, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(path, value) {
  (0, import_node_fs5.mkdirSync)((0, import_node_path13.dirname)(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  (0, import_node_fs5.writeFileSync)(temp, JSON.stringify(value, null, 2), "utf8");
  (0, import_node_fs5.renameSync)(temp, path);
}
function now() {
  return new Date().toISOString();
}
function nextId(prefix, existing) {
  const max = existing.reduce((best, item) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(item.id);
    return match ? Math.max(best, Number(match[1])) : best;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}
function loadState() {
  const state = readJson(statePath(), { tickets: [] });
  const tickets = Array.isArray(state.tickets) ? state.tickets : [];
  return {
    tickets: tickets.map((ticket) => ({
      ...ticket,
      artifactRevisions: ticket.artifactRevisions && typeof ticket.artifactRevisions === "object" ? ticket.artifactRevisions : {},
      roleDeps: ticket.roleDeps && typeof ticket.roleDeps === "object" ? ticket.roleDeps : void 0,
      tasks: Array.isArray(ticket.tasks) ? ticket.tasks.map((task) => ({
        ...task,
        blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy : []
      })) : void 0,
      steers: Array.isArray(ticket.steers) ? ticket.steers : void 0
    }))
  };
}
function saveState(state) {
  writeJson(statePath(), state);
}
function listTickets() {
  return loadState().tickets.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function getTicket(id) {
  return loadState().tickets.find((ticket) => ticket.id === id);
}
function updateTicket(id, mutate) {
  return withStoreLock(() => {
    const state = loadState();
    const ticket = state.tickets.find((item) => item.id === id);
    if (ticket === void 0)
      throw new Error(`unknown ticket ${id}`);
    mutate(ticket);
    ticket.updatedAt = now();
    saveState(state);
    return ticket;
  });
}
function sessionRole(sessionId) {
  if (sessionId === void 0 || sessionId === "")
    return void 0;
  for (const ticket of loadState().tickets) {
    const assignment = ticket.roles.find((role) => role.sessionId === sessionId);
    if (assignment !== void 0)
      return assignment.role;
  }
  return void 0;
}
function scaffoldCaseDir(caseDir, goal) {
  try {
    if ((0, import_node_fs5.existsSync)((0, import_node_path13.join)(caseDir, "CASE.md")))
      return;
    (0, import_node_fs5.mkdirSync)((0, import_node_path13.join)(caseDir, "evidence"), { recursive: true });
    (0, import_node_fs5.writeFileSync)((0, import_node_path13.join)(caseDir, "CASE.md"), [
      "status: open",
      `goal: ${goal}`,
      "mode: full",
      "route: team",
      "",
      "## timeline",
      `- [${now()}] ticket workspace scaffolded (team)`,
      "",
      "## resume",
      "- workspace created by the team rail; workers report through the ticket",
      ""
    ].join("\n"), "utf8");
  } catch {
  }
}
function createTicket(input) {
  const goal = input.goal.trim();
  const caseDir = input.caseDir.trim();
  if (goal === "")
    throw new Error("goal is required");
  if (caseDir === "")
    throw new Error("caseDir is required");
  scaffoldCaseDir(caseDir, goal);
  return withStoreLock(() => {
    var _a, _b;
    const state = loadState();
    const roles = input.roles && input.roles.length > 0 ? input.roles : configuredDefaultRoles();
    const unique = [...new Set(roles)].filter((role) => TEAM_ROLES.includes(role));
    if (unique.length === 0)
      throw new Error("at least one valid role is required");
    const timestamp = now();
    const roleTaskIds = new Map(unique.map((role, index) => [role, `TK-${String(index + 1).padStart(3, "0")}`]));
    const taskInputs = input.tasks !== void 0 && input.tasks.length > 0 ? input.tasks : unique.map((role) => {
      var _a2, _b2;
      return {
        role,
        blockedBy: ((_b2 = (_a2 = input.roleDeps) == null ? void 0 : _a2[role]) != null ? _b2 : []).map((dep) => roleTaskIds.get(dep)).filter((id) => id !== void 0)
      };
    });
    const tasks = taskInputs.map((task, index) => {
      var _a2, _b2, _c;
      return {
        id: (_a2 = task.id) != null ? _a2 : `TK-${String(index + 1).padStart(3, "0")}`,
        role: task.role,
        blockedBy: [...new Set((_b2 = task.blockedBy) != null ? _b2 : [])],
        state: ((_c = task.blockedBy) != null ? _c : []).length > 0 ? "blocked" : "ready",
        createdAt: timestamp,
        updatedAt: timestamp
      };
    });
    const ticket = {
      id: nextId("T", state.tickets),
      goal,
      caseDir,
      state: "open",
      revision: (_a = input.revision) != null ? _a : 0,
      artifactRevisions: { ...(_b = input.artifactRevisions) != null ? _b : {} },
      ...input.roleDeps !== void 0 ? { roleDeps: input.roleDeps } : {},
      ...input.budget !== void 0 ? { budget: input.budget } : {},
      ...tasks.length > 0 ? { tasks } : {},
      roles: unique.map((role) => ({ role, state: "idle" })),
      reports: [],
      handoffs: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state.tickets.push(ticket);
    saveState(state);
    return ticket;
  });
}
function recordSteer(ticketId, role, message) {
  const text = message.trim();
  if (text === "")
    throw new Error("steer message is required");
  return withStoreLock(() => {
    var _a, _b;
    const state = loadState();
    const ticket = state.tickets.find((item) => item.id === ticketId);
    if (ticket === void 0)
      throw new Error(`unknown ticket ${ticketId}`);
    const steer = {
      id: nextId("S", (_a = ticket.steers) != null ? _a : []),
      role,
      message: text.slice(0, 4e3),
      at: now()
    };
    ticket.steers = [...(_b = ticket.steers) != null ? _b : [], steer];
    ticket.updatedAt = steer.at;
    saveState(state);
    return steer;
  });
}
function recordReport(input) {
  const summary = input.summary.trim();
  if (summary === "")
    throw new Error("summary is required");
  return updateTicket(input.ticketId, (ticket) => {
    var _a, _b, _c;
    const assignment = ticket.roles.find((item) => item.role === input.role);
    if (assignment === void 0)
      throw new Error(`role ${input.role} is not part of ticket ${input.ticketId}`);
    const last = [...ticket.reports].reverse().find((report2) => report2.role === input.role);
    if (last !== void 0 && last.state === input.state && last.summary === summary) {
      return ticket;
    }
    const report = {
      id: nextId("R", ticket.reports),
      role: input.role,
      state: input.state,
      summary,
      evidenceIds: [...new Set((_a = input.evidenceIds) != null ? _a : [])],
      ...input.repro !== void 0 && input.repro.trim() !== "" ? { repro: input.repro.trim() } : {},
      ...input.budget !== void 0 ? { budget: input.budget } : {},
      ...input.tokens !== void 0 ? { tokens: input.tokens } : {},
      ...input.wallTimeMs !== void 0 ? { wallTimeMs: input.wallTimeMs } : {},
      ...input.source !== void 0 ? { source: input.source } : {},
      ...input.stopReason !== void 0 ? { stopReason: input.stopReason } : {},
      at: now()
    };
    ticket.reports.push(report);
    const claimedTask = [...(_b = ticket.tasks) != null ? _b : []].reverse().find((task) => task.role === input.role && (task.state === "claimed" || task.state === "ready") && (task.owner === void 0 || task.owner === input.role));
    if (claimedTask !== void 0) {
      if (input.state === "ready") {
        claimedTask.state = "done";
        claimedTask.owner = void 0;
        claimedTask.leaseUntil = void 0;
        claimedTask.updatedAt = now();
        for (const candidate of (_c = ticket.tasks) != null ? _c : []) {
          if (candidate.state === "blocked" && candidate.blockedBy.every((id) => {
            var _a2, _b2;
            return ((_b2 = (_a2 = ticket.tasks) == null ? void 0 : _a2.find((task) => task.id === id)) == null ? void 0 : _b2.state) === "done";
          })) {
            candidate.state = "ready";
            candidate.updatedAt = now();
          }
        }
      } else if (input.state === "blocked" || input.state === "failed" || input.state === "dropped") {
        claimedTask.state = input.state === "failed" ? "failed" : "blocked";
        claimedTask.owner = void 0;
        claimedTask.leaseUntil = void 0;
        claimedTask.updatedAt = now();
      }
    }
    if (input.state === "blocked" || input.state === "failed")
      ticket.state = "blocked";
    else if (input.state === "dropped")
      ticket.state = "dropped";
    else if (input.state === "ready" && input.role === "reporter")
      ticket.state = "review";
    else if (ticket.state === "open")
      ticket.state = "working";
    if (input.state === "ready" || input.state === "dropped" || input.state === "failed") {
      assignment.state = "done";
      assignment.endedAt = now();
    }
  });
}

// src/settings.js
var DEFAULT_SETTINGS = {
  team: {
    autoTicket: false,
    defaultRoles: ["triage", "static", "critic", "reporter"],
    maxParallelWorkers: 4,
    defaultWallTimeMin: 15,
    riskApproval: "ask",
    approvalTimeoutSec: 300,
    roleToolPolicy: {}
  },
  toolbox: { modelInstall: false }
};
function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n))
    return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
function clampBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function normalizeSettings(raw) {
  const src = raw !== null && typeof raw === "object" ? raw : {};
  const team = src.team !== null && typeof src.team === "object" ? src.team : {};
  const roles = Array.isArray(team.defaultRoles) ? [...new Set(team.defaultRoles.map(String))].filter((role) => TEAM_ROLES.includes(role)) : [];
  const roleToolPolicy = {};
  if (team.roleToolPolicy !== null && typeof team.roleToolPolicy === "object") {
    for (const [role, rawPolicy] of Object.entries(team.roleToolPolicy)) {
      if (!TEAM_ROLES.includes(role) || rawPolicy === null || typeof rawPolicy !== "object")
        continue;
      const allow = Array.isArray(rawPolicy.allow) ? rawPolicy.allow.map(String).filter(Boolean) : void 0;
      const deny = Array.isArray(rawPolicy.deny) ? rawPolicy.deny.map(String).filter(Boolean) : void 0;
      if (allow !== void 0 && allow.length > 0 || deny !== void 0 && deny.length > 0) {
        roleToolPolicy[role] = {
          ...allow !== void 0 && allow.length > 0 ? { allow } : {},
          ...deny !== void 0 && deny.length > 0 ? { deny } : {}
        };
      }
    }
  }
  const riskApproval = team.riskApproval === "deny" || team.riskApproval === "allow" ? team.riskApproval : "ask";
  const d = DEFAULT_SETTINGS;
  return {
    team: {
      autoTicket: clampBool(team.autoTicket, d.team.autoTicket),
      defaultRoles: roles.length > 0 ? roles : [...d.team.defaultRoles],
      maxParallelWorkers: clampNumber(team.maxParallelWorkers, 1, 8, d.team.maxParallelWorkers),
      defaultWallTimeMin: clampNumber(team.defaultWallTimeMin, 1, 60, d.team.defaultWallTimeMin),
      riskApproval,
      approvalTimeoutSec: clampNumber(team.approvalTimeoutSec, 1, 3600, d.team.approvalTimeoutSec),
      roleToolPolicy
    },
    toolbox: { modelInstall: clampBool(src.toolbox !== null && typeof src.toolbox === "object" ? src.toolbox.modelInstall : void 0, d.toolbox.modelInstall) }
  };
}
function settingsPath() {
  const data = process.env.AICODE_DATA_DIR || (0, import_node_path14.join)(process.env.AICODE_HOME || (0, import_node_path14.join)((0, import_node_os3.homedir)(), ".guru"), "plugins", "data", "jinghan.toolbox");
  return (0, import_node_path14.normalize)((0, import_node_path14.join)(data, "settings.json"));
}
function loadSettings() {
  try {
    return normalizeSettings(JSON.parse((0, import_node_fs6.readFileSync)(settingsPath(), "utf8")));
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

// src/tools/toolbox.js
var refRoot7 = (0, import_node_path15.join)(packageRoot2(), "references", "toolbox");
var rules = {
  tool: "\u5DE5\u5177\u83B7\u53D6: \u5148\u67E5\u672C\u673A(where/Get-Command/--version) \u2192 \u6709\u5219\u76F4\u63A5\u7528\u5E76\u8BB0\u7248\u672C\u8DEF\u5F84 \u2192 \u65E0\u5219\u9664 C \u76D8\u5916\u6700\u5927\u76D8\u5EFA X:\\Reverse\\ \u4E0B\u8F7D \u2192 \u8D85\u65F6\u5148\u63A2\u672C\u673A\u4EE3\u7406\uFF0C\u63A2\u4E0D\u5230\u5C31\u76F4\u8FDE \u2192 \u8BE6\u89C1 references/toolbox/tool-install.md",
  install: "\u5DE5\u5177\u83B7\u53D6: \u5148\u67E5\u672C\u673A \u2192 \u65E0\u5219\u9664 C \u5916\u6700\u5927\u76D8 X:\\Reverse\\ \u2192 \u8D85\u65F6\u5148\u63A2\u672C\u673A\u4EE3\u7406\uFF0C\u63A2\u4E0D\u5230\u5C31\u76F4\u8FDE \u2192 \u8BE6\u89C1 references/toolbox/tool-install.md",
  download: "\u5DE5\u5177\u83B7\u53D6: \u5148\u67E5\u672C\u673A \u2192 \u65E0\u5219\u9664 C \u5916\u6700\u5927\u76D8 X:\\Reverse\\ \u2192 \u8D85\u65F6\u5148\u63A2\u672C\u673A\u4EE3\u7406\uFF0C\u63A2\u4E0D\u5230\u5C31\u76F4\u8FDE \u2192 \u8BE6\u89C1 references/toolbox/tool-install.md",
  proxy: "\u51FA\u7AD9\u901A\u9053: \u5148\u76F4\u8FDE\u4E00\u6B21 \u2192 \u5931\u8D25\u5219\u63A2\u73AF\u5883\u53D8\u91CF/\u7CFB\u7EDF\u8BBE\u7F6E/\u56DE\u73AF\u76D1\u542C\u7AEF\u53E3\uFF0C\u9010\u4E2A\u7528\u63A7\u5236\u8BF7\u6C42\u9A8C\u8BC1 \u2192 \u5168\u90E8\u5931\u8D25\u56DE\u9000\u76F4\u8FDE+\u6362\u6E90 \u2192 \u9776\u673A\u4E0E\u5185\u7F51\u5730\u5740\u6C38\u4E0D\u8D70\u4EE3\u7406 \u2192 \u8BE6\u89C1 references/toolbox/network-egress.md",
  timeout: "\u51FA\u7AD9\u901A\u9053: \u76F4\u8FDE\u5931\u8D25\u540E\u63A2\u672C\u673A\u53EF\u7528\u4EE3\u7406(\u9A8C\u8BC1\u901A\u8FC7\u624D\u7528)\uFF0C\u63A2\u4E0D\u5230\u5C31\u76F4\u8FDE+\u6362\u6E90\uFF0C\u4E0D\u8981\u731C\u7AEF\u53E3 \u2192 \u8BE6\u89C1 references/toolbox/network-egress.md",
  network: "\u51FA\u7AD9\u901A\u9053: \u76F4\u8FDE\u4F18\u5148\uFF0C\u5931\u8D25\u540E\u6309 \u73AF\u5883\u53D8\u91CF\u2192\u7CFB\u7EDF\u8BBE\u7F6E\u2192\u56DE\u73AF\u7AEF\u53E3 \u53D1\u73B0\u4EE3\u7406\u5E76\u9A8C\u8BC1\uFF0C\u5168\u90E8\u5931\u8D25\u56DE\u9000\u76F4\u8FDE+\u6362\u6E90 \u2192 \u8BE6\u89C1 references/toolbox/network-egress.md",
  setup: "\u73AF\u5883\u914D\u7F6E: scoop install apktool/jadx/adb + pip install frida/capstone/unicorn \u2192 \u8BE6\u89C1 references/toolbox/tool-install.md",
  env: "\u73AF\u5883\u914D\u7F6E: scoop install apktool/jadx/adb + pip install frida/capstone/unicorn \u2192 \u8BE6\u89C1 references/toolbox/tool-install.md",
  garlic: "garlic https://github.com/neocanable/garlic/releases \u2014 C \u5B9E\u73B0\u7684\u8D85\u5FEB APK/DEX/JAR \u53CD\u7F16\u8BD1\u5668 + aarch64 ELF \u5206\u6790 | \u4E0B\u8F7D: Releases \u9009\u5E73\u53F0\u4E8C\u8FDB\u5236 | \u9996\u9009: \u5FEB\u901F\u521D\u7B5B/\u5B57\u7B26\u4E32\u641C\u7D22/ELF \u5206\u6790",
  decompile: "garlic https://github.com/neocanable/garlic/releases \u2014 APK/DEX/JAR \u53CD\u7F16\u8BD1 (200MB/12s) | \u4E0B\u8F7D: Releases | \u9996\u9009: \u5FEB\u901F\u521D\u7B5B",
  jadx: "jadx https://github.com/skylot/jadx/releases \u2014 DEX/APK \u2192 Java \u53CD\u7F16\u8BD1 | \u4E0B\u8F7D: Releases \u9009 `jadx-x.x.x.zip` | \u6DF1\u5EA6\u53CD\u7F16\u8BD1/\u4EA4\u53C9\u5F15\u7528",
  dex: "DEX \u2192 garlic https://github.com/neocanable/garlic/releases (\u9996\u9009) | \u66FF\u4EE3: jadx/Fernflower | \u5B58\u8BC1: Java \u6E90\u7801",
  apktool: "apktool https://github.com/ibotpeaches/apktool/releases \u2014 APK \u89E3\u5305/\u91CD\u6253\u5305/smali \u8C03\u8BD5 | \u4E0B\u8F7D: Releases \u9009 `apktool_x.x.x.jar`",
  apk: "APK \u2192 garlic (\u5FEB\u901F\u53CD\u7F16\u8BD1) + apktool (\u89E3\u5305) | \u5B58\u8BC1: Java \u6E90\u7801/smali/manifest",
  mobsf: "MobSF https://github.com/MobSF/Mobile-Security-Framework-MobSF \u2014 \u9759\u6001+\u52A8\u6001\u4E00\u4F53\u5316\u79FB\u52A8\u5E94\u7528\u8BC4\u4F30 | docker run -p 8000:8000 opensecurity/mobile-security-framework-mobsf | \u5B58\u8BC1: \u62A5\u544A/\u6D41\u91CF",
  objection: "objection https://github.com/sensepost/objection \u2014 Frida \u8FD0\u884C\u65F6\u79FB\u52A8\u63A2\u7D22 | pip install objection | objection -g <pkg> explore",
  quark: "Quark Engine https://github.com/ev-flow/quark-engine \u2014 \u5B89\u5353\u6076\u610F\u884C\u4E3A\u8BC4\u5206 | pip install quark-engine | quark -a app.apk -s",
  apkid: "APKiD https://github.com/rednaga/APKiD \u2014 \u58F3/\u4FDD\u62A4\u5668/\u6DF7\u6DC6\u5668\u8BC6\u522B | pip install apkid | apkid app.apk",
  androguard: "androguard https://github.com/androguard/androguard \u2014 pip install androguard | APK \u9759\u6001\u5206\u6790",
  unidbg: "unidbg https://github.com/zhkl0228/unidbg \u2014 Android native SO \u6A21\u62DF\u6267\u884C | \u4E0B\u8F7D: Releases \u6216 mvnw package \u6784\u5EFA",
  emulat: "\u6A21\u62DF\u6267\u884C \u2192 unidbg | \u66FF\u4EE3: angr/unicorn",
  fernflower: "fernflower https://github.com/jetBrains/fernflower \u2014 Java \u5B57\u8282\u7801 \u2192 Java | \u4E0B\u8F7D: Releases \u9009 `fernflower.jar`",
  jar: "JAR \u2192 garlic https://github.com/neocanable/garlic/releases (\u9996\u9009) | \u66FF\u4EE3: fernflower/CFR",
  bytecode: "\u5B57\u8282\u7801 \u2192 fernflower https://github.com/jetBrains/fernflower/releases",
  jvm: "JVM mod \u5E38\u91CF\u52A0\u5BC6 \u2192 scripts/native/jvm/ \u5168\u7BA1\u7EBF (scan_jar/extract/flatten/Oracle/decrypt) + references/native/jvm-mod-deobf-workflow.md | headless JVM oracle \u91CD\u653E\uFF0C\u4E0D\u9006\u5411 PRNG",
  forge: "Forge/Fabric mod \u5E38\u91CF\u52A0\u5BC6 \u2192 references/native/jvm-mod-deobf-workflow.md + scripts/native/jvm/ | \u7279\u5F81: MixinConfigs manifest + emoji/iI \u7C7B\u540D + DESKeySpec \u5171\u73B0",
  mixin: "mixin \u6DF7\u6DC6\u7C7B \u2192 references/native/jvm-mod-deobf-workflow.md \xA71 \u7279\u5F81\u901F\u67E5 + scan_jar.py \u5206\u7C7B",
  des: "DES \u5E38\u91CF\u89E3\u5BC6 (DESKeySpec+IvParameterSpec+DES/CBC/NoPadding \u540C\u7C7B\u5171\u73B0) \u2192 references/native/jvm-mod-deobf-workflow.md + decrypt_sites.py | key = ret ^ xor, \u5927\u7AEF 8B, \u96F6 IV",
  indy: "indy bootstrap \u60F0\u6027\u89E3\u5BC6 (Lookup/MutableCallSite \u7B7E\u540D) \u2192 \u9759\u6001\u4E0D\u53EF\u89E3, \u4FDD\u7559\u8FD0\u884C\u65F6\u539F\u89E3\u5BC6\u5668 | \u5224\u5B9A\u4F9D\u636E: references/native/jvm-mod-deobf-workflow.md \xA76",
  rustfrida: "rustFrida https://github.com/kkkbbb/rustFrida/releases \u2014 Android ARM64 \u52A8\u6001\u63D2\u6869 | \u4E0B\u8F7D: Releases \u9009 ELF ARM64 \u2192 adb push",
  instrument: "\u52A8\u6001\u63D2\u6869 -> rustFrida https://github.com/kkkbbb/rustFrida/releases",
  spawn: "spawn \u6CE8\u5165 -> rustFrida --spawn \u6216 Frida -f",
  "search": '\u5B57\u7B26\u4E32\u641C\u7D22 \u2192 garlic -f "pattern" (\u652F\u6301\u6B63\u5219) | \u4E0B\u8F7D: https://github.com/neocanable/garlic/releases',
  scrapling: "Scrapling https://github.com/d4vinci/Scrapling \u2014 pip install scrapling | \u81EA\u9002\u5E94\u7F51\u9875\u6293\u53D6/\u53CD\u722C",
  scrap: "\u7F51\u9875\u6293\u53D6 \u2192 Scrapling | pip install scrapling",
  crawl: "\u722C\u866B \u2192 Scrapling | pip install scrapling",
  wechat: "WeChat-lm https://github.com/HSGQSRGS/WeChat-lm \u2014 pip install wechat-lm | \u5FAE\u4FE1\u5C0F\u7A0B\u5E8F\u6E17\u900F",
  wxapkg: "\u5FAE\u4FE1\u5C0F\u7A0B\u5E8F\u5305 \u2192 WeChat-lm | pip install wechat-lm",
  miniprogram: "\u5FAE\u4FE1\u5C0F\u7A0B\u5E8F\u9006\u5411 \u2192 WeChat-lm | pip install wechat-lm",
  ip_check: "IP \u5B58\u6D3B\u68C0\u6D4B \u2192 ip_checker https://github.com/test692618/ip_checker/releases | \u4E0B\u8F7D: Releases \u9009\u5E73\u53F0\u4E8C\u8FDB\u5236",
  alive: "\u5B58\u6D3B\u68C0\u6D4B \u2192 ip_checker https://github.com/test692618/ip_checker/releases",
  cipher: "\u52A0\u89E3\u5BC6/\u7B7E\u540D \u2192 CipherBridge https://github.com/CuriousLearnerDev/CipherBridge/releases | \u4E0B\u8F7D: Releases \u9009\u5E73\u53F0\u4E8C\u8FDB\u5236",
  decrypt: "\u89E3\u5BC6 \u2192 CipherBridge https://github.com/CuriousLearnerDev/CipherBridge/releases",
  aes: "AES \u2192 CipherBridge https://github.com/CuriousLearnerDev/CipherBridge/releases",
  sign: "\u7B7E\u540D \u2192 CipherBridge https://github.com/CuriousLearnerDev/CipherBridge/releases",
  nuclei: "Nuclei https://github.com/projectdiscovery/nuclei \u2014 \u6A21\u677F\u5316\u6F0F\u6D1E\u626B\u63CF | UI \u5DE5\u5177\u9875\u76F4\u63A5\u88C5 Windows \u5305 | nuclei -u <target> -severity high,critical",
  ffuf: "ffuf https://github.com/ffuf/ffuf \u2014 Web \u76EE\u5F55/\u53C2\u6570 fuzz | UI \u5DE5\u5177\u9875\u76F4\u63A5\u88C5 Windows \u5305 | ffuf -w wordlist.txt -u https://target/FUZZ",
  mitm: "mitmproxy https://github.com/mitmproxy/mitmproxy \u2014 TLS \u62E6\u622A/\u91CD\u653E | pip install mitmproxy | mitmproxy -p 8080",
  impacket: "Impacket https://github.com/fortra/impacket \u2014 SMB/WMI/Kerberos \u534F\u8BAE\u5DE5\u5177 | pip install impacket | python -m impacket.examples.secretsdump -h",
  netexec: "NetExec https://github.com/Pennyw0rth/NetExec \u2014 \u7F51\u7EDC/AD \u679A\u4E3E\u4E0E\u6267\u884C | pipx install git+https://github.com/Pennyw0rth/NetExec | nxc smb 10.0.0.0/24",
  sqlmap: 'sqlmap https://github.com/sqlmapproject/sqlmap \u2014 SQL \u6CE8\u5165\u68C0\u6D4B/\u5229\u7528 | git clone + python sqlmap.py -u "<url>" --batch',
  "headless-ida": "headless-ida https://github.com/DennyDai/headless-ida \u2014 pip install headless-ida | IDA idalib \u65E0\u754C\u9762\u8DD1\u811A\u672C",
  idalib: "idalib \u2192 headless-ida | pip install headless-ida",
  ida: "IDA \u53CD\u6C47\u7F16 \u2192 headless-ida + IDA Pro | \u66FF\u4EE3: Ghidra/radare2",
  radare2: "radare2 https://github.com/radareorg/radare2/releases \u2014 \u547D\u4EE4\u884C\u9006\u5411\u6846\u67B6 | \u4E0B\u8F7D: Releases \u9009\u5E73\u53F0\u4E8C\u8FDB\u5236 | scoop install radare2",
  r2: "r2 \u2192 radare2 https://github.com/radareorg/radare2/releases",
  rizin: "Rizin https://github.com/rizinorg/rizin/releases \u2014 radare2 \u5206\u652F\uFF0CCLI \u9006\u5411\u6846\u67B6 | UI \u5DE5\u5177\u9875\u53EF\u76F4\u63A5\u88C5 Windows \u9759\u6001\u5305 | rizin -A sample.bin",
  capa: "capa https://github.com/mandiant/capa \u2014 \u8BC6\u522B\u53EF\u6267\u884C\u6587\u4EF6\u80FD\u529B\u5E76\u6620\u5C04 ATT&CK/MBC | pip install flare-capa | capa sample.exe",
  floss: "FLOSS https://github.com/mandiant/flare-floss \u2014 \u63D0\u53D6\u6DF7\u6DC6/\u6808\u5B57\u7B26\u4E32 | pip install flare-floss | floss sample.exe",
  angr: "angr https://github.com/angr/angr \u2014 \u7B26\u53F7\u6267\u884C/\u4E8C\u8FDB\u5236\u5206\u6790\u5E73\u53F0 | pip install angr",
  pwntools: "pwntools https://github.com/Gallopsled/pwntools \u2014 \u6F0F\u6D1E\u5229\u7528\u5F00\u53D1/CTF | pip install pwntools (\u5EFA\u8BAE WSL/Kali) | pwn checksec ./bin",
  rop: "ROPgadget https://github.com/JonathanSalwan/ROPgadget \u2014 \u641C\u7D22 ROP/JOP gadget | pip install ROPgadget | ROPgadget --binary ./bin",
  ghidra: "Ghidra https://github.com/NationalSecurityAgency/ghidra/releases \u2014 \u53CD\u7F16\u8BD1\u5957\u4EF6 | \u7EA6 570MB\uFF0C\u5EFA\u8BAE\u624B\u52A8\u4E0B\u8F7D | GhidraMCP https://github.com/LaurieWired/GhidraMCP \u63D0\u4F9B agent \u63A5\u53E3",
  firmware: "\u56FA\u4EF6\u63D0\u53D6 \u2192 binwalk (cargo install binwalk / \u624B\u52A8\u4E0B\u8F7D) + unblob (Linux/WSL: pip install unblob) | binwalk firmware.bin",
  semgrep: "Semgrep https://github.com/semgrep/semgrep \u2014 \u6A21\u5F0F\u5316\u6E90\u7801\u5BA1\u8BA1 | pip install semgrep | semgrep --config auto .",
  joern: "Joern https://github.com/joernio/joern \u2014 \u4EE3\u7801\u5C5E\u6027\u56FE/\u6570\u636E\u6D41\u67E5\u8BE2 | \u4E0B\u8F7D joern-cli-windows-x86_64.zip (~1.7GB) | joern --script query.sc",
  vmp: "VMP \u2192 VMPStaticUnpacker https://github.com/YuroGod/VMPStaticUnpacker/releases | \u4E0B\u8F7D: Releases \u9009 `VMPStaticUnpacker.exe`",
  vmprotect: "VMProtect \u2192 VMPStaticUnpacker https://github.com/YuroGod/VMPStaticUnpacker/releases",
  unpack: "\u8131\u58F3 \u2192 VMPStaticUnpacker https://github.com/YuroGod/VMPStaticUnpacker/releases / detect_packer",
  x64dbg: "x64dbg https://github.com/x64dbg/x64dbg/releases \u2014 Windows \u7528\u6237\u6001\u8C03\u8BD5\u5668 | \u4E0B\u8F7D: Releases \u9009 `snapshot_*.zip`",
  debug: "Windows \u8C03\u8BD5 \u2192 x64dbg https://github.com/x64dbg/x64dbg/releases",
  "x64dbg-mcp": "x64dbg-mcp https://github.com/SetsunaYukiOvO/x64dbg-mcp/releases \u2014 AI \u63A7\u5236\u8C03\u8BD5 | \u4E0B\u8F7D: Releases \u9009 `dp32/dp64`",
  mcp: "MCP \u8C03\u8BD5 \u2192 x64dbg-mcp https://github.com/SetsunaYukiOvO/x64dbg-mcp/releases",
  hashdump: "Hash Dump \u2192 HashDump-BypassEDR https://github.com/AabyssZG/HashDump-BypassEDR/releases | \u4E0B\u8F7D: Releases \u9009 `BootKey.exe` + gcc \u7F16\u8BD1",
  edr: "EDR \u7ED5\u8FC7 \u2192 HashDump-BypassEDR https://github.com/AabyssZG/HashDump-BypassEDR/releases",
  frida: "\u8FD0\u884C\u65F6 hook -> Frida | pip install frida frida-tools | Android \u81EA\u5305\u542B\u66FF\u4EE3: rustFrida https://github.com/kkkbbb/rustFrida/releases",
  weakpass: "\u5F31\u53E3\u4EE4\u68C0\u6D4B \u2192 WeakPassDetect https://github.com/Pick-program/WeakPassDetect/releases | \u4E0B\u8F7D: Releases \u9009\u5E73\u53F0\u4E8C\u8FDB\u5236",
  weak: "\u5F31\u53E3\u4EE4 \u2192 WeakPassDetect https://github.com/Pick-program/WeakPassDetect/releases",
  brute: "\u7206\u7834 \u2192 WeakPassDetect https://github.com/Pick-program/WeakPassDetect/releases",
  pe_inspector: "PE \u6076\u610F\u68C0\u6D4B \u2192 pe-inspector https://github.com/la-1314/pe-inspector/releases | \u4E0B\u8F7D: Releases \u9009\u5E73\u53F0\u4E8C\u8FDB\u5236",
  malware: "\u6076\u610F\u6837\u672C\u68C0\u6D4B \u2192 pe-inspector https://github.com/la-1314/pe-inspector/releases",
  yara: "YARA https://github.com/VirusTotal/yara \u2014 \u89C4\u5219\u5339\u914D/\u6837\u672C\u5206\u7C7B | UI \u5DE5\u5177\u9875\u88C5 Windows \u5305 | yara rule.yar sample.exe",
  ember: "EMBER/PE \u7279\u5F81 \u2192 pe-inspector https://github.com/la-1314/pe-inspector/releases / yara_gen",
  volatility: "Volatility 3 https://github.com/volatilityfoundation/volatility3 \u2014 \u5185\u5B58\u53D6\u8BC1 | pip install volatility3 | vol -f memory.raw windows.pslist",
  oletools: "oletools https://github.com/decalage2/oletools \u2014 Office/OLE \u5B8F\u5206\u6790 | pip install oletools | olevba sample.doc",
  pesieve: "PE-sieve https://github.com/hasherezade/pe-sieve \u2014 \u8FDB\u7A0B\u6CE8\u5165/\u5185\u5B58 implant \u68C0\u6D4B | UI \u5DE5\u5177\u9875\u88C5 Windows \u5305 | pe-sieve64.exe /pid <pid>",
  hollows: "hollows_hunter https://github.com/hasherezade/hollows_hunter \u2014 \u626B\u63CF\u8FDB\u7A0B hollowing/injection | UI \u5DE5\u5177\u9875\u88C5 Windows \u5305 | hollows_hunter64.exe /loop",
  garak: 'garak https://github.com/NVIDIA/garak \u2014 LLM \u6F0F\u6D1E/\u8D8A\u72F1\u626B\u63CF | pip install "garak==0.17.0"\uFF080.17.1 wheel \u7F3A probe \u6A21\u5757\uFF09| garak --target_type openai --target_name <model> --spec probes.encoding.InjectBase64 -g 1',
  jailbreak: "\u6A21\u578B\u5B89\u5168\u8BC4\u6D4B -> references/ai-security/{model-security-analysis-guide,bypass-framework-matrix}.md\uFF1B\u5728\u81EA\u6709\u6D4B\u8BD5\u6837\u672C\u4E0A\u6BD4\u8F83\u54CD\u5E94\u5206\u7C7B\u3001\u62D2\u7B54\u4E00\u81F4\u6027\u548C\u5BA1\u8BA1\u8BB0\u5F55",
  llm: "LLM \u5E94\u7528\u5B89\u5168\u8BC4\u6D4B -> garak + references/ai-security/ + llm_sim \u5DE5\u5177"
};
function registerToolboxTools(ctx) {
  const tokenize = (text) => [...new Set(text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((token) => token.length >= 2))];
  const catalogMatches = (query) => {
    const tokens = tokenize(query);
    return TOOL_CATALOG.map((entry) => {
      const haystack = `${entry.id} ${entry.name} ${entry.category} ${entry.purpose} ${entry.usage}`.toLowerCase();
      const reasons = tokens.filter((token) => haystack.includes(token));
      const health = toolHealth(entry.id);
      const score = reasons.length * 10 + (health.installed ? 3 : 0) + (entry.license !== void 0 ? 1 : 0);
      return { entry, score, reasons, health };
    }).filter((row) => row.reasons.length > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, 8);
  };
  ctx.tools.register((0, import_dsh_tools8.defineTool)({
    name: "tool_recommend",
    description: "Recommend tools and evidence format from a task or signal description.",
    parameters: {
      query: { type: "string", description: 'Plain task or signal, e.g. "APK unpack Frida dex"; empty returns the full tool matrix.' }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      var _a;
      const q = ((_a = args.query) != null ? _a : "").toLowerCase();
      if (!q) {
        return await readTextSeam(ctx, (0, import_node_path15.resolve)(refRoot7, "tool-matrix.md"));
      }
      const hits = [];
      for (const [key3, value] of Object.entries(rules)) {
        if (q.includes(key3))
          hits.push(value);
      }
      const unique = [...new Set(hits)];
      const matches = catalogMatches(q);
      const catalogLines = matches.map(({ entry, health, reasons }) => {
        var _a2;
        return `- ${entry.id} (${entry.category}) \u2014 ${entry.purpose} | ${health.installed ? `installed ${(_a2 = health.version) != null ? _a2 : ""}` : "not installed"} | trust=${entry.license !== void 0 ? "verified" : "unverified"} | match=${reasons.join(",")}`;
      });
      const tail = catalogLines.length > 0 ? ["catalog matches (scored; installed first):", ...catalogLines] : [];
      if (unique.length > 0)
        return [...unique, ...tail].join("\n");
      return tail.length > 0 ? tail.join("\n") : "triage-and-route: begin_case + detect_packer + scan_strings + hash_artifact";
    }
  }));
  ctx.tools.register((0, import_dsh_tools8.defineTool)({
    name: "toolbox",
    description: "External-tool catalog and install status. action=catalog lists curated tools with GitHub repo, purpose, usage, and whether installed; action=status shows installed rows; action=mcp lists read-only MCP tool names exposed by the host; action=probe checks whether a local command resolves (where/which, cached 5min; never executes it); action=install installs one catalog release asset; action=update re-downloads the latest release; action=mirror installs a local archive with an operator-supplied sha256 (offline); model install/update/mirror are disabled unless the operator enables them. Only bundled catalog entries with a verified GitHub repository exist \u2014 arbitrary URLs are not accepted.",
    parameters: {
      action: { type: "string", required: true, description: "catalog | status | mcp | probe | install | update | mirror" },
      id: { type: "string", description: "Catalog id for install/update/mirror (e.g. jadx)." },
      asset_name: { type: "string", description: "Release asset name when the release has multiple candidates." },
      path: { type: "string", description: "Local archive path for action=mirror." },
      sha256: { type: "string", description: "Required sha256 for action=mirror." },
      query: { type: "string", description: "catalog: filter by id/name/category/purpose." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      var _a, _b, _c, _d, _e, _f, _g, _h;
      if (args.action === "probe") {
        const command = ((_b = (_a = args.query) != null ? _a : args.id) != null ? _b : "").trim();
        if (command === "")
          return "REJECTED \u2014 probe needs query (a command name)";
        try {
          return JSON.stringify(probeCommand(command));
        } catch (error) {
          return "REJECTED \u2014 " + (error instanceof Error ? error.message : String(error));
        }
      }
      if (args.action === "mcp") {
        let names = [];
        try {
          const schemas = ctx.tools.schemas;
          names = typeof schemas === "function" ? schemas().map((schema) => {
            var _a2;
            return String((_a2 = schema.name) != null ? _a2 : "");
          }).filter((name) => name.startsWith("mcp__")) : [];
        } catch {
        }
        return names.length > 0 ? ["MCP tools (read-only discovery; no external server is started):", ...names.sort().map((name) => "- " + name)].join("\n") : "no MCP tools are registered in this host";
      }
      if (args.action === "catalog" || args.action === "status") {
        const q = ((_c = args.query) != null ? _c : "").toLowerCase();
        const rows = TOOL_CATALOG.filter((entry) => args.action === "status" ? toolHealth(entry.id).installed : true).filter((entry) => q === "" || (entry.id + " " + entry.name + " " + entry.category + " " + entry.purpose).toLowerCase().includes(q)).map((entry) => {
          const health = toolHealth(entry.id);
          const status = health.installed ? "installed " + String(health.version) + " at " + String(health.path) : "not installed";
          return "- " + entry.id + " (" + entry.category + ") \u2014 " + entry.purpose + "\n  repo: " + entry.repo + "\n  kind: " + entry.kind + " | " + status + (entry.license !== void 0 ? " | license: " + entry.license : "") + "\n" + (entry.installHint !== void 0 ? "  install: " + entry.installHint + "\n" : "") + "  usage: " + entry.usage;
        });
        return rows.length > 0 ? rows.join("\n") : "no catalog entries match";
      }
      if (args.action === "install" || args.action === "update" || args.action === "mirror") {
        const entry = catalogEntry((_d = args.id) != null ? _d : "");
        if (entry === void 0)
          return "REJECTED \u2014 unknown catalog id: " + ((_e = args.id) != null ? _e : "(empty)");
        if (entry.kind !== "release") {
          return entry.name + " is a " + entry.kind + " tool; install manually: " + ((_f = entry.installHint) != null ? _f : entry.usage);
        }
        if (!loadSettings().toolbox.modelInstall) {
          return "REJECTED \u2014 model install is disabled. Use the WebUI \u5DE5\u5177 tab (operator action), or enable toolbox.modelInstall in settings.";
        }
        try {
          const installed = args.action === "install" ? await installCatalogTool(entry.id, args.asset_name) : args.action === "update" ? await updateCatalogTool(entry.id, args.asset_name) : await installCatalogMirror(entry.id, (_g = args.path) != null ? _g : "", (_h = args.sha256) != null ? _h : "");
          return "installed " + installed.name + " " + installed.version + "\npath: " + installed.path + "\nsha256: " + installed.sha256 + "\nusage: " + entry.usage;
        } catch (error) {
          return "REJECTED \u2014 " + (error instanceof Error ? error.message : String(error));
        }
      }
      return "REJECTED \u2014 action must be catalog | status | mcp | probe | install | update | mirror.";
    }
  }));
}

// src/tools/recon.js
var import_dsh_tools9 = __toESM(require_dsh_tools());
var import_node_fs9 = require("fs");

// src/case.js
var import_node_crypto3 = require("crypto");
var import_node_fs7 = require("fs");
var import_promises2 = __toESM(require_fsp());
var import_node_path16 = require("path");
var bindings = /* @__PURE__ */ new Map();
function sessionBindingPath(sessionId) {
  const key3 = (0, import_node_crypto3.createHash)("sha256").update(sessionId).digest("hex");
  return dataDir("sessions", `${key3}.json`);
}
function standaloneCase() {
  const dir = dataDir("workspace");
  try {
    (0, import_node_fs7.mkdirSync)(dir, { recursive: true });
    (0, import_node_fs7.mkdirSync)((0, import_node_path16.join)(dir, "evidence"), { recursive: true });
  } catch {
  }
  return { name: "standalone", dir, goal: "", scope: [], mode: "full", status: "open", samples: [] };
}
function getCase(sessionId) {
  const key3 = sessionId != null ? sessionId : "__global__";
  const cached2 = bindings.get(key3);
  if (cached2)
    return cached2;
  if (!sessionId)
    return void 0;
  try {
    const parsed = JSON.parse((0, import_node_fs7.readFileSync)(sessionBindingPath(sessionId), "utf8"));
    if (parsed !== null && typeof parsed === "object" && typeof parsed.dir === "string") {
      const dir = (0, import_node_path16.resolve)(parsed.dir);
      if ((0, import_node_fs7.existsSync)((0, import_node_path16.join)(dir, "CASE.md"))) {
        const info = {
          dir,
          name: typeof parsed.name === "string" ? parsed.name : (0, import_node_path16.basename)(dir),
          goal: typeof parsed.goal === "string" ? parsed.goal : "unspecified",
          mode: typeof parsed.mode === "string" ? parsed.mode : "full",
          route: typeof parsed.route === "string" ? parsed.route : "pending",
          ...Array.isArray(parsed.scope) ? { scope: parsed.scope.map(String) } : {}
        };
        bindings.set(key3, info);
        return info;
      }
    }
  } catch {
  }
  return void 0;
}
function bindCase(sessionId, info) {
  const key3 = sessionId != null ? sessionId : "__global__";
  bindings.set(key3, info);
  if (!sessionId)
    return;
  try {
    const path = sessionBindingPath(sessionId);
    (0, import_node_fs7.mkdirSync)((0, import_node_path16.dirname)(path), { recursive: true });
    (0, import_node_fs7.writeFileSync)(path, JSON.stringify({ sessionId, ...info, boundAt: new Date().toISOString() }, null, 2), "utf8");
  } catch {
  }
}
function unbindCase(sessionId) {
  const key3 = sessionId != null ? sessionId : "__global__";
  const info = bindings.get(key3);
  bindings.delete(key3);
  if (sessionId) {
    try {
      (0, import_node_fs7.unlinkSync)(sessionBindingPath(sessionId));
    } catch {
    }
  }
  return info;
}
function casesRoot(root) {
  var _a;
  const base = (root == null ? void 0 : root.trim()) || ((_a = process.env.HELMD_CASES_DIR) == null ? void 0 : _a.trim()) || process.cwd();
  return (0, import_node_path16.resolve)(base, "helmd-cases");
}
function slugify(text, max = 48) {
  const clean = text.replace(/[\\/:\*\?"<>\|]+/g, " ").trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return clean || "case";
}
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
async function sha256File2(path) {
  return await new Promise((resolvePromise, reject) => {
    const hash = (0, import_node_crypto3.createHash)("sha256");
    const stream = (0, import_node_fs7.createReadStream)(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
    stream.on("error", reject);
  });
}
async function createCaseDir(opts) {
  var _a;
  const base = casesRoot(opts.root);
  const hint = slugify(opts.goal || (0, import_node_path16.basename)((_a = opts.samples[0]) != null ? _a : ""));
  let name = `${today()}-${hint}`;
  for (let i = 2; (0, import_node_fs7.existsSync)((0, import_node_path16.join)(base, name)); i++)
    name = `${today()}-${hint}-${i}`;
  const dir = (0, import_node_path16.join)(base, name);
  for (const sub of ["sample", "evidence", "scripts"]) {
    await (0, import_promises2.mkdir)((0, import_node_path16.join)(dir, sub), { recursive: true });
  }
  const lines = [];
  let id = 0;
  for (const sample of opts.samples) {
    if (!(0, import_node_fs7.existsSync)(sample))
      throw new Error(`sample not found: ${sample}`);
    const dest = (0, import_node_path16.join)(dir, "sample", (0, import_node_path16.basename)(sample));
    await (0, import_promises2.copyFile)(sample, dest);
    const sha = await sha256File2(dest);
    id++;
    const eid = `E-${String(id).padStart(3, "0")}`;
    await (0, import_promises2.writeFile)((0, import_node_path16.join)(dir, "evidence", `${eid}-sha256.txt`), `${sha}  ${(0, import_node_path16.basename)(sample)}
source: ${(0, import_node_path16.resolve)(sample)}
`, "utf8");
    lines.push(`  - sample/${(0, import_node_path16.basename)(sample)} sha256:${sha}`);
  }
  const caseMd = [
    `# CASE ${name}`,
    `status: open`,
    `mode: ${opts.mode}`,
    `route: ${opts.route}`,
    ...opts.scope !== void 0 && opts.scope.length > 0 ? [`scope: ${opts.scope.join(", ")}`] : [],
    `goal: ${opts.goal}`,
    ...lines.length ? ["samples:", ...lines] : [],
    "",
    "## timeline",
    `- [${nowStamp()}] BEGIN \u2014 created by begin_case`,
    "",
    "## resume\uFF08\u538B\u7F29\u6062\u590D\u5951\u7EA6\uFF1A\u6062\u590D\u65F6\u5148 case_status()\uFF1B\u538B\u7F29\u524D\u628A 1-6 \u66F4\u65B0\u5230\u5F53\u524D\uFF09",
    "1. \u76EE\u6807\u4E0E\u7528\u6237\u7EA6\u675F\uFF1Agoal + \u7528\u6237\u8BF4\u8FC7\u7684\u8303\u56F4/\u8FB9\u754C\uFF08\u5B89\u5168\u76F8\u5173\u7EA6\u675F\u9010\u5B57\u4FDD\u7559\uFF0C\u4E0D\u8981\u8F6C\u8FF0\uFF09",
    "2. \u5DF2\u786E\u8BA4\u4E8B\u5B9E\uFF1A\u9A8C\u8BC1\u8FC7\u7684\u7ED3\u8BBA + \u5BF9\u5E94 E-id\uFF08\u672A\u9A8C\u8BC1\u7684\u731C\u6D4B\u4E0D\u8981\u5199\u8FDB\u6765\uFF09",
    "3. \u5173\u952E\u53C2\u6570\uFF1A\u547D\u4EE4 / \u504F\u79FB / \u54C8\u5E0C / \u5DE5\u5177\u7248\u672C \u2014\u2014 \u6B63\u6587\u53EA\u5199 E-id\uFF0C\u7EC6\u8282\u7559\u5728 evidence/",
    "4. \u5DF2\u6392\u9664\u7684\u8DEF\u7EBF\uFF1A\u8BD5\u8FC7\u4E14\u5931\u8D25\u7684\u8DEF\u5B50\uFF08\u540C\u6B65\u8FDB DEAD_ENDS\uFF0C\u5199\u660E\u6839\u56E0\uFF09",
    "5. \u5F53\u524D\u8FDB\u5C55\uFF1A\u6B63\u5728\u505A\u7684\u8FD9\u4E00\u6B65\u3001\u505A\u5230\u54EA\u3001\u4E0B\u4E00\u6B65\u7684\u6700\u5C0F\u52A8\u4F5C",
    "6. \u5F85\u529E\u4E0E\u963B\u585E\uFF1A\u7B49\u6750\u6599 / \u7B49\u5916\u90E8\u7ED3\u679C / \u7B49\u7528\u6237\u6280\u672F\u9009\u62E9\uFF08\u5199\u660E\u7B49\u4EC0\u4E48\u3001\u7531\u8C01\u7ED9\uFF09",
    ""
  ].join("\n");
  await (0, import_promises2.writeFile)((0, import_node_path16.join)(dir, "CASE.md"), caseMd, "utf8");
  await (0, import_promises2.writeFile)((0, import_node_path16.join)(dir, "findings.md"), `# FINDINGS ${name}
`, "utf8");
  return { dir, name, goal: opts.goal, mode: opts.mode, route: opts.route, ...opts.scope !== void 0 ? { scope: [...opts.scope] } : {} };
}
async function countEvidence(caseDir) {
  const files = await (0, import_promises2.readdir)((0, import_node_path16.join)(caseDir, "evidence")).catch(() => []);
  return files.filter((f) => /^E-\d{3}/.test(f) && !f.endsWith(".meta.json")).length;
}
async function listEvidence(caseDir) {
  const files = await (0, import_promises2.readdir)((0, import_node_path16.join)(caseDir, "evidence")).catch(() => []);
  return files.filter((file) => !file.endsWith(".meta.json")).map((file) => {
    const match = /^(E-\d+)/.exec(file);
    return match ? { id: match[1], file } : null;
  }).filter((entry) => entry !== null).sort((a, b) => a.id.localeCompare(b.id));
}
var evidenceCounters = /* @__PURE__ */ new Map();
async function nextEvidenceId(caseDir) {
  const cached2 = evidenceCounters.get(caseDir);
  if (cached2 !== void 0) {
    const next = cached2 + 1;
    evidenceCounters.set(caseDir, next);
    return `E-${String(next).padStart(3, "0")}`;
  }
  const files = await (0, import_promises2.readdir)((0, import_node_path16.join)(caseDir, "evidence")).catch(() => []);
  let max = 0;
  for (const f of files) {
    if (f.endsWith(".meta.json"))
      continue;
    const m = /^E-(\d{3})-/.exec(f);
    if (m)
      max = Math.max(max, parseInt(m[1], 10));
  }
  evidenceCounters.set(caseDir, max + 1);
  return `E-${String(max + 1).padStart(3, "0")}`;
}
async function saveEvidence(caseDir, toolLabel, content, summary, options = {}) {
  var _a, _b;
  const maxBytes = (_a = options.maxBytes) != null ? _a : 256 * 1024;
  const capped = maxBytes > 0 && content.length > maxBytes ? content.slice(0, maxBytes) + `
[truncated at ${Math.round(maxBytes / 1024)}KB; full length ${content.length}]
` : content;
  const sha = (0, import_node_crypto3.createHash)("sha256").update(capped, "utf8").digest("hex");
  const files = await (0, import_promises2.readdir)((0, import_node_path16.join)(caseDir, "evidence")).catch(() => []);
  for (const f of files) {
    if (!/^E-\d{3,}-/.test(f) || f.endsWith(".meta.json"))
      continue;
    const existing = await (0, import_promises2.readFile)((0, import_node_path16.join)(caseDir, "evidence", f), "utf8").catch(() => "");
    const existingSha = (0, import_node_crypto3.createHash)("sha256").update(existing, "utf8").digest("hex");
    if (existingSha === sha) {
      const existingId = (_b = /^E-(\d{3,})-/.exec(f)) == null ? void 0 : _b[1];
      if (existingId)
        return { id: `E-${existingId}`, path: (0, import_node_path16.join)(caseDir, "evidence", f), sha256: sha, dedup: `E-${existingId}` };
    }
  }
  const id = await nextEvidenceId(caseDir);
  const safeTool = toolLabel.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "output";
  const path = (0, import_node_path16.join)(caseDir, "evidence", `${id}-${safeTool}.txt`);
  await (0, import_promises2.writeFile)(path, capped, "utf8");
  const metas = await listEvidenceMeta(caseDir);
  const prevHash = metas.length > 0 ? metas[metas.length - 1].sha256 : "genesis";
  const meta = {
    id,
    file: (0, import_node_path16.basename)(path),
    sha256: sha,
    prevHash,
    tool: safeTool,
    ts: new Date().toISOString()
  };
  await (0, import_promises2.writeFile)((0, import_node_path16.join)(caseDir, "evidence", `${id}-${safeTool}.meta.json`), JSON.stringify(meta, null, 2), "utf8");
  await appendTimeline(caseDir, `${toolLabel} \u2192 ${id} \u2014 ${summary.slice(0, 80)}`);
  return { id, path, sha256: sha };
}
async function uncitedClaims(caseDir, detail, evidenceIds, negativeIds = []) {
  var _a, _b, _c;
  const citations = /* @__PURE__ */ new Set([...evidenceIds, ...negativeIds]);
  const brokenCitations = [...new Set((_a = detail.match(/\bE-\d{3,}\b/gi)) != null ? _a : [])].filter((id) => !citations.has(id.toUpperCase()));
  const hashes = [...new Set(((_b = detail.match(/\b[a-f0-9]{32,64}\b/gi)) != null ? _b : []).map((value) => value.toLowerCase()))];
  if (hashes.length === 0)
    return brokenCitations;
  const files = await (0, import_promises2.readdir)((0, import_node_path16.join)(caseDir, "evidence")).catch(() => []);
  let haystack = "";
  for (const file of files) {
    if (!/^E-\d{3,}-/.test(file) || file.endsWith(".meta.json"))
      continue;
    const id = (_c = /^(E-\d{3,})-/.exec(file)) == null ? void 0 : _c[1];
    if (id === void 0 || !citations.has(id))
      continue;
    haystack += await (0, import_promises2.readFile)((0, import_node_path16.join)(caseDir, "evidence", file), "utf8").catch(() => "") + "\n";
  }
  const lower = haystack.toLowerCase();
  return [...brokenCitations, ...hashes.filter((hash) => !lower.includes(hash))];
}
async function listEvidenceMeta(caseDir) {
  const files = await (0, import_promises2.readdir)((0, import_node_path16.join)(caseDir, "evidence")).catch(() => []);
  const metas = [];
  for (const file of files.filter((name) => name.endsWith(".meta.json"))) {
    try {
      const parsed = JSON.parse(await (0, import_promises2.readFile)((0, import_node_path16.join)(caseDir, "evidence", file), "utf8"));
      if (typeof parsed.id === "string" && typeof parsed.sha256 === "string") {
        metas.push({
          id: parsed.id,
          file: typeof parsed.file === "string" ? parsed.file : "",
          sha256: parsed.sha256,
          prevHash: typeof parsed.prevHash === "string" ? parsed.prevHash : "genesis",
          tool: typeof parsed.tool === "string" ? parsed.tool : "unknown",
          ts: typeof parsed.ts === "string" ? parsed.ts : ""
        });
      }
    } catch {
    }
  }
  return metas.sort((a, b) => a.id.localeCompare(b.id));
}
async function evidenceChainHead(caseDir, ids) {
  const metas = await listEvidenceMeta(caseDir);
  const wanted = ids === void 0 ? metas : metas.filter((meta) => ids.includes(meta.id));
  return wanted.length > 0 ? wanted[wanted.length - 1].sha256 : void 0;
}
async function staleEvidenceIds(caseDir) {
  const metas = await listEvidenceMeta(caseDir);
  const stale = [];
  for (const meta of metas) {
    const content = await (0, import_promises2.readFile)((0, import_node_path16.join)(caseDir, "evidence", meta.file), "utf8").catch(() => "");
    const sha = (0, import_node_crypto3.createHash)("sha256").update(content, "utf8").digest("hex");
    if (sha !== meta.sha256)
      stale.push(meta.id);
  }
  return stale;
}
async function appendTimeline(caseDir, line) {
  await (0, import_promises2.appendFile)((0, import_node_path16.join)(caseDir, "CASE.md"), `- [${nowStamp()}] ${line}
`, "utf8");
}
async function loadCaseMd(caseDir) {
  return await (0, import_promises2.readFile)((0, import_node_path16.join)(caseDir, "CASE.md"), "utf8");
}
async function validateEvidenceIds(caseDir, ids) {
  const files = await (0, import_promises2.readdir)((0, import_node_path16.join)(caseDir, "evidence")).catch(() => []);
  const known = files.filter((f) => !f.endsWith(".meta.json")).map((f) => {
    var _a;
    return (_a = /^(E-\d{3})-/.exec(f)) == null ? void 0 : _a[1];
  }).filter((x) => Boolean(x));
  const missing = ids.filter((id) => !known.includes(id));
  return { ok: missing.length === 0, missing, known };
}
var FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"];
var FINDING_STATUSES = ["candidate", "verified", "rejected", "duplicate", "wontfix"];
var FINDING_CONFIDENCES = ["verified", "probable", "unverified"];
var SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
var STATUS_STRENGTH = { candidate: 1, verified: 2, rejected: 3, duplicate: 3, wontfix: 3 };
function isSeverity(value) {
  return typeof value === "string" && FINDING_SEVERITIES.includes(value);
}
function isFindingStatus(value) {
  return typeof value === "string" && FINDING_STATUSES.includes(value);
}
function isConfidence(value) {
  return typeof value === "string" && FINDING_CONFIDENCES.includes(value);
}
function cvssToSeverity(score) {
  if (score >= 9)
    return "critical";
  if (score >= 7)
    return "high";
  if (score >= 4)
    return "medium";
  if (score > 0)
    return "low";
  return "info";
}
function severityAtMost(severity, cap) {
  return SEVERITY_RANK[severity] > SEVERITY_RANK[cap] ? cap : severity;
}
function downgradeOne(severity) {
  const order = ["info", "low", "medium", "high", "critical"];
  const idx = Math.max(0, order.indexOf(severity) - 1);
  return order[idx];
}
function findingsPath(caseDir) {
  return (0, import_node_path16.join)(caseDir, "findings.json");
}
function normalizeKey(value) {
  return (value != null ? value : "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function findingKey(finding) {
  return `${normalizeKey(finding.vulnClass || "unspecified")}|${normalizeKey(finding.target)}|${normalizeKey(finding.title)}`;
}
function normalizeFinding(raw, index) {
  var _a;
  const severity = isSeverity(raw.severity) ? raw.severity : "info";
  return {
    id: typeof raw.id === "string" && /^F-\d+$/.test(raw.id) ? raw.id : `F-${String(index + 1).padStart(3, "0")}`,
    title: typeof raw.title === "string" ? raw.title : "",
    detail: typeof raw.detail === "string" ? raw.detail : "",
    severity,
    status: isFindingStatus(raw.status) ? raw.status : "verified",
    confidence: isConfidence(raw.confidence) ? raw.confidence : "probable",
    vulnClass: typeof raw.vulnClass === "string" && raw.vulnClass.trim() !== "" ? raw.vulnClass : "unspecified",
    ...typeof raw.target === "string" && raw.target.trim() !== "" ? { target: raw.target } : {},
    ...typeof raw.cvss === "number" && Number.isFinite(raw.cvss) ? { cvss: raw.cvss } : {},
    ...typeof raw.cvssVector === "string" && raw.cvssVector.trim() !== "" ? { cvssVector: raw.cvssVector.trim() } : {},
    ...isSeverity(raw.assertedSeverity) ? { assertedSeverity: raw.assertedSeverity } : {},
    evidence: typeof raw.evidence === "string" ? raw.evidence : ((_a = raw.evidenceIds) != null ? _a : []).join(", "),
    evidenceIds: Array.isArray(raw.evidenceIds) ? raw.evidenceIds.map(String) : [],
    ...typeof raw.evidenceHash === "string" && raw.evidenceHash !== "" ? { evidenceHash: raw.evidenceHash } : {},
    ...Array.isArray(raw.negativeEvidenceIds) && raw.negativeEvidenceIds.length > 0 ? { negativeEvidenceIds: raw.negativeEvidenceIds.map(String) } : {},
    ...typeof raw.negativeControl === "string" && raw.negativeControl.trim() !== "" ? { negativeControl: raw.negativeControl } : {},
    ...typeof raw.pocId === "string" && raw.pocId.trim() !== "" ? { pocId: raw.pocId } : {},
    ...raw.stale === true ? { stale: true } : {},
    ...typeof raw.repro === "string" && raw.repro.trim() !== "" ? { repro: raw.repro } : {},
    seenCount: typeof raw.seenCount === "number" && raw.seenCount > 0 ? raw.seenCount : 1,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
  };
}
function parseFindingsMarkdown(raw) {
  return raw.split(/^## /m).slice(1).map((chunk, index) => {
    var _a, _b, _c, _d, _e, _f;
    const lines = chunk.split("\n");
    const title = ((_a = lines.shift()) != null ? _a : "").trim();
    const meta = (name) => {
      const line = lines.find((entry) => new RegExp(`^[-*]?\\s*${name}:`, "i").test(entry));
      return line == null ? void 0 : line.replace(new RegExp(`^[-*]?\\s*${name}:\\s*`, "i"), "").trim();
    };
    const evidenceLine = (_b = lines.find((line) => /^evidence:/i.test(line))) != null ? _b : "";
    const reproLine = (_c = lines.find((line) => /^repro:/i.test(line))) != null ? _c : "";
    const detail = lines.filter((line) => !/^([-*]?\s*(severity|status|confidence|vuln_class):|evidence:|repro:)/i.test(line)).join("\n").trim();
    return normalizeFinding({
      id: `F-${String(index + 1).padStart(3, "0")}`,
      title,
      detail: detail.slice(0, 500),
      severity: (_d = meta("severity")) != null ? _d : "info",
      status: (_e = meta("status")) != null ? _e : "verified",
      confidence: (_f = meta("confidence")) != null ? _f : "probable",
      vulnClass: meta("vuln_class"),
      evidence: evidenceLine.replace(/^evidence:\s*/i, ""),
      evidenceIds: evidenceLine.replace(/^evidence:\s*/i, "").split(/[,\s]+/).filter(Boolean),
      repro: reproLine.replace(/^repro:\s*/i, "")
    }, index);
  }).filter((finding) => finding.title !== "");
}
async function markStaleFindings(caseDir, findings) {
  const stale = new Set(await staleEvidenceIds(caseDir));
  if (stale.size === 0)
    return findings;
  for (const finding of findings) {
    if (finding.evidenceIds.some((id) => stale.has(id)))
      finding.stale = true;
  }
  return findings;
}
async function loadFindings(caseDir) {
  try {
    const parsed = JSON.parse(await (0, import_promises2.readFile)(findingsPath(caseDir), "utf8"));
    if (Array.isArray(parsed)) {
      return await markStaleFindings(caseDir, parsed.map((entry, index) => normalizeFinding(entry, index)));
    }
  } catch {
  }
  try {
    const raw = await (0, import_promises2.readFile)((0, import_node_path16.join)(caseDir, "findings.md"), "utf8");
    return await markStaleFindings(caseDir, parseFindingsMarkdown(raw));
  } catch {
    return [];
  }
}
async function saveFindings(caseDir, findings) {
  await (0, import_promises2.writeFile)(findingsPath(caseDir), JSON.stringify(findings, null, 2), "utf8");
}
async function recordFinding(caseDir, input) {
  var _a, _b, _c, _d, _e, _f;
  const title = input.title.trim();
  const detail = input.detail.trim();
  if (title === "")
    throw new Error("finding title is required");
  if (detail === "")
    throw new Error("finding detail is required");
  const evidenceIds = [...new Set(input.evidenceIds.map((id) => id.trim()).filter(Boolean))];
  if (evidenceIds.length === 0)
    throw new Error("at least one evidence id is required");
  const negativeEvidenceIds = [...new Set(((_a = input.negativeEvidenceIds) != null ? _a : []).map((id) => id.trim()).filter(Boolean))];
  const overlap = negativeEvidenceIds.filter((id) => evidenceIds.includes(id));
  if (overlap.length > 0)
    throw new Error(`negative control must use independent evidence; overlap: ${overlap.join(", ")}`);
  if (negativeEvidenceIds.length > 0) {
    const known = await validateEvidenceIds(caseDir, negativeEvidenceIds);
    if (!known.ok)
      throw new Error(`unknown negative-control evidence ids: ${known.missing.join(", ")}`);
  }
  const evidenceHash = await evidenceChainHead(caseDir, [...evidenceIds, ...negativeEvidenceIds]);
  const notes = [];
  let severity = isSeverity(input.severity) ? input.severity : "info";
  if (!isSeverity(input.severity))
    notes.push(`unknown severity "${String(input.severity)}" coerced to info`);
  const assertedSeverity = severity;
  let asserted;
  const parsedVector = input.cvssVector !== void 0 && input.cvssVector.trim() !== "" ? parseCvssVector(input.cvssVector) : void 0;
  if (input.cvssVector !== void 0 && input.cvssVector.trim() !== "" && parsedVector === void 0) {
    throw new Error(`invalid CVSS vector: ${input.cvssVector}`);
  }
  const cvssScore = (_b = parsedVector == null ? void 0 : parsedVector.score) != null ? _b : typeof input.cvss === "number" && Number.isFinite(input.cvss) ? input.cvss : void 0;
  if (cvssScore !== void 0) {
    const fromCvss = (_c = parsedVector == null ? void 0 : parsedVector.severity) != null ? _c : cvssToSeverity(Math.max(0, Math.min(10, cvssScore)));
    if (fromCvss !== severity) {
      asserted = severity;
      severity = fromCvss;
      notes.push(`severity overridden by CVSS ${cvssScore}${parsedVector !== void 0 ? " (vector)" : ""} \u2192 ${fromCvss} (asserted ${assertedSeverity})`);
    }
  }
  const confidence = isConfidence(input.confidence) ? input.confidence : "probable";
  const capped = severityAtMost(severity, confidence === "unverified" ? "medium" : "critical");
  if (capped !== severity) {
    notes.push(`severity capped at ${capped}: confidence=${confidence}`);
    severity = capped;
  }
  if ((severity === "critical" || severity === "high") && evidenceIds.length < 2) {
    const next = downgradeOne(severity);
    notes.push(`severity downgraded ${severity} \u2192 ${next}: ${severity} requires >= 2 evidence ids, got ${evidenceIds.length}`);
    severity = next;
  }
  const findings = await loadFindings(caseDir);
  const status = isFindingStatus(input.status) ? input.status : "verified";
  const key3 = findingKey({ vulnClass: (_d = input.vulnClass) != null ? _d : "", target: input.target, title });
  const existing = findings.find((finding2) => findingKey(finding2) === key3);
  const nowIso = new Date().toISOString();
  if (existing !== void 0) {
    existing.evidenceIds = [.../* @__PURE__ */ new Set([...existing.evidenceIds, ...evidenceIds])];
    existing.evidence = existing.evidenceIds.join(", ");
    if (negativeEvidenceIds.length > 0) {
      existing.negativeEvidenceIds = [.../* @__PURE__ */ new Set([...(_e = existing.negativeEvidenceIds) != null ? _e : [], ...negativeEvidenceIds])];
    }
    if (input.negativeControl !== void 0 && input.negativeControl.trim() !== "")
      existing.negativeControl = input.negativeControl.trim();
    if (input.pocId !== void 0 && input.pocId.trim() !== "")
      existing.pocId = input.pocId.trim();
    if (evidenceHash !== void 0)
      existing.evidenceHash = evidenceHash;
    if (cvssScore !== void 0)
      existing.cvss = cvssScore;
    if (input.cvssVector !== void 0 && input.cvssVector.trim() !== "")
      existing.cvssVector = input.cvssVector.trim();
    existing.seenCount += 1;
    existing.updatedAt = nowIso;
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity])
      existing.severity = severity;
    if (STATUS_STRENGTH[status] > STATUS_STRENGTH[existing.status] && existing.status === "candidate")
      existing.status = status;
    await saveFindings(caseDir, findings);
    await appendTimeline(caseDir, `FINDING merge \u2014 ${existing.id} ${title} (+${evidenceIds.join(", ")})`);
    return { finding: existing, merged: true, notes };
  }
  const nextNumber = findings.reduce((best, finding2) => {
    const match = /^F-(\d+)$/.exec(finding2.id);
    return match ? Math.max(best, Number(match[1])) : best;
  }, 0) + 1;
  const finding = {
    id: `F-${String(nextNumber).padStart(3, "0")}`,
    title,
    detail,
    severity,
    status,
    confidence,
    vulnClass: ((_f = input.vulnClass) != null ? _f : "unspecified").trim() || "unspecified",
    ...input.target !== void 0 && input.target.trim() !== "" ? { target: input.target.trim() } : {},
    ...cvssScore !== void 0 ? { cvss: cvssScore } : {},
    ...input.cvssVector !== void 0 && input.cvssVector.trim() !== "" ? { cvssVector: input.cvssVector.trim() } : {},
    ...asserted !== void 0 ? { assertedSeverity: asserted } : {},
    evidence: evidenceIds.join(", "),
    evidenceIds,
    ...evidenceHash !== void 0 ? { evidenceHash } : {},
    ...negativeEvidenceIds.length > 0 ? { negativeEvidenceIds } : {},
    ...input.negativeControl !== void 0 && input.negativeControl.trim() !== "" ? { negativeControl: input.negativeControl.trim() } : {},
    ...input.pocId !== void 0 && input.pocId.trim() !== "" ? { pocId: input.pocId.trim() } : {},
    ...input.repro !== void 0 && input.repro.trim() !== "" ? { repro: input.repro.trim() } : {},
    seenCount: 1,
    createdAt: nowIso,
    updatedAt: nowIso
  };
  findings.push(finding);
  await saveFindings(caseDir, findings);
  await (0, import_promises2.appendFile)((0, import_node_path16.join)(caseDir, "findings.md"), `
## ${title}
- severity: ${severity}
- status: ${status}
- confidence: ${confidence}
- vuln_class: ${finding.vulnClass}
${finding.target ? `- target: ${finding.target}
` : ""}${finding.cvss !== void 0 ? `- cvss: ${finding.cvss}
` : ""}${detail}
evidence: ${evidenceIds.join(", ")}
${finding.repro ? `repro: ${finding.repro}
` : ""}`, "utf8");
  await appendTimeline(caseDir, `FINDING ${finding.id} \u2014 ${title} [${severity}/${status}] (${evidenceIds.join(", ")})`);
  return { finding, merged: false, notes };
}
async function updateFinding(caseDir, id, patch) {
  const findings = await loadFindings(caseDir);
  const finding = findings.find((entry) => entry.id === id);
  if (finding === void 0)
    return void 0;
  if (patch.status !== void 0) {
    if (!isFindingStatus(patch.status))
      throw new Error(`unknown finding status: ${String(patch.status)}`);
    finding.status = patch.status;
  }
  if (patch.severity !== void 0) {
    if (!isSeverity(patch.severity))
      throw new Error(`unknown severity: ${String(patch.severity)}`);
    finding.severity = patch.severity;
  }
  finding.updatedAt = new Date().toISOString();
  await saveFindings(caseDir, findings);
  await appendTimeline(caseDir, `FINDING ${id} \u2192 ${finding.status}${patch.severity ? ` (${patch.severity})` : ""}${patch.note ? ` \u2014 ${patch.note}` : ""}`);
  return finding;
}
function severityCounts(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings)
    counts[finding.severity] += 1;
  return counts;
}
function findingStatusCounts(findings) {
  const counts = { candidate: 0, verified: 0, rejected: 0, duplicate: 0, wontfix: 0 };
  for (const finding of findings)
    counts[finding.status] += 1;
  return counts;
}
async function closeCase(caseDir, summary) {
  const swept = await sweepCaseRootFiles(caseDir);
  if (swept.length > 0) {
    await appendTimeline(caseDir, `SWEEP \u2014 auto-archived loose files to evidence/: ${swept.join(", ")}`);
  }
  const md = await loadCaseMd(caseDir);
  await (0, import_promises2.writeFile)((0, import_node_path16.join)(caseDir, "CASE.md"), md.replace(/^status: open/m, "status: completed"), "utf8");
  if (summary)
    await appendTimeline(caseDir, `END \u2014 ${summary.slice(0, 120)}`);
  else
    await appendTimeline(caseDir, "END \u2014 closed by end_case");
}
async function listCasesOnDisk(root) {
  var _a, _b, _c, _d, _e, _f, _g;
  const base = casesRoot(root);
  if (!(0, import_node_fs7.existsSync)(base))
    return [];
  try {
    const entries = await (0, import_promises2.readdir)(base, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      if (!entry.isDirectory())
        continue;
      const dirPath = (0, import_node_path16.join)(base, entry.name);
      const caseMdPath = (0, import_node_path16.join)(dirPath, "CASE.md");
      if ((0, import_node_fs7.existsSync)(caseMdPath)) {
        try {
          const md = await (0, import_promises2.readFile)(caseMdPath, "utf8");
          const statusMatch = /^status:\s*(open|completed)\b/m.exec(md);
          const goalMatch = /^goal:\s*(.*)$/m.exec(md);
          const modeMatch = /^mode:\s*(.*)$/m.exec(md);
          const routeMatch = /^route:\s*(.*)$/m.exec(md);
          const evidenceCount = await countEvidence(dirPath);
          const looseFiles = await listLooseFilesInCase(dirPath);
          const findings = await loadFindings(dirPath);
          results.push({
            name: entry.name,
            dir: dirPath,
            status: (_a = statusMatch == null ? void 0 : statusMatch[1]) != null ? _a : "unknown",
            goal: (_c = (_b = goalMatch == null ? void 0 : goalMatch[1]) == null ? void 0 : _b.trim()) != null ? _c : "unspecified",
            mode: (_e = (_d = modeMatch == null ? void 0 : modeMatch[1]) == null ? void 0 : _d.trim()) != null ? _e : "full",
            route: (_g = (_f = routeMatch == null ? void 0 : routeMatch[1]) == null ? void 0 : _f.trim()) != null ? _g : "pending",
            evidenceCount,
            findingsBySeverity: severityCounts(findings),
            staleFindings: findings.filter((finding) => finding.stale).length,
            looseFiles
          });
        } catch {
        }
      }
    }
    results.sort((a, b) => b.name.localeCompare(a.name));
    return results;
  } catch {
    return [];
  }
}
async function auditCasesRoot(root) {
  const base = casesRoot(root);
  const cases = await listCasesOnDisk(root);
  const strays = [];
  if (!(0, import_node_fs7.existsSync)(base))
    return { cases, strays };
  try {
    const entries = await (0, import_promises2.readdir)(base, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        strays.push(`file:${entry.name}`);
      } else if (entry.isDirectory()) {
        const caseMdPath = (0, import_node_path16.join)(base, entry.name, "CASE.md");
        if (!(0, import_node_fs7.existsSync)(caseMdPath)) {
          strays.push(`dir:${entry.name}`);
        }
      }
    }
  } catch {
  }
  return { cases, strays };
}
async function findOpenCaseOnDisk(root) {
  const all = await listCasesOnDisk(root);
  const open = all.find((c) => c.status === "open");
  if (!open)
    return void 0;
  return {
    dir: open.dir,
    name: open.name,
    goal: open.goal,
    mode: open.mode,
    route: open.route
  };
}
async function loadCaseInfoFromDisk(caseDirOrName, root) {
  var _a, _b, _c, _d, _e, _f, _g;
  const base = casesRoot(root);
  const dirPath = caseDirOrName.includes("/") || caseDirOrName.includes("\\") ? (0, import_node_path16.resolve)(caseDirOrName) : (0, import_node_path16.join)(base, caseDirOrName);
  const caseMdPath = (0, import_node_path16.join)(dirPath, "CASE.md");
  if (!(0, import_node_fs7.existsSync)(caseMdPath))
    return void 0;
  try {
    const md = await (0, import_promises2.readFile)(caseMdPath, "utf8");
    const goalMatch = /^goal:\s*(.*)$/m.exec(md);
    const modeMatch = /^mode:\s*(.*)$/m.exec(md);
    const routeMatch = /^route:\s*(.*)$/m.exec(md);
    const scopeMatch = /^scope:\s*(.*)$/m.exec(md);
    return {
      dir: dirPath,
      name: (0, import_node_path16.basename)(dirPath),
      goal: (_b = (_a = goalMatch == null ? void 0 : goalMatch[1]) == null ? void 0 : _a.trim()) != null ? _b : "unspecified",
      mode: (_d = (_c = modeMatch == null ? void 0 : modeMatch[1]) == null ? void 0 : _c.trim()) != null ? _d : "full",
      route: (_f = (_e = routeMatch == null ? void 0 : routeMatch[1]) == null ? void 0 : _e.trim()) != null ? _f : "pending",
      ...((_g = scopeMatch == null ? void 0 : scopeMatch[1]) == null ? void 0 : _g.trim()) ? { scope: scopeMatch[1].split(",").map((item) => item.trim()).filter(Boolean) } : {}
    };
  } catch {
    return void 0;
  }
}
async function listLooseFilesInCase(caseDir) {
  const loose = [];
  try {
    const entries = await (0, import_promises2.readdir)(caseDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name !== "CASE.md" && e.name !== "findings.md") {
        loose.push(e.name);
      }
    }
  } catch {
  }
  return loose;
}
async function sweepCaseRootFiles(caseDir) {
  const swept = [];
  try {
    const loose = await listLooseFilesInCase(caseDir);
    for (const name of loose) {
      const src = (0, import_node_path16.join)(caseDir, name);
      const dest = (0, import_node_path16.join)(caseDir, "evidence", name);
      if (!(0, import_node_fs7.existsSync)(dest)) {
        await (0, import_promises2.rename)(src, dest);
        swept.push(name);
      }
    }
  } catch {
  }
  return swept;
}
var hypothesisCounters = /* @__PURE__ */ new Map();
function hypothesesPath(caseDir) {
  return (0, import_node_path16.join)(caseDir, "hypotheses.json");
}
async function recordHypothesis(caseDir, statement, expected, testCmd, evidenceIds = [], negativeCmd) {
  let count = hypothesisCounters.get(caseDir);
  if (count === void 0) {
    const existing = await loadHypotheses(caseDir);
    count = existing.length;
    hypothesisCounters.set(caseDir, count);
  }
  count++;
  hypothesisCounters.set(caseDir, count);
  const now2 = new Date().toISOString();
  const h = {
    id: `H-${String(count).padStart(3, "0")}`,
    statement,
    expected,
    testCmd,
    ...negativeCmd !== void 0 && negativeCmd.trim() !== "" ? { negativeCmd: negativeCmd.trim() } : {},
    status: "open",
    evidenceIds,
    createdAt: now2,
    updatedAt: now2
  };
  const all = await loadHypotheses(caseDir);
  all.push(h);
  await (0, import_promises2.writeFile)(hypothesesPath(caseDir), JSON.stringify(all, null, 2), "utf8");
  await appendTimeline(caseDir, `HYPOTHESIS ${h.id} \u2014 ${statement.slice(0, 80)}`);
  return h;
}
async function updateHypothesis(caseDir, id, status, observation, evidenceIds = []) {
  const all = await loadHypotheses(caseDir);
  const h = all.find((x) => x.id === id);
  if (!h)
    return void 0;
  h.status = status;
  h.observation = observation;
  h.observed = observation;
  if (evidenceIds.length > 0)
    h.evidenceIds = [.../* @__PURE__ */ new Set([...h.evidenceIds, ...evidenceIds])];
  h.updatedAt = new Date().toISOString();
  await (0, import_promises2.writeFile)(hypothesesPath(caseDir), JSON.stringify(all, null, 2), "utf8");
  await appendTimeline(caseDir, `HYPOTHESIS ${id} \u2192 ${status} \u2014 ${observation.slice(0, 80)}`);
  return h;
}
async function loadHypotheses(caseDir) {
  try {
    return JSON.parse(await (0, import_promises2.readFile)(hypothesesPath(caseDir), "utf8"));
  } catch {
    return [];
  }
}
async function getOpenHypothesisCount(caseDir) {
  const all = await loadHypotheses(caseDir);
  return all.filter((h) => h.status === "open").length;
}
function parseCvssVector(vector) {
  var _a, _b, _c;
  const raw = vector.trim().replace(/^CVSS:3\.[01]\//i, "");
  const parts = /* @__PURE__ */ new Map();
  for (const pair of raw.split("/")) {
    const [key3, value] = pair.split(":");
    if (key3 === void 0 || value === void 0)
      return void 0;
    parts.set(key3.toUpperCase(), value.toUpperCase());
  }
  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[(_a = parts.get("AV")) != null ? _a : ""];
  const ac = { L: 0.77, H: 0.44 }[(_b = parts.get("AC")) != null ? _b : ""];
  const ui = { N: 0.85, R: 0.62 }[(_c = parts.get("UI")) != null ? _c : ""];
  const scope = parts.get("S");
  const prTable = scope === "C" ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 };
  const pr = prTable[parts.get("PR")];
  const cia = { H: 0.56, L: 0.22, N: 0 };
  const c = cia[parts.get("C")];
  const i = cia[parts.get("I")];
  const a = cia[parts.get("A")];
  if (av === void 0 || ac === void 0 || ui === void 0 || pr === void 0 || scope === void 0 || scope !== "U" && scope !== "C" || c === void 0 || i === void 0 || a === void 0)
    return void 0;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  const exploitability = 8.22 * av * ac * pr * ui;
  if (impact <= 0)
    return { score: 0, severity: "info" };
  const base = scope === "U" ? Math.min(impact + exploitability, 10) : Math.min(1.08 * (impact + exploitability), 10);
  const score = Math.ceil(base * 10) / 10;
  return { score, severity: cvssToSeverity(score) };
}

// src/recon.js
var import_node_fs8 = require("fs");
var import_node_net = require("net");
var import_node_path17 = require("path");
function ledgerPath(caseDir) {
  return (0, import_node_path17.join)(caseDir, "recon", "assets.jsonl");
}
function loadAssets(caseDir) {
  if (!(0, import_node_fs8.existsSync)(ledgerPath(caseDir)))
    return [];
  const rows = [];
  for (const line of (0, import_node_fs8.readFileSync)(ledgerPath(caseDir), "utf8").split("\n")) {
    if (line.trim() === "")
      continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.kind === "string" && typeof parsed.value === "string") {
        rows.push({
          kind: parsed.kind,
          value: parsed.value,
          ...typeof parsed.parent === "string" ? { parent: parsed.parent } : {},
          source: typeof parsed.source === "string" ? parsed.source : "unknown",
          ...typeof parsed.evidenceId === "string" ? { evidenceId: parsed.evidenceId } : {},
          firstSeen: typeof parsed.firstSeen === "string" ? parsed.firstSeen : "",
          lastSeen: typeof parsed.lastSeen === "string" ? parsed.lastSeen : ""
        });
      }
    } catch {
    }
  }
  return rows;
}
function addAsset(caseDir, input) {
  (0, import_node_fs8.mkdirSync)((0, import_node_path17.join)(caseDir, "recon"), { recursive: true });
  const now2 = new Date().toISOString();
  const rows = loadAssets(caseDir);
  const key3 = (asset2) => {
    var _a;
    return `${asset2.kind}|${asset2.value}|${(_a = asset2.parent) != null ? _a : ""}`;
  };
  const existing = rows.find((asset2) => key3(asset2) === key3(input));
  if (existing !== void 0) {
    existing.lastSeen = now2;
    existing.source = input.source;
    if (input.evidenceId !== void 0)
      existing.evidenceId = input.evidenceId;
    (0, import_node_fs8.writeFileSync)(ledgerPath(caseDir), rows.map((asset2) => JSON.stringify(asset2)).join("\n") + "\n", "utf8");
    return { asset: existing, deduped: true };
  }
  const asset = { ...input, firstSeen: now2, lastSeen: now2 };
  (0, import_node_fs8.appendFileSync)(ledgerPath(caseDir), JSON.stringify(asset) + "\n", "utf8");
  return { asset, deduped: false };
}
function addAssets(caseDir, inputs) {
  let added = 0;
  let deduped = 0;
  for (const input of inputs) {
    const result = addAsset(caseDir, input);
    if (result.deduped)
      deduped += 1;
    else
      added += 1;
  }
  return { added, deduped };
}
var PRIVATE_PREFIXES = ["10.", "127.", "169.254.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.", "192.168.", "::1", "fc", "fd", "fe80"];
function isPrivateHost(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost") || value === "metadata.google.internal")
    return true;
  if ((0, import_node_net.isIP)(value) === 0)
    return false;
  return PRIVATE_PREFIXES.some((prefix) => value.startsWith(prefix));
}
function hostInScope(host, scope) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  return scope.some((entry) => {
    const allowed = entry.toLowerCase().trim();
    if (allowed === "")
      return false;
    if (allowed.includes("/"))
      return false;
    return value === allowed || value.endsWith(`.${allowed}`);
  });
}
function checkReconTarget(host, scope, lab = false) {
  if (host.trim() === "")
    return { ok: false, reason: "empty target" };
  if (scope.length > 0 && !hostInScope(host, scope))
    return { ok: false, reason: `target ${host} is outside case scope` };
  if (isPrivateHost(host) && !lab)
    return { ok: false, reason: `target ${host} is private/loopback; pass lab=true only for an authorized lab` };
  return { ok: true };
}
var ReconLimiter = class {
  rps;
  concurrency;
  nextAt = /* @__PURE__ */ new Map();
  active = 0;
  constructor(rps = 1, concurrency = 4) {
    this.rps = rps;
    this.concurrency = concurrency;
  }
  async acquire(host) {
    var _a;
    const wait = ((_a = this.nextAt.get(host)) != null ? _a : 0) - Date.now();
    if (wait > 0)
      await new Promise((resolve12) => setTimeout(resolve12, wait));
    const jitter = Math.floor(Math.random() * 120);
    this.nextAt.set(host, Date.now() + Math.max(0, 1e3 / Math.max(0.1, this.rps)) + jitter);
    while (this.active >= this.concurrency)
      await new Promise((resolve12) => setTimeout(resolve12, 25));
    this.active += 1;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
  }
};
function coverageFor(assets) {
  const count = (kind) => assets.filter((asset) => asset.kind === kind).length;
  return {
    dns: count("domain") + count("host"),
    ports: count("port"),
    http: count("url"),
    tech: count("tech"),
    crawl: count("url"),
    dir: count("path"),
    untested: assets.filter((asset) => (asset.kind === "host" || asset.kind === "url") && asset.evidenceId === void 0).length
  };
}
function coverageLine(assets) {
  const coverage = coverageFor(assets);
  const dimensions = ["dns", "ports", "http", "tech", "crawl", "dir"].filter((key3) => coverage[key3] > 0);
  return `[recon] assets ${assets.length} \xB7 covered ${dimensions.join(",") || "none"} \xB7 untested ${coverage.untested}`;
}
function parseNmapXml(xml) {
  var _a;
  const rows = [];
  for (const block of xml.matchAll(/<host\b[\s\S]*?<\/host>/gi)) {
    const addr = (_a = /<address[^>]*addr="([^"]+)"/i.exec(block[0])) == null ? void 0 : _a[1];
    if (addr === void 0)
      continue;
    const ports = [...block[0].matchAll(/<port[^>]*portid="(\d+)"/gi)].map((match) => Number(match[1]));
    rows.push({ host: addr, ports });
  }
  return rows;
}
function parseHttpxJsonl(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "")
      continue;
    try {
      const parsed = JSON.parse(line);
      const url = typeof parsed.url === "string" ? parsed.url : "";
      if (url === "")
        continue;
      rows.push({
        url,
        ...typeof parsed.host === "string" ? { host: parsed.host } : {},
        tech: Array.isArray(parsed.tech) ? parsed.tech.map(String) : [],
        ...typeof parsed.status_code === "number" ? { status: parsed.status_code } : {}
      });
    } catch {
    }
  }
  return rows;
}
function parseNucleiJsonl(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "")
      continue;
    try {
      const parsed = JSON.parse(line);
      const host = typeof parsed.host === "string" ? parsed.host : "";
      if (host === "")
        continue;
      rows.push({
        host,
        ...typeof parsed["matched-at"] === "string" ? { matchedAt: parsed["matched-at"] } : {},
        ...typeof parsed["template-id"] === "string" ? { template: parsed["template-id"] } : {}
      });
    } catch {
    }
  }
  return rows;
}

// src/tools/recon.js
var limiter = new ReconLimiter(1, 4);
function hostOf(target) {
  try {
    return new URL(target.includes("://") ? target : `http://${target}`).hostname;
  } catch {
    return target;
  }
}
function requireScope(exec, target, lab) {
  var _a, _b, _c, _d, _e;
  const active = (_b = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id)) != null ? _b : standaloneCase();
  const decision = checkReconTarget(hostOf(target), (_c = active.scope) != null ? _c : [], lab);
  if (!decision.ok)
    throw new Error((_d = decision.reason) != null ? _d : "target rejected");
  return { dir: active.dir, scope: (_e = active.scope) != null ? _e : [] };
}
async function saveRaw(dir, tool, content) {
  const result = await saveEvidence(dir, tool, content, `${tool} output`);
  return result.id;
}
async function httpGet(url) {
  const response = await requestText(url, { method: "GET", headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.8" } });
  return { status: response.status, headers: {}, body: response.text.slice(0, 512 * 1024) };
}
function registerReconTools(ctx) {
  ctx.tools.register((0, import_dsh_tools9.defineTool)({
    name: "recon_passive",
    description: "Passive recon via DNS-over-HTTPS (A/AAAA) for one in-scope domain. Read-only; no port scan.",
    parameters: {
      domain: { type: "string", required: true, description: "In-scope domain, e.g. example.com." },
      lab: { type: "boolean", description: "Allow private/loopback targets (authorized lab only)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a;
      const domain = args.domain.trim().toLowerCase();
      const { dir } = requireScope(exec, domain, args.lab === true);
      const endpoints = [
        "https://dns.alidns.com/resolve",
        "https://dns.google/resolve",
        "https://cloudflare-dns.com/dns-query"
      ];
      let response;
      const failures = [];
      for (const base of endpoints) {
        try {
          response = await requestText(`${base}?name=${encodeURIComponent(domain)}&type=A`, {
            method: "GET",
            headers: { accept: "application/dns-json" }
          });
          break;
        } catch (error) {
          failures.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (response === void 0) {
        throw new Error(`all DoH endpoints failed \u2014 ${failures.join(" | ")}`);
      }
      const evidenceId = await saveRaw(dir, "recon_dns", response.text);
      let parsed = {};
      try {
        parsed = JSON.parse(response.text);
      } catch {
      }
      const rows = ((_a = parsed.Answer) != null ? _a : []).filter((answer) => answer.type === 1 && typeof answer.data === "string");
      addAsset(dir, { kind: "domain", value: domain, source: "doh", evidenceId });
      addAssets(dir, rows.map((answer) => ({
        kind: "host",
        value: String(answer.data),
        parent: domain,
        source: "doh",
        evidenceId
      })));
      return [`recon_passive ${domain}: ${rows.length} A record(s)`, `evidence: ${evidenceId}`, coverageLine(loadAssets(dir))].join("\n");
    }
  }));
  ctx.tools.register((0, import_dsh_tools9.defineTool)({
    name: "recon_ports",
    description: "TCP connect scan of a small explicit port list on one in-scope host. No raw sockets, no shellcode, 1 rps.",
    parameters: {
      target: { type: "string", required: true, description: "In-scope hostname or IP." },
      ports: { type: "array", items: { type: "number" }, description: "Ports (default 22,80,443,445,3389,8080)." },
      lab: { type: "boolean", description: "Allow private/loopback targets (authorized lab only)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a;
      const target = args.target.trim();
      const { dir } = requireScope(exec, target, args.lab === true);
      const ports = [...new Set(((_a = args.ports) != null ? _a : [22, 80, 443, 445, 3389, 8080]).map(Number).filter((port) => Number.isInteger(port) && port > 0 && port < 65536))];
      const net = await Promise.resolve().then(() => __toESM(require("net")));
      const open = [];
      await limiter.acquire(hostOf(target));
      try {
        await Promise.all(ports.map((port) => new Promise((resolve12) => {
          const socket = net.connect({ host: target, port, timeout: 3e3 });
          socket.once("connect", () => {
            open.push(port);
            socket.destroy();
            resolve12();
          });
          socket.once("timeout", () => {
            socket.destroy();
            resolve12();
          });
          socket.once("error", () => resolve12());
        })));
      } finally {
        limiter.release();
      }
      open.sort((a, b) => a - b);
      const evidenceId = await saveRaw(dir, "recon_ports", `target=${target}
ports=${ports.join(",")}
open=${open.join(",")}
`);
      addAsset(dir, { kind: "host", value: target, source: "connect-scan", evidenceId });
      addAssets(dir, open.map((port) => ({ kind: "port", value: String(port), parent: target, source: "connect-scan", evidenceId })));
      return [`recon_ports ${target}: open ${open.join(",") || "(none)"}`, `evidence: ${evidenceId}`, coverageLine(loadAssets(dir))].join("\n");
    }
  }));
  ctx.tools.register((0, import_dsh_tools9.defineTool)({
    name: "recon_http",
    description: "One in-scope HTTP GET baseline with a small technology fingerprint. Read-only; no fuzzing.",
    parameters: {
      url: { type: "string", required: true, description: "In-scope http(s) URL." },
      lab: { type: "boolean", description: "Allow private/loopback targets (authorized lab only)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      const url = args.url.trim();
      const { dir } = requireScope(exec, url, args.lab === true);
      await limiter.acquire(hostOf(url));
      let response;
      try {
        response = await httpGet(url);
      } finally {
        limiter.release();
      }
      const tech = [];
      const body = response.body;
      if (/wp-content|wordpress/i.test(body))
        tech.push("wordpress");
      if (/__NEXT_DATA__|_next\//i.test(body))
        tech.push("nextjs");
      if (/ng-version|angular/i.test(body))
        tech.push("angular");
      if (/react|__REACT_DEVTOOLS/i.test(body))
        tech.push("react");
      if (/vue(?:\.js)?|__VUE__/i.test(body))
        tech.push("vue");
      if (/jquery/i.test(body))
        tech.push("jquery");
      const evidenceId = await saveRaw(dir, "recon_http", `${url}
status=${response.status}
tech=${tech.join(",")}

${body.slice(0, 64 * 1024)}`);
      addAsset(dir, { kind: "url", value: url, source: "http-get", evidenceId });
      addAssets(dir, tech.map((name) => ({ kind: "tech", value: name, parent: url, source: "http-get", evidenceId })));
      return [`recon_http ${url}: HTTP ${response.status}${tech.length > 0 ? ` \xB7 ${tech.join(",")}` : ""}`, `evidence: ${evidenceId}`, coverageLine(loadAssets(dir))].join("\n");
    }
  }));
  ctx.tools.register((0, import_dsh_tools9.defineTool)({
    name: "recon_crawl",
    description: "Same-host link crawl from one in-scope URL (depth <= 2, pages <= 10). No form submission.",
    parameters: {
      url: { type: "string", required: true, description: "In-scope starting URL." },
      depth: { type: "number", description: "Link depth (default 1, max 2)." },
      maxPages: { type: "number", description: "Page cap (default 5, max 10)." },
      lab: { type: "boolean", description: "Allow private/loopback targets (authorized lab only)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a, _b;
      const start = new URL(args.url.trim());
      const { dir } = requireScope(exec, start.href, args.lab === true);
      const depth = Math.max(0, Math.min(2, Math.trunc((_a = args.depth) != null ? _a : 1)));
      const maxPages = Math.max(1, Math.min(10, Math.trunc((_b = args.maxPages) != null ? _b : 5)));
      const seen = /* @__PURE__ */ new Set([start.href]);
      let frontier = [start.href];
      const found = [];
      for (let level = 0; level <= depth && found.length < maxPages; level += 1) {
        const next = [];
        for (const page of frontier) {
          if (found.length >= maxPages)
            break;
          await limiter.acquire(start.hostname);
          try {
            const response = await httpGet(page);
            for (const match of response.body.matchAll(/href=["']([^"'#]+)["']/gi)) {
              let link;
              try {
                link = new URL(match[1], page);
              } catch {
                continue;
              }
              if (link.hostname !== start.hostname || seen.has(link.href))
                continue;
              if (!["http:", "https:"].includes(link.protocol))
                continue;
              seen.add(link.href);
              found.push({ url: link.href, parent: page });
              next.push(link.href);
            }
          } finally {
            limiter.release();
          }
        }
        frontier = next;
        if (frontier.length === 0)
          break;
      }
      const evidenceId = await saveRaw(dir, "recon_crawl", found.map((row) => row.url).join("\n"));
      addAssets(dir, found.map((row) => ({ kind: "url", value: row.url, ...row.parent !== void 0 ? { parent: row.parent } : {}, source: "crawl", evidenceId })));
      return [`recon_crawl ${start.href}: ${found.length} URL(s)`, `evidence: ${evidenceId}`, coverageLine(loadAssets(dir))].join("\n");
    }
  }));
  ctx.tools.register((0, import_dsh_tools9.defineTool)({
    name: "recon_import",
    description: "Import local nmap XML or httpx/nuclei JSONL into the asset ledger. Offline; no scan is started.",
    parameters: {
      path: { type: "string", required: true, description: "Local output file path." },
      format: { type: "string", description: "nmap-xml | httpx-jsonl | nuclei-jsonl (inferred from content when omitted)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a, _b, _c;
      const active = (_b = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id)) != null ? _b : standaloneCase();
      const text = (0, import_node_fs9.readFileSync)(args.path, "utf8");
      const format = (_c = args.format) != null ? _c : /<nmaprun/i.test(text) ? "nmap-xml" : /"matched-at"|"template-id"/.test(text) ? "nuclei-jsonl" : "httpx-jsonl";
      const evidenceId = await saveRaw(active.dir, "recon_import", text);
      let added = 0;
      if (format === "nmap-xml") {
        for (const row of parseNmapXml(text)) {
          addAsset(active.dir, { kind: "host", value: row.host, source: "nmap", evidenceId });
          for (const port of row.ports)
            addAsset(active.dir, { kind: "port", value: String(port), parent: row.host, source: "nmap", evidenceId });
          added += 1 + row.ports.length;
        }
      } else if (format === "nuclei-jsonl") {
        for (const row of parseNucleiJsonl(text)) {
          addAsset(active.dir, { kind: "host", value: row.host, source: "nuclei", evidenceId });
          if (row.matchedAt !== void 0)
            addAsset(active.dir, { kind: "url", value: row.matchedAt, parent: row.host, source: "nuclei", evidenceId });
          added += 1;
        }
      } else {
        for (const row of parseHttpxJsonl(text)) {
          addAsset(active.dir, { kind: "url", value: row.url, source: "httpx", evidenceId });
          for (const tech of row.tech)
            addAsset(active.dir, { kind: "tech", value: tech, parent: row.url, source: "httpx", evidenceId });
          added += 1;
        }
      }
      return [`recon_import ${format}: ${added} asset row(s)`, `evidence: ${evidenceId}`, coverageLine(loadAssets(active.dir))].join("\n");
    }
  }));
}

// src/tools/poc.js
var import_dsh_tools10 = __toESM(require_dsh_tools());

// src/poc.js
var JSON_HEADERS = { "content-type": "application/json" };
var POC_RECIPES = [
  {
    id: "http-diff",
    vulnClass: "http-diff",
    description: "Compare a candidate request with a benign control; useful for auth/status-code differences.",
    successRegex: '"(?:admin|success|true)"|HTTP/\\d\\.\\d 2\\d\\d',
    positive: { method: "GET", headers: { "x-poc": "1" } },
    negative: { method: "GET", headers: { "x-poc": "0" } },
    safe: true
  },
  {
    id: "sqli-boolean",
    vulnClass: "sqli",
    description: "Boolean-based SQLi: true condition must match the success marker, false/control must not.",
    successRegex: "welcome|admin|1 row|login success",
    positive: { method: "GET" },
    negative: { method: "GET" },
    safe: true
  },
  {
    id: "path-traversal",
    vulnClass: "path-traversal",
    description: "Path traversal against a file endpoint; success regex should be a file signature such as root:.",
    successRegex: "root:.*:0:0:|\\[boot loader\\]|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY",
    positive: { method: "GET" },
    negative: { method: "GET" },
    safe: true
  },
  {
    id: "idor",
    vulnClass: "idor",
    description: "Object-level authorization: a second identity must not receive the first identity object.",
    successRegex: '"email"|"user"|"account"|"balance"',
    positive: { method: "GET" },
    negative: { method: "GET" },
    safe: true
  },
  {
    id: "xss-canary",
    vulnClass: "xss",
    description: "Reflected canary: the unique marker must appear unescaped in the positive response.",
    successRegex: "<svg/onload=alert\\(1\\)>|<script>alert\\(1\\)<\/script>",
    positive: { method: "GET" },
    negative: { method: "GET" },
    safe: true
  },
  {
    id: "jwt-none",
    vulnClass: "auth-bypass",
    description: "JWT alg=none acceptance: a stripped-signature token must not authorize the request.",
    successRegex: '"role"\\s*:\\s*"admin"|"authenticated"\\s*:\\s*true',
    positive: { method: "GET" },
    negative: { method: "GET" },
    safe: true
  },
  {
    id: "state-change",
    vulnClass: "state-change",
    description: "Placeholder for a state-changing proof; requires an explicit approval and is not safe by default.",
    successRegex: '"ok"|"success"|"updated"',
    positive: { method: "POST", headers: JSON_HEADERS, body: "{}" },
    negative: { method: "POST", headers: JSON_HEADERS, body: "{}" },
    safe: false
  }
];
function recipeById(id) {
  return POC_RECIPES.find((recipe) => recipe.id === id);
}
function renderPocRequest(recipe, overrides) {
  var _a, _b;
  return {
    method: recipe.method,
    ...recipe.headers !== void 0 || overrides.headers !== void 0 ? { headers: { ...(_a = recipe.headers) != null ? _a : {}, ...(_b = overrides.headers) != null ? _b : {} } } : {},
    ...overrides.body !== void 0 ? { body: overrides.body } : recipe.body !== void 0 ? { body: recipe.body } : {}
  };
}
function classifyPoc(positiveHit, negativeHit) {
  if (positiveHit && !negativeHit)
    return { verdict: "verified", reason: "positive hit; independent control did not hit" };
  if (positiveHit && negativeHit)
    return { verdict: "inconclusive", reason: "control also hit; the marker is not payload-specific" };
  return { verdict: "refuted", reason: "positive request did not reproduce the expected marker" };
}

// src/oob.js
var import_node_http2 = require("http");
var import_node_crypto4 = require("crypto");
var sessions = /* @__PURE__ */ new Map();
function close(session) {
  clearTimeout(session.timer);
  try {
    session.server.close();
  } catch {
  }
  sessions.delete(session.id);
}
async function startOob(ttlMs2 = 5 * 60 * 1e3) {
  var _a;
  const id = (0, import_node_crypto4.randomBytes)(8).toString("hex");
  const server = (0, import_node_http2.createServer)((req, res) => {
    const session2 = sessions.get(id);
    if (session2 === void 0) {
      res.writeHead(404);
      res.end("gone");
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024)
        req.destroy();
    });
    req.on("end", () => {
      var _a2, _b;
      session2.hits.push({
        method: (_a2 = req.method) != null ? _a2 : "GET",
        url: (_b = req.url) != null ? _b : "/",
        headers: req.headers,
        body: body.slice(0, 4096),
        at: new Date().toISOString()
      });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise((resolve12, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve12());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("OOB listener failed to bind");
  }
  const expiresAt = new Date(Date.now() + Math.max(1e4, Math.min(ttlMs2, 15 * 60 * 1e3))).toISOString();
  let timer;
  const session = {
    id,
    url: `http://127.0.0.1:${address.port}/${id}`,
    createdAt: new Date().toISOString(),
    expiresAt,
    hits: [],
    server,
    timer: setTimeout(() => {
      const current = sessions.get(id);
      if (current !== void 0)
        close(current);
    }, ttlMs2)
  };
  timer = session.timer;
  (_a = timer.unref) == null ? void 0 : _a.call(timer);
  sessions.set(id, session);
  return { id, url: session.url, expiresAt };
}
function pollOob(id) {
  const session = sessions.get(id);
  if (session === void 0)
    throw new Error(`unknown or expired OOB session: ${id}`);
  return session.hits.slice();
}
function stopOob(id) {
  const session = sessions.get(id);
  if (session === void 0)
    return false;
  close(session);
  return true;
}

// src/tools/poc.js
var limiter2 = new ReconLimiter(1, 2);
function withSuffix(url, suffix) {
  if (suffix === void 0 || suffix.trim() === "")
    return url;
  const value = suffix.trim();
  if (value.startsWith("?") || value.startsWith("/"))
    return url.replace(/\/$/, "") + value;
  return url + value;
}
function parseHeaders(raw) {
  if (raw === void 0 || raw.trim() === "")
    return void 0;
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("headers must be a JSON object");
  return Object.fromEntries(Object.entries(parsed).map(([key3, value]) => [key3, String(value)]));
}
async function send(url, request) {
  var _a;
  await limiter2.acquire(new URL(url).hostname);
  try {
    const response = await requestText(url, {
      method: request.method,
      headers: (_a = request.headers) != null ? _a : {},
      ...request.body !== void 0 ? { body: request.body } : {}
    });
    return { status: response.status, text: response.text.slice(0, 256 * 1024) };
  } finally {
    limiter2.release();
  }
}
function registerPocTools(ctx) {
  ctx.tools.register((0, import_dsh_tools10.defineTool)({
    name: "run_poc",
    description: "Run a deterministic PoC recipe against one in-scope URL: positive request + independent negative control, then verdict verified/refuted/inconclusive. Safe recipes only unless team.riskApproval=allow. Both raw responses are saved as evidence; cite them in record_finding.",
    parameters: {
      recipe: { type: "string", required: true, description: "http-diff | sqli-boolean | path-traversal | idor | xss-canary | jwt-none | state-change" },
      url: { type: "string", required: true, description: "Target URL. Private/loopback addresses need lab=true." },
      positive_suffix: { type: "string", description: "Query/path suffix for the positive request, e.g. ?id=1%27%20OR%201=1--" },
      negative_suffix: { type: "string", description: "Independent benign suffix for the control request." },
      positive_headers: { type: "string", description: "JSON object of positive request headers." },
      negative_headers: { type: "string", description: "JSON object of negative request headers." },
      positive_body: { type: "string", description: "Positive request body." },
      negative_body: { type: "string", description: "Negative request body." },
      success_regex: { type: "string", description: "Override the recipe marker regex." },
      lab: { type: "boolean", description: "Allow private/loopback targets (authorized lab only)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a, _b, _c, _d, _e;
      const active = (_b = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id)) != null ? _b : standaloneCase();
      const recipe = recipeById(args.recipe);
      if (recipe === void 0)
        throw new Error(`unknown PoC recipe: ${args.recipe}`);
      if (!recipe.safe && loadSettings().team.riskApproval !== "allow") {
        throw new Error(`recipe ${recipe.id} is state-changing; set team.riskApproval=allow or use a safe recipe`);
      }
      const url = args.url.trim();
      const host = new URL(url).hostname;
      const scope = checkReconTarget(host, (_c = active.scope) != null ? _c : [], args.lab === true);
      if (!scope.ok)
        throw new Error((_d = scope.reason) != null ? _d : "target rejected");
      const marker = new RegExp((_e = args.success_regex) != null ? _e : recipe.successRegex, "i");
      const positiveRequest = renderPocRequest(recipe.positive, {
        ...args.positive_headers !== void 0 ? { headers: parseHeaders(args.positive_headers) } : {},
        ...args.positive_body !== void 0 ? { body: args.positive_body } : {}
      });
      const negativeRequest = renderPocRequest(recipe.negative, {
        ...args.negative_headers !== void 0 ? { headers: parseHeaders(args.negative_headers) } : {},
        ...args.negative_body !== void 0 ? { body: args.negative_body } : {}
      });
      const positive = await send(withSuffix(url, args.positive_suffix), positiveRequest);
      const negative = await send(withSuffix(url, args.negative_suffix), negativeRequest);
      const positiveHit = marker.test(positive.text);
      const negativeHit = marker.test(negative.text);
      const verdict = classifyPoc(positiveHit, negativeHit);
      const positiveEvidence = await saveEvidence(active.dir, "poc_positive", `${positive.status}
${positive.text}`, `${recipe.id} positive`);
      const negativeEvidence = await saveEvidence(active.dir, "poc_negative", `${negative.status}
${negative.text}`, `${recipe.id} negative`);
      return [
        `recipe: ${recipe.id} (${recipe.vulnClass})`,
        `positive: HTTP ${positive.status} hit=${positiveHit} evidence=${positiveEvidence.id}`,
        `negative: HTTP ${negative.status} hit=${negativeHit} evidence=${negativeEvidence.id}`,
        `verdict: ${verdict.verdict} \u2014 ${verdict.reason}`,
        `finding link: positive_evidence_ids=[${positiveEvidence.id}] negative_evidence_ids=[${negativeEvidence.id}]`
      ].join("\n");
    }
  }));
  ctx.tools.register((0, import_dsh_tools10.defineTool)({
    name: "oob_start",
    description: "Start a loopback-only OOB callback listener (lab use). Returns a one-time URL/token and expiry; no external service.",
    parameters: { ttl_sec: { type: "number", description: "Listener lifetime seconds (default 300, max 900)." } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      var _a;
      const session = await startOob(((_a = args.ttl_sec) != null ? _a : 300) * 1e3);
      return `oob session: ${session.id}
url: ${session.url}
expires: ${session.expiresAt}
Place this URL in the payload, then poll with oob_poll(id).`;
    }
  }));
  ctx.tools.register((0, import_dsh_tools10.defineTool)({
    name: "oob_poll",
    description: "Poll a loopback OOB session for callback hits; returns method/url/body/at.",
    parameters: { id: { type: "string", required: true, description: "OOB session id from oob_start." } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      const hits = pollOob(args.id);
      return hits.length === 0 ? "no OOB hits yet" : JSON.stringify(hits, null, 2);
    }
  }));
  ctx.tools.register((0, import_dsh_tools10.defineTool)({
    name: "oob_stop",
    description: "Stop a loopback OOB session and free its port.",
    parameters: { id: { type: "string", required: true, description: "OOB session id." } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      return stopOob(args.id) ? `stopped ${args.id}` : `unknown or expired ${args.id}`;
    }
  }));
}

// src/tools/mining.js
var import_dsh_tools11 = __toESM(require_dsh_tools());
var import_node_fs11 = require("fs");

// src/mining.js
var import_node_fs10 = require("fs");
var import_node_path18 = require("path");
var import_node_child_process5 = require("child_process");
var CLASS_RANK = {
  "auth-bypass": 5,
  idor: 5,
  sqli: 5,
  rce: 5,
  ssrf: 4,
  xss: 4,
  "path-traversal": 4,
  "file-upload": 4,
  api: 2,
  unknown: 1
};
function classifyEndpoint(endpoint) {
  const value = endpoint.toLowerCase();
  if (/\/(?:user|account|order|invoice|file|download|upload|admin|api\/v\d+\/)/.test(value))
    return "idor";
  if (/(?:id|q|search|query|filter|sort)=/.test(value))
    return "sqli";
  if (/(?:url|next|redirect|callback|webhook)=/.test(value))
    return "ssrf";
  if (/(?:path|file|template|page|view)=/.test(value))
    return "path-traversal";
  return "api";
}
function key2(candidate) {
  var _a;
  return `${candidate.class}|${candidate.target}|${candidate.endpoint}|${(_a = candidate.param) != null ? _a : ""}`;
}
function dedupeCandidates(candidates) {
  const seen = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const id = key2(candidate);
    const prior = seen.get(id);
    if (prior === void 0 || candidate.confidence > prior.confidence)
      seen.set(id, candidate);
  }
  return [...seen.values()].sort((a, b) => {
    var _a, _b;
    return ((_a = CLASS_RANK[b.class]) != null ? _a : 0) - ((_b = CLASS_RANK[a.class]) != null ? _b : 0) || b.confidence - a.confidence || a.endpoint.localeCompare(b.endpoint);
  });
}
function candidateFromUrl(target, rawUrl, source, confidence) {
  let url;
  try {
    url = new URL(rawUrl, target);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol))
    return null;
  return {
    class: classifyEndpoint(url.pathname + url.search),
    target,
    endpoint: url.pathname + url.search,
    ...url.searchParams.keys().next().done === false ? { param: [...url.searchParams.keys()][0] } : {},
    source,
    confidence
  };
}
function extractHar(text, target) {
  var _a, _b;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = (_a = parsed == null ? void 0 : parsed.log) == null ? void 0 : _a.entries;
  if (!Array.isArray(entries))
    return [];
  const rows = [];
  for (const entry of entries) {
    const raw = (_b = entry == null ? void 0 : entry.request) == null ? void 0 : _b.url;
    if (typeof raw !== "string")
      continue;
    const candidate = candidateFromUrl(target, raw, "har", 0.7);
    if (candidate !== null)
      rows.push(candidate);
  }
  return dedupeCandidates(rows);
}
function extractOpenApi(text, target) {
  var _a;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const paths = parsed == null ? void 0 : parsed.paths;
  if (paths === null || typeof paths !== "object")
    return [];
  const rows = [];
  for (const [endpoint, methods] of Object.entries(paths)) {
    if (methods === null || typeof methods !== "object")
      continue;
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = methods[method];
      if (operation === null || typeof operation !== "object")
        continue;
      const params = (_a = operation.parameters) != null ? _a : [];
      for (const param of params) {
        if (typeof (param == null ? void 0 : param.name) !== "string")
          continue;
        rows.push({
          class: classifyEndpoint(endpoint),
          target,
          endpoint,
          param: param.name,
          source: `openapi:${method}`,
          confidence: 0.8
        });
      }
      if (params.length === 0) {
        rows.push({ class: classifyEndpoint(endpoint), target, endpoint, source: `openapi:${method}`, confidence: 0.6 });
      }
    }
  }
  return dedupeCandidates(rows);
}
var URL_RE = /https?:\/\/[^\s"'`<>\\]+/g;
var PATH_RE = /["'`](\/(?:api|v\d+|rest|graphql|admin|user|account|file|upload|download)[^"'`\s]*)["'`]/g;
function extractText(text, target) {
  const rows = [];
  for (const match of text.matchAll(URL_RE)) {
    const candidate = candidateFromUrl(target, match[0], "text:url", 0.55);
    if (candidate !== null)
      rows.push(candidate);
  }
  for (const match of text.matchAll(PATH_RE)) {
    try {
      const candidate = candidateFromUrl(target, new URL(match[1], target).href, "text:path", 0.5);
      if (candidate !== null)
        rows.push(candidate);
    } catch {
    }
  }
  return dedupeCandidates(rows);
}
function decodeAxmlStrings(buffer) {
  const strings = [];
  let offset = 0;
  const read8 = (at) => {
    let length = buffer[at];
    let cursor = at + 1;
    if ((length & 128) !== 0) {
      length = (length & 127) << 8 | buffer[cursor];
      cursor += 1;
    }
    return [length, cursor];
  };
  const read16 = (at) => {
    let length = buffer.readUInt16LE(at);
    let cursor = at + 2;
    if ((length & 32768) !== 0) {
      length = (length & 32767) << 16 | buffer.readUInt16LE(cursor);
      cursor += 2;
    }
    return [length, cursor];
  };
  while (offset + 8 <= buffer.length) {
    const type = buffer.readUInt16LE(offset);
    const headerSize = buffer.readUInt16LE(offset + 2);
    const size = buffer.readUInt32LE(offset + 4);
    if (size <= 0 || offset + size > buffer.length)
      break;
    if (type === 1 && headerSize >= 28) {
      const stringCount = buffer.readUInt32LE(offset + 8);
      const flags = buffer.readUInt32LE(offset + 16);
      const stringsStart = buffer.readUInt32LE(offset + 20);
      const utf8 = (flags & 256) !== 0;
      for (let index = 0; index < stringCount; index += 1) {
        const stringOffset = buffer.readUInt32LE(offset + headerSize + index * 4);
        let cursor = offset + stringsStart + stringOffset;
        if (utf8) {
          const [, afterChars] = read8(cursor);
          const [byteLength, start] = read8(afterChars);
          cursor = start;
          const raw = buffer.subarray(cursor, cursor + byteLength).toString("utf8");
          strings.push(raw);
        } else {
          const [charLength, start] = read16(cursor);
          cursor = start;
          const raw = buffer.subarray(cursor, cursor + charLength * 2).toString("utf16le");
          strings.push(raw);
        }
      }
    }
    offset += size;
  }
  return strings;
}
function readApkEntry(apkPath, entry = "AndroidManifest.xml") {
  var _a;
  const tar = process.platform === "win32" ? (0, import_node_path18.join)((_a = process.env.SystemRoot) != null ? _a : "C:\\Windows", "System32", "tar.exe") : "tar";
  const result = (0, import_node_child_process5.spawnSync)(tar, ["-xOf", apkPath, entry], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 2e4 });
  if (result.status === 0 && result.stdout !== null && result.stdout.length > 0)
    return Buffer.from(result.stdout);
  return void 0;
}
function extractApk(text, target, apkPath) {
  var _a;
  const strings = apkPath !== void 0 ? decodeAxmlStrings((_a = readApkEntry(apkPath)) != null ? _a : Buffer.alloc(0)) : [];
  return extractText([...strings, text].join("\n"), target);
}
function extractCandidates(text, target, format, apkPath) {
  if (format === "har")
    return extractHar(text, target);
  if (format === "openapi")
    return extractOpenApi(text, target);
  if (format === "apk")
    return extractApk(text, target, apkPath);
  return extractText(text, target);
}
function candidatesPath(caseDir) {
  return (0, import_node_path18.join)(caseDir, "mining", "candidates.jsonl");
}
function writeCandidates(caseDir, candidates) {
  (0, import_node_fs10.mkdirSync)((0, import_node_path18.join)(caseDir, "mining"), { recursive: true });
  (0, import_node_fs10.writeFileSync)(candidatesPath(caseDir), candidates.map((candidate) => JSON.stringify(candidate)).join("\n") + "\n", "utf8");
}
function loadCandidates(caseDir) {
  if (!(0, import_node_fs10.existsSync)(candidatesPath(caseDir)))
    return [];
  const rows = [];
  for (const line of (0, import_node_fs10.readFileSync)(candidatesPath(caseDir), "utf8").split("\n")) {
    if (line.trim() === "")
      continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.class === "string" && typeof parsed.endpoint === "string") {
        rows.push({
          class: parsed.class,
          target: typeof parsed.target === "string" ? parsed.target : "",
          endpoint: parsed.endpoint,
          ...typeof parsed.param === "string" ? { param: parsed.param } : {},
          source: typeof parsed.source === "string" ? parsed.source : "unknown",
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5
        });
      }
    } catch {
    }
  }
  return rows;
}
function miningLine(caseDir, assetCount) {
  const candidates = loadCandidates(caseDir);
  const tested = new Set(candidates.filter((candidate) => candidate.class === "unknown").map((candidate) => candidate.endpoint));
  return `[mining] candidates ${candidates.length} \xB7 untested ${Math.max(0, candidates.length - tested.size)} \xB7 assets ${assetCount}`;
}

// src/tools/mining.js
function registerMiningTools(ctx) {
  ctx.tools.register((0, import_dsh_tools11.defineTool)({
    name: "mine_candidates",
    description: "Extract candidate endpoints/parameters from a local HAR, OpenAPI/Swagger, JS/HTML, APK manifest or binary strings into mining/candidates.jsonl. Deterministic, offline, and proposals only \u2014 run_poc must prove them.",
    parameters: {
      path: { type: "string", required: true, description: "Local artifact path (HAR/OpenAPI/JS/HTML)." },
      target: { type: "string", required: true, description: "Target label for the candidates, e.g. https://example.com." },
      format: { type: "string", description: "har | openapi | text | apk (inferred from extension/content when omitted)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a, _b;
      const active = (_b = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id)) != null ? _b : standaloneCase();
      const isApk = args.path.toLowerCase().endsWith(".apk");
      const binary = isApk || /\.(dex|so|dll|exe|bin|elf|macho|dylib)$/i.test(args.path);
      const text = (0, import_node_fs11.readFileSync)(args.path, binary ? "latin1" : "utf8");
      const format = args.format === "har" || args.format === "openapi" || args.format === "text" || args.format === "apk" ? args.format : isApk ? "apk" : args.path.toLowerCase().endsWith(".har") ? "har" : /"openapi"|"swagger"/.test(text.slice(0, 2048)) ? "openapi" : "text";
      const candidates = extractCandidates(text, args.target, format, args.path);
      writeCandidates(active.dir, candidates);
      const evidence = await saveEvidence(active.dir, "mine_candidates", JSON.stringify(candidates, null, 2), `${format} candidates`);
      return [
        `mined ${candidates.length} candidate(s) from ${format}`,
        `evidence: ${evidence.id}`,
        `candidates: ${candidates.slice(0, 8).map((candidate) => `${candidate.class}:${candidate.endpoint}`).join(" \xB7 ") || "(none)"}`,
        `stored: mining/candidates.jsonl (total ${loadCandidates(active.dir).length})`
      ].join("\n");
    }
  }));
}

// src/tools/caseflow.js
var import_dsh_tools12 = __toESM(require_dsh_tools());
var import_node_fs12 = require("fs");
var import_node_path19 = require("path");

// src/mode.js
var DEFAULT_LEVEL = "full";
var sessions2 = /* @__PURE__ */ new Map();
function keyOf(sessionId) {
  return sessionId != null ? sessionId : "__global__";
}
function getLevel(sessionId) {
  var _a;
  return (_a = sessions2.get(keyOf(sessionId))) != null ? _a : DEFAULT_LEVEL;
}

// src/tools/caseflow.js
function resolveWorkspaceRoot(root, exec) {
  var _a, _b, _c, _d, _e;
  return (root == null ? void 0 : root.trim()) || ((_c = (_b = (_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.session) == null ? void 0 : _b.header) == null ? void 0 : _c.cwd) || ((_d = exec == null ? void 0 : exec.agent) == null ? void 0 : _d.cwd) || ((_e = exec == null ? void 0 : exec.agent) == null ? void 0 : _e.workspace);
}
var RULES = [
  "1. Built-in tools first; missing capability \u2192 use shell (gh/curl) to find and install it; custom scripts LAST, only in <case>/scripts/.",
  "2. External CLI output \u2192 save_evidence(label, ...) before citing it.",
  "3. Parameters come from prior tool output in evidence/. Findings cite E ids via record_finding.",
  "4. Resume after compaction \u2192 case_status(); before compaction, bring the CASE.md `## resume` block up to date.",
  "5. A tactic failing 3 times in a row on the same target (no new evidence) \u2192 stop, record the dead end in the case, and never retry it without new evidence."
].join("\n");
function registerCaseflowTools(ctx) {
  ctx.tools.register((0, import_dsh_tools12.defineTool)({
    name: "begin_case",
    description: "Start a case workspace for one sample/investigation: creates <workspace>/helmd-cases/<date>-<slug>/ (sample/, evidence/, scripts/, CASE.md), hashes samples as first evidence, routes the goal, and binds it to this session. Call before analyzing a new sample. Pass root = the workspace directory shown in your environment when unsure.",
    parameters: {
      goal: { type: "string", required: true, description: "What this investigation must deliver." },
      samples: { type: "array", items: { type: "string" }, description: "Absolute paths of sample files to ingest." },
      root: { type: "string", description: "Workspace root; defaults to session cwd, HELMD_CASES_DIR, or process cwd." },
      force: { type: "boolean", description: "Force open a new case even if an uncompleted open case exists on disk." },
      scope: { type: "array", items: { type: "string" }, description: "Recon scope (hostnames/CIDRs). Recon tools refuse targets outside it; private/loopback still needs lab=true." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a, _b, _c, _d, _e, _f;
      const effectiveRoot = resolveWorkspaceRoot(args.root, exec);
      const existing = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
      if (existing) {
        return `A case is already active for this session: ${existing.name}
Close it with end_case() before opening another.`;
      }
      if (!args.force) {
        const openCase = await findOpenCaseOnDisk(effectiveRoot);
        if (openCase) {
          return [
            `Notice: an unclosed case is already open on disk: ${openCase.name}`,
            `Goal: ${openCase.goal}`,
            "",
            `Options:`,
            `1. Resume it: call case_status(name: "${openCase.name}")`,
            `2. Close it first: call end_case(summary: "...")`,
            `3. Force new case: call begin_case(goal: "...", force: true)`
          ].join("\n");
        }
      }
      const mode = getLevel((_b = exec == null ? void 0 : exec.agent) == null ? void 0 : _b.id);
      const info = await createCaseDir({
        goal: (_c = args.goal) != null ? _c : "unspecified",
        samples: (_d = args.samples) != null ? _d : [],
        mode,
        route: "pending",
        root: effectiveRoot,
        ...args.scope !== void 0 && args.scope.length > 0 ? { scope: args.scope } : {}
      });
      bindCase((_e = exec == null ? void 0 : exec.agent) == null ? void 0 : _e.id, info);
      let teamNote = "";
      if (loadSettings().team.autoTicket) {
        try {
          const ticket = createTicket({ goal: (_f = args.goal) != null ? _f : info.goal, caseDir: info.dir });
          teamNote = `team ticket: ${ticket.id} (${ticket.roles.map((r) => r.role).join(", ")}) \u2014 dispatch with team_dispatch`;
        } catch (error) {
          teamNote = `team ticket: skipped (${error instanceof Error ? error.message : String(error)})`;
        }
      }
      return [
        `case opened: ${info.dir}`,
        `mode: ${mode}`,
        ...teamNote !== "" ? [teamNote] : [],
        "",
        RULES
      ].join("\n");
    }
  }));
  ctx.tools.register((0, import_dsh_tools12.defineTool)({
    name: "case_status",
    description: "Re-read the active case state from disk (CASE.md header, samples, recent timeline). Call this FIRST when resuming a task after context compaction \u2014 disk state survives what the conversation loses. Can also resume an existing case by name or inspect cases on disk.",
    parameters: {
      name: { type: "string", description: 'Optional case folder name to resume (or "open"/"latest" to rebind the most recent open case).' },
      root: { type: "string", description: "Optional workspace root directory." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a, _b, _c;
      const effectiveRoot = resolveWorkspaceRoot(args.root, exec);
      let active = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
      if (args.name) {
        if (args.name === "open" || args.name === "latest") {
          const found = await findOpenCaseOnDisk(effectiveRoot);
          if (found) {
            bindCase((_b = exec == null ? void 0 : exec.agent) == null ? void 0 : _b.id, found);
            active = found;
          } else {
            return `No unclosed open case found on disk under ${casesRoot(effectiveRoot)}.`;
          }
        } else {
          const fromDisk = await loadCaseInfoFromDisk(args.name, effectiveRoot);
          if (fromDisk) {
            bindCase((_c = exec == null ? void 0 : exec.agent) == null ? void 0 : _c.id, fromDisk);
            active = fromDisk;
          } else {
            return `Case '${args.name}' not found under ${casesRoot(effectiveRoot)}.`;
          }
        }
      }
      if (!active) {
        const base = casesRoot(effectiveRoot);
        const audit = await auditCasesRoot(effectiveRoot);
        const parts = [
          `No case bound to this session. Recent case dirs (if any) live under ${base} \u2014 inspect and re-run begin_case if resuming.`
        ];
        if (audit.cases.length > 0) {
          parts.push("\nCases on disk:");
          for (const c of audit.cases.slice(0, 5)) {
            parts.push(`  - ${c.name} [${c.status}] (${c.evidenceCount} evidence): ${c.goal.slice(0, 60)}`);
          }
        }
        if (audit.strays.length > 0) {
          parts.push(`
[Notice] Non-case items found under helmd-cases: ${audit.strays.join(", ")}`);
        }
        const openCase = audit.cases.find((c) => c.status === "open");
        if (openCase) {
          parts.push(`
Active unclosed case: ${openCase.name}. To resume: case_status(name: "${openCase.name}")`);
        }
        return parts.join("\n");
      }
      const md = await loadCaseMd(active.dir);
      const lines = md.split("\n");
      const head = lines.slice(0, lines.indexOf("## timeline") >= 0 ? lines.indexOf("## timeline") : 12).join("\n");
      const timeline = lines.filter((l) => l.startsWith("- [")).slice(-5).join("\n");
      const resumeAt = lines.findIndex((l) => l.startsWith("## resume"));
      const resume = resumeAt >= 0 ? lines.slice(resumeAt).join("\n").trim() : "";
      const loose = await listLooseFilesInCase(active.dir);
      const looseNotice = loose.length > 0 ? `

[Warning] ${loose.length} loose unorganized file(s) in case root (will auto-archive to evidence/ on end_case): ${loose.join(", ")}` : "";
      const hypotheses = await loadHypotheses(active.dir);
      const findings = await loadFindings(active.dir);
      const evidence = await listEvidence(active.dir);
      const reconAssets = await loadAssets(active.dir);
      const bySeverity = severityCounts(findings);
      const byStatus = findingStatusCounts(findings);
      const findingStats = findings.length === 0 ? "findings: none" : `findings: ${findings.length} \u2014 critical ${bySeverity.critical} \xB7 high ${bySeverity.high} \xB7 medium ${bySeverity.medium} \xB7 low ${bySeverity.low} \xB7 info ${bySeverity.info} | verified ${byStatus.verified} \xB7 candidate ${byStatus.candidate} \xB7 rejected ${byStatus.rejected} \xB7 duplicate ${byStatus.duplicate} \xB7 wontfix ${byStatus.wontfix}${findings.some((finding) => finding.stale) ? ` | STALE ${findings.filter((finding) => finding.stale).map((finding) => finding.id).join(",")}` : ""}`;
      return [
        `case: ${active.name}`,
        `dir: ${active.dir}`,
        "",
        head,
        "",
        "recent timeline:",
        timeline || "  (empty)",
        looseNotice,
        ...resume ? ["", resume] : [],
        "",
        findingStats,
        coverageLine(reconAssets),
        miningLine(active.dir, reconAssets.length),
        "",
        RULES
      ].join("\n");
    }
  }));
  ctx.tools.register((0, import_dsh_tools12.defineTool)({
    name: "record_finding",
    description: "Register a finding in the case register (findings.json + findings.md). severity is required; CVSS (when given) is authoritative and the asserted value is kept for audit. critical/high need >= 2 evidence ids and non-unverified confidence, otherwise the severity is downgraded. Identical vuln_class+target+title merges into the existing finding. Every evidence id is validated; citing unknown ids or self-authored evidence is rejected.",
    parameters: {
      title: { type: "string", required: true, description: 'Finding title, e.g. "License check is a plaintext base64 compare".' },
      detail: { type: "string", required: true, description: "What was found, how it was observed, and the impact." },
      evidence_ids: { type: "array", items: { type: "string" }, required: true, description: 'e.g. ["E-002","E-005"].' },
      repro_cmd: { type: "string", required: true, description: "Reusable command/tool call that reproduces the conclusion." },
      severity: {
        type: "string",
        required: true,
        description: `One of: ${FINDING_SEVERITIES.join(" | ")}. critical/high require >= 2 evidence ids.`
      },
      vuln_class: { type: "string", description: "Vulnerability class, e.g. auth-bypass / xss / license-bypass; used for dedup." },
      target: { type: "string", description: "Affected target/endpoint/file; used for dedup." },
      confidence: { type: "string", description: `One of: ${FINDING_CONFIDENCES.join(" | ")} (default probable). unverified caps severity at medium.` },
      cvss: { type: "number", description: "CVSS v3 score 0-10; when supplied it overrides severity by the standard bands." },
      cvss_vector: { type: "string", description: "CVSS v3.1 base vector, e.g. CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H. Overrides cvss." },
      status: { type: "string", description: `Initial triage state: ${FINDING_STATUSES.join(" | ")} (default verified after the gates).` },
      negative_evidence_ids: { type: "array", items: { type: "string" }, description: "Independent negative-control evidence ids; must not overlap evidence_ids." },
      negative_control: { type: "string", description: "What the negative control was and why it must not reproduce the finding." },
      poc_id: { type: "string", description: 'PoC recipe/run id from run_poc (e.g. "sqli-boolean"); links the finding to the positive/negative evidence.' }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a, _b, _c, _d, _e, _f, _g;
      const active = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
      if (!active)
        return "No active case. begin_case() first \u2014 findings need an evidence chain.";
      const check = await validateEvidenceIds(active.dir, (_b = args.evidence_ids) != null ? _b : []);
      if (!check.ok) {
        return [
          `REJECTED \u2014 unknown evidence ids: ${check.missing.join(", ")}`,
          `known ids: ${check.known.join(", ") || "(none)"}`,
          "Cite only ids that exist in evidence/. Run the tool that produces the proof first."
        ].join("\n");
      }
      if (((_c = args.repro_cmd) != null ? _c : "").trim() === "") {
        return "REJECTED \u2014 repro_cmd is required: a finding without a reproducible command is not a conclusion.";
      }
      const negativeIds = (_d = args.negative_evidence_ids) != null ? _d : [];
      const overlap = negativeIds.filter((id) => {
        var _a2;
        return ((_a2 = args.evidence_ids) != null ? _a2 : []).includes(id);
      });
      if (overlap.length > 0) {
        return `REJECTED \u2014 negative control must use independent evidence; overlap: ${overlap.join(", ")}`;
      }
      if (negativeIds.length > 0) {
        const negativeCheck = await validateEvidenceIds(active.dir, negativeIds);
        if (!negativeCheck.ok) {
          return `REJECTED \u2014 unknown negative-control evidence ids: ${negativeCheck.missing.join(", ")}`;
        }
        if (((_e = args.negative_control) != null ? _e : "").trim() === "") {
          return "REJECTED \u2014 negative_control is required when negative_evidence_ids are supplied.";
        }
      }
      const uncited = await uncitedClaims(active.dir, args.detail, (_f = args.evidence_ids) != null ? _f : [], negativeIds);
      if (uncited.length > 0) {
        return [
          `REJECTED \u2014 detail contains claims not found verbatim in the cited evidence: ${uncited.slice(0, 8).join(", ")}`,
          "Copy the hash/E-id from the evidence file, or cite the evidence that contains it. Do not paraphrase or invent it."
        ].join("\n");
      }
      try {
        const recorded = await recordFinding(active.dir, {
          title: args.title,
          detail: args.detail,
          evidenceIds: (_g = args.evidence_ids) != null ? _g : [],
          severity: args.severity,
          vulnClass: args.vuln_class,
          target: args.target,
          confidence: args.confidence,
          cvss: typeof args.cvss === "number" ? args.cvss : void 0,
          ...args.cvss_vector !== void 0 ? { cvssVector: args.cvss_vector } : {},
          status: args.status,
          repro: args.repro_cmd,
          negativeEvidenceIds: negativeIds,
          ...args.negative_control !== void 0 ? { negativeControl: args.negative_control } : {},
          ...args.poc_id !== void 0 ? { pocId: args.poc_id } : {}
        });
        const f = recorded.finding;
        return [
          `${recorded.merged ? "finding merged" : "finding recorded"}: ${f.id} [${f.severity}/${f.status}] ${f.title}`,
          `evidence: ${f.evidenceIds.join(", ")} | vuln_class: ${f.vulnClass}${f.cvss !== void 0 ? ` | cvss: ${f.cvss}` : ""}${f.assertedSeverity ? ` | asserted: ${f.assertedSeverity}` : ""}`,
          ...recorded.notes.length > 0 ? [`rules: ${recorded.notes.join("; ")}`] : [],
          `repro: ${args.repro_cmd.trim()}`
        ].join("\n");
      } catch (error) {
        return `REJECTED \u2014 ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }));
  ctx.tools.register((0, import_dsh_tools12.defineTool)({
    name: "update_finding",
    description: "Move one finding through its triage lifecycle (candidate \u2192 verified \u2192 rejected/duplicate/wontfix) or correct its severity with an audit note. Evidence and repro are immutable; use a new record_finding for new evidence.",
    parameters: {
      finding_id: { type: "string", required: true, description: "F-xxx id from the finding register." },
      status: { type: "string", description: `New status: ${FINDING_STATUSES.join(" | ")}.` },
      severity: { type: "string", description: `Corrected severity: ${FINDING_SEVERITIES.join(" | ")}.` },
      note: { type: "string", description: "Why the triage changed (written to the case timeline)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a;
      const active = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
      if (!active)
        return "No active case. begin_case() first.";
      try {
        const updated = await updateFinding(active.dir, args.finding_id, {
          status: args.status,
          severity: args.severity,
          note: args.note
        });
        if (updated === void 0)
          return `REJECTED \u2014 unknown finding id: ${args.finding_id}`;
        return `finding updated: ${updated.id} [${updated.severity}/${updated.status}] ${updated.title}`;
      } catch (error) {
        return `REJECTED \u2014 ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }));
  ctx.tools.register((0, import_dsh_tools12.defineTool)({
    name: "record_hypothesis",
    description: "State a testable hypothesis before running tools. Forces you to think: what do you expect to find, and how will you verify it? Returns H-xxx. Use update_hypothesis after testing.",
    parameters: {
      statement: { type: "string", required: true, description: "What you think is true." },
      expected: { type: "string", required: true, description: "What you expect to observe if true." },
      test_cmd: { type: "string", required: true, description: "Shell command or tool call to verify." },
      negative_cmd: { type: "string", description: "Independent negative-control command (must not reproduce the expected observation)." },
      evidence_ids: { type: "array", items: { type: "string" }, description: "Supporting evidence already collected." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a, _b;
      const active = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
      if (!active)
        return "No active case. begin_case() first \u2014 hypotheses need a case.";
      const all = await loadHypotheses(active.dir);
      const open = all.filter((h2) => h2.status === "open");
      if (open.length >= 1) {
        return [
          `REJECTED \u2014 ${open.length} open hypothesis already exists: ${open.map((h2) => h2.id).join(", ")}.`,
          "Resolve it first with update_hypothesis before creating a new one."
        ].join("\n");
      }
      const h = await recordHypothesis(active.dir, args.statement, args.expected, args.test_cmd, (_b = args.evidence_ids) != null ? _b : [], args.negative_cmd);
      return [
        `hypothesis ${h.id} recorded (open):`,
        `  statement: ${h.statement}`,
        `  expected:  ${h.expected}`,
        `  test_cmd:  ${h.testCmd}`,
        `Run the test, then update_hypothesis(id="${h.id}", status=..., observation=..., evidence_ids=[...])`
      ].join("\n");
    }
  }));
  ctx.tools.register((0, import_dsh_tools12.defineTool)({
    name: "update_hypothesis",
    description: "Resolve a hypothesis after testing. Status must be confirmed / refuted / blocked. confirmed and refuted require an observation and at least one evidence id.",
    parameters: {
      id: { type: "string", required: true, description: 'Hypothesis id, e.g. "H-001".' },
      status: { type: "string", required: true, description: "confirmed | refuted | blocked." },
      observation: { type: "string", required: true, description: "What you actually observed." },
      evidence_ids: { type: "array", items: { type: "string" }, description: "Evidence supporting the verdict." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a, _b, _c, _d, _e;
      const active = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
      if (!active)
        return "No active case.";
      if (!["confirmed", "refuted", "blocked"].includes(args.status)) {
        return `REJECTED \u2014 status must be confirmed | refuted | blocked, got "${args.status}".`;
      }
      if (args.status !== "blocked" && ((_b = args.evidence_ids) != null ? _b : []).length === 0) {
        return `REJECTED \u2014 ${args.status} requires at least one evidence id. Run the test first.`;
      }
      if (args.evidence_ids && args.evidence_ids.length > 0) {
        const check = await validateEvidenceIds(active.dir, args.evidence_ids);
        if (!check.ok) {
          return `REJECTED \u2014 unknown evidence ids: ${check.missing.join(", ")}. Known: ${check.known.join(", ") || "(none)"}.`;
        }
      }
      const h = await updateHypothesis(active.dir, args.id, args.status, args.observation, (_c = args.evidence_ids) != null ? _c : []);
      if (!h)
        return `REJECTED \u2014 hypothesis ${args.id} not found.`;
      return `hypothesis ${h.id} \u2192 ${h.status}. ${(_e = (_d = h.observation) == null ? void 0 : _d.slice(0, 120)) != null ? _e : ""}`;
    }
  }));
  ctx.tools.register((0, import_dsh_tools12.defineTool)({
    name: "end_case",
    description: 'Close the active case: stamps CASE.md completed and unbinds the session. In deep mode at least one recorded finding is required, and every finding must carry repro_cmd. Closing also requires at least one evidence entry on disk, unless the summary states why there is none with "(no-evidence: \u2026)".',
    parameters: { summary: { type: "string", description: "One-line closing summary." } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a, _b, _c, _d, _e;
      const active = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
      if (!active)
        return "No active case bound to this session.";
      const mode = getLevel((_b = exec == null ? void 0 : exec.agent) == null ? void 0 : _b.id);
      if (mode === "deep") {
        const findings = await loadFindings(active.dir);
        if (findings.length === 0) {
          return "DEEP mode requires at least one record_finding before end_case. Evidence chain incomplete.";
        }
        const missingRepro = findings.filter((finding) => {
          var _a2;
          return ((_a2 = finding.repro) != null ? _a2 : "").trim() === "";
        });
        if (missingRepro.length > 0) {
          return [
            `REJECTED \u2014 DEEP mode requires repro_cmd on every finding: ${missingRepro.map((f) => f.title).join(", ")}.`,
            "Re-record the finding with repro_cmd (a command that reproduces it) before closing."
          ].join("\n");
        }
      }
      const openCount = await getOpenHypothesisCount(active.dir);
      if (openCount > 0) {
        const all = await loadHypotheses(active.dir);
        const open = all.filter((h) => h.status === "open");
        return [
          `REJECTED \u2014 ${openCount} open hypothesis(es) must be resolved before closing:`,
          ...open.map((h) => `  ${h.id}: ${h.statement} (test: ${h.testCmd})`),
          "Use update_hypothesis(id, status, observation, evidence_ids) to resolve each one."
        ].join("\n");
      }
      const evidence = await countEvidence(active.dir);
      if (evidence === 0 && !/\(no-evidence:\s*\S/i.test((_c = args.summary) != null ? _c : "")) {
        return [
          "REJECTED \u2014 \u5173\u95ED\u524D\u5FC5\u987B\u4EA4\u4EE3\u8BC1\u636E\uFF1Aevidence/ \u91CC\u4E00\u6761 E-xxx \u90FD\u6CA1\u6709\u3002",
          "\u4E24\u6761\u8DEF\u5F84\uFF1A\u2460 \u5148\u843D\u5730\u8BC1\u636E\uFF08\u8DD1\u5DE5\u5177\uFF0C\u6216 save_evidence(label, ...)\uFF09\u518D\u5173\u95ED\uFF1B",
          "\u2461 \u672C\u6B21\u786E\u5B9E\u65E0\u8BC1\u636E\uFF08\u7EAF\u54A8\u8BE2 / \u88AB\u963B\u585E\uFF09\u5C31\u5728 summary \u91CC\u5199\u660E\uFF1A",
          '   summary: "\u2026 (no-evidence: \u7528\u6237\u4EC5\u54A8\u8BE2\uFF0C\u672A\u63A5\u89E6\u6837\u672C)"\u3002'
        ].join("\n");
      }
      await closeCase(active.dir, args.summary);
      try {
        const metas = await listEvidenceMeta(active.dir);
        const findings = await loadFindings(active.dir);
        await (await Promise.resolve().then(() => __toESM(require_fsp()))).writeFile((0, import_node_path19.join)(active.dir, "evidence", "manifest.json"), JSON.stringify({
          case: active.name,
          goal: active.goal,
          summary: (_d = args.summary) != null ? _d : "",
          chainHead: metas.length > 0 ? metas[metas.length - 1].sha256 : null,
          evidence: metas,
          findings: findings.map((finding) => {
            var _a2;
            return {
              id: finding.id,
              severity: finding.severity,
              status: finding.status,
              evidenceIds: finding.evidenceIds,
              repro: (_a2 = finding.repro) != null ? _a2 : null
            };
          })
        }, null, 2), "utf8");
      } catch {
      }
      unbindCase((_e = exec == null ? void 0 : exec.agent) == null ? void 0 : _e.id);
      return `case closed: ${active.name}${args.summary ? ` \u2014 ${args.summary}` : ""}`;
    }
  }));
  ctx.tools.register((0, import_dsh_tools12.defineTool)({
    name: "save_evidence",
    description: "Persist arbitrary output into the active case evidence chain with an E-number. Use for external CLI tools run via shell whose output would otherwise leave no trace. Findings may cite these ids exactly like tool-generated ones.",
    parameters: {
      label: { type: "string", required: true, description: 'Short source label, e.g. "themida-dump".' },
      content: { type: "string", description: "Text to store." },
      file: { type: "string", description: "Path of a file to store instead of inline content." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args, exec) {
      var _a, _b;
      const active = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
      if (!active)
        return "No active case. begin_case() first \u2014 evidence needs a home.";
      let content = (_b = args.content) != null ? _b : "";
      if (!content && args.file) {
        if (!(0, import_node_fs12.existsSync)((0, import_node_path19.resolve)(args.file)))
          return `file not found: ${args.file}`;
        content = `<copied from file: ${(0, import_node_path19.resolve)(args.file)}>
` + await Promise.resolve().then(() => __toESM(require_fsp())).then((m) => m.readFile((0, import_node_path19.resolve)(args.file), "utf8"));
      }
      if (!content.trim())
        return "nothing to save (empty content)";
      const { id } = await saveEvidence(active.dir, `manual_${args.label}`, content, args.label);
      return `[evidence: ${id} saved to ${active.name}]`;
    }
  }));
}

// src/tools/team.js
var import_dsh_tools13 = __toESM(require_dsh_tools());
function isTeamRole(value) {
  return TEAM_ROLES.includes(value);
}
function defaultCaseDir(exec) {
  var _a, _b, _c, _d, _e, _f;
  const bound = getCase((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
  if (bound == null ? void 0 : bound.dir)
    return bound.dir;
  return ((_d = (_c = (_b = exec == null ? void 0 : exec.agent) == null ? void 0 : _b.session) == null ? void 0 : _c.header) == null ? void 0 : _d.cwd) || ((_e = exec == null ? void 0 : exec.agent) == null ? void 0 : _e.cwd) || ((_f = exec == null ? void 0 : exec.agent) == null ? void 0 : _f.workspace) || void 0;
}
var REPORT_STATES = ["progress", "ready", "blocked", "failed", "dropped"];
function renderTicket(ticket) {
  var _a, _b;
  const roles = ticket.roles.map((r) => {
    var _a2, _b2;
    const deps = (_b2 = (_a2 = ticket.roleDeps) == null ? void 0 : _a2[r.role]) != null ? _b2 : [];
    const unmet = deps.filter((dep) => {
      var _a3;
      return ((_a3 = ticket.roles.find((role) => role.role === dep)) == null ? void 0 : _a3.state) !== "done";
    });
    const waits = unmet.length > 0 ? ` [waits: ${unmet.join(", ")}]` : "";
    return `- ${r.role}: ${r.state}${r.sessionId ? ` (${r.sessionId})` : ""}${waits}`;
  }).join("\n");
  const lastByRole = /* @__PURE__ */ new Map();
  for (const report of ticket.reports)
    lastByRole.set(report.role, `[${report.state}] ${report.summary}`);
  const reports = [...lastByRole.entries()].map(([role, line]) => `- ${role}: ${line}`).join("\n");
  const tasks = ((_a = ticket.tasks) != null ? _a : []).map((task) => `- ${task.id} ${task.role} [${task.state}]${task.owner ? ` owner=${task.owner}` : ""}${task.leaseUntil ? ` lease=${task.leaseUntil}` : ""}${task.blockedBy.length > 0 ? ` blockedBy=${task.blockedBy.join(",")}` : ""}`).join("\n");
  const steers = ((_b = ticket.steers) != null ? _b : []).slice(-3).map((steer) => `- ${steer.role}: ${steer.message.slice(0, 120)}`).join("\n");
  return [
    `ticket ${ticket.id} [${ticket.state}] ${ticket.goal}`,
    `case: ${ticket.caseDir}`,
    `roles:
${roles || "(none)"}`,
    tasks !== "" ? `tasks:
${tasks}` : "",
    reports !== "" ? `latest reports:
${reports}` : "latest reports: (none)",
    steers !== "" ? `recent steers:
${steers}` : "",
    ticket.revision ? `pinned revisions: ${JSON.stringify(ticket.artifactRevisions)}` : ""
  ].filter((line) => line !== "").join("\n");
}
function registerTeamTools(ctx) {
  ctx.tools.register((0, import_dsh_tools13.defineTool)({
    name: "team_create",
    description: "Create a team ticket for local multi-agent analysis. Prefer this before team_dispatch: dispatch needs a ticketId. caseDir defaults to the session's active case (begin_case) or its workspace.",
    parameters: {
      goal: { type: "string", required: true, description: "What this team must deliver." },
      roles: { type: "array", items: { type: "string" }, description: `Subset of: ${TEAM_ROLES.join(", ")}. Defaults to the configured default roles.` },
      roleDeps: { type: "string", description: 'Role dependencies, format "role:dep1,dep2;role2:dep" \u2014 e.g. "critic:static,dynamic". A role starts only after its prerequisites are done.' },
      caseDir: { type: "string", description: "Ticket workspace directory; defaults to the active case or session cwd." },
      budgetMinutes: { type: "number", description: "Per-worker wall-time budget in minutes (1-60); workers report blocked when exhausted." },
      maxToolCalls: { type: "number", description: "Advisory tool-call budget for workers; recorded on the ticket." }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args, exec) {
      var _a, _b, _c;
      const caseDir = ((_a = args.caseDir) == null ? void 0 : _a.trim()) || defaultCaseDir(exec);
      if (caseDir === void 0 || caseDir === "") {
        throw new Error("no caseDir: bind a case with begin_case or pass caseDir explicitly");
      }
      const roles = ((_b = args.roles) != null ? _b : []).map(String).filter(isTeamRole);
      const roleDeps = {};
      for (const pair of ((_c = args.roleDeps) != null ? _c : "").split(";")) {
        const [role, deps] = pair.split(":").map((part) => part.trim());
        if (role === void 0 || deps === void 0)
          continue;
        if (!isTeamRole(role))
          continue;
        const valid = deps.split(",").map((dep) => dep.trim()).filter(isTeamRole);
        if (valid.length > 0)
          roleDeps[role] = valid;
      }
      const ticket = createTicket({
        goal: args.goal,
        caseDir,
        roles: roles.length > 0 ? roles : void 0,
        roleDeps: Object.keys(roleDeps).length > 0 ? roleDeps : void 0,
        ...args.budgetMinutes !== void 0 || args.maxToolCalls !== void 0 ? {
          budget: {
            ...args.budgetMinutes !== void 0 ? { wallTimeMs: Math.max(1, Math.min(60, Math.round(args.budgetMinutes))) * 6e4 } : {},
            ...args.maxToolCalls !== void 0 ? { maxToolCalls: Math.max(1, Math.round(args.maxToolCalls)) } : {}
          }
        } : {}
      });
      return [
        `ticket created: ${ticket.id}`,
        `goal: ${ticket.goal}`,
        `case: ${ticket.caseDir}`,
        `roles: ${ticket.roles.map((r) => r.role).join(", ")}`,
        "Dispatch roles with team_dispatch(ticketId, role, task)."
      ].join("\n");
    }
  }));
  ctx.tools.register((0, import_dsh_tools13.defineTool)({
    name: "team_status",
    description: "Read team ticket state: role assignments, latest report per role, pinned artifact revisions. Omit ticketId to list the most recent tickets.",
    parameters: {
      ticketId: { type: "string", description: "Ticket id, e.g. T-001. Omit to list recent tickets." }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      if (args.ticketId !== void 0 && args.ticketId.trim() !== "") {
        const ticket = getTicket(args.ticketId.trim());
        if (ticket === void 0)
          throw new Error(`unknown ticket ${args.ticketId}`);
        return renderTicket(ticket);
      }
      const tickets = listTickets().slice(0, 5);
      if (tickets.length === 0)
        return "no team tickets yet; create one with team_create(goal)";
      return ["recent tickets (newest first):", ...tickets.map(renderTicket)].join("\n\n");
    }
  }));
  ctx.tools.register((0, import_dsh_tools13.defineTool)({
    name: "team_report",
    description: "File a report on a team ticket for one of its roles. Workers should call this for interim results or when blocked; the final child output is recorded automatically, so a final JSON summary in the last message is enough.",
    parameters: {
      ticketId: { type: "string", required: true, description: "Ticket id." },
      role: { type: "string", required: true, description: `One of: ${TEAM_ROLES.join(", ")}; must be part of the ticket.` },
      state: { type: "string", required: true, description: "progress | ready | blocked | failed | dropped" },
      summary: { type: "string", required: true, description: "What was done / found / blocked. Cite evidence ids inline." },
      evidenceIds: { type: "array", items: { type: "string" }, description: 'Evidence ids backing the report, e.g. ["E-001"].' },
      repro: { type: "string", description: "Reproduction command when the report claims a finding." }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args, exec) {
      var _a;
      if (!isTeamRole(args.role))
        throw new Error(`unknown team role: ${args.role}`);
      const state = args.state;
      if (!REPORT_STATES.includes(state)) {
        throw new Error(`state must be one of: ${REPORT_STATES.join(" | ")}`);
      }
      const callerRole = sessionRole((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
      if (callerRole !== void 0 && callerRole !== args.role) {
        throw new Error(`session is assigned role ${callerRole}; it cannot report as ${args.role}`);
      }
      const updated = recordReport({
        ticketId: args.ticketId,
        role: args.role,
        state,
        summary: args.summary,
        evidenceIds: args.evidenceIds,
        repro: args.repro,
        source: "manual"
      });
      return `report recorded on ${updated.id} as ${args.role}/${state} (ticket now ${updated.state})`;
    }
  }));
  ctx.tools.register((0, import_dsh_tools13.defineTool)({
    name: "team_steer",
    description: "Steer a running role worker at its nearest step boundary. Only the orchestrator may steer; the message is recorded on the ticket and delivered through the host subagent manager. Use it to narrow scope or stop a bad path.",
    parameters: {
      ticketId: { type: "string", required: true, description: "Ticket id." },
      role: { type: "string", required: true, description: `Running role: ${TEAM_ROLES.join(", ")}.` },
      message: { type: "string", required: true, description: 'Instruction for the worker, e.g. "\u53EA\u505A\u9759\u6001\u5206\u6790\uFF0C\u7136\u540E blocked \u6C47\u62A5".' }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args, exec) {
      var _a, _b;
      const callerRole = sessionRole((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
      if (callerRole !== void 0 && callerRole !== "orchestrator") {
        throw new Error(`role ${callerRole} cannot steer workers; hand the request back to the orchestrator`);
      }
      if (!isTeamRole(args.role))
        throw new Error(`unknown team role: ${args.role}`);
      const ticket = getTicket(args.ticketId);
      if (ticket === void 0)
        throw new Error(`unknown ticket ${args.ticketId}`);
      const assignment = ticket.roles.find((item) => item.role === args.role);
      if (assignment === void 0)
        throw new Error(`role ${args.role} is not part of ticket ${ticket.id}`);
      const message = args.message.trim();
      let subagents;
      try {
        subagents = (_b = ctx.get) == null ? void 0 : _b.call(ctx, "subagents");
      } catch {
      }
      if ((subagents == null ? void 0 : subagents.steerPrompt) !== void 0 && assignment.sessionId !== void 0 && (exec == null ? void 0 : exec.signal) !== void 0) {
        await subagents.steerPrompt(exec.agent, assignment.sessionId, [{ type: "text", text: `[helm-d steer ${ticket.id}/${args.role}] ${message}` }], { kind: "user" }, exec.signal);
        const steer2 = recordSteer(ticket.id, args.role, message);
        return `steer accepted: ${steer2.id} \u2192 ${args.role} (${assignment.sessionId})`;
      }
      const steer = recordSteer(ticket.id, args.role, message);
      return [
        `steer recorded: ${steer.id} \u2192 ${args.role}`,
        "",
        "\u672C\u673A\u6CA1\u6709 subagent \u7BA1\u7406\u5668\uFF0C\u7528 task \u628A\u8FD9\u6761\u6307\u4EE4\u53D1\u7ED9\u8FD0\u884C\u4E2D\u7684\u5B50\u4EE3\u7406\uFF1A",
        `  task(action="send", id="<\u5B50\u4EE3\u7406 id>", message="${message}")`,
        "\u5B50\u4EE3\u7406 id \u5728\u5B83\u542F\u52A8\u65F6\u7531 task \u8FD4\u56DE\uFF1B\u6307\u4EE4\u4E5F\u4F1A\u7559\u5728\u5DE5\u5355\u65F6\u95F4\u7EBF\u91CC\u3002"
      ].join("\n");
    }
  }));
  ctx.tools.register((0, import_dsh_tools13.defineTool)({
    name: "team_dispatch",
    description: 'Turn one role of a ticket into a ready-to-run subagent task. In Guru, plugin processes cannot spawn subagents directly, so this returns the exact `task` call (agent = "jh-<role>") that the calling AI should execute; the child then reports back via team_report. Only the orchestrator may dispatch.',
    parameters: {
      ticketId: { type: "string", required: true, description: "Ticket id from team_create, e.g. T-001." },
      role: { type: "string", required: true, description: `One of: ${TEAM_ROLES.join(", ")}.` },
      task: { type: "string", description: "Optional focused task for this worker; defaults to the ticket goal." }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      var _a;
      const callerRole = sessionRole((_a = exec == null ? void 0 : exec.agent) == null ? void 0 : _a.id);
      if (callerRole !== void 0 && callerRole !== "orchestrator") {
        throw new Error(`role ${callerRole} cannot dispatch workers; hand the request back to the orchestrator`);
      }
      if (!isTeamRole(args.role))
        throw new Error(`unknown team role: ${args.role}`);
      const ticket = getTicket(args.ticketId.trim());
      if (ticket === void 0)
        throw new Error(`unknown ticket ${args.ticketId}`);
      const step = args.task !== void 0 && args.task.trim() !== "" ? args.task.trim() : ticket.goal;
      return [
        `\u6D3E\u53D1\u65B9\u5F0F\uFF08nox\uFF09\uFF1A\u8C03\u7528 task \u5DE5\u5177\uFF0C\u53C2\u6570\u5982\u4E0B`,
        "",
        `  agent: "jh-${args.role}"`,
        `  description: "${ticket.id} \xB7 ${args.role}"`,
        `  prompt: |`,
        `    \u5DE5\u5355 ${ticket.id}\uFF5C\u76EE\u6807\uFF1A${ticket.goal}`,
        `    \u89D2\u8272\uFF1A${args.role}`,
        `    \u672C\u6B65\u4EFB\u52A1\uFF1A${step}`,
        `    \u5DE5\u4F5C\u76EE\u5F55\uFF1A${ticket.caseDir}`,
        `    \u5B8C\u6210\u540E\u56DE\u586B\uFF1Ateam_report(ticketId="${ticket.id}", role="${args.role}", state="ready", summary="...", evidenceIds=[...])`,
        "",
        "\u5B50\u4EE3\u7406\u7684\u6700\u7EC8\u8F93\u51FA\u4F1A\u88AB\u767B\u8BB0\u4E3A\u62A5\u544A\uFF1B\u4E5F\u53EF\u4EE5\u7528 team_report \u663E\u5F0F\u5199\u4E2D\u671F\u7ED3\u8BBA\u3002"
      ].join("\n");
    }
  }));
}

// src/entry.js
var DOMAINS = [
  ["web", registerWebTools],
  ["android", registerAndroidTools],
  ["native", registerNativeTools],
  ["protocol", registerProtocolTools],
  ["malware", registerMalwareTools],
  ["ai-security", registerAiSecurityTools],
  ["evidence", registerEvidenceTools],
  ["toolbox", registerToolboxTools],
  ["recon", registerReconTools],
  ["poc", registerPocTools],
  ["mining", registerMiningTools],
  ["caseflow", registerCaseflowTools],
  ["team", registerTeamTools]
];
function referenceDomains() {
  try {
    return (0, import_node_fs13.readdirSync)((0, import_node_path20.join)(packageRoot2(), "references"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return null;
  }
}
function registerReferenceTool(ctx, domains) {
  const list = domains !== null ? domains.join(" / ") : "web / native / protocol / malware / ai-security / evidence / android / toolbox / playbooks";
  ctx.tools.register((0, import_dsh_tools14.defineTool)({
    name: "jh_reference",
    description: `Read one doc from the offline security knowledge base (365 docs). domain: ${list}; path is relative to that domain, start with index.md. path may also carry the domain as its first segment ('web/index.md'), in which case domain can be omitted. Returns the document text. Read only what the task needs \u2014 do not dump whole indexes.`,
    parameters: {
      domain: { type: "string", required: false, description: `Reference partition, one of: ${list}` },
      path: { type: "string", required: true, description: "Path inside the domain dir, e.g. index.md, or 'web/index.md'" }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) {
      let domain = String(args.domain === void 0 ? "" : args.domain).trim();
      let rel = String(args.path === void 0 ? "" : args.path).trim().replace(/^[./\\]+/, "");
      if (domain === "") {
        const slash = rel.indexOf("/");
        const head = slash > 0 ? rel.slice(0, slash) : "";
        if (head !== "" && (domains === null || domains.indexOf(head) >= 0)) {
          domain = head;
          rel = rel.slice(slash + 1);
        } else {
          throw new Error(`\u9700\u8981 domain \u53C2\u6570\uFF0C\u6216\u8BA9 path \u4EE5\u5206\u533A\u540D\u5F00\u5934\uFF08\u5982 web/index.md\uFF09\u3002\u53EF\u7528\u5206\u533A: ${list}`);
        }
      }
      if (domains !== null && domains.indexOf(domain) < 0) {
        throw new Error(`unknown domain "${domain}"; available: ${list}`);
      }
      const root = (0, import_node_path20.join)(packageRoot2(), "references", domain);
      const abs = (0, import_node_path20.resolve)(root, rel);
      assertWithinRoot(abs, root);
      return await readTextSeam(ctx, abs);
    }
  }));
}
function collectTools(ctx) {
  const registered = [];
  const skipped = [];
  const inner = {
    get: (name) => typeof ctx.get === "function" ? ctx.get(name) : void 0,
    tools: {
      register(def) {
        const name = String(def && def.name ? def.name : "");
        if (name.endsWith("_reference")) {
          skipped.push(name);
          return;
        }
        registered.push(name);
        ctx.tools.register(def);
      }
    }
  };
  const failures = [];
  for (const [domain, fn] of DOMAINS) {
    try {
      fn(inner);
    } catch (error) {
      failures.push({ domain, error: String(error && error.message || error) });
    }
  }
  try {
    registerReferenceTool(ctx, referenceDomains());
    registered.push("jh_reference");
  } catch (error) {
    failures.push({ domain: "reference", error: String(error && error.message || error) });
  }
  return { registered, skipped, failures };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  collectTools,
  referenceDomains
});
