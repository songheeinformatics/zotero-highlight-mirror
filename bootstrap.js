/* global Zotero, Services */
"use strict";

var HighlightMirror;

function log(msg) {
	Zotero.debug("[HighlightMirror/bootstrap] " + msg);
}

function install() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;

	// ignoreCache: 개발 중 소스 폴더를 직접 올려 쓸 때 시작 캐시의 옛 코드가 로드되는 것을 막는다
	Services.scriptloader.loadSubScriptWithOptions(rootURI + "content/highlightMirror.js", {
		target: globalThis,
		ignoreCache: true,
	});
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
