import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { checkToolPaths, extractToolPaths, globStaticPrefix, isInsideDir, resolveToolPath } from "../src/pathguard.js";
import { tmpDir } from "./helpers.js";

const IS_WIN = process.platform === "win32";

describe("contrôle des chemins (dossier de travail)", () => {
  let tmp: ReturnType<typeof tmpDir>;
  let ws: string;
  let outside: string;

  before(() => {
    tmp = tmpDir();
    ws = path.join(tmp.dir, "Workspace");
    outside = path.join(tmp.dir, "secret");
    mkdirSync(path.join(ws, "src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(ws, "src", "a.txt"), "a");
    writeFileSync(path.join(outside, "key.txt"), "k");
  });
  after(() => tmp.cleanup());

  const ok = (tool: string, input: Record<string, unknown>) => checkToolPaths(tool, input, ws).ok;

  test("chemins dans le dossier : relatifs, absolus, inexistants", () => {
    assert.equal(ok("Read", { file_path: "src/a.txt" }), true);
    assert.equal(ok("Read", { file_path: path.join(ws, "src", "a.txt") }), true);
    assert.equal(ok("Write", { file_path: path.join(ws, "nouveau", "dossier", "b.txt") }), true);
    assert.equal(ok("Read", { file_path: "." }), true);
    assert.equal(ok("Glob", { pattern: "**/*.ts" }), true);
    assert.equal(ok("Grep", { pattern: "x" }), true);
    assert.equal(ok("Grep", { pattern: "x", path: "src", glob: "*.txt" }), true);
  });

  test("chemins hors du dossier refusés", () => {
    assert.equal(ok("Read", { file_path: path.join(outside, "key.txt") }), false);
    assert.equal(ok("Read", { file_path: os.homedir() }), false);
    assert.equal(ok("Write", { file_path: path.join(tmp.dir, "x.txt") }), false);
    assert.equal(ok("Grep", { pattern: "x", path: outside }), false);
    assert.equal(ok("Glob", { pattern: "*", path: outside }), false);
  });

  test("traversée par .. refusée (et .. qui reste dedans acceptée)", () => {
    assert.equal(ok("Read", { file_path: "../secret/key.txt" }), false);
    assert.equal(ok("Read", { file_path: "src/../../secret/key.txt" }), false);
    assert.equal(ok("Read", { file_path: "src/../src/a.txt" }), true);
    assert.equal(ok("Glob", { pattern: "../secret/*" }), false);
    assert.equal(ok("Glob", { pattern: "../../**/*" }), false);
    assert.equal(ok("Grep", { pattern: "x", path: "src", glob: "../../secret/*" }), false);
  });

  test("préfixe de dossier homonyme refusé (Workspace vs Workspace2)", () => {
    assert.equal(ok("Read", { file_path: ws + "2" + path.sep + "x.txt" }), false);
    assert.equal(isInsideDir(ws + "2", ws), false);
  });

  test("~ développé vers le dossier personnel → refusé", () => {
    assert.equal(ok("Read", { file_path: "~/.ssh/id_rsa" }), false);
    assert.equal(ok("Read", { file_path: "~" }), false);
  });

  test("motif glob absolu refusé", () => {
    const abs = path.join(outside, "*.txt");
    assert.equal(ok("Glob", { pattern: abs }), false);
    assert.equal(ok("Glob", { pattern: "/etc/*" }), false);
  });

  test("octet nul et chemins de périphérique refusés", () => {
    assert.equal(ok("Read", { file_path: "src/a.txt\0" }), false);
    assert.equal(resolveToolPath("\\\\?\\C:\\Windows\\win.ini", ws), null);
    assert.equal(resolveToolPath("//./PhysicalDrive0", ws), null);
  });

  test("outils sans chemin : rien à contrôler", () => {
    assert.deepEqual(extractToolPaths("Bash", { command: "cat ../secret/key.txt" }), []);
    assert.deepEqual(extractToolPaths("WebFetch", { url: "https://example.com" }), []);
    assert.deepEqual(extractToolPaths("mcp__x__y", { path: "../a" }), ["../a"]);
    assert.equal(ok("mcp__srv__read", { path: "../secret" }), false);
  });

  test("préfixe statique d'un motif glob", () => {
    assert.equal(globStaticPrefix("**/*.ts"), "");
    assert.equal(globStaticPrefix("src/**/*.ts"), "src");
    assert.equal(globStaticPrefix("../a/*"), [".." , "a"].join(path.sep));
  });

  test("Windows : casse ignorée et séparateurs mélangés", { skip: !IS_WIN }, () => {
    const upper = ws.toUpperCase();
    const lower = ws.toLowerCase();
    assert.equal(ok("Read", { file_path: path.join(upper, "src", "a.txt") }), true);
    assert.equal(ok("Read", { file_path: path.join(lower, "SRC", "A.TXT") }), true);
    const mixed = ws.replace(/\\/g, "/") + "/src\\a.txt";
    assert.equal(ok("Read", { file_path: mixed }), true);
    assert.equal(ok("Read", { file_path: "src\\..\\..\\secret/key.txt" }), false);
    assert.equal(ok("Read", { file_path: outside.replace(/\\/g, "/").toUpperCase() + "/key.txt" }), false);
    // Autre lecteur / racine du lecteur.
    assert.equal(ok("Read", { file_path: "/Windows/win.ini" }), false);
    assert.equal(ok("Read", { file_path: "C:/Windows/win.ini" }), false);
  });

  test("lien (jonction / symlink) vers l'extérieur refusé", (t) => {
    const link = path.join(ws, "lien");
    try {
      symlinkSync(outside, link, IS_WIN ? "junction" : "dir");
    } catch {
      t.skip("création de lien impossible sur ce système");
      return;
    }
    assert.equal(ok("Read", { file_path: "lien/key.txt" }), false);
    assert.equal(ok("Write", { file_path: "lien/nouveau.txt" }), false);
    assert.equal(ok("Grep", { pattern: "x", path: "lien" }), false);
  });
});
