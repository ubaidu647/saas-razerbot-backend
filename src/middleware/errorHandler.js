// Global error handler
function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;

  const body = { message: err.message || 'Internal Server Error' };
  // Package-limit rejections carry the cap and current usage so the UI can
  // show "3 of 3 used" rather than a bare error string.
  if (err.code) body.code = err.code;
  if (err.details) body.details = err.details;

  res.status(status).json(body);
}

module.exports = errorHandler;
