import { describe, it, expect, beforeEach, vi } from 'vitest';
import aiService, { extractFailure } from '../src/service/ai-service.js';
import emailUtils from '../src/utils/email-utils.js';
import { settingConst } from '../src/const/entity-const.js';

// 决策卡 §3.1 提取管线 / §4「提取管线」用例。
// 被测契约:aiService.extract(c, email, options) -> { code, link },永不抛给调用方。

function mail(overrides = {}) {
	return {
		subject: '',
		text: '',
		html: '',
		headers: [],
		from: { address: 'noreply@example.com' },
		...overrides
	};
}

function ctx(ai) {
	return { env: ai === undefined ? {} : { ai } };
}

const OPEN = { aiCode: settingConst.aiCode.OPEN };
const RULE_ONLY = { aiCode: settingConst.aiCode.RULE_ONLY };
const CLOSE = { aiCode: settingConst.aiCode.CLOSE };

// AI 永远不该被采纳的那些用例里,给一个会立刻被识破的脏值。
function aiReturning(payload) {
	return { run: vi.fn(async () => ({ response: JSON.stringify(payload) })) };
}

beforeEach(() => {
	aiService.metrics.reset();
});

describe('三态语义(§1.7)', () => {
	it('CLOSE(默认值)完全不提取,且零 env.ai 调用', async () => {
		const ai = aiReturning({ code: '999999' });
		const result = await aiService.extract(ctx(ai), mail({
			subject: 'Your verification code',
			text: 'Your verification code is 483920'
		}), CLOSE);

		expect(result).toEqual({ code: '', link: '' });
		expect(ai.run).not.toHaveBeenCalled();
	});

	it('RULE_ONLY 只跑确定性层 —— 用 spy 断言零 env.ai 调用', async () => {
		const ai = { run: vi.fn(async () => ({ response: '{"code":"000000"}' })) };
		const result = await aiService.extract(ctx(ai), mail({
			subject: 'Verify your account',
			text: 'Your verification code is 483920. It expires in 10 minutes.'
		}), RULE_ONLY);

		expect(ai.run).toHaveBeenCalledTimes(0);
		expect(result.code).toBe('483920');
	});

	it('aiCodeFilter 白名单未命中时不提取(沿用既有门控)', async () => {
		const result = await aiService.extract(ctx(undefined), mail({
			subject: 'Verify your account',
			text: 'Your verification code is 483920',
			from: { address: 'noreply@evil.example' }
		}), { aiCode: settingConst.aiCode.RULE_ONLY, aiCodeFilter: 'example.com' });

		expect(result).toEqual({ code: '', link: '' });
	});
});

describe('One-Time-Code 邮件头快捷路径(§3.1 步骤 2 / 评审 F1)', () => {
	it('命中头即采纳 code', async () => {
		const result = await aiService.extract(ctx(undefined), mail({
			headers: [{ key: 'one-time-code', value: 'code=771244; origin=example.com' }],
			text: 'Hello.'
		}), RULE_ONLY);

		expect(result.code).toBe('771244');
	});

	it('是字段级完成而非整条管线终止:头给 code,正文链接仍要被提取出来', async () => {
		const result = await aiService.extract(ctx(undefined), mail({
			headers: [{ key: 'One-Time-Code', value: 'code=771244; origin=example.com' }],
			html: '<p>Tap to confirm</p><a href="https://example.com/verify?token=Ab12Cd34Ef56Gh78">Confirm your email</a>'
		}), RULE_ONLY);

		expect(result.code).toBe('771244');
		expect(result.link).toBe('https://example.com/verify?token=Ab12Cd34Ef56Gh78');
	});
});

describe('确定性层 · 验证码(正例)', () => {
	it.each([
		['4 位纯数字', 'Your verification code is 4821 .', '4821'],
		['6 位纯数字', 'Your verification code is 483920.', '483920'],
		['8 位纯数字', 'Your verification code is 48392017.', '48392017'],
		['字母数字混合', 'Your verification code is A1B2C3.', 'A1B2C3'],
		['带连字符', 'Your verification code is 439-221.', '439-221'],
		['中文验证码', '您的验证码是 618243,10 分钟内有效。', '618243']
	])('%s', async (_name, text, expected) => {
		const result = await aiService.extract(ctx(undefined), mail({ subject: 'Verify', text }), RULE_ONLY);
		expect(result.code).toBe(expected);
	});
});

