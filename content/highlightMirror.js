/* global Zotero, Services, ChromeUtils */
"use strict";

/**
 * Highlight Mirror for Zotero 7+
 *
 * 1) 번역 노트의 하이라이트  →  원문 PDF 하이라이트 주석 (댓글 = 번역문)
 * 2) 원문 PDF  →  Claude API로 단락 단위 번역 노트 + 원문 대응표
 * 3) 노트 → PDF 반영은 우클릭 메뉴로만 (노트를 고칠 때마다 자동 반영하지 않음 — 읽는 중 리더가 튀는 문제)
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
		this.registerReaderMenu();
	},

	shutdown() {
		if (this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
		}
		this.server.unregister();
		this.unregisterReaderMenu();
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
				// 노트 하이라이트 → PDF 주석은 자동으로 하지 않는다(우클릭 메뉴로만).
				// 새 PDF 첨부 → 번역 노트
				if (event === "add" && item.isAttachment() && item.parentItemID && HM.pref("autoTranslate")) {
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
		translate.setAttribute("label", "번역 노트 만들기·다듬기 (Claude)");
		translate.addEventListener("command", () => this.translateSelected(window));

		menu.append(sep, sync, translate);
		this._windows.add(window);
	},

	/** PDF 리더 화면 우클릭 메뉴: 이 논문의 노트 하이라이트를 지금 PDF에 반영 */
	registerReaderMenu() {
		if (this._readerHandler || !Zotero.Reader?.registerEventListener) return;
		this._readerHandler = ({ reader, append }) => {
			append({
				label: "노트 하이라이트 → PDF 주석 (Highlight Mirror)",
				onCommand: () => this.syncForReader(reader),
			});
		};
		Zotero.Reader.registerEventListener("createViewContextMenu", this._readerHandler, this.id);
	},

	unregisterReaderMenu() {
		if (!this._readerHandler) return;
		try {
			Zotero.Reader.unregisterEventListener("createViewContextMenu", this._readerHandler);
		}
		catch (e) { /* 이미 해제됨 */ }
		this._readerHandler = null;
	},

	async syncForReader(reader) {
		let att = Zotero.Items.get(reader.itemID);
		if (!att || !att.parentItemID) {
			this.notify("대상 없음", "상위 아이템이 있는 PDF에서만 쓸 수 있습니다.");
			return;
		}
		let notes = this._collectNotes([att]);
		if (!notes.length) {
			this.notify("대상 없음", "이 논문에 노트가 없습니다.");
			return;
		}
		for (let note of notes) {
			try {
				await this.syncNote(note, { manual: true });
			}
			catch (e) {
				this.log(`sync error: ${e}
${e.stack || ""}`);
				this.notify("오류", String(e.message || e), 10000);
			}
		}
	},

	removeFromWindow(window) {
		let doc = window.document;
		for (let id of ["hm-menu-sep", "hm-menu-sync", "hm-menu-translate", "hm-menu-polish"]) {
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
		this.log(`menu: sync clicked, ${items.length} item(s) selected`);
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

	/** 대응표에 다듬기 완료 표시가 있는가(0.5.0 이후 다듬기를 거친 노트) */
	async isPolished(note) {
		let m = await this.state.loadMapping(note);
		return !!(m && m.polished);
	},

	/** 번역이 끝나지 않았거나(진행 줄이 남음) 실패한 구간이 있는 노트인가 */
	async isBroken(note) {
		let html = note.getNote();
		if (/<em>⏳ |\[구간 \d+ 번역 실패/.test(html)) return true;
		let m = await this.state.loadMapping(note);
		return !!(m && m.complete === false);
	},

	/**
	 * 메뉴 하나로 번역과 다듬기를 처리한다.
	 * - 노트를 직접 골랐으면: 그 노트를 다듬는다(이미 다듬었으면 확인 후).
	 * - 논문을 골랐으면: 번역 노트가 없으면 번역(설정이 켜져 있으면 다듬기 포함),
	 *   아직 안 다듬은 번역 노트가 있으면 그 노트를 다듬고, 모두 다듬었으면 새로 번역할지 묻는다.
	 */
	async translateSelected(window) {
		let items = window.ZoteroPane.getSelectedItems();
		this.log(`menu: translate/polish clicked, ${items.length} item(s) selected`);
		let directNotes = items.filter(i => i.isNote() && i.parentItemID);
		let parents = new Set();
		for (let item of items) {
			if (item.isRegularItem()) parents.add(item);
			else if (item.isAttachment() && item.parentItemID) parents.add(Zotero.Items.get(item.parentItemID));
		}
		if (!parents.size && !directNotes.length) {
			this.notify("대상 없음", "논문 아이템(또는 그 PDF/노트)을 선택한 뒤 실행하세요.");
			return;
		}
		let toPolish = [];
		for (let note of directNotes) {
			if (await this.isPolished(note)
				&& !window.confirm("이 노트는 이미 다듬었습니다. 한 번 더 다듬을까요?")) continue;
			toPolish.push(note);
		}
		let toTranslate = [];
		for (let parent of parents) {
			let notes = Zotero.Items.get(parent.getNotes()).filter(n => n.hasTag(this.TAG));
			if (!notes.length) { toTranslate.push(parent); continue; }
			// 끝나지 않았거나 실패한 구간이 남은 노트는 다듬기 대상이 아니라 다시 번역할 대상
			let broken = [];
			for (let n of notes) if (await this.isBroken(n)) broken.push(n);
			if (broken.length === notes.length) {
				if (window.confirm(`"${parent.getField("title").slice(0, 60)}"의 번역 노트는 끝나지 않았거나 실패한 구간이 있습니다. 새로 번역할까요? (기존 노트는 그대로 둡니다)`)) {
					toTranslate.push(parent);
				}
				continue;
			}
			let raw = [];
			for (let n of notes) if (!broken.includes(n) && !directNotes.includes(n) && !(await this.isPolished(n))) raw.push(n);
			if (raw.length) { toPolish.push(...raw); continue; }
			if (window.confirm(`"${parent.getField("title").slice(0, 60)}"에는 이미 다듬은 번역 노트가 있습니다. 새로 하나 더 번역할까요?`)) {
				toTranslate.push(parent);
			}
		}
		if (toPolish.length) await this.polishNotes(toPolish);
		for (let parent of toTranslate) {
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
			// 힌트 페이지부터 찾는다 — 짧은 영문 구절은 문서 여러 곳에 있을 수 있다
			let direct = this.matcher.findInDocument(pages, h.text, this.claude.hintPage(h, mapping));
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
	/** 노트 머리에 쓸 서지정보 */
	paperMeta(parent) {
		let creators = [];
		try {
			for (let c of parent.getCreatorsJSON()) {
				if (c.creatorType && c.creatorType !== "author") continue;
				creators.push(c.name || [c.firstName, c.lastName].filter(Boolean).join(" "));
			}
		}
		catch (e) { /* ignore */ }
		let date = parent.getField("date") || "";
		let year = (date.match(/\d{4}/) || [""])[0];
		return {
			authors: creators.join(", "),
			year,
			journal: parent.getField("publicationTitle") || "",
			doi: (parent.getField("DOI") || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""),
		};
	},

	/** **굵게** 표기를 strong으로 바꾸며 이스케이프 */
	inline(text) {
		return this.escape(String(text ?? "")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	},

	/**
	 * Claude가 돌려준 구조 블록 하나를 노트 HTML로 만든다.
	 * leaves: noteParser가 세는 leaf 블록(p/li/h/td/th)들의 텍스트, 문서 순서대로(대응표 인덱스와 맞춤).
	 */
	renderBlock(b) {
		const I = (t) => this.inline(t);
		let leaves = [];
		let html = "";
		let items = Array.isArray(b.items) ? b.items.map(x => String(x ?? "")).filter(x => x.trim()) : [];
		switch (b.type) {
			case "skip":
				return null;
			case "h1": case "h2": case "h3": {
				if (!b.text) return null;
				html = `<${b.type}>${I(b.text)}</${b.type}>`;
				leaves.push(b.text);
				break;
			}
			case "ul": case "ol": {
				if (!items.length) return null;
				html = `<${b.type}>\n${items.map(x => `<li>${I(x)}</li>`).join("\n")}\n</${b.type}>`;
				leaves.push(...items);
				break;
			}
			case "quote": {
				if (!b.text) return null;
				html = `<blockquote>\n<p>${I(b.text)}</p>\n</blockquote>`;
				leaves.push(b.text);
				break;
			}
			case "table": {
				let header = Array.isArray(b.header) ? b.header.map(x => String(x ?? "")) : [];
				let rows = Array.isArray(b.rows) ? b.rows.filter(Array.isArray).map(r => r.map(x => String(x ?? ""))) : [];
				if (!header.length && !rows.length) return null;
				let parts = [];
				if (b.caption) { parts.push(`<h2>${I(b.caption)}</h2>`); leaves.push(b.caption); }
				let trs = [];
				if (header.length) {
					trs.push(`<tr>${header.map(x => `<th><p>${I(x)}</p></th>`).join("")}</tr>`);
					leaves.push(...header);
				}
				for (let r of rows) {
					trs.push(`<tr>${r.map(x => `<td><p>${I(x)}</p></td>`).join("")}</tr>`);
					leaves.push(...r);
				}
				parts.push(`<table>\n<tbody>\n${trs.join("\n")}\n</tbody>\n</table>`);
				if (b.note) { parts.push(`<p><em>${I(b.note)}</em></p>`); leaves.push(b.note); }
				html = parts.join("\n");
				break;
			}
			case "figure": {
				let parts = [];
				if (b.caption) { parts.push(`<h2>${I(b.caption)}</h2>`); leaves.push(b.caption); }
				if (items.length) { parts.push(`<ul>\n${items.map(x => `<li>${I(x)}</li>`).join("\n")}\n</ul>`); leaves.push(...items); }
				else if (b.text) { parts.push(`<p>${I(b.text)}</p>`); leaves.push(b.text); }
				if (!parts.length) return null;
				html = parts.join("\n");
				break;
			}
			default: {
				if (!b.text) return null;
				html = `<p>${I(b.text)}</p>`;
				leaves.push(b.text);
			}
		}
		return { html, leaves };
	},

	/**
	 * 번역은 한 번에 하나만 돌린다(자동 번역이 여러 PDF에 동시에 걸리면 API 호출이 몰려
	 * 429·타임아웃으로 구간이 빠지던 문제). 메뉴·자동·서버 엔드포인트 모두 이 줄을 탄다.
	 */
	translateItem(parent, opts = {}) {
		let run = () => this._translateItem(parent, opts);
		let p = (this._translateQueue || Promise.resolve()).then(run, run);
		this._translateQueue = p.catch(() => {});
		return p;
	},

	async _translateItem(parent, { pages } = {}) {
		let pdf = await this.findPDF(parent);
		if (!pdf) {
			this.notify("PDF 없음", "선택한 아이템에 PDF 첨부가 없습니다.");
			return;
		}
		let lang = this.pref("targetLang") || "한국어";
		let title = parent.getField("title");

		// 1) 노트를 먼저 만들어 바로 보이게 하고, 구간이 끝날 때마다 블록을 덧붙인다
		let meta = this.paperMeta(parent);
		let headParas = [
			`<p><em>Highlight Mirror가 Claude API로 만든 개인 연구용 번역입니다. 하이라이트하면 원문 PDF에 같은 자리로 주석이 달립니다.</em></p>`,
			`<p>${this.escape(meta.authors ? meta.authors + " " : "")}${meta.year ? `(${meta.year}) ` : ""}“${this.escape(title)}” 전문 ${lang} 번역. 원문의 절 구성·표·그림·목록·인용을 유지하고, 인용문헌의 저자명과 서지정보는 원문 표기를 둔다.</p>`,
		];
		if (meta.journal) headParas.push(`<p>게재지: ${this.escape(meta.journal)}${meta.year ? ` (${meta.year})` : ""}</p>`);
		if (meta.doi) headParas.push(`<p>DOI: <a href="https://doi.org/${this.escape(meta.doi)}">https://doi.org/${this.escape(meta.doi)}</a></p>`);
		let head = headParas.join("\n");
		let headBlocks = headParas.length; // noteParser가 세는 leaf 블록 수(모두 <p>)
		const progressLine = (msg) => `<p><em>⏳ ${this.escape(msg)}</em></p>`;
		let note = new Zotero.Item("note");
		note.libraryID = parent.libraryID;
		note.parentID = parent.id;
		note.setNote(head + "\n" + progressLine("원문 PDF 텍스트를 읽는 중…"));
		note.addTag(this.TAG);
		await note.saveTx();

		pages = pages || await this.pdfText.getPages(pdf);
		let paragraphs = this.pdfText.toParagraphs(pages);
		let chunks = this.pdfText.chunkParagraphs(paragraphs, 3500);

		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("Highlight Mirror: 번역 중");
		let line = new pw.ItemProgress(null, `${title}`);
		pw.show();

		let body = [];   // 완성된 단락 HTML (순서대로)
		let map = [];
		let results = new Array(chunks.length);
		let nextToAppend = 0;
		let done = 0;
		let failed = [];
		let polishOn = !!this.pref("polish");
		let polishFailed = false;

		const flush = async (finalMsg) => {
			// 연속으로 완료된 구간을 순서대로 노트에 덧붙인다
			while (nextToAppend < chunks.length && results[nextToAppend] !== undefined) {
				for (let b of results[nextToAppend] || []) {
					let r = this.renderBlock(b);
					if (!r) continue;
					body.push(r.html);
					for (let leaf of r.leaves) map.push({ page: b.page, src: b.src, koHash: this.hash(this.noteParser.normalize(leaf)) });
				}
				nextToAppend++;
			}
			let tail = finalMsg !== undefined
				? (finalMsg ? progressLine(finalMsg) : "")
				: progressLine(`번역 중… ${done}/${chunks.length} 구간 완료`);
			note.setNote([head, ...body, tail].filter(Boolean).join("\n"));
			await note.saveTx();
			let m = { pdfKey: pdf.key, headBlocks, paragraphs: map, complete: finalMsg !== undefined };
			if (finalMsg !== undefined && polishOn && !polishFailed) m.polished = new Date().toISOString();
			await this.state.saveMapping(note, m);
		};

		// 2) 구간 2개씩 동시에 번역, 완료되는 대로 순서 맞춰 추가
		let cursor = 0;
		const worker = async () => {
			while (cursor < chunks.length) {
				let i = cursor++;
				try {
					let blocks = await this.claude.translateChunk(chunks[i], { lang, title, ...this.pdfText.chunkContext(chunks, i) });
					if (polishOn) {
						try {
							blocks = await this.polishBlocks(blocks);
							if (blocks.failedBatches) polishFailed = true;
						}
						catch (e) { polishFailed = true; this.log(`polish chunk ${i + 1} failed, keeping raw translation: ${e}`); }
					}
					results[i] = blocks;
				}
				catch (e) {
					this.log(`translate chunk ${i + 1} failed: ${e}`);
					failed.push(i + 1);
					results[i] = [{ type: "p", page: chunks[i][0].page, src: chunks[i][0].text.split(/\s+/).slice(0, 12).join(" "),
						text: `[구간 ${i + 1} 번역 실패: ${e.message || e}]` }];
				}
				done++;
				line.setProgress(Math.round((done / chunks.length) * 100));
				line.setText(`${done}/${chunks.length} 구간 완료 (${title.slice(0, 40)})`);
				await flush();
			}
		};
		await Promise.all([worker(), worker()]);

		let summary = failed.length ? `구간 ${failed.join(", ")} 번역 실패. 우클릭 메뉴로 다시 시도하세요.` : "";
		await flush(summary);
		line.setProgress(100);
		pw.startCloseTimer(2000);
		this.notify("번역 노트 완성", `${body.length}개 블록${failed.length ? `, 실패 ${failed.length}구간` : ""}, 원문 대응표 저장됨`);
	},

	// ------------------------------------------- 3) 2차 편집 패스(문단 나누기·핵심 볼드)
	/**
	 * 편집 패스 결과 검증. ** 와 공백을 빼고 이어 붙인 글자가 원래 단락과 정확히 같을 때만 받아들인다.
	 * 문장 중간에서 끊긴 조각은 다음 조각과 다시 합치고, 짝이 안 맞는 ** 는 그 조각에서 지운다.
	 * @returns {string[]|null} 바뀐 것이 없거나 검증 실패면 null
	 */
	polishCheck(orig, parts) {
		const bare = (s) => String(s).replace(/\*\*/g, "").replace(/\s+/g, "");
		if (!Array.isArray(parts)) return null;
		parts = parts.map(p => String(p ?? "").trim()).filter(Boolean);
		if (!parts.length || bare(parts.join("")) !== bare(orig)) return null;
		parts = parts.map(p => ((p.match(/\*\*/g) || []).length % 2 ? p.replace(/\*\*/g, "") : p));
		let merged = [];
		for (let p of parts) {
			let prev = merged[merged.length - 1];
			let prevEnd = prev && prev.replace(/\*\*/g, "").trim();
			if (prev && !/[.?!…。"”’'」』)\]]$/.test(prevEnd)) merged[merged.length - 1] = prev + " " + p;
			else merged.push(p);
		}
		if (merged.length === 1 && merged[0] === String(orig).trim()) return null;
		return merged;
	},

	/** 편집 대상 단락으로 볼 만한가: 너무 짧거나 정형 문구는 건드리지 않는다. */
	polishable(text) {
		let t = String(text ?? "");
		return t.length >= 60 && !/^주요어:|^원문의 참고문헌 목록은|^\[구간 \d+ 번역 실패/.test(t);
	},

	/** 단락 묶음을 약 6,000자 배치로 나눠 편집 패스를 돌린다(2개 동시). */
	async polishTexts(texts) {
		let batches = [];
		let cur = [];
		let len = 0;
		texts.forEach((t, i) => {
			if (len + t.length > 6000 && cur.length) { batches.push(cur); cur = []; len = 0; }
			cur.push(i);
			len += t.length;
		});
		if (cur.length) batches.push(cur);
		let out = new Array(texts.length).fill(null);
		out.failedBatches = 0;
		let next = 0;
		const worker = async () => {
			while (next < batches.length) {
				let b = batches[next++];
				try {
					let res = await this.claude.polishParagraphs(b.map(i => texts[i]));
					b.forEach((i, k) => { out[i] = res[k]; });
				}
				catch (e) {
					out.failedBatches++;
					this.log(`polish batch failed: ${e}`);
				}
			}
		};
		await Promise.all([worker(), worker()]);
		return out;
	},

	/**
	 * 새 번역 구간의 블록에 편집 패스를 적용한다. 나뉜 단락은 원래 블록의 page/src를 물려받아
	 * 대응표(하이라이트 → 원문 힌트)가 그대로 맞는다. 실패하면 1차 번역을 그대로 둔다.
	 */
	async polishBlocks(blocks) {
		let idx = [];
		blocks.forEach((b, i) => { if (b && b.type === "p" && this.polishable(b.text)) idx.push(i); });
		if (!idx.length) return blocks;
		let res = await this.polishTexts(idx.map(i => blocks[i].text));
		let out = [];
		let pos = new Map(idx.map((i, k) => [i, k]));
		blocks.forEach((b, i) => {
			let parts = pos.has(i) ? res[pos.get(i)] : null;
			if (parts) for (let t of parts) out.push(Object.assign({}, b, { text: t }));
			else out.push(b);
		});
		let changed = res.filter(Boolean).length;
		this.log(`polish: ${changed}/${idx.length} paragraphs reformatted`);
		out.failedBatches = res.failedBatches;
		return out;
	},

	/**
	 * 이미 있는 번역 노트를 다듬는다. 하이라이트·링크 등 다른 서식이 있는 단락은 건드리지 않고,
	 * 덮어쓰기 전에 원래 HTML을 상태 폴더에 백업한다.
	 */
	async polishNote(note) {
		let html = note.getNote();
		let doc = new (this.win().DOMParser)().parseFromString(html, "text/html");
		const LEAF = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre";
		let leaves = [...doc.body.querySelectorAll(LEAF)].filter(el => !el.querySelector(LEAF));
		let mapping = await this.state.loadMapping(note);
		let headBlocks = mapping?.headBlocks ?? 2;

		let cands = [];
		leaves.forEach((el, leafIndex) => {
			if (leafIndex < headBlocks || el.tagName !== "P" || el.closest("li, td, th, blockquote")) return;
			let clone = el.cloneNode(true);
			for (let s of [...clone.querySelectorAll("strong, b")]) {
				if (s.querySelector("*")) return;
				s.replaceWith(doc.createTextNode(`**${s.textContent}**`));
			}
			if (clone.querySelector("*")) return; // 하이라이트 span·링크·기울임 등이 남아 있으면 건너뜀
			let text = clone.textContent.replace(/\s+/g, " ").trim();
			if (this.polishable(text)) cands.push({ el, leafIndex, text });
		});
		const markPolished = async () => {
			let m = mapping || {};
			m.polished = new Date().toISOString();
			await this.state.saveMapping(note, m);
		};
		if (!cands.length) { await markPolished(); return { paragraphs: 0, changed: 0 }; }

		let res = await this.polishTexts(cands.map(c => c.text));
		let splits = new Map();
		cands.forEach((c, k) => {
			let parts = res[k];
			if (!parts) return;
			let frag = doc.createDocumentFragment();
			parts.forEach((t, j) => {
				let p = doc.createElement("p");
				p.innerHTML = this.inline(t);
				if (j) frag.append(doc.createTextNode("\n"));
				frag.append(p);
			});
			c.el.replaceWith(frag);
			splits.set(c.leafIndex, parts.length);
		});
		let changed = splits.size;
		if (!changed) {
			if (!res.failedBatches) await markPolished();
			return { paragraphs: cands.length, changed: 0, failedBatches: res.failedBatches };
		}

		await this.state.ensureDir();
		let stamp = new Date().toISOString().replace(/[:.]/g, "-");
		let backup = this.paths.join(this.state.dir(), `backup-${note.libraryID}-${note.key}-${stamp}.html`);
		await this.io.writeUTF8(backup, html);

		if (mapping && Array.isArray(mapping.paragraphs)) {
			let paras = [];
			mapping.paragraphs.forEach((entry, j) => {
				let k = splits.get(j + headBlocks) || 1;
				for (let n = 0; n < k; n++) paras.push(entry);
			});
			mapping.paragraphs = paras;
		}
		if (mapping) mapping.polished = res.failedBatches ? undefined : new Date().toISOString();
		if (mapping) await this.state.saveMapping(note, mapping);
		else if (!res.failedBatches) await markPolished();
		note.setNote(doc.body.innerHTML);
		await note.saveTx();
		this.log(`polishNote ${note.key}: ${changed}/${cands.length} paragraphs, backup ${backup}`);
		return { paragraphs: cands.length, changed, backup, failedBatches: res.failedBatches };
	},

	async polishNotes(notes) {
		if (!(this.pref("apiKey") || "").trim()) {
			this.notify("API 키 없음", "설정 → Highlight Mirror에서 Claude API 키를 입력하세요.");
			return;
		}
		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("Highlight Mirror: 번역 노트 다듬는 중");
		let line = new pw.ItemProgress(null, `${notes.length}개 노트`);
		pw.show();
		let total = 0;
		for (let [i, note] of notes.entries()) {
			try {
				let r = await this.polishNote(note);
				total += r.changed;
			}
			catch (e) {
				this.log(`polish error: ${e}\n${e.stack || ""}`);
				this.notify("오류", String(e.message || e), 10000);
			}
			line.setProgress(Math.round(((i + 1) / notes.length) * 100));
		}
		line.setText(`${notes.length}개 노트, 단락 ${total}개 다듬음`);
		pw.startCloseTimer(4000);
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
		BLOCKS: new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "DIV", "TD", "TH", "PRE"]),

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
			let blocks = [...doc.body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre")];
			if (!blocks.length) blocks = [doc.body];
			let blockIndex = 0;
			for (let block of blocks) {
				if (block.querySelector("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre")) continue; // 중첩 블록은 자식에서 처리
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

		/** 페이지 위아래 가장자리 줄 수 — 머리글·꼬리글·쪽번호는 여기에만 있다 */
		EDGE_LINES: 3,

		/** 문장이 끝나는 조각인가(마침표·물음표 등, 닫는 따옴표·괄호 허용) */
		endsSentence(s) {
			return /[.!?:;]["'’”)\]]?$/.test(s);
		},

		/**
		 * 여러 페이지에 반복되는 줄(머리글·꼬리글)을 골라낸다.
		 * 본문 끝줄("et al., 2019)." 같은 짧은 줄)이 우연히 반복돼 지워지지 않도록
		 * 페이지 위아래 가장자리 줄만 센다.
		 * @returns {{drop:Set<string>, norm:Function}} 제거할 줄의 정규화 키
		 */
		runningLines(pages) {
			let count = new Map();
			let norm = s => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
			for (let p of pages) {
				let seen = new Set();
				let lines = p.text.split("\n").map(s => s.trim()).filter(Boolean);
				let edge = lines.filter((_, i) => i < this.EDGE_LINES || i >= lines.length - this.EDGE_LINES);
				for (let line of edge) {
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

		/**
		 * 페이지 텍스트를 단락으로 쪼갠다(문장 끝 + 짧은 줄 휴리스틱).
		 * 페이지 끝에서 문장이 안 끝났으면 버퍼를 다음 페이지로 넘겨 한 문장이 두 조각으로 갈라지지 않게 한다
		 * (갈라지면 구간 경계에 걸렸을 때 Claude가 반쪽 문장을 받아 앞뒤를 지어낸다).
		 * 단락의 page는 시작한 페이지다.
		 */
		toParagraphs(pages) {
			let paras = [];
			let { drop, norm } = this.runningLines(pages);
			let buf = [];
			let bufPage = 0;
			const flush = (pageIndex) => {
				if (!buf.length) return;
				// 줄 끝 하이픈으로 갈라진 단어 이어붙이기(페이지 경계 포함)
				paras.push({ page: bufPage, text: buf.join(" ").replace(/-\s+(?=[a-z])/g, ""), kind: "para" });
				buf = [];
				bufPage = pageIndex;
			};
			for (let p of pages) {
				if (this.isCoverPage(p)) continue;
				let all = p.text.split("\n").map(s => s.trim()).filter(Boolean);
				let lines = all.filter((l, i) => !drop.has(norm(l))
					&& !(/^\d{1,4}$/.test(l) && (i < this.EDGE_LINES || i >= all.length - this.EDGE_LINES)));
				if (!buf.length) bufPage = p.index;
				for (let i = 0; i < lines.length; i++) {
					let line = lines[i];
					let next = lines[i + 1];
					let short = line.length < 45;
					let isHeading = /^(\d+(\.\d+)*\.?\s+\S|[A-Z][A-Za-z ]{2,40}$|Abstract|References|Introduction|Conclusion)/.test(line) && short;
					if (isHeading && !buf.length) {
						paras.push({ page: p.index, text: line, kind: "heading" });
						bufPage = p.index;
						continue;
					}
					if (!buf.length) bufPage = p.index;
					buf.push(line);
					let endsSentence = this.endsSentence(line);
					if (!next) {
						// 페이지 끝: 문장이 끝났을 때만 단락을 닫고, 아니면 다음 페이지로 이어 간다
						if (endsSentence) flush(p.index);
					}
					else if (endsSentence && (short || next.length < 45 || /^[A-Z0-9(]/.test(next) && line.length < 60)) {
						flush(p.index);
					}
				}
			}
			flush(0);
			return paras.filter(x => x.text.length > 1);
		},

		/**
		 * 단락을 번역 구간으로 묶는다. 구간 경계는 문장이 끝난 조각 뒤, 문장을 새로 시작하는 조각 앞에만 두고
		 * (소문자로 시작하는 조각은 앞 문장의 나머지 — 예: 사이드바 박스가 문장 중간에 끼어든 경우),
		 * 어쩔 수 없이 넘치는 조각은 hardMax(기본 2배)까지 허용한다. 절 제목 앞에서는 되도록 끊는다.
		 */
		chunkParagraphs(paras, maxChars, hardMax = maxChars * 2) {
			let chunks = [];
			let cur = [];
			let len = 0;
			const cut = () => { if (cur.length) { chunks.push(cur); cur = []; len = 0; } };
			for (let p of paras) {
				let last = cur[cur.length - 1];
				let lastDone = !last || last.kind === "heading" || this.endsSentence(last.text);
				let startsNew = p.kind === "heading" || !/^\p{Ll}/u.test(p.text);
				let boundary = lastDone && startsNew;
				if (cur.length && p.kind === "heading" && len >= maxChars * 0.6 && lastDone) cut();
				else if (cur.length && len + p.text.length > maxChars && (boundary || len + p.text.length > hardMax)) cut();
				cur.push(p);
				len += p.text.length;
			}
			cut();
			return chunks;
		},

		/** 구간 앞뒤 문맥(번역하지 않고 참고만): 앞 구간의 끝과 뒤 구간의 시작 */
		chunkContext(chunks, i, chars = 400) {
			let prev = chunks[i - 1];
			let next = chunks[i + 1];
			let before = prev ? prev.map(p => p.text).join(" ").slice(-chars) : "";
			let after = next ? next.map(p => p.text).join(" ").slice(0, chars) : "";
			return { before, after };
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

		/** 재시도 간격(ms): 429·529·5xx·타임아웃·네트워크 오류일 때 */
		RETRY_DELAYS: [5000, 15000, 45000],

		/** 다시 시도할 만한 오류인가 — 상태 코드가 없으면 타임아웃·네트워크 끊김으로 본다 */
		retryable(e) {
			let status = e?.status ?? e?.xmlhttp?.status;
			if (status === 429 || status === 408 || status === 409 || (status >= 500 && status < 600)) return true;
			if (status) return false;
			return /timeout|timed out|offline|network|NS_ERROR|connection/i.test(e?.message || String(e)) || !status;
		},

		async request({ system, user, maxTokens = 16000, model }) {
			let apiKey = (HighlightMirror.pref("apiKey") || "").trim();
			if (!apiKey) {
				throw new Error("Claude API 키가 없습니다. 설정 → Highlight Mirror에서 입력하세요.");
			}
			model = model || HighlightMirror.pref("model") || "claude-opus-5-5";
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
			for (let attempt = 0; ; attempt++) {
				try {
					xhr = await Zotero.HTTP.request("POST", HighlightMirror.API_URL, {
						headers,
						body: JSON.stringify(body),
						responseType: "json",
						timeout: 300000,
					});
					break;
				}
				catch (e) {
					let delay = this.RETRY_DELAYS[attempt];
					if (delay !== undefined && this.retryable(e)) {
						// 서버가 Retry-After를 주면 그만큼(최대 2분) 기다린다
						let ra = Number(e.xmlhttp?.getResponseHeader?.("retry-after"));
						if (ra > 0) delay = Math.min(ra * 1000, 120000);
						let status = e.status ?? e.xmlhttp?.status ?? "no-status";
						HighlightMirror.log(`Claude API ${status}, retry ${attempt + 1}/${this.RETRY_DELAYS.length} in ${delay}ms: ${e.message || e}`);
						await Zotero.Promise.delay(delay);
						continue;
					}
					let detail = e.xmlhttp?.responseText || e.message || String(e);
					try { detail = JSON.parse(detail).error?.message || detail; } catch (_) { /* raw */ }
					throw new Error(`Claude API 오류: ${detail}`);
				}
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
			let p = this.hintEntry(h, mapping);
			return p ? `page ${p.page}, paragraph starting "${p.src}"` : null;
		},

		hintPage(h, mapping) {
			let p = this.hintEntry(h, mapping);
			return p && Number.isInteger(p.page) ? p.page : undefined;
		},

		hintEntry(h, mapping) {
			if (!mapping || !mapping.paragraphs) return null;
			// 번역 노트의 단락 해시가 아니라 포함 관계로 찾는 건 비용이 커서, 블록 순서 기반 근사
			return mapping.paragraphs[h.block - (mapping.headBlocks ?? 2)] || null; // 머리 블록 뒤부터 본문
		},

		/**
		 * 단락 묶음을 번역해 구조 블록 배열로 돌려준다(제목/단락/목록/인용/표/그림).
		 * 각 블록에는 원문 첫 단어들(src)과 페이지를 붙여 대응표에 쓴다.
		 * @returns {Array<{type, page, src, text?, items?, caption?, header?, rows?, note?}>}
		 */
		async translateChunk(paras, { lang, title, before = "", after = "" }) {
			let numbered = paras.map((p, i) => `[${i + 1}] (page ${p.page}) ${p.text}`).join("\n\n");
			let context = "";
			if (before) context += `CONTEXT BEFORE (end of the previous chunk — for reference only, do NOT translate or output it):\n…${before}\n\n`;
			if (after) context += `CONTEXT AFTER (start of the next chunk — for reference only, do NOT translate or output it):\n${after}…\n\n`;
			let system = [
				`You are translating an academic paper into ${lang} for a researcher's private study notes, producing a well-structured document (as a careful human translator would), not a flat dump of sentences.`,
				"Context: the researcher legally holds this paper and reads it through a translation stored only inside their own Zotero library. This is personal, non-distributed research use; a faithful full translation is required so that each translated block can later be mapped back to the original passage.",
				"",
				"INPUT: numbered text fragments extracted from the PDF in reading order. Extraction is imperfect: a table may arrive as scattered cell fragments, a heading may be glued to the paragraph after it, several short fragments may be one list, and figure captions or bibliography entries appear as plain text.",
				"",
				"OUTPUT: ONLY a JSON array of blocks in reading order that together cover every fragment. Each block has \"ids\" (the fragment numbers it was built from, in order) and \"type\":",
				`- {"type":"h1","text"}  the paper title (translated) and top-level section headings. Write section headings as "1. 서론(Introduction)": number, ${lang} heading, then the original English in parentheses.`,
				`- {"type":"h2","text"} / {"type":"h3","text"}  subsection headings, e.g. "4.1. TCCM 프레임워크". The abstract heading is h2 "초록(Abstract)".`,
				`- {"type":"p","text"}  one paragraph, translated completely and faithfully into ${lang}; never summarize, omit, or add commentary. A keywords line becomes "주요어: …". The author line and affiliations stay as a short paragraph.`,
				`- {"type":"ul"|"ol","items":[...]}  when the source enumerates items (bulleted, numbered, "(1) … (2) …", or a run of short parallel fragments). A sentence that enumerates three or more parallel named items or questions (e.g. who/when/where/how…, the three "A"s, selection criteria) is also rendered as a list, with the introducing sentence as the preceding paragraph. Use "ol" when the order or numbering matters.`,
				`- {"type":"quote","text"}  a set-off direct quotation (block quote). Inline quotations stay inside the paragraph with their quotation marks.`,
				`- {"type":"table","caption":"표 N. …","header":[...],"rows":[[...],...],"note":"…"}  rebuild a real table from the cell fragments: translate cell text, keep names/numbers/journal titles verbatim, one array per row with the same column count as the header. If some cells are too garbled to recover, rebuild what is reliable and say what was abridged in "note" (optional).`,
				`- {"type":"figure","caption":"그림 N. …","items":[...]}  a figure: translate the caption and list in "items" the figure's content that is visible in the text (box labels, steps, arrows). If nothing beyond the caption is available, give only the caption.`,
				`- {"type":"skip"}  for text not worth keeping: running headers/footers, page numbers, "To cite this article", submission/acceptance dates, copyright or licence lines, and individual bibliography entries.`,
				"",
				"Rules:",
				"- Keep author names, in-text citations (e.g. Paul & Benito, 2018), acronyms, framework names, variable names and numbers exactly as in the source.",
				`- On the first use of a key technical term, put the original English in parentheses after the ${lang} term, e.g. 체계적 문헌고찰(systematic literature review).`,
				"- Use **double asterisks** to bold a term that is bolded or being defined in the source (e.g. **이론(Theory)**은 …).",
				"- Reference list: when the bibliography begins, emit its heading as h1 \"참고문헌(References)\" followed by ONE paragraph: \"원문의 참고문헌 목록은 서지정보의 정확성을 위해 번역하지 않고 원문 표기를 유지한다.\" — then skip every entry. If the fragments are all bibliography entries (the list began in an earlier chunk), skip them all.",
				"- Author biographies, acknowledgements and disclosure statements are translated as normal sections.",
				"- If a fragment begins or ends mid-sentence, translate exactly what is there (the rest belongs to a neighbouring chunk); use the CONTEXT passages only to understand the sentence. Never invent or bracket missing words.",
				"- Never output anything before or after the JSON array. Escape quotes inside strings. No HTML or Markdown other than ** for bold.",
			].join("\n");
			let user = `Paper: ${title}\n\n${context}FRAGMENTS TO TRANSLATE:\n${numbered}`;
			let { text, usage } = await this.request({ system, user, maxTokens: 24000 });
			HighlightMirror.log(`translate usage: ${JSON.stringify(usage)}`);
			let arr = this.parseJSONArray(text);
			let out = [];
			for (let b of arr) {
				if (!b || typeof b !== "object") continue;
				let ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(x => (x | 0) - 1).filter(i => i >= 0 && i < paras.length);
				let p = paras[ids.length ? ids[0] : 0];
				let src = (ids.length ? ids.map(i => paras[i].text).join(" ") : String(b.text || "")).split(/\s+/).slice(0, 12).join(" ");
				out.push(Object.assign({}, b, { type: String(b.type || "p"), page: p.page, src }));
			}
			return out;
		},

		/**
		 * 2차 편집 패스: 이미 번역된 단락을 읽기 단위(1~3문장)로 나누고 핵심에 **볼드**를 단다.
		 * 문장은 고치지 않는다. 결과는 polishCheck로 원문과 글자 단위로 대조해, 다르면 버린다.
		 * @param {string[]} texts 번역 단락들
		 * @returns {Promise<Array<string[]|null>>} 단락별 조각 배열(검증 실패·변화 없음은 null)
		 */
		async polishParagraphs(texts) {
			if (!texts.length) return [];
			let numbered = texts.map((t, i) => JSON.stringify({ id: i + 1, text: t })).join("\n");
			let system = [
				"You are a copy-editor formatting a Korean translation of an academic paper so a researcher can read it comfortably on screen in their private study notes. The translation is already final.",
				"You receive numbered paragraphs as JSON lines. For each one, return the SAME text, character for character, with only two kinds of change:",
				"",
				"1. SPLIT into reading units: break a long paragraph into several shorter paragraphs of 1–3 sentences each (aim for 100–200 Korean characters; a unit longer than 250 characters that contains two or more sentences must be split again), at sentence boundaries where the thought moves on (a new claim, an example, a counterpoint, a list of studies, the conclusion of the paragraph). Never split inside a sentence or inside parentheses. A paragraph of one or two sentences stays whole.",
				"2. BOLD with **double asterisks** what a reader skimming the page must catch:",
				"   - the paper's central argument or thesis, and the key conclusion of a section (one sentence, or its core clause);",
				"   - a key concept where it is introduced or defined (just the term, e.g. **관계(relation)**);",
				"   - a key finding or number (e.g. **85%의 예측 정확도**);",
				"   - labels of enumerated research questions, propositions or stages (e.g. **(a)**).",
				"   Most reading units get zero or one bold; transitional or descriptive passages get none. Never bold several sentences together, citations, author names, or connectives. Keep any ** already present.",
				"",
				"Do NOT change, add, delete, reorder or re-translate any character. The only allowed edits are paragraph breaks and ** markers. If a paragraph needs nothing, return it as a single part.",
				"Output ONLY a JSON array covering every id: [{\"id\":1,\"parts\":[\"…\",\"…\"]}, …]. Escape quotes inside strings.",
			].join("\n");
			let model = HighlightMirror.pref("polishModel") || "claude-sonnet-5-5";
			let total = texts.reduce((n, t) => n + t.length, 0);
			let { text, usage } = await this.request({ system, user: numbered, model, maxTokens: Math.min(32000, 4000 + total * 2) });
			HighlightMirror.log(`polish usage: ${JSON.stringify(usage)}`);
			let arr = this.parseJSONArray(text);
			let out = new Array(texts.length).fill(null);
			for (let r of arr) {
				let i = (r?.id | 0) - 1;
				if (i < 0 || i >= texts.length) continue;
				out[i] = HighlightMirror.polishCheck(texts[i], r.parts);
				if (!out[i] && Array.isArray(r.parts) && r.parts.length > 1) {
					// 검증 탈락 이유를 짧게 남긴다(어느 글자에서 어긋났는지)
					const bare = (s) => String(s).replace(/\*\*/g, "").replace(/\s+/g, "");
					let x = bare(texts[i]), y = bare(r.parts.join(""));
					let k = 0;
					while (k < x.length && x[k] === y[k]) k++;
					HighlightMirror.log(`polish reject #${i + 1}: ${x.length}/${y.length} chars, differs at ${k}: [${x.slice(Math.max(0, k - 8), k + 20)}] vs [${y.slice(Math.max(0, k - 8), k + 20)}]`);
				}
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
	 *   POST /highlight-mirror/polish    {"note": "<note key>"}            (기존 번역 노트 다듬기)
	 */
	server: {
		PATHS: ["/highlight-mirror/status", "/highlight-mirror/locate", "/highlight-mirror/highlights",
			"/highlight-mirror/sync", "/highlight-mirror/translate", "/highlight-mirror/note", "/highlight-mirror/item",
			"/highlight-mirror/polish"],

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
				let menus = Zotero.getMainWindows().map(w => ({
					sync: !!w.document.getElementById("hm-menu-sync"),
					translate: !!w.document.getElementById("hm-menu-translate"),
					itemmenu: !!w.document.getElementById("zotero-itemmenu"),
					labels: [...w.document.querySelectorAll("[id^='hm-menu-']")].map(el => el.getAttribute("label")).filter(Boolean),
				}));
				return {
					plugin: "highlight-mirror",
					version: HM.version,
					zotero: Zotero.version,
					windows: menus,
					model: HM.pref("model"),
					hasApiKey: !!(HM.pref("apiKey") || "").trim(),
					autoSync: false,
					readerMenu: !!HM._readerHandler,
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

			async note(p) {
				let note = HighlightMirror.server.byKey(p.note);
				if (!note.isNote()) throw new Error("item is not a note");
				let html = note.getNote();
				return { key: note.key, length: html.length, paragraphs: (html.match(/<p>/g) || []).length,
					headings: (html.match(/<h[123]>/g) || []).length, tables: (html.match(/<table>/g) || []).length,
					lists: (html.match(/<[uo]l>/g) || []).length, quotes: (html.match(/<blockquote>/g) || []).length,
					tail: html.slice(-300), html: p.full ? html : undefined };
			},

			async item(p) {
				let item = HighlightMirror.server.byKey(p.item);
				let notes = Zotero.Items.get(item.getNotes ? item.getNotes() : []);
				let pdf = item.isRegularItem() ? await HighlightMirror.findPDF(item) : null;
				return { key: item.key, title: item.getField("title"), pdf: pdf && pdf.key,
					notes: notes.map(n => ({ key: n.key, tags: n.getTags().map(t => t.tag), length: n.getNote().length })) };
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

			async polish(p) {
				let note = HighlightMirror.server.byKey(p.note);
				if (!note.isNote()) throw new Error("item is not a note");
				return await HighlightMirror.polishNote(note);
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
