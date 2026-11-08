const jwt = require('jsonwebtoken'), { httpError } = require('./util');
const opts = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.COOKIE_SAMESITE || 'lax', maxAge: 8 * 3600 * 1000 });
exports.setSession = (res, a) => res.cookie('adm', jwt.sign({ sub: a.id, role: a.role, name: a.name }, process.env.JWT_SECRET, { expiresIn: '8h' }), opts());
exports.clearSession = res => res.clearCookie('adm', { ...opts(), maxAge: undefined });
// CSRF: state-changing calls must carry a custom header, which cross-site forms cannot send.
exports.csrf = (req, _s, next) => (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get('x-requested-with') === 'XMLHttpRequest') ? next() : next(httpError(403, 'Blocked request.'));
exports.requireRole = (...roles) => (req, _s, next) => {
  try {
    const p = jwt.verify(req.cookies.adm, process.env.JWT_SECRET);
    if (roles.length && !roles.includes(p.role)) return next(httpError(403, 'Your role cannot do this.'));
    req.admin = p; next();
  } catch { next(httpError(401, 'Sign in required.')); }
};