describe('确定性层 · 验证码写在主题里', () => {
	it('正文没有码时,取主题里的', async () => {
		const result = await aiService.extract(
			ctx(undefined),
			mail({ subject: '【Example】验证码 618243', text: '请勿向任何人泄露此信息。' }),
			RULE_ONLY
		);
		expect(result.code).toBe('618243');
	});

	it('英文主题同理', async () => {
		const result = await aiService.extract(
			ctx(undefined),
			mail({ subject: '483920 is your verification code', text: 'Do not share this with anyone.' }),
			RULE_ONLY
		);
		expect(result.code).toBe('483920');
	});

	it('正文与主题都有码时以正文为准', async () => {
		const result = await aiService.extract(
			ctx(undefined),
			mail({ subject: 'Your verification code 111111', text: 'Your verification code is 222222.' }),
			RULE_ONLY
		);
		expect(result.code).toBe('222222');
	});

	// 主题与正文分开扫描的理由:拼接后主题末尾紧邻正文开头,主题里的「验证码」会落进
	// 正文首个数字的邻域。这里正文那串数字离自己的负向标签更近,不该被主题救活。
	it('主题的关键词不得给正文里的无关数字背书', async () => {
		const result = await aiService.extract(
			ctx(undefined),
			mail({ subject: 'Your verification code', text: '订单号 887766 已发货,客服电话 021-8899。' }),
			RULE_ONLY
		);
		expect(result.code).toBe('');
	});
});

describe('确定性层 · 验证码(负例:不得被当成码)', () => {
	it('电话号码', async () => {
		const result = await aiService.extract(ctx(undefined), mail({
			subject: 'Verify your account',
			text: 'Your verification code is 918273. Support phone: 555-987-6543.'
		}), RULE_ONLY);
		expect(result.code).toBe('918273');
	});

	it('日期与年份(唯一候选时结果为空)', async () => {
		const result = await aiService.extract(ctx(undefined), mail({
			subject: 'Verify your account',
			text: 'Please verify your account. This request is valid until 2026-08-25.'
		}), RULE_ONLY);
		expect(result.code).toBe('');
	});

	it('订单号 / 追踪号', async () => {
		const result = await aiService.extract(ctx(undefined), mail({
			subject: 'Verify your account',
			text: 'Order number 4455661 shipped. Tracking 7781234.'
		}), RULE_ONLY);
		expect(result.code).toBe('');
	});

	it('门牌号', async () => {
		const result = await aiService.extract(ctx(undefined), mail({
			subject: 'Verify your account',
			text: 'Please verify. Our office is at 1234 Market Street, Suite 5678.'
		}), RULE_ONLY);
		expect(result.code).toBe('');
	});

	it('意图闸门:没有验证意图的邮件不吐码', async () => {
		const result = await aiService.extract(ctx(undefined), mail({
			subject: 'Weekly newsletter',
			text: 'We shipped 483920 packages this year. Read more inside.'
		}), RULE_ONLY);
		expect(result.code).toBe('');
	});
});

describe('确定性层 · 验证链接', () => {
	it('从锚点里挑出验证链接', async () => {
		const result = await aiService.extract(ctx(undefined), mail({
			html: `
				<a href="https://example.com/unsubscribe?u=1">Unsubscribe</a>
				<a href="https://example.com/verify?token=Ab12Cd34Ef56Gh78">Verify your email</a>
				<a href="https://twitter.com/example">Twitter</a>
			`
		}), RULE_ONLY);

		expect(result.link).toBe('https://example.com/verify?token=Ab12Cd34Ef56Gh78');
	});

	it.each([
		['退订', '<a href="https://example.com/unsubscribe?u=1">Unsubscribe</a>'],
		['隐私政策', '<a href="https://example.com/privacy">Privacy Policy</a>'],
		['社交图标', '<a href="https://facebook.com/example">Facebook</a>']
	])('%s 链接不得被当成验证链接', async (_name, html) => {
		const result = await aiService.extract(ctx(undefined), mail({ html }), RULE_ONLY);
		expect(result.link).toBe('');
	});

	// href 刻意构造成「除了协议以外样样都像验证链接」(路径含 verify、锚文本含 Verify、
	// 带 16 位 token),否则打分层会先把它们筛掉,白名单是否生效就测不出来。
	it.each([
		['javascript:', '<a href="javascript:/verify?token=Ab12Cd34Ef56Gh78">Verify your email</a>'],
		['data:', '<a href="data:/verify?token=Ab12Cd34Ef56Gh78">Verify your email</a>'],
		['file:', '<a href="file:///verify?token=Ab12Cd34Ef56Gh78">Verify your email</a>']
	])('协议白名单:%s 锚点必须出局(§1.5 不变量 1)', async (_name, html) => {
		const result = await aiService.extract(ctx(undefined), mail({ html }), RULE_ONLY);
		expect(result.link).toBe('');
	});

	it('纯文本邮件无锚点候选 → 链接判未识别', async () => {
		const result = await aiService.extract(ctx(undefined), mail({
			subject: 'Verify',
			text: 'Your verification code is 483920. Visit https://example.com/verify?token=Ab12Cd34Ef56Gh78'
		}), RULE_ONLY);

		expect(result.code).toBe('483920');
		expect(result.link).toBe('');
	});
});

