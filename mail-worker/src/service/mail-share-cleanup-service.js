import { isDel } from '../const/entity-const';
import { toUtc } from '../utils/date-uitil';
import { SHARE_EVENT, logShareEvent } from './mail-share-service';

const IDEMPOTENCY_TTL_HOURS = 24;

// 孤儿 Binding 的合法性判据。必须与写入门禁 `prepareBindingInsert` 的 JOIN、
// `init.js` 回填的 JOIN、`v3-2-db.spec.js` 的 `illegalBindingCount()` 逐字同源:
// account 存在 + `is_del = NORMAL` + `user_id` 与分享所有者匹配。少一个条件就漏扫,
// 多一个就误删。内层 `ms` 不存在时 NOT EXISTS 自动成立,所以「悬空 share_id」不需要单独一臂。
const LEGAL_BINDING = `EXISTS (
			SELECT 1 FROM mail_share ms
			JOIN account a ON a.account_id = mail_share_binding.account_id
				AND a.is_del = ${isDel.NORMAL}
				AND a.user_id = ms.user_id
			WHERE ms.share_id = mail_share_binding.share_id
		)`;

function groupByShare(result) {
	const grouped = new Map();
	for (const row of (result && result.results) || []) {
		grouped.set(row.share_id, (grouped.get(row.share_id) || 0) + 1);
	}
	return grouped;
}

const mailShareCleanupService = {

	// 入口是 `index.js` 的 cron,`c` 只有 `env` —— 不能用 `c.get('setting')` / `c.req`。
	// 六条语句一个 batch,顺序是硬约束:子表恒在主表之前(①④的子查询要在 mail_share
	// 行还在的时候求值),②的撤销要读③即将删掉的 Binding,④的重指要在③之后才知道
	// 「剩下的都是活的」。写反的现象是「零孤儿断言过、但撤销/重指静默失效」。
	// 不加 try/catch:清理失败必须让 cron 报错,而不是静默少清一批。
	async cleanupExpired(c) {
		// 恒 UTC：库里的 delete_at / created_at 都是 UTC 裸串，比较基准必须同口径，
		// 否则非 UTC 进程(本地开发)会按偏移量提前或延后清理。
		const now = toUtc().format('YYYY-MM-DD HH:mm:ss');
		const idempotencyCutoff = toUtc().subtract(IDEMPOTENCY_TTL_HOURS, 'hour').format('YYYY-MM-DD HH:mm:ss');

		const results = await c.env.db.batch([
			// ① AC-LIFE-06:到期分享的 Binding 与主表行同批删。
			c.env.db.prepare(`
				DELETE FROM mail_share_binding
				WHERE share_id IN (SELECT share_id FROM mail_share WHERE delete_at <= ?)
				RETURNING share_id, account_id
			`).bind(now),
			// ② 孤儿补偿前置:有 Binding 但一条活的都不剩 → REVOKED。
			// `EXISTS(任意 Binding)` 不可省 —— 零 Binding 的合法遗留行(R3-A2)归回填收编,
			// 不归本臂管。`status = 'ACTIVE'` 保证重复运行不会改写 revoked_at。
			c.env.db.prepare(`
				UPDATE mail_share SET status = 'REVOKED', revoked_at = ?
				WHERE status = 'ACTIVE'
					AND EXISTS (SELECT 1 FROM mail_share_binding b WHERE b.share_id = mail_share.share_id)
					AND NOT EXISTS (
						SELECT 1 FROM mail_share_binding b
						JOIN account a ON a.account_id = b.account_id
							AND a.is_del = ${isDel.NORMAL}
							AND a.user_id = mail_share.user_id
						WHERE b.share_id = mail_share.share_id
					)
				RETURNING share_id
			`).bind(now),
			// ③ AC-BIND-10 尾句:剔除孤儿(account 不存在 / 已删 / 归属不符,含悬空 share_id)。
			c.env.db.prepare(`
				DELETE FROM mail_share_binding WHERE NOT ${LEGAL_BINDING}
				RETURNING share_id, account_id
			`),
			// ④ AC-LIFE-10 双写补偿:③之后剩下的 Binding 都是活的,主表 account_id 若已不在
			// 其中就重指到最小 binding_id。级联路径已自己重指过,这里是崩溃/绕过 service 的兜底。
			// `EXISTS(幸存者)` + `account_id > 0` 守卫保证绝不写 0/NULL。
			c.env.db.prepare(`
				UPDATE mail_share
				SET account_id = (
					SELECT b.account_id FROM mail_share_binding b
					WHERE b.share_id = mail_share.share_id AND b.account_id > 0
					ORDER BY b.binding_id ASC LIMIT 1
				),
				window_start_email_id = (
					SELECT b.window_start_email_id FROM mail_share_binding b
					WHERE b.share_id = mail_share.share_id AND b.account_id > 0
					ORDER BY b.binding_id ASC LIMIT 1
				)
				WHERE NOT EXISTS (
					SELECT 1 FROM mail_share_binding b
					WHERE b.share_id = mail_share.share_id AND b.account_id = mail_share.account_id
				)
				AND EXISTS (
					SELECT 1 FROM mail_share_binding b
					WHERE b.share_id = mail_share.share_id AND b.account_id > 0
				)
			`),
			// ⑤ 幂等行:相关子查询替代原来的 JS 侧预读 + `inArray` 展开(到期分享一多就撞参数上限)。
			c.env.db.prepare(`
				DELETE FROM share_idempotency
				WHERE created_at < ? OR share_id IN (SELECT share_id FROM mail_share WHERE delete_at <= ?)
			`).bind(idempotencyCutoff, now),
			// ⑥ 主表恒最后。
			c.env.db.prepare('DELETE FROM mail_share WHERE delete_at <= ?').bind(now)
		]);

		// 每个受影响 share 一行。`reason` 与级联侧的 `account_deleted` 区分开,
		// 便于排障时分辨「谁清的」。字段只放行号与计数,无 PII。
		const revoked = new Set((results[1].results || []).map((row) => row.share_id));
		for (const [shareId, removedBindings] of groupByShare(results[0])) {
			logShareEvent(SHARE_EVENT.BINDING_CASCADE, {
				shareId, reason: 'share_expired', removedBindings, revoked: false
			});
		}
		for (const [shareId, removedBindings] of groupByShare(results[2])) {
			logShareEvent(SHARE_EVENT.BINDING_CASCADE, {
				shareId, reason: 'orphan_sweep', removedBindings, revoked: revoked.has(shareId)
			});
		}
	}
};

export default mailShareCleanupService;
