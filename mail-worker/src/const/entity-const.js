import verifyRecordService from '../service/verify-record-service';

export const userConst = {
	status: {
		NORMAL: 0,
		BAN: 1
	}
}

export const accountConst = {
	allReceive: {
		CLOSE: 0,
		OPEN: 1
	}
}

export const roleConst = {
	isDefault: {
		CLOSE: 0,
		OPEN: 1
	},
	banEmailType: {
		ALL: 0,
		CONTENT: 1
	},
	sendType: {
		COUNT: 'count',
		DAY: 'day'
	}
}

export const permConst = {
	type: {
		BUTTON: 2,
	}
}

export const emailConst = {
	type: {
		SEND: 1,
		RECEIVE: 0
	},
	status:  {
		RECEIVE: 0,
		SENT: 1,
		DELIVERED: 2,
		BOUNCED: 3,
		COMPLAINED: 4,
		DELAYED: 5,
		SAVING: 6,
		NOONE: 7,
		FAILED: 8
	},
	unread: {
		UNREAD: 0,
		READ: 1
	}
}

export const attConst = {
	status: {
		NORMAL: 0,
		UNUSED: 1
	},
	type: {
		ATT: 0,
		EMBED: 1
	}
}

export const settingConst = {
	register: {
		OPEN: 0,
		CLOSE: 1,
	},
	regKey: {
		OPEN: 0,
		CLOSE: 1,
		OPTIONAL: 2,
	},
	receive: {
		OPEN: 0,
		CLOSE: 1,
	},
	send: {
		OPEN: 0,
		CLOSE: 1
	},
	addEmail: {
		OPEN: 0,
		CLOSE: 1
	},
	manyEmail: {
		OPEN: 0,
		CLOSE: 1,
	},
	registerVerify: {
		OPEN: 0,
		CLOSE: 1,
		COUNT: 2,
	},
	addEmailVerify: {
		OPEN: 0,
		CLOSE: 1,
		COUNT: 2,
	},
	forwardStatus: {
		OPEN: 0,
		CLOSE: 1,
	},
	tgBotStatus: {
		OPEN: 0,
		CLOSE: 1,
	},
	ruleType: {
		ALL: 0,
		RULE: 1
	},
	noRecipient: {
		OPEN: 0,
		CLOSE: 1,
	},
	kvStorage: {
		OPEN: 0,
		CLOSE: 1
	},
	forcePathStyle: {
		OPEN: 0,
		CLOSE: 1
	},
	// 三态。`OPEN`/`CLOSE` 的数值不动 —— 它们已经躺在存量部署的 setting 行里,
	// 换值等于把别人的配置读成另一个意思。语义上 `OPEN` 升级为「规则优先 + AI 补位」,
	// `CLOSE` 保持「完全不提取」(它是列默认值,改语义会给所有存量部署静默开启新功能)。
	aiCode: {
		OPEN: 0,
		CLOSE: 1,
		RULE_ONLY: 2
	},
	authRefresh: {
		OPEN: 1,
		CLOSE: 0
	}
}

export const verifyRecordType = {
	REG: 0,
	ADD: 1,
}


export const isDel = {
	DELETE: 1,
	NORMAL: 0
}