describe('输入归一化(评审 F7)', () => {
	it('HTML-only 邮件走 htmlToText', async () => {
		const result = await aiService.extract(ctx(undefined), mail({
			subject: 'Verify',
			html: '<style>.x{color:red}</style><p>Your verification code is <b>483920</b></p>'
		}), RULE_ONLY);
		expect(result.code).toBe('483920');
	});

	it('码位于截断边界之后:确定性层扫描完整文本,不受送 AI 的截断影响', async () => {
		const filler = 'lorem ipsum dolor sit amet '.repeat(400); // > 6000 字符
		expect(filler.length).toBeGreaterThan(6000);
		const result = await aiService.extract(ctx(undefined), mail({
			subject: 'Verify your account',
			text: `${filler}\nYour verification code is 483920.`
		}), RULE_ONLY);
		expect(result.code).toBe('483920');
	});

	it('送 AI 的语料受截断约束', async () => {
		const filler = 'lorem ipsum dolor sit amet '.repeat(400);
		const ai = aiReturning({ code: '' });
		await aiService.extract(ctx(ai), mail({
			subject: 'Verify your account',
			text: `${filler}\nnothing code like here`
		}), OPEN);

		expect(ai.run).toHaveBeenCalled();
		const userMessage = ai.run.mock.calls[0][1].messages.find(m => m.role === 'user');
		expect(userMessage.content.length).toBeLessThanOrEqual(6000 + 200);
	});
});

describe('AI 补位 · 七条失败路径均落到确定性结果且不抛(§4)', () => {
	// 刻意用**低置信**的确定性命中(只有弱关键词 verify,没有「verification code」),
	// 否则高置信路径根本不会去调 AI,这些失败路径就一条也走不到。
	const body = 'Please verify your account. Reference 483920 is required.';
	const email = () => mail({ subject: 'Verify your account', text: body });

	it('env.ai 未绑定(fork 无 [ai] 段)', async () => {
		const result = await aiService.extract(ctx(undefined), email(), OPEN);
		expect(result.code).toBe('483920');
		expect(aiService.metrics.counters[extractFailure.AI_UNBOUND]).toBeGreaterThan(0);
	});

	it('AI 抛异常', async () => {
		const ai = { run: vi.fn(async () => { throw new Error('boom'); }) };
		const result = await aiService.extract(ctx(ai), email(), OPEN);
		expect(result.code).toBe('483920');
		expect(aiService.metrics.counters[extractFailure.AI_ERROR]).toBeGreaterThan(0);
	});

	it('429 额度耗尽被单独归类', async () => {
		const ai = {
			run: vi.fn(async () => {
				const e = new Error('AiError: 3036 Account limited');
				e.status = 429;
				throw e;
			})
		};
		const result = await aiService.extract(ctx(ai), mail({ subject: 'Verify', text: 'no candidate here at all' }), OPEN);
		expect(result.code).toBe('');
		expect(aiService.metrics.counters[extractFailure.AI_RATE_LIMITED]).toBeGreaterThan(0);
		expect(aiService.metrics.counters[extractFailure.AI_ERROR] || 0).toBe(0);
	});

	it('返回非法 JSON', async () => {
		const ai = { run: vi.fn(async () => ({ response: 'sure! the code is 111111' })) };
		const result = await aiService.extract(ctx(ai), email(), OPEN);
		expect(result.code).toBe('483920');
		expect(aiService.metrics.counters[extractFailure.AI_BAD_JSON]).toBeGreaterThan(0);
	});

	it('返回原文中不存在的码 → 丢弃 AI 结果', async () => {
		const ai = aiReturning({ code: '000111' });
		const result = await aiService.extract(ctx(ai), mail({
			subject: 'Verify your account',
			text: 'Please verify your account soon.'
		}), OPEN);
		expect(result.code).toBe('');
		expect(aiService.metrics.counters[extractFailure.AI_NOT_IN_SOURCE]).toBeGreaterThan(0);
	});

	it('返回越界下标 → 丢弃 AI 结果', async () => {
		const ai = aiReturning({ index: 7 });
		const result = await aiService.extract(ctx(ai), mail({
			html: '<a href="https://example.com/newsletter">Read more</a>'
		}), OPEN);
		expect(result.link).toBe('');
		expect(aiService.metrics.counters[extractFailure.AI_INDEX_OUT_OF_RANGE]).toBeGreaterThan(0);
	});

	it('超时:AI 迟迟不返回时,提取仍在限定时间内完成(收信不被阻塞)', async () => {
		const ai = { run: vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ response: '{"code":"000000"}' }), 1000))) };
		const started = Date.now();
		const result = await aiService.extract(ctx(ai), email(), { ...OPEN, aiTimeoutMs: 30 });
		const elapsed = Date.now() - started;

		expect(result.code).toBe('483920');
		expect(elapsed).toBeLessThan(500);
		expect(aiService.metrics.counters[extractFailure.AI_TIMEOUT]).toBeGreaterThan(0);
	});
});

