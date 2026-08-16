const shareResult = {
	ok(data) {
		return { code: 200, message: 'success', data: data === undefined ? null : data };
	},
	fail(message, code = 500) {
		return { code, message };
	}
};
export default shareResult;
