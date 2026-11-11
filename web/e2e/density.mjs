// Visible-text density helper (round 8): counts what a person can actually read on a page — CJK characters plus latin/number
// words — skipping hidden nodes, <option>, scripts/styles and the input values. Used to compare before/after copy cleanup.
export async function visibleUnits(page) {
	return page.evaluate(() => {
		const skip = new Set(["SCRIPT", "STYLE", "OPTION", "NOSCRIPT", "TEXTAREA"]);
		let n = 0;
		const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		const re = /[㐀-鿿＀-￯]|[A-Za-z0-9]+(?:[._'-][A-Za-z0-9]+)*/g;
		const hidden = (el) => {
			for (let e = el; e && e !== document.body; e = e.parentElement) {
				if (skip.has(e.tagName) || e.getAttribute("aria-hidden") === "true" || e.classList.contains("sr-only")) return true;
				const cs = getComputedStyle(e);
				if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return true;
				if (e.tagName === "DETAILS" && !e.open && el.parentElement?.closest("summary") !== e.querySelector(":scope > summary") && !el.parentElement?.closest("summary")) return true;
			}
			return false;
		};
		while (w.nextNode()) {
			const t = w.currentNode;
			const m = t.textContent?.match(re);
			if (!m || !t.parentElement || hidden(t.parentElement)) continue;
			const r = document.createRange();
			r.selectNodeContents(t);
			const b = r.getBoundingClientRect();
			if (b.width === 0 || b.height === 0) continue;
			n += m.length;
		}
		// a native <select> shows its chosen option as text but not as a text node: count it like the popover trigger's label
		for (const sel of document.querySelectorAll("select")) {
			const cs = getComputedStyle(sel);
			if (cs.display === "none" || cs.visibility === "hidden" || sel.getBoundingClientRect().width === 0) continue;
			n += (sel.selectedOptions[0]?.textContent?.match(re) ?? []).length;
		}
		return n;
	});
}
