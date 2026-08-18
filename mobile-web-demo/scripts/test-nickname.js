const assert = require('assert');
const {
  normalizeNickname,
  validNickname,
  systemNickname
} = require('../nickname');

assert.equal(normalizeNickname('  小 北  '), '小 北');
assert.equal(normalizeNickname('校园\n买家'), '校园 买家');
assert.equal(validNickname('小北'), true);
assert.equal(validNickname('Campus Buyer 01'), true);
assert.equal(validNickname('🦀同学'), true);
assert.equal(validNickname('同'), false);
assert.equal(validNickname('123456789012345678901'), false);
assert.equal(validNickname(`校园\n用户`), false);
assert.equal(validNickname(`校园\u0085用户`), false);
assert.equal(validNickname(`校园\u200B用户`), false);
assert.equal(validNickname(`校园\u202E用户`), false);
assert.equal(validNickname(`校园\u2066用户`), false);
assert.equal(validNickname(`校园\uFEFF用户`), false);
assert.equal(validNickname('管理员'), false);
assert.equal(validNickname('燕小北官方客服'), false);
assert.equal(validNickname('同学9034'), false);
assert.equal(validNickname('昵称待设置'), false);
assert.equal(systemNickname('S202489034'), '昵称待设置');

console.log('Nickname validation tests passed');
