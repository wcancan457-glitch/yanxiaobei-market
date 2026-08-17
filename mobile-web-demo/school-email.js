(function exposeSchoolEmailRules(root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  if (root) root.YanxiaobeiSchoolEmail = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSchoolEmailRules() {
  const SCHOOL_EMAIL_DOMAIN = 'emails.bjut.edu.cn';
  const FORMAT_MESSAGE = `请输入以 @${SCHOOL_EMAIL_DOMAIN} 结尾的北工大学生邮箱；@ 前的邮箱名由学生自行设置`;
  const LOCAL_PART_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;

  function normalizeSchoolEmail(value) {
    return String(value || '').trim().toLowerCase().slice(0, 120);
  }

  function validSchoolEmail(value) {
    const email = normalizeSchoolEmail(value);
    const separator = email.lastIndexOf('@');
    if (separator <= 0) return false;
    const localPart = email.slice(0, separator);
    const domain = email.slice(separator + 1);
    return LOCAL_PART_PATTERN.test(localPart) && domain === SCHOOL_EMAIL_DOMAIN;
  }

  return {
    SCHOOL_EMAIL_DOMAIN,
    FORMAT_MESSAGE,
    normalizeSchoolEmail,
    validSchoolEmail
  };
});
