const assert = require('assert/strict');
const {
  FORMAT_MESSAGE,
  normalizeStudentId,
  validStudentId
} = require('../student-id');

[
  '20231234',
  '202364391',
  '20231234567890123456',
  'S202312345',
  'B202312345'
].forEach((studentId) => assert.equal(validStudentId(studentId), true, studentId));

[
  '',
  '1234',
  '199912345',
  'S20231234',
  'S2023123456',
  'B20231234',
  'C202312345',
  '2023A1234'
].forEach((studentId) => assert.equal(validStudentId(studentId), false, studentId));

assert.equal(normalizeStudentId(' s202312345 '), 'S202312345');
assert.equal(normalizeStudentId(' b202312345 '), 'B202312345');
assert.match(FORMAT_MESSAGE, /S\+9位数字/);

console.log('Student ID validation tests passed');
