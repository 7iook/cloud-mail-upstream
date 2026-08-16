import { inArray, lt, lte, or } from 'drizzle-orm';
import dayjs from 'dayjs';
import orm from '../entity/orm';
import { mailShare, shareIdempotency } from '../entity/mail-share';

const IDEMPOTENCY_TTL_HOURS = 24;

const mailShareCleanupService = {

	async cleanupExpired(c) {
		const now = dayjs().format('YYYY-MM-DD HH:mm:ss');
		const idempotencyCutoff = dayjs().subtract(IDEMPOTENCY_TTL_HOURS, 'hour').format('YYYY-MM-DD HH:mm:ss');

		const dueShares = await orm(c)
			.select({ shareId: mailShare.shareId })
			.from(mailShare)
			.where(lte(mailShare.deleteAt, now))
			.all();
		const dueShareIds = dueShares.map((row) => row.shareId);

		const staleIdempotency = lt(shareIdempotency.createdAt, idempotencyCutoff);
		const idempotencyFilter = dueShareIds.length > 0
			? or(staleIdempotency, inArray(shareIdempotency.shareId, dueShareIds))
			: staleIdempotency;

		await orm(c).delete(shareIdempotency).where(idempotencyFilter).run();
		await orm(c).delete(mailShare).where(lte(mailShare.deleteAt, now)).run();
	}
};

export default mailShareCleanupService;
