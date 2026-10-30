#!/usr/bin/env node
/**
 * 打安卓 APK：npm run dist:apk [-- --release]
 *
 * 只做三件事：
 *   1. 找一个能用的 JDK(>=17) 和 Gradle(>=8.7)，找不到就说清楚缺什么
 *   2. 在 android/ 里跑 assembleDebug（或 assembleRelease）
 *   3. 把产物拷到 out/XinghaiFM-<version>-debug.apk，跟 CI 的命名一致
 *
 * 环境变量（都可选）：JAVA_HOME / GRADLE_HOME / GRADLE_BIN / ANDROID_HOME
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ANDROID_DIR = path.join(ROOT, "android");
const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";

const release = process.argv.includes("--release");
const task = release ? "assembleRelease" : "assembleDebug";
const variant = release ? "release" : "debug";

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function javaMajor(dir) {
  const bin = path.join(dir, "bin", "java" + EXE);
  if (!isFile(bin)) return 0;
  const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
  const out = (r.stderr || "") + (r.stdout || "");
  const m = out.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  let major = Number(m[1]);
  if (major === 1) major = Number(m[2] || 0); // 1.8.0_281 这种老写法
  return major;
}

/** JDK：JAVA_HOME 优先，其次扫几个常见安装目录，挑版本最高的那个 >= 17 */
function findJdk() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);

  const roots = [
    process.env.ProgramFiles,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Java") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Eclipse Adoptium") : null,
    "/Library/Java/JavaVirtualMachines",
    "/usr/lib/jvm",
    path.join(os.homedir(), ".jdks"),
    "D:/develop/Java",
    "C:/develop/Java",
    "D:/Java",
    "C:/Java",
  ].filter(Boolean);

  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = path.join(root, name);
      if (isDir(p) && (isDir(path.join(p, "bin")) || isDir(path.join(p, "Contents", "Home", "bin")))) {
        candidates.push(isDir(path.join(p, "Contents", "Home", "bin")) ? path.join(p, "Contents", "Home") : p);
      }
    }
  }

  let best = null;
  for (const dir of candidates) {
    const major = javaMajor(dir);
    if (major >= 17 && (!best || major > best.major)) best = { dir, major };
  }
  return best;
}

function gradleCandidates() {
  const list = [];
  if (process.env.GRADLE_BIN) list.push(process.env.GRADLE_BIN);
  if (process.env.GRADLE_HOME) list.push(path.join(process.env.GRADLE_HOME, "bin", "gradle" + (WIN ? ".bat" : "")));
  list.push(path.join(ANDROID_DIR, WIN ? "gradlew.bat" : "gradlew"));

  // PATH 里找，避免 execSync("which") 的额外开销
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    list.push(path.join(dir, "gradle" + (WIN ? ".bat" : "")));
    list.push(path.join(dir, "gradle"));
  }

  // Gradle 官网 zip 解压后的常见落点 + wrapper 缓存
  const roots = [
    path.join(ANDROID_DIR, ".tools"),
    "D:/develop",
    "C:/develop",
    "D:/",
    "C:/",
    path.join(os.homedir(), ".gradle", "wrapper", "dists"),
  ];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = path.join(root, name);
      if (!isDir(p)) continue;
      if (/^gradle[-.]?\d/i.test(name)) {
        list.push(path.join(p, "bin", "gradle" + (WIN ? ".bat" : "")));
      } else if (root.endsWith(path.join("wrapper", "dists")) && name.startsWith("gradle-")) {
        for (const hash of fs.readdirSync(p)) {
          const inner = fs.readdirSync(path.join(p, hash)).filter((n) => n.startsWith("gradle-"));
          for (const g of inner) {
            list.push(path.join(p, hash, g, "bin", "gradle" + (WIN ? ".bat" : "")));
          }
        }
      }
    }
  }
  return list;
}

function findGradle() {
  for (const p of gradleCandidates()) {
    if (isFile(p)) return p;
  }
  return null;
}

/** SDK 只是为了报错更友好；Gradle 自己会读 android/local.properties */
function findSdk() {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (fromEnv && isDir(fromEnv)) return fromEnv;
  try {
    const txt = fs.readFileSync(path.join(ANDROID_DIR, "local.properties"), "utf8");
    const m = txt.match(/^sdk\.dir=(.+)$/m);
    if (m) {
      const p = m[1].trim().replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => d.toUpperCase() + ":");
      if (isDir(p)) return p;
    }
  } catch {}
  return null;
}

function fail(msg) {
  console.error("\n  ✗ " + msg + "\n");
  process.exit(1);
}

function main() {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

  const jdk = findJdk();
  if (!jdk) fail("没找到 JDK 17 或更高版本。装一个（如 Temurin 21）后重试，或设 JAVA_HOME 指过去。");

  const gradle = findGradle();
  if (!gradle) {
    fail(
      "没找到 Gradle。三种办法任选其一：\n" +
        "    1) 下载 gradle-8.9-bin.zip 解压到 D:/develop/ 或 android/.tools/\n" +
        "    2) 设置 GRADLE_HOME 指向解压目录\n" +
        "    3) 直接跑 GitHub Actions 的 Android APK workflow"
    );
  }

  const sdk = findSdk();
  console.log("  JDK    " + jdk.dir + "  (" + jdk.major + ")");
  console.log("  Gradle " + gradle);
  console.log("  SDK    " + (sdk || "未检测到，交给 Gradle 自己找（android/local.properties）"));
  console.log("  构建   " + task + "  v" + version + "\n");

  const env = {
    ...process.env,
    JAVA_HOME: jdk.dir,
    PATH: path.join(jdk.dir, "bin") + path.delimiter + (process.env.PATH || ""),
  };
  if (sdk) {
    env.ANDROID_HOME = sdk;
    env.ANDROID_SDK_ROOT = sdk;
  }

  const r = spawnSync(gradle, [task, "--no-daemon", "-p", ANDROID_DIR], {
    stdio: "inherit",
    env,
    shell: WIN && /\.bat$/i.test(gradle),
  });
  if (r.status !== 0) fail("Gradle 构建失败，日志见上。");

  const apk = path.join(ANDROID_DIR, "app", "build", "outputs", "apk", variant, "app-" + variant + ".apk");
  if (!isFile(apk)) fail("构建结束但没找到产物：" + apk);

  const outDir = path.join(ROOT, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, "XinghaiFM-" + version + "-" + variant + ".apk");
  fs.copyFileSync(apk, target);

  const size = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  console.log("\n  ✓ " + path.relative(ROOT, target).replace(/\\/g, "/") + "  (" + size + " MB)\n");
}

main();
