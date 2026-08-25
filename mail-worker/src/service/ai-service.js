import emailUtils from '../utils/email-utils';
import { settingConst } from '../const/entity-const';

// 摄取链上的双字段提取管线(决策卡 §3.1)。确定性优先、AI 补位。
//
// 为什么确定性层在前:Workers AI 的免费额度是**账户级**硬顶(超出即 429/3036),
// 而防注入要求 AI 的输出必须能在原文里逐字找到 —— 这个回验本身就依赖确定性抽出的
// 候选集。既然确定性层无论如何都得存在,让它先跑不增加任何工程量,却省掉全部额度。
//
// 这里是收信路径:任何一条失败路径都必须落回确定性结果并继续落库,不能抛给调用方,
// 更不能让 AI 卡住邮件入库(故 AI 调用带超时)。

const AI_INPUT_LIMIT = 6000;
const AI_TIMEOUT_MS = 5000;
const NEIGHBORHOOD = 80;
const STRONG_DISTANCE = 40;

// 失败分类。运维侧要能分辨「规则没识别出来」和「AI 已经挂了一周」,
// 所以七条路径各自计数,不合并成一个 catch。
export const extractFailure = {
	AI_UNBOUND: 'ai_unbound',
	AI_RATE_LIMITED: 'ai_rate_limited',
	AI_TIMEOUT: 'ai_timeout',
	AI_BAD_JSON: 'ai_bad_json',
	AI_INDEX_OUT_OF_RANGE: 'ai_index_out_of_range',
	AI_NOT_IN_SOURCE: 'ai_not_in_source',
	AI_ERROR: 'ai_error'
};

// 「≥6 位十进制数字」是 NIST SP 800-63B 的下限表述,而 800-63-4 明确承认 Base64 等
// 可打印 ASCII 形态,所以候选不能限定纯数字。开源实现一致收敛在 4-8 位。
const CODE_MIN = 4;
const CODE_MAX = 8;

// 意图闸门 + 邻近打分的关键词(参考 otp-detector 的 positive/negative/neighborhood 结构)。
// 强关键词 = 明确指向一次性口令;弱关键词 = 可能只是路过的「验证」字样。
const STRONG_CODE_KEYWORDS = [
	'verification code', 'verify code', 'security code', 'confirmation code',
	'auth code', 'authentication code', 'access code', 'one-time', 'one time code',
	'otp', 'passcode', 'pin code',
	'验证码', '校验码', '动态码', '动态密码', '确认码', '登录码', '安全码'
];
const WEAK_CODE_KEYWORDS = [
	'code', 'verify', 'verification', 'confirm', 'authenticate', 'login', 'sign in',
	'验证', '确认', '登录'
];
// 负向过滤:电话、日期、年份、门牌号、订单/发票/追踪号。
const NEGATIVE_CODE_KEYWORDS = [
	'phone', 'tel', 'telephone', 'fax', 'call us', 'mobile',
	'order', 'invoice', 'receipt', 'tracking', 'shipment', 'ticket', 'reference number',
	'street', 'suite', 'avenue', 'zip', 'postal',
	'电话', '手机', '订单', '发票', '单号', '运单', '快递', '邮编', '门牌'
];

const LINK_POSITIVE = [
	'verify', 'verification', 'confirm', 'confirmation', 'activate', 'activation',
	'validate', 'magic', 'one-time', 'onetime', 'otp', 'signin', 'sign-in',
	'passwordless', 'authorize', 'validation',
	'验证', '激活', '确认'
];
const LINK_NEGATIVE = [
	'unsubscribe', 'opt-out', 'optout', 'preferences', 'privacy', 'terms', 'policy',
	'legal', 'imprint', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
	'linkedin.com', 'youtube.com', 'weibo.com', 't.me', 'mailto:',
	'退订', '取消订阅', '隐私', '条款'
];

const metrics = {
	counters: {},
	record(reason) {
		// 指标只记原因与计数 —— 邮件正文一个字都不进这里。
		this.counters[reason] = (this.counters[reason] || 0) + 1;
	},
	reset() {
		this.counters = {};
	}
};

class AiTimeoutError extends Error {}

function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new AiTimeoutError('workers ai timeout')), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function classifyAiError(e) {
	if (e instanceof AiTimeoutError) return extractFailure.AI_TIMEOUT;
	const status = e?.status ?? e?.code;
	const message = String(e?.message || '');
	// 3036 = Workers AI 账户额度耗尽,HTTP 429。它和「AI 坏了」是两件事:
	// 前者管理员该去看用量,后者该去看日志。
	if (status === 429 || /\b429\b|\b3036\b|rate.?limit|quota/i.test(message)) {
		return extractFailure.AI_RATE_LIMITED;
	}
	return extractFailure.AI_ERROR;
}

