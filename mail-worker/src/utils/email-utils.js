import { parseHTML } from 'linkedom';

const emailUtils = {

	getDomain(email) {
		if (typeof email !== 'string') return '';
		const parts = email.split('@');
		return parts.length === 2 ? parts[1] : '';
	},

	getName(email) {
		if (typeof email !== 'string') return '';
		const parts = email.trim().split('@');
		return parts.length === 2 ? parts[0] : '';
	},

	formatText(text) {
		if (!text) return ''
		return text
			.split('\n')
			.map(line => {
				return line.replace(/[\u200B-\u200F\uFEFF\u034F\u200B-\u200F\u00A0\u3000\u00AD]/g, '')
					.replace(/\s+/g, ' ')
					.trim();
			})
			.join('\n')
			.replace(/\n{3,}/g, '\n')
			.trim();
	},

	// 锚点候选集。链接提取只认 DOM 里真实存在的 <a href>,不用正则从正文扒 URL ——
	// 后者会把纯文本里被引用的地址也算进来,而那不是发件人放的可点击入口。
	// 协议白名单不在这里施加:候选集保持「邮件里有什么」的原貌,取舍交给打分层。
	extractAnchors(content) {
		if (!content || typeof content !== 'string') return [];
		try {
			const wrappedContent = content.includes('<body')
				? content
				: `<!DOCTYPE html><html><body>${content}</body></html>`;
			const { document } = parseHTML(wrappedContent);
			return Array.from(document.querySelectorAll('a[href]'))
				.map(el => ({
					href: (el.getAttribute('href') || '').trim(),
					text: (el.textContent || '').replace(/\s+/g, ' ').trim()
				}))
				.filter(anchor => anchor.href);
		} catch (e) {
			console.error(e);
			return [];
		}
	},

	htmlToText(content) {
		if (!content) return ''
		try {
			const wrappedContent = content.includes('<body')
				? content
				: `<!DOCTYPE html><html><body>${content}</body></html>`;
			const { document } = parseHTML(wrappedContent);
			document.querySelectorAll('style, script, title').forEach(el => el.remove());
			let text = document.body.innerText;
			return this.formatText(text);
		} catch (e) {
			console.error(e)
			return ''
		}
	}
};

export default emailUtils;
