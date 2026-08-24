import { and, eq, inArray, isNull } from 'drizzle-orm';
import { attConst } from '../const/entity-const';
import account from '../entity/account';
import { att } from '../entity/att';
import orm from '../entity/orm';

const MASKED_ADDRESS = '***';

/**
 * Decision 14: masking is a display preference, not a confidentiality boundary, so it
 * only covers the system-generated mailbox identity. Sender, subject and body keep the
 * address verbatim (AC-MAIL-08). Anything that is not a parsable address degrades to
 * `***` rather than throwing: one dirty account row must not turn a read into a 500.
 */
function maskAddress(address, showFullAddress) {
	const text = typeof address === 'string' ? address : '';
	const at = text.indexOf('@');
	if (at <= 0 || at === text.length - 1) {
		return MASKED_ADDRESS;
	}
	return showFullAddress === true ? text : `${text[0]}${MASKED_ADDRESS}${text.slice(at)}`;
}

function resolveAttachmentRows(emailRow, attachmentRows) {
	if (attachmentRows !== undefined) {
		return Array.isArray(attachmentRows) ? attachmentRows : [];
	}
	if (Array.isArray(emailRow && emailRow.attachments)) {
		return emailRow.attachments;
	}
	if (Array.isArray(emailRow && emailRow.attList)) {
		return emailRow.attList;
	}
	return [];
}

function isDownloadableAttachment(row) {
	if (!row) {
		return false;
	}
	const id = row.attId ?? row.attachmentId;
	if (id == null) {
		return false;
	}
	if (row.type != null && row.type !== attConst.type.ATT) {
		return false;
	}
	if (row.contentId != null && row.contentId !== '') {
		return false;
	}
	return true;
}

function projectAttachment(attRow, mailId) {
	const attachmentId = attRow.attId ?? attRow.attachmentId;
	return {
		attachmentId,
		filename: attRow.filename == null ? null : attRow.filename,
		size: attRow.size == null ? null : attRow.size,
		downloadUrl: `/share/attachment?mailId=${mailId}&attachmentId=${attachmentId}`
	};
}

// The Binding a row belongs to, resolved from ctx.bindings rather than echoed from the
// row: `account_id` is an internal id the visitor must never see (AC-MAIL-07). A row
// whose account is not in the binding set gets a null identity instead of a raw id.
function resolveBindingId(ctx, accountId) {
	const bindings = Array.isArray(ctx && ctx.bindings) ? ctx.bindings : [];
	const matched = bindings.find((item) => item && Number(item.accountId) === Number(accountId));
	return matched && matched.bindingId != null ? matched.bindingId : null;
}

/**
 * `ctx` is the frozen ShareContext (T-09) and `mailboxes` maps accountId -> account.email.
 * Both are required: the projection cannot invent the Binding identity or the mailbox
 * address from the email row alone.
 */
function project(emailRow, attachmentRows, ctx, mailboxes) {
	const mailId = emailRow.emailId ?? emailRow.mailId;
	const attachments = resolveAttachmentRows(emailRow, attachmentRows)
		.filter(isDownloadableAttachment)
		.map((row) => projectAttachment(row, mailId));

	return {
		mailId,
		bindingId: resolveBindingId(ctx, emailRow.accountId),
		mailboxAddress: maskAddress(
			mailboxes ? mailboxes.get(emailRow.accountId) : undefined,
			ctx && ctx.showFullAddress
		),
		senderName: emailRow.name ?? emailRow.senderName ?? null,
		senderAddress: emailRow.sendEmail ?? emailRow.senderAddress ?? null,
		subject: emailRow.subject == null ? null : emailRow.subject,
		text: emailRow.text === undefined ? null : emailRow.text,
		content: emailRow.content === undefined ? null : emailRow.content,
		receivedAt: emailRow.createTime ?? emailRow.receivedAt ?? null,
		// The key exists only while the switch is on (AC-OTP-02); a null placeholder would
		// still tell the visitor page an OTP slot exists.
		...(ctx && ctx.otpExtractionEnabled === true ? { code: emailRow.code } : {}),
		attachments
	};
}

async function loadRepo(deps) {
	if (deps.shareScopedEmailRepository) {
		return deps.shareScopedEmailRepository;
	}
	const mod = await import('./share-scoped-email-repository.js');
	return mod.default;
}

async function defaultFindAttachments(c, emailIds) {
	if (!emailIds.length) {
		return [];
	}
	const rows = await orm(c).select().from(att).where(
		and(
			inArray(att.emailId, emailIds),
			eq(att.type, attConst.type.ATT),
			isNull(att.contentId)
		)
	).all();
	return rows || [];
}

async function loadAttachments(c, emailIds, deps) {
	const findAttachments = deps.findAttachments || defaultFindAttachments;
	return findAttachments(c, emailIds);
}

async function defaultFindAccountEmails(c, accountIds) {
	const rows = await orm(c)
		.select({ accountId: account.accountId, email: account.email })
		.from(account)
		.where(inArray(account.accountId, accountIds))
		.all();
	return rows || [];
}

// Bindings carry no mailbox address, so the projection reads account.email here rather
// than growing the frozen ShareContext a field it does not own.
async function loadMailboxes(c, rows, deps) {
	const accountIds = [...new Set(rows.map((row) => row.accountId).filter((id) => id != null))];
	if (!accountIds.length) {
		return new Map();
	}
	const findAccountEmails = deps.findAccountEmails || defaultFindAccountEmails;
	const found = await findAccountEmails(c, accountIds);
	return new Map((found || []).map((item) => [item.accountId, item.email]));
}

const shareMailService = {

	maskAddress,
	project,

	async list(c, ctx, cursor, limit, deps = {}) {
		const repo = await loadRepo(deps);
		const rows = await repo.list(c, ctx, cursor, limit);
		const emailIds = rows.map((row) => row.emailId);
		const attRows = await loadAttachments(c, emailIds, deps);
		const mailboxes = await loadMailboxes(c, rows, deps);
		return rows.map((row) => project(
			row,
			attRows.filter((item) => item.emailId === row.emailId),
			ctx,
			mailboxes
		));
	},

	async getById(c, ctx, mailId, deps = {}) {
		const repo = await loadRepo(deps);
		const row = await repo.getById(c, ctx, mailId);
		if (!row) {
			return null;
		}
		const attRows = await loadAttachments(c, [row.emailId], deps);
		const mailboxes = await loadMailboxes(c, [row], deps);
		return project(row, attRows, ctx, mailboxes);
	}

};

export default shareMailService;