function nearestKeyword(haystack, keywords, start, end) {
	let best = Infinity;
	let hit = null;
	for (const keyword of keywords) {
		let from = 0;
		for (;;) {
			const at = haystack.indexOf(keyword, from);
			if (at === -1) break;
			const to = at + keyword.length;
			const distance = at >= end ? at - end : (to <= start ? start - to : 0);
			if (distance < best) {
				best = distance;
				hit = keyword;
			}
			from = at + 1;
		}
	}
	return { distance: best, keyword: hit };
}

// `2026-08-25` / `555-987-6543` 这类结构被正则本身排除:候选最多含一个连字符,
// 两侧又不允许紧邻字母数字或连字符,所以多段结构整体匹配不上,不需要额外的日期/电话正则。
const CODE_CANDIDATE = /(?<![A-Za-z0-9-])([A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{2,8})?)(?![A-Za-z0-9-])/g;

function isYear(value) {
	return /^\d{4}$/.test(value) && Number(value) >= 1900 && Number(value) <= 2099;
}

function insideUrl(text, start, end) {
	const before = text[start - 1];
	const after = text[end];
	if (before && '/=?&'.includes(before)) return true;
	if (after && '/=?&'.includes(after)) return true;
	// `example.com/x` 里的片段:紧跟一个点再接字母数字,说明还在域名/路径中间。
	if (after === '.' && /[A-Za-z0-9]/.test(text[end + 1] || '')) return true;
	return false;
}

function hasCodeIntent(text) {
	const lower = text.toLowerCase();
	return STRONG_CODE_KEYWORDS.some(k => lower.includes(k))
		|| WEAK_CODE_KEYWORDS.some(k => lower.includes(k));
}

// 在一段文本内部找最佳候选。主题与正文各自调用一次,**不拼接** —— 拼起来之后主题末尾
// 紧邻正文开头,主题里的一句「验证码」就会落进正文首个数字的邻域,给它白白背书。
// 分开扫时,一段文本里的关键词只能服务这段文本自己的候选。
function scanForCode(haystack) {
	const lower = haystack.toLowerCase();
	let best = null;

	CODE_CANDIDATE.lastIndex = 0;
	for (let match = CODE_CANDIDATE.exec(haystack); match; match = CODE_CANDIDATE.exec(haystack)) {
		const raw = match[1];
		const start = match.index;
		const end = start + raw.length;
		const plain = raw.replace(/-/g, '');

		if (plain.length < CODE_MIN || plain.length > CODE_MAX) continue;
		// 全字母的 4-8 字符串在正文里遍地都是(please / account / minutes),
		// 要求至少一个数字才是候选 —— 混合形态因此仍被支持,纯字母口令则不支持。
		if (!/\d/.test(plain)) continue;
		if (isYear(plain)) continue;
		if (insideUrl(haystack, start, end)) continue;

		const strong = nearestKeyword(lower, STRONG_CODE_KEYWORDS, start, end);
		const weak = nearestKeyword(lower, WEAK_CODE_KEYWORDS, start, end);
		const positive = strong.distance <= weak.distance ? strong : weak;
		const negative = nearestKeyword(lower, NEGATIVE_CODE_KEYWORDS, start, end);

		if (positive.distance > NEIGHBORHOOD) continue;
		// 标签就近归属:离候选更近的那个标签说了算。「验证码 918273。客服电话 555-…」里
		// phone 虽在邻域内,却离另一个数字更近,不该把码判死。
		if (negative.distance <= positive.distance) continue;

		const isStrong = strong.distance <= weak.distance && strong.distance <= NEIGHBORHOOD;
		const rank = [isStrong ? 1 : 0, -positive.distance];
		if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) {
			best = { value: raw, rank, confident: isStrong && strong.distance <= STRONG_DISTANCE };
		}
	}

	return best;
}

/**
 * 确定性验证码提取:意图闸门 → 关键词邻近打分 → 负向过滤 → 长度 4-8。
 * 正文与主题**各自独立**扫描后取优:「【某某】验证码 123456」这类把码放进主题的邮件是
 * 主流形态之一,只扫正文会整类漏掉;而独立扫描又不会让主题的关键词污染正文的候选。
 * 同为高置信时正文优先 —— 正文是发件方写给人读的正式位置,主题可能被截断或加装饰。
 * @returns {{value: string, confident: boolean}}
 */
