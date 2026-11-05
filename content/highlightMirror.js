/* global Zotero, Services, ChromeUtils */
"use strict";

/**
 * Highlight Mirror for Zotero 7+
 *
 * 1) 번역 노트의 하이라이트  →  원문 PDF 하이라이트 주석 (댓글 = 번역문)
 * 2) 원문 PDF  →  Claude API로 단락 단위 번역 노트 + 원문 대응표
 * 3) 노트가 바뀌면(Notifier) 새로 생긴 하이라이트만 자동 미러링
 *
 * 모듈 구성: noteParser / pdfText / matcher / claude / annotator / state / ui / prefs
 */
var HighlightMirror = {
	id: null,
	version: null,
	rootURI: null,
	PREF_BRANCH: "extensions.highlightmirror.",
	TAG: "highlight-mirror",
	API_URL: "https://api.anthropic.com/v1/messages",
	API_VERSION: "2026-10-21",

	_notifierID: null,
	_timers: new Map(), // noteID -> timer id
	_running: new Set(), // noteID currently syncing
	_windows: new Set(),
	_pdfCache: new Map(), // attachmentID -> {mtime, pages}

	// ------------------------------------------------------------------ core
	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	log(msg) {
		Zotero.debug(`[HighlightMirror] ${msg}`);
	},

	pref(key) {
		return Zotero.Prefs.get(this.PREF_BRANCH + key, true);
	},

	setPref(key, value) {
		return Zotero.Prefs.set(this.PREF_BRANCH + key, value, true);
	},

	win() {
		return Zotero.getMainWindow();
	},

	get io() {
		return globalThis.IOUtils || this.win().IOUtils;
	},

	get paths() {
		return globalThis.PathUtils || this.win().PathUtils;
	},

	async main() {
		this._notifierID = Zotero.Notifier.registerObserver(
			this.notifier, ["item"], "highlightMirror");
		await this.state.ensureDir();
		this.server.register();
	},

	shutdown() {
		if (this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
		}
		this.server.unregister();
		for (let t of this._timers.values()) {
			this.win().clearTimeout(t);
		}
		this._timers.clear();
		this._pdfCache.clear();
	},

	notify(headline, text, ms = 6000) {
		try {
			let pw = new Zotero.ProgressWindow({ closeOnClick: true });
			pw.changeHeadline(`Highlight Mirror: ${headline}`);
			if (text) pw.addDescription(text);
			pw.show();
			pw.startCloseTimer(ms);
		}
		catch (e) {
			this.log(`${headline} — ${text}`);
		}
	},

	// ------------------------------------------------------------ notifier
	notifier: {
		notify(event, type, ids, _extra) {
			if (type !== "item" || !["add", "modify"].includes(event)) return;
			let HM = HighlightMirror;
			for (let id of ids) {
				let item = Zotero.Items.get(id);
				if (!item) continue;
				// 번역 노트의 하이라이트 → PDF 주석
				if (item.isNote() && item.parentItemID && HM.pref("autoSync")) {
					if (item.getNote().indexOf("background-color") !== -1) HM.scheduleSync(item.id);
				}
				// 새 PDF 첨부 → 번역 노트
				else if (event === "add" && item.isAttachment() && item.parentItemID && HM.pref("autoTranslate")) {
					if (item.isPDFAttachment()) HM.scheduleTranslate(item.id);
				}
			}
		},
	},

	/**
	 * PDF가 새로 추가되면 파일이 실제로 내려온 뒤 번역을 시작한다.
	 * (웹에서 저장하면 아이템이 먼저 생기고 파일은 몇 초 뒤 도착하므로 재시도)
	 */
	scheduleTranslate(attachmentID, attempt = 0) {
		let win = this.win();
		let key = `t${attachmentID}`;
		if (this._timers.has(key)) win.clearTimeout(this._timers.get(key));
		let delay = attempt === 0 ? 8000 : 15000;
		this._timers.set(key, win.setTimeout(async () => {
			this._timers.delete(key);
			let att = Zotero.Items.get(attachmentID);
			if (!att || !att.parentItemID) return;
			let path = await att.getFilePathAsync();
			if (!path) {
				if (attempt < 12) this.scheduleTranslate(attachmentID, attempt + 1);
				else this.log(`autoTranslate: file never arrived for ${att.key}`);
				return;
			}
			let parent = Zotero.Items.get(att.parentItemID);
			try {
				await this.autoTranslate(parent, att);
			}
			catch (e) {
				this.log(`autoTranslate failed: ${e}\n${e.stack || ""}`);
				this.notify("자동 번역 실패", String(e.message || e), 10000);
			}
		}, delay));
	},

	hasTranslationNote(parent) {
		return Zotero.Items.get(parent.getNotes()).some(n => n.getTags().some(t => t.tag === this.TAG));
	},

	/** 자동 번역 전 검사: 키, 중복, 길이, 언어 */
	async autoTranslate(parent, pdf) {
		if (!(this.pref("apiKey") || "").trim()) {
			this.log("autoTranslate: no API key, skipping");
			return;
		}
		if (this.hasTranslationNote(parent)) {
			this.log(`autoTranslate: ${parent.key} already has a translation note`);
			return;
		}
		let pages = await this.pdfText.getPages(pdf);
		let maxPages = Number(this.pref("maxPages")) || 60;
		if (pages.length > maxPages) {
			this.notify("자동 번역 건너뜀", `${pages.length}쪽은 설정된 한도(${maxPages}쪽)를 넘습니다. 필요하면 우클릭 메뉴로 직접 실행하세요.`, 10000);
			return;
		}
		let sample = pages.slice(0, 3).map(p => p.text).join(" ");
		if (this.looksLikeTargetLanguage(sample)) {
			this.log(`autoTranslate: ${parent.key} already in target language, skipping`);
			return;
		}
		await this.translateItem(parent, { pages });
	},

	/** 대상 언어(기본 한국어)로 이미 쓰인 문서인지 — 한글 비율로 판단 */
	looksLikeTargetLanguage(text) {
		let lang = (this.pref("targetLang") || "한국어");
		let letters = (text.match(/\p{L}/gu) || []).length;
		if (!letters) return false;
		let re = /한국어|korean/i.test(lang) ? /\p{Script=Hangul}/gu
			: /日本語|japanese/i.test(lang) ? /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu
			: /中文|chinese/i.test(lang) ? /\p{Script=Han}/gu
			: null;
		if (!re) return false;
		return (text.match(re) || []).length / letters > 0.2;
	},

	scheduleSync(noteID) {
		let win = this.win();
		if (this._timers.has(noteID)) {
			win.clearTimeout(this._timers.get(noteID));
		}
		let delay = Number(this.pref("debounceMs")) || 4000;
		this._timers.set(noteID, win.setTimeout(async () => {
			this._timers.delete(noteID);
			let note = Zotero.Items.get(noteID);
			if (!note) return;
			try {
				await this.syncNote(note, { manual: false });
			}
			catch (e) {
				this.log(`autoSync failed: ${e}`);
			}
		}, delay));
	},

	// ------------------------------------------------------------------- UI
	addToWindow(window) {
		let doc = window.document;
		if (doc.getElementById("hm-menu-sep")) return;
		let menu = doc.getElementById("zotero-itemmenu");
		if (!menu) return;

		let sep = doc.createXULElement("menuseparator");
		sep.id = "hm-menu-sep";

		let sync = doc.createXULElement("menuitem");
		sync.id = "hm-menu-sync";
		sync.setAttribute("label", "노트 하이라이트 → PDF 주석 (Highlight Mirror)");
		sync.addEventListener("command", () => this.syncSelected(window));

		let translate = doc.createXULElement("menuitem");
		translate.id = "hm-menu-translate";
		translate.setAttribute("label", "원문 PDF → 번역 노트 (Claude)");
		translate.addEventListener("command", () => this.translateSelected(window));

		menu.append(sep, sync, translate);
		this._windows.add(window);
	},

	removeFromWindow(window) {
		let doc = window.document;
		for (let id of ["hm-menu-sep", "hm-menu-sync", "hm-menu-translate"]) {
			let el = doc.getElementById(id);
			if (el) el.remove();
		}
		this._windows.delete(window);
	},

	removeFromAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			this.removeFromWindow(win);
		}
	},

	/** 선택된 아이템에서 처리할 번역 노트 목록을 모은다. */
	_collectNotes(items) {
		let notes = [];
		for (let item of items) {
			if (item.isNote() && item.parentItemID) {
				notes.push(item);
			}
			else if (item.isRegularItem()) {
				notes.push(...Zotero.Items.get(item.getNotes()));
			}
			else if (item.isAttachment() && item.parentItemID) {
				let parent = Zotero.Items.get(item.parentItemID);
				notes.push(...Zotero.Items.get(parent.getNotes()));
			}
		}
		return [...new Set(notes)];
	},

	async syncSelected(window) {
		let items = window.ZoteroPane.getSelectedItems();
		let notes = this._collectNotes(items);
		if (!notes.length) {
			this.notify("대상 없음", "하위 노트가 있는 아이템이나 노트를 선택하세요.");
			return;
		}
		for (let note of notes) {
			try {
				await this.syncNote(note, { manual: true });
			}
			catch (e) {
				this.log(`sync error: ${e}\n${e.stack || ""}`);
				this.notify("오류", String(e.message || e), 10000);
			}
		}
	},

	async translateSelected(window) {
		let items = window.ZoteroPane.getSelectedItems();
		let parents = new Set();
		for (let item of items) {
			if (item.isRegularItem()) parents.add(item);
			else if (item.parentItemID) parents.add(Zotero.Items.get(item.parentItemID));
		}
		for (let parent of parents) {
			try {
				await this.translateItem(parent);
			}
			catch (e) {
				this.log(`translate error: ${e}\n${e.stack || ""}`);
				this.notify("번역 오류", String(e.message || e), 10000);
			}
		}
	},

	// ------------------------------------------------------------- helpers
	async findPDF(parent) {
		for (let id of parent.getAttachments()) {
			let att = Zotero.Items.get(id);
			if (att && att.isPDFAttachment() && await att.getFilePathAsync()) {
				return att;
			}
		}
		return null;
	},

	// ------------------------------------------------ 1) note → PDF annotations
	async syncNote(note, { manual }) {
		if (this._running.has(note.id)) return;
		this._running.add(note.id);
		try {
			await this._syncNote(note, { manual });
		}
		finally {
			this._running.delete(note.id);
		}
	},

	async _syncNote(note, { manual }) {
		let parent = Zotero.Items.get(note.parentItemID);
		let pdf = await this.findPDF(parent);
		if (!pdf) {
			if (manual) this.notify("PDF 없음", "상위 아이템에 PDF 첨부가 없습니다.");
			return;
		}

		let highlights = this.noteParser.extract(note.getNote());
		let state = await this.state.loadNote(note);
		state.pdfKey = pdf.key;

		// 노트에서 사라진 하이라이트 → (옵션) 주석 삭제
		let current = new Set(highlights.map(h => h.hash));
		if (this.pref("removeOrphans")) {
			for (let [hash, annKey] of Object.entries(state.done)) {
				if (current.has(hash)) continue;
				let ann = Zotero.Items.getByLibraryAndKey(pdf.libraryID, annKey);
				if (ann) await ann.eraseTx();
				delete state.done[hash];
			}
		}

		let pending = highlights.filter(h => !state.done[h.hash] && !state.failed?.[h.hash]);
		if (manual) {
			// 수동 실행 때는 이전에 실패한 것도 다시 시도
			pending = highlights.filter(h => !state.done[h.hash]);
		}
		if (!pending.length) {
			if (manual) this.notify("변경 없음", `새 하이라이트가 없습니다. (총 ${highlights.length}개)`);
			await this.state.saveNote(note, state);
			return;
		}

		this.notify("매칭 중", `하이라이트 ${pending.length}개의 원문 위치를 찾습니다…`, 4000);
		let pages = await this.pdfText.getPages(pdf);
		let mapping = await this.state.loadMapping(note);

		// 1단계: 하이라이트 텍스트 자체가 PDF에 있으면(원문 언어 노트) Claude 없이 바로
		let located = [];
		let needClaude = [];
		for (let h of pending) {
			let direct = this.matcher.findInDocument(pages, h.text);
			if (direct) located.push({ hash: h.hash, pageIndex: direct.pageIndex, quote: h.text, direct });
			else needClaude.push(h);
		}

		// 2단계: Claude로 원문 문장 찾기
		if (needClaude.length) {
			let results = await this.claude.locate(needClaude, pages, mapping);
			located.push(...results);
		}

		let color = this.pref("color") || "#ffd400";
		let useNoteColor = this.pref("useNoteColor");
		let commentMode = this.pref("commentMode");
		let ok = 0;
		let fail = [];
		state.failed = state.failed || {};

		for (let loc of located) {
			let h = pending.find(x => x.hash === loc.hash);
			if (!h) continue;
			if (!loc.quote) {
				fail.push(h.text);
				state.failed[h.hash] = { reason: "not-found", at: Date.now() };
				continue;
			}
			let match = loc.direct || this.matcher.findInDocument(pages, loc.quote, loc.pageIndex);
			if (!match) {
				fail.push(h.text);
				state.failed[h.hash] = { reason: "no-rects", quote: loc.quote, at: Date.now() };
				continue;
			}
			let comment = commentMode === "translation" ? h.text : "";
			let annKey = await this.annotator.create(pdf, pages[match.pageIndex], match, {
				text: loc.quote,
				comment,
				color: (useNoteColor && h.color) || color,
			});
			state.done[h.hash] = annKey;
			delete state.failed[h.hash];
			ok++;
		}

		await this.state.saveNote(note, state);
		let msg = `주석 ${ok}개 생성`;
		if (fail.length) msg += `, 못 찾음 ${fail.length}개:\n• ` + fail.map(t => t.slice(0, 40)).join("\n• ");
		this.notify("완료", msg, fail.length ? 12000 : 5000);
	},

	// ---------------------------------------------- 2) PDF → translation note
	async translateItem(parent, { pages } = {}) {
		let pdf = await this.findPDF(parent);
		if (!pdf) {
			this.notify("PDF 없음", "선택한 아이템에 PDF 첨부가 없습니다.");
			return;
		}
		pages = pages || await this.pdfText.getPages(pdf);
		let paragraphs = this.pdfText.toParagraphs(pages);
		let lang = this.pref("targetLang") || "한국어";
		let title = parent.getField("title");

		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("Highlight Mirror: 번역 중");
		let line = new pw.ItemProgress(null, `${title}`);
		pw.show();

		let chunks = this.pdfText.chunkParagraphs(paragraphs, 7000);
		let translated = [];
		for (let i = 0; i < chunks.length; i++) {
			line.setProgress(Math.round((i / chunks.length) * 100));
			line.setText(`${i + 1}/${chunks.length} 구간 번역 중… (${title.slice(0, 40)})`);
			let part = await this.claude.translateChunk(chunks[i], { lang, title });
			translated.push(...part);
		}
		line.setProgress(100);
		pw.startCloseTimer(2000);

		// 노트 HTML + 대응표
		let html = [`<h1>[${lang} 번역] ${this.escape(title)}</h1>`];
		html.push(`<p><em>Highlight Mirror가 Claude API로 만든 개인 연구용 번역입니다. 하이라이트하면 원문 PDF에 같은 자리로 주석이 달립니다.</em></p>`);
		let map = [];
		for (let t of translated) {
			let tag = t.kind === "heading" ? "h2" : "p";
			html.push(`<${tag}>${this.escape(t.ko)}</${tag}>`);
			map.push({ page: t.page, src: t.src, koHash: this.hash(this.noteParser.normalize(t.ko)) });
		}

		let note = new Zotero.Item("note");
		note.libraryID = parent.libraryID;
		note.parentID = parent.id;
		note.setNote(html.join("\n"));
		note.addTag(this.TAG);
		await note.saveTx();
		await this.state.saveMapping(note, { pdfKey: pdf.key, paragraphs: map });
		this.notify("번역 노트 생성", `${translated.length}개 단락, 원문 대응표 저장됨`);
	},

	escape(s) {
		return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	},

	hash(str) {
		// djb2 — 상태 파일 키로만 쓰이므로 짧고 안정적이면 충분
		let h = 5381;
		for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
		return (h >>> 0).toString(36);
	},

	// =================================================================== noteParser
	noteParser: {
		BLOCKS: new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "DIV", "TD", "PRE"]),

		normalize(s) {
			return String(s).replace(/\s+/g, " ").trim();
		},

		isHighlight(el) {
			if (!el || el.nodeType !== 1) return false;
			if (el.tagName === "MARK") return true;
			let st = (el.getAttribute("style") || "").replace(/\s/g, "").toLowerCase();
			return st.includes("background-color:") && !st.includes("background-color:transparent");
		},

		colorOf(el) {
			let st = el.getAttribute("style") || "";
			let m = st.match(/background-color:\s*rgba?\(([^)]+)\)/i);
			if (m) {
				let [r, g, b] = m[1].split(",").map(x => parseInt(x, 10));
				return HighlightMirror.noteParser.nearestZoteroColor(r, g, b);
			}
			let hex = st.match(/background-color:\s*(#[0-9a-f]{6})/i);
			return hex ? hex[1].toLowerCase() : null;
		},

		// Zotero 노트 에디터의 하이라이트 팔레트 → 리더 주석 색
		PALETTE: [
			[255, 212, 0, "#ffd400"], [255, 102, 102, "#ff6666"], [95, 178, 54, "#5fb236"],
			[46, 168, 229, "#2ea8e5"], [162, 138, 229, "#a28ae5"], [229, 110, 238, "#e56eee"],
			[241, 152, 55, "#f19837"], [170, 170, 170, "#aaaaaa"],
		],

		nearestZoteroColor(r, g, b) {
			let best = null;
			let bestD = Infinity;
			for (let [pr, pg, pb, hex] of this.PALETTE) {
				let d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
				if (d < bestD) { bestD = d; best = hex; }
			}
			return best;
		},

		/**
		 * 노트 HTML에서 하이라이트 구간을 뽑는다.
		 * 같은 블록 안에서 연속한 하이라이트 span은 하나로 합친다(에디터가 서식 경계마다 span을 쪼개기 때문).
		 * @returns {Array<{text, color, hash, block}>}
		 */
		extract(html) {
			let DOMParser = HighlightMirror.win().DOMParser;
			let doc = new DOMParser().parseFromString(html, "text/html");
			let out = [];
			let blocks = [...doc.body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, pre")];
			if (!blocks.length) blocks = [doc.body];
			let blockIndex = 0;
			for (let block of blocks) {
				if (block.querySelector("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, pre")) continue; // 중첩 블록은 자식에서 처리
				let run = null;
				const flush = () => {
					if (run && this.normalize(run.text).length >= 2) {
						let text = this.normalize(run.text);
						out.push({ text, color: run.color, block: blockIndex, hash: HighlightMirror.hash(text) });
					}
					run = null;
				};
				let walker = doc.createTreeWalker(block, 1 | 4); // ELEMENT | TEXT
				let node;
				while ((node = walker.nextNode())) {
					if (node.nodeType === 3) {
						let inHL = false;
						let color = null;
						for (let p = node.parentNode; p && p !== block; p = p.parentNode) {
							if (this.isHighlight(p)) { inHL = true; color = color || this.colorOf(p); break; }
						}
						if (inHL) {
							if (!run) run = { text: "", color };
							run.text += node.nodeValue;
						}
						else if (run && /^\s*$/.test(node.nodeValue)) {
							run.text += " "; // 하이라이트 사이의 공백은 이어붙임
						}
						else {
							flush();
						}
					}
				}
				flush();
				blockIndex++;
			}
			return out;
		},
	},

	// ====================================================================== pdfText
	pdfText: {
		_lib: null,

		/** Zotero에 내장된 pdf.js 모듈을 불러온다. 성공한 경로를 로그에 남긴다. */
		async getLib() {
			if (this._lib) return this._lib;
			const url = "resource://zotero/reader/pdf/build/pdf.mjs";
			let lib = null;
			let errors = [];
			try {
				lib = ChromeUtils.importESModule(url, { global: "current" });
				HighlightMirror.log("pdf.js loaded via ChromeUtils.importESModule");
			}
			catch (e) { errors.push(`importESModule: ${e.message}`); }
			if (!lib) {
				try {
					lib = await HighlightMirror.win().eval(`import("${url}")`);
					HighlightMirror.log("pdf.js loaded via window import()");
				}
				catch (e) { errors.push(`window import(): ${e.message}`); }
			}
			if (!lib) {
				throw new Error("pdf.js를 불러올 수 없습니다.\n" + errors.join("\n"));
			}
			try {
				lib.GlobalWorkerOptions.workerSrc = "resource://zotero/reader/pdf/build/pdf.worker.mjs";
			}
			catch (e) { HighlightMirror.log(`workerSrc set failed: ${e}`); }
			this._lib = lib;
			return lib;
		},

		/**
		 * 페이지별 단어 좌표를 반환한다(캐시).
		 * 좌표계는 PDF 사용자 공간(왼쪽 아래 원점) — Zotero annotationPosition.rects와 동일.
		 * @returns {Array<{index, label, width, height, words:[{t, x0,y0,x1,y1, line}], text}>}
		 */
		async getPages(pdf) {
			let path = await pdf.getFilePathAsync();
			let stat = await HighlightMirror.io.stat(path);
			let cached = HighlightMirror._pdfCache.get(pdf.id);
			if (cached && cached.mtime === stat.lastModified) return cached.pages;

			let lib = await this.getLib();
			let data = await HighlightMirror.io.read(path);
			let doc = await lib.getDocument({
				data,
				isEvalSupported: false,
				useSystemFonts: false,
				standardFontDataUrl: "resource://zotero/reader/pdf/web/standard_fonts/",
				cMapUrl: "resource://zotero/reader/pdf/web/cmaps/",
				cMapPacked: true,
			}).promise;

			let labels = null;
			try { labels = await doc.getPageLabels(); } catch (e) { /* none */ }

			let pages = [];
			for (let i = 0; i < doc.numPages; i++) {
				let page = await doc.getPage(i + 1);
				let view = page.view; // [x0, y0, x1, y1]
				let content = await page.getTextContent();
				let words = [];
				let textParts = [];
				let lineNo = 0;
				for (let item of content.items) {
					if (!item.str) { if (item.hasEOL) lineNo++; continue; }
					let [a, b, c, d, e, f] = item.transform;
					let fontH = Math.hypot(c, d) || item.height || 10;
					let x = e - view[0];
					let y = f - view[1];
					// 한 item 안의 단어 위치는 글자 수 비례로 근사
					let str = item.str;
					let totalLen = str.length || 1;
					let re = /\S+/g;
					let m;
					while ((m = re.exec(str))) {
						let x0 = x + (item.width * m.index) / totalLen;
						let x1 = x + (item.width * (m.index + m[0].length)) / totalLen;
						words.push({
							t: m[0],
							x0: round(x0), y0: round(y - fontH * 0.22),
							x1: round(x1), y1: round(y + fontH * 0.82),
							line: lineNo,
							offset: textParts.join(" ").length,
						});
						textParts.push(m[0]);
					}
					if (item.hasEOL) lineNo++;
				}
				pages.push({
					index: i,
					label: (labels && labels[i]) || String(i + 1),
					width: view[2] - view[0],
					height: view[3] - view[1],
					words,
					text: this.joinWords(words),
				});
				page.cleanup();
			}
			await doc.destroy();
			HighlightMirror._pdfCache.set(pdf.id, { mtime: stat.lastModified, pages });
			return pages;

			function round(n) { return Math.round(n * 1000) / 1000; }
		},

		joinWords(words) {
			let out = "";
			let prevLine = -1;
			for (let w of words) {
				if (prevLine !== -1) out += w.line !== prevLine ? "\n" : " ";
				out += w.t;
				prevLine = w.line;
			}
			return out;
		},

		/** 출판사 표지(인용 안내·약관 페이지)인지 */
		isCoverPage(page) {
			let t = page.text;
			return /To cite this article|To link to this article|Full Terms & Conditions|Terms of Use|Downloaded from|This content downloaded/i.test(t)
				&& page.index === 0;
		},

		/**
		 * 여러 페이지에 반복되는 줄(머리글·꼬리글), 쪽번호만 있는 줄을 골라낸다.
		 * @returns {Set<string>} 제거할 줄의 정규화 키
		 */
		runningLines(pages) {
			let count = new Map();
			let norm = s => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
			for (let p of pages) {
				let seen = new Set();
				for (let line of p.text.split("\n")) {
					let k = norm(line);
					if (k.length < 3 || k.length > 90 || seen.has(k)) continue;
					seen.add(k);
					count.set(k, (count.get(k) || 0) + 1);
				}
			}
			let drop = new Set();
			let threshold = Math.max(3, Math.ceil(pages.length * 0.25));
			for (let [k, n] of count) if (n >= threshold) drop.add(k);
			return { drop, norm };
		},

		/** 페이지 텍스트를 단락으로 쪼갠다(빈 줄/문장 끝 + 짧은 줄 휴리스틱). */
		toParagraphs(pages) {
			let paras = [];
			let { drop, norm } = this.runningLines(pages);
			for (let p of pages) {
				if (this.isCoverPage(p)) continue;
				let lines = p.text.split("\n").map(s => s.trim()).filter(Boolean)
					.filter(l => !drop.has(norm(l)) && !/^\d{1,4}$/.test(l));
				let buf = [];
				for (let i = 0; i < lines.length; i++) {
					let line = lines[i];
					buf.push(line);
					let endsSentence = /[.!?:;]["')\]]?$/.test(line);
					let next = lines[i + 1];
					let short = line.length < 45;
					let isHeading = /^(\d+(\.\d+)*\.?\s+\S|[A-Z][A-Za-z ]{2,40}$|Abstract|References|Introduction|Conclusion)/.test(line) && short;
					if (isHeading && buf.length === 1) {
						paras.push({ page: p.index, text: line, kind: "heading" });
						buf = [];
						continue;
					}
					if (!next || (endsSentence && (short || next.length < 45 || /^[A-Z0-9(]/.test(next) && line.length < 60))) {
						paras.push({ page: p.index, text: buf.join(" ").replace(/-\s+(?=[a-z])/g, ""), kind: "para" });
						buf = [];
					}
				}
				if (buf.length) paras.push({ page: p.index, text: buf.join(" "), kind: "para" });
			}
			return paras.filter(x => x.text.length > 1);
		},

		chunkParagraphs(paras, maxChars) {
			let chunks = [];
			let cur = [];
			let len = 0;
			for (let p of paras) {
				if (len + p.text.length > maxChars && cur.length) {
					chunks.push(cur);
					cur = [];
					len = 0;
				}
				cur.push(p);
				len += p.text.length;
			}
			if (cur.length) chunks.push(cur);
			return chunks;
		},
	},

	// ====================================================================== matcher
	matcher: {
		/** 비교용 정규화: 소문자, 합자/따옴표/대시 통일, 영숫자만 남김 */
		key(s) {
			return String(s)
				.normalize("NFKC")
				.toLowerCase()
				.replace(/[‘’“”]/g, "'")
				.replace(/[‐-―­]/g, "-")
				.replace(/[^\p{L}\p{N}]+/gu, "");
		},

		/**
		 * 페이지 단어열에서 인용문 위치를 찾아 줄 단위 rect로 반환.
		 * @returns {{pageIndex, rects, offset, top}|null}
		 */
		findInPage(page, quote) {
			let q = this.key(quote);
			if (q.length < 3) return null;
			// 단어별 key와 누적 위치
			let keys = page.words.map(w => this.key(w.t));
			let starts = [];
			let stream = "";
			for (let k of keys) {
				starts.push(stream.length);
				stream += k;
			}
			let pos = stream.indexOf(q);
			let endPos;
			if (pos !== -1) {
				endPos = pos + q.length;
			}
			else {
				// 앞/뒤 조각으로 느슨하게 찾기 (OCR 오류, 특수문자 차이 흡수)
				let head = q.slice(0, Math.min(24, q.length));
				let tail = q.slice(-Math.min(24, q.length));
				pos = stream.indexOf(head);
				if (pos === -1) return null;
				let tailPos = stream.indexOf(tail, pos + head.length - 1);
				if (tailPos === -1 || tailPos - pos > q.length * 1.6) return null;
				endPos = tailPos + tail.length;
			}
			let first = this.wordAt(starts, pos);
			let last = this.wordAt(starts, endPos - 1);
			if (first === -1 || last === -1) return null;
			let words = page.words.slice(first, last + 1);
			return {
				pageIndex: page.index,
				rects: this.mergeRects(words),
				offset: page.words[first].offset,
				top: Math.max(...words.map(w => w.y1)),
			};
		},

		wordAt(starts, charPos) {
			// starts는 오름차순 — 이진 탐색
			let lo = 0;
			let hi = starts.length - 1;
			let ans = -1;
			while (lo <= hi) {
				let mid = (lo + hi) >> 1;
				if (starts[mid] <= charPos) { ans = mid; lo = mid + 1; }
				else hi = mid - 1;
			}
			return ans;
		},

		/** 같은 줄 단어들을 하나의 rect로 합친다 → [[x0,y0,x1,y1], ...] */
		mergeRects(words) {
			let rects = [];
			let cur = null;
			for (let w of words) {
				if (cur && w.line === cur.line) {
					cur.x0 = Math.min(cur.x0, w.x0);
					cur.x1 = Math.max(cur.x1, w.x1);
					cur.y0 = Math.min(cur.y0, w.y0);
					cur.y1 = Math.max(cur.y1, w.y1);
				}
				else {
					if (cur) rects.push([cur.x0, cur.y0, cur.x1, cur.y1]);
					cur = { ...w };
				}
			}
			if (cur) rects.push([cur.x0, cur.y0, cur.x1, cur.y1]);
			return rects;
		},

		/** 힌트 페이지 → 인접 페이지 → 전체 순으로 찾는다. */
		findInDocument(pages, quote, hintPage) {
			let order = [];
			if (Number.isInteger(hintPage) && pages[hintPage]) {
				order.push(hintPage, hintPage - 1, hintPage + 1);
			}
			for (let i = 0; i < pages.length; i++) order.push(i);
			let seen = new Set();
			for (let i of order) {
				if (i < 0 || i >= pages.length || seen.has(i)) continue;
				seen.add(i);
				let m = this.findInPage(pages[i], quote);
				if (m) return m;
			}
			return null;
		},
	},

	// ======================================================================= claude
	claude: {
		modelSupportsFallback(model) {
			return /^claude-(opus-5|sonnet-5-5|fable)/.test(model);
		},

		async request({ system, user, maxTokens = 16000 }) {
			let apiKey = (HighlightMirror.pref("apiKey") || "").trim();
			if (!apiKey) {
				throw new Error("Claude API 키가 없습니다. 설정 → Highlight Mirror에서 입력하세요.");
			}
			let model = HighlightMirror.pref("model") || "claude-opus-5-5";
			let headers = {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": HighlightMirror.API_VERSION,
			};
			let body = {
				model,
				max_tokens: maxTokens,
				system,
				messages: [{ role: "user", content: user }],
			};
			if (this.modelSupportsFallback(model)) {
				// 안전 분류기가 거부하면 같은 요청을 다른 모델로 서버에서 재시도
				headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
				body.fallbacks = "default";
			}
			let xhr;
			try {
				xhr = await Zotero.HTTP.request("POST", HighlightMirror.API_URL, {
					headers,
					body: JSON.stringify(body),
					responseType: "json",
					timeout: 180000,
				});
			}
			catch (e) {
				let detail = e.xmlhttp?.responseText || e.message || String(e);
				try { detail = JSON.parse(detail).error?.message || detail; } catch (_) { /* raw */ }
				throw new Error(`Claude API 오류: ${detail}`);
			}
			let res = xhr.response;
			if (res.stop_reason === "refusal") {
				throw new Error(`Claude가 요청을 거부했습니다 (${res.stop_details?.category || "unknown"}). 더 작은 구간으로 나누어 다시 시도하세요.`);
			}
			let text = (res.content || []).filter(b => b.type === "text").map(b => b.text).join("");
			return { text, model: res.model, usage: res.usage };
		},

		parseJSONArray(text) {
			let s = text.indexOf("[");
			let e = text.lastIndexOf("]");
			if (s === -1 || e === -1) throw new Error("Claude 응답에서 JSON 배열을 찾지 못했습니다.");
			return JSON.parse(text.slice(s, e + 1));
		},

		/**
		 * 번역 하이라이트 → 원문 인용(verbatim) 찾기
		 * @returns {Array<{hash, pageIndex, quote}>}
		 */
		async locate(highlights, pages, mapping) {
			let docText = pages.map(p => `=== PAGE ${p.index} ===\n${p.text}`).join("\n\n");
			let items = highlights.map((h, i) => {
				let hint = this.hintFor(h, mapping);
				return `${i + 1}. ${h.text}${hint ? `\n   (hint: ${hint})` : ""}`;
			}).join("\n");

			let system = [
				"You align a researcher's reading notes with the original document.",
				"The document text below is the user's own licensed copy of a paper; the notes are the user's private translation of it.",
				"For each numbered translated passage, find the corresponding passage in the ORIGINAL document text and return it VERBATIM (copy characters exactly as they appear, including line breaks replaced by single spaces).",
				"A translated passage may correspond to a clause inside a longer sentence, or to a parenthetical; return just the corresponding span, not the whole sentence, unless the whole sentence is the match.",
				"If several translated passages come from one original sentence, return the distinct span for each.",
				"If you cannot find a match with high confidence, return null for that quote.",
				"Respond with ONLY a JSON array: [{\"id\": 1, \"page\": <PAGE number from the === PAGE n === marker>, \"quote\": \"...\" | null}, ...]",
			].join("\n");

			let user = `DOCUMENT:\n${docText}\n\nTRANSLATED PASSAGES:\n${items}`;
			let { text, usage } = await this.request({ system, user, maxTokens: 8000 });
			HighlightMirror.log(`locate usage: ${JSON.stringify(usage)}`);
			let arr = this.parseJSONArray(text);
			return arr.map((r) => {
				let h = highlights[(r.id | 0) - 1];
				if (!h) return null;
				return { hash: h.hash, pageIndex: Number.isInteger(r.page) ? r.page : null, quote: r.quote ? String(r.quote).trim() : null };
			}).filter(Boolean);
		},

		hintFor(h, mapping) {
			if (!mapping || !mapping.paragraphs) return null;
			// 번역 노트의 단락 해시가 아니라 포함 관계로 찾는 건 비용이 커서, 블록 순서 기반 근사
			let p = mapping.paragraphs[h.block - 2]; // h1 + 안내문 두 블록 뒤부터 본문
			return p ? `page ${p.page}, paragraph starting "${p.src}"` : null;
		},

		/**
		 * 단락 묶음을 번역. 각 단락마다 원문 첫 단어들(src)을 돌려받아 대응표에 쓴다.
		 * @returns {Array<{page, kind, src, ko}>}
		 */
		async translateChunk(paras, { lang, title }) {
			let numbered = paras.map((p, i) => `[${i + 1}] (page ${p.page}, ${p.kind}) ${p.text}`).join("\n\n");
			let system = [
				`You are translating an academic paper into ${lang} for a researcher's private study notes.`,
				"Context: the researcher legally holds this paper and reads it through a translation stored only inside their own Zotero library. This is personal, non-distributed research use; a faithful full translation is required so that each translated paragraph can later be mapped back to the original passage.",
				"Rules:",
				`- Translate each numbered paragraph completely and faithfully into ${lang}; do not summarize, omit, or add commentary.`,
				"- Keep author names, citations (e.g. Paul & Benito, 2018), acronyms, framework names, and numbers exactly as in the source; on first use, put the original English term in parentheses after a translated key term.",
				"- Headings stay headings (short).",
				"- Return ONLY a JSON array with one object per input paragraph, in order:",
				"  [{\"id\": 1, \"src\": \"<first 10 words of the ORIGINAL paragraph, verbatim>\", \"ko\": \"<translation>\"}, ...]",
			].join("\n");
			let user = `Paper: ${title}\n\n${numbered}`;
			let { text, usage } = await this.request({ system, user, maxTokens: 24000 });
			HighlightMirror.log(`translate usage: ${JSON.stringify(usage)}`);
			let arr = this.parseJSONArray(text);
			let out = [];
			for (let r of arr) {
				let p = paras[(r.id | 0) - 1];
				if (!p || !r.ko) continue;
				let src = String(r.src || p.text).split(/\s+/).slice(0, 12).join(" ");
				out.push({ page: p.page, kind: p.kind, src, ko: String(r.ko) });
			}
			return out;
		},

		async ping() {
			let { text, model } = await this.request({ system: "Reply with the single word OK.", user: "ping", maxTokens: 16 });
			return `${model}: ${text.trim()}`;
		},
	},

	// ==================================================================== annotator
	annotator: {
		async create(pdf, page, match, { text, comment, color }) {
			let ann = new Zotero.Item("annotation");
			ann.libraryID = pdf.libraryID;
			ann.parentID = pdf.id;
			ann.annotationType = "highlight";
			ann.annotationText = text;
			ann.annotationComment = comment || "";
			ann.annotationColor = color;
			ann.annotationPageLabel = page.label;
			ann.annotationSortIndex = [
				String(page.index).padStart(5, "0"),
				String(Math.max(0, match.offset | 0)).padStart(6, "0"),
				String(Math.max(0, Math.round(page.height - match.top))).padStart(5, "0"),
			].join("|");
			ann.annotationPosition = JSON.stringify({ pageIndex: page.index, rects: match.rects });
			ann.addTag(HighlightMirror.TAG);
			await ann.saveTx();
			return ann.key;
		},

		async purgeAll() {
			let s = new Zotero.Search();
			s.libraryID = Zotero.Libraries.userLibraryID;
			s.addCondition("tag", "is", HighlightMirror.TAG);
			s.addCondition("itemType", "is", "annotation");
			let ids = await s.search();
			if (ids.length) await Zotero.Items.erase(ids);
			return ids.length;
		},
	},

	// ======================================================================== state
	state: {
		dir() {
			return HighlightMirror.paths.join(Zotero.DataDirectory.dir, "highlight-mirror");
		},

		async ensureDir() {
			await HighlightMirror.io.makeDirectory(this.dir(), { ignoreExisting: true });
		},

		file(prefix, item) {
			return HighlightMirror.paths.join(this.dir(), `${prefix}-${item.libraryID}-${item.key}.json`);
		},

		async readJSON(path, fallback) {
			try {
				if (await HighlightMirror.io.exists(path)) return await HighlightMirror.io.readJSON(path);
			}
			catch (e) { HighlightMirror.log(`readJSON failed ${path}: ${e}`); }
			return fallback;
		},

		async loadNote(note) {
			return this.readJSON(this.file("note", note), { version: 1, done: {}, failed: {} });
		},

		async saveNote(note, data) {
			data.updated = new Date().toISOString();
			await HighlightMirror.io.writeJSON(this.file("note", note), data);
		},

		async loadMapping(note) {
			return this.readJSON(this.file("map", note), null);
		},

		async saveMapping(note, data) {
			await HighlightMirror.io.writeJSON(this.file("map", note), data);
		},
	},

	// ======================================================================= server
	/**
	 * 로컬 HTTP 엔드포인트 (Zotero 커넥터 포트, 기본 23119, localhost 전용).
	 * 테스트·외부 자동화용. 예:
	 *   GET  /highlight-mirror/status
	 *   GET  /highlight-mirror/locate?item=<PDF key>&q=<원문 구절>        (드라이런: 좌표만 계산)
	 *   GET  /highlight-mirror/highlights?note=<note key>                 (노트에서 뽑은 하이라이트)
	 *   POST /highlight-mirror/sync      {"note": "<note key>"}            (실제 주석 생성)
	 *   POST /highlight-mirror/translate {"item": "<parent key>"}          (번역 노트 생성)
	 */
	server: {
		PATHS: ["/highlight-mirror/status", "/highlight-mirror/locate", "/highlight-mirror/highlights",
			"/highlight-mirror/sync", "/highlight-mirror/translate"],

		register() {
			if (!Zotero.Server || !Zotero.Server.Endpoints) return;
			for (let path of this.PATHS) {
				let handler = this.handlers[path.split("/").pop()];
				Zotero.Server.Endpoints[path] = function () {
					this.supportedMethods = ["GET", "POST"];
					this.supportedDataTypes = ["application/json", "application/x-www-form-urlencoded", "text/plain"];
					this.permitBookmarklet = false;
					this.init = async (options) => {
						try {
							let params = Object.fromEntries(options.searchParams?.entries?.() || []);
							let data = options.data;
							if (typeof data === "string" && data.trim()) {
								try { data = JSON.parse(data); } catch (e) { /* keep string */ }
							}
							if (data && typeof data === "object") Object.assign(params, data);
							let result = await handler(params);
							return [200, "application/json", JSON.stringify(result, null, 1)];
						}
						catch (e) {
							HighlightMirror.log(`endpoint error: ${e}\n${e.stack || ""}`);
							return [500, "application/json", JSON.stringify({ error: String(e.message || e) })];
						}
					};
				};
			}
			HighlightMirror.log("endpoints registered");
		},

		unregister() {
			if (!Zotero.Server || !Zotero.Server.Endpoints) return;
			for (let path of this.PATHS) delete Zotero.Server.Endpoints[path];
		},

		byKey(key) {
			let lib = Zotero.Libraries.userLibraryID;
			let item = Zotero.Items.getByLibraryAndKey(lib, key);
			if (!item) throw new Error(`item not found: ${key}`);
			return item;
		},

		handlers: {
			async status() {
				let HM = HighlightMirror;
				let pdfjs = null;
				try {
					let lib = await HM.pdfText.getLib();
					pdfjs = { ok: true, version: lib.version || null };
				}
				catch (e) {
					pdfjs = { ok: false, error: String(e.message || e) };
				}
				return {
					plugin: "highlight-mirror",
					version: HM.version,
					zotero: Zotero.version,
					model: HM.pref("model"),
					hasApiKey: !!(HM.pref("apiKey") || "").trim(),
					autoSync: HM.pref("autoSync"),
					stateDir: HM.state.dir(),
					pdfjs,
				};
			},

			async locate(p) {
				let HM = HighlightMirror;
				let pdf = HM.server.byKey(p.item);
				if (!pdf.isPDFAttachment()) throw new Error("item is not a PDF attachment");
				let pages = await HM.pdfText.getPages(pdf);
				let hint = p.page !== undefined ? parseInt(p.page, 10) : undefined;
				let m = p.q ? HM.matcher.findInDocument(pages, p.q, hint) : null;
				return {
					pages: pages.length,
					words: pages.reduce((n, pg) => n + pg.words.length, 0),
					match: m,
					sample: pages[0]?.text.slice(0, 200),
				};
			},

			async highlights(p) {
				let note = HighlightMirror.server.byKey(p.note);
				if (!note.isNote()) throw new Error("item is not a note");
				return HighlightMirror.noteParser.extract(note.getNote());
			},

			async sync(p) {
				let note = HighlightMirror.server.byKey(p.note);
				if (!note.isNote()) throw new Error("item is not a note");
				await HighlightMirror.syncNote(note, { manual: p.manual !== "false" && p.manual !== false });
				return await HighlightMirror.state.loadNote(note);
			},

			async translate(p) {
				let parent = HighlightMirror.server.byKey(p.item);
				await HighlightMirror.translateItem(parent);
				return { ok: true, notes: parent.getNotes().length };
			},
		},
	},

	// ======================================================================== prefs
	prefs: {
		async testConnection(window) {
			try {
				let r = await HighlightMirror.claude.ping();
				window.alert(`연결 성공 — ${r}`);
			}
			catch (e) {
				window.alert(`연결 실패\n${e.message || e}`);
			}
		},

		openDebug(_window) {
			Zotero.Debug.setStore(true);
			Zotero.openInViewer("chrome://zotero/content/debugViewer.html");
		},

		async purgeAll(window) {
			if (!window.confirm("이 플러그인이 만든 PDF 주석(태그 highlight-mirror)을 모두 삭제할까요? 되돌릴 수 없습니다.")) return;
			let n = await HighlightMirror.annotator.purgeAll();
			window.alert(`${n}개 삭제됨`);
		},
	},
};
