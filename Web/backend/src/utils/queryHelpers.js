const isAdmin = (user) =>
  !!user && (user.role === 'admin' || user.role === 'superadmin');

// admin sees everything, normal user sees only own data
const ownerFilter = (req) =>
  isAdmin(req.user) ? {} : { nodeOwner: req.user._id };

const getPageOptions = (req, allowedSort, defaultSort = 'createdAt') => {
  const paginated = req.query.page !== undefined;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  const sortBy = allowedSort.includes(req.query.sortBy) ? req.query.sortBy : defaultSort;
  const order = req.query.order === 'asc' ? 1 : -1;
  return { paginated, page, limit, skip: (page - 1) * limit, sort: { [sortBy]: order } };
};

const listWithPaging = async (req, res, Model, { allowedSort, legacyLimit, scoped = true }) => {
  const filter = scoped ? ownerFilter(req) : {};
  const opts = getPageOptions(req, allowedSort);

  // no ?page  ->  old behaviour, plain array
  if (!opts.paginated) {
    let q = Model.find(filter).sort({ createdAt: -1 });
    if (legacyLimit) q = q.limit(legacyLimit);
    return res.json(await q);
  }

  const [data, total] = await Promise.all([
    Model.find(filter).sort(opts.sort).skip(opts.skip).limit(opts.limit),
    Model.countDocuments(filter),
  ]);
  res.json({ data, total, page: opts.page, limit: opts.limit, totalPages: Math.ceil(total / opts.limit) });
};

module.exports = { isAdmin, ownerFilter, getPageOptions, listWithPaging };