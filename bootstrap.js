/* global Zotero, Services */
"use strict";

var HighlightMirror;

function log(msg) {
	Zotero.debug("[HighlightMirror/bootstrap] " + msg);
}

function install() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;

	Services.scriptloader.loadSubScript(rootURI + "content/highlightMirror.js");
	HighlightMirror.init({ id, version, rootURI });
	Zotero.HighlightMirror = HighlightMirror; // 설정창(preferences.xhtml)에서 접근용

	Zotero.PreferencePanes.register({
		pluginID: id,
		src: rootURI + "content/preferences.xhtml",
		label: "Highlight Mirror",
		scripts: [],
	});

	await HighlightMirror.main();
	for (let win of Zotero.getMainWindows()) {
		HighlightMirror.addToWindow(win);
	}
	log("started " + version);
}

function onMainWindowLoad({ window }) {
	HighlightMirror && HighlightMirror.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	HighlightMirror && HighlightMirror.removeFromWindow(window);
}

function shutdown() {
	if (HighlightMirror) {
		HighlightMirror.removeFromAllWindows();
		HighlightMirror.shutdown();
	}
	delete Zotero.HighlightMirror;
	HighlightMirror = undefined;
	log("shutdown");
}

function uninstall() {}