function deterministicCode(body, subject) {
	if (!hasCodeIntent(`${subject}\n${body}`)) {
		return { value: '', confident: false };
	}

	const fromBody = scanForCode(body);
	const fromSubject = scanForCode(subject);

	let best = fromBody;
	if (!best) {
		best = fromSubject;
	} else if (fromSubject && !best.confident && fromSubject.confident) {
		best = fromSubject;
	}

	return best ? { value: best.value, confident: best.confident } : { value: '', confident: false };
}

// §1.5 不变量 1:协议白名单。`javascript:` / `data:` / `file:` 一律出局,
// 相对地址同样出局(摄取时没有 base URL,解析不出可信绝对地址)。
function isAllowedUrl(href) {
	return /^https?:\/\/[^\s]+$/i.test(href);
}

function longestOpaqueToken(href) {
	let url;
	try {
		url = new URL(href);
	} catch {
		return 0;
	}
	const parts = url.pathname.split('/').filter(Boolean);
	for (const value of url.searchParams.values()) {
		parts.push(value);
	}
	return parts.reduce((max, part) => {
		const alnum = part.replace(/[^A-Za-z0-9]/g, '');
		return /^[A-Za-z0-9._~-]+$/.test(part) ? Math.max(max, alnum.length) : max;
	}, 0);
}

function scoreAnchor(anchor) {
	const href = anchor.href.toLowerCase();
	const text = anchor.text.toLowerCase();

	if (LINK_NEGATIVE.some(k => href.includes(k) || text.includes(k))) {
		return -1;
	}

	let score = 0;
	let url;
	try {
		url = new URL(anchor.href);
	} catch {
		return -1;
	}
	const pathAndQuery = `${url.pathname}${url.search}`.toLowerCase();
	if (LINK_POSITIVE.some(k => pathAndQuery.includes(k))) score += 3;
	if (LINK_POSITIVE.some(k => text.includes(k))) score += 2;

	const token = longestOpaqueToken(anchor.href);
	if (token >= 16) score += 2;
	else if (token >= 10) score += 1;

	return score;
}

/**
 * 确定性链接提取:候选只来自 DOM 锚点,先过协议白名单再打分。
 * @returns {{value: string, confident: boolean}}
 */
function deterministicLink(candidates) {
	let best = null;
	for (const anchor of candidates) {
		const score = scoreAnchor(anchor);
		if (score < 3) continue;
		if (!best || score > best.score) {
			best = { value: anchor.href, score };
		}
	}
	return best ? { value: best.value, confident: best.score >= 5 } : { value: '', confident: false };
}

// IETF draft-wells-origin-bound-one-time-codes-00 §3.2:`One-Time-Code: code=123456; origin=example.com`。
// 草案已过期、无 IETF 背书,所以只当「命中即高置信」的快捷路径,必须假设 99% 邮件没有它。
function oneTimeCodeHeader(email) {
	const headers = Array.isArray(email?.headers) ? email.headers : [];
	const header = headers.find(item => String(item?.key || '').toLowerCase() === 'one-time-code');
	if (!header) return '';
	const match = /(?:^|[;\s])code=([^;\s]+)/i.exec(String(header.value || ''));
	return match ? match[1] : '';
}

function readAiJson(result) {
	const content = typeof result === 'string' ? result : result?.response || '';
	try {
		const json = JSON.parse(content);
		return json && typeof json === 'object' ? json : null;
	} catch {
		return null;
	}
}

