import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const oxlintBin = path.join(
  path.dirname(createRequire(import.meta.url).resolve("oxlint/package.json")),
  "bin/oxlint"
);
const CONFIG_FILE = "oxlint.config.ts";
const OXLINT_TIMEOUT_MS = 120_000;
const DIAGNOSTIC_CODE_PATTERN = /^(?<plugin>[^()]*)\((?<rule>[^()]+)\)$/u;

/**
 * @typedef {object} LintMessage
 * @property {string | null} ruleId
 * @property {1 | 2} severity
 * @property {string} message
 * @property {number} line
 * @property {number} column
 * @property {boolean} fatal
 */

/**
 * @typedef {object} LintResult
 * @property {string} filePath
 * @property {LintMessage[]} messages
 * @property {number} errorCount
 */

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function runOxlint(args, cwd) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [oxlintBin, ...args], {
      cwd,
      maxBuffer: 256 * 1024 * 1024,
      timeout: OXLINT_TIMEOUT_MS,
    });
    return stdout;
  } catch (error) {
    // Oxlint exits non-zero when it reports errors; the JSON report is still on stdout.
    if (typeof error.stdout === "string" && error.stdout.trimStart().startsWith("{")) {
      return error.stdout;
    }
    throw error;
  }
}

/**
 * The repository's oxlint configuration as plain JSON, with plugin paths made absolute so the
 * config can be written anywhere. `rules` replaces the configured rules (and the JS plugins and
 * overrides that configure them) when given.
 *
 * @param {{ rules?: Record<string, unknown> }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function loadRepositoryConfig({ rules } = {}) {
  const config = structuredClone(await (printedConfig ??= printRepositoryConfig()));
  if (rules) {
    config.rules = rules;
    config.jsPlugins = [];
    delete config.overrides;
  }
  return config;
}

let printedConfig;

async function printRepositoryConfig() {
  const printed = await runOxlint(
    ["-c", path.join(repositoryRoot, CONFIG_FILE), "--print-config"],
    repositoryRoot
  );
  const config = JSON.parse(printed);
  config.jsPlugins = (config.jsPlugins ?? []).map((plugin) => path.resolve(repositoryRoot, plugin));
  return config;
}

// Oxlint reports `plugin(rule)`; ESLint-style rule ids are `plugin/rule`, except for core rules.
function toRuleId(code) {
  const match = DIAGNOSTIC_CODE_PATTERN.exec(code ?? "");
  if (!match) return null;
  const { plugin, rule } = match.groups;
  return plugin === "eslint" || plugin === "" ? rule : `${plugin}/${rule}`;
}

/**
 * @param {{ code?: string, severity: string, message: string, labels?: { span: { line: number, column: number } }[] }} diagnostic
 * @returns {LintMessage}
 */
export function toMessage(diagnostic) {
  const span = diagnostic.labels?.[0]?.span;
  return {
    ruleId: toRuleId(diagnostic.code),
    severity: diagnostic.severity === "error" ? 2 : 1,
    message: diagnostic.message,
    line: span?.line ?? 0,
    column: span?.column ?? 0,
    // Parse failures and other non-rule errors carry no rule code.
    fatal: diagnostic.severity === "error" && !DIAGNOSTIC_CODE_PATTERN.test(diagnostic.code ?? ""),
  };
}

/**
 * Lints source text as if it lived at each `filePath` (relative to the repository root) and
 * returns `[{ filePath, messages, errorCount }]` in input order. Oxlint cannot lint stdin, so the
 * sources are written to a temporary tree that mirrors the repository layout; the repository
 * config's `files` globs then apply exactly as they do for real files. All sources are linted in
 * one oxlint run.
 *
 * @param {{ filePath: string, source: string }[]} entries
 * @param {{ config?: Record<string, unknown> }} [options]
 * @returns {Promise<LintResult[]>}
 */
export async function lintTexts(entries, { config } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oxlint-text-"));
  try {
    const resolvedConfig = config ?? (await loadRepositoryConfig());
    await writeFile(path.join(directory, ".oxlintrc.json"), JSON.stringify(resolvedConfig));
    for (const { filePath, source } of entries) {
      const target = path.join(directory, filePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }

    const stdout = await runOxlint(
      [
        "-c",
        ".oxlintrc.json",
        "--disable-nested-config",
        "--format",
        "json",
        ...entries.map(({ filePath }) => filePath),
      ],
      directory
    );
    const { diagnostics } = JSON.parse(stdout);

    return entries.map(({ filePath }) => {
      const messages = diagnostics
        .filter((diagnostic) => diagnostic.filename === filePath)
        .map(toMessage);
      return {
        filePath,
        messages,
        errorCount: messages.filter((message) => message.severity === 2).length,
      };
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Lints one source text; see `lintTexts`.
 *
 * @param {string} source
 * @param {string} filePath
 * @param {{ config?: Record<string, unknown> }} [options]
 * @returns {Promise<LintResult>}
 */
export async function lintText(source, filePath, options) {
  const [result] = await lintTexts([{ filePath, source }], options);
  return result;
}
