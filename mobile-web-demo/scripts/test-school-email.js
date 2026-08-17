const assert = require('assert/strict');
const {
  SCHOOL_EMAIL_DOMAIN,
  FORMAT_MESSAGE,
  normalizeSchoolEmail,
  validSchoolEmail
} = require('../school-email');

assert.equal(SCHOOL_EMAIL_DOMAIN, 'emails.bjut.edu.cn');
assert.equal(normalizeSchoolEmail(' Custom.Name@EMAILS.BJUT.EDU.CN '), 'custom.name@emails.bjut.edu.cn');

[
  's202489034@emails.bjut.edu.cn',
  'student.chosen-name@emails.bjut.edu.cn',
  'campus_mail+test@emails.bjut.edu.cn'
].forEach((email) => assert.equal(validSchoolEmail(email), true, email));

[
  '',
  's202489034@bjut.edu.cn',
  's202489034@emails.bgut.edu.cn',
  '@emails.bjut.edu.cn',
  'name@sub.emails.bjut.edu.cn',
  'name@example.com'
].forEach((email) => assert.equal(validSchoolEmail(email), false, email));

assert.match(FORMAT_MESSAGE, /@ 前的邮箱名由学生自行设置/);

console.log('School email validation tests passed');
