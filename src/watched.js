'use strict'
// 兼容壳：被注视模块已按团队约定改名为 audience.js。
// 保留这个文件是因为 spontaneous.js 的接线在 bc5d2f0 里已经引用了 './watched'，
// 两边同时改容易撞车；这里只做转发，不实现任何逻辑。
module.exports = require('./audience')
