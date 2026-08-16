import { and, eq, inArray, isNull } from 'drizzle-orm';
import { attConst } from '../const/entity-const';
import { att } from '../entity/att';
import orm from '../entity/orm';

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

function project(emailRow, attachmentRows) {
	const mailId = emailRow.emailId ?? emailRow.mailId;
	const attachments = resolveAttachmentRows(emailRow, attachmentRows)
		.filter(isDownloadableAttachment)
		.map((row) => projectAttachment(row, mailId));

	return {
		mailId,
		senderName: emailRow.name ?? emailRow.senderName ?? null,
		senderAddress: emailRow.sendEmail ?? emailRow.senderAddress ?? null,
		subject: emailRow.subject == null ? null : emailRow.subject,
		text: emailRow.text === undefined ? null : emailRow.text,
		content: emailRow.content === undefined ? null : emailRow.content,
		receivedAt: emailRow.createTime ?? emailRow.receivedAt ?? null,
		code: emailRow.code,
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

const shareMailService = {

	project,

	async list(c, ctx, cursor, limit, deps = {}) {
		const repo = await loadRepo(deps);
		const rows = await repo.list(c, ctx, cursor, limit);
		const emailIds = rows.map((row) => row.emailId);
		const attRows = await loadAttachments(c, emailIds, deps);
		return rows.map((row) => project(
			row,
			attRows.filter((item) => item.emailId === row.emailId)
		));
	},

	async getById(c, ctx, mailId, deps = {}) {
		const repo = await loadRepo(deps);
		const row = await repo.getById(c, ctx, mailId);
		if (!row) {
			return null;
		}
		const attRows = await loadAttachments(c, [row.emailId], deps);
		return project(row, attRows);
	}

};

export default shareMailService;
