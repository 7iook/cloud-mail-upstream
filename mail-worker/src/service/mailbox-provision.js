import BizError from '../error/biz-error';
import { isDel } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import verifyUtils from '../utils/verify-utils';
import settingService from './setting-service';
import userService from './user-service';
import roleService from './role-service';
import { t } from '../i18n/i18n';

// 建号(account 行)不变量的唯一居所(share-fullchain P2 · DC-P0-2)。
// 两个写入口 —— 设置页「添加账号」(account-service.add)与分享创建
// (mail-share-service create emails[]) —— 都必须经由本模块;在别处复制任何一条
// 校验或 INSERT 都是第二写路径,迟早分叉成一次越权或一条脏行。
// 本模块**不得** import mail-share-service / account-service:它在两者之下,
// 反向依赖会把 account-service→mail-share-service 的既有边接成环。
//
// 两个入口经批准的差异只在包装层,不在不变量:设置页入口保留 addEmail/manyEmail
// 开关与 Turnstile(那是「加账号」这个产品功能的门),分享入口不查它们
// (用户裁定「不预注册」;Owner 已持 JWT,不是匿名流量)。

// 拒绝原因是机器码,不是用户文案:同一条不变量在两个入口说不同的话
// (设置页说 t('notExistDomain'),分享创建说 SHARE_DOMAIN_NOT_CONFIGURED),
// 所以文案映射留给调用方,这里只负责「为什么不行」。
export const PROVISION_DENIED = {
	EMAIL_INVALID: 'EMAIL_INVALID',
	DOMAIN_NOT_CONFIGURED: 'DOMAIN_NOT_CONFIGURED',
	PREFIX_TOO_SHORT: 'PREFIX_TOO_SHORT',
	PREFIX_FORBIDDEN: 'PREFIX_FORBIDDEN',
	ACCOUNT_DELETED: 'ACCOUNT_DELETED',
	ACCOUNT_TAKEN: 'ACCOUNT_TAKEN',
	ACCOUNT_EXISTS: 'ACCOUNT_EXISTS',
	QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
	DOMAIN_NOT_PERMITTED: 'DOMAIN_NOT_PERMITTED'
};

export class ProvisionDenied extends Error {
	constructor(reason, meta = {}) {
		super(reason);
		this.name = 'ProvisionDenied';
		this.reason = reason;
		this.meta = meta;
	}
}

function deny(reason, meta) {
	throw new ProvisionDenied(reason, meta);
}

// 域名配置的唯一解析口径:`c.env.domain` 既可能是真数组(wrangler [vars] 数组),
// 也可能是 JSON 字符串(dashboard 粘贴)。禁止对字符串形态做 `.includes` ——
// 那是子串匹配,`"xample.co"` 会命中 `'["example.com"]'`(share-fullchain 不变量 2)。
export function configuredDomains(c) {
	let list = c.env && c.env.domain;
	if (typeof list === 'string') {
		try {
			list = JSON.parse(list);
		} catch (err) {
			throw new BizError(t('notJsonDomain'));
		}
	}
	if (!Array.isArray(list)) {
		return [];
	}
	return list.map((item) => String(item).toLowerCase());
}

function isUniqueConflict(err) {
	return /UNIQUE constraint failed/i.test(String(err && err.message || err));
}

async function countOwnedMailboxes(c, userId) {
	const row = await c.env.db.prepare(`
		SELECT COUNT(*) AS owned FROM account WHERE user_id = ? AND is_del = ${isDel.NORMAL}
	`).bind(userId).first();
	return row.owned;
}

/**
 * 全量预校验 + 现状读取,零写入。任一项不过整单拒绝(ProvisionDenied),
 * 这正是分享创建「任一项失败 → 整单稳定码、零 INSERT」的前半段。
 *
 * @param {string[]} emails 完整地址(本函数内部按小写比对,存储形态由调用方决定)
 * @param {boolean} requireNew 设置页语义:地址已被注册(哪怕是自己的)即拒;
 *   分享语义传 false:自己的活账号直接复用(find-or-create)。
 * @returns {{ reused: {accountId:number, email:string}[], missing: string[] }}
 */