const aiService = {
	metrics,

	/**
	 * 摄取链上的唯一提取入口。永不抛给调用方 —— 收信比提取结果重要。
	 * @returns {Promise<{code: string, link: string}>}
	 */
	async extract(c, email, options = {}) {
		try {
			return await this.runPipeline(c, email, options);
		} catch (e) {
			console.error('提取管线异常: ', e);
			return { code: '', link: '' };
		}
	},

	async runPipeline(c, email, options) {
		const mode = options.aiCode;

		if (!this.shouldExtract(mode, options.aiCodeFilter, email)) {
			return { code: '', link: '' };
		}

		// 1. 归一化只做一次,确定性层与 AI 层共用同一份语料与同一份锚点集合,
		//    否则 AI 结果的逐字回验会因为两边文本不同而假失败。
		const subject = email.subject || '';
		const text = emailUtils.formatText(email.text || '');
		const htmlText = emailUtils.htmlToText(email.html || '');
		const body = htmlText || text;
		const anchors = emailUtils.extractAnchors(email.html || '');
		const linkCandidates = anchors.filter(anchor => isAllowedUrl(anchor.href));

		// 2. One-Time-Code 头是**字段级**完成:它只给 code,link 必须继续走后续步骤。
		const headerCode = oneTimeCodeHeader(email);

		// 3. 确定性层,逐字段各自求解。
		const codeHit = headerCode
			? { value: headerCode, confident: true }
			: deterministicCode(body, subject);
		const linkHit = deterministicLink(linkCandidates);

		let code = codeHit.value;
		let link = linkHit.value;

		// 4. AI 补位:仅 OPEN 模式、AI 可用、且该字段仍空或低置信时,逐字段发起。
		if (mode !== settingConst.aiCode.OPEN) {
			return { code, link };
		}

		const ai = c?.env?.ai;
		if (!ai || typeof ai.run !== 'function') {
			// fork 的 wrangler.toml 没有 [ai] 段时走这里。不抛,只标记不可用。
			metrics.record(extractFailure.AI_UNBOUND);
			return { code, link };
		}

		const model = c.env.ai_model || '@cf/meta/llama-3.1-8b-instruct';
		const timeoutMs = options.aiTimeoutMs || AI_TIMEOUT_MS;
		const corpus = body.slice(0, AI_INPUT_LIMIT);

		if (!codeHit.confident && (subject || corpus)) {
			const aiCodeValue = await this.askAiForCode(ai, model, timeoutMs, subject, corpus, body);
			if (aiCodeValue) code = aiCodeValue;
		}

		if (!linkHit.confident && linkCandidates.length > 0) {
			const aiLink = await this.askAiForLink(ai, model, timeoutMs, subject, linkCandidates);
			if (aiLink) link = aiLink;
		}

		return { code, link };
	},

	async askAiForCode(ai, model, timeoutMs, subject, corpus, fullText) {
		let result;
		try {
			result = await withTimeout(ai.run(model, {
				messages: [
					{
						role: 'system',
						content: 'You extract the verification code from an email. Return only JSON like {"code":"12345678"} or {"code":""}. The code must be copied verbatim from the email, be 8 characters or fewer, and contain no spaces. Do not explain.'
					},
					{ role: 'user', content: `Subject: ${subject}\n\n${corpus}` }
				],
				temperature: 0,
				max_tokens: 32
			}), timeoutMs);
		} catch (e) {
			metrics.record(classifyAiError(e));
			return '';
		}

		const json = readAiJson(result);
		if (!json || typeof json.code !== 'string') {
			metrics.record(extractFailure.AI_BAD_JSON);
			return '';
		}
		const value = json.code.trim();
		if (!value) return '';
		if (value.length > CODE_MAX || /\s/.test(value)) {
			metrics.record(extractFailure.AI_BAD_JSON);
			return '';
		}
		// 防注入回验:AI 只能复述原文里已有的东西,不能凭空生成一个码。
		if (!fullText.includes(value)) {
			metrics.record(extractFailure.AI_NOT_IN_SOURCE);
			return '';
		}
		return value;
	},

	async askAiForLink(ai, model, timeoutMs, subject, candidates) {
		// 任务形态是选择题:AI 返回候选下标,拿不到「生成一个 URL」的权力。
		const listing = candidates
			.map((anchor, index) => `${index}. text="${anchor.text}" href="${anchor.href}"`)
			.join('\n');

		let result;
		try {
			result = await withTimeout(ai.run(model, {
				messages: [
					{
						role: 'system',
						content: 'You pick which link in an email is the confirmation link the recipient must click. Answer only with JSON like {"index":0} or {"index":-1} when none of them is. Never invent a URL. Do not explain.'
					},
					{ role: 'user', content: `Subject: ${subject}\n\nLinks:\n${listing}` }
				],
				temperature: 0,
				max_tokens: 16
			}), timeoutMs);
		} catch (e) {
			metrics.record(classifyAiError(e));
			return '';
		}

		const json = readAiJson(result);
		if (!json || typeof json.index !== 'number' || !Number.isInteger(json.index)) {
			metrics.record(extractFailure.AI_BAD_JSON);
			return '';
		}
		if (json.index === -1) return '';
		if (json.index < 0 || json.index >= candidates.length) {
			metrics.record(extractFailure.AI_INDEX_OUT_OF_RANGE);
			return '';
		}
		return candidates[json.index].href;
	},

	shouldExtract(aiCode, aiCodeFilterStr, email) {
		if (aiCode !== settingConst.aiCode.OPEN && aiCode !== settingConst.aiCode.RULE_ONLY) {
			return false;
		}

		const filterList = aiCodeFilterStr ? aiCodeFilterStr.split(',').map(item => item.trim().toLowerCase()).filter(Boolean) : [];

		if (filterList.length === 0) {
			return true;
		}

		const fromEmail = (email.from?.address || '').trim().toLowerCase();
		const fromDomain = emailUtils.getDomain(fromEmail).toLowerCase();

		return filterList.some(item => item === fromEmail || item === fromDomain);
	}
};

export default aiService;
