(function exposeStudentIdRules(root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  if (root) root.YanxiaobeiStudentId = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createStudentIdRules() {
  const FORMAT_MESSAGE = '本科生请输入以入学年份开头的纯数字学号；硕士生请输入 S+9位数字；博士生请输入 B+9位数字';

  function normalizeStudentId(value) {
    return String(value || '').trim().toUpperCase();
  }

  function validStudentId(value) {
    const studentId = normalizeStudentId(value);
    const undergraduate = /^20\d{6,18}$/.test(studentId);
    const postgraduate = /^[SB]20\d{7}$/.test(studentId);
    return undergraduate || postgraduate;
  }

  return { FORMAT_MESSAGE, normalizeStudentId, validStudentId };
});