describe('AI 补位 · 逐字段判断与采纳', () => {
	it('确定性层已高置信拿到 code 时,不为 code 再花额度', async () => {
		const ai = aiReturning({ code: '000000' });
		await aiService.extract(ctx(ai), mail({
			subject: 'Verify your account',
			text: 'Your verification code is 483920.'
		}), OPEN);

		const askedForCode = ai.run.mock.calls.some(call =>
			JSON.stringify(call[1].messages).includes('verification code')
		);
		expect(askedForCode).toBe(false);
	});

	it('code 为空时 AI 返回原文中确实存在的码 → 采纳', async () => {
		const ai = aiReturning({ code: 'ZK9F21' });
		const result = await aiService.extract(ctx(ai), mail({
			subject: 'Verify your account',
			text: 'Please verify. The token ZK9F21 belongs to this request.'
		}), OPEN);
		expect(result.code).toBe('ZK9F21');
	});

	it('link 为空时 AI 返回合法下标 → 采纳该候选的 href(AI 不能生成 URL)', async () => {
		const ai = aiReturning({ index: 0 });
		const result = await aiService.extract(ctx(ai), mail({
			html: '<a href="https://example.com/x/aStrangePath">Continue</a>'
		}), OPEN);
		expect(result.link).toBe('https://example.com/x/aStrangePath');
	});

	it('AI 选中的下标即便指向 javascript: 锚点也不可能被采纳(候选集已过白名单)', async () => {
		const ai = aiReturning({ index: 0 });
		const result = await aiService.extract(ctx(ai), mail({
			html: '<a href="javascript:/verify?token=Ab12Cd34Ef56Gh78">Continue</a>'
		}), OPEN);
		expect(result.link).toBe('');
	});
});

describe('可观测(§3.1)', () => {
	it('指标只含失败原因与计数,不含邮件正文', async () => {
		await aiService.extract(ctx(undefined), mail({
			subject: 'Verify your account',
			text: 'Your verification code is 483920 secret-body-marker'
		}), OPEN);

		const dump = JSON.stringify(aiService.metrics.counters);
		expect(dump).not.toContain('secret-body-marker');
		expect(dump).not.toContain('483920');
	});
});

describe('emailUtils.extractAnchors', () => {
	it('返回 href 与锚文本', () => {
		const anchors = emailUtils.extractAnchors('<a href="https://a.example/x"> Click  here </a><a>no href</a>');
		expect(anchors).toEqual([{ href: 'https://a.example/x', text: 'Click here' }]);
	});

	it('输入为空或解析失败时返回空数组,不抛', () => {
		expect(emailUtils.extractAnchors('')).toEqual([]);
		expect(emailUtils.extractAnchors(null)).toEqual([]);
	});
});