export async function planMailboxProvision(c, { emails, userId, requireNew = false }) {
	const domains = configuredDomains(c);
	const { minEmailPrefix, emailPrefixFilter } = await settingService.query(c);

	for (const email of emails) {
		if (!verifyUtils.isEmail(email)) {
			deny(PROVISION_DENIED.EMAIL_INVALID, { email });
		}
		if (!domains.includes(emailUtils.getDomain(email).toLowerCase())) {
			deny(PROVISION_DENIED.DOMAIN_NOT_CONFIGURED, { email });
		}
		const prefix = emailUtils.getName(email);
		if (prefix.length < minEmailPrefix) {
			deny(PROVISION_DENIED.PREFIX_TOO_SHORT, { email, minEmailPrefix });
		}
		if (emailPrefixFilter.some((token) => prefix.toLowerCase().includes(String(token).toLowerCase()))) {
			deny(PROVISION_DENIED.PREFIX_FORBIDDEN, { email });
		}
	}

	// 一次取回全集(含已删行):UNIQUE 索引是 NOCASE 的,查找也必须 NOCASE,
	// 否则「已删的 Foo@x.com」会被误判为缺失,写入时再撞索引。
	const keys = emails.map((email) => email.toLowerCase());
	const found = await c.env.db.prepare(`
		SELECT account_id, email, user_id, is_del FROM account
		WHERE lower(email) IN (SELECT value FROM json_each(?))
	`).bind(JSON.stringify(keys)).all();
	const byEmail = new Map();
	for (const row of found.results || []) {
		byEmail.set(String(row.email).toLowerCase(), row);
	}

	const reused = [];
	const missing = [];
	for (const email of emails) {
		const row = byEmail.get(email.toLowerCase());
		if (!row) {
			missing.push(email);
			continue;
		}
		if (row.is_del === isDel.DELETE) {
			deny(PROVISION_DENIED.ACCOUNT_DELETED, { email });
		}
		if (row.user_id !== userId) {
			deny(PROVISION_DENIED.ACCOUNT_TAKEN, { email });
		}
		if (requireNew) {
			deny(PROVISION_DENIED.ACCOUNT_EXISTS, { email });
		}
		reused.push({ accountId: row.account_id, email });
	}

	if (missing.length) {
		const userRow = await userService.selectById(c, userId);
		if (!userRow) {
			throw new BizError(t('authExpired'), 401);
		}
		// 与设置页同一条豁免:admin 不受配额与域名白名单约束。
		if (userRow.email !== c.env.admin) {
			const roleRow = await roleService.selectById(c, userRow.type);
			if (!roleRow) {
				deny(PROVISION_DENIED.QUOTA_EXCEEDED, { limit: 0 });
			}
			if (roleRow.accountCount > 0) {
				const owned = await countOwnedMailboxes(c, userId);
				if (owned + missing.length > roleRow.accountCount) {
					deny(PROVISION_DENIED.QUOTA_EXCEEDED, { limit: roleRow.accountCount });
				}
			}
			for (const email of missing) {
				if (!roleService.hasAvailDomainPerm(roleRow.availDomain, email)) {
					deny(PROVISION_DENIED.DOMAIN_NOT_PERMITTED, { email });
				}
			}
		}
	}

	return { reused, missing };
}

// account 的唯一 INSERT 文本。刻意**不带** NOT EXISTS 守卫:并发抢注同一地址必须以
// UNIQUE 报错收场 —— 报错才会让整个 D1 batch 回滚(分享创建把本语句与 share/binding
// 塞进同一个 batch,「share 失败则 account 一并回滚」全靠这一点)。静默 0 行反而会让
// 同批其它新 account 落库成孤儿。guard 由调用方注入自己的事务性前置条件
// (如分享创建的活跃数余量),不变量本身不认识这些领域谓词。
export function prepareAccountInsert(c, { email, userId, guardSql = '', guardBinds = [] }) {
	return c.env.db.prepare(`
		INSERT INTO account (email, name, user_id)
		SELECT ?, ?, ?${guardSql ? ` WHERE 1 = 1${guardSql}` : ''}
		RETURNING account_id
	`).bind(email, emailUtils.getName(email), userId, ...guardBinds);
}

/**
 * 设置页入口的立即写路径:plan(requireNew) → INSERT → 回读整行。
 * UNIQUE 撞车(plan 与 INSERT 之间被人抢注)时再 plan 一次 —— 它会以
 * ACCOUNT_EXISTS / ACCOUNT_TAKEN / ACCOUNT_DELETED 之一收场,与首次校验同一套话术。
 */
export async function provisionMailbox(c, { email, userId }) {
	await planMailboxProvision(c, { emails: [email], userId, requireNew: true });
	let inserted;
	try {
		inserted = await prepareAccountInsert(c, { email, userId }).first();
	} catch (err) {
		if (isUniqueConflict(err)) {
			await planMailboxProvision(c, { emails: [email], userId, requireNew: true });
		}
		throw err;
	}
	const row = await c.env.db.prepare(`
		SELECT * FROM account WHERE account_id = ?
	`).bind(inserted.account_id).first();
	return {
		accountId: row.account_id,
		email: row.email,
		name: row.name,
		status: row.status,
		latestEmailTime: row.latest_email_time,
		createTime: row.create_time,
		userId: row.user_id,
		allReceive: row.all_receive,
		sort: row.sort,
		isDel: row.is_del
	};
}

/**
 * 非管理员的 account 配额上限。admin 与 accountCount<=0（角色未设上限）返回 null，
 * 调用方不得注入配额谓词。role 行缺失 fail-closed（与 planMailboxProvision 同一条）。
 */
export async function resolveNonAdminAccountQuota(c, userId) {
	const userRow = await userService.selectById(c, userId);
	if (!userRow) {
		throw new BizError(t('authExpired'), 401);
	}
	if (userRow.email === c.env.admin) {
		return null;
	}
	const roleRow = await roleService.selectById(c, userRow.type);
	if (!roleRow) {
		deny(PROVISION_DENIED.QUOTA_EXCEEDED, { limit: 0 });
	}
	if (!(roleRow.accountCount > 0)) {
		return null;
	}
	return roleRow.accountCount;
}

export function accountQuotaPredicateSql() {
	return ` AND (
			SELECT COUNT(*) FROM account
			WHERE user_id = ? AND is_del = ${isDel.NORMAL}
		) < ?`;
}

export function accountQuotaPredicateBinds(userId, missingCount, accountCount) {
	return [userId, accountCount - (missingCount - 1)];
}
