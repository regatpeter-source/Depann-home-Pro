import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const editorSource = readFileSync(new URL("../js/leak-report-wizard.js", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("../css/report-editor.css", import.meta.url), "utf8");

test("mobile report actions remain in the viewport while only the editor content scrolls", () => {
    assert.match(styleSource, /body\.mobile-device\.report-writing-active\{height:100dvh;overflow:hidden\}/);
    assert.match(styleSource, /\.report-writing-active \.report-editor-fullscreen\{[^}]*height:100dvh;[^}]*overflow:hidden/);
    assert.match(styleSource, /\.report-writing-active \.report-editor-main\{[^}]*min-height:0;[^}]*overflow-y:auto/);
    assert.match(styleSource, /\.report-writing-active \.report-editor-footer\{[^}]*position:static!important;[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
});

test("a suspended mobile report renews or reacquires its lock without waiting for a reload", () => {
    assert.match(editorSource, /window\.addEventListener\("pageshow", \(\) => recoverReportLock\(\)\)/);
    assert.match(editorSource, /window\.addEventListener\("online", \(\) => recoverReportLock\(\)\)/);
    assert.match(editorSource, /document\.addEventListener\("visibilitychange", \(\) => \{ if \(document\.visibilityState === "hidden"\) saveOnExit\(\); else recoverReportLock\(\); \}\)/);
    assert.match(editorSource, /const recovery = await acquireLock\(\);/);
    assert.match(editorSource, /document\.body\.classList\.contains\("mobile-device"\) \? 20000 : 30000/);
});
