import test from "node:test";
import assert from "node:assert/strict";
import { initializeDesktopWorkspace, markDesktopWorkspaceDraftSaved, restoreDesktopWorkspaceDraft } from "../js/desktop-workspace.js";

test("les brouillons identifiés attendent les champs chargés et ne remplacent pas un homonyme", () => {
    const windowHandlers = new Map();
    const documentHandlers = new Map();
    const timers = new Map();
    let timerId = 0;
    let controls = [];
    class Input {
        constructor(id, name, value) { Object.assign(this, { id, name, value, type: "number", checked: false }); }
        closest(selector) { return selector === "#brands" ? {} : null; }
    }
    class Select {}
    class TextArea {}
    const list = { innerHTML: "" };
    const workspace = {
        hidden: false,
        classList: { toggle() {} },
        addEventListener() {},
        querySelector(selector) { return selector === "[data-workspace-tabs]" ? list : null; }
    };
    const previous = {
        window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage,
        HTMLInputElement: globalThis.HTMLInputElement, HTMLSelectElement: globalThis.HTMLSelectElement,
        HTMLTextAreaElement: globalThis.HTMLTextAreaElement
    };
    try {
        Object.assign(globalThis, {
            HTMLInputElement: Input, HTMLSelectElement: Select, HTMLTextAreaElement: TextArea,
            localStorage: { getItem() { return null; }, setItem() {} },
            window: {
                location: { search: "" },
                addEventListener(type, handler) { windowHandlers.set(type, handler); },
                setTimeout(handler) { const id = ++timerId; timers.set(id, handler); return id; },
                clearTimeout(id) { timers.delete(id); }
            },
            document: {
                body: { dataset: { deviceType: "desktop", accountId: "1", activeCompanyId: "1" } },
                getElementById(id) { return id === "desktopWorkspace" ? workspace : null; },
                addEventListener(type, handler) { documentHandlers.set(type, handler); },
                querySelectorAll() { return controls; },
                createElement() {
                    return { set textContent(value) { this.innerHTML = String(value); }, innerHTML: "" };
                }
            }
        });
        initializeDesktopWorkspace();
        const view = { detail: { type: "route", route: "home", title: "Accueil" } };
        windowHandlers.get("depannhome:application-view")(view);
        controls = [
            new Input("reminder-rule-1-lead", "leadDays", "41"),
            new Input("reminder-create-lead", "leadDays", "17"),
            new Input("", "legacy", "9")
        ];
        documentHandlers.get("input")({ target: controls[0] });
        windowHandlers.get("depannhome:application-view")(view);
        assert.equal(timers.size, 3);

        controls = [new Input("reminder-create-lead", "leadDays", "0"), new Input("", "legacy", "0")];
        const [firstId, firstTimer] = timers.entries().next().value;
        timers.delete(firstId);
        firstTimer();
        assert.equal(controls[0].value, "17", "Le champ absent ne doit pas écraser un homonyme.");
        assert.equal(controls[1].value, "9", "Les anciens champs sans identifiant restent restaurables par nom.");

        controls.unshift(new Input("reminder-rule-1-lead", "leadDays", "0"));
        assert.equal(restoreDesktopWorkspaceDraft(), true);
        assert.deepEqual(controls.map(control => control.value), ["41", "17", "9"]);
        assert.equal(timers.size, 0, "Les restaurations différées ne doivent plus écraser une saisie récente.");
        assert.equal(markDesktopWorkspaceDraftSaved(), true);
        assert.equal(restoreDesktopWorkspaceDraft(), false);
    } finally {
        Object.assign(globalThis, previous);
    }
});
