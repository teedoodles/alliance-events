exports.httpError = (status, message) => Object.assign(new Error(message), { status });
exports.h = fn => (req, res, next) => fn(req, res, next).catch(next);
exports.dbCheck = ({ error, data }) => { if (error) { console.error(error); throw exports.httpError(500, 'Database error'); } return data; };
